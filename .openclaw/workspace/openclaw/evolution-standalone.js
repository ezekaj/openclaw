#!/usr/bin/env node
/**
 * Standalone Evolution Daemon - No build required
 *
 * Usage: node evolution-standalone.js
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec as execAsync } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execAsync);

const BAILIAN_API_KEY = process.env.BAILIAN_API_KEY || 'sk-sp-7869acee3a6e4cb3a03d0dbd52b1c3b1';
const BAILIAN_BASE_URL = 'https://coding-intl.dashscope.aliyuncs.com/v1';
const MODEL = process.env.EVOLUTION_MODEL || 'kimi-k2.5';
const INTERVAL_MS = parseInt(process.env.EVOLUTION_INTERVAL_MS || '3600000', 10);
const OPENCLAW_DIR = process.cwd();

const TARGETS = [
  'src/services/evolution/evolution-service.ts',
  'src/agents/neuro-memory-bridge.ts',
  'src/agents/predictive-engine.ts',
  'src/infra/event-partition-manager.ts'
];

async function generateProposal(code, file) {
  const systemPrompt = `You are an autonomous code evolution agent performing DEEP ANALYSIS.

DEEP SEARCH INSTRUCTIONS:
1. Analyze the entire codebase structure and dependencies
2. Search for performance bottlenecks, memory leaks, inefficiencies
3. Identify dead code, unused imports, redundant logic
4. Look for architectural improvements and design patterns
5. Consider edge cases, error handling, and robustness
6. Evaluate code readability and maintainability

ANALYSIS DEPTH:
- Trace function call chains and data flows
- Check for race conditions and async issues
- Identify opportunities for caching and optimization
- Look for duplicated logic across files
- Consider scalability and future maintainability

RULES:
1. Generate unified diff patches for MEANINGFUL improvements
2. Focus on: performance, simplicity, maintainability, correctness
3. Simpler is better: removing code > adding code
4. Return ONLY valid unified diff format
5. If no improvement needed after deep search, return "NO_CHANGE"

OUTPUT FORMAT (JSON):
{
  "description": "Brief description of improvement",
  "reasoning": "Why this improves the code (deep analysis)",
  "patch": "unified diff or NO_CHANGE",
  "simplicityScore": 0.0-1.0,
  "impactAreas": ["performance", "memory", "maintainability", etc],
  "riskLevel": "low|medium|high"
}`;

  const userPrompt = `File: ${file}

Perform DEEP SEARCH analysis:
- Trace dependencies and call chains
- Identify bottlenecks and inefficiencies
- Look for optimization opportunities
- Consider architectural improvements

Current code:
\`\`\`typescript
${code}
\`\`\`

After deep analysis, return JSON with your best improvement proposal.`;

  const response = await fetch(`${BAILIAN_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${BAILIAN_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 8192
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';

  // Parse JSON response
  let cleaned = content.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  try {
    const proposal = JSON.parse(cleaned);
    return {
      id: randomUUID().substring(0, 7),
      description: proposal.description || 'No description',
      patch: proposal.patch === 'NO_CHANGE' ? null : proposal.patch,
      simplicityScore: proposal.simplicityScore || 0.5,
      reasoning: proposal.reasoning || ''
    };
  } catch (error) {
    return {
      id: randomUUID().substring(0, 7),
      description: 'Parse error',
      patch: null,
      simplicityScore: 0,
      reasoning: content.substring(0, 200)
    };
  }
}

async function runTests() {
  try {
    // TypeScript compile check
    await execAsync('npx tsc --noEmit', { cwd: OPENCLAW_DIR, timeout: 60000 });

    // Run tests
    const { stdout } = await execAsync('npm test 2>&1 || true', {
      cwd: OPENCLAW_DIR,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120000
    });

    const passed = !stdout.includes('FAIL') && !stdout.includes('Error:');
    const testsPassed = parseInt((stdout.match(/(\d+) passed/) || [])[1] || '0', 10);
    const testsTotal = parseInt((stdout.match(/(\d+) total/) || [])[1] || '0', 10);

    return { passed, testsPassed, testsTotal };
  } catch (error) {
    return { passed: false, testsPassed: 0, testsTotal: 0 };
  }
}

async function logToTSV(entry) {
  const tsvPath = path.join(OPENCLAW_DIR, 'evolution-results.tsv');

  // Check if file exists, create with header if not
  try {
    await fs.access(tsvPath);
  } catch {
    await fs.writeFile(tsvPath, 'commit\tmetric\tmemory_gb\tstatus\tdescription\n');
  }

  const line = `${entry.commit}\t${entry.metric.toFixed(6)}\t${entry.memory.toFixed(1)}\t${entry.status}\t${entry.description}\n`;
  await fs.appendFile(tsvPath, line);
}

async function runCycle() {
  console.log('\n[Evolution] === Starting new cycle ===');

  // Pick target
  const target = TARGETS[Math.floor(Math.random() * TARGETS.length)];
  console.log(`[Evolution] Target: ${target}`);

  // Read code
  const codePath = path.join(OPENCLAW_DIR, target);
  const currentCode = await fs.readFile(codePath, 'utf-8');

  // Generate proposal
  console.log(`[Evolution] Generating proposal via ${MODEL}...`);
  const proposal = await generateProposal(currentCode, target);

  if (!proposal.patch) {
    console.log('[Evolution] No changes proposed, skipping');
    await logToTSV({
      commit: 'skip',
      metric: 0,
      memory: 0,
      status: 'discard',
      description: 'No changes proposed'
    });
    return;
  }

  console.log(`[Evolution] Proposal: ${proposal.description}`);
  console.log(`[Evolution] Simplicity: ${proposal.simplicityScore.toFixed(3)}`);

  // Apply patch
  const startTime = Date.now();
  let success = false;
  let testResult = null;

  try {
    await fs.writeFile(codePath, proposal.patch);

    console.log('[Evolution] Running tests...');
    testResult = await runTests();
    success = testResult.passed;
  } catch (error) {
    console.error('[Evolution] Test failed:', error);
  }

  const elapsed = Date.now() - startTime;

  // Log result
  if (success && testResult) {
    const metric = testResult.testsPassed / Math.max(testResult.testsTotal, 1);
    const memory = process.memoryUsage().heapUsed / 1024 / 1024 / 1024;

    await logToTSV({
      commit: proposal.id,
      metric,
      memory,
      status: 'keep',
      description: proposal.description
    });

    console.log(`[Evolution] ✓ Applied: ${proposal.description}`);
    console.log(`[Evolution]   Metric: ${metric.toFixed(6)}`);
    console.log(`[Evolution]   Time: ${elapsed}ms`);
  } else {
    // Rollback
    await fs.writeFile(codePath, currentCode);

    await logToTSV({
      commit: proposal.id,
      metric: 0,
      memory: 0,
      status: 'discard',
      description: proposal.description
    });

    console.log(`[Evolution] ✗ Discarded: ${proposal.description}`);
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function start() {
  console.log('[Evolution] Starting autonomous evolution daemon...');
  console.log(`[Evolution] Model: ${MODEL}`);
  console.log(`[Evolution] Interval: ${INTERVAL_MS}ms`);
  console.log(`[Evolution] Targets: ${TARGETS.length} files`);
  console.log(`[Evolution] Working directory: ${OPENCLAW_DIR}`);

  while (true) {
    try {
      await runCycle();
    } catch (error) {
      console.error('[Evolution] Cycle failed:', error);
      await logToTSV({
        commit: 'error',
        metric: 0,
        memory: 0,
        status: 'crash',
        description: `Error: ${error.message}`
      });
    }

    console.log(`[Evolution] Sleeping for ${INTERVAL_MS}ms...`);
    await sleep(INTERVAL_MS);
  }
}

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\n[Evolution] Stopping...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Evolution] Stopping...');
  process.exit(0);
});

// Start daemon
start().catch(console.error);
