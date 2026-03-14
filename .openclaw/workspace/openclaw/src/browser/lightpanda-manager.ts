/**
 * Lightpanda Binary Manager
 * 
 * Handles downloading, starting, and managing Lightpanda browser instances.
 * Lightpanda is a Zig-based headless browser with 9x less memory and 11x faster
 * than Chrome, perfect for AI agents and automation.
 * 
 * Key features:
 * - Auto-download from GitHub releases
 * - Cross-platform support (macOS aarch64, Linux x86_64)
 * - CDP server on configurable port
 * - Process lifecycle management
 */

import { spawn, ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, chmodSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir, platform as osPlatform, arch as osArch } from "node:os";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import https from "node:https";
import http from "node:http";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("lightpanda");

// ============================================================================
// TYPES
// ============================================================================

export interface LightpandaConfig {
  enabled: boolean;
  binaryPath?: string;
  autoInstall?: boolean;
  fallbackToChromium?: boolean;
  version?: string;  // Default: 'nightly'
}

export interface LightpandaInstance {
  pid: number;
  port: number;
  cdpUrl: string;
  wsUrl: string;
  process: ChildProcess;
  startedAt: number;
}

export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes?: number;
  percentage?: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const GITHUB_RELEASES_URL = "https://github.com/lightpanda-io/browser/releases";
const DEFAULT_VERSION = "nightly";
const BINARY_NAME = "lightpanda";

const PLATFORM_MAPPING: Record<string, string> = {
  "darwin-arm64": "lightpanda-aarch64-macos",
  "linux-x64": "lightpanda-x86_64-linux",
  // Note: Lightpanda doesn't support Windows yet
};

const CDP_READY_TIMEOUT_MS = 10000;  // 10 seconds to start
const CDP_POLL_INTERVAL_MS = 100;

// ============================================================================
// LIGHTPANDA MANAGER
// ============================================================================

export class LightpandaManager {
  private binaryPath: string;
  private config: LightpandaConfig;
  private activeInstances: Map<number, LightpandaInstance> = new Map();

  constructor(config: LightpandaConfig) {
    this.config = config;
    this.binaryPath = config.binaryPath || this.getDefaultBinaryPath();
  }

  // --------------------------------------------------------------------------
  // BINARY MANAGEMENT
  // --------------------------------------------------------------------------

  /**
   * Check if Lightpanda binary exists
   */
  async isInstalled(): Promise<boolean> {
    try {
      if (!existsSync(this.binaryPath)) {
        return false;
      }
      
      // Check if executable
      const stats = statSync(this.binaryPath);
      return stats.isFile() && (stats.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  }

  /**
   * Download and install Lightpanda binary
   */
  async install(onProgress?: (progress: DownloadProgress) => void): Promise<void> {
    const platform = this.getPlatform();
    const binaryFilename = PLATFORM_MAPPING[platform];

    if (!binaryFilename) {
      throw new Error(
        `Unsupported platform: ${platform}. Lightpanda supports: ${Object.keys(PLATFORM_MAPPING).join(", ")}`
      );
    }

    const version = this.config.version || DEFAULT_VERSION;
    const downloadUrl = `${GITHUB_RELEASES_URL}/download/${version}/${binaryFilename}`;

    log.info("Downloading Lightpanda", { url: downloadUrl, path: this.binaryPath });

    // Ensure directory exists
    const binaryDir = dirname(this.binaryPath);
    if (!existsSync(binaryDir)) {
      await mkdir(binaryDir, { recursive: true });
    }

    // Download binary
    await this.downloadFile(downloadUrl, this.binaryPath, onProgress);

    // Make executable
    chmodSync(this.binaryPath, 0o755);

    // Verify
    const installed = await this.isInstalled();
    if (!installed) {
      throw new Error("Installation failed: binary not executable");
    }

    log.info("Lightpanda installed successfully", { path: this.binaryPath });
  }

  /**
   * Get version info from binary
   */
  async getVersion(): Promise<string> {
    if (!(await this.isInstalled())) {
      throw new Error("Lightpanda not installed");
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(this.binaryPath, ["version"]);
      let output = "";

      proc.stdout.on("data", (data) => {
        output += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          reject(new Error(`Failed to get version: exit code ${code}`));
        }
      });

      proc.on("error", reject);
    });
  }

  // --------------------------------------------------------------------------
  // INSTANCE MANAGEMENT
  // --------------------------------------------------------------------------

