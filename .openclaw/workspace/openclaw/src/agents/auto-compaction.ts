/**
 * Auto-Compaction
 *
 * Provides a simplified interface to trigger compaction from a sessionKey,
 * handling session lookup and parameter resolution internally.
 */

import { promises as fsPromises } from "fs";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveSessionFilePath, resolveStorePath } from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isVerbose } from "../globals.js";
import { compactEmbeddedPiSession } from "./pi-embedded.js";
import { acquireSessionWriteLock } from "./session-write-lock.js";

const log = createSubsystemLogger("auto-compaction");

// ============================================================================
// Types for session file entries (JSONL format)
// ============================================================================

/** Session header entry (first line of session file) */
type SessionHeaderEntry = {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
};

/** Custom metadata entry */
type SessionCustomEntry = {
  type: "custom";
  [key: string]: unknown;
};

/** Message entry in session file */
type SessionMessageEntry = {
  type: "message";
  id: string;
  timestamp?: string;
  message: {
    role: "user" | "assistant";
    content: MessageContent;
    timestamp?: number;
    stopReason?: string;
  };
};

/** Content block types */
type TextContentBlock = { type: "text"; text: string };
type ToolResultBlock = {
  type: "tool_result";
  content?: string | ContentBlock[];
};
type ToolCallBlock = {
  type: "toolCall";
  arguments?: string;
};
type ContentBlock = TextContentBlock | ToolResultBlock | ToolCallBlock;

type MessageContent = string | ContentBlock[];

/** Union of all session entry types */
type SessionEntry = SessionHeaderEntry | SessionCustomEntry | SessionMessageEntry;

/** Context required for auto-compaction */
export interface AutoCompactionContext {
  config: OpenClawConfig;
  workspaceDir: string;
}

let globalContext: AutoCompactionContext | null = null;

/**
 * Initialize the auto-compaction context.
 * Must be called at startup before any auto-compaction can be triggered.
 */
export function initAutoCompactionContext(ctx: AutoCompactionContext): void {
  globalContext = ctx;
  log.debug("Auto-compaction context initialized");
}

/**
 * Trigger auto-compaction for a session.
 * Uses the global context to resolve session info and trigger compaction.
 */
export async function triggerAutoCompaction(
  sessionKey: string,
  agentId: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!globalContext) {
    log.warn("Auto-compaction context not initialized");
    return { ok: false, reason: "context not initialized" };
  }

  const { config, workspaceDir } = globalContext;

  try {
    // Resolve session store path for this agent
    const storePath = resolveStorePath(config?.session?.store, { agentId });

    // Load session store and find the entry
    const store = loadSessionStore(storePath);
    const sessionEntry = store[sessionKey];

    if (!sessionEntry?.sessionId) {
      log.warn(`Session not found for key: ${sessionKey}`);
      return { ok: false, reason: "session not found" };
    }

    const sessionId = sessionEntry.sessionId;
    const sessionFile = resolveSessionFilePath(sessionId, sessionEntry, { agentId });

    if (isVerbose()) {
      log.info(`Triggering auto-compaction for session ${sessionKey}`);
    }

    // Trigger compaction with minimal required parameters
    const result = await compactEmbeddedPiSession({
      sessionId,
      sessionKey,
      sessionFile,
      workspaceDir,
      config,
      groupId: sessionEntry.groupId,
      groupChannel: sessionEntry.groupChannel,
      groupSpace: sessionEntry.space,
      spawnedBy: sessionEntry.spawnedBy,
      skillsSnapshot: sessionEntry.skillsSnapshot,
      customInstructions: "Auto-compaction triggered. Summarize the conversation concisely.",
    });

    if (result.ok) {
      log.info(
        `Auto-compaction completed for ${sessionKey}: ${result.compacted ? "compacted" : "skipped"}`,
      );
      return { ok: true, reason: result.reason };
    } else {
      log.error(`Auto-compaction failed for ${sessionKey}: ${result.reason}`);
      return { ok: false, reason: result.reason };
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error(`Auto-compaction error for ${sessionKey}: ${errMsg}`);
    return { ok: false, reason: errMsg };
  }
}

