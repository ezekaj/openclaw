/**
 * Smart Routing Tests
 * 
 * Tests for task complexity detection and engine routing decisions.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  analyzeTaskComplexity,
  shouldUseLightpanda,
  requiresChromium,
  type TaskContext,
} from "./task-complexity.js";

describe("Task Complexity Detection", () => {
  describe("Simple Tasks", () => {
    it("should classify screenshot as simple", () => {
      const ctx: TaskContext = { action: "screenshot" };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.complexity).toBe("simple");
      expect(analysis.recommendedEngine).toBe("lightpanda");
    });

    it("should classify OCR as simple", () => {
      const ctx: TaskContext = { action: "ocr" };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.complexity).toBe("simple");
      expect(analysis.recommendedEngine).toBe("lightpanda");
    });

    it("should classify static URL as simple", () => {
      const ctx: TaskContext = {
        action: "navigate",
        url: "https://example.com/docs/api.html",
      };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.complexity).toBe("simple");
    });

    it("should classify blog URL as simple", () => {
      const ctx: TaskContext = {
        action: "navigate",
        url: "https://blog.example.com/post/123",
      };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.complexity).toBe("simple");
    });

    it("should recommend Lightpanda for simple tasks", () => {
      const ctx: TaskContext = { action: "screenshot" };
      expect(shouldUseLightpanda(ctx)).toBe(true);
    });
  });

  describe("Moderate Tasks", () => {
    it("should classify navigate as moderate", () => {
      const ctx: TaskContext = { action: "navigate", url: "https://example.com" };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.complexity).toBe("moderate");
    });

    it("should classify form with query params as moderate", () => {
      const ctx: TaskContext = {
        action: "navigate",
        url: "https://example.com/search?q=test",
      };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.complexity).toBe("moderate");
    });

    it("should classify simple selector as moderate", () => {
      const ctx: TaskContext = {
        action: "act",
        selector: "#submit-button",
      };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.complexity).toBe("moderate");
    });

    it("should allow Lightpanda for moderate tasks with fallback", () => {
      const ctx: TaskContext = { action: "navigate", url: "https://example.com" };
      // Lightpanda is allowed for moderate tasks if fallback is enabled
      expect(shouldUseLightpanda(ctx)).toBe(true);
    });
  });

  describe("Complex Tasks", () => {
    it("should classify Chrome extension relay as complex", () => {
      const ctx: TaskContext = {
        action: "navigate",
        profile: "chrome",
      };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.complexity).toBe("complex");
      expect(analysis.recommendedEngine).toBe("chromium");
    });

    it("should require Chromium for Chrome extension relay", () => {
      const ctx: TaskContext = {
        action: "navigate",
        profile: "chrome",
      };
      expect(requiresChromium(ctx)).toBe(true);
    });

    it("should classify SPA URL as complex", () => {
      const ctx: TaskContext = {
        action: "navigate",
        url: "https://app.example.com/dashboard",
      };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.complexity).toBe("complex");
    });

    it("should classify Twitter as complex", () => {
      const ctx: TaskContext = {
        action: "navigate",
        url: "https://twitter.com/home",
      };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.complexity).toBe("complex");
      expect(analysis.recommendedEngine).toBe("chromium");
    });

    it("should classify LinkedIn as complex", () => {
      const ctx: TaskContext = {
        action: "navigate",
        url: "https://linkedin.com/feed",
      };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.complexity).toBe("complex");
    });

    it("should classify WebSocket usage as complex", () => {
      const ctx: TaskContext = {
        action: "act",
        expression: "new WebSocket('wss://example.com')",
      };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.complexity).toBe("complex");
      expect(analysis.hints).toContain("complex-expression");
    });

    it("should classify complex selector as complex", () => {
      const ctx: TaskContext = {
        action: "act",
        selector: "[data-testid='submit-button']:nth-child(2)",
      };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.complexity).toBe("complex");
      expect(analysis.hints).toContain("complex-selector");
    });

    it("should require Chromium for complex tasks", () => {
      const ctx: TaskContext = {
        action: "navigate",
        url: "https://app.example.com/dashboard",
      };
      expect(requiresChromium(ctx)).toBe(true);
    });
  });

  describe("Confidence Scores", () => {
    it("should have high confidence for simple screenshot", () => {
      const ctx: TaskContext = { action: "screenshot" };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.confidence).toBeGreaterThan(0.5);
    });

    it("should have high confidence for Chrome extension relay", () => {
      const ctx: TaskContext = { action: "navigate", profile: "chrome" };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.confidence).toBeGreaterThan(0.6);
    });

    it("should have lower confidence for ambiguous cases", () => {
      const ctx: TaskContext = { action: "navigate" };
      const analysis = analyzeTaskComplexity(ctx);

      // No URL, no profile = ambiguous
      expect(analysis.confidence).toBeLessThan(0.5);
    });
  });

  describe("Reasoning", () => {
    it("should provide reasoning for classification", () => {
      const ctx: TaskContext = { action: "screenshot" };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis.reasoning.length).toBeGreaterThan(0);
      expect(analysis.reasoning[0]).toContain("screenshot");
    });

    it("should explain Chrome extension relay requirement", () => {
      const ctx: TaskContext = { action: "navigate", profile: "chrome" };
      const analysis = analyzeTaskComplexity(ctx);

      const chromeReason = analysis.reasoning.find(r =>
        r.toLowerCase().includes("chrome")
      );
      expect(chromeReason).toBeDefined();
    });

    it("should explain SPA detection", () => {
      const ctx: TaskContext = {
        action: "navigate",
        url: "https://app.example.com",
      };
      const analysis = analyzeTaskComplexity(ctx);

      const spaReason = analysis.reasoning.find(r =>
        r.toLowerCase().includes("spa")
      );
      expect(spaReason).toBeDefined();
    });
  });

  describe("Edge Cases", () => {
    it("should handle missing URL", () => {
      const ctx: TaskContext = { action: "navigate" };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis).toBeDefined();
      expect(analysis.complexity).toBe("moderate");
    });

    it("should handle missing selector", () => {
      const ctx: TaskContext = { action: "act" };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis).toBeDefined();
    });

    it("should handle unknown action", () => {
      const ctx: TaskContext = { action: "unknown" };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis).toBeDefined();
      expect(analysis.complexity).toBe("moderate");
    });

    it("should handle invalid URL", () => {
      const ctx: TaskContext = {
        action: "navigate",
        url: "not-a-url",
      };
      const analysis = analyzeTaskComplexity(ctx);

      expect(analysis).toBeDefined();
    });
  });
});

describe("Performance", () => {
  it("should analyze complexity quickly (<10ms)", () => {
    const ctx: TaskContext = {
      action: "navigate",
      url: "https://example.com",
    };

    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      analyzeTaskComplexity(ctx);
    }
    const duration = Date.now() - start;

    // 100 analyses should take < 1000ms (10ms each)
    expect(duration).toBeLessThan(1000);
  });
});
