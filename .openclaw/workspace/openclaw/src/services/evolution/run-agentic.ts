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

// Parse arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const discover = args.includes('--discover');
const verbose = args.includes('--verbose') || args.includes('-v');
const targetFile = args.find(a => !a.startsWith('-'));

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

// Discover a good target file
async function discoverFile(): Promise<string | null> {
  const workDir = process.cwd();
  const ignorePatterns = await loadEvolutionIgnore(workDir);

  try {
    const { stdout } = await exec(
      'find src -name "*.ts" -not -name "*.test.ts" -not -name "*.d.ts" | head -200',
      { cwd: workDir, maxBuffer: 10 * 1024 * 1024 }
    );

    const files = stdout.trim().split('\n').filter(f => f);

    // Filter out ignored files
    const ignoreRegexes = ignorePatterns.map(pattern => {
      const regex = pattern
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\./g, '\\.');
      return new RegExp(regex);
    });

    const validFiles: Array<{ file: string; score: number }> = [];

    for (const file of files) {
      // Skip ignored
      if (ignoreRegexes.some(r => r.test(file))) continue;

      // Skip index files
      if (file.endsWith('index.ts')) continue;

      try {
        const stat = await fs.stat(path.join(workDir, file));
        const sizeKB = stat.size / 1024;

        // Skip too large or too small
        if (sizeKB > 50 || sizeKB < 0.5) continue;

        // Score based on factors
        let score = 50;
        if (sizeKB > 2 && sizeKB < 20) score += 20; // Medium size
        if (file.includes('/infra/')) score += 15;   // Prefer infra
        if (file.includes('/utils/')) score += 10;   // Prefer utils

        validFiles.push({ file, score });
      } catch {
        // Skip inaccessible files
      }
    }

    if (validFiles.length === 0) return null;

    // Sort by score and pick randomly from top 10
    validFiles.sort((a, b) => b.score - a.score);
    const top = validFiles.slice(0, 10);
    return top[Math.floor(Math.random() * top.length)].file;
  } catch {
    return null;
  }
}

// Main
async function main() {
  console.log('========================================');
  console.log('   AGENTIC EVOLUTION SYSTEM');
  console.log('   Powered by Kimi K2.5 + Tool Calling');
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

  const model = process.env.EVOLUTION_MODEL || 'kimi-k2.5';
  const workDir = process.cwd();

  // Determine target file
  let target: string | null = targetFile || null;

  if (!target && discover) {
    console.log('Discovering target file...');
    target = await discoverFile();
    if (!target) {
      console.error('ERROR: Could not find a suitable file');
      process.exit(1);
    }
    console.log(`Selected: ${target}\n`);
  }

  if (!target) {
    console.log('Usage: bun src/services/evolution/run-agentic.ts [options] <target-file>');
    console.log('');
    console.log('Options:');
    console.log('  --dry-run     Show what would be done without making changes');
    console.log('  --discover    Auto-select a file to evolve');
    console.log('  --verbose     Show detailed logs');
    console.log('');
    console.log('Examples:');
    console.log('  bun src/services/evolution/run-agentic.ts src/infra/event-loop-lag.ts');
    console.log('  bun src/services/evolution/run-agentic.ts --discover');
    console.log('  bun src/services/evolution/run-agentic.ts --dry-run src/utils/helpers.ts');
    process.exit(1);
  }

  // Verify file exists
  try {
    await fs.access(path.join(workDir, target));
  } catch {
    console.error(`ERROR: File not found: ${target}`);
    process.exit(1);
  }

  console.log(`Model:      ${model}`);
  console.log(`Target:     ${target}`);
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

  // Run the task
  console.log('Starting evolution task...\n');
  console.log('='.repeat(40));

  const result = await client.runTask({
    targetFile: target,
    goal: 'Improve code quality: simplify, remove dead code, improve types',
  });

  console.log('='.repeat(40));
  console.log('');

  // Summary
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

  // Exit code
  process.exit(result.success ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
