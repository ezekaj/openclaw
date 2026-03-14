/**
 * HTTP Client Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HttpClient, getHttpClient, resetHttpClient } from "./http-client.js";

describe("HttpClient", () => {
  let client: HttpClient;

  beforeEach(() => {
    resetHttpClient();
    client = new HttpClient({
        maxSockets: 10,
        maxFreeSockets: 5,
        timeout: 5000,
        circuitBreaker: {
          threshold: 3,
          timeout: 1000,
          successThreshold: 2,
        },
        enableMetrics: true,
      });
  });

  afterEach(() => {
    client.destroy();
  });

  describe("Connection Pooling", () => {
    it("should reuse connections with keep-alive", async () => {
      const mockServer = "https://httpbin.org";
      
      // Make multiple requests to same host
      const results = await Promise.all([
        client.fetch(`${mockServer}/get?id=1`),
        client.fetch(`${mockServer}/get?id=2`),
        client.fetch(`${mockServer}/get?id=3`),
      ]);

      expect(results).toHaveLength(3);
      results.forEach(r => expect(r.ok).toBe(true));
    });

    it("should handle concurrent requests efficiently", async () => {
      const urls = Array.from({ length: 10 }, (_, i) => 
        `https://httpbin.org/get?n=${i}`
      );

      const start = Date.now();
      const results = await Promise.all(urls.map(url => client.fetch(url)));
      const duration = Date.now() - start;

      expect(results).toHaveLength(10);
      // Should complete in <5 seconds with connection pooling
      expect(duration).toBeLessThan(5000);
    });
  });

  describe("Circuit Breaker", () => {
    it("should start in CLOSED state", () => {
      expect(client.getCircuitState()).toBe("closed");
    });

    it("should OPEN after threshold failures", async () => {
      // Force failures with invalid URLs
      const failingUrl = "http://localhost:99999/fail";
      
      for (let i = 0; i < 3; i++) {
        try {
          await client.fetch(failingUrl);
        } catch {
          // Expected to fail
        }
      }

      expect(client.getCircuitState()).toBe("open");
    });

    it("should reject requests when OPEN", async () => {
      // Force circuit to open
      const failingUrl = "http://localhost:99999/fail";
      for (let i = 0; i < 3; i++) {
        try {
          await client.fetch(failingUrl);
        } catch {}
      }

      expect(client.getCircuitState()).toBe("open");

      // Next request should fail immediately
      await expect(client.fetch("https://httpbin.org/get")).rejects.toThrow(
        "Circuit breaker is OPEN"
      );
    });

    it("should transition to HALF-OPEN after timeout", async () => {
      // Force circuit to open
      const failingUrl = "http://localhost:99999/fail";
      for (let i = 0; i < 3; i++) {
        try {
          await client.fetch(failingUrl);
        } catch {}
      }

      expect(client.getCircuitState()).toBe("open");

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Next request should try (half-open)
      try {
        await client.fetch("https://httpbin.org/get");
      } catch {
        // May still fail, but circuit should try
      }

      // Circuit should be half-open or closed now
      const state = client.getCircuitState();
      expect(["half-open", "closed"]).toContain(state);
    });

    it("should CLOSE after success threshold in HALF-OPEN", async () => {
      // Force circuit to open
      const failingUrl = "http://localhost:99999/fail";
      for (let i = 0; i < 3; i++) {
        try {
          await client.fetch(failingUrl);
        } catch {}
      }

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Make successful requests to close circuit
      for (let i = 0; i < 2; i++) {
        await client.fetch("https://httpbin.org/get");
      }

      expect(client.getCircuitState()).toBe("closed");
    });
  });

  describe("Request Timeout", () => {
    it("should timeout slow requests", async () => {
      const slowUrl = "https://httpbin.org/delay/10"; // 10 second delay

      await expect(
        client.fetch(slowUrl, { timeout: 100 })
      ).rejects.toThrow();
    }, 10000);
  });

  describe("JSON Helpers", () => {
    it("should fetch and parse JSON", async () => {
      const data = await client.fetchJson<{ url: string }>(
        "https://httpbin.org/get"
      );

      expect(data).toBeDefined();
      expect(data.url).toContain("httpbin.org");
    });

    it("should POST JSON data", async () => {
      const payload = { message: "test", count: 42 };
      const response = await client.postJson<{ json: typeof payload }>(
        "https://httpbin.org/post",
        payload
      );

      expect(response.json).toEqual(payload);
    });

    it("should throw on non-OK responses", async () => {
      await expect(
        client.fetchJson("https://httpbin.org/status/404")
      ).rejects.toThrow("HTTP 404");
    });
  });

  describe("Metrics", () => {
    it("should track successful requests", async () => {
      await client.fetch("https://httpbin.org/get");
      await client.fetch("https://httpbin.org/get");

      const metrics = client.getMetrics();
      const urlMetrics = metrics.get("https://httpbin.org/get");

      expect(urlMetrics).toBeDefined();
      expect(urlMetrics?.total).toBe(2);
      expect(urlMetrics?.successful).toBe(2);
      expect(urlMetrics?.failed).toBe(0);
      expect(urlMetrics?.avgDuration).toBeGreaterThan(0);
    });

    it("should track failed requests", async () => {
      try {
        await client.fetch("http://localhost:99999/fail");
      } catch {}

      const metrics = client.getMetrics();
      const urlMetrics = metrics.get("http://localhost:99999/fail");

      expect(urlMetrics?.failed).toBe(1);
      expect(urlMetrics?.lastError).toBeDefined();
      expect(urlMetrics?.lastErrorTime).toBeGreaterThan(0);
    });

    it("should normalize URLs for metrics", async () => {
      await client.fetch("https://httpbin.org/get?param1=value1");
      await client.fetch("https://httpbin.org/get?param2=value2");

      const metrics = client.getMetrics();
      
      // Both requests should be grouped under same normalized URL
      expect(metrics.size).toBe(1);
      const urlMetrics = metrics.get("https://httpbin.org/get");
      expect(urlMetrics?.total).toBe(2);
    });
  });

  describe("Singleton", () => {
    it("should return same instance", () => {
      const instance1 = getHttpClient();
      const instance2 = getHttpClient();

      expect(instance1).toBe(instance2);
    });

    it("should reset singleton", () => {
      const instance1 = getHttpClient();
      resetHttpClient();
      const instance2 = getHttpClient();

      expect(instance1).not.toBe(instance2);
    });
  });
});
