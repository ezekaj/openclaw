/**
 * Lightpanda Client Adapter
 *
 * Wraps Lightpanda CDP endpoint to provide browser automation capabilities.
 *
 * Key difference from Chromium CDP: Lightpanda requires explicit browser context
 * creation before any Page/Runtime commands work:
 *   1. Target.createBrowserContext → browserContextId
 *   2. Target.createTarget → targetId
 *   3. Target.attachToTarget → sessionId
 *   4. Then Page.navigate, Runtime.evaluate, etc. work
 */

import { fetchJson, withCdpSocket, type CdpSendFn } from "./cdp.helpers.js";
import type { LightpandaInstance } from "./lightpanda-manager.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("lightpanda-client");

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30000;
const FETCH_TIMEOUT_MS = 5000;
const CHECK_INTERVAL_MS = 100;

// ============================================================================
// TYPES
// ============================================================================

export interface LightpandaClientOptions {
  instance: LightpandaInstance;
  timeout?: number;
}

export interface NavigateOptions {
  url: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  timeout?: number;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
}

export interface EvaluateOptions {
  expression: string;
  awaitPromise?: boolean;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function escapeJsString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
}

function escapeSelector(selector: string): string {
  if (!selector || selector.trim() === "") {
    throw new Error("Selector cannot be empty");
  }
  if (selector.includes("<script") || selector.includes("javascript:")) {
    throw new Error("Invalid selector: potential script injection");
  }
  return escapeJsString(selector);
}

// ============================================================================
// LIGHTPANDA CLIENT
// ============================================================================

export class LightpandaClient {
  private instance: LightpandaInstance;
  private timeout: number;

  constructor(opts: LightpandaClientOptions) {
    this.instance = opts.instance;
    this.timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  // --------------------------------------------------------------------------
  // CONNECTION INFO
  // --------------------------------------------------------------------------

  get cdpUrl(): string {
    return this.instance.cdpUrl;
  }

  get wsUrl(): string {
    return this.instance.wsUrl;
  }

  get port(): number {
    return this.instance.port;
  }

  get pid(): number {
    return this.instance.pid;
  }

  // --------------------------------------------------------------------------
  // BROWSER OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Navigate to URL
   */
  async navigate(opts: NavigateOptions): Promise<{ url: string; title?: string }> {
    log.debug("Navigating", { url: opts.url, port: this.port });

    try {
      new URL(opts.url);
    } catch {
      throw new Error(`Invalid URL: ${opts.url}`);
    }

    return this.withSession(async (send) => {
      const result = (await send("Page.navigate", {
        url: opts.url,
      })) as { frameId?: string; loaderId?: string; errorText?: string };

      if (result.errorText) {
        throw new Error(`Navigation failed: ${result.errorText}`);
      }

      // Get title via Runtime.evaluate
      const title = await this.evalInSession(send, "document.title");

      return {
        url: opts.url,
        title: typeof title === "string" ? title : undefined,
      };
    }, opts.timeout);
  }

  /**
   * Capture screenshot
   */
  async screenshot(opts: ScreenshotOptions = {}): Promise<Buffer> {
    log.debug("Capturing screenshot", { port: this.port, fullPage: opts.fullPage });

    if (opts.quality !== undefined && (opts.quality < 0 || opts.quality > 100)) {
      throw new Error("Quality must be between 0 and 100");
    }

    return this.withSession(async (send) => {
      const format = opts.format || "png";
      const params: Record<string, unknown> = { format };
      if (opts.quality !== undefined && format === "jpeg") {
        params.quality = opts.quality;
      }

      const result = (await send("Page.captureScreenshot", params)) as {
        data?: string;
      };

      if (!result?.data) {
        throw new Error("Screenshot returned no data");
      }

      return Buffer.from(result.data, "base64");
    });
  }

  /**
   * Evaluate JavaScript in page context.
   * If url is provided, navigates first then evaluates (single session).
   * Without url, evaluates against a blank page (useful for non-DOM expressions).
   */
  async evaluate<T = unknown>(opts: EvaluateOptions & { url?: string }): Promise<T> {
    log.debug("Evaluating JavaScript", { port: this.port, url: opts.url });

    if (!opts.expression || opts.expression.trim() === "") {
      throw new Error("Expression cannot be empty");
    }

    return this.withSession(async (send) => {
      if (opts.url) {
        await send("Page.navigate", { url: opts.url });
      }
      return this.evalInSession(send, opts.expression, opts.awaitPromise) as T;
    });
  }

  /**
   * Get page content (HTML).
   * If url is provided, navigates first then gets content (single session).
   */
  async getContent(url?: string): Promise<string> {
    return this.withSession(async (send) => {
      if (url) {
        await send("Page.navigate", { url });
      }
      return this.evalInSession(send, "document.documentElement.outerHTML") as Promise<string>;
    });
  }

  /**
   * Get page title
   */
  async getTitle(): Promise<string> {
    return this.evaluate({
      expression: "document.title",
      awaitPromise: false,
    });
  }

  /**
   * Wait for selector
   */
  async waitForSelector(selector: string, timeout = 10000): Promise<void> {
    log.debug("Waiting for selector", { selector, timeout });
    const escapedSelector = escapeSelector(selector);
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const found = await this.evaluate<boolean>({
        expression: `!!document.querySelector(\`${escapedSelector}\`)`,
      });
      if (found) return;
      await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
    }

    throw new Error(`Timeout waiting for selector: ${selector}`);
  }

