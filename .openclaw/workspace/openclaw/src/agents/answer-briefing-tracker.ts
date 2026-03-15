/**
 * Answer Briefing Tracker
 *
 * Tracks agent answers per session and:
 * 1. Records briefing after EVERY answer
 * 2. Triggers auto-compact after 25 answers (configurable)
 *
 * Listens for "answer" stream events emitted when assistant messages complete.
 *
 * Thread Safety: This module uses module-level state. The handleAgentEvent function
 * is designed to be called from a single event listener. If concurrent processing
 * is needed, external synchronization would be required.
 */

import { promises as fs } from "fs";
import { statSync } from "fs";
import path from "path";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { loadSessionStore, resolveSessionFilePath, resolveStorePath } from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isVerbose } from "../globals.js";
import {
  recordCompaction,
  type CompactionBriefingConfig,
  type CompactionEvent,
} from "./compaction-briefing.js";
import { extractAgentIdFromSessionKey } from "./session-utils.js";
import { fastTruncateSession, type AutoCompactionContext } from "./auto-compaction.js";

const log = createSubsystemLogger("answer-briefing-tracker");

/** Default timeout for LLM API calls (10 seconds) */
const LLM_API_TIMEOUT_MS = 10_000;

/** Maximum number of cycle summaries to keep (prevents unbounded memory growth) */
const MAX_CYCLE_SUMMARIES = 100;

/** Configuration for the answer briefing tracker */
export interface AnswerBriefingConfig extends CompactionBriefingConfig {
  /** Number of answers before triggering auto-compact (default: 25) */
  compactAfterAnswers?: number;
  /** Number of cycles before aggregating into master briefing (default: 2) */
  aggregateAfterCycles?: number;
  /** Callback to trigger compaction */
  onCompactNeeded?: (sessionKey: string, agentId: string) => Promise<void>;
  /** LLM config for cycle summaries */
  llmConfig?: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  };
  /** Auto-compaction context for file-size-based compaction checks */
  compactionContext?: AutoCompactionContext;
}

/** Internal tracking state for a session */
interface SessionTracker {
  count: number;
  agentId: string;
  answerTexts: string[];
  /** Estimated total characters for token calculation */
  estimatedChars: number;
}

const DEFAULT_COMPACT_AFTER_ANSWERS = 25;
const DEFAULT_AGGREGATE_AFTER_CYCLES = 2;

// Track answer counts by sessionKey
const answerCounts = new Map<string, SessionTracker>();

// Collect cycle summaries for aggregation (NOT saved to context)
const cycleSummaries: string[] = [];
let cycleCount = 0;

// Keep recent summaries for continuity (last 2 cycles) - use fixed-size array for O(1) operations
let recentSummaries: string[] = [];

/** Get recent summaries for context continuity */
export function getRecentSummaries(): string[] {
  return [...recentSummaries]; // Return a copy to prevent external mutation
}

let unsubscribe: (() => void) | null = null;
let config: AnswerBriefingConfig | null = null;
let autoCompactionContext: AutoCompactionContext | null = null;

/** Check if the tracker is initialized */
export function isInitialized(): boolean {
  return unsubscribe !== null;
}

/**
 * Initialize the answer briefing tracker
 * @param cfg - Optional configuration (will be merged with defaults)
 */
export function initAnswerBriefingTracker(cfg?: AnswerBriefingConfig): void {
  if (unsubscribe) {
    log.debug("Answer briefing tracker already initialized");
    return;
  }

  config = cfg ?? null;
  autoCompactionContext = cfg?.compactionContext ?? null;
  unsubscribe = onAgentEvent(handleAgentEvent);
  log.info("Answer briefing tracker initialized");
}

/**
 * Stop the answer briefing tracker and clear all state
 */
export function stopAnswerBriefingTracker(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  answerCounts.clear();
  cycleSummaries.length = 0;
  recentSummaries.length = 0;
  cycleCount = 0;
  config = null;
  autoCompactionContext = null;
  log.info("Answer briefing tracker stopped");
}

/**
 * Handle agent events
 */
