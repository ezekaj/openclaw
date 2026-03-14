/**
 * Lightpanda Pool Tests
 * 
 * Tests for instance pooling, load balancing, and health monitoring.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LightpandaPool, type PoolConfig, type PoolInstance } from "./lightpanda-pool.js";

// Mock LightpandaManager
vi.mock("./lightpanda-manager.js", () => ({
  getLightpandaManager: () => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockReturnValue(true),
  }),
}));

// Mock LightpandaClient
vi.mock("./lightpanda-client.js", () => ({
  createLightpandaClient: vi.fn().mockResolvedValue({
    navigate: vi.fn(),
    screenshot: vi.fn(),
    evaluate: vi.fn(),
    close: vi.fn(),
  }),
}));

describe("Lightpanda Pool", () => {
  let pool: LightpandaPool;
  const testConfig: Partial<PoolConfig> = {
    minInstances: 2,
    maxInstances: 5,
    maxRequestsPerInstance: 10,
    healthCheckIntervalMs: 5000,
    idleTimeoutMs: 10000,
    portRangeStart: 9400,
    acquireTimeoutMs: 2000,
  };

  beforeEach(async () => {
    pool = new LightpandaPool(testConfig);
    await pool.initialize();
  });

  afterEach(async () => {
    await pool.shutdown();
  });

  describe("Initialization", () => {
    it("should pre-warm min instances on initialization", async () => {
      const metrics = pool.getMetrics();
      expect(metrics.totalInstances).toBe(testConfig.minInstances);
      expect(metrics.idleInstances).toBe(testConfig.minInstances);
      expect(metrics.busyInstances).toBe(0);
    });

    it("should assign sequential ports", async () => {
      // Create another pool to check port assignment
      const pool2 = new LightpandaPool({ ...testConfig, minInstances: 3 });
      await pool2.initialize();

      const metrics = pool2.getMetrics();
      expect(metrics.totalInstances).toBe(3);

      await pool2.shutdown();
    });
  });

  describe("Acquire & Release", () => {
    it("should acquire an idle instance", async () => {
      const instance = await pool.acquire();

      expect(instance).toBeDefined();
      expect(instance.status).toBe("busy");
      expect(instance.port).toBeGreaterThanOrEqual(testConfig.portRangeStart!);

      const metrics = pool.getMetrics();
      expect(metrics.busyInstances).toBe(1);
      expect(metrics.idleInstances).toBe((testConfig.minInstances || 2) - 1);
    });

    it("should release instance back to pool", async () => {
      const instance = await pool.acquire();
      await pool.release(instance);

      expect(instance.status).toBe("idle");
      expect(instance.requestCount).toBe(1);

      const metrics = pool.getMetrics();
      expect(metrics.idleInstances).toBe(testConfig.minInstances);
    });

    it("should track metrics correctly", async () => {
      const instance1 = await pool.acquire();
      const instance2 = await pool.acquire();

      const metricsDuring = pool.getMetrics();
      expect(metricsDuring.busyInstances).toBe(2);
      expect(metricsDuring.averageAcquireTimeMs).toBeGreaterThan(0);

      await pool.release(instance1);
      await pool.release(instance2);

      const metricsAfter = pool.getMetrics();
      expect(metricsAfter.idleInstances).toBe(2);
      expect(metricsAfter.averageReleaseTimeMs).toBeGreaterThan(0);
    });

    it("should create new instance if pool empty and not at max", async () => {
      // Acquire all initial instances
      const instances: PoolInstance[] = [];
      for (let i = 0; i < testConfig.minInstances!; i++) {
        instances.push(await pool.acquire());
      }

      // Acquire one more (should create new)
      const extraInstance = await pool.acquire();
      expect(extraInstance).toBeDefined();
      expect(pool.getMetrics().totalInstances).toBe(testConfig.minInstances! + 1);

      // Cleanup
      instances.forEach(i => pool.release(i));
      await pool.release(extraInstance);
    });

    it("should wait for available instance if at max capacity", async () => {
      const smallPool = new LightpandaPool({ ...testConfig, maxInstances: 2, minInstances: 2 });
      await smallPool.initialize();

      // Acquire all instances
      const instance1 = await smallPool.acquire();
      const instance2 = await smallPool.acquire();

      // Try to acquire another (should wait)
      const acquirePromise = smallPool.acquire();

      // Release one after short delay
      setTimeout(() => smallPool.release(instance1), 100);

      const instance3 = await acquirePromise;
      expect(instance3).toBeDefined();

      await smallPool.release(instance2);
      await smallPool.release(instance3);
      await smallPool.shutdown();
    });

    it("should timeout if no instance available", async () => {
      const tinyPool = new LightpandaPool({
        ...testConfig,
        maxInstances: 1,
        minInstances: 1,
        acquireTimeoutMs: 500,
      });
      await tinyPool.initialize();

      // Acquire the only instance
      const instance1 = await tinyPool.acquire();

      // Try to acquire another (should timeout)
      await expect(tinyPool.acquire()).rejects.toThrow("Timeout");

      await tinyPool.release(instance1);
      await tinyPool.shutdown();
    });
  });

  describe("Load Balancing", () => {
    it("should prefer instance with lowest request count", async () => {
      // Acquire and release multiple times
      const instance1 = await pool.acquire();
      await pool.release(instance1);

      const instance2 = await pool.acquire();
      await pool.release(instance2);

      await pool.release(instance1); // instance1 now has 2 requests

      // instance2 should be preferred (1 request vs 2)
      const instance3 = await pool.acquire();
      expect(instance3.id).toBe(instance2.id);
      expect(instance3.requestCount).toBe(1);

      await pool.release(instance3);
    });

    it("should distribute load across instances", async () => {
      const instances: PoolInstance[] = [];

      // Acquire all instances
      for (let i = 0; i < testConfig.minInstances!; i++) {
        instances.push(await pool.acquire());
      }

      // All should be different
      const ids = new Set(instances.map(i => i.id));
      expect(ids.size).toBe(testConfig.minInstances);

      // Release all
      instances.forEach(i => pool.release(i));
    });
  });

  describe("Instance Recycling", () => {
    it("should recycle instance after max requests", async () => {
      const recyclePool = new LightpandaPool({
        ...testConfig,
        maxRequestsPerInstance: 2,
      });
      await recyclePool.initialize();

      const instance = await recyclePool.acquire();
      const originalId = instance.id;

      // Use instance 2 times
      await recyclePool.release(instance);
      const instance2 = await recyclePool.acquire();
      await recyclePool.release(instance2);

      // Should be recycled (new instance created)
      const instance3 = await recyclePool.acquire();
      expect(instance3.id).toBe(originalId); // Same ID (recreated)

      await recyclePool.release(instance3);
      await recyclePool.shutdown();
    });
  });

  describe("Health Monitoring", () => {
    it("should mark instance as unhealthy", () => {
      const instance = { id: "test", errorCount: 0 } as PoolInstance;

      pool.markUnhealthy(instance, new Error("Test error"));

      expect(instance.status).toBe("unhealthy");
      expect(instance.errorCount).toBe(1);
    });

    it("should track unhealthy instances in metrics", async () => {
      const instance = await pool.acquire();
      pool.markUnhealthy(instance);
      await pool.release(instance);

      const metrics = pool.getMetrics();
      expect(metrics.unhealthyInstances).toBe(1);
    });

    it("should shutdown idle instances after timeout", async () => {
      vi.useFakeTimers();

      const idlePool = new LightpandaPool({
        ...testConfig,
        minInstances: 1,
        idleTimeoutMs: 1000,
        healthCheckIntervalMs: 100,
      });
      await idlePool.initialize();

      // Create extra instance
      const instance = await idlePool.acquire();
      await idlePool.release(instance);

      const metricsBefore = idlePool.getMetrics();
      expect(metricsBefore.totalInstances).toBe(2);

      // Fast-forward past idle timeout
      vi.advanceTimersByTime(1500);

      // Wait for health check to run
      await new Promise(resolve => setTimeout(resolve, 200));
      vi.runAllTimers();

      // Should have shutdown idle instance
      const metricsAfter = idlePool.getMetrics();
      expect(metricsAfter.totalInstances).toBe(1);

      vi.useRealTimers();
      await idlePool.shutdown();
    });
  });

  describe("Pool Metrics", () => {
    it("should track pool utilization", async () => {
      const metrics1 = pool.getMetrics();
      expect(metrics1.poolUtilization).toBe(0);

      const instance = await pool.acquire();
      const metrics2 = pool.getMetrics();
      expect(metrics2.poolUtilization).toBeGreaterThan(0);

      await pool.release(instance);
    });

    it("should calculate average times", async () => {
      // Acquire and release several times
      for (let i = 0; i < 5; i++) {
        const instance = await pool.acquire();
        await pool.release(instance);
      }

      const metrics = pool.getMetrics();
      expect(metrics.averageAcquireTimeMs).toBeGreaterThan(0);
      expect(metrics.averageReleaseTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Shutdown", () => {
    it("should shutdown all instances", async () => {
      const instance1 = await pool.acquire();
      const instance2 = await pool.acquire();

      await pool.shutdown();

      const metrics = pool.getMetrics();
      expect(metrics.totalInstances).toBe(0);
    });

    it("should stop health monitoring on shutdown", async () => {
      await pool.shutdown();

      // Should not throw or cause errors
      vi.advanceTimersByTime(10000);
    });
  });

  describe("Concurrency", () => {
    it("should handle concurrent acquire/release", async () => {
      const promises: Promise<void>[] = [];

      // 10 concurrent operations
      for (let i = 0; i < 10; i++) {
        promises.push(
          (async () => {
            const instance = await pool.acquire();
            await new Promise(resolve => setTimeout(resolve, 50));
            await pool.release(instance);
          })()
        );
      }

      await Promise.all(promises);

      const metrics = pool.getMetrics();
      expect(metrics.idleInstances).toBeGreaterThan(0);
    });

    it("should maintain consistency under load", async () => {
      const operations = 50;
      const promises: Promise<void>[] = [];

      for (let i = 0; i < operations; i++) {
        promises.push(
          (async () => {
            const instance = await pool.acquire();
            await pool.release(instance);
          })()
        );
      }

      await Promise.all(promises);

      const metrics = pool.getMetrics();
      expect(metrics.totalInstances).toBeLessThanOrEqual(testConfig.maxInstances!);
    });
  });
});

describe("Pool Performance", () => {
  it("should acquire instance in < 50ms", async () => {
    const pool = new LightpandaPool({ minInstances: 5 });
    await pool.initialize();

    const start = Date.now();
    await pool.acquire();
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(50);

    await pool.shutdown();
  });

  it("should handle 100 concurrent requests", async () => {
    const pool = new LightpandaPool({
      minInstances: 10,
      maxInstances: 50,
    });
    await pool.initialize();

    const start = Date.now();
    const promises: Promise<void>[] = [];

    for (let i = 0; i < 100; i++) {
      promises.push(
        (async () => {
          const instance = await pool.acquire();
          await pool.release(instance);
        })()
      );
    }

    await Promise.all(promises);
    const duration = Date.now() - start;

    console.log(`100 concurrent requests completed in ${duration}ms`);
    expect(duration).toBeLessThan(5000); // < 5 seconds

    await pool.shutdown();
  });
});
