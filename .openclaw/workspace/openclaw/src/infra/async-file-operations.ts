/**
 * Async File Operations
 * 
 * Non-blocking file operations with:
 * - Atomic writes (write to temp, then rename)
 * - Proper error handling
 * - No event loop blocking
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("async-file");

/**
 * Type guard to check if an error is a NodeJS.ErrnoException
 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  );
}

/**
 * Atomic write file (write to temp, then rename)
 * 
 * Writes to a temporary file first, then renames it to the target path.
 * This ensures that readers never see a partially written file.
 * The temp file is cleaned up on error.
 * 
 * @param filePath - Target file path
 * @param data - Data to write (string or Buffer)
 * @param options - Optional file mode (default: 0o644)
 */
export async function atomicWriteFile(
  filePath: string,
  data: string | Buffer,
  options?: { mode?: number }
): Promise<void> {
  const tempPath = `${filePath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
  const mode = options?.mode ?? 0o644;

  try {
    // Ensure directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Write to temp file
    await fs.writeFile(tempPath, data, { mode });

    // Atomic rename
    await fs.rename(tempPath, filePath);

    log.debug(`Atomic write complete: ${filePath}`);
  } catch (error) {
    // Cleanup temp file on error (best effort)
    fs.unlink(tempPath).catch((cleanupError) => {
      log.debug(`Failed to cleanup temp file ${tempPath}:`, cleanupError);
    });
    throw error;
  }
}

/**
 * Read JSON file (async)
 * 
 * Returns null if the file doesn't exist or if parsing fails.
 * Parsing failures are logged at debug level.
 */
export async function readJsonFile<T = unknown>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    log.debug(`Failed to read JSON ${filePath}:`, error);
    return null;
  }
}

/**
 * Write JSON file (async with atomic write)
 * 
 * Note: Always appends a trailing newline for POSIX compatibility.
 */
export async function writeJsonFile<T>(
  filePath: string,
  data: T,
  options?: { mode?: number; pretty?: boolean }
): Promise<void> {
  const json = options?.pretty 
    ? `${JSON.stringify(data, null, 2)}\n`
    : `${JSON.stringify(data)}\n`;
  
  await atomicWriteFile(filePath, json, { mode: options?.mode ?? 0o644 });
}

/**
 * Check if file exists (async)
 * 
 * Returns true if the file exists and is accessible, false otherwise.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure directory exists (async)
 * 
 * Creates the directory and all parent directories if they don't exist.
 * Does not throw if the directory already exists.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Ensure directory exists (sync) - use only for startup paths where async isn't possible
 * 
 * Creates the directory and all parent directories if they don't exist.
 * Does not throw if the directory already exists.
 */
export function ensureDirSync(dirPath: string): void {
  fsSync.mkdirSync(dirPath, { recursive: true });
}

/**
 * Read file with fallback (async)
 * 
 * Returns the file contents if readable, otherwise returns the fallback value.
 * Any error (including ENOENT, permission denied, etc.) results in the fallback.
 */
export async function readFileWithFallback(
  filePath: string,
  fallback: string
): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return fallback;
  }
}

/**
 * Touch file (create if not exists, update mtime if exists)
 * 
 * Updates both access time and modification time to current time.
 * Creates an empty file if it doesn't exist.
 */
export async function touchFile(filePath: string): Promise<void> {
  try {
    await fs.utimes(filePath, new Date(), new Date());
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      await fs.writeFile(filePath, "");
      return;
    }
    throw error;
  }
}
