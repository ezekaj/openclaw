/**
 * Memory Batch Queue
 *
 * Batches memory operations to reduce Python IPC overhead.
 * Similar pattern to MetricsQueue - accumulate, flush on size/time.
 */

import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory-batch");

export type BatchMemoryItem = {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  embedding?: number[];
};

export type BatchStoreResult = {
  id: string;
  result: {
    stored: boolean;
    episode_id?: string;
    surprise: number;
    is_novel: boolean;
    reason?: string;
  };
  error?: string;
};

export type MemoryBatchConfig = {
  /** Max items before flush - default: 10 */
  batchSize?: number;
  /** Max wait time before flush (ms) - default: 2000 (2 seconds) */
  flushInterval?: number;
  /** Max queue size before drop oldest - default: 100 */
  maxQueueSize?: number;
  /** Callback to send batch to Python */
  onFlush: (items: BatchMemoryItem[]) => Promise<BatchStoreResult[]>;
};

/**
 * Memory Batch Queue
 *
 * Queues memory operations and flushes them in batches:
 * - Flush when batch size reached
 * - Flush on interval (debouncing)
 * - Drop oldest on overflow
 */
export class MemoryBatchQueue {
  private buffer: BatchMemoryItem[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private readonly batchSize: number;
  private readonly flushInterval: number;
  private readonly maxQueueSize: number;
  private readonly onFlush: (items: BatchMemoryItem[]) => Promise<BatchStoreResult[]>;

  private isFlushing = false;
  private pendingCallbacks: Map<
    string,
    {
      resolve: (result: BatchStoreResult["result"]) => void;
      reject: (error: Error) => void;
    }
  > = new Map();

  private totalStored = 0;
  private totalDropped = 0;

  constructor(config: MemoryBatchConfig) {
    this.batchSize = config.batchSize ?? 10;
    this.flushInterval = config.flushInterval ?? 2000;
    this.maxQueueSize = config.maxQueueSize ?? 100;
    this.onFlush = config.onFlush;

    this.startFlushTimer();

    log.debug(
      `Memory batch queue initialized (batch: ${this.batchSize}, interval: ${this.flushInterval}ms, max: ${this.maxQueueSize})`,
    );
  }

  /**
   * Add memory to batch queue (non-blocking, <0.1ms)
   * Returns a promise that resolves when the batch is flushed
   */
  push(item: Omit<BatchMemoryItem, "id">): Promise<BatchStoreResult["result"]> {
    const id = randomUUID();
    const fullItem: BatchMemoryItem = { ...item, id };

    // Enforce max queue size (drop oldest if overflow)
    if (this.buffer.length >= this.maxQueueSize) {
      const dropped = this.buffer.shift();
      if (dropped) {
        const callback = this.pendingCallbacks.get(dropped.id);
        if (callback) {
          this.pendingCallbacks.delete(dropped.id);
          callback.reject(new Error("Memory dropped due to queue overflow"));
        }
        this.totalDropped++;
        log.warn(`Memory queue overflow, dropped item: ${dropped.id}`);
      }
    }

    this.buffer.push(fullItem);

    // Create promise for this item's result
    const resultPromise = new Promise<BatchStoreResult["result"]>((resolve, reject) => {
      this.pendingCallbacks.set(id, { resolve, reject });
    });

    // Flush immediately if batch full
    if (this.buffer.length >= this.batchSize) {
      this.scheduleFlush();
    }

    return resultPromise;
  }

  /**
   * Force flush all pending items
   */
  async flush(): Promise<void> {
    if (this.isFlushing || this.buffer.length === 0) return;

    this.isFlushing = true;

    // Swap buffer atomically
    const toProcess = [...this.buffer];
    this.buffer = [];

    log.debug(`Flushing ${toProcess.length} memory items to Python`);

    try {
      const results = await this.onFlush(toProcess);

      // Dispatch results to waiting callers
      for (const result of results) {
        const callback = this.pendingCallbacks.get(result.id);
        if (callback) {
          this.pendingCallbacks.delete(result.id);

          if (result.error) {
            callback.reject(new Error(result.error));
          } else {
            if (result.result.stored) {
              this.totalStored++;
            }
            callback.resolve(result.result);
          }
        }
      }

      // Reject any items that didn't get results (Python error)
      for (const item of toProcess) {
        if (this.pendingCallbacks.has(item.id)) {
          const callback = this.pendingCallbacks.get(item.id)!;
          this.pendingCallbacks.delete(item.id);
          callback.reject(new Error("No result returned from batch store"));
        }
      }
    } catch (error) {
      // Batch failed - reject all pending
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`Batch flush failed (${toProcess.length} items): ${msg}`);

      for (const item of toProcess) {
        const callback = this.pendingCallbacks.get(item.id);
        if (callback) {
          this.pendingCallbacks.delete(item.id);
          callback.reject(new Error(`Batch failed: ${msg}`));
        }
      }
    } finally {
      this.isFlushing = false;

      // If more items queued during flush, schedule again
      if (this.buffer.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  /**
   * Get current queue statistics
   */
  getStats() {
    return {
      queueSize: this.buffer.length,
      pendingCallbacks: this.pendingCallbacks.size,
      totalStored: this.totalStored,
      totalDropped: this.totalDropped,
      isFlushing: this.isFlushing,
    };
  }

  /**
   * Stop timer and flush remaining
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    log.debug(`Shutting down batch queue, flushing ${this.buffer.length} remaining items`);
    await this.flush();

    log.info(
      `Memory batch queue shutdown (stored: ${this.totalStored}, dropped: ${this.totalDropped})`,
    );
  }

  private scheduleFlush(): void {
    // Immediate flush via setImmediate (doesn't block current call)
    setImmediate(() => this.flush());
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      if (this.buffer.length > 0 && !this.isFlushing) {
        this.flush();
      }
    }, this.flushInterval);

    // Don't prevent process exit
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }
}
