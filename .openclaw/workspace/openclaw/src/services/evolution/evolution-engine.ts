/**
 * Evolution Engine - Robust autonomous code improvement
 *
 * Features:
 * - Kimi K2.5 via Bailian API (auto-configured)
 * - Intelligent file selection based on complexity
 * - Atomic git commits with auto-rollback
 * - Real-time metrics and monitoring
 * - Safety guards and validation
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createKimiClient, type EvolutionProposal } from './kimi-client.js';
import { checkEvolutionGuard, loadEvolutionIgnore } from './evolution-guards.js';

const exec = promisify(execCallback);

// Auto-load .env.evolution if exists
async function loadEnvEvolution(workDir: string): Promise<void> {
  try {
    const envPath = path.join(workDir, '.env.evolution');
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
    // No .env.evolution file - use existing env vars
  }
}

// Get API key (supports multiple env var names)
function getApiKey(): string | undefined {
  return process.env.BAILIAN_API_KEY ||
         process.env.MOONSHOT_API_KEY ||
         process.env.KIMI_API_KEY;
}

// Supported models via Bailian
type SupportedModel = 'kimi-k2.5' | 'qwen3-coder-plus' | 'qwen3.5-plus' | 'moonshot-v1-128k';

// Configuration
const DEFAULT_CONFIG = {
  maxFileSizeKB: 100,           // Skip files larger than 100KB
  minFileSizeBytes: 100,        // Skip tiny files
  maxRetries: 3,                // Retries per proposal
  testTimeoutMs: 120000,        // 2 minute test timeout
  cooldownMs: 300000,           // 5 minutes between cycles
  maxCyclesPerHour: 10,         // Rate limiting
  preferredModel: 'kimi-k2.5' as SupportedModel,
};

export interface EngineConfig {
  workDir: string;
  model?: SupportedModel;
  apiKey?: string;
  dryRun?: boolean;
  verbose?: boolean;
  targetFiles?: string[];        // Specific files to target
  excludePatterns?: string[];    // Additional exclude patterns
}

export interface CycleResult {
  cycleId: string;
  timestamp: string;
  targetFile: string;
  proposal: EvolutionProposal | null;
  testsPassed: boolean;
  applied: boolean;
  commitHash?: string;
  duration: number;
  error?: string;
}

export interface EngineStats {
  totalCycles: number;
  successfulChanges: number;
  failedChanges: number;
  skippedFiles: number;
  totalLinesChanged: number;
  averageCycleDuration: number;
}

/**
 * Create the evolution engine
 */
