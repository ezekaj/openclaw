/**
 * Conversation Summarization
 *
 * Delta and full summarization for conversation history.
 * Extracted from Claude Code v2.1.50
 */

import type {
  ConversationMessage,
  ConversationSummary,
  SummarizationOptions,
  DeltaSummaryResult,
  FullSummaryResult,
} from "./conversation-summarizer.types.js";
import {
  DEFAULT_MAX_SUMMARY_TOKENS,
  MIN_MESSAGES_FOR_SUMMARY,
  DELTA_SUMMARY_SYSTEM_PROMPT,
  FULL_SUMMARY_SYSTEM_PROMPT,
  formatSummaryForContext,
} from "./conversation-summarizer.types.js";
import { generateText } from "ai";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Content block type for message content arrays
 */
interface ContentBlock {
  type: string;
  text?: string;
}

/**
 * Tool result content block (for large result handling)
 */
interface ToolResultBlock {
  type: "tool_result";
  text?: string;
}

/**
 * Check if a content block is a tool result block
 */
function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === "tool_result";
}

// ============================================================================
// DELTA SUMMARIZATION
// ============================================================================

/**
 * Perform delta summarization (incremental updates)
 *
 * @param existingSummary - Current summary text
 * @param newMessages - New messages to incorporate
 * @param options - Summarization options
 * @returns Updated summary with change flag
 */
export async function summarizeDelta(
  existingSummary: string,
  newMessages: ConversationMessage[],
  options: SummarizationOptions = {}
): Promise<DeltaSummaryResult> {
  // Input validation
  if (typeof existingSummary !== "string") {
    throw new TypeError("existingSummary must be a string");
  }

  if (!Array.isArray(newMessages)) {
    throw new TypeError("newMessages must be an array");
  }

  if (newMessages.length === 0) {
    return { summary: existingSummary, changed: false };
  }

  const model = options.model ?? "openai/gpt-4o-mini";
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_SUMMARY_TOKENS;

  // Format messages for summarization
  const messagesText = formatMessagesForSummary(newMessages);

  try {
    const { text } = await generateText({
      model,
      maxTokens,
      system: DELTA_SUMMARY_SYSTEM_PROMPT,
      prompt: `Current summary:\n${existingSummary}\n\nNew messages:\n${messagesText}`,
    });

    // Extract summary from tags
    const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/);
    const newSummary = summaryMatch?.[1]?.trim() ?? "";

    return {
      summary: newSummary || existingSummary,
      changed: newSummary !== existingSummary && newSummary.length > 0,
    };
  } catch (error) {
    console.error("[conversation-summarizer] Delta summarization failed:", error);
    return { summary: existingSummary, changed: false };
  }
}

// ============================================================================
// FULL SUMMARIZATION
// ============================================================================

/**
 * Perform full summarization of conversation
 *
 * @param messages - All conversation messages
 * @param options - Summarization options
 * @returns Structured summary with formatted text
 */
export async function summarizeFull(
  messages: ConversationMessage[],
  options: SummarizationOptions = {}
): Promise<FullSummaryResult | null> {
  // Input validation
  if (!Array.isArray(messages)) {
    throw new TypeError("messages must be an array");
  }

  if (messages.length < MIN_MESSAGES_FOR_SUMMARY) {
    return null;
  }

  const model = options.model ?? "openai/gpt-4o-mini";
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_SUMMARY_TOKENS;

  // Format messages for summarization
  const messagesText = formatMessagesForSummary(messages, options.includeCodeSnippets);

  try {
    const { text } = await generateText({
      model,
      maxTokens: maxTokens * 2, // Allow more tokens for analysis
      system: FULL_SUMMARY_SYSTEM_PROMPT,
      prompt: messagesText,
    });

    // Parse structured summary
    const summary = parseFullSummary(text, messages.length);
    if (!summary) {
      return null;
    }

    // Calculate token savings (use pre-calculated tokenCount from summary)
    const originalTokens = estimateTokens(messagesText);
    const tokenSavings = originalTokens - summary.tokenCount;

    return {
      summary,
      formattedText: formatSummaryForContext(summary),
      tokenSavings,
    };
  } catch (error) {
    console.error("[conversation-summarizer] Full summarization failed:", error);
    return null;
  }
}

// ============================================================================
// LARGE TOOL RESULT HANDLING
// ============================================================================

/**
 * Process large tool results by persisting to disk
 *
 * @param messages - Messages to process
 * @param threshold - Size threshold in bytes (default 100KB)
 * @returns Processed messages with large results replaced
 */