// ============================================================================
// FAST TRUNCATE (no LLM needed — instant session trimming)
// ============================================================================

/** Max session file size before fast-truncate kicks in (bytes) */
const FAST_TRUNCATE_THRESHOLD = 150_000; // 150KB
/** Max chars per content block after truncation */
const MAX_BLOCK_CHARS = 400;
/** Number of recent messages to keep */
const KEEP_MESSAGES = 12;
/** Maximum headers to preserve (prevents unbounded growth) */
const MAX_HEADERS = 5;

/**
 * Type guard to check if an entry is a message entry
 */
function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
  return entry.type === "message";
}

/**
 * Type guard to check if an entry is a custom/header entry
 */
function isCustomEntry(entry: SessionEntry): entry is SessionCustomEntry {
  return entry.type === "custom";
}

/**
 * Truncate a text string to maxChars, adding marker if truncated
 */
function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + " [trimmed]";
}

/**
 * Truncate content blocks in a message entry (mutates in place for efficiency)
 */
function truncateMessageContent(entry: SessionMessageEntry, maxChars: number): void {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      block.text = truncateText(block.text, maxChars);
    } else if (block.type === "tool_result") {
      if (typeof block.content === "string") {
        block.content = truncateText(block.content, maxChars);
      } else if (Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (nested?.type === "text" && typeof nested.text === "string") {
            nested.text = truncateText(nested.text, maxChars);
          }
        }
      }
    } else if (block.type === "toolCall" && typeof block.arguments === "string") {
      block.arguments = truncateText(block.arguments, maxChars);
    }
  }
}

/**
 * Extract user text from a message entry for summary generation
 */
function extractUserText(entry: SessionMessageEntry, maxLength: number): string {
  const content = entry.message?.content;
  if (typeof content === "string") {
    return content.slice(0, maxLength);
  }
  if (Array.isArray(content)) {
    const textBlock = content.find((c): c is TextContentBlock => c.type === "text");
    return textBlock?.text?.slice(0, maxLength) ?? "";
  }
  return "";
}

/**
 * Parse session file lines into typed entries
 */
function parseSessionLines(raw: string): SessionEntry[] {
  const lines: SessionEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SessionEntry;
      // Validate it has a recognized type
      if (parsed.type === "session" || parsed.type === "message" || parsed.type === "custom") {
        lines.push(parsed);
      }
    } catch {
      // Skip malformed lines - they'll be lost but that's better than crashing
      log.debug(`Skipping malformed session line: ${trimmed.slice(0, 50)}...`);
    }
  }
  return lines;
}

/**
 * Fast-truncate a session file without any LLM call.
 * Keeps header entries + last N messages with truncated content blocks.
 * Runs after every answer to keep sessions small.
 *
 * IMPORTANT: Uses session write lock to prevent race conditions with
 * concurrent compaction or other session modifications.
 */
