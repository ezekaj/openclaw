/**
 * Compaction Briefing System
 *
 * Tracks compaction events and generates daily briefings that agents can read.
 * Design: Generate summaries incrementally, agent just reads pre-built briefing (saves tokens).
 *
 * Flow:
 * 1. After each compaction, generate a short summary using LLM
 * 2. Store summary in daily briefing file
 * 3. Agent reads briefing file directly - no LLM needed to consume
 */

import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { isVerbose } from "../globals.js";

const log = createSubsystemLogger("compaction-briefing");

/** Default timeout for external API calls (10 seconds) */
const API_TIMEOUT_MS = 10_000;

/** Maximum days allowed for recent briefings query */
const MAX_DAYS_QUERY = 365;

/** Compaction event data to summarize */
export interface CompactionEvent {
  sessionKey: string;
  agentId: string;
  timestamp: number;
  tokensBefore: number;
  tokensAfter: number;
  messagesCompacted: number;
  /** Key topics/themes from compacted content */
  topics?: string[];
  /** Summary of what was discussed */
  summary?: string;
}

/** Daily briefing structure */
export interface DailyBriefing {
  date: string; // YYYY-MM-DD
  generatedAt: number;
  totalCompactions: number;
  totalTokensSaved: number;
  sessions: Array<{
    sessionKey: string;
    agentId: string;
    compactionCount: number;
    summary: string;
  }>;
  /** Combined narrative briefing for the day */
  narrative: string;
}

/** Configuration for the briefing system */
export interface CompactionBriefingConfig {
  /** Base directory for briefings (default: ~/.openclaw/briefings) */
  briefingsDir?: string;
  /** API key for generating summaries */
  apiKey?: string;
  /** Model to use (default: glm-5) */
  model?: string;
  /** Base URL for the completions API */
  baseUrl?: string;
  /** Max tokens for summary generation */
  maxTokens?: number;
}

const DEFAULT_BRIEFINGS_DIR = "~/.openclaw/briefings";
const DEFAULT_MODEL = "glm-5";
const DEFAULT_MAX_TOKENS = 200;

/** 
 * File locks to prevent race conditions when multiple compactions happen concurrently.
 * Maps date string to a promise that resolves when the lock is released.
 */
const briefingLocks = new Map<string, Promise<void>>();

/**
 * Acquire a lock for a specific briefing date, execute the operation, then release.
 * This prevents race conditions when multiple compactions write to the same file.
 */
async function withBriefingLock<T>(date: string, operation: () => Promise<T>): Promise<T> {
  // Wait for any existing lock to be released
  const existingLock = briefingLocks.get(date);
  if (existingLock) {
    await existingLock;
  }

  // Create a new lock
  let releaseLock: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  briefingLocks.set(date, lockPromise);

  try {
    return await operation();
  } finally {
    // Release the lock
    releaseLock!();
    // Only delete if our lock is still the current one
    if (briefingLocks.get(date) === lockPromise) {
      briefingLocks.delete(date);
    }
  }
}

/** OpenRouter API response structure */
interface OpenRouterResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

/**
 * Get the briefings directory path
 */
function getBriefingsDir(config?: CompactionBriefingConfig): string {
  const dir = config?.briefingsDir || DEFAULT_BRIEFINGS_DIR;
  return resolveUserPath(dir);
}

/**
 * Get today's date string in YYYY-MM-DD format
 */
function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Get the path for a daily briefing file
 */
function getDailyBriefingPath(config?: CompactionBriefingConfig, date?: string): string {
  const dir = getBriefingsDir(config);
  const dateStr = date || getTodayDate();
  return path.join(dir, `briefing-${dateStr}.json`);
}

/**
 * Ensure the briefings directory exists
 * Uses recursive mkdir which is atomic and handles race conditions
 */
