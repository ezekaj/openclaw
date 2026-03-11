#!/usr/bin/env node
/**
 * Self-Evolution Runner
 *
 * Usage:
 *   # Run with Kimi K2.5 (default, via Bailian API)
 *   npx ts-node src/services/evolution/run-evolution.ts
 *
 *   # Dry run (no changes applied)
 *   npx ts-node src/services/evolution/run-evolution.ts --dry-run
 *
 *   # Target specific files
 *   npx ts-node src/services/evolution/run-evolution.ts --files src/infra/sqlite-utils.ts
 *
 *   # Use different model
 *   npx ts-node src/services/evolution/run-evolution.ts --model qwen3-coder-plus
 *
 * Configuration:
 *   Auto-loads .env.evolution from working directory
 *   Or set: BAILIAN_API_KEY, EVOLUTION_MODEL in environment
 */

import { createEvolutionEngine } from './evolution-engine.js';

type SupportedModel = 'kimi-k2.5' | 'qwen3-coder-plus' | 'qwen3.5-plus' | 'moonshot-v1-128k';

async function main() {
  console.log('');
  console.log('===========================================');
  console.log('   OpenClaw Self-Evolution Engine');
  console.log('   Powered by Kimi K2.5 via Bailian');
  console.log('===========================================');
  console.log('');

  // Parse args
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-d');
  const verbose = !args.includes('--quiet') && !args.includes('-q');
  const singleRun = args.includes('--single') || args.includes('-s');

  // Parse target files
  const filesIndex = args.findIndex(a => a === '--files' || a === '-f');
  let targetFiles: string[] | undefined;
  if (filesIndex !== -1 && args[filesIndex + 1]) {
    targetFiles = args[filesIndex + 1].split(',');
  }

  // Parse model
  const modelIndex = args.findIndex(a => a === '--model' || a === '-m');
  let model: SupportedModel | undefined;
  if (modelIndex !== -1 && args[modelIndex + 1]) {
    model = args[modelIndex + 1] as SupportedModel;
  }

  // Create engine (auto-loads .env.evolution)
  const engine = await createEvolutionEngine({
    workDir: process.cwd(),
    model: model || 'kimi-k2.5',
    dryRun,
    verbose,
    targetFiles,
  });

  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE'}`);
  console.log(`Model: ${model || process.env.EVOLUTION_MODEL || 'kimi-k2.5'}`);
  if (targetFiles) {
    console.log(`Targets: ${targetFiles.join(', ')}`);
  }
  console.log('');

  // Handle shutdown
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down gracefully...');
    engine.stop();
    setTimeout(() => {
      const stats = engine.getStats();
      console.log('');
      console.log('=== Final Statistics ===');
      console.log(`Total cycles: ${stats.totalCycles}`);
      console.log(`Successful changes: ${stats.successfulChanges}`);
      console.log(`Failed changes: ${stats.failedChanges}`);
      console.log(`Lines changed: ${stats.totalLinesChanged}`);
      console.log('');
      process.exit(0);
    }, 500);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Run
  if (singleRun) {
    console.log('Running single cycle...');
    const result = await engine.runCycle();
    await engine.logResult(result);

    console.log('');
    console.log('=== Result ===');
    console.log(`File: ${result.targetFile}`);
    console.log(`Status: ${result.applied ? 'APPLIED' : result.error ? 'FAILED' : 'SKIPPED'}`);
    if (result.proposal) {
      console.log(`Proposal: ${result.proposal.description}`);
      console.log(`Confidence: ${(result.proposal.confidence * 100).toFixed(0)}%`);
    }
    if (result.commitHash) {
      console.log(`Commit: ${result.commitHash}`);
    }
    if (result.error) {
      console.log(`Error: ${result.error}`);
    }
    console.log(`Duration: ${result.duration}ms`);
  } else {
    console.log('Starting continuous evolution...');
    console.log('Press Ctrl+C to stop');
    console.log('');
    await engine.start();
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