function handleAgentEvent(evt: AgentEventPayload): void {
  // Listen for "answer" stream events (emitted when assistant message completes)
  if (evt.stream !== "answer") {
    return;
  }

  // Validate sessionKey - must have either sessionKey or runId
  const sessionKey = evt.sessionKey ?? evt.runId;
  if (!sessionKey) {
    log.debug("Answer event missing sessionKey and runId, skipping");
    return;
  }

  // Safely extract answer text
  const answerText = extractAnswerText(evt.data);
  if (!answerText.trim()) {
    return;
  }

  const agentId = extractAgentIdFromSessionKey(sessionKey);

  // Get or create answer tracking for this session
  let tracker = answerCounts.get(sessionKey);
  if (!tracker) {
    tracker = {
      count: 0,
      agentId,
      answerTexts: [],
      estimatedChars: 0,
    };
    answerCounts.set(sessionKey, tracker);
  }

  // Increment answer count and track text for cycle summary
  const truncatedText = answerText.slice(0, 300);
  tracker.count += 1;
  tracker.answerTexts.push(truncatedText);
  tracker.estimatedChars += truncatedText.length;

  log.debug(`Answer #${tracker.count} for session ${sessionKey}`);

  // Fast-Truncate: trim session file if too large (no LLM needed, instant)
  void fastTruncateSession(sessionKey, agentId).catch((err) => {
    log.debug(`Fast-truncate skipped: ${err}`);
  });

  // Record briefing for this answer
  void recordAnswerBriefing(sessionKey, agentId, tracker.count, answerText);

  // Check if we need to trigger auto-compact (file-size-based OR answer-count-based)
  const compactAfter = config?.compactAfterAnswers ?? DEFAULT_COMPACT_AFTER_ANSWERS;
  const shouldCompact = checkCompactionNeeded(tracker, compactAfter, sessionKey, agentId);

  if (shouldCompact) {
    triggerCompaction(sessionKey, agentId, tracker);
  }
}

/**
 * Safely extract answer text from event data
 */
function extractAnswerText(data: Record<string, unknown> | undefined): string {
  if (!data) return "";
  const text = data.text;
  if (typeof text === "string") return text;
  return "";
}

/** Session file size threshold for triggering LLM compaction (bytes) */
const FILE_SIZE_COMPACT_THRESHOLD = 100_000; // 100KB — compact before fast-truncate (150KB) kicks in

/**
 * Check if compaction is needed based on session file size or answer count.
 * Token estimation from answer text alone is unreliable (ignores tool results,
 * user messages, system prompt), so we check actual session file size instead.
 */
function checkCompactionNeeded(
  tracker: SessionTracker,
  compactAfter: number,
  sessionKey: string,
  agentId: string,
): boolean {
  // Answer-count-based trigger
  if (tracker.count >= compactAfter) {
    log.info(`Session ${sessionKey} reached ${tracker.count} answers, triggering auto-compact`);
    return true;
  }

  // File-size-based trigger — check actual session file size (more reliable than token estimation)
  if (tracker.count >= 2 && autoCompactionContext) {
    try {
      const storePath = resolveStorePath(autoCompactionContext.config?.session?.store, { agentId });
      const store = loadSessionStore(storePath);
      const sessionEntry = store[sessionKey];
      if (sessionEntry?.sessionId) {
        const sessionFile = resolveSessionFilePath(sessionEntry.sessionId, sessionEntry, { agentId });
        const stat = statSync(sessionFile);
        if (stat.size > FILE_SIZE_COMPACT_THRESHOLD) {
          log.info(
            `Session ${sessionKey} file is ${(stat.size / 1024).toFixed(0)}KB (threshold: ${(FILE_SIZE_COMPACT_THRESHOLD / 1024).toFixed(0)}KB), triggering size-based auto-compact`,
          );
          return true;
        }
      }
    } catch {
      // Non-critical — fall through to answer-count check
    }
  }

  return false;
}

/**
 * Trigger compaction for a session
 */
function triggerCompaction(
  sessionKey: string,
  agentId: string,
  tracker: SessionTracker,
): void {
  // Capture texts before resetting
  const cycleTexts = [...tracker.answerTexts];

  // Reset counter
  tracker.count = 0;
  tracker.answerTexts = [];
  tracker.estimatedChars = 0;

  // Generate cycle summary (collected, not saved to context)
  void generateAndCollectCycleSummary(cycleTexts, sessionKey);

  // Trigger compaction callback if configured
  if (config?.onCompactNeeded) {
    void config.onCompactNeeded(sessionKey, agentId).catch((err) => {
      log.error(`Failed to trigger compaction for ${sessionKey}: ${err}`);
    });
  }
}

