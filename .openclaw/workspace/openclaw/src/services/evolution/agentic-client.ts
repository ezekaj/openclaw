/**
 * Agentic Evolution Client
 *
 * A fully autonomous code evolution agent powered by Kimi K2.5 with tool calling.
 * This agent can:
 * - Read and search the codebase
 * - Fetch documentation from the web
 * - Run tests to validate changes
 * - Apply patches with automatic rollback
 * - Learn from failures and iterate
 *
 * The agent runs in an autonomous loop until it completes its task or hits limits.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  getEvolutionTools,
  executeTool,
  createToolContext,
  type ToolDefinition,
  type ToolCall,
  type Message,
  type ToolContext
} from './evolution-tools.js';

// Bailian API endpoint (supports Kimi, Qwen, GLM, etc.)
const BAILIAN_BASE_URL = 'https://coding-intl.dashscope.aliyuncs.com/v1';

// Agent configuration
const MAX_ITERATIONS = 100;      // Allow deep exploration
const MAX_PATCHES_WITHOUT_TEST = 3; // Must test after 3 patches
const MAX_TOKENS = 16384;        // Max response tokens
const TEMPERATURE = 0.3;         // Balance precision/creativity
const THINKING_BUDGET = 8192;    // For reasoning models
const MAX_NUDGES = 3;            // Max times to nudge model to use tools

export interface AgentConfig {
  apiKey: string;
  model: string;
  workDir: string;
  verbose?: boolean;
  dryRun?: boolean;
  maxIterations?: number;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  summary: string;
  changesMade: number;
  filesModified: string[];
  iterations: number;
  duration: number;
  error?: string;
}

interface ApiResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Create an agentic evolution client
 */
