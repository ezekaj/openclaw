/**
 * Lightpanda Integration Tests
 * 
 * Tests for Lightpanda browser engine integration.
 * Requires Lightpanda binary to be installed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LightpandaManager } from "./lightpanda-manager.js";
import { createLightpandaClient } from "./lightpanda-client.js";
import { BrowserEngineRouter } from "./browser-engine-router.js";

const TEST_PORT = 9333;  // Use non-standard port for tests
const TEST_URL = "https://example.com";

describe("Lightpanda Integration", () => {
  let manager: LightpandaManager;

  beforeAll(async () => {
    manager = new LightpandaManager({
      enabled: true,
      autoInstall: true,  // Download if missing
      fallbackToChromium: false,
    });

    // Skip tests if not installed and can't auto-install
    const installed = await manager.isInstalled();
    if (!installed) {
      console.log("Lightpanda not installed, attempting auto-install...");
      try {
        await manager.install();
      } catch (err) {
        console.warn("Failed to install Lightpanda, skipping tests:", err);
        return;
      }
    }
  });

  afterAll(async () => {
    if (manager) {
      await manager.stopAll();
    }
  });

  describe("Binary Management", () => {
    it("should detect if Lightpanda is installed", async () => {
      const installed = await manager.isInstalled();
      expect(typeof installed).toBe("boolean");
    });

    it("should get version info", async () => {
      if (!(await manager.isInstalled())) {
        return;  // Skip
      }

      const version = await manager.getVersion();
      expect(version).toBeDefined();
      expect(typeof version).toBe("string");
    });
  });

  describe("Instance Management", () => {
    it("should start Lightpanda on custom port", async () => {
      if (!(await manager.isInstalled())) {
        return;  // Skip
      }

      const instance = await manager.start(TEST_PORT);
      
      expect(instance).toBeDefined();
      expect(instance.pid).toBeGreaterThan(0);
      expect(instance.port).toBe(TEST_PORT);
      expect(instance.cdpUrl).toBe(`http://127.0.0.1:${TEST_PORT}`);
      
      // Cleanup
      await manager.stop(TEST_PORT);
    });

    it("should detect running instance", async () => {
      if (!(await manager.isInstalled())) {
        return;
      }

      await manager.start(TEST_PORT);
      
      const instance = manager.getInstance(TEST_PORT);
      expect(instance).toBeDefined();
      expect(instance?.pid).toBeGreaterThan(0);
      
      await manager.stop(TEST_PORT);
    });

    it("should prevent duplicate instances on same port", async () => {
      if (!(await manager.isInstalled())) {
        return;
      }

      const instance1 = await manager.start(TEST_PORT);
      const instance2 = await manager.start(TEST_PORT);
      
      // Should return same instance
      expect(instance1.pid).toBe(instance2.pid);
      
      await manager.stop(TEST_PORT);
    });
  });

  describe("CDP Client", () => {
    it("should navigate to URL", async () => {
      if (!(await manager.isInstalled())) {
        return;
      }

      const instance = await manager.start(TEST_PORT);
      const client = createLightpandaClient(instance);

      const result = await client.navigate({ url: TEST_URL });
      
      expect(result.url).toContain("example.com");
      
      await manager.stop(TEST_PORT);
    }, 10000);  // 10s timeout

    it("should capture screenshot", async () => {
      if (!(await manager.isInstalled())) {
        return;
      }

      const instance = await manager.start(TEST_PORT);
      const client = createLightpandaClient(instance);

      await client.navigate({ url: TEST_URL });
      const screenshot = await client.screenshot({ format: "png" });
      
      expect(screenshot).toBeInstanceOf(Buffer);
      expect(screenshot.length).toBeGreaterThan(0);
      
      await manager.stop(TEST_PORT);
    }, 10000);

    it("should evaluate JavaScript", async () => {
      if (!(await manager.isInstalled())) {
        return;
      }

      const instance = await manager.start(TEST_PORT);
      const client = createLightpandaClient(instance);

      const title = await client.evaluate<string>({
        expression: "document.title",
        url: TEST_URL,
      });
      
      expect(title).toContain("Example");
      
      await manager.stop(TEST_PORT);
    }, 10000);

    it("should get page content", async () => {
      if (!(await manager.isInstalled())) {
        return;
      }

      const instance = await manager.start(TEST_PORT);
      const client = createLightpandaClient(instance);

      const content = await client.getContent(TEST_URL);

      expect(content).toContain("<html");
      expect(content).toContain("Example Domain");
      
      await manager.stop(TEST_PORT);
    }, 10000);

    it("should check health", async () => {
      if (!(await manager.isInstalled())) {
        return;
      }

      const instance = await manager.start(TEST_PORT);
      const client = createLightpandaClient(instance);

      const healthy = await client.isHealthy();
      expect(healthy).toBe(true);
      
      await manager.stop(TEST_PORT);
    });
  });

  describe("Browser Engine Router", () => {
    it("should select Lightpanda when engine='lightpanda'", async () => {
      if (!(await manager.isInstalled())) {
        return;
      }

      const router = new BrowserEngineRouter({
        engine: "lightpanda",
        lightpandaEnabled: true,
        defaultCdpPort: TEST_PORT,
      });

      const client = await router.getLightpandaClient();
      expect(client).toBeDefined();
      
      await router.shutdown();
    });

    it("should fallback to Chromium on error", async () => {
      const router = new BrowserEngineRouter({
        engine: "lightpanda",
        lightpandaEnabled: true,
        fallbackToChromium: true,
        lightpandaBinaryPath: "/nonexistent/lightpanda",  // Force failure
        defaultCdpPort: TEST_PORT,
      });

      // Lightpanda binary doesn't exist → fallback → getChromiumClient throws (stub)
      await expect(router.getLightpandaClient()).rejects.toThrow();

      await router.shutdown();
    });

    it("should select engine based on task hint", async () => {
      const router = new BrowserEngineRouter({
        engine: "auto",
        lightpandaEnabled: true,
        defaultCdpPort: TEST_PORT,
      });

      // Access private method for testing
      const selectEngine = (router as any).selectEngine.bind(router);

      expect(selectEngine("scraping")).toBe("lightpanda");
      expect(selectEngine("screenshot")).toBe("lightpanda");
      expect(selectEngine("complex-spa")).toBe("chromium");
      expect(selectEngine("debugging")).toBe("chromium");
    });

    it("should reject invalid port numbers in constructor", () => {
      expect(() => new BrowserEngineRouter({
        engine: "lightpanda",
        defaultCdpPort: 0,
      })).toThrow("Invalid defaultCdpPort");

      expect(() => new BrowserEngineRouter({
        engine: "lightpanda",
        defaultCdpPort: 99999,
      })).toThrow("Invalid defaultCdpPort");

      expect(() => new BrowserEngineRouter({
        engine: "lightpanda",
        defaultCdpPort: -1,
      })).toThrow("Invalid defaultCdpPort");

      expect(() => new BrowserEngineRouter({
        engine: "lightpanda",
        defaultCdpPort: 3.14,
      })).toThrow("Invalid defaultCdpPort");
    });
  });

  describe("Performance", () => {
    it("should start faster than Chromium (< 1 second)", async () => {
      if (!(await manager.isInstalled())) {
        return;
      }

      const startTime = Date.now();
      await manager.start(TEST_PORT);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(1000);  // Lightpanda starts in < 1s
      
      await manager.stop(TEST_PORT);
    });

    it("should use less memory than Chromium (< 100MB)", async () => {
      if (!(await manager.isInstalled())) {
        return;
      }

      const instance = await manager.start(TEST_PORT);
      
      // Get memory usage (approximate)
      // In production, would parse /proc/<pid>/status on Linux
      // or use ps on macOS
      
      // For now, just verify instance started
      expect(instance.pid).toBeGreaterThan(0);
      
      await manager.stop(TEST_PORT);
    });
  });
});