/**
 * Record a briefing entry for an answer
 */
async function recordAnswerBriefing(
  sessionKey: string,
  agentId: string,
  answerNumber: number,
  answerText: string,
): Promise<void> {
  try {
    const compactionEvent: CompactionEvent = {
      sessionKey,
      agentId,
      timestamp: Date.now(),
      tokensBefore: 0,
      tokensAfter: 0,
      messagesCompacted: 0,
      summary: `Answer #${answerNumber}`,
    };

    // Generate a summary of the answer
    const summary = `Answer #${answerNumber}: ${answerText.slice(0, 200).trim()}${answerText.length > 200 ? "..." : ""}`;

    await recordCompaction(compactionEvent, summary, config);
    log.debug(`Recorded briefing for answer #${answerNumber} in session ${sessionKey}`);
  } catch (error) {
    log.error(`Failed to record answer briefing: ${error}`);
  }
}

/**
 * Get the current answer count for a session
 */
export function getAnswerCount(sessionKey: string): number {
  return answerCounts.get(sessionKey)?.count ?? 0;
}

/**
 * Reset the answer count for a session (fully clears tracking state)
 */
export function resetAnswerCount(sessionKey: string): void {
  const tracker = answerCounts.get(sessionKey);
  if (tracker) {
    tracker.count = 0;
    tracker.answerTexts = [];
    tracker.estimatedChars = 0;
  }
}

/**
 * Update the configuration (merges with existing config)
 */
export function updateAnswerBriefingConfig(cfg: AnswerBriefingConfig): void {
  config = config ? { ...config, ...cfg } : { ...cfg };
}

/**
 * Generate a cycle summary and collect it (NOT saved to context)
 */
async function generateAndCollectCycleSummary(
  answerTexts: string[],
  sessionKey: string,
): Promise<void> {
  if (!config?.llmConfig?.apiKey) {
    log.debug("No LLM config for cycle summary, skipping");
    return;
  }

  if (answerTexts.length === 0) {
    log.debug("No answer texts to summarize, skipping");
    return;
  }

  const model = config.llmConfig.model || "google/gemini-2.5-flash";
  const baseUrl = config.llmConfig.baseUrl || "https://openrouter.ai/api/v1";

  const prompt = `Summarize this conversation cycle into 3-5 concise bullet points. Focus on what was discussed, decisions made, and any action items.

Conversation excerpts:
${answerTexts.map((t, i) => `${i + 1}. ${t}`).join("\n")}

Provide a brief, useful summary (no more than 100 words).`;

  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.llmConfig.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 200,
        }),
      },
      LLM_API_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status}`);
    }

    const data = (await response.json()) as LLMResponse;
    const summary = extractSummaryFromResponse(data);

    // Collect for aggregation (with bounds check to prevent unbounded memory growth)
    if (cycleSummaries.length < MAX_CYCLE_SUMMARIES) {
      cycleSummaries.push(summary);
    } else {
      log.warn(`Cycle summaries limit (${MAX_CYCLE_SUMMARIES}) reached, forcing aggregation`);
      await aggregateAndSaveBriefing();
      cycleSummaries.push(summary);
    }
    cycleCount++;

    // Keep recent summaries for context continuity (last 2 cycles)
    recentSummaries.push(summary);
    if (recentSummaries.length > 2) {
      recentSummaries.shift(); // Keep only last 2
    }

    // Update RECENT_CONTEXT.md for next session
    await updateRecentContext();

    log.info(
      `Cycle #${cycleCount} summary collected (${cycleSummaries.length} total, ${recentSummaries.length} recent)`,
    );

    // Check if we should aggregate and save
    const aggregateAfter = config.aggregateAfterCycles ?? DEFAULT_AGGREGATE_AFTER_CYCLES;
    if (cycleCount >= aggregateAfter) {
      await aggregateAndSaveBriefing();
    }
  } catch (error) {
    log.error(`Failed to generate cycle summary: ${error}`);
  }
}

/** LLM API response structure */
interface LLMResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

/**
 * Extract summary from LLM response safely
 */
function extractSummaryFromResponse(data: LLMResponse): string {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  return "Cycle summary unavailable.";
}

