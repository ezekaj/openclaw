/**
 * Lightpanda Instance Pool
 * 
 * Manages multiple Lightpanda instances for concurrent browsing.
 * Provides load balancing, health monitoring, and auto-scaling.
 * 
 * Goal: 50 concurrent browsers on 8GB RAM (150MB each)
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { LightpandaClient, createLightpandaClient } from "./lightpanda-client.js";
import { getLightpandaManager, LightpandaManager } from "./lightpanda-manager.js";

const log = createSubsystemLogger("lightpanda-pool");

// ============================================================================
// TYPES
// ============================================================================

export interface PoolInstance {
  id: string;
  client: LightpandaClient;
  port: number;
  status: "idle" | "busy" | "unhealthy";
  lastUsed: number;
  requestCount: number;
  errorCount: number;
  acquiredAt?: number;
}

export interface PoolConfig {
  minInstances: number;      // Pre-warm this many on startup
  maxInstances: number;      // Maximum concurrent instances
  maxRequestsPerInstance: number;  // Recycle after this many requests
  healthCheckIntervalMs: number;   // Check health periodically
  idleTimeoutMs: number;          // Shutdown idle instances
  portRangeStart: number;         // Starting port for instances
  acquireTimeoutMs: number;       // Max time to wait for available instance
}

export interface PoolMetrics {
  totalInstances: number;
  idleInstances: number;
  busyInstances: number;
  unhealthyInstances: number;
  totalRequests: number;
  averageAcquireTimeMs: number;
  averageReleaseTimeMs: number;
  poolUtilization: number; // 0-1, how busy the pool is
}

// ============================================================================
// DEFAULT CONFIG
// ============================================================================

const DEFAULT_POOL_CONFIG: PoolConfig = {
  minInstances: 5,           // Pre-warm 5 instances
  maxInstances: 50,          // Max 50 concurrent (8GB RAM / 150MB each)
  maxRequestsPerInstance: 100,  // Recycle after 100 requests
  healthCheckIntervalMs: 30000,  // Check every 30s
  idleTimeoutMs: 300000,        // Shutdown after 5min idle
  portRangeStart: 9300,         // Start at port 9300
  acquireTimeoutMs: 5000,        // Wait up to 5s for instance
};

// ============================================================================
// LIGHTPANDA POOL
// ============================================================================

export class LightpandaPool {
  private instances: Map<string, PoolInstance> = new Map();
  private manager: LightpandaManager;
  private config: PoolConfig;
  private nextPort: number;
  private healthCheckTimer?: NodeJS.Timeout;
  private metrics = {
    totalRequests: 0,
    totalAcquireTime: 0,
    totalReleaseTime: 0,
    acquireCount: 0,
    releaseCount: 0,
  };

  constructor(config: Partial<PoolConfig> = {}) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
    this.nextPort = this.config.portRangeStart;
    this.manager = getLightpandaManager();

    log.info("Lightpanda pool created", {
      minInstances: this.config.minInstances,
      maxInstances: this.config.maxInstances,
      portRange: `${this.config.portRangeStart}-${this.config.portRangeStart + this.config.maxInstances}`,
    });
  }

  /**
   * Initialize pool with pre-warmed instances
   */
  async initialize(): Promise<void> {
    log.info("Initializing Lightpanda pool", {
      preWarmCount: this.config.minInstances,
    });

    // Pre-warm instances
    const warmupPromises: Promise<void>[] = [];
    for (let i = 0; i < this.config.minInstances; i++) {
      warmupPromises.push(this.createInstance());
    }

    await Promise.all(warmupPromises);

    // Start health monitoring
    this.startHealthMonitoring();

    log.info("Pool initialized", {
      instances: this.instances.size,
    });
  }

  /**
   * Create a new instance
   */
  private async createInstance(): Promise<void> {
    if (this.instances.size >= this.config.maxInstances) {
      throw new Error(`Pool at max capacity (${this.config.maxInstances} instances)`);
    }

    const port = this.nextPort++;
    const id = `lightpanda-${port}`;

    try {
      // Start Lightpanda instance
      await this.manager.start({ port });

      // Create client
      const client = await createLightpandaClient({ port });

      // Track instance
      const instance: PoolInstance = {
        id,
        client,
        port,
        status: "idle",
        lastUsed: Date.now(),
        requestCount: 0,
        errorCount: 0,
      };

      this.instances.set(id, instance);

      log.debug("Instance created", { id, port });
    } catch (error) {
      log.error("Failed to create instance", { port, error });
      throw error;
    }
  }

  /**
   * Acquire an instance from the pool
   */
  async acquire(): Promise<PoolInstance> {
    const startTime = Date.now();

    // Find idle instance
    let instance = this.findIdleInstance();

    // If no idle instance and not at max, create new
    if (!instance && this.instances.size < this.config.maxInstances) {
      await this.createInstance();
      instance = this.findIdleInstance();
    }

    // If still no instance, wait for one to be released
    if (!instance) {
      instance = await this.waitForAvailableInstance();
    }

    // Mark as busy
    instance.status = "busy";
    instance.acquiredAt = Date.now();

    // Update metrics
    const acquireTime = Date.now() - startTime;
    this.metrics.totalAcquireTime += acquireTime;
    this.metrics.acquireCount++;

    log.debug("Instance acquired", {
      id: instance.id,
      acquireTimeMs: acquireTime,
      poolUtilization: this.getPoolUtilization(),
    });

    return instance;
  }

  /**
   * Release an instance back to the pool
   */
  async release(instance: PoolInstance): Promise<void> {
    const startTime = Date.now();

    instance.status = "idle";
    instance.lastUsed = Date.now();
    instance.requestCount++;
    delete instance.acquiredAt;

    // Check if instance should be recycled
    if (instance.requestCount >= this.config.maxRequestsPerInstance) {
      await this.recycleInstance(instance);
    }

    // Update metrics
    const releaseTime = Date.now() - startTime;
    this.metrics.totalReleaseTime += releaseTime;
    this.metrics.releaseCount++;

    log.debug("Instance released", {
      id: instance.id,
      requestCount: instance.requestCount,
      releaseTimeMs: releaseTime,
    });
  }

  /**
   * Mark instance as unhealthy
   */
  markUnhealthy(instance: PoolInstance, error?: Error): void {
    instance.status = "unhealthy";
    instance.errorCount++;

    log.warn("Instance marked unhealthy", {
      id: instance.id,
      errorCount: instance.errorCount,
      error: error?.message,
    });
  }

  /**
   * Get pool metrics
   */
  getMetrics(): PoolMetrics {
    const instances = Array.from(this.instances.values());
    const idle = instances.filter(i => i.status === "idle").length;
    const busy = instances.filter(i => i.status === "busy").length;
    const unhealthy = instances.filter(i => i.status === "unhealthy").length;

    return {
      totalInstances: this.instances.size,
      idleInstances: idle,
      busyInstances: busy,
      unhealthyInstances: unhealthy,
      totalRequests: this.metrics.totalRequests,
      averageAcquireTimeMs: this.metrics.acquireCount > 0
        ? this.metrics.totalAcquireTime / this.metrics.acquireCount
        : 0,
      averageReleaseTimeMs: this.metrics.releaseCount > 0
        ? this.metrics.totalReleaseTime / this.metrics.releaseCount
        : 0,
      poolUtilization: this.getPoolUtilization(),
    };
  }

  /**
   * Shutdown pool and all instances
   */
  async shutdown(): Promise<void> {
    log.info("Shutting down pool", {
      instances: this.instances.size,
    });

    // Stop health monitoring
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    // Shutdown all instances
    const shutdownPromises = Array.from(this.instances.values()).map(instance =>
      this.shutdownInstance(instance)
    );

    await Promise.all(shutdownPromises);

    this.instances.clear();

    log.info("Pool shutdown complete");
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  /**
   * Find an idle instance
   */
  private findIdleInstance(): PoolInstance | undefined {
    // Prefer instance with lowest request count (load balancing)
    const idleInstances = Array.from(this.instances.values())
      .filter(i => i.status === "idle")
      .sort((a, b) => a.requestCount - b.requestCount);

    return idleInstances[0];
  }

  /**
   * Wait for an available instance
   */
  private async waitForAvailableInstance(): Promise<PoolInstance> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const checkForInstance = () => {
        const elapsed = Date.now() - startTime;

        if (elapsed > this.config.acquireTimeoutMs) {
          reject(new Error("Timeout waiting for available instance"));
          return;
        }

        const instance = this.findIdleInstance();
        if (instance) {
          resolve(instance);
        } else {
          // Check again in 100ms
          setTimeout(checkForInstance, 100);
        }
      };

      checkForInstance();
    });
  }

  /**
   * Get pool utilization (0-1)
   */
  private getPoolUtilization(): number {
    if (this.instances.size === 0) return 0;

    const busyInstances = Array.from(this.instances.values())
      .filter(i => i.status === "busy").length;

    return busyInstances / this.instances.size;
  }

  /**
   * Recycle an instance (shutdown + create new)
   */
  private async recycleInstance(instance: PoolInstance): Promise<void> {
    log.info("Recycling instance", {
      id: instance.id,
      requestCount: instance.requestCount,
    });

    await this.shutdownInstance(instance);
    this.instances.delete(instance.id);

    await this.createInstance();
  }

  /**
   * Shutdown a single instance
   */
  private async shutdownInstance(instance: PoolInstance): Promise<void> {
    try {
      await this.manager.stop(instance.port);
      log.debug("Instance shutdown", { id: instance.id });
    } catch (error) {
      log.error("Failed to shutdown instance", {
        id: instance.id,
        error,
      });
    }
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckTimer = setInterval(async () => {
      await this.performHealthChecks();
    }, this.config.healthCheckIntervalMs);

    log.debug("Health monitoring started", {
      intervalMs: this.config.healthCheckIntervalMs,
    });
  }

  /**
   * Perform health checks on all instances
   */
  private async performHealthChecks(): Promise<void> {
    const now = Date.now();

    for (const instance of this.instances.values()) {
      // Check if idle timeout exceeded
      if (
        instance.status === "idle" &&
        now - instance.lastUsed > this.config.idleTimeoutMs &&
        this.instances.size > this.config.minInstances
      ) {
        log.info("Shutting down idle instance", {
          id: instance.id,
          idleMs: now - instance.lastUsed,
        });

        await this.shutdownInstance(instance);
        this.instances.delete(instance.id);
        continue;
      }

      // Check health of busy instances (they might be stuck)
      if (instance.status === "busy" && instance.acquiredAt) {
        const busyDuration = now - instance.acquiredAt;

        // If busy for > 5 minutes, mark as unhealthy
        if (busyDuration > 300000) {
          this.markUnhealthy(instance, new Error("Instance stuck in busy state"));
        }
      }

      // Try to recover unhealthy instances
      if (instance.status === "unhealthy") {
        await this.recycleInstance(instance);
      }
    }

    // Ensure minimum instances
    while (this.instances.size < this.config.minInstances) {
      await this.createInstance();
    }
  }
}

// ============================================================================
// SINGLETON
// ============================================================================

let poolInstance: LightpandaPool | undefined;

export function getLightpandaPool(config?: Partial<PoolConfig>): LightpandaPool {
  if (!poolInstance) {
    poolInstance = new LightpandaPool(config);
  }
  return poolInstance;
}

export async function initializePool(config?: Partial<PoolConfig>): Promise<LightpandaPool> {
  const pool = getLightpandaPool(config);
  await pool.initialize();
  return pool;
}
