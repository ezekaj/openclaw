#!/usr/bin/env bun
/**
 * View evolution history
 *
 * Usage:
 *   bun src/services/evolution/evolution-log.ts          # show last 20
 *   bun src/services/evolution/evolution-log.ts --all    # show all
 *   bun src/services/evolution/evolution-log.ts --stats  # show stats
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const LOG_FILE = path.join(process.cwd(), 'evolution-log.jsonl');

interface LogEntry {
  timestamp: string;
  taskId: string;
  success: boolean;
  summary: string;
  changesMade: number;
  filesModified: string[];
  iterations: number;
  duration: number;
  error?: string;
}

async function main() {
  const showAll = process.argv.includes('--all');
  const showStats = process.argv.includes('--stats');

  let content: string;
  try {
    content = await fs.readFile(LOG_FILE, 'utf-8');
  } catch {
    console.log('No evolution log found. Run the evolution agent first.');
    return;
  }

  const entries: LogEntry[] = content
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((e): e is LogEntry => e !== null && 'taskId' in e);

  if (entries.length === 0) {
    console.log('No agentic evolution entries found yet.');
    return;
  }

  if (showStats) {
    const successful = entries.filter(e => e.success);
    const totalChanges = entries.reduce((sum, e) => sum + e.changesMade, 0);
    const totalDuration = entries.reduce((sum, e) => sum + e.duration, 0);
    const avgIterations = entries.reduce((sum, e) => sum + e.iterations, 0) / entries.length;
    const allFiles = new Set(entries.flatMap(e => e.filesModified));

    console.log('EVOLUTION STATS');
    console.log('===============');
    console.log(`Total runs:       ${entries.length}`);
    console.log(`Successful:       ${successful.length} (${((successful.length / entries.length) * 100).toFixed(0)}%)`);
    console.log(`Total changes:    ${totalChanges}`);
    console.log(`Files touched:    ${allFiles.size}`);
    console.log(`Avg iterations:   ${avgIterations.toFixed(1)}`);
    console.log(`Total time:       ${(totalDuration / 60000).toFixed(1)} minutes`);
    console.log(`Avg time/run:     ${(totalDuration / entries.length / 1000).toFixed(0)}s`);
    return;
  }

  const display = showAll ? entries : entries.slice(-20);

  console.log('EVOLUTION HISTORY');
  console.log('=================\n');

  for (const entry of display) {
    const date = new Date(entry.timestamp);
    const dateStr = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const timeStr = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const status = entry.success ? '\x1b[32mOK\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    const duration = `${(entry.duration / 1000).toFixed(0)}s`;
    const files = entry.filesModified.join(', ') || '-';

    console.log(`${dateStr} ${timeStr}  ${status}  ${entry.changesMade} changes  ${entry.iterations} iter  ${duration}  ${files}`);

    // Show summary (first line only)
    const summaryLine = entry.summary.split('\n')[0].slice(0, 100);
    if (summaryLine && summaryLine !== 'Agent stopped') {
      console.log(`              ${summaryLine}`);
    }
    if (entry.error) {
      console.log(`              \x1b[31mError: ${entry.error.slice(0, 80)}\x1b[0m`);
    }
    console.log('');
  }
}

main().catch(console.error);