function ensureBriefingsDir(config?: CompactionBriefingConfig): void {
  const dir = getBriefingsDir(config);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    // Ignore EEXIST error (directory already exists from race condition)
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

/**
 * Load today's briefing (or create empty one)
 */
export function loadDailyBriefing(config?: CompactionBriefingConfig, date?: string): DailyBriefing {
  const briefingPath = getDailyBriefingPath(config, date);
  const dateStr = date || getTodayDate();

  if (fs.existsSync(briefingPath)) {
    try {
      const content = fs.readFileSync(briefingPath, "utf-8");
      return JSON.parse(content) as DailyBriefing;
    } catch (error) {
      log.warn(`Failed to load briefing: ${error}`);
    }
  }

  // Return fresh briefing for today
  return {
    date: dateStr,
    generatedAt: Date.now(),
    totalCompactions: 0,
    totalTokensSaved: 0,
    sessions: [],
    narrative: `Daily Briefing - ${dateStr}\nNo compactions yet. Briefing will update after first compaction (every 7 answers).`,
  };
}

/**
 * Save the daily briefing
 */
function saveDailyBriefing(briefing: DailyBriefing, config?: CompactionBriefingConfig): void {
  ensureBriefingsDir(config);
  const briefingPath = getDailyBriefingPath(config, briefing.date);

  try {
    fs.writeFileSync(briefingPath, JSON.stringify(briefing, null, 2));
    if (isVerbose()) {
      log.info(`Saved daily briefing: ${briefingPath}`);
    }
  } catch (error) {
    log.error(`Failed to save briefing: ${error}`);
  }
}

/**
 * Generate a summary for compacted content using LLM
 */
async function generateCompactionSummary(
  compactedContent: string,
  config?: CompactionBriefingConfig,
): Promise<string> {
  const apiKey = config?.apiKey;
  if (!apiKey) {
    // Fallback: extract key phrases without LLM
    return extractKeyPhrases(compactedContent);
  }

  const model = config?.model || DEFAULT_MODEL;
  const maxTokens = config?.maxTokens || DEFAULT_MAX_TOKENS;
  const baseUrl = config?.baseUrl || "https://openrouter.ai/api/v1";

  const prompt = `Summarize this conversation in 1-2 sentences. Focus on key topics, decisions, and outcomes:

${compactedContent.slice(0, 2000)}

Summary:`;

  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
        }),
      },
      API_TIMEOUT_MS,
    );

    if (!response.ok) {
      throw new Error(`Compaction LLM API error: ${response.status}`);
    }

    const data = (await response.json()) as OpenRouterResponse;

    // Check for API error response
    if (data.error) {
      throw new Error(`Compaction LLM API error: ${data.error.message || data.error.type || "unknown"}`);
    }

    const content = data.choices?.[0]?.message?.content?.trim();
    return content || extractKeyPhrases(compactedContent);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.warn(`LLM summary failed, using fallback: ${errorMessage}`);
    return extractKeyPhrases(compactedContent);
  }
}

/**
 * Extract key phrases without LLM (fallback)
 */
