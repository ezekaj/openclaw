import { createSubsystemLogger } from "../logging/subsystem.js";

export interface LRUCacheConfig {
  /** Maximum number of items - default: 1000 */
  maxSize?: number;
  /** Time-to-live in milliseconds - default: 3600000 (1 hour) */
  ttl?: number;
  /** Enable stats tracking */
  enableStats?: boolean;
}

interface CacheEntry<V> {
  value: V;
  timestamp: number;
  ttl: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  maxSize: number;
}

/**
 * Generic LRU Cache with TTL support
 */
export class LRUCache<K = string, V = unknown> {
  private readonly cache = new Map<K, CacheEntry<V>>();
  private readonly maxSize: number;
  private readonly defaultTtl: number;
  private readonly enableStats: boolean;
  private stats: CacheStats;

  constructor(config: LRUCacheConfig = {}) {
    this.maxSize = config.maxSize ?? 1000;
    this.defaultTtl = config.ttl ?? 3600000; // 1 hour
    this.enableStats = config.enableStats ?? false;
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      size: 0,
      maxSize: this.maxSize,
    };
  }

  /**
   * Get value from cache
   */
  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    
    if (!entry) {
      if (this.enableStats) this.stats.misses++;
      return undefined;
    }

    // Check TTL
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      if (this.enableStats) {
        this.stats.misses++;
        this.stats.evictions++;
        this.stats.size = this.cache.size;
      }
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    
    if (this.enableStats) this.stats.hits++;
    return entry.value;
  }

  /**
   * Set value in cache
   */
  set(key: K, value: V, ttl?: number): void {
    // Remove if exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    
    // Evict oldest if at capacity
    else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
        if (this.enableStats) {
          this.stats.evictions++;
        }
      }
    }

    // Add new entry
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      ttl: ttl ?? this.defaultTtl,
    });

    if (this.enableStats) this.stats.size = this.cache.size;
  }

  /**
   * Check if key exists (without updating access order)
   */
  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      if (this.enableStats) {
        this.stats.evictions++;
        this.stats.size = this.cache.size;
      }
      return false;
    }
    
    return true;
  }

  /**
   * Delete key from cache
   */
  delete(key: K): boolean {
    const deleted = this.cache.delete(key);
    if (deleted && this.enableStats) {
      this.stats.size = this.cache.size;
    }
    return deleted;
  }

  /**
   * Clear entire cache
   */
  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    if (this.enableStats) {
      this.stats.evictions += size;
      this.stats.size = this.cache.size;
    }
  }

  /**
   * Get current size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Get hit rate (0-1)
   */
  getHitRate(): number {
    if (!this.enableStats) return 0;
    const total = this.stats.hits + this.stats.misses;
    return total === 0 ? 0 : this.stats.hits / total;
  }

  /**
   * Cleanup expired entries
   */
  cleanup(): number {
    let cleaned = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (this.isExpired(entry)) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0 && this.enableStats) {
      this.stats.evictions += cleaned;
      this.stats.size = this.cache.size;
    }
    return cleaned;
  }

  /**
   * Check if entry is expired
   */
  private isExpired(entry: CacheEntry<V>): boolean {
    return Date.now() - entry.timestamp > entry.ttl;
  }
}

/**
 * Embedding Cache - Specialized for embedding vectors
 */
export class EmbeddingCache {
  private readonly cache: LRUCache<string, number[]>;
  private readonly textToKey: (text: string) => string;

  constructor(config: LRUCacheConfig = {}) {
    this.cache = new LRUCache<string, number[]>({
      maxSize: config.maxSize ?? 1000,
      ttl: config.ttl ?? 86400000, // 24 hours for embeddings
      enableStats: config.enableStats ?? true,
    });

    // Simple hash function for text
    this.textToKey = (text: string): string => {
      let hash = 0;
      for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash; // Convert to 32-bit integer
      }
      return `emb_${hash}_${text.length}`;
    };
  }

  /**
   * Get embedding from cache
   */
  get(text: string): number[] | undefined {
    return this.cache.get(this.textToKey(text));
  }

  /**
   * Set embedding in cache
   */
  set(text: string, embedding: number[]): void {
    this.cache.set(this.textToKey(text), embedding);
  }

  /**
   * Get or compute embedding
   */
  async getOrCompute(
    text: string,
    compute: () => Promise<number[]>
  ): Promise<number[]> {
    const cached = this.get(text);
    if (cached) {
      return cached;
    }

    const embedding = await compute();
    this.set(text, embedding);
    return embedding;
  }

  /**
   * Batch get or compute embeddings
   */
  async batchGetOrCompute(
    texts: string[],
    compute: (texts: string[]) => Promise<number[][]>
  ): Promise<number[][]> {
    const results: number[][] = new Array(texts.length);
    const toCompute: { index: number; text: string }[] = [];

    // Check cache for each text
    for (let i = 0; i < texts.length; i++) {
      const cached = this.get(texts[i]);
      if (cached) {
        results[i] = cached;
      } else {
        toCompute.push({ index: i, text: texts[i] });
      }
    }

    // Compute missing embeddings
    if (toCompute.length > 0) {
      const textsToCompute = toCompute.map((t) => t.text);
      const computed = await compute(textsToCompute);

      // Store in cache and fill results
      for (let i = 0; i < toCompute.length; i++) {
        const { index } = toCompute[i];
        results[index] = computed[i];
        this.set(toCompute[i].text, computed[i]);
      }
    }

    return results;
  }

  /**
   * Get cache statistics
   */
  getStats(): { hitRate: number; size: number; maxSize: number } {
    const stats = this.cache.getStats();
    return {
      hitRate: this.cache.getHitRate(),
      size: stats.size,
      maxSize: stats.maxSize,
    };
  }

  /**
   * Clear cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Cleanup expired entries
   */
  cleanup(): number {
    return this.cache.cleanup();
  }
}

// Singleton embedding cache
let embeddingCache: EmbeddingCache | null = null;

/**
 * Get or create embedding cache
 */
export function getEmbeddingCache(config?: LRUCacheConfig): EmbeddingCache {
  if (!embeddingCache) {
    embeddingCache = new EmbeddingCache(config);
  }
  return embeddingCache;
}

/**
 * Reset embedding cache (for testing)
 */
export function resetEmbeddingCache(): void {
  embeddingCache = null;
}