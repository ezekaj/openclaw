import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type MemoryFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
};

export type MemoryChunk = {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
};

export function normalizeRelPath(value: string): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim().replace(/^[./]+/, "");
  // Remove null bytes and normalize path separators
  return trimmed.replace(/\0/g, "").replace(/\\/g, "/");
}

export function normalizeExtraMemoryPaths(workspaceDir: string, extraPaths?: string[]): string[] {
  if (!Array.isArray(extraPaths) || extraPaths.length === 0) {
    return [];
  }
  if (typeof workspaceDir !== "string" || !workspaceDir.trim()) {
    return [];
  }
  const resolved = extraPaths
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) =>
      path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceDir, value),
    );
  return Array.from(new Set(resolved));
}

export function isMemoryPath(relPath: string): boolean {
  if (typeof relPath !== "string") {
    return false;
  }
  const normalized = normalizeRelPath(relPath);
  if (!normalized) {
    return false;
  }
  if (normalized === "MEMORY.md" || normalized === "memory.md") {
    return true;
  }
  return normalized.startsWith("memory/");
}

async function walkDir(dir: string, files: string[]): Promise<void> {
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // Directory may have been removed or is inaccessible
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await walkDir(full, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.endsWith(".md")) {
      continue;
    }
    files.push(full);
  }
}

export async function listMemoryFiles(
  workspaceDir: string,
  extraPaths?: string[],
): Promise<string[]> {
  const result: string[] = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const altMemoryFile = path.join(workspaceDir, "memory.md");
  const memoryDir = path.join(workspaceDir, "memory");

  const addMarkdownFile = async (absPath: string): Promise<void> => {
    try {
      const stat = await fs.lstat(absPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return;
      }
      if (!absPath.endsWith(".md")) {
        return;
      }
      result.push(absPath);
    } catch {
      // File may not exist or be inaccessible - this is expected
    }
  };

  await addMarkdownFile(memoryFile);
  await addMarkdownFile(altMemoryFile);
  try {
    const dirStat = await fs.lstat(memoryDir);
    if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
      await walkDir(memoryDir, result);
    }
  } catch {
    // Memory directory may not exist - this is expected
  }

  const normalizedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
  if (normalizedExtraPaths.length > 0) {
    for (const inputPath of normalizedExtraPaths) {
      try {
        const stat = await fs.lstat(inputPath);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          await walkDir(inputPath, result);
          continue;
        }
        if (stat.isFile() && inputPath.endsWith(".md")) {
          result.push(inputPath);
        }
      } catch {
        // Extra path may not exist or be inaccessible - this is expected
      }
    }
  }
  if (result.length <= 1) {
    return result;
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of result) {
    let key = entry;
    try {
      key = await fs.realpath(entry);
    } catch {
      // If realpath fails, use the original path as key
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export function hashText(value: string): string {
  if (typeof value !== "string") {
    // Hash empty string for non-string inputs
    return crypto.createHash("sha256").update("").digest("hex");
  }
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function buildFileEntry(
  absPath: string,
  workspaceDir: string,
): Promise<MemoryFileEntry> {
  // Validate inputs
  if (typeof absPath !== "string" || !absPath.trim()) {
    throw new Error("buildFileEntry: absPath must be a non-empty string");
  }
  if (typeof workspaceDir !== "string" || !workspaceDir.trim()) {
    throw new Error("buildFileEntry: workspaceDir must be a non-empty string");
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  let content: string;

  try {
    stat = await fs.stat(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(
      `buildFileEntry: cannot stat file "${absPath}": ${code ?? "unknown error"}`,
      { cause: err },
    );
  }

  try {
    content = await fs.readFile(absPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(
      `buildFileEntry: cannot read file "${absPath}": ${code ?? "unknown error"}`,
      { cause: err },
    );
  }

  const hash = hashText(content);
  return {
    path: path.relative(workspaceDir, absPath).replace(/\\/g, "/"),
    absPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash,
  };
}

export function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  // Input validation
  if (typeof content !== "string") {
    return [];
  }
  if (!chunking || typeof chunking.tokens !== "number" || typeof chunking.overlap !== "number") {
    return [];
  }

  const lines = content.split("\n");
  if (lines.length === 0) {
    return [];
  }
  const maxChars = Math.max(32, chunking.tokens * 4);
  const overlapChars = Math.max(0, chunking.overlap * 4);
  const chunks: MemoryChunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    const firstEntry = current[0];
    const lastEntry = current[current.length - 1];
    // These are guaranteed to exist when current.length > 0
    const text = current.map((entry) => entry.line).join("\n");
    chunks.push({
      startLine: firstEntry.lineNo,
      endLine: lastEntry.lineNo,
      text,
      hash: hashText(text),
    });
  };

  const carryOverlap = (): void => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: Array<{ line: string; lineNo: number }> = [];
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const entry = current[i];
      // entry is guaranteed to exist when iterating current's valid indices
      acc += entry.line.length + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) {
        break;
      }
    }
    current = kept;
    currentChars = kept.reduce((sum, entry) => sum + entry.line.length + 1, 0);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push("");
    } else {
      for (let start = 0; start < line.length; start += maxChars) {
        segments.push(line.slice(start, start + maxChars));
      }
    }
    for (const segment of segments) {
      const lineSize = segment.length + 1;
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }
  flush();
  return chunks;
}

export function parseEmbedding(raw: string): number[] {
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    // Validate all elements are finite numbers
    const result: number[] = [];
    for (const item of parsed) {
      if (typeof item === "number" && Number.isFinite(item)) {
        result.push(item);
      } else {
        // Invalid element found - return empty to indicate corrupt data
        return [];
      }
    }
    return result;
  } catch {
    return [];
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  // Input validation
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return 0;
  }
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  // Vectors must have the same length for meaningful cosine similarity
  if (a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    // Skip non-finite values (they would corrupt the calculation)
    if (typeof av !== "number" || !Number.isFinite(av)) {
      continue;
    }
    if (typeof bv !== "number" || !Number.isFinite(bv)) {
      continue;
    }
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Clamp to [-1, 1] to handle floating point errors
  return Math.max(-1, Math.min(1, similarity));
}
