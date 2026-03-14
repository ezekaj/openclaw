/**
 * GoalGenerationEngine - Main Orchestrator
 *
 * Integrates GoalTree, IntrinsicMotivation, and GoalArchive
 * to provide autonomous goal generation and execution.
 */

import { GoalTree, GoalNode } from './goal-tree.js';
import { IntrinsicMotivation } from './intrinsic-motivation.js';
import { GoalArchive, ArchivedGoal, GoalPattern } from './goal-archive.js';

export interface GoalGenerationConfig {
  maxActiveGoals?: number; // Default: 3
  usefulnessThreshold?: number; // Default: 0.5
  enableIntrinsicGoals?: boolean; // Default: true
  archiveSize?: number; // Default: 1000
}

export class GoalGenerationEngine {
  private goalTree: GoalTree;
  private motivation: IntrinsicMotivation;
  private archive: GoalArchive;
  private config: Required<GoalGenerationConfig>;

  constructor(config: GoalGenerationConfig = {}) {
    this.config = {
      maxActiveGoals: config.maxActiveGoals ?? 3,
      usefulnessThreshold: config.usefulnessThreshold ?? 0.5,
      enableIntrinsicGoals: config.enableIntrinsicGoals ?? true,
      archiveSize: config.archiveSize ?? 1000,
    };

    this.goalTree = new GoalTree();
    this.motivation = new IntrinsicMotivation();
    this.archive = new GoalArchive();
  }

  /**
   * Add an external goal (from user or system)
   */
  addExternalGoal(goal: string, usefulnessScore = 0.7): string {
    // Self-protection: Prevent goals that could delete the goal autonomy system
    if (this.isSelfDestructive(goal)) {
      console.warn('[GoalEngine] Blocked self-destructive goal:', goal);
      return 'blocked-self-destruction';
    }
    
    const goalId = this.goalTree.addRootGoal(goal, usefulnessScore);
    return goalId;
  }

  /**
   * Check if a goal could harm the goal autonomy system itself
   */
  private isSelfDestructive(goal: string): boolean {
    const lower = goal.toLowerCase();
    
    // Prevent deletion of goal autonomy files
    if (lower.includes('delete') && lower.includes('goal')) return true;
    if (lower.includes('remove') && lower.includes('goal')) return true;
    if (lower.includes('rm ') && lower.includes('goal')) return true;
    
    // Prevent disabling the goal engine
    if (lower.includes('disable') && lower.includes('autonomy')) return true;
    if (lower.includes('stop') && lower.includes('autonomy')) return true;
    
    // Prevent modifying goal autonomy code
    if (lower.includes('modify') && lower.includes('goal-generation-engine')) return true;
    
    return false;
  }

  /**
   * Generate and pursue goals (main autonomous loop)
   */
  async generateAndPursueGoals(
    llmClient?: { generate: (prompt: string) => Promise<string> }
  ): Promise<{
    generated: number;
    completed: number;
    failed: number;
    active: number;
  }> {
    const stats = { generated: 0, completed: 0, failed: 0, active: 0 };

    // 1. Check for intrinsic goals
    if (this.config.enableIntrinsicGoals) {
      const intrinsicGoals = this.motivation.generateIntrinsicGoals();
      for (const goal of intrinsicGoals) {
        if (this.goalTree.getAllGoals().length < this.config.maxActiveGoals) {
          this.addExternalGoal(`[Intrinsic] ${goal}`, 0.6);
          stats.generated++;
        }
      }
    }

    // 2. Get next goal to work on
    const nextGoal = this.goalTree.getNextPendingGoal();
    if (!nextGoal) {
      return stats;
    }

    stats.active = 1;

    // 3. Decompose goal using LLM (if available)
    if (llmClient && !nextGoal.goal.includes('[Intrinsic]')) {
      try {
        const subgoals = await this.decomposeGoal(nextGoal.goal, llmClient);
        this.goalTree.decompose(nextGoal.id, subgoals);
        stats.generated += subgoals.length;
      } catch (error) {
        console.error('[GoalEngine] Decomposition failed:', error);
      }
    }

    // 4. Mark as completed or failed (simplified)
    const success = Math.random() > 0.3; // 70% success rate simulation
    if (success) {
      this.goalTree.completeGoal(nextGoal.id);
      stats.completed++;
      this.motivation.recordSuccess(nextGoal.goal);
    } else {
      this.goalTree.failGoal(nextGoal.id);
      stats.failed++;
      this.motivation.recordFailure(nextGoal.goal);
    }

    // 5. Archive goal
    this.archiveGoal(nextGoal, success);

    // 6. Apply motivation decay
    this.motivation.decay();

    return stats;
  }

