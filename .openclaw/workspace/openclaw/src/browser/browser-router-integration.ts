/**
 * Browser Router Integration
 * 
 * Integration layer between browser-tool.ts and browser-engine-router.ts.
 * Provides smart routing with automatic engine selection based on task complexity.
 */

import { getBrowserRouter, resetBrowserRouter, type RouterConfig, type BrowserClient } from "./browser-engine-router.js";
import type { TaskContext } from "./task-complexity.js";
import { analyzeTaskComplexity } from "./task-complexity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { BrowserConfig } from "../config/types.browser.js";

const log = createSubsystemLogger("browser-router-integration");

// ============================================================================
// ROUTING METRICS
// ============================================================================

/**
 * Engine usage counts for a category (action or domain)
 */
interface EngineUsageCount {
  lightpanda: number;
  chromium: number;
}

interface RoutingMetrics {
  totalRequests: number;
  lightpandaRequests: number;
  chromiumRequests: number;
  lightpandaFallbacks: number;
  averageDecisionTime: number;
  byAction: Record<string, EngineUsageCount>;
  byDomain: Record<string, EngineUsageCount>;
}

const metrics: RoutingMetrics = {
  totalRequests: 0,
  lightpandaRequests: 0,
  chromiumRequests: 0,
  lightpandaFallbacks: 0,
  averageDecisionTime: 0,
  byAction: {},
  byDomain: {},
};

/**
 * Record routing decision for metrics
 */
function recordRoutingDecision(
  engine: "lightpanda" | "chromium",
  ctx: TaskContext,
  decisionTimeMs: number,
  fallback?: boolean
): void {
  metrics.totalRequests++;

  if (engine === "lightpanda") {
    metrics.lightpandaRequests++;
    if (fallback) {
      metrics.lightpandaFallbacks++;
    }
  } else {
    metrics.chromiumRequests++;
  }

  // Update average decision time
  metrics.averageDecisionTime =
    (metrics.averageDecisionTime * (metrics.totalRequests - 1) + decisionTimeMs) /
    metrics.totalRequests;

  // By action
  if (!metrics.byAction[ctx.action]) {
    metrics.byAction[ctx.action] = { lightpanda: 0, chromium: 0 };
  }
  metrics.byAction[ctx.action][engine]++;

  // By domain
  if (ctx.url) {
    try {
      const domain = new URL(ctx.url).hostname;
      if (!metrics.byDomain[domain]) {
        metrics.byDomain[domain] = { lightpanda: 0, chromium: 0 };
      }
      metrics.byDomain[domain][engine]++;
    } catch {
      // Invalid URL, skip domain tracking
    }
  }
}

/**
 * Get current routing metrics (deep copy to prevent mutation)
 */
export function getRoutingMetrics(): RoutingMetrics {
  return {
    totalRequests: metrics.totalRequests,
    lightpandaRequests: metrics.lightpandaRequests,
    chromiumRequests: metrics.chromiumRequests,
    lightpandaFallbacks: metrics.lightpandaFallbacks,
    averageDecisionTime: metrics.averageDecisionTime,
    byAction: deepCopyEngineUsage(metrics.byAction),
    byDomain: deepCopyEngineUsage(metrics.byDomain),
  };
}

/**
 * Deep copy engine usage record to prevent mutation
 */
function deepCopyEngineUsage(
  record: Record<string, EngineUsageCount>
): Record<string, EngineUsageCount> {
  const result: Record<string, EngineUsageCount> = {};
  for (const key of Object.keys(record)) {
    result[key] = { ...record[key] };
  }
  return result;
}

/**
 * Reset routing metrics
 */
export function resetRoutingMetrics(): void {
  metrics.totalRequests = 0;
  metrics.lightpandaRequests = 0;
  metrics.chromiumRequests = 0;
  metrics.lightpandaFallbacks = 0;
  metrics.averageDecisionTime = 0;
  metrics.byAction = {};
  metrics.byDomain = {};
}

// ============================================================================
// ROUTER INTEGRATION
// ============================================================================

/**
 * Initialize router from browser config
 */