  /**
   * Start a Lightpanda CDP server
   */
  async start(port: number): Promise<LightpandaInstance> {
    if (!(await this.isInstalled())) {
      if (this.config.autoInstall) {
        log.info("Lightpanda not installed, auto-installing...");
        await this.install();
      } else {
        throw new Error(
          "Lightpanda not installed. Run 'openclaw browser install-lightpanda' or set autoInstall: true"
        );
      }
    }

    // Check if port already in use
    if (this.activeInstances.has(port)) {
      const existing = this.activeInstances.get(port)!;
      log.warn("Lightpanda already running on port", { port, pid: existing.pid });
      return existing;
    }

    log.info("Starting Lightpanda", { port, binary: this.binaryPath });

    // Spawn process: lightpanda serve --host 127.0.0.1 --port <port>
    const proc = spawn(this.binaryPath, [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ]);

    const instance: LightpandaInstance = {
      pid: proc.pid!,
      port,
      cdpUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}`,
      process: proc,
      startedAt: Date.now(),
    };

    // Handle process events
    proc.on("error", (err) => {
      log.error("Lightpanda process error", { err, pid: instance.pid });
      this.activeInstances.delete(port);
    });

    proc.on("exit", (code, signal) => {
      log.info("Lightpanda exited", { pid: instance.pid, code, signal });
      this.activeInstances.delete(port);
    });

    // Log stdout/stderr for debugging
    proc.stdout?.on("data", (data) => {
      log.debug("Lightpanda stdout", { output: data.toString().trim() });
    });

    proc.stderr?.on("data", (data) => {
      log.debug("Lightpanda stderr", { output: data.toString().trim() });
    });

    // Wait for CDP to be ready
    await this.waitForCdpReady(instance);

    this.activeInstances.set(port, instance);
    log.info("Lightpanda started successfully", { pid: instance.pid, port });

    return instance;
  }

  /**
   * Stop a Lightpanda instance
   */
  async stop(port: number): Promise<void> {
    const instance = this.activeInstances.get(port);
    if (!instance) {
      return;
    }

    log.info("Stopping Lightpanda", { pid: instance.pid, port });

    // Send SIGTERM
    instance.process.kill("SIGTERM");

    // Wait for exit (max 5 seconds)
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        log.warn("Lightpanda didn't exit gracefully, forcing kill", { pid: instance.pid });
        instance.process.kill("SIGKILL");
        resolve();
      }, 5000);

      instance.process.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.activeInstances.delete(port);
  }

  /**
   * Stop all active instances
   */
  async stopAll(): Promise<void> {
    const ports = [...this.activeInstances.keys()];
    await Promise.all(ports.map((port) => this.stop(port)));
  }

  /**
   * Get active instance by port
   */
  getInstance(port: number): LightpandaInstance | undefined {
    return this.activeInstances.get(port);
  }

  /**
   * Get all active instances
   */
  getAllInstances(): LightpandaInstance[] {
    return [...this.activeInstances.values()];
  }

  // --------------------------------------------------------------------------
  // HEALTH CHECKS
  // --------------------------------------------------------------------------

  /**
   * Check if CDP endpoint is responding
   */
  async isHealthy(port: number): Promise<boolean> {
    const instance = this.activeInstances.get(port);
    if (!instance) {
      return false;
    }

    try {
      const response = await this.fetchJson(`${instance.cdpUrl}/json/version`);
      return response && response.webSocketDebuggerUrl;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // PRIVATE HELPERS
  // --------------------------------------------------------------------------

  private getPlatform(): string {
    const platform = osPlatform();
    const arch = osArch();
    return `${platform}-${arch}`;
  }

  private getDefaultBinaryPath(): string {
    const platform = osPlatform();
    const binaryDir = join(homedir(), ".openclaw", "bin");
    return join(binaryDir, BINARY_NAME);
  }

  private async waitForCdpReady(instance: LightpandaInstance): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < CDP_READY_TIMEOUT_MS) {
      try {
        const response = await this.fetchJson<{ webSocketDebuggerUrl?: string }>(
          `${instance.cdpUrl}/json/version`
        );

        if (response?.webSocketDebuggerUrl) {
          instance.wsUrl = response.webSocketDebuggerUrl;
          return;
        }
      } catch {
        // CDP not ready yet, wait and retry
      }

      await this.sleep(CDP_POLL_INTERVAL_MS);
    }

    throw new Error(
      `Lightpanda CDP not ready after ${CDP_READY_TIMEOUT_MS}ms on port ${instance.port}`
    );
  }

  private async downloadFile(
    url: string,
    destPath: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = createWriteStream(destPath);
      let bytesDownloaded = 0;

      // Auto-select http or https based on URL
      const client = url.startsWith("https://") ? https : http;
      client
        .get(url, (response) => {
          // Handle redirects
          if (response.statusCode === 302 || response.statusCode === 301) {
            const redirectUrl = response.headers.location;
            if (redirectUrl) {
              file.close();
              this.downloadFile(redirectUrl, destPath, onProgress)
                .then(resolve)
                .catch(reject);
              return;
            }
          }

          if (response.statusCode !== 200) {
            file.close();
            reject(new Error(`Download failed: HTTP ${response.statusCode}`));
            return;
          }

          const totalBytes = parseInt(response.headers["content-length"] || "0", 10);

          response.on("data", (chunk) => {
            bytesDownloaded += chunk.length;
            onProgress?.({
              bytesDownloaded,
              totalBytes: totalBytes > 0 ? totalBytes : undefined,
              percentage: totalBytes > 0 ? (bytesDownloaded / totalBytes) * 100 : undefined,
            });
          });

          response.pipe(file);

          file.on("finish", () => {
            file.close();
            resolve();
          });
        })
        .on("error", (err) => {
          file.close();
          reject(err);
        });
    });
  }

  private async fetchJson<T = unknown>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
      // Auto-select http or https based on URL (CDP is http, but this is flexible)
      const client = url.startsWith("https://") ? https : http;
      client
        .get(url, (response) => {
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }

          let data = "";
          response.on("data", (chunk) => (data += chunk));
          response.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(err);
            }
          });
        })
        .on("error", reject);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let defaultManager: LightpandaManager | null = null;

export function getLightpandaManager(config?: LightpandaConfig): LightpandaManager {
  if (!defaultManager && config) {
    defaultManager = new LightpandaManager(config);
  }
  if (!defaultManager) {
    throw new Error("LightpandaManager not initialized. Call getLightpandaManager(config) first.");
  }
  return defaultManager;
}

export function resetLightpandaManager(): void {
  defaultManager = null;
}
