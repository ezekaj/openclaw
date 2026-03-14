/**
 * Goal Autonomy Integration
 * Wires GoalGenerationEngine to heartbeat for proactive execution
 */

import { GoalGenerationEngine } from './goal-generation-engine.js';
import { getEventMesh } from './event-mesh.js';
import { getNeuroMemoryBridge } from './neuro-memory-bridge.js';
import { getPredictiveService } from './predictive-service.js';
import { createSubsystemLogger } from '../logging/subsystem.js';

const log = createSubsystemLogger('goal-autonomy');

let goalEngine: GoalGenerationEngine | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;

/**
 * Initialize goal autonomy system
 */
export function initGoalAutonomy(config?: {
  maxActiveGoals?: number;
  usefulnessThreshold?: number;
  enableIntrinsicGoals?: boolean;
  heartbeatIntervalMs?: number;
}): void {
  if (goalEngine) {
    log.warn('Goal autonomy already initialized');
    return;
  }

  goalEngine = new GoalGenerationEngine({
    maxActiveGoals: config?.maxActiveGoals ?? 5,
    usefulnessThreshold: config?.usefulnessThreshold ?? 0.5,
    enableIntrinsicGoals: config?.enableIntrinsicGoals ?? true,
  });

  // Start heartbeat execution
  const intervalMs = config?.heartbeatIntervalMs ?? 30000; // 30 seconds
  heartbeatInterval = setInterval(() => executeGoalHeartbeat(), intervalMs);

  log.info('✅ Goal autonomy initialized', {
    maxActiveGoals: config?.maxActiveGoals ?? 5,
    heartbeatInterval: `${intervalMs}ms`
  });

  // Wire to event mesh
  const eventMesh = getEventMesh();
  if (eventMesh) {
    eventMesh.on('goal_completed', (event) => {
      log.info('📊 Goal completed', { goal: event.data.goal });
    });

    eventMesh.on('goal_failed', (event) => {
      log.warn('❌ Goal failed', { goal: event.data.goal });
    });
  }
}

/**
 * Execute goal heartbeat (called periodically)
 * OPTIMIZED: Parallel operations, 5s timeout, fire-and-forget writes
 */
async function executeGoalHeartbeat(): Promise<void> {
  if (!goalEngine) return;

  try {
    const startTime = Date.now();

    // OPTIMIZATION 1: Run independent operations in parallel
    const [neuroMemoryResult, predictionsResult] = await Promise.allSettled([
      // 1. Sync with neuro-memory (load recent goal history)
      (async () => {
        const neuroMemory = getNeuroMemoryBridge();
        if (!neuroMemory) return null;
        
        const recentGoals = await neuroMemory.query({
          type: 'goal_completed',
          limit: 10
        });
        return { count: recentGoals.length };
      })(),
      
      // 2. Get predictive priority boosts
      (async () => {
        const predictiveService = getPredictiveService();
        if (!predictiveService) return null;
        
        const predictions = await predictiveService.check();
        return { count: predictions.length };
      })()
    ]);

    if (neuroMemoryResult.status === 'fulfilled' && neuroMemoryResult.value) {
      log.debug('Loaded recent goals from neuro-memory', { count: neuroMemoryResult.value.count });
    }
    
    if (predictionsResult.status === 'fulfilled' && predictionsResult.value?.count) {
      log.debug('Predictive suggestions available', { count: predictionsResult.value.count });
    }

    // 3. Generate and pursue goals with 5s timeout (CRITICAL: prevents event loop blocking)
    const result = await Promise.race([
      goalEngine.generateAndPursueGoals(),
      new Promise<{generated: 0, completed: 0, failed: 0, active: 0}>((_, reject) => 
        setTimeout(() => reject(new Error('Goal generation timeout')), 5000)
      )
    ]);

    const elapsed = Date.now() - startTime;

    if (result.generated > 0 || result.completed > 0 || result.failed > 0) {
      log.info('🔄 Goal heartbeat', {
        generated: result.generated,
        completed: result.completed,
        failed: result.failed,
        active: result.active,
        elapsed: `${elapsed}ms`
      });

      // OPTIMIZATION 2: Fire-and-forget writes (don't await, just log errors)
      const neuroMemory = getNeuroMemoryBridge();
      const eventMesh = getEventMesh();
      
      // Store in neuro-memory (async, non-blocking)
      if (neuroMemory && result.completed > 0) {
        neuroMemory.store({
          type: 'goal_heartbeat',
          data: result,
          timestamp: Date.now()
        }).catch(error => {
          log.warn('Failed to store goals in neuro-memory', { error });
        });
      }

      // Emit to event mesh (async, non-blocking)
      if (eventMesh) {
        eventMesh.emit({
          type: 'goal_heartbeat',
          source: 'goal-autonomy',
          data: result
        }).catch(error => {
          log.warn('Failed to emit goal heartbeat', { error });
        });
      }
    }
  } catch (error) {
    log.error('Goal heartbeat failed', { error });
  }
}

/**
 * Add external goal (from user or system)
 */
export function addGoal(goal: string, usefulnessScore = 0.7): string | null {
  if (!goalEngine) {
    log.warn('Goal autonomy not initialized');
    return null;
  }

  const goalId = goalEngine.addExternalGoal(goal, usefulnessScore);
  log.info('📝 Goal added', { goal, usefulnessScore, goalId });

  // Emit to event mesh
  const eventMesh = getEventMesh();
  if (eventMesh) {
    eventMesh.emit({
      type: 'goal_added',
      source: 'goal-autonomy',
      data: { goal, usefulnessScore, goalId }
    });
  }

  return goalId;
}

/**
 * Get goal engine statistics
 */
export function getGoalStats() {
  if (!goalEngine) {
    return null;
  }

  return {
    tree: goalEngine.getGoalTreeStats(),
    archive: goalEngine.getArchiveStats(),
    motivation: goalEngine.getMotivation().getState()
  };
}

/**
 * Get proactive actions
 */
export function getProactiveActions(): string[] {
  if (!goalEngine) {
    return [];
  }

  return goalEngine.generateProactiveActions();
}

/**
 * Stop goal autonomy system
 */
export function stopGoalAutonomy(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  goalEngine = null;
  log.info('🛑 Goal autonomy stopped');
}

/**
 * Check if goal autonomy is initialized
 */
export function isGoalAutonomyInitialized(): boolean {
  return goalEngine !== null;
}