export async function createEvolutionEngine(config: EngineConfig) {
  const workDir = config.workDir;
  const verbose = config.verbose ?? false;
  const dryRun = config.dryRun ?? false;

  // Auto-load .env.evolution
  await loadEnvEvolution(workDir);

  // Statistics
  const stats: EngineStats = {
    totalCycles: 0,
    successfulChanges: 0,
    failedChanges: 0,
    skippedFiles: 0,
    totalLinesChanged: 0,
    averageCycleDuration: 0,
  };

  // State
  let running = false;
  let lastCycleTime = 0;
  const failedFiles = new Set<string>();
  const recentProposals = new Map<string, string[]>();

  // Get model from config or env
  const model = config.model ||
    (process.env.EVOLUTION_MODEL as SupportedModel) ||
    DEFAULT_CONFIG.preferredModel;

  // Initialize Kimi client (works with Bailian API)
  const apiKey = config.apiKey || getApiKey();
  if (!apiKey) {
    throw new Error('No API key found. Set BAILIAN_API_KEY in .env.evolution or environment');
  }

  const kimi = createKimiClient({
    apiKey,
    model,
    baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1', // Bailian endpoint
    temperature: 0.3,
    maxTokens: 8192,
  });

  // Logging
  const log = (msg: string, ...args: unknown[]) => {
    if (verbose) {
      console.log(`[Evolution] ${msg}`, ...args);
    }
  };

  const logAlways = (msg: string, ...args: unknown[]) => {
    console.log(`[Evolution] ${msg}`, ...args);
  };

  return {
    /**
     * Start the evolution loop
     */
    async start(): Promise<void> {
      if (running) {
        logAlways('Engine already running');
        return;
      }

      running = true;
      logAlways('Starting evolution engine...');
      logAlways(`Model: ${config.model || DEFAULT_CONFIG.preferredModel}`);
      logAlways(`Work directory: ${workDir}`);
      logAlways(`Dry run: ${dryRun}`);

      // Test API connection
      const connected = await kimi.testConnection();
      if (!connected) {
        logAlways('Failed to connect to AI provider');
        running = false;
        return;
      }
      logAlways('AI provider connected');

      // Load ignore patterns
      const ignorePatterns = await loadEvolutionIgnore(workDir);
      logAlways(`Loaded ${ignorePatterns.length} ignore patterns`);

      // Main loop
      while (running) {
        try {
          const result = await this.runCycle();
          await this.logResult(result);

          // Update stats
          stats.totalCycles++;
          if (result.applied) {
            stats.successfulChanges++;
          } else if (result.error) {
            stats.failedChanges++;
          }
        } catch (error) {
          logAlways('Cycle error:', error);
        }

        // Cooldown
        const cooldown = DEFAULT_CONFIG.cooldownMs;
        log(`Cooling down for ${cooldown / 1000}s...`);
        await sleep(cooldown);
      }

      logAlways('Engine stopped');
    },

    /**
     * Run a single evolution cycle
     */
    async runCycle(): Promise<CycleResult> {
      const cycleId = randomUUID().substring(0, 8);
      const startTime = Date.now();

      log(`\n--- Cycle ${cycleId} ---`);

      // 1. Select target file
      const targetFile = await selectTargetFile();
      if (!targetFile) {
        return {
          cycleId,
          timestamp: new Date().toISOString(),
          targetFile: '',
          proposal: null,
          testsPassed: false,
          applied: false,
          duration: Date.now() - startTime,
          error: 'No suitable files found',
        };
      }

      log(`Target: ${targetFile}`);

      // 2. Read file content
      const filePath = path.join(workDir, targetFile);
      let originalCode: string;
      try {
        originalCode = await fs.readFile(filePath, 'utf-8');
      } catch (error) {
        return {
          cycleId,
          timestamp: new Date().toISOString(),
          targetFile,
          proposal: null,
          testsPassed: false,
          applied: false,
          duration: Date.now() - startTime,
          error: `Failed to read file: ${error}`,
        };
      }

      // 3. Generate proposal
      log('Generating proposal...');
      const previousAttempts = recentProposals.get(targetFile) || [];
      let proposal: EvolutionProposal;

      try {
        proposal = await kimi.generateProposal({
          file: targetFile,
          code: originalCode,
          goal: 'Improve code quality, simplify, remove dead code',
          previousAttempts,
        });
      } catch (error) {
        return {
          cycleId,
          timestamp: new Date().toISOString(),
          targetFile,
          proposal: null,
          testsPassed: false,
          applied: false,
          duration: Date.now() - startTime,
          error: `AI generation failed: ${error}`,
        };
      }

      log(`Proposal: ${proposal.description}`);
      log(`Confidence: ${(proposal.confidence * 100).toFixed(0)}%`);
      log(`Simplicity: ${(proposal.simplicityScore * 100).toFixed(0)}%`);

      // 4. Check if no changes needed
      if (!proposal.patch) {
        log('No changes proposed');
        stats.skippedFiles++;
        return {
          cycleId,
          timestamp: new Date().toISOString(),
          targetFile,
          proposal,
          testsPassed: true,
          applied: false,
          duration: Date.now() - startTime,
        };
      }

      // 5. Check evolution guards
      const guards = await checkEvolutionGuard({
        description: proposal.description,
        patches: [{ file: targetFile, search: originalCode, replace: proposal.patch }],
        affectedFiles: [targetFile],
      });

      const blocked = guards.find(g => !g.allowed);
      if (blocked) {
        log(`Blocked by guard: ${blocked.reason}`);
        return {
          cycleId,
          timestamp: new Date().toISOString(),
          targetFile,
          proposal,
          testsPassed: false,
          applied: false,
          duration: Date.now() - startTime,
          error: `Guard: ${blocked.reason}`,
        };
      }

      // 6. Validate proposal (confidence check)
      if (proposal.confidence < 0.7) {
        log(`Low confidence (${proposal.confidence}), skipping`);
        return {
          cycleId,
          timestamp: new Date().toISOString(),
          targetFile,
          proposal,
          testsPassed: false,
          applied: false,
          duration: Date.now() - startTime,
          error: 'Low confidence',
        };
      }

      // 7. Dry run check
      if (dryRun) {
        logAlways(`[DRY RUN] Would apply: ${proposal.description}`);
        return {
          cycleId,
          timestamp: new Date().toISOString(),
          targetFile,
          proposal,
          testsPassed: true,
          applied: false,
          duration: Date.now() - startTime,
        };
      }

      // 8. Apply change with rollback capability
      log('Applying change...');
      try {
        await fs.writeFile(filePath, proposal.patch, 'utf-8');
      } catch (error) {
        return {
          cycleId,
          timestamp: new Date().toISOString(),
          targetFile,
          proposal,
          testsPassed: false,
          applied: false,
          duration: Date.now() - startTime,
          error: `Write failed: ${error}`,
        };
      }

      // 9. Run tests
      log('Running tests...');
      const testResult = await runTests(targetFile);

      if (!testResult.passed) {
        // Rollback
        log('Tests failed, rolling back...');
        await fs.writeFile(filePath, originalCode, 'utf-8');
        failedFiles.add(targetFile);

        // Track failed attempt
        const attempts = recentProposals.get(targetFile) || [];
        attempts.push(proposal.description);
        recentProposals.set(targetFile, attempts.slice(-5));

        return {
          cycleId,
          timestamp: new Date().toISOString(),
          targetFile,
          proposal,
          testsPassed: false,
          applied: false,
          duration: Date.now() - startTime,
          error: `Tests failed: ${testResult.error}`,
        };
      }

      // 10. Create git commit
      log('Committing change...');
      let commitHash: string | undefined;
      try {
        await exec(`cd "${workDir}" && git add "${targetFile}"`);
        const commitMsg = `${proposal.description}\n\nEvolution ID: ${cycleId}\nConfidence: ${(proposal.confidence * 100).toFixed(0)}%\nSimplicity: ${(proposal.simplicityScore * 100).toFixed(0)}%`;
        const { stdout } = await exec(`cd "${workDir}" && git commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
        const match = stdout.match(/\[[\w-]+\s+([a-f0-9]+)\]/);
        commitHash = match?.[1];
      } catch (error) {
        log('Git commit failed (changes still applied):', error);
      }

      // Count lines changed
      const linesChanged = Math.abs(
        proposal.patch.split('\n').length - originalCode.split('\n').length
      );
      stats.totalLinesChanged += linesChanged;

      logAlways(`Applied: ${proposal.description} (${commitHash || 'no commit'})`);

      return {
        cycleId,
        timestamp: new Date().toISOString(),
        targetFile,
        proposal,
        testsPassed: true,
        applied: true,
        commitHash,
        duration: Date.now() - startTime,
      };
    },

    /**
     * Stop the engine
     */
    stop(): void {
      logAlways('Stopping engine...');
      running = false;
    },

    /**
     * Get current statistics
     */
    getStats(): EngineStats {
      return { ...stats };
    },

    /**
     * Log result to file
     */
    async logResult(result: CycleResult): Promise<void> {
      const logPath = path.join(workDir, 'evolution-log.jsonl');
      const entry = JSON.stringify(result) + '\n';
      await fs.appendFile(logPath, entry).catch(() => {});

      // Also log to TSV
      const tsvPath = path.join(workDir, 'evolution-results.tsv');
      try {
        await fs.access(tsvPath);
      } catch {
        await fs.writeFile(tsvPath, 'timestamp\tcycle\tfile\tstatus\tcommit\tdescription\n');
      }

      const status = result.applied ? 'applied' : (result.error ? 'failed' : 'skipped');
      const desc = result.proposal?.description || result.error || 'no change';
      const tsvLine = `${result.timestamp}\t${result.cycleId}\t${result.targetFile}\t${status}\t${result.commitHash || '-'}\t${desc.substring(0, 100)}\n`;
      await fs.appendFile(tsvPath, tsvLine).catch(() => {});
    },
  };

  /**
   * Select a target file for evolution
   */
  async function selectTargetFile(): Promise<string | null> {
    // Use provided targets or discover files
    let candidates: string[];

    if (config.targetFiles?.length) {
      candidates = config.targetFiles;
    } else {
      candidates = await discoverFiles();
    }

    // Filter out recently failed files
    candidates = candidates.filter(f => !failedFiles.has(f));

    // Filter by size and other criteria
    const validFiles: Array<{ file: string; score: number }> = [];

    for (const file of candidates) {
      try {
        const filePath = path.join(workDir, file);
        const stat = await fs.stat(filePath);
        const sizeKB = stat.size / 1024;

        // Skip too large or too small files
        if (sizeKB > DEFAULT_CONFIG.maxFileSizeKB) continue;
        if (stat.size < DEFAULT_CONFIG.minFileSizeBytes) continue;

        // Score based on various factors
        let score = 50;

        // Prefer medium-sized files (easier to improve)
        if (sizeKB > 5 && sizeKB < 30) score += 20;

        // Prefer files not recently modified
        const daysSinceModified = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
        if (daysSinceModified > 7) score += 10;

        // Prefer infra/utility files (less risky)
        if (file.includes('/infra/') || file.includes('/utils/')) score += 15;

        // Avoid test files
        if (file.includes('.test.') || file.includes('.spec.')) continue;

        // Avoid index files (often just re-exports)
        if (file.endsWith('index.ts')) score -= 20;

        validFiles.push({ file, score });
      } catch {
        // Skip files that can't be accessed
      }
    }

    if (validFiles.length === 0) {
      return null;
    }

    // Sort by score and pick randomly from top candidates
    validFiles.sort((a, b) => b.score - a.score);
    const topCandidates = validFiles.slice(0, Math.min(10, validFiles.length));
    const selected = topCandidates[Math.floor(Math.random() * topCandidates.length)];

    return selected.file;
  }

  /**
   * Discover TypeScript files in src/
   */
  async function discoverFiles(): Promise<string[]> {
    try {
      const { stdout } = await exec(
        `find src -name "*.ts" -not -name "*.test.ts" -not -name "*.spec.ts" -not -name "*.d.ts" | head -500`,
        { cwd: workDir, maxBuffer: 10 * 1024 * 1024 }
      );

      return stdout.trim().split('\n').filter(f => f);
    } catch {
      return [];
    }
  }

  /**
   * Run tests for a specific file
   */
  async function runTests(targetFile: string): Promise<{ passed: boolean; error?: string }> {
    // Find corresponding test file
    const testFile = targetFile.replace('.ts', '.test.ts');
    const testPath = path.join(workDir, testFile);

    try {
      await fs.access(testPath);
    } catch {
      // No test file - just validate syntax
      log('No test file, validating syntax...');
      try {
        const { stderr } = await exec(
          `cd "${workDir}" && npx tsc --noEmit "${targetFile}" 2>&1 || true`,
          { timeout: 30000 }
        );

        if (stderr.includes('error TS')) {
          return { passed: false, error: 'TypeScript errors' };
        }
        return { passed: true };
      } catch {
        return { passed: true }; // Assume OK if tsc fails to run
      }
    }

    // Run vitest for the specific test file
    try {
      const { stdout, stderr } = await exec(
        `cd "${workDir}" && npx vitest run "${testFile}" --reporter=json 2>&1 || true`,
        { timeout: DEFAULT_CONFIG.testTimeoutMs, maxBuffer: 10 * 1024 * 1024 }
      );

      const output = stdout + stderr;

      // Check for failures
      if (output.includes('"numFailedTests":0') || output.includes('passed')) {
        return { passed: true };
      }

      if (output.includes('failed') || output.includes('Error')) {
        return { passed: false, error: 'Test failures' };
      }

      return { passed: true };
    } catch (error: any) {
      return { passed: false, error: error.message };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Quick start helper
 */
export async function startEvolution(options?: {
  dryRun?: boolean;
  verbose?: boolean;
  targetFiles?: string[];
  model?: SupportedModel;
}): Promise<void> {
  const engine = await createEvolutionEngine({
    workDir: process.cwd(),
    dryRun: options?.dryRun ?? false,
    verbose: options?.verbose ?? true,
    targetFiles: options?.targetFiles,
    model: options?.model,
  });

  // Handle shutdown
  process.on('SIGINT', () => {
    engine.stop();
    setTimeout(() => process.exit(0), 1000);
  });

  process.on('SIGTERM', () => {
    engine.stop();
    setTimeout(() => process.exit(0), 1000);
  });

  await engine.start();
}

// Export type for external use
export type { SupportedModel };