export function createAgenticClient(config: AgentConfig) {
  const {
    apiKey,
    model,
    workDir,
    verbose = false,
    dryRun = false,
    maxIterations = MAX_ITERATIONS
  } = config;

  // Tool definitions
  const tools = getEvolutionTools();

  // Tool execution context
  const toolContext = createToolContext(workDir);

  // Logging
  const log = (msg: string, ...args: unknown[]) => {
    if (verbose) {
      console.log(`[Agent] ${msg}`, ...args);
    }
  };

  const logAlways = (msg: string, ...args: unknown[]) => {
    console.log(`[Agent] ${msg}`, ...args);
  };

  /**
   * Build the system prompt for the evolution agent
   */
  function buildSystemPrompt(): string {
    return `You are a principal-level software engineer doing autonomous code evolution. Your job is to take code from "it works" to "it's production-grade". You have unlimited time to research, plan, and iterate until you get it right.

## YOUR TOOLS
- read_file: Read any file in the codebase
- search_code: Find patterns with regex across codebase
- list_files: Explore directory structure
- write_file: Create new files (tests, helpers, modules)
- fetch_docs: Look up API docs, npm packages, or best practices
- web_search: Search GitHub, StackOverflow for patterns and solutions
- git_history: See recent changes and understand why code evolved
- git_diff: Check current uncommitted changes
- run_tests: Run tests to validate your changes work
- type_check: Verify TypeScript compiles
- apply_patch: Make code changes (search/replace)
- compare_files: Diff two files to understand differences
- complete: Signal task completion with detailed summary

## YOUR WORKFLOW

### Phase 1: DEEP RESEARCH
1. Read the target file completely — understand every function
2. search_code for every exported function/type to find ALL callers
3. Read the callers — understand how this code is actually used
4. Check git_history — understand why the code looks the way it does
5. list_files in the same directory — understand the module structure
6. If external APIs are used, fetch_docs to verify correct usage

### Phase 2: DIAGNOSE
For each function/section, ask:
- Can this crash? (null deref, missing await, unhandled rejection)
- Can this lose data? (missing error handling, silent failures)
- Is the typing honest? (any, unknown, missing generics, wrong return types)
- Is there dead code? (unused imports, unreachable branches, stale comments)
- Is this harder to read than it needs to be? (deep nesting, unclear names, god functions)
- Is there an obvious performance issue? (N+1, re-creating objects in loops, missing caching)

### Phase 3: FIX (most important changes first)
1. Fix actual bugs and crash risks FIRST
2. Add missing error handling on async boundaries
3. Fix type safety issues (eliminate 'any', add generics)
4. Remove dead code and simplify
5. Extract helpers for repeated patterns
6. Improve naming where it helps comprehension

### Phase 4: VALIDATE EVERY CHANGE
- After EACH apply_patch: run_tests to catch regressions immediately
- If tests fail: READ the error output carefully, understand why, fix it
- If you can't fix a test failure: ROLLBACK (apply inverse patch)
- After all patches: type_check the whole project
- After all patches: git_diff to review the complete changeset

### Phase 5: COMPLETE
Call complete with:
- What you found (bugs, issues, risks)
- What you fixed and why each change matters
- What tests verified
- Anything you noticed but chose not to change (and why)

## PRINCIPLES
- FIX REAL PROBLEMS: Bugs > missing error handling > bad types > dead code > style
- UNDERSTAND BEFORE CHANGING: Read callers. Read tests. Read git history. Then change.
- EVERY CHANGE MUST BE SAFE: If search_code shows callers depend on behavior, don't change it
- TEST CONSTANTLY: run_tests after every patch. Never batch multiple risky changes.
- ROLLBACK ON FAILURE: A broken codebase is worse than an unimproved one
- LESS IS MORE: Deleting 50 lines of dead code is worth more than adding 50 lines of "improvements"
- PRESERVE PUBLIC APIs: Never change function signatures that callers depend on without updating all callers

## WHAT NOT TO DO
- Don't add JSDoc/comments to obvious code
- Don't rename things just for style preferences
- Don't add abstractions for one-time operations
- Don't wrap things in try/catch if the caller already handles errors
- Don't add validation for impossible states
- Don't refactor working code just because you'd write it differently

You are not here to make code look different. You are here to make code work better, fail less, and be easier to maintain. Every change should have a clear reason.`;
  }

  /**
   * Make a single API call
   */
  async function callApi(messages: Message[]): Promise<ApiResponse> {
    const body: Record<string, unknown> = {
      model,
      messages,
      tools,
      tool_choice: 'required',
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
    };

    // Thinking disabled - interferes with tool calling on Bailian

    const response = await fetch(`${BAILIAN_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API error (${response.status}): ${error}`);
    }

    const json = await response.json() as ApiResponse;

    // Always log key info about the response
    const msg = json.choices?.[0]?.message;
    const toolCount = msg?.tool_calls?.length ?? 0;
    const hasContent = !!msg?.content;
    const finishReason = json.choices?.[0]?.finish_reason;
    console.log(`[API] finish=${finishReason} tools=${toolCount} hasContent=${hasContent} tokens=${json.usage?.total_tokens ?? '?'}`);
    if (verbose && msg) {
      console.log('[API Raw]', JSON.stringify(msg, null, 2)?.slice(0, 800));
    }
    return json;
  }

  /**
   * Run a single evolution task
   */
  async function runTask(task: {
    targetFile: string;
    goal?: string;
    context?: string;
  }): Promise<TaskResult> {
    const taskId = randomUUID().substring(0, 8);
    const startTime = Date.now();

    logAlways(`Starting task ${taskId}`);
    logAlways(`Target: ${task.targetFile}`);
    logAlways(`Model: ${model}`);

    // Initialize message history
    const messages: Message[] = [
      { role: 'system', content: buildSystemPrompt() },
      {
        role: 'user',
        content: `## TASK
Analyze and improve this file: ${task.targetFile}

${task.goal ? `## GOAL\n${task.goal}\n` : ''}
${task.context ? `## CONTEXT\n${task.context}\n` : ''}

Start by reading the file, then explore related code if needed, and make improvements. Call 'complete' when done.`
      }
    ];

    let iterations = 0;
    let changesMade = 0;
    let patchesSinceLastTest = 0;
    const filesModified: Set<string> = new Set();
    let completed = false;
    let summary = '';
    let error: string | undefined;
    let nudgeCount = 0; // Track how many times we nudged the model to use tools

    // Main agent loop
    while (iterations < maxIterations && !completed) {
      iterations++;
      log(`\n--- Iteration ${iterations} ---`);

      try {
        // Call the API
        const response = await callApi(messages);
        const choice = response.choices[0];
        const assistantMessage = choice.message;

        // Add assistant message to history
        messages.push({
          role: 'assistant',
          content: assistantMessage.content,
          tool_calls: assistantMessage.tool_calls
        });

        // Handle text response
        if (assistantMessage.content) {
          log(`Assistant: ${assistantMessage.content.substring(0, 200)}...`);
        }

        // Handle tool calls
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
          const toolNames = assistantMessage.tool_calls.map(tc => tc.function.name).join(', ');
          logAlways(`Iteration ${iterations}: ${toolNames}`);

          for (const toolCall of assistantMessage.tool_calls) {
            const toolName = toolCall.function.name;
            log(`Tool: ${toolName}`);

            // Check for completion
            if (toolName === 'complete') {
              try {
                const args = JSON.parse(toolCall.function.arguments);
                summary = args.summary || 'Task completed';
                changesMade = args.changes_made || 0;
                if (args.files_modified) {
                  args.files_modified.split(',').forEach((f: string) =>
                    filesModified.add(f.trim())
                  );
                }
              } catch {
                summary = 'Task completed';
              }
              completed = true;
              break;
            }

            // Check for apply_patch to track changes
            if (toolName === 'apply_patch') {
              try {
                const args = JSON.parse(toolCall.function.arguments);
                filesModified.add(args.file);
              } catch {
                // Ignore parse errors
              }
            }

            // Execute the tool (skip if dry run for modifications)
            let result: string;
            if (dryRun && (toolName === 'apply_patch')) {
              result = JSON.stringify({
                success: true,
                dry_run: true,
                message: 'Would apply patch (dry run mode)'
              });
              logAlways(`[DRY RUN] Would execute: ${toolName}`);
            } else {
              result = await executeTool(toolCall, toolContext);
            }

            log(`Result: ${result.substring(0, 200)}...`);

            // Track patches and enforce test-after-patch rule
            if (toolName === 'apply_patch') {
              changesMade++;
              patchesSinceLastTest++;

              // Warn if too many patches without testing
              if (patchesSinceLastTest >= MAX_PATCHES_WITHOUT_TEST) {
                log(`Warning: ${patchesSinceLastTest} patches without testing`);
                // Add a hint to the tool result
                result = JSON.stringify({
                  ...JSON.parse(result),
                  warning: `You've made ${patchesSinceLastTest} patches without running tests. Please run run_tests to validate your changes before continuing.`
                });
              }
            }

            // Reset counter when tests run
            if (toolName === 'run_tests') {
              patchesSinceLastTest = 0;
            }

            // Add tool result to messages
            messages.push({
              role: 'tool',
              content: result,
              tool_call_id: toolCall.id
            });
          }
        }

        // Handle model returning text without tool calls
        if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
          nudgeCount++;
          logAlways(`Model returned text without tool calls (nudge ${nudgeCount}/${MAX_NUDGES})`);
          if (verbose && assistantMessage.content) {
            logAlways(`Model said: ${assistantMessage.content.substring(0, 300)}`);
          }

          if (nudgeCount >= MAX_NUDGES) {
            logAlways('Max nudges reached, stopping');
            if (!completed) {
              summary = assistantMessage.content || 'Agent stopped (model refused to use tools)';
            }
            break;
          }

          // Nudge the model to use tools
          messages.push({
            role: 'user',
            content: `You MUST use your tools to complete this task. Do NOT respond with just text. Start by calling read_file to read the target file: ${task.targetFile}`
          });
          continue;
        }

        // Reset nudge counter on successful tool use
        nudgeCount = 0;

      } catch (err) {
        error = err instanceof Error ? err.message : 'Unknown error';
        logAlways(`Error in iteration ${iterations}: ${error}`);
        break;
      }
    }

    const duration = Date.now() - startTime;

    // Final result
    const result: TaskResult = {
      taskId,
      success: completed && !error && (changesMade > 0 || dryRun),
      summary: summary || (changesMade > 0 ? `Applied ${changesMade} patches` : 'No changes made'),
      changesMade,
      filesModified: Array.from(filesModified),
      iterations,
      duration,
      error
    };

    logAlways(`Task ${taskId} completed`);
    logAlways(`  Success: ${result.success}`);
    logAlways(`  Changes: ${result.changesMade}`);
    logAlways(`  Files: ${result.filesModified.join(', ') || 'none'}`);
    logAlways(`  Duration: ${(duration / 1000).toFixed(1)}s`);
    logAlways(`  Iterations: ${iterations}`);

    // Log to evolution-log.jsonl
    await logResult(result);

    return result;
  }

  /**
   * Run multiple tasks in sequence
   */
  async function runTasks(tasks: Array<{
    targetFile: string;
    goal?: string;
    context?: string;
  }>): Promise<TaskResult[]> {
    const results: TaskResult[] = [];

    for (const task of tasks) {
      const result = await runTask(task);
      results.push(result);

      // Log to file
      await logResult(result);

      // Small delay between tasks
      await sleep(1000);
    }

    return results;
  }

  /**
   * Log result to evolution-log.jsonl
   */
  async function logResult(result: TaskResult): Promise<void> {
    const logPath = path.join(workDir, 'evolution-log.jsonl');
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...result
    }) + '\n';

    await fs.appendFile(logPath, entry).catch(() => {});
  }

  /**
   * Test API connection with a simple chat request
   */
  async function testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${BAILIAN_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 5
        })
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  return {
    runTask,
    runTasks,
    testConnection,
    getTools: () => tools,
  };
}

/**
 * Quick start helper - run a single file evolution
 */
export async function evolveFile(
  targetFile: string,
  options?: {
    goal?: string;
    model?: string;
    verbose?: boolean;
    dryRun?: boolean;
  }
): Promise<TaskResult> {
  const apiKey = process.env.BAILIAN_API_KEY ||
                 process.env.MOONSHOT_API_KEY ||
                 process.env.KIMI_API_KEY;

  if (!apiKey) {
    throw new Error('No API key found. Set BAILIAN_API_KEY in environment');
  }

  const client = createAgenticClient({
    apiKey,
    model: options?.model || process.env.EVOLUTION_MODEL || 'kimi-k2.5',
    workDir: process.cwd(),
    verbose: options?.verbose ?? true,
    dryRun: options?.dryRun ?? false,
  });

  // Test connection
  const connected = await client.testConnection();
  if (!connected) {
    throw new Error('Failed to connect to AI provider');
  }

  return client.runTask({
    targetFile,
    goal: options?.goal || 'Improve code quality',
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
