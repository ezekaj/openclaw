#!/usr/bin/env node
/**
 * Dev Observer Mode
 * 
 * Starts gateway in dev mode and shows logs without interactive TUI.
 * Use this for debugging/monitoring without chat interaction.
 */

import type { Command } from "commander";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");

export function registerDevObserverCli(program: Command) {
  program
    .command("dev")
    .description("Dev observer mode - shows logs without interactive TUI")
    .action(() => {
      console.log("=== OpenClaw Dev Observer Mode ===");
      console.log("Starting gateway in dev mode (port 19001)...");
      console.log("Press Ctrl+C to stop\n");

      // Start gateway in dev mode
      const gateway = spawn("node", ["scripts/run-node.mjs", "--dev", "gateway"], {
        cwd: workspaceRoot,
        stdio: "inherit",
        env: { ...process.env, FORCE_COLOR: "1" },
      });

      gateway.on("error", (err) => {
        console.error("Failed to start gateway:", err);
        process.exit(1);
      });

      gateway.on("exit", (code) => {
        console.log(`Gateway exited with code ${code}`);
        process.exit(code ?? 0);
      });

      // Handle Ctrl+C
      process.on("SIGINT", () => {
        console.log("\nShutting down...");
        gateway.kill("SIGINT");
      });

      process.on("SIGTERM", () => {
        gateway.kill("SIGTERM");
      });
    });
}
