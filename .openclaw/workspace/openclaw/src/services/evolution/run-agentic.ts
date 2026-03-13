#!/usr/bin/env bun
/**
 * Run the agentic evolution system
 *
 * Usage:
 *   bun src/services/evolution/run-agentic.ts [target-file]
 *
 * Environment:
 *   BAILIAN_API_KEY - Your Bailian API key
 *   EVOLUTION_MODEL - Model to use (default: kimi-k2.5)
 *
 * Examples:
 *   bun src/services/evolution/run-agentic.ts src/infra/event-loop-lag.ts
 *   bun src/services/evolution/run-agentic.ts --dry-run src/utils/helpers.ts
 *   bun src/services/evolution/run-agentic.ts --discover  # Auto-select a file
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgenticClient, type TaskResult } from './agentic-client.js';
import { loadEvolutionIgnore } from './evolution-guards.js';

const exec = promisify(execCallback);

const DEFAULT_GOAL = `Evolve this code to production quality. In priority order:

1. BUGS & CORRECTNESS: Fix race conditions, null derefs, off-by-one errors, unhandled promise rejections, missing error handling on async boundaries
2. TYPE SAFETY: Eliminate 'any' types, add proper generics, narrow union types, add missing return types
3. ERROR HANDLING: Add try/catch on async calls that can fail, add proper error propagation, ensure resources are cleaned up (streams, timers, listeners)
4. ROBUSTNESS: Add input validation at function boundaries, handle edge cases (empty arrays, undefined, null), add timeouts on external calls
5. DEAD CODE: Remove unused imports, unreachable branches, commented-out code, unused variables
6. SIMPLIFY: Reduce nesting depth, extract repeated logic into helpers, use early returns, clearer variable names
7. PERFORMANCE: Fix obvious N+1 loops, unnecessary allocations, redundant computations, missing caching

Make the code something you'd be proud to ship to production.`;

// Parse arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const discover = args.includes('--discover');
const daemon = args.includes('--daemon');
const verbose = args.includes('--verbose') || args.includes('-v');
const goalIdx = args.indexOf('--goal');
const customGoal = goalIdx !== -1 ? args[goalIdx + 1] : undefined;
const targetFile = args.find((a, i) => !a.startsWith('-') && i !== goalIdx + 1);

// Load .env.evolution
async function loadEnv() {
  try {
    const envPath = path.join(process.cwd(), '.env.evolution');
    const content = await fs.readFile(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=');
      if (key && value && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env.evolution file
  }
}

// History file to avoid repeating files
const HISTORY_FILE = '/tmp/evolution-history.json';
const HISTORY_SIZE = 50;

async function loadHistory(): Promise<string[]> {
  try {
    const content = await fs.readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function saveHistory(history: string[]): Promise<void> {
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history.slice(-HISTORY_SIZE)));
}

// Discover a good target file - prioritize newer files, never repeat
async function discoverFile(): Promise<string | null> {
  const workDir = process.cwd();
  const ignorePatterns = await loadEvolutionIgnore(workDir);
  const history = await loadHistory();

  try {
    // Find files sorted by modification time (newest first) - macOS compatible
    const { stdout: rawOutput } = await exec(
      'find src -name "*.ts" -not -name "*.test.ts" -not -name "*.d.ts" -type f -exec stat -f "%m %N" {} \\; | sort -rn | head -100',
      { cwd: workDir, maxBuffer: 10 * 1024 * 1024 }
    );

    // Each line is "timestamp filepath" - strip the timestamp prefix
    const files = rawOutput.trim().split('\n')
      .filter(f => f)
      .map(line => line.replace(/^\d+\s+/, ''));

    // Filter out ignored files
    const ignoreRegexes = ignorePatterns.map(pattern => {
      const regex = pattern
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\./g, '\\.');
      return new RegExp(regex);
    });

    const validFiles: Array<{ file: string; score: number }> = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Skip ignored
      if (ignoreRegexes.some(r => r.test(file))) continue;

      // Skip index files
      if (file.endsWith('index.ts')) continue;

      // Skip recently evolved files
      if (history.includes(file)) continue;

      try {
        const stat = await fs.stat(path.join(workDir, file));
        const sizeKB = stat.size / 1024;

        // Skip too large or too small
        if (sizeKB > 50 || sizeKB < 0.5) continue;

        // Score based on recency (position in sorted list)
        let score = 100 - i;
        if (sizeKB > 2 && sizeKB < 20) score += 10;

        validFiles.push({ file, score });
      } catch {
        // Skip inaccessible files
      }
    }

    if (validFiles.length === 0) {
      // Reset history so next run gets fresh picks
      console.log('All recent files covered, resetting history for next cycle...');
      await saveHistory([]);
      return null;
    }

    // Sort by score (recency) and pick randomly from top 10 newest
    validFiles.sort((a, b) => b.score - a.score);
    const top = validFiles.slice(0, 10);
    const selected = top[Math.floor(Math.random() * top.length)].file;

    // Add to history
    history.push(selected);
    await saveHistory(history);

    return selected;
  } catch {
    return null;
  }
}

/**
 * Run a single evolution cycle (discover or targeted)
 */
