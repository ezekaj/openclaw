import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";

const THREAD_SUFFIX_REGEX = /^(.*)(?::(?:thread|topic):\d+)$/i;

function stripThreadSuffix(value: string): string {
  const match = value.match(THREAD_SUFFIX_REGEX);
  return match?.[1] ?? value;
}

/**
 * Limits conversation history to the last N user turns (and their associated
 * assistant responses). This reduces token usage for long-running DM sessions.
 */
export function limitHistoryTurns(
  messages: AgentMessage[],
  limit: number | undefined,
): AgentMessage[] {
  if (!limit || limit <= 0 || messages.length === 0) {
    return messages;
  }

  let userCount = 0;
  let lastUserIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userCount++;
      if (userCount > limit) {
        return messages.slice(lastUserIndex);
      }
      lastUserIndex = i;
    }
  }
  return messages;
}

/**
 * Extract provider + user ID from a session key and look up dmHistoryLimit.
 * Supports per-DM overrides and provider defaults.
 */
export function getDmHistoryLimitFromSessionKey(
  sessionKey: string | undefined,
  config: OpenClawConfig | undefined,
): number | undefined {
  if (!sessionKey || !config) {
    return undefined;
  }

  const parts = sessionKey.split(":").filter(Boolean);
  const providerParts = parts.length >= 3 && parts[0] === "agent" ? parts.slice(2) : parts;

  const provider = providerParts[0]?.toLowerCase();
  if (!provider) {
    return undefined;
  }

  const kind = providerParts[1]?.toLowerCase();
  const userIdRaw = providerParts.slice(2).join(":");
  const userId = stripThreadSuffix(userIdRaw);
  if (kind !== "dm") {
    return undefined;
  }

  const getLimit = (
    providerConfig:
      | {
          dmHistoryLimit?: number;
          dms?: Record<string, { historyLimit?: number }>;
        }
      | undefined,
  ): number | undefined => {
    if (!providerConfig) {
      return undefined;
    }
    if (userId && providerConfig.dms?.[userId]?.historyLimit !== undefined) {
      return providerConfig.dms[userId].historyLimit;
    }
    return providerConfig.dmHistoryLimit;
  };

  const resolveProviderConfig = (
    cfg: OpenClawConfig | undefined,
    providerId: string,
  ): { dmHistoryLimit?: number; dms?: Record<string, { historyLimit?: number }> } | undefined => {
    const channels = cfg?.channels;
    if (!channels || typeof channels !== "object") {
      return undefined;
    }
    const entry = (channels as Record<string, unknown>)[providerId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return undefined;
    }
    return entry as { dmHistoryLimit?: number; dms?: Record<string, { historyLimit?: number }> };
  };

  return getLimit(resolveProviderConfig(config, provider));
}

// ============================================================================
// Tool result compression for context-constrained models
// ============================================================================

/** Max chars for tool results in older messages (recent ones keep full content) */
const OLDER_TOOL_RESULT_MAX_CHARS = 200;
/** Number of recent user turns to keep with full tool results */
const FULL_RESULT_RECENT_TURNS = 1;

/**
 * Compress old tool results in session history to reduce token usage.
 *
 * Keeps the last N user turns with full tool results intact (the agent needs
 * them for the current task). For older turns, replaces large tool results
 * with a brief summary: URL, status, and first few lines.
 *
 * This runs before every prompt — no LLM needed, pure string truncation.
 * A browser DOM snapshot goes from ~50k chars to ~200 chars.
 */
export function compressOldToolResults(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length === 0) return messages;

  // Find the boundary: keep last N user turns with full results
  let userTurnsSeen = 0;
  let boundaryIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen > FULL_RESULT_RECENT_TURNS) {
        boundaryIndex = i;
        break;
      }
    }
  }

  // Nothing to compress — all messages are recent
  if (boundaryIndex >= messages.length) return messages;

  return messages.map((msg, idx) => {
    // Keep recent messages untouched
    if (idx >= boundaryIndex) return msg;

    const content = msg.content;
    if (!Array.isArray(content)) return msg;

    let changed = false;
    const newContent = content.map((block: Record<string, unknown>) => {
      // Compress tool_result blocks
      if (block.type === "tool_result") {
        const compressed = compressToolResultBlock(block);
        if (compressed !== block) changed = true;
        return compressed;
      }
      // Compress toolCall arguments (browser action JSON can be huge)
      if (block.type === "toolCall" && typeof block.arguments === "string" &&
          block.arguments.length > OLDER_TOOL_RESULT_MAX_CHARS) {
        changed = true;
        return { ...block, arguments: block.arguments.slice(0, OLDER_TOOL_RESULT_MAX_CHARS) + "..." };
      }
      return block;
    });

    return changed ? { ...msg, content: newContent } : msg;
  });
}

function compressToolResultBlock(block: Record<string, unknown>): Record<string, unknown> {
  // String content
  if (typeof block.content === "string" && block.content.length > OLDER_TOOL_RESULT_MAX_CHARS) {
    return {
      ...block,
      content: extractToolResultSummary(block.content),
    };
  }

  // Array content (nested text blocks)
  if (Array.isArray(block.content)) {
    let changed = false;
    const newNested = (block.content as Record<string, unknown>[]).map((nested) => {
      if (nested.type === "text" && typeof nested.text === "string" &&
          nested.text.length > OLDER_TOOL_RESULT_MAX_CHARS) {
        changed = true;
        return { ...nested, text: extractToolResultSummary(nested.text) };
      }
      return nested;
    });
    return changed ? { ...block, content: newNested } : block;
  }

  return block;
}

/**
 * Extract a meaningful summary from a tool result string.
 * For browser results: keeps URL, status, and key info.
 * For other tools: keeps the first few meaningful lines.
 */
function extractToolResultSummary(text: string): string {
  // Try to extract URL from browser results
  const urlMatch = text.match(/"url"\s*:\s*"([^"]+)"/);
  const okMatch = text.match(/"ok"\s*:\s*(true|false)/);
  const errorMatch = text.match(/"error"\s*:\s*"([^"]+)"/);

  if (urlMatch || okMatch) {
    const parts: string[] = [];
    if (okMatch) parts.push(`ok:${okMatch[1]}`);
    if (urlMatch) parts.push(urlMatch[1]);
    if (errorMatch) parts.push(`error:${errorMatch[1].slice(0, 80)}`);
    return `[result: ${parts.join(" | ")}]`;
  }

  // For non-browser results: keep first meaningful content
  const lines = text.split("\n").filter((l) => l.trim()).slice(0, 3);
  const summary = lines.join(" ").slice(0, OLDER_TOOL_RESULT_MAX_CHARS);
  return summary + (text.length > OLDER_TOOL_RESULT_MAX_CHARS ? " [...]" : "");
}
