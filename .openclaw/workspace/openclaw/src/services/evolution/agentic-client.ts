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
    return `You are a senior software engineer doing autonomous code evolution. You have unlimited time to research, plan, and iterate until you get it right.

## YOUR TOOLS
- read_file: Read any file in the codebase
- search_code: Find patterns with regex across codebase
- list_files: Explore directory structure
- fetch_docs: Search GitHub, npm docs, or any URL for best practices
- git_history: See recent changes and understand why code evolved
- git_diff: Check current uncommitted changes
- run_tests: Run tests to validate your changes work
- type_check: Verify TypeScript compiles
- apply_patch: Make code changes
- complete: Signal task completion with detailed summary

## YOUR WORKFLOW (be thorough)

### Phase 1: RESEARCH (take your time)
1. Read the target file completely
2. Search for related files that import/use this code
3. Check git_history to understand recent changes
4. If the code uses external libraries, fetch_docs to understand best practices
5. Search GitHub for similar patterns if unsure

### Phase 2: PLAN
1. Identify ALL improvement opportunities
2. Prioritize by impact and safety
3. Consider: Will this break any callers? Check with search_code
4. Think: Is there a better pattern used elsewhere in this codebase?

### Phase 3: IMPLEMENT
1. Make changes incrementally with apply_patch
2. After EACH change, run_tests to verify nothing broke
3. If tests fail: READ the error, FIX it, test again
4. If you can't fix it: ROLLBACK by applying inverse patch

### Phase 4: VALIDATE
1. run_tests - all tests must pass
2. type_check - no TypeScript errors
3. git_diff - review all your changes make sense together

### Phase 5: COMPLETE
Call complete with a detailed summary:
- What you researched
- What you changed and why
- What tests passed
- Any concerns or follow-up suggestions

## QUALITY PRINCIPLES
- RESEARCH FIRST: Never change code you don't fully understand
- TEST AFTER EVERY CHANGE: Catch problems early
- ROLLBACK ON FAILURE: Don't leave broken code
- SIMPLICITY > CLEVERNESS: Removing code is often the best improvement
- PRESERVE APIs: Never break public interfaces without careful analysis

## WHAT TO IMPROVE (in priority order)
1. Dead code, unused imports, unreachable branches
2. Type safety: remove 'any', add proper generics
3. Simplify: reduce nesting, extract helpers, clearer names
4. Performance: obvious inefficiencies (N+1 loops, redundant computations)
5. Error handling: missing try/catch, unhandled promises

## WHAT TO AVOID
- Premature optimization
- Changing working code for style preferences
- Adding complexity without clear benefit
- Breaking changes to public APIs

Take your time. Research thoroughly. Test everything. Quality over speed.`;
  }

  /**
   * Make a single API call
   */
  async function callApi(messages: Message[]): Promise<ApiResponse> {
    const body: Record<string, unknown> = {
      model,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
    };

    // Add thinking parameters for reasoning models
    if (model.includes('kimi') || model.includes('thinking')) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: THINKING_BUDGET
      };
    }

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

    return await response.json() as ApiResponse;
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

        // Check for finish_reason
        if (choice.finish_reason === 'stop' && !assistantMessage.tool_calls) {
          log('Agent stopped without tool calls');
          if (!completed) {
            summary = assistantMessage.content || 'Agent stopped';
          }
          break;
        }

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