export async function fastTruncateSession(
  sessionKey: string,
  agentId: string,
): Promise<{ truncated: boolean; reason?: string }> {
  if (!globalContext) {
    return { truncated: false, reason: "context not initialized" };
  }

  const { config } = globalContext;

  try {
    const storePath = resolveStorePath(config?.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const sessionEntry = store[sessionKey];

    if (!sessionEntry?.sessionId) {
      return { truncated: false, reason: "session not found" };
    }

    const sessionFile = resolveSessionFilePath(sessionEntry.sessionId, sessionEntry, { agentId });

    // Check file size — skip if small enough (use async stat)
    let fileSize: number;
    try {
      const stats = await fsPromises.stat(sessionFile);
      fileSize = stats.size;
    } catch {
      return { truncated: false, reason: "session file not found" };
    }

    if (fileSize < FAST_TRUNCATE_THRESHOLD) {
      return { truncated: false, reason: "below threshold" };
    }

    log.info(
      `Fast-truncate: session ${sessionKey} is ${(fileSize / 1024).toFixed(0)}KB ` +
        `(threshold: ${(FAST_TRUNCATE_THRESHOLD / 1024).toFixed(0)}KB)`,
    );

    // Acquire session write lock to prevent race conditions
    const sessionLock = await acquireSessionWriteLock({ sessionFile });

    try {
      // Re-read file size after acquiring lock (it may have changed)
      let currentSize: number;
      try {
        const stats = await fsPromises.stat(sessionFile);
        currentSize = stats.size;
      } catch {
        // File was deleted while we waited for lock
        return { truncated: false, reason: "session file deleted" };
      }

      if (currentSize < FAST_TRUNCATE_THRESHOLD) {
        return { truncated: false, reason: "below threshold (updated)" };
      }

      // Read and parse with proper types
      const raw = await fsPromises.readFile(sessionFile, "utf-8");
      const lines = parseSessionLines(raw);

      // Separate headers (custom/metadata) from messages
      const headers = lines.filter(isCustomEntry);
      const messages = lines.filter(isMessageEntry);

      // Filter out error responses
      const goodMessages = messages.filter((m) => m.message?.stopReason !== "error");

      // Keep last N messages
      const kept = goodMessages.slice(-KEEP_MESSAGES);

      // Nothing to truncate
      if (kept.length === goodMessages.length) {
        return { truncated: false, reason: "not enough messages to truncate" };
      }

      // Truncate large content blocks in kept messages
      for (const entry of kept) {
        truncateMessageContent(entry, MAX_BLOCK_CHARS);
      }

      // Build a summary of dropped messages (no LLM, just extract user questions)
      const dropped = goodMessages.slice(0, -KEEP_MESSAGES);
      const droppedUserTexts = dropped
        .filter((m) => m.message?.role === "user")
        .map((m) => extractUserText(m, 100))
        .filter(Boolean);

      // Create a synthetic compaction summary message
      const summaryParts: string[] = [];
      if (droppedUserTexts.length > 0) {
        summaryParts.push(
          `Earlier in this session (${dropped.length} messages trimmed), the user asked about:`,
        );
        // Last 5 user messages from dropped
        for (const t of droppedUserTexts.slice(-5)) {
          summaryParts.push(`- ${t}`);
        }
      }

      const summaryEntry: SessionMessageEntry[] = summaryParts.length > 0
        ? [{
            type: "message",
            id: `compaction-${Date.now()}`,
            timestamp: new Date().toISOString(),
            message: {
              role: "user",
              content: [{ type: "text", text: `[Session compacted] ${summaryParts.join("\n")}` }],
              timestamp: Date.now(),
            },
          }]
        : [];

      // Write back: headers (limited) + summary + kept messages
      const result: SessionEntry[] = [
        ...headers.slice(0, MAX_HEADERS),
        ...summaryEntry,
        ...kept,
      ];
      const output = result.map((e) => JSON.stringify(e)).join("\n") + "\n";

      // Atomic write via temp file
      const tmpFile = `${sessionFile}.${process.pid}.tmp`;
      try {
        await fsPromises.writeFile(tmpFile, output, "utf-8");
        await fsPromises.rename(tmpFile, sessionFile);
      } catch (writeErr) {
        // Clean up temp file on failure
        await fsPromises.unlink(tmpFile).catch(() => {});
        throw writeErr;
      }

      const newSize = Buffer.byteLength(output, "utf-8");
      log.info(
        `Fast-truncate complete: ${lines.length} → ${result.length} entries, ` +
          `${(currentSize / 1024).toFixed(0)}KB → ${(newSize / 1024).toFixed(0)}KB`,
      );

      return { truncated: true };
    } finally {
      await sessionLock.release();
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error(`Fast-truncate error: ${errMsg}`);
    return { truncated: false, reason: errMsg };
  }
}