  /**
   * Get current goal tree state
   */
  getGoalTree(): GoalTree {
    return this.goalTree;
  }

  /**
   * Get motivation state
   */
  getMotivation(): IntrinsicMotivation {
    return this.motivation;
  }

  /**
   * Get archive statistics
   */
  getArchiveStats(): ReturnType<GoalArchive['getStats']> {
    return this.archive.getStats();
  }

  /**
   * Get goal tree statistics
   */
  getGoalTreeStats(): ReturnType<GoalTree['getStats']> {
    return this.goalTree.getStats();
  }

  /**
   * Get top learned patterns
   */
  getTopPatterns(limit = 10): GoalPattern[] {
    return this.archive.getTopPatterns(limit);
  }

  /**
   * Generate proactive actions based on patterns
   */
  generateProactiveActions(): string[] {
    const patterns = this.getTopPatterns(5);
    const actions: string[] = [];

    for (const pattern of patterns) {
      if (pattern.successRate > 0.8 && this.goalTree.getAllGoals().length < this.config.maxActiveGoals) {
        // Generate goal based on successful pattern
        const action = `Apply pattern: ${pattern.pattern}`;
        actions.push(action);
      }
    }

    return actions;
  }

  /**
   * Get all goals
   */
  getAllGoals(): GoalNode[] {
    return this.goalTree.getAllGoals();
  }

  /**
   * Decompose goal using LLM with 2s timeout to prevent event loop blocking
   */
  private async decomposeGoal(
    goal: string,
    llmClient: { generate: (prompt: string) => Promise<string> }
  ): Promise<Array<{ goal: string; usefulnessScore?: number }>> {
    const prompt = `Decompose this goal into 3 subgoals: "${goal}"
Return as JSON array: [{"goal": "...", "usefulnessScore": 0.8}]`;

    try {
      // CRITICAL: 2s timeout to prevent blocking event loop
      const response = await Promise.race([
        llmClient.generate(prompt),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('LLM decomposition timeout')), 2000)
        )
      ]);

      try {
        return JSON.parse(response);
      } catch {
        // Fallback: simple decomposition
        return this.getFallbackDecomposition(goal);
      }
    } catch (error) {
      // Timeout or LLM error: use fallback
      console.warn('[GoalEngine] LLM decomposition failed, using fallback:', error.message);
      return this.getFallbackDecomposition(goal);
    }
  }

  /**
   * Fallback decomposition when LLM unavailable/timed out
   */
  private getFallbackDecomposition(goal: string): Array<{ goal: string; usefulnessScore?: number }> {
    return [
      { goal: `Research: ${goal}`, usefulnessScore: 0.7 },
      { goal: `Implement: ${goal}`, usefulnessScore: 0.8 },
      { goal: `Test: ${goal}`, usefulnessScore: 0.9 },
    ];
  }

  /**
   * Archive a completed/failed goal
   */
  private archiveGoal(goal: GoalNode, success: boolean): void {
    const archived: ArchivedGoal = {
      id: goal.id,
      goal: goal.goal,
      status: success ? 'completed' : 'failed',
      usefulnessScore: goal.usefulnessScore,
      pattern: this.extractPattern(goal.goal),
      attemptCount: goal.attempts,
      timestamp: Date.now(),
    };

    this.archive.archive(archived);
  }

  /**
   * Extract reusable pattern from goal string
   */
  private extractPattern(goal: string): string {
    const lower = goal.toLowerCase();

    if (lower.includes('fix') || lower.includes('bug')) return 'bugfix';
    if (lower.includes('optimize') || lower.includes('improve')) return 'optimization';
    if (lower.includes('test')) return 'testing';
    if (lower.includes('document')) return 'documentation';
    if (lower.includes('implement')) return 'implementation';
    if (lower.includes('explore')) return 'exploration';

    return 'general';
  }
}
