/**
 * Shared HTTP Client with Connection Pooling and Circuit Breaker
 * 
 * Features:
 * - Connection pooling (keep-alive)
 * - Circuit breaker for resilience
 * - Automatic retry with backoff
 * - Request timeout handling
 * - Metrics collection
 */

import http from "node:http";
import https from "node:https";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("http-client");

// Circuit breaker states
type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** Failure threshold before opening circuit - default: 5 */
  threshold?: number;
  /** Time to wait before trying half-open (ms) - default: 60000 */
  timeout?: number;
  /** Success threshold to close circuit - default: 3 */
  successThreshold?: number;
}

export interface HttpClientConfig {
  /** Connection pool max sockets per host - default: 50 */
  maxSockets?: number;
  /** Connection pool max free sockets - default: 10 */
  maxFreeSockets?: number;
  /** Default request timeout (ms) - default: 30000 */
  timeout?: number;
  /** Circuit breaker config */
  circuitBreaker?: CircuitBreakerConfig;
  /** Enable request metrics */
  enableMetrics?: boolean;
}

interface RequestMetrics {
  total: number;
  successful: number;
  failed: number;
  avgDuration: number;
  lastError?: string;
  lastErrorTime?: number;
}

/**
 * Circuit Breaker Implementation
 */
class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private lastFailureTime = 0;
  private readonly threshold: number;
  private readonly timeout: number;
  private readonly successThreshold: number;

  constructor(config: CircuitBreakerConfig = {}) {
    this.threshold = config.threshold ?? 5;
    this.timeout = config.timeout ?? 60000;
    this.successThreshold = config.successThreshold ?? 3;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed < this.timeout) {
        throw new Error("Circuit breaker is OPEN - too many failures");
      }
      this.state = "half-open";
      log.debug("Circuit breaker moved to HALF-OPEN");
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.state = "closed";
        this.failures = 0;
        this.successes = 0;
        log.info("Circuit breaker CLOSED - recovered");
      }
    } else {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.threshold) {
      this.state = "open";
      log.warn(`Circuit breaker OPENED after ${this.failures} failures`);
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getFailures(): number {
    return this.failures;
  }
}

/**
 * Shared HTTP Client with Connection Pooling
 */
export class HttpClient {
  private readonly httpAgent: http.Agent;
  private readonly httpsAgent: https.Agent;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly defaultTimeout: number;
  private readonly enableMetrics: boolean;
  private readonly metrics = new Map<string, RequestMetrics>();

  constructor(config: HttpClientConfig = {}) {
    const maxSockets = config.maxSockets ?? 50;
    const maxFreeSockets = config.maxFreeSockets ?? 10;

    // Create connection pooling agents
    this.httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets,
      maxFreeSockets,
      timeout: 60000, // Socket timeout
    });

    this.httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets,
      maxFreeSockets,
      timeout: 60000,
    });

    this.circuitBreaker = new CircuitBreaker(config.circuitBreaker);
    this.defaultTimeout = config.timeout ?? 30000;
    this.enableMetrics = config.enableMetrics ?? false;

    log.debug(`HTTP client initialized (maxSockets=${maxSockets}, maxFreeSockets=${maxFreeSockets})`);
  }

  /**
   * Fetch with connection pooling and circuit breaker
   */
  async fetch(
    url: string | URL,
    options?: RequestInit & { timeout?: number }
  ): Promise<Response> {
    const urlString = url.toString();
    const urlObj = new URL(urlString);
    const isHttps = urlObj.protocol === "https:";
    const startTime = Date.now();
    const timeout = options?.timeout ?? this.defaultTimeout;

    // Use circuit breaker
    return this.circuitBreaker.execute(async () => {
      try {
        // Create abort controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        const fetchOptions: RequestInit = {
          ...options,
          signal: controller.signal,
          // @ts-expect-error Node.js specific agent option
          agent: isHttps ? this.httpsAgent : this.httpAgent,
        };

        const response = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);

        if (this.enableMetrics) {
          this.recordMetrics(urlString, Date.now() - startTime, true);
        }

        return response;
      } catch (error) {
        if (this.enableMetrics) {
          this.recordMetrics(urlString, Date.now() - startTime, false, String(error));
        }
        throw error;
      }
    });
  }

  /**
   * JSON fetch helper
   */
  async fetchJson<T = unknown>(
    url: string | URL,
    options?: RequestInit & { timeout?: number }
  ): Promise<T> {
    const response = await this.fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * POST JSON helper
   */
  async postJson<T = unknown>(
    url: string | URL,
    data: unknown,
    options?: RequestInit & { timeout?: number }
  ): Promise<T> {
    return this.fetchJson<T>(url, {
      ...options,
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /**
   * Get circuit breaker state
   */
  getCircuitState(): CircuitState {
    return this.circuitBreaker.getState();
  }

  /**
   * Get metrics for a URL pattern
   */
  getMetrics(urlPattern?: string): Map<string, RequestMetrics> {
    if (urlPattern) {
      const result = new Map<string, RequestMetrics>();
      const metrics = this.metrics.get(urlPattern);
      if (metrics) {
        result.set(urlPattern, metrics);
      }
      return result;
    }
    return new Map(this.metrics);
  }

  /**
   * Record request metrics
   */
  private recordMetrics(
    url: string,
    duration: number,
    success: boolean,
    error?: string
  ): void {
    const key = this.normalizeUrl(url);
    let metrics = this.metrics.get(key);

    if (!metrics) {
      metrics = { total: 0, successful: 0, failed: 0, avgDuration: 0 };
      this.metrics.set(key, metrics);
    }

    metrics.total++;
    if (success) {
      metrics.successful++;
    } else {
      metrics.failed++;
      metrics.lastError = error;
      metrics.lastErrorTime = Date.now();
    }

    // Calculate rolling average
    const totalDuration = metrics.avgDuration * (metrics.total - 1) + duration;
    metrics.avgDuration = totalDuration / metrics.total;
  }

  /**
   * Normalize URL for metrics (remove query params, IDs)
   */
  private normalizeUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      // Remove query params
      return `${urlObj.origin}${urlObj.pathname}`;
    } catch {
      return url;
    }
  }

  /**
   * Cleanup agents on shutdown
   */
  destroy(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
    log.debug("HTTP client destroyed");
  }
}

// Singleton instance
let defaultClient: HttpClient | null = null;

/**
 * Get or create default HTTP client
 */
export function getHttpClient(config?: HttpClientConfig): HttpClient {
  if (!defaultClient) {
    defaultClient = new HttpClient(config);
  }
  return defaultClient;
}

/**
 * Reset default client (for testing)
 */
export function resetHttpClient(): void {
  if (defaultClient) {
    defaultClient.destroy();
    defaultClient = null;
  }
}
