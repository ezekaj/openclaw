/**
 * Browser Engine Router
 * 
 * Routes browser requests to either Lightpanda (fast) or Chromium (compatible).
 * Automatically selects engine based on config and task requirements.
 * 
 * Modes:
 * - 'lightpanda': Always use Lightpanda (fast, 9x less memory)
 * - 'chromium': Always use Chromium (full compatibility)
 * - 'auto': Smart routing based on task complexity
 */

import { LightpandaManager } from "./lightpanda-manager.js";
import { LightpandaClient, createLightpandaClient } from "./lightpanda-client.js";
import { 
  shouldUseLightpanda, 
  requiresChromium,
  type TaskContext 
} from "./task-complexity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("browser-router");

// ============================================================================
// TYPES
// ============================================================================

export type BrowserEngine = "lightpanda" | "chromium";

export interface BrowserClient {
  cdpUrl: string;
  wsUrl: string;
  navigate(opts: { url: string; waitUntil?: string }): Promise<{ url: string; title?: string }>;
  screenshot(opts?: { fullPage?: boolean; format?: "png" | "jpeg" }): Promise<Buffer>;
  evaluate<T = unknown>(opts: { expression: string; awaitPromise?: boolean }): Promise<T>;
  isHealthy(): Promise<boolean>;
}

export interface RouterConfig {
  engine?: "chromium" | "lightpanda" | "auto";
  lightpandaEnabled?: boolean;
  lightpandaAutoInstall?: boolean;
  lightpandaBinaryPath?: string;
  fallbackToChromium?: boolean;
  defaultCdpPort?: number;
}

// ============================================================================
// BROWSER ENGINE ROUTER
// ============================================================================

export class BrowserEngineRouter {
  private config: RouterConfig;
  private lightpandaManager: LightpandaManager | null = null;
  private activeEngine: BrowserEngine | null = null;

  constructor(config: RouterConfig) {
    // Validate config
    if (config.defaultCdpPort !== undefined) {
      if (!Number.isInteger(config.defaultCdpPort) || 
          config.defaultCdpPort < 1 || 
          config.defaultCdpPort > 65535) {
        throw new Error(
          `Invalid defaultCdpPort: ${config.defaultCdpPort}. Must be an integer between 1 and 65535.`
        );
      }
    }
    
    this.config = config;
  }

  // --------------------------------------------------------------------------
  // CLIENT ACQUISITION
  // --------------------------------------------------------------------------

  /**
   * Get browser client (auto-selects engine based on config)
   */
  async getClient(taskHint?: TaskHint, taskContext?: TaskContext): Promise<BrowserClient> {
    // If task context provided, use smart complexity analysis
    if (taskContext) {
      const engine = this.smartSelectEngineWithContext(taskContext);
      
      log.info("Smart routing decision", {
        action: taskContext.action,
        engine,
        url: taskContext.url,
      });

      if (engine === "lightpanda") {
        return await this.getLightpandaClient();
      }

      return await this.getChromiumClient();
    }

    // Fallback to hint-based selection
    const engine = this.selectEngine(taskHint);

    if (engine === "lightpanda") {
      return await this.getLightpandaClient();
    }

    return await this.getChromiumClient();
  }

  /**
   * Get Lightpanda client
   */
  async getLightpandaClient(): Promise<LightpandaClient> {
    if (!this.lightpandaManager) {
      this.lightpandaManager = new LightpandaManager({
        enabled: true,
        autoInstall: this.config.lightpandaAutoInstall ?? false,
        fallbackToChromium: this.config.fallbackToChromium ?? true,
        binaryPath: this.config.lightpandaBinaryPath,
      });
    }

    const port = this.config.defaultCdpPort ?? 9222;

    try {
      // Start Lightpanda if not running
      let instance = this.lightpandaManager.getInstance(port);
      
      if (!instance) {
        log.info("Starting Lightpanda", { port });
        instance = await this.lightpandaManager.start(port);
      }

      // Health check
      const client = createLightpandaClient(instance);
      if (!(await client.isHealthy())) {
        log.warn("Lightpanda unhealthy, restarting");
        await this.lightpandaManager.stop(port);
        instance = await this.lightpandaManager.start(port);
      }

      this.activeEngine = "lightpanda";
      return createLightpandaClient(instance);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error("Lightpanda failed", { err: errorMessage });

      if (this.config.fallbackToChromium) {
        log.info("Falling back to Chromium");
        this.activeEngine = "chromium";
        // Note: getChromiumClient throws in current implementation
        // but we set activeEngine before the call for consistency
        throw new Error(
          "Lightpanda failed and Chromium fallback is not yet implemented. " +
          "Use engine='chromium' to bypass this router. " +
          `Original error: ${errorMessage}`
        );
      }

      // Re-throw original error to preserve stack trace
      throw err;
    }
  }

