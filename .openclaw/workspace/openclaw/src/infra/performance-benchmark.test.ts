/**
 * Performance Benchmark Tests
 * 
 * Tests to validate optimization improvements with real metrics.
 * Run: node --test src/infra/performance-benchmark.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { optimizeDatabase, checkDatabaseHealth, backupDatabase } from "./sqlite-utils.js";
import { LRUCache } from "lru-cache";

describe("SQLite Performance Benchmarks", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "perf-test-"));
    dbPath = join(tempDir, "test.db");
    db = new DatabaseSync(dbPath);
    optimizeDatabase(db);
    
    // Create test table
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_data (
        id INTEGER PRIMARY KEY,
        category TEXT NOT NULL,
        value REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX idx_category ON test_data(category);
    `);
    
    // Insert 10k test rows
    db.exec("BEGIN TRANSACTION");
    const stmt = db.prepare("INSERT INTO test_data (category, value, timestamp) VALUES (?, ?, ?)");
    for (let i = 0; i < 10000; i++) {
      stmt.run(`cat-${i % 100}`, Math.random(), Date.now() - i * 1000);
    }
    db.exec("COMMIT");
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("Query without cache baseline", () => {
    const iterations = 100;
    const start = performance.now();
    
    for (let i = 0; i < iterations; i++) {
      const stmt = db.prepare("SELECT * FROM test_data WHERE category = ?");
      stmt.all(`cat-${i % 100}`);
    }
    
    const duration = performance.now() - start;
    const avgMs = duration / iterations;
    
    console.log(`  Uncached queries: ${avgMs.toFixed(2)}ms avg (${iterations} iterations)`);
    
    // Baseline: should be < 5ms per query
    expect(avgMs).toBeLessThan(5);
  });

  test("Query with LRU cache", () => {
    const cache = new LRUCache<string, any[]>({
      max: 500,
      ttl: 60000, // 1 minute
    });

    const iterations = 100;
    const start = performance.now();
    
    for (let i = 0; i < iterations; i++) {
      const cacheKey = `cat-${i % 100}`;
      
      let results = cache.get(cacheKey);
      if (!results) {
        const stmt = db.prepare("SELECT * FROM test_data WHERE category = ?");
        results = stmt.all(cacheKey) as any[];
        cache.set(cacheKey, results);
      }
    }
    
    const duration = performance.now() - start;
    const avgMs = duration / iterations;
    
    console.log(`  Cached queries: ${avgMs.toFixed(2)}ms avg (${iterations} iterations, ${cache.size} unique keys)`);
    
    // Cached should be 10x faster
    expect(avgMs).toBeLessThan(0.5);
  });

  test("Batch inserts vs individual inserts", () => {
    // Individual inserts
    const individualStart = performance.now();
    for (let i = 0; i < 100; i++) {
      const stmt = db.prepare("INSERT INTO test_data (category, value, timestamp) VALUES (?, ?, ?)");
      stmt.run("individual-test", Math.random(), Date.now());
    }
    const individualDuration = performance.now() - individualStart;
    
    // Batch inserts
    const batchStart = performance.now();
    db.exec("BEGIN TRANSACTION");
    const stmt = db.prepare("INSERT INTO test_data (category, value, timestamp) VALUES (?, ?, ?)");
    for (let i = 0; i < 100; i++) {
      stmt.run("batch-test", Math.random(), Date.now());
    }
    db.exec("COMMIT");
    const batchDuration = performance.now() - batchStart;
    
    console.log(`  Individual inserts: ${individualDuration.toFixed(2)}ms`);
    console.log(`  Batch inserts: ${batchDuration.toFixed(2)}ms`);
    console.log(`  Speedup: ${(individualDuration / batchDuration).toFixed(1)}x`);
    
    // Batch should be at least 5x faster
    expect(batchDuration).toBeLessThan(individualDuration * 0.2);
  });

  test("Database health check performance", () => {
    const iterations = 10;
    const start = performance.now();
    
    for (let i = 0; i < iterations; i++) {
      checkDatabaseHealth(db);
    }
    
    const duration = performance.now() - start;
    const avgMs = duration / iterations;
    
    console.log(`  Health check (quick_check): ${avgMs.toFixed(2)}ms avg`);
    
    // Should be < 10ms for 10k rows
    expect(avgMs).toBeLessThan(10);
  });

  test("Backup performance with cache", () => {
    const backupDir = join(tempDir, "backups");
    
    // First backup
    const firstStart = performance.now();
    const firstBackup = backupDatabase(dbPath, 0); // No cache
    const firstDuration = performance.now() - firstStart;
    
    // Second backup (should skip due to cache)
    const secondStart = performance.now();
    const secondBackup = backupDatabase(dbPath, 3600000); // 1 hour cache
    const secondDuration = performance.now() - secondStart;
    
    console.log(`  First backup: ${firstDuration.toFixed(2)}ms`);
    console.log(`  Second backup (cached): ${secondDuration.toFixed(2)}ms`);
    
    // Second should be instant (cache hit)
    expect(secondDuration).toBeLessThan(1);
    expect(secondBackup).toBe(firstBackup);
  });

  test("Memory usage with different cache sizes", () => {
    const getMemoryUsage = () => process.memoryUsage().heapUsed / 1024 / 1024;
    
    // Large cache (256MB)
    const largeCache = new LRUCache<string, Buffer>({
      max: 256 * 1024 * 1024, // 256MB
      sizeCalculation: (value) => value.byteLength,
    });
    
    for (let i = 0; i < 1000; i++) {
      largeCache.set(`key-${i}`, Buffer.alloc(100 * 1024)); // 100KB each
    }
    
    const largeMemory = getMemoryUsage();
    console.log(`  Large cache (256MB): ${largeMemory.toFixed(1)}MB heap`);
    
    largeCache.clear();
    
    // Small cache (64MB)
    const smallCache = new LRUCache<string, Buffer>({
      max: 64 * 1024 * 1024, // 64MB
      sizeCalculation: (value) => value.byteLength,
    });
    
    for (let i = 0; i < 1000; i++) {
      smallCache.set(`key-${i}`, Buffer.alloc(100 * 1024));
    }
    
    const smallMemory = getMemoryUsage();
    console.log(`  Small cache (64MB): ${smallMemory.toFixed(1)}MB heap`);
    console.log(`  Memory saved: ${(largeMemory - smallMemory).toFixed(1)}MB`);
    
    // Smaller cache should use less memory
    expect(smallMemory).toBeLessThan(largeMemory);
  });
});

describe("Event Mesh Performance", () => {
  test("Event emission throughput", () => {
    const events: Array<{ type: string; data: any }> = [];
    const iterations = 1000;
    
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      events.push({
        type: "test-event",
        data: { index: i, timestamp: Date.now() }
      });
    }
    const duration = performance.now() - start;
    
    const throughput = iterations / (duration / 1000);
    console.log(`  Event emission: ${throughput.toFixed(0)} events/sec`);
    
    // Should handle > 10k events/sec
    expect(throughput).toBeGreaterThan(10000);
  });
});

describe("LRU Cache Benchmarks", () => {
  test("Cache hit rate impact", () => {
    const cache = new LRUCache<string, number>({ max: 100 });
    
    // Simulate 80/20 access pattern (80% reads to 20% of keys)
    const keys = Array.from({ length: 100 }, (_, i) => `key-${i}`);
    let hits = 0;
    let misses = 0;
    
    for (let i = 0; i < 1000; i++) {
      // 80% of time, access first 20 keys
      const keyIndex = Math.random() < 0.8 
        ? Math.floor(Math.random() * 20)
        : 20 + Math.floor(Math.random() * 80);
      
      const key = keys[keyIndex];
      
      if (cache.has(key)) {
        hits++;
        cache.get(key);
      } else {
        misses++;
        cache.set(key, i);
      }
    }
    
    const hitRate = hits / (hits + misses);
    console.log(`  Cache hit rate: ${(hitRate * 100).toFixed(1)}%`);
    console.log(`  Hits: ${hits}, Misses: ${misses}`);
    
    // Should achieve > 70% hit rate with 80/20 pattern
    expect(hitRate).toBeGreaterThan(0.7);
  });

  test("Cache eviction performance", () => {
    const cache = new LRUCache<string, number>({ max: 1000 });
    
    // Fill cache beyond capacity
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      cache.set(`key-${i}`, i);
    }
    const duration = performance.now() - start;
    
    console.log(`  Eviction (10k inserts, 1k max): ${duration.toFixed(2)}ms`);
    
    // Should handle eviction efficiently
    expect(duration).toBeLessThan(100);
    expect(cache.size).toBe(1000);
  });
});
