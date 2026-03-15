/**
 * Task Decomposition System
 *
 * Detects complex tasks and injects step-by-step instructions into the prompt
 * so that even weaker models (GLM-5) break work into manageable steps instead
 * of trying to do everything at once.
 *
 * Works by prepending a decomposition directive to the user's message before
 * it reaches the model. No changes to the model or API calls needed.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("task-decomposition");

/** Signals that suggest a task is complex and needs decomposition */
const COMPLEXITY_SIGNALS = [
  // Creation tasks
  /\b(build|create|make|develop|implement|design|set up|setup)\b.*\b(website|app|application|system|service|api|dashboard|platform|page|project)\b/i,
  // Multi-step requests
  /\b(and|then|also|plus|with|including)\b.*\b(and|then|also|plus|with|including)\b/i,
  // Large scope indicators
  /\b(full|complete|entire|whole|comprehensive|production|professional|enterprise|world.class|next.level)\b/i,
  // Multi-file work
  /\b(multiple|several|all|every|each)\s+(files?|components?|pages?|sections?|features?)\b/i,
  // Refactoring
  /\b(refactor|rewrite|migrate|convert|upgrade|overhaul|redesign)\b.*\b(codebase|project|system|app|application)\b/i,
];

/** Short/simple messages that should NOT be decomposed */
const SIMPLE_PATTERNS = [
  /^(hi|hello|hey|yo|sup|thanks|ok|yes|no|sure)\b/i,
  /^(what|how|why|when|where|who|which|is|are|do|does|can|could|will|would)\b/i, // questions
  /^(show|list|check|status|explain|describe|tell me)\b/i, // info requests
  /^(fix|debug|find|search|grep|read|open)\b/i, // single operations
  /^\//,  // slash commands
];

/**
 * Detect if a message describes a complex task that needs decomposition
 */
export function isComplexTask(message: string): boolean {
  const trimmed = message.trim();

  // Too short to be complex
  if (trimmed.length < 30) return false;

  // Simple patterns — don't decompose
  if (SIMPLE_PATTERNS.some(p => p.test(trimmed))) return false;

  // Check for complexity signals
  const matchCount = COMPLEXITY_SIGNALS.filter(p => p.test(trimmed)).length;

  // Need at least 2 signals to consider it complex
  return matchCount >= 2;
}

/**
 * Build the decomposition directive that gets prepended to the prompt
 */
export function buildDecompositionDirective(userMessage: string): string {
  return `<task-decomposition>
IMPORTANT INSTRUCTION: This is a complex task. You MUST follow this approach:

1. FIRST, write a short numbered plan (3-7 steps) of what you will do. List each step clearly.
2. THEN, execute step 1 only. Complete it fully before moving on.
3. After completing each step, state which step you just finished and what step is next.
4. Do NOT try to do everything at once. One step at a time.
5. If a step involves creating a file, finish that file completely before starting the next.
6. If you run out of space or hit a limit, stop and say which steps remain.

DO NOT skip the plan. DO NOT combine steps. Work methodically.
</task-decomposition>`;
}

/**
 * Process a user message and optionally prepend decomposition instructions.
 * Returns the modified prompt or null if no modification needed.
 */
export function applyTaskDecomposition(prompt: string): string | null {
  if (!isComplexTask(prompt)) {
    return null;
  }

  log.info(`Complex task detected, applying decomposition directive`);
  return buildDecompositionDirective(prompt);
}