function extractKeyPhrases(content: string): string {
  // Simple extraction: get first meaningful sentences
  const lines = content.split("\n").filter((line) => line.trim().length > 20);
  const sample = lines.slice(0, 3).join(" ");

  if (sample.length > 200) {
    return sample.slice(0, 200) + "...";
  }
  return sample || "Session conversation compacted.";
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
 * Generate the daily narrative from all session summaries
 */
function generateDailyNarrative(briefing: DailyBriefing): string {
  if (briefing.sessions.length === 0) {
    return "No compactions today.";
  }

  const parts: string[] = [];

  // Header
  parts.push(`Daily Briefing - ${briefing.date}`);
  parts.push(
    `${briefing.totalCompactions} compaction(s), ${briefing.totalTokensSaved.toLocaleString()} tokens saved\n`,
  );

  // Session summaries
  for (const session of briefing.sessions) {
    parts.push(`[${session.agentId}] ${session.summary}`);
  }

  return parts.join("\n");
}

/**
 * Record a compaction event and update the daily briefing
 */
export async function recordCompaction(
  event: CompactionEvent,
  compactedContent: string,
  config?: CompactionBriefingConfig,
): Promise<void> {
  // Input validation
  if (!event.sessionKey || !event.agentId) {
    log.warn("recordCompaction called with missing sessionKey or agentId, skipping");
    return;
  }

  if (typeof event.timestamp !== "number" || event.timestamp <= 0) {
    event.timestamp = Date.now();
  }

  if (event.tokensBefore < 0 || event.tokensAfter < 0) {
    log.warn(`Invalid token counts: before=${event.tokensBefore}, after=${event.tokensAfter}`);
    event.tokensBefore = Math.max(0, event.tokensBefore);
    event.tokensAfter = Math.max(0, event.tokensAfter);
  }

  // Generate summary for this compaction (can be done outside the lock)
  const summary = event.summary || (await generateCompactionSummary(compactedContent, config));

  // Use file lock to prevent race conditions when multiple compactions happen concurrently
  const dateStr = getTodayDate();
  await withBriefingLock(dateStr, async () => {
    const briefing = loadDailyBriefing(config);

    // Find or create session entry
    let sessionEntry = briefing.sessions.find(
      (s) => s.sessionKey === event.sessionKey && s.agentId === event.agentId,
    );

    if (!sessionEntry) {
      sessionEntry = {
        sessionKey: event.sessionKey,
        agentId: event.agentId,
        compactionCount: 0,
        summary: "",
      };
      briefing.sessions.push(sessionEntry);
    }

    // Update session entry
    sessionEntry.compactionCount += 1;
    sessionEntry.summary = summary; // Latest summary replaces previous

    // Update totals
    briefing.totalCompactions += 1;

    // Only count token savings if we have actual token data
    // Answer-based compactions (every 13 answers) have tokensBefore=0 and tokensAfter=0
    // Token-based compactions (overflow) have real token counts
    if (event.tokensBefore > 0 || event.tokensAfter > 0) {
      const tokensSaved = event.tokensBefore - event.tokensAfter;
      briefing.totalTokensSaved += tokensSaved;
      log.debug(
        `Added token savings: ${tokensSaved} (before: ${event.tokensBefore}, after: ${event.tokensAfter})`,
      );
    } else {
      log.debug(`Skipping token calculation for compaction without token data`);
    }

    briefing.generatedAt = Date.now();

    // Regenerate narrative
    briefing.narrative = generateDailyNarrative(briefing);

    // Save
    saveDailyBriefing(briefing, config);

    if (isVerbose()) {
      log.info(`Recorded compaction for ${event.agentId}: ${summary.slice(0, 50)}...`);
    }
  });

  // HYBRID INTEGRATION: Emit event for neuro-memory storage
  // This allows briefing summaries to be stored in ChromaDB for similarity-based retrieval
  // Note: This is done outside the lock to avoid blocking other compactions
  try {
    const { tryGetEventMesh } = await import("./event-mesh.js");
    const eventMesh = tryGetEventMesh();

    if (eventMesh) {
      eventMesh.emit({
        type: "compaction_summary",
        source: "compaction-briefing",
        data: {
          sessionKey: event.sessionKey,
          agentId: event.agentId,
          summary: summary,
          topics: event.topics || [],
          tokensSaved: event.tokensBefore > 0 ? event.tokensBefore - event.tokensAfter : 0,
          messagesCompacted: event.messagesCompacted,
          timestamp: Date.now(),
        },
      });
      log.debug(`Emitted compaction_summary event for neuro-memory`);
    }
  } catch (error) {
    // Non-critical: briefing was already saved to JSON
    log.debug(`Failed to emit compaction_summary event: ${error}`);
  }
}

/**
 * Get the daily briefing narrative for agent consumption
 * This is what the agent reads - pre-generated, no LLM needed
 */
export function getDailyBriefingText(config?: CompactionBriefingConfig, date?: string): string {
  const briefing = loadDailyBriefing(config, date);
  return briefing.narrative || "No briefing available for today.";
}

/**
 * Get recent briefings (last N days)
 */
export function getRecentBriefings(
  days: number = 7,
  config?: CompactionBriefingConfig,
): DailyBriefing[] {
  // Validate and clamp days parameter
  const validatedDays = Math.max(1, Math.min(days, MAX_DAYS_QUERY));

  const briefings: DailyBriefing[] = [];
  const today = new Date();

  for (let i = 0; i < validatedDays; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0];

    const briefing = loadDailyBriefing(config, dateStr);
    if (briefing.totalCompactions > 0) {
      briefings.push(briefing);
    }
  }

  return briefings;
}

/**
 * Get a combined narrative for recent days
 */
export function getRecentBriefingsText(
  days: number = 3,
  config?: CompactionBriefingConfig,
): string {
  // Validate and clamp days parameter
  const validatedDays = Math.max(1, Math.min(days, MAX_DAYS_QUERY));
  const briefings = getRecentBriefings(validatedDays, config);

  if (briefings.length === 0) {
    return "No recent activity to report.";
  }

  return briefings
    .map((b) => b.narrative)
    .filter((n) => n)
    .join("\n\n---\n\n");
}

/**
 * Clean up old briefings (older than N days)
 */
export function cleanupOldBriefings(
  daysToKeep: number = 30,
  config?: CompactionBriefingConfig,
): number {
  // Validate daysToKeep - must be positive, max 365 days
  const validatedDaysToKeep = Math.max(1, Math.min(daysToKeep, MAX_DAYS_QUERY));

  const dir = getBriefingsDir(config);
  if (!fs.existsSync(dir)) {
    return 0;
  }

  const cutoff = Date.now() - validatedDaysToKeep * 24 * 60 * 60 * 1000;
  let deleted = 0;

  try {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      if (!file.startsWith("briefing-") || !file.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    }

    if (deleted > 0) {
      log.info(`Cleaned up ${deleted} old briefing files`);
    }
  } catch (error) {
    log.warn(`Failed to cleanup old briefings: ${error}`);
  }

  return deleted;
}
