/**
 * Metrics Queue
 * 
 * Lightweight in-memory queue for batching metric events
 * before writing to SQLite. Non-blocking, fire-and-forget.
 * 
 * Performance: <0.1ms per push, batch writes every 100 events or 5 seconds
 */

import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { safeOpenDatabase } from "../infra/sqlite-utils.js";
import type { MetricEvent } from "./meta-cognitive-types.js";

const log = createSubsystemLogger("metrics-queue");

export interface MetricsQueueConfig {
  /** Max events before flush - default: 100 */
  batchSize?: number;
  /** Max time before flush (ms) - default: 5000 (5 seconds) */
  flushInterval?: number;
  /** Callback for batch processing */
  onFlush?: (events: MetricEvent[]) => Promise<void>;
}

export class MetricsQueue {
  private buffer: MetricEvent[] = [];
  private flushTimer?: NodeJS.Timeout;
  private readonly batchSize: number;
  private readonly flushInterval: number;
  private readonly onFlush?: (events: MetricEvent[]) => Promise<void>;
  private isFlushing = false;
  private totalEventsProcessed = 0;

  constructor(config: MetricsQueueConfig = {}) {
    this.batchSize = config.batchSize ?? 100;
    this.flushInterval = config.flushInterval ?? 5000;
    this.onFlush = config.onFlush;
    
    // Start flush timer
    this.startFlushTimer();
  }

  /**
   * Add metric to queue (non-blocking, <0.1ms)
   */
  push(metric: Omit<MetricEvent, "batchId">): void {
    const fullMetric: MetricEvent = {
      ...metric,
      batchId: randomUUID(),
    };
    
    this.buffer.push(fullMetric);
    
    // Flush if buffer full
    if (this.buffer.length >= this.batchSize) {
      this.flushIfNeeded();
    }
  }

  /**
   * Flush if buffer has events
   */
  flushIfNeeded(): void {
    if (this.buffer.length > 0) {
      this.flush();
    }
  }

  /**
   * Force flush all pending events
   */
  async flush(): Promise<void> {
    if (this.isFlushing || this.buffer.length === 0) return;
    
    this.isFlushing = true;
    
    // Swap buffer to process
    const toProcess = [...this.buffer];
    this.buffer = [];
    
    // Process in background (don't await)
    setImmediate(async () => {
      try {
        if (this.onFlush) {
          await this.onFlush(toProcess);
        }
        this.totalEventsProcessed += toProcess.length;
        log.debug(`Flushed ${toProcess.length} metrics (total: ${this.totalEventsProcessed})`);
      } catch (error) {
        log.error("Failed to flush metrics:", error);
        // Re-add failed events to buffer
        this.buffer.unshift(...toProcess);
      } finally {
        this.isFlushing = false;
      }
    });
  }

  /**
   * Get current buffer size
   */
  size(): number {
    return this.buffer.length;
  }

  /**
   * Get total events processed
   */
  getTotalProcessed(): number {
    return this.totalEventsProcessed;
  }

  /**
   * Stop flush timer and flush remaining
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    await this.flush();
  }

  /**
   * Start periodic flush timer
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flushIfNeeded();
    }, this.flushInterval);
    
    // Don't prevent process exit
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }
}

/**
 * Create a metrics queue with SQLite persistence
 */
export function createMetricsQueueWithDB(
  dbPath: string,
  config?: Omit<MetricsQueueConfig, "onFlush">
): MetricsQueue {
  // Import DatabaseSync lazily to avoid issues if not available
  let db: any;
  
  try {
    // Ensure directory exists
    const fs = require("node:fs");
    const path = require("node:path");
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    const { DatabaseSync } = require("node:sqlite");
    
    // Use safe open with automatic corruption recovery
    db = safeOpenDatabase(dbPath, DatabaseSync);
    
    if (!db) {
      log.warn("Failed to open metrics database (corruption recovery failed), using memory-only queue");
      return new MetricsQueue(config);
    }
    
    // Create or recreate table
    try {
      // Try to query the table to see if it's valid
      db.exec(`SELECT * FROM metric_events LIMIT 1`);
    } catch (error) {
      // Table might be corrupted, drop and recreate
      log.warn(`Metrics table appears corrupted, recreating: ${dbPath}`);
      try {
        db.exec(`DROP TABLE IF EXISTS metric_events`);
      } catch (e) {
        // Ignore drop errors
      }
    }
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS metric_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        response_time INTEGER NOT NULL,
        surprise_score REAL,
        error_occurred INTEGER DEFAULT 1,
        retry_count INTEGER DEFAULT 0,
        batch_id TEXT,
        timestamp INTEGER NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);
    
    // Create indexes
    db.exec(`CREATE INDEX IF NOT EXISTS idx_metrics_event_type ON metric_events(event_type, timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metric_events(timestamp)`);
    
    log.info(`Metrics database initialized: ${dbPath}`);
  } catch (error) {
    log.warn("SQLite not available for metrics, using memory-only queue:", error);
    return new MetricsQueue(config); // Return memory-only queue
  }
  
  return new MetricsQueue({
    ...config,
    onFlush: async (events: MetricEvent[]) => {
      if (!db) {
        log.debug(`Skipping flush - no database (${events.length} events)`);
        return;
      }
      
      try {
        const stmt = db.prepare(`
          INSERT INTO metric_events
          (event_id, event_type, response_time, surprise_score, error_occurred, retry_count, batch_id, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        // Insert each metric individually (DatabaseSync doesn't support transactions)
        for (const event of events) {
          stmt.run(
            event.eventId,
            event.eventType,
            event.responseTime,
            event.surpriseScore ?? null,
            event.errorOccurred ? 1 : 0,
            event.retryCount ?? 0,
            event.batchId,
            event.timestamp
          );
        }
        
        log.debug(`Flushed ${events.length} metrics to database`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.warn(`Failed to insert ${events.length} metrics: ${errorMsg}`);
        // Don't re-throw - just log and continue (metrics are non-critical)
      }
    },
  });
}