export function initializeRouter(browserConfig: BrowserConfig): void {
  // Extract port from cdpUrl if available, otherwise use default
  let defaultCdpPort = 9222;
  if (browserConfig.cdpUrl) {
    try {
      const url = new URL(browserConfig.cdpUrl);
      const port = parseInt(url.port, 10);
      if (port > 0 && port <= 65535) {
        defaultCdpPort = port;
      }
    } catch {
      // Invalid URL, use default port
    }
  }
  
  const routerConfig: RouterConfig = {
    engine: browserConfig.engine ?? "auto",
    lightpandaEnabled: browserConfig.lightpanda?.enabled ?? false,
    lightpandaAutoInstall: browserConfig.lightpanda?.autoInstall ?? false,
    fallbackToChromium: browserConfig.lightpanda?.fallbackToChromium ?? true,
    defaultCdpPort,
  };

  log.info("Initializing browser router", {
    engine: routerConfig.engine,
    lightpandaEnabled: routerConfig.lightpandaEnabled,
    fallbackToChromium: routerConfig.fallbackToChromium,
  });

  getBrowserRouter(routerConfig);
}

/**
 * Get routed browser client for task
 * 
 * @throws Error if router is not initialized or fails to acquire client
 */
export async function getRoutedBrowserClient(
  ctx: TaskContext
): Promise<{ client: BrowserClient; engine: "lightpanda" | "chromium" }> {
  const startTime = Date.now();

  let router: ReturnType<typeof getBrowserRouter>;
  try {
    router = getBrowserRouter();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Router not initialized", { err: message });
    throw new Error(`Browser router not initialized: ${message}`);
  }

  let client: BrowserClient;
  try {
    client = await router.getClient(undefined, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Failed to get browser client", { 
      action: ctx.action, 
      url: ctx.url, 
      err: message 
    });
    throw err;
  }

  const engine = router.getActiveEngine();

  if (!engine) {
    throw new Error("Router failed to select engine");
  }

  const decisionTimeMs = Date.now() - startTime;

  recordRoutingDecision(engine, ctx, decisionTimeMs);

  log.info("Browser client routed", {
    action: ctx.action,
    engine,
    decisionTimeMs,
    url: ctx.url,
  });

  return { client, engine };
}

/**
 * Check if smart routing is enabled
 */
export function isSmartRoutingEnabled(): boolean {
  try {
    const router = getBrowserRouter();
    // Router exists = smart routing enabled
    return true;
  } catch {
    return false;
  }
}

/**
 * Get routing recommendation for task (without executing).
 * Uses task complexity analysis to recommend an engine without actually routing.
 * Useful for debugging, metrics, and pre-flight checks.
 */
export function getRoutingRecommendation(ctx: TaskContext): {
  engine: "lightpanda" | "chromium" | "auto";
  reasoning: string[];
  confidence: number;
} {
  const analysis = analyzeTaskComplexity(ctx);
  
  // Check if router is configured for a specific engine
  let configuredEngine: "lightpanda" | "chromium" | "auto" = "auto";
  try {
    const router = getBrowserRouter();
    const activeEngine = router.getActiveEngine();
    if (activeEngine) {
      configuredEngine = activeEngine;
    }
  } catch {
    // Router not initialized, use analysis result
  }
  
  // If router is locked to a specific engine, respect that
  if (configuredEngine !== "auto") {
    return {
      engine: configuredEngine,
      reasoning: [`Router is configured to use ${configuredEngine}`, ...analysis.reasoning],
      confidence: 1.0,
    };
  }
  
  // Use complexity analysis recommendation
  return {
    engine: analysis.recommendedEngine,
    reasoning: analysis.reasoning,
    confidence: analysis.confidence,
  };
}

/**
 * Shutdown the browser router and clean up resources.
 * Call this during application shutdown to properly release Lightpanda instances.
 */
export async function shutdownRouter(): Promise<void> {
  try {
    const router = getBrowserRouter();
    await router.shutdown();
    log.info("Browser router shut down successfully");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Router shutdown failed or router was not initialized", { err: message });
  } finally {
    // Always reset the singleton so it can be re-initialized
    resetBrowserRouter();
  }
}