  /**
   * Get Chromium client (placeholder - calls existing browser system)
   */
  async getChromiumClient(): Promise<BrowserClient> {
    this.activeEngine = "chromium";
    
    // This would integrate with existing browser.ts / client.ts
    // For now, return a stub that signals to use existing system
    throw new Error(
      "Chromium client should be handled by existing browser-tool.ts. " +
      "Use engine='chromium' to bypass this router."
    );
  }

  // --------------------------------------------------------------------------
  // ENGINE SELECTION
  // --------------------------------------------------------------------------

  /**
   * Select browser engine based on config and task requirements
   */
  private selectEngine(taskHint?: TaskHint): BrowserEngine {
    const { engine } = this.config;

    // Explicit engine selection
    if (engine === "lightpanda") {
      return "lightpanda";
    }

    if (engine === "chromium") {
      return "chromium";
    }

    // Auto mode - smart routing
    return this.smartSelectEngine(taskHint);
  }

  /**
   * Smart engine selection based on task requirements
   */
  private smartSelectEngine(taskHint?: TaskHint): BrowserEngine {
    // If Lightpanda disabled, use Chromium
    if (!this.config.lightpandaEnabled) {
      return "chromium";
    }

    // Simple tasks: prefer Lightpanda (9x faster)
    if (taskHint !== undefined && LIGHTPANDA_PREFERRED_TASKS.includes(taskHint)) {
      return "lightpanda";
    }

    // Complex tasks: use Chromium (full Web API support)
    if (taskHint !== undefined && CHROMIUM_PREFERRED_TASKS.includes(taskHint)) {
      return "chromium";
    }

    // Default: Lightpanda for speed (with fallback)
    return "lightpanda";
  }

  /**
   * Smart engine selection with task context (Phase 2)
   */
  private smartSelectEngineWithContext(ctx: TaskContext): BrowserEngine {
    // If Lightpanda disabled, use Chromium
    if (!this.config.lightpandaEnabled) {
      return "chromium";
    }

    // Use complexity analysis
    if (requiresChromium(ctx)) {
      log.info("Chromium required", { action: ctx.action, url: ctx.url });
      return "chromium";
    }

    if (shouldUseLightpanda(ctx)) {
      log.info("Lightpanda preferred", { action: ctx.action, url: ctx.url });
      return "lightpanda";
    }

    // Moderate complexity: try Lightpanda with fallback
    if (this.config.fallbackToChromium) {
      log.info("Moderate task, trying Lightpanda with fallback", { 
        action: ctx.action, 
        url: ctx.url 
      });
      return "lightpanda";
    }

    // Without fallback, play safe with Chromium
    return "chromium";
  }

  // --------------------------------------------------------------------------
  // LIFECYCLE
  // --------------------------------------------------------------------------

  /**
   * Get currently active engine
   */
  getActiveEngine(): BrowserEngine | null {
    return this.activeEngine;
  }

  /**
   * Shutdown all instances
   */
  async shutdown(): Promise<void> {
    this.activeEngine = null;
    
    if (this.lightpandaManager) {
      try {
        await this.lightpandaManager.stopAll();
      } catch (err) {
        log.error("Error during Lightpanda shutdown", { err });
        // Continue cleanup even if stop fails
      }
      this.lightpandaManager = null;
    }
  }
}

// ============================================================================
// TASK HINTS
// ============================================================================

export type TaskHint =
  | "scraping"
  | "screenshot"
  | "simple-navigation"
  | "form-interaction"
  | "complex-spa"
  | "websocket-heavy"
  | "debugging"
  | "extension-relay";

/**
 * Tasks that benefit from Lightpanda (fast, low memory)
 */
const LIGHTPANDA_PREFERRED_TASKS: TaskHint[] = [
  "scraping",
  "screenshot",
  "simple-navigation",
  "form-interaction",
];

/**
 * Tasks that require Chromium (full compatibility)
 */
const CHROMIUM_PREFERRED_TASKS: TaskHint[] = [
  "complex-spa",
  "websocket-heavy",
  "debugging",
  "extension-relay",
];

// ============================================================================
// SINGLETON
// ============================================================================

let defaultRouter: BrowserEngineRouter | null = null;

/**
 * Get or initialize the default browser router.
 * Thread-safe: concurrent calls will wait for the same initialization.
 */
export function getBrowserRouter(config?: RouterConfig): BrowserEngineRouter {
  // Fast path: already initialized
  if (defaultRouter) {
    return defaultRouter;
  }
  
  // Need config to initialize
  if (!config) {
    throw new Error("BrowserEngineRouter not initialized. Provide config on first call.");
  }
  
  // Create new instance synchronously (constructor is sync)
  defaultRouter = new BrowserEngineRouter(config);
  return defaultRouter;
}

/**
 * Reset the singleton. Used for testing.
 */
export function resetBrowserRouter(): void {
  defaultRouter = null;
}
