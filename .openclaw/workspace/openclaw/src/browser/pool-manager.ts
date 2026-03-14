/**
 * Pool Manager Integration
 * 
 * Provides a high-level API for using the Lightpanda pool with smart routing.
 * Combines pool management with task complexity analysis.
 */

import { LightpandaPool, getLightpandaPool, type PoolConfig, type PoolInstance } from "./lightpanda-pool.js";
import { 
  analyzeTaskComplexity, 
  shouldUseLightpanda, 
  requiresChromium,
  type TaskContext 
} from "./task-complexity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("pool-manager");

// ============================================================================
// TYPES
// ============================================================================

export interface PooledClientOptions {
  taskContext?: TaskContext;
  preferPool?: boolean;
}

export interface PooledClientResult {
  client: any; // LightpandaClient
  instance: PoolInstance;
  engine: "lightpanda" | "chromium";
  fromPool: boolean;
  analysis?: {
    complexity: string;
    confidence: number;
    reasoning: string[];
  };
}

// ============================================================================
// POOL MANAGER
// ============================================================================

/**
 * High-level pool manager with smart routing
 */
export class PoolManager {
  private pool: LightpandaPool;
  private chromiumFallback: boolean;

  constructor(config?: Partial<PoolConfig> & { chromiumFallback?: boolean }) {
    const { chromiumFallback = true, ...poolConfig } = config || {};
    
    this.pool = getLightpandaPool(poolConfig);
    this.chromiumFallback = chromiumFallback;
  }

  /**
   * Initialize pool
   */
  async initialize(): Promise<void> {
    await this.pool.initialize();
    
    log.info("Pool manager initialized", {
      metrics: this.pool.getMetrics(),
    });
  }

  /**
   * Get client with smart routing
   */
  async getClient(options: PooledClientOptions = {}): Promise<PooledClientResult> {
    const { taskContext, preferPool = true } = options;

    // If task context provided, analyze complexity
    if (taskContext) {
      const analysis = analyzeTaskComplexity(taskContext);

      // Check if Chromium is required
      if (requiresChromium(taskContext)) {
        log.info("Task requires Chromium", {
          action: taskContext.action,
          complexity: analysis.complexity,
        });

        return {
          client: null, // Caller should use Chromium
          instance: null as any,
          engine: "chromium",
          fromPool: false,
          analysis: {
            complexity: analysis.complexity,
            confidence: analysis.confidence,
            reasoning: analysis.reasoning,
          },
        };
      }

      // Check if Lightpanda is suitable
      if (shouldUseLightpanda(taskContext) || preferPool) {
        const instance = await this.pool.acquire();

        return {
          client: instance.client,
          instance,
          engine: "lightpanda",
          fromPool: true,
          analysis: {
            complexity: analysis.complexity,
            confidence: analysis.confidence,
            reasoning: analysis.reasoning,
          },
        };
      }
    }

    // Default: acquire from pool
    const instance = await this.pool.acquire();

    return {
      client: instance.client,
      instance,
      engine: "lightpanda",
      fromPool: true,
    };
  }

  /**
   * Release client back to pool
   */
  async release(result: PooledClientResult): Promise<void> {
    if (result.fromPool && result.instance) {
      await this.pool.release(result.instance);
    }
  }

  /**
   * Get pool metrics
   */
  getMetrics() {
    return this.pool.getMetrics();
  }

  /**
   * Shutdown pool
   */
  async shutdown(): Promise<void> {
    await this.pool.shutdown();
    log.info("Pool manager shutdown complete");
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let poolManager: PoolManager | undefined;

export function getPoolManager(config?: Parameters<typeof PoolManager>[0]): PoolManager {
  if (!poolManager) {
    poolManager = new PoolManager(config);
  }
  return poolManager;
}

export async function initializePoolManager(config?: Parameters<typeof PoolManager>[0]): Promise<PoolManager> {
  const manager = getPoolManager(config);
  await manager.initialize();
  return manager;
}

// ============================================================================
// CONVENIENCE API
// ============================================================================

/**
 * Execute task with pooled client
 */
export async function withPooledClient<T>(
  taskContext: TaskContext,
  fn: (client: any) => Promise<T>
): Promise<T> {
  const manager = getPoolManager();
  const result = await manager.getClient({ taskContext });

  try {
    if (result.engine === "chromium") {
      throw new Error("Chromium required but not available in pool");
    }

    return await fn(result.client);
  } finally {
    await manager.release(result);
  }
}

/**
 * Batch execute tasks with pool
 */
export async function batchWithPool<T>(
  tasks: Array<{ context: TaskContext; fn: (client: any) => Promise<T> }>
): Promise<T[]> {
  const manager = getPoolManager();
  const results: T[] = [];

  // Execute in parallel
  const promises = tasks.map(async ({ context, fn }) => {
    const result = await manager.getClient({ taskContext: context });

    try {
      if (result.engine === "chromium") {
        throw new Error(`Chromium required for ${context.action}`);
      }

      return await fn(result.client);
    } finally {
      await manager.release(result);
    }
  });

  return await Promise.all(promises);
}
