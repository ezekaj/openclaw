/**
 * LRU Cache Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { LRUCache, EmbeddingCache, getEmbeddingCache, resetEmbeddingCache } from "./lru-cache.js";

describe("LRUCache", () => {
  let cache: LRUCache<string, number>;

  beforeEach(() => {
    cache = new LRUCache<string, number>({
      maxSize: 3,
      ttl: 1000, // 1 second for testing
      enableStats: true,
    });
  });

  describe("Basic Operations", () => {
    it("should set and get values", () => {
      cache.set("a", 1);
      expect(cache.get("a")).toBe(1);
    });

    it("should return undefined for missing keys", () => {
      expect(cache.get("missing")).toBeUndefined();
    });

    it("should overwrite existing values", () => {
      cache.set("a", 1);
      cache.set("a", 2);
      expect(cache.get("a")).toBe(2);
    });

    it("should check if key exists", () => {
      cache.set("a", 1);
      expect(cache.has("a")).toBe(true);
      expect(cache.has("b")).toBe(false);
    });

    it("should delete keys", () => {
      cache.set("a", 1);
      expect(cache.delete("a")).toBe(true);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.delete("a")).toBe(false);
    });

    it("should clear all keys", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.clear();
      expect(cache.size).toBe(0);
    });
  });

  describe("LRU Eviction", () => {
    it("should evict oldest entry when full", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      cache.set("d", 4); // Should evict "a"

      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("b")).toBe(2);
      expect(cache.get("c")).toBe(3);
      expect(cache.get("d")).toBe(4);
    });

    it("should update position on access", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      
      // Access "a" to make it most recently used
      cache.get("a");
      
      // Add new item - should evict "b" instead of "a"
      cache.set("d", 4);

      expect(cache.get("a")).toBe(1); // Still there
      expect(cache.get("b")).toBeUndefined(); // Evicted
    });

    it("should update position on set", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      
      // Update "a" to make it most recently used
      cache.set("a", 10);
      
      // Add new item - should evict "b" instead of "a"
      cache.set("d", 4);

      expect(cache.get("a")).toBe(10); // Updated and still there
      expect(cache.get("b")).toBeUndefined(); // Evicted
    });

    it("should respect max size", () => {
      for (let i = 0; i < 10; i++) {
        cache.set(`key${i}`, i);
      }

      // Should only have last 3 entries
      expect(cache.size).toBe(3);
    });
  });

  describe("TTL (Time To Live)", () => {
    it("should expire entries after TTL", async () => {
      cache.set("a", 1, 100); // 100ms TTL

      expect(cache.get("a")).toBe(1);

      await new Promise(resolve => setTimeout(resolve, 150));

      expect(cache.get("a")).toBeUndefined();
    });

    it("should use default TTL", async () => {
      cache.set("a", 1); // Uses default 1000ms TTL

      expect(cache.get("a")).toBe(1);

      await new Promise(resolve => setTimeout(resolve, 1100));

      expect(cache.get("a")).toBeUndefined();
    });

    it("should cleanup expired entries", async () => {
      cache.set("a", 1, 100);
      cache.set("b", 2, 100);
      cache.set("c", 3, 1000); // Won't expire

      await new Promise(resolve => setTimeout(resolve, 150));

      const cleaned = cache.cleanup();

      expect(cleaned).toBe(2);
      expect(cache.size).toBe(1);
      expect(cache.get("c")).toBe(3);
    });

    it("should treat expired entries as missing in has()", async () => {
      cache.set("a", 1, 100);

      await new Promise(resolve => setTimeout(resolve, 150));

      expect(cache.has("a")).toBe(false);
    });
  });

  describe("Statistics", () => {
    it("should track hits and misses", () => {
      cache.set("a", 1);

      cache.get("a"); // Hit
      cache.get("a"); // Hit
      cache.get("b"); // Miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
    });

    it("should calculate hit rate", () => {
      cache.set("a", 1);

      cache.get("a"); // Hit
      cache.get("a"); // Hit
      cache.get("b"); // Miss
      cache.get("c"); // Miss

      expect(cache.getHitRate()).toBe(0.5); // 2/4 = 0.5
    });

    it("should track evictions", () => {
      cache.set("a", 1);
      cache.set("b", 2);
      cache.set("c", 3);
      cache.set("d", 4); // Evicts "a"

      const stats = cache.getStats();
      expect(stats.evictions).toBe(1);
    });

    it("should track size", () => {
      expect(cache.getStats().size).toBe(0);

      cache.set("a", 1);
      expect(cache.getStats().size).toBe(1);

      cache.set("b", 2);
      expect(cache.getStats().size).toBe(2);
    });
  });
});

describe("EmbeddingCache", () => {
  let cache: EmbeddingCache;
  let computeCount = 0;

  beforeEach(() => {
    cache = new EmbeddingCache({
      maxSize: 100,
      ttl: 1000,
    });
    computeCount = 0;
  });

  const mockCompute = async (texts: string[]): Promise<number[][]> => {
    computeCount += texts.length;
    return texts.map((_, i) => [i, i + 1, i + 2]);
  };

  describe("Caching", () => {
    it("should cache embeddings by text", async () => {
      const text = "test embedding";
      const embedding = [1, 2, 3];

      const result1 = await cache.getOrCompute(text, async () => {
        computeCount++;
        return embedding;
      });

      const result2 = await cache.getOrCompute(text, async () => {
        computeCount++;
        return [9, 9, 9]; // Should not be called
      });

      expect(result1).toEqual(embedding);
      expect(result2).toEqual(embedding);
      expect(computeCount).toBe(1); // Only computed once
    });

    it("should handle batch operations", async () => {
      const texts = ["a", "b", "c", "a"]; // "a" is duplicate

      const results = await cache.batchGetOrCompute(texts, mockCompute);

      expect(results).toHaveLength(4);
      expect(computeCount).toBe(3); // Only 3 unique texts
      expect(results[0]).toEqual(results[3]); // "a" should be same
    });

    it("should reuse cached embeddings in batch", async () => {
      // Pre-cache "a"
      await cache.getOrCompute("a", async () => {
        computeCount++;
        return [1, 1, 1];
      });

      expect(computeCount).toBe(1);

      // Batch with "a" and new texts
      const texts = ["a", "b", "c"];
      await cache.batchGetOrCompute(texts, mockCompute);

      expect(computeCount).toBe(1 + 2); // Initial + 2 new
    });
  });

  describe("Statistics", () => {
    it("should track hit rate", async () => {
      await cache.getOrCompute("a", async () => [1]); // Miss
      await cache.getOrCompute("a", async () => [1]); // Hit
      await cache.getOrCompute("a", async () => [1]); // Hit

      const stats = cache.getStats();
      expect(stats.hitRate).toBeCloseTo(2 / 3);
    });

    it("should track size", async () => {
      const stats1 = cache.getStats();
      expect(stats1.size).toBe(0);

      await cache.getOrCompute("a", async () => [1]);
      await cache.getOrCompute("b", async () => [2]);

      const stats2 = cache.getStats();
      expect(stats2.size).toBe(2);
    });
  });

  describe("Cleanup", () => {
    it("should clear cache", async () => {
      await cache.getOrCompute("a", async () => [1]);
      await cache.getOrCompute("b", async () => [2]);

      cache.clear();

      expect(cache.getStats().size).toBe(0);
    });

    it("should cleanup expired", async () => {
      const shortCache = new EmbeddingCache({ ttl: 100 });

      await shortCache.getOrCompute("a", async () => [1]);

      await new Promise(resolve => setTimeout(resolve, 150));

      const cleaned = shortCache.cleanup();
      expect(cleaned).toBe(1);
    });
  });

  describe("Singleton", () => {
    it("should return same instance", () => {
      resetEmbeddingCache();
      const instance1 = getEmbeddingCache();
      const instance2 = getEmbeddingCache();

      expect(instance1).toBe(instance2);
    });

    it("should reset singleton", () => {
      const instance1 = getEmbeddingCache();
      resetEmbeddingCache();
      const instance2 = getEmbeddingCache();

      expect(instance1).not.toBe(instance2);
    });
  });
});