async function runOnce(client: ReturnType<typeof createAgenticClient>, workDir: string): Promise<TaskResult> {
  let target: string | null = targetFile || null;

  if (!target) {
    console.log('Discovering target file...');
    target = await discoverFile();
    if (!target) {
      throw new Error('Could not find a suitable file');
    }
    console.log(`Selected: ${target}\n`);
  }

  // Verify file exists
  await fs.access(path.join(workDir, target));

  console.log('Starting evolution task...\n');
  console.log('='.repeat(40));

  const result = await client.runTask({
    targetFile: target,
    goal: customGoal || DEFAULT_GOAL,
  });

  console.log('='.repeat(40));
  console.log('');
  console.log('RESULT:');
  console.log(`  Task ID:    ${result.taskId}`);
  console.log(`  Success:    ${result.success}`);
  console.log(`  Changes:    ${result.changesMade}`);
  console.log(`  Files:      ${result.filesModified.join(', ') || 'none'}`);
  console.log(`  Iterations: ${result.iterations}`);
  console.log(`  Duration:   ${(result.duration / 1000).toFixed(1)}s`);
  console.log(`  Summary:    ${result.summary}`);
  if (result.error) {
    console.log(`  Error:      ${result.error}`);
  }

  return result;
}

// Main
async function main() {
  console.log('========================================');
  console.log('   AGENTIC EVOLUTION SYSTEM');
  console.log(`   Mode: ${daemon ? 'DAEMON (continuous)' : 'single run'}`);
  console.log('========================================\n');

  // Load environment
  await loadEnv();

  const apiKey = process.env.BAILIAN_API_KEY ||
                 process.env.MOONSHOT_API_KEY ||
                 process.env.KIMI_API_KEY;

  if (!apiKey) {
    console.error('ERROR: No API key found');
    console.error('Set BAILIAN_API_KEY in .env.evolution or environment');
    process.exit(1);
  }

  const model = process.env.EVOLUTION_MODEL || 'glm-5';
  const workDir = process.cwd();
  const intervalMs = parseInt(process.env.EVOLUTION_INTERVAL_MS || '3600000', 10);

  if (!targetFile && !discover && !daemon) {
    console.log('Usage: bun src/services/evolution/run-agentic.ts [options] <target-file>');
    console.log('');
    console.log('Options:');
    console.log('  --dry-run     Show what would be done without making changes');
    console.log('  --discover    Auto-select a file to evolve');
    console.log('  --daemon      Run continuously, evolving files on interval');
    console.log('  --verbose     Show detailed logs');
    console.log('');
    console.log('Examples:');
    console.log('  bun src/services/evolution/run-agentic.ts src/infra/event-loop-lag.ts');
    console.log('  bun src/services/evolution/run-agentic.ts --discover');
    console.log('  bun src/services/evolution/run-agentic.ts --daemon');
    console.log('  bun src/services/evolution/run-agentic.ts --dry-run src/utils/helpers.ts');
    process.exit(1);
  }

  console.log(`Model:      ${model}`);
  if (targetFile) console.log(`Target:     ${targetFile}`);
  if (daemon) console.log(`Interval:   ${(intervalMs / 60000).toFixed(0)}m`);
  console.log(`Dry Run:    ${dryRun}`);
  console.log(`Verbose:    ${verbose}`);
  console.log('');

  // Create client
  const client = createAgenticClient({
    apiKey,
    model,
    workDir,
    verbose,
    dryRun,
  });

  // Test connection
  console.log('Testing API connection...');
  const connected = await client.testConnection();
  if (!connected) {
    console.error('ERROR: Failed to connect to AI provider');
    process.exit(1);
  }
  console.log('Connected!\n');

  // Show available tools
  const tools = client.getTools();
  console.log(`Available tools (${tools.length}):`);
  for (const tool of tools) {
    console.log(`  - ${tool.function.name}: ${tool.function.description.substring(0, 50)}...`);
  }
  console.log('');

  if (!daemon) {
    // Single run
    const result = await runOnce(client, workDir);
    process.exit(result.success ? 0 : 1);
  }

  // === DAEMON MODE ===
  console.log(`Evolution daemon started. Will evolve a file every ${(intervalMs / 60000).toFixed(0)} minutes.`);
  console.log('Press Ctrl+C to stop.\n');

  let cycle = 0;
  let totalChanges = 0;
  const stats = { success: 0, failed: 0 };

  // Run immediately, then on interval
  while (true) {
    cycle++;
    const cycleTime = new Date().toLocaleTimeString();
    console.log(`\n${'#'.repeat(50)}`);
    console.log(`# CYCLE ${cycle} — ${cycleTime}`);
    console.log(`# Stats: ${stats.success} successful, ${stats.failed} failed, ${totalChanges} total changes`);
    console.log(`${'#'.repeat(50)}\n`);

    try {
      const result = await runOnce(client, workDir);
      if (result.success) {
        stats.success++;
        totalChanges += result.changesMade;
      } else {
        stats.failed++;
      }
    } catch (err) {
      stats.failed++;
      console.error(`Cycle ${cycle} error:`, err instanceof Error ? err.message : err);
    }

    // Wait for next cycle
    const nextRun = new Date(Date.now() + intervalMs).toLocaleTimeString();
    console.log(`\nNext evolution cycle at ${nextRun} (${(intervalMs / 60000).toFixed(0)}m)\n`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