export async function processLargeToolResults(
  messages: ConversationMessage[],
  threshold: number = 100_000
): Promise<ConversationMessage[]> {
  // Input validation
  if (!Array.isArray(messages)) {
    throw new TypeError("messages must be an array");
  }

  if (typeof threshold !== "number" || threshold < 0) {
    throw new TypeError("threshold must be a non-negative number");
  }

  // Dynamic import with error handling
  let processToolResult: (content: string, threshold: number) => Promise<{ content: unknown }>;
  try {
    const module = await import("./tools/tool-result-persist.js");
    processToolResult = module.processToolResult;
  } catch (error) {
    console.error("[conversation-summarizer] Failed to load tool-result-persist module:", error);
    // Return messages unchanged if module fails to load
    return messages;
  }

  const processed: ConversationMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      // Process content blocks for large tool results
      // Use Promise.all with proper indexing to maintain order
      const processedContent = await Promise.all(
        message.content.map(async (block): Promise<ContentBlock> => {
          // Check if this is a tool result block with large text
          if (isToolResultBlock(block) && block.text && block.text.length > threshold) {
            try {
              const result = await processToolResult(block.text, threshold);
              // Return the processed content (could be string or formatted preview)
              if (typeof result.content === "string") {
                return { type: "tool_result", text: result.content };
              }
              return block;
            } catch (error) {
              console.error("[conversation-summarizer] Failed to process large tool result:", error);
              return block; // Return original on error
            }
          }
          return block;
        })
      );

      processed.push({ ...message, content: processedContent });
    } else {
      processed.push(message);
    }
  }

  return processed;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Format messages for summarization
 */
function formatMessagesForSummary(
  messages: ConversationMessage[],
  includeCodeSnippets: boolean = true
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    // Skip invalid messages
    if (!msg || typeof msg.role !== "string") {
      continue;
    }

    const role = msg.role.toUpperCase();
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? formatContentBlocks(msg.content, includeCodeSnippets)
          : "";

    parts.push(`[${role}]\n${content}\n`);
  }

  return parts.join("\n");
}

/**
 * Format content blocks
 */
function formatContentBlocks(
  blocks: ContentBlock[],
  includeCode: boolean
): string {
  if (!Array.isArray(blocks)) {
    return "";
  }

  return blocks
    .map((block) => {
      if (!block || typeof block.type !== "string") {
        return "[UNKNOWN]";
      }

      if (block.type === "text" && block.text) {
        // Optionally truncate code snippets
        if (!includeCode && block.text.includes("```")) {
          return block.text.replace(/```[\s\S]*?```/g, "[CODE SNIPPET OMITTED]");
        }
        return block.text;
      }
      return `[${block.type}]`;
    })
    .join("\n");
}

/**
 * Parse full summary from LLM output
 */
function parseFullSummary(text: string, messageCount: number): ConversationSummary | null {
  // Input validation
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }

  // Extract summary section
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/);
  if (!summaryMatch?.[1]) {
    return null;
  }

  const summaryText = summaryMatch[1];

  // Parse structured sections
  const sections = {
    primaryRequest: extractSection(summaryText, "Primary Request and Intent"),
    keyConcepts: extractListSection(summaryText, "Key Technical Concepts"),
    currentState: extractSection(summaryText, "Current State"),
    discoveries: extractListSection(summaryText, "Important Discoveries"),
    errorsAndFixes: extractErrorsAndFixes(summaryText),
    nextSteps: extractListSection(summaryText, "Next Steps"),
    userPreferences: extractListSection(summaryText, "User Preferences"),
  };

  return {
    ...sections,
    createdAt: Date.now(),
    tokenCount: estimateTokens(summaryText),
  };
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract a text section by header
 */
function extractSection(text: string, header: string): string {
  if (typeof text !== "string" || typeof header !== "string") {
    return "";
  }

  const escapedHeader = escapeRegex(header);
  const regex = new RegExp(`${escapedHeader}:?\\s*\\n([\\s\\S]*?)(?=\\n\\d+\\.|$)`, "i");
  const match = text.match(regex);
  return match?.[1]?.trim() ?? "";
}

/**
 * Extract a list section by header
 */
function extractListSection(text: string, header: string): string[] {
  if (typeof text !== "string" || typeof header !== "string") {
    return [];
  }

  const escapedHeader = escapeRegex(header);
  const regex = new RegExp(`${escapedHeader}:?\\s*\\n([\\s\\S]*?)(?=\\n\\d+\\.|$)`, "i");
  const match = text.match(regex);
  if (!match?.[1]) return [];

  return match[1]
    .split("\n")
    .filter((line) => line.trim().startsWith("-"))
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length > 0);
}

/**
 * Extract errors and fixes section
 */
function extractErrorsAndFixes(
  text: string
): Array<{ error: string; fix: string }> {
  if (typeof text !== "string") {
    return [];
  }

  const regex = new RegExp(`Errors and Fixes:?\\s*\\n([\\s\\S]*?)(?=\\n\\d+\\.|$)`, "i");
  const match = text.match(regex);
  if (!match?.[1]) return [];

  const items: Array<{ error: string; fix: string }> = [];
  const lines = match[1].split("\n");

  let currentError = "";
  let currentFix = "";

  for (const line of lines) {
    if (line.includes("- Error:")) {
      if (currentError && currentFix) {
        items.push({ error: currentError, fix: currentFix });
      }
      currentError = line.replace(/.*Error:\s*/, "").trim();
      currentFix = "";
    } else if (line.includes("Fix:")) {
      currentFix = line.replace(/.*Fix:\s*/, "").trim();
    }
  }

  if (currentError && currentFix) {
    items.push({ error: currentError, fix: currentFix });
  }

  return items;
}

/**
 * Estimate token count
 */
function estimateTokens(text: string): number {
  // Input validation
  if (typeof text !== "string") {
    return 0;
  }
  // Rough approximation: 1 token ≈ 4 characters
  return Math.ceil(text.length / 4);
}