  /**
   * Click element
   */
  async click(selector: string): Promise<void> {
    log.debug("Clicking element", { selector });
    const escapedSelector = escapeSelector(selector);
    await this.evaluate({
      expression: `
        const el = document.querySelector(\`${escapedSelector}\`);
        if (el) { el.click(); }
        else { throw new Error(\`Element not found: ${escapedSelector}\`); }
      `,
    });
  }

  /**
   * Type into input field
   */
  async type(selector: string, text: string): Promise<void> {
    log.debug("Typing into element", { selector });
    const escapedSelector = escapeSelector(selector);
    const escapedText = escapeJsString(text);
    await this.evaluate({
      expression: `
        const el = document.querySelector(\`${escapedSelector}\`);
        if (el) {
          el.focus();
          el.value = \`${escapedText}\`;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else { throw new Error(\`Element not found: ${escapedSelector}\`); }
      `,
    });
  }

  // --------------------------------------------------------------------------
  // HEALTH CHECKS
  // --------------------------------------------------------------------------

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetchJson<{ webSocketDebuggerUrl?: string }>(
        `${this.cdpUrl}/json/version`,
        FETCH_TIMEOUT_MS
      );
      return !!response?.webSocketDebuggerUrl;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // PRIVATE: LIGHTPANDA CDP SESSION
  // --------------------------------------------------------------------------

  /**
   * Execute a function within a Lightpanda CDP session.
   *
   * Lightpanda requires explicit browser context creation before any
   * Page/Runtime commands work. This method handles the full lifecycle:
   *   1. Connect to WebSocket
   *   2. Target.createBrowserContext
   *   3. Target.createTarget (about:blank)
   *   4. Target.attachToTarget (flatten)
   *   5. Execute the user function
   *   6. Clean up
   */
  private async withSession<T>(
    fn: (send: CdpSendFn) => Promise<T>,
    timeout?: number,
  ): Promise<T> {
    const wsUrl = await this.getActiveWsUrl();
    const effectiveTimeout = timeout ?? this.timeout;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Lightpanda operation timeout after ${effectiveTimeout}ms`)),
        effectiveTimeout,
      );
    });

    try {
      const resultPromise = withCdpSocket(wsUrl, async (send) => {
        // Initialize Lightpanda browser context
        const ctx = (await send("Target.createBrowserContext")) as {
          browserContextId: string;
        };

        const target = (await send("Target.createTarget", {
          url: "about:blank",
          browserContextId: ctx.browserContextId,
        })) as { targetId: string };

        await send("Target.attachToTarget", {
          targetId: target.targetId,
          flatten: true,
        });

        // Now Page/Runtime commands work
        return fn(send);
      });

      return await Promise.race([resultPromise, timeoutPromise]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Evaluate an expression within an existing CDP session
   */
  private async evalInSession(
    send: CdpSendFn,
    expression: string,
    awaitPromise = false,
  ): Promise<unknown> {
    const result = (await send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown };

    if (result.exceptionDetails) {
      throw new Error(`Evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    }

    return result.result?.value;
  }

  private async getActiveWsUrl(): Promise<string> {
    const response = await fetchJson<{ webSocketDebuggerUrl?: string }>(
      `${this.cdpUrl}/json/version`,
      FETCH_TIMEOUT_MS
    );

    if (!response?.webSocketDebuggerUrl) {
      throw new Error("No active WebSocket debugger URL available");
    }

    return response.webSocketDebuggerUrl;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createLightpandaClient(instance: LightpandaInstance): LightpandaClient {
  return new LightpandaClient({ instance });
}
