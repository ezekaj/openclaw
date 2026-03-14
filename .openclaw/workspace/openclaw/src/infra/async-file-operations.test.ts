/**
 * Async File Operations Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  atomicWriteFile,
  readJsonFile,
  writeJsonFile,
  fileExists,
  ensureDir,
  readFileWithFallback,
  touchFile,
} from "./async-file-operations.js";

describe("Async File Operations", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `async-file-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("atomicWriteFile", () => {
    it("should write file atomically", async () => {
      const filePath = path.join(tempDir, "test.txt");
      await atomicWriteFile(filePath, "test content");

      const content = await fs.readFile(filePath, "utf8");
      expect(content).toBe("test content");
    });

    it("should create directory if not exists", async () => {
      const filePath = path.join(tempDir, "subdir", "nested", "test.txt");
      await atomicWriteFile(filePath, "nested content");

      const exists = await fileExists(filePath);
      expect(exists).toBe(true);
    });

    it("should overwrite existing file", async () => {
      const filePath = path.join(tempDir, "test.txt");
      await atomicWriteFile(filePath, "original");
      await atomicWriteFile(filePath, "updated");

      const content = await fs.readFile(filePath, "utf8");
      expect(content).toBe("updated");
    });

    it("should set file mode", async () => {
      const filePath = path.join(tempDir, "test.txt");
      await atomicWriteFile(filePath, "content", { mode: 0o600 });

      const stats = await fs.stat(filePath);
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it("should cleanup temp file on error", async () => {
      const filePath = path.join(tempDir, "test.txt");
      
      // Create a file with invalid path (should fail)
      await expect(
        atomicWriteFile("", "content")
      ).rejects.toThrow();

      // No temp files should remain
      const files = await fs.readdir(tempDir);
      expect(files).toHaveLength(0);
    });
  });

  describe("readJsonFile", () => {
    it("should read and parse JSON file", async () => {
      const filePath = path.join(tempDir, "test.json");
      const data = { key: "value", count: 42 };
      await fs.writeFile(filePath, JSON.stringify(data));

      const result = await readJsonFile(filePath);
      expect(result).toEqual(data);
    });

    it("should return null if file not found", async () => {
      const result = await readJsonFile("/nonexistent/file.json");
      expect(result).toBeNull();
    });

    it("should return null on parse error", async () => {
      const filePath = path.join(tempDir, "invalid.json");
      await fs.writeFile(filePath, "not valid json {{{");

      const result = await readJsonFile(filePath);
      expect(result).toBeNull();
    });
  });

  describe("writeJsonFile", () => {
    it("should write JSON file with atomic write", async () => {
      const filePath = path.join(tempDir, "test.json");
      const data = { key: "value" };
      await writeJsonFile(filePath, data);

      const content = await fs.readFile(filePath, "utf8");
      expect(content).toContain("key");
      expect(content).toContain("value");
    });

    it("should pretty-print when requested", async () => {
      const filePath = path.join(tempDir, "test.json");
      const data = { key: "value" };
      await writeJsonFile(filePath, data, { pretty: true });

      const content = await fs.readFile(filePath, "utf8");
      expect(content).toContain("\n"); // Pretty printed has newlines
    });

    it("should compact without pretty option", async () => {
      const filePath = path.join(tempDir, "test.json");
      const data = { key: "value" };
      await writeJsonFile(filePath, data, { pretty: false });

      const content = await fs.readFile(filePath, "utf8");
      expect(content).not.toContain("\n  "); // No indentation
    });

    it("should set file mode", async () => {
      const filePath = path.join(tempDir, "test.json");
      const data = { key: "value" };
      await writeJsonFile(filePath, data, { mode: 0o600 });

      const stats = await fs.stat(filePath);
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  describe("fileExists", () => {
    it("should return true for existing file", async () => {
      const filePath = path.join(tempDir, "test.txt");
      await fs.writeFile(filePath, "content");

      const exists = await fileExists(filePath);
      expect(exists).toBe(true);
    });

    it("should return false for non-existing file", async () => {
      const exists = await fileExists("/nonexistent/file.txt");
      expect(exists).toBe(false);
    });
  });

  describe("ensureDir", () => {
    it("should create directory", async () => {
      const dirPath = path.join(tempDir, "new", "nested", "dir");
      await ensureDir(dirPath);

      const exists = await fileExists(dirPath);
      expect(exists).toBe(true);
    });

    it("should not fail if directory exists", async () => {
      const dirPath = path.join(tempDir, "existing");
      await ensureDir(dirPath);
      await ensureDir(dirPath); // Should not throw

      const exists = await fileExists(dirPath);
      expect(exists).toBe(true);
    });
  });

  describe("readFileWithFallback", () => {
    it("should read existing file", async () => {
      const filePath = path.join(tempDir, "test.txt");
      await fs.writeFile(filePath, "content");

      const result = await readFileWithFallback(filePath, "fallback");
      expect(result).toBe("content");
    });

    it("should return fallback for non-existing file", async () => {
      const result = await readFileWithFallback("/nonexistent/file.txt", "fallback");
      expect(result).toBe("fallback");
    });
  });

  describe("touchFile", () => {
    it("should create file if not exists", async () => {
      const filePath = path.join(tempDir, "new.txt");
      await touchFile(filePath);

      const exists = await fileExists(filePath);
      expect(exists).toBe(true);
    });

    it("should update mtime if file exists", async () => {
      const filePath = path.join(tempDir, "existing.txt");
      await fs.writeFile(filePath, "content");

      const stats1 = await fs.stat(filePath);
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait a bit

      await touchFile(filePath);

      const stats2 = await fs.stat(filePath);
      expect(stats2.mtimeMs).toBeGreaterThan(stats1.mtimeMs);
    });
  });
});