/**
 * Fetch with timeout to prevent hanging on external API calls
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Aggregate all cycle summaries into one master briefing and save
 */
async function aggregateAndSaveBriefing(): Promise<void> {
  if (cycleSummaries.length === 0) {
    log.debug("No cycle summaries to aggregate");
    return;
  }

  if (!config?.llmConfig?.apiKey) {
    log.debug("No LLM config for aggregation, dumping raw summaries");
    await writeBriefingFile(cycleSummaries.join("\n\n"));
    cycleSummaries.length = 0;
    cycleCount = 0;
    return;
  }

  const model = config.llmConfig.model || "google/gemini-2.5-flash";
  const baseUrl = config.llmConfig.baseUrl || "https://openrouter.ai/api/v1";

  const prompt = `You are summarizing ${cycleSummaries.length} conversation cycles from today. Create ONE cohesive briefing (5-7 bullet points) that captures:

1. Main topics discussed across all cycles
2. Key decisions made
3. Important action items or follow-ups
4. Any patterns or recurring themes

Cycle summaries:
${cycleSummaries.map((s, i) => `--- Cycle ${i + 1} ---\n${s}`).join("\n")}

Create a concise master briefing (no more than 150 words). Focus on what matters.`;

  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.llmConfig.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 300,
        }),
      },
      LLM_API_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status}`);
    }

    const data = (await response.json()) as LLMResponse;
    const masterBriefing = extractSummaryFromResponse(data) || cycleSummaries.join("\n\n");

    // Write the aggregated briefing
    await writeBriefingFile(masterBriefing);

    log.info(`Aggregated briefing saved (${cycleSummaries.length} cycles → 1 briefing)`);

    // Clear collected summaries (tokens saved!)
    cycleSummaries.length = 0;
    cycleCount = 0;
  } catch (error) {
    log.error(`Failed to aggregate briefing: ${error}`);
    // Fallback: write raw summaries
    await writeBriefingFile(cycleSummaries.join("\n\n"));
    cycleSummaries.length = 0;
    cycleCount = 0;
  }
}

/**
 * Write briefing to briefings/YYYY-MM-DD.md (OUTSIDE memory/ to avoid token burn)
 */
async function writeBriefingFile(content: string): Promise<void> {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const timeStr = now.toTimeString().slice(0, 5);

  // Write to briefings/ folder (NOT memory/briefings/ - avoid auto-indexing)
  const workspacePath =
    process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || "", ".openclaw", "workspace");
  const briefingDir = path.join(workspacePath, "briefings");
  const briefingPath = path.join(briefingDir, `${dateStr}.md`);

  try {
    // Ensure directory exists
    await fs.mkdir(briefingDir, { recursive: true });

    // Append master briefing entry
    const entry = `\n## Aggregated Briefing (${timeStr})\n${content}\n`;
    await fs.appendFile(briefingPath, entry, "utf-8");

    log.debug(`Wrote aggregated briefing to ${briefingPath}`);
  } catch (error) {
    log.error(`Failed to write briefing file: ${error}`);
  }
}

/**
 * Update RECENT_CONTEXT.md with latest summaries (for continuity)
 */
async function updateRecentContext(): Promise<void> {
  if (recentSummaries.length === 0) return;

  const workspacePath =
    process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME || "", ".openclaw", "workspace");
  const contextPath = path.join(workspacePath, "RECENT_CONTEXT.md");

  const content = `# Recent Context

Last ${recentSummaries.length} conversation cycles:

${recentSummaries.map((s, i) => `## Cycle ${i + 1}\n${s}`).join("\n\n")}

---
*Auto-updated. Do not edit manually.*
`;

  try {
    await fs.writeFile(contextPath, content, "utf-8");
    log.debug(`Updated RECENT_CONTEXT.md with ${recentSummaries.length} summaries`);
  } catch (error) {
    log.error(`Failed to update RECENT_CONTEXT.md: ${error}`);
  }
}

/**
 * Force aggregation (e.g., at end of day)
 */
export async function forceAggregateBriefing(): Promise<void> {
  if (cycleSummaries.length > 0) {
    await aggregateAndSaveBriefing();
  }
}

/**
 * Get current cycle stats
 */
export function getCycleStats(): { cycleCount: number; summariesCollected: number } {
  return { cycleCount, summariesCollected: cycleSummaries.length };
}
