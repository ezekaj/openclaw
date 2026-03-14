/**
 * GoalArchive - Darwin Gödel Machine Pattern Implementation
 *
 * Archives goal execution history with patterns and rollback capability.
 * Based on arXiv:2505.22954 (Darwin Gödel Machine)
 */

export interface ArchivedGoal {
  id: string;
  goal: string;
  status: 'completed' | 'failed';
  usefulnessScore: number;
  pattern: string; // Extracted reusable pattern
  attemptCount: number;
  timestamp: number;
  rollbackSnapshot?: Record<string, unknown>; // State before execution
}

export interface GoalPattern {
  id: string;
  pattern: string;
  successRate: number; // 0-1
  usageCount: number;
  lastUsed: number;
  examples: string[]; // Goal examples using this pattern
}

export class GoalArchive {
  private archive: Map<string, ArchivedGoal> = new Map();
  private patterns: Map<string, GoalPattern> = new Map();
  private snapshots: Map<string, Record<string, unknown>> = new Map();

  private readonly maxArchiveSize = 1000;
  private readonly maxPatternCount = 100;

  /**
   * Archive a goal execution attempt
   */
  add(goal: ArchivedGoal): void {
    // Enforce size limit
    if (this.archive.size >= this.maxArchiveSize) {
      const oldestKey = this.archive.keys().next().value;
      this.archive.delete(oldestKey);
    }

    this.archive.set(goal.id, goal);

    // Extract and update pattern
    if (goal.pattern) {
      this.updatePattern(goal.pattern, goal.status === 'completed', goal.goal);
    }
  }

  /**
   * Get rollback snapshot for a goal
   */
  getRollbackSnapshot(goalId: string): Record<string, unknown> | undefined {
    return this.snapshots.get(goalId);
  }

  /**
   * Save rollback snapshot before goal execution
   */
  saveSnapshot(goalId: string, state: Record<string, unknown>): void {
    this.snapshots.set(goalId, state);
  }

  /**
   * Get pattern by success rate
   */
  getTopPatterns(limit = 10): GoalPattern[] {
    return Array.from(this.patterns.values())
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, limit);
  }

  /**
   * Get pattern by ID
   */
  getPattern(patternId: string): GoalPattern | null {
    return this.patterns.get(patternId) || null;
  }

  /**
   * Get archived goals by status
   */
  getArchivedGoals(status?: 'completed' | 'failed'): ArchivedGoal[] {
    const goals = Array.from(this.archive.values());
    return status ? goals.filter(g => g.status === status) : goals;
  }

  /**
   * Get similar goals (by pattern)
   */
  getSimilarGoals(pattern: string): ArchivedGoal[] {
    return Array.from(this.archive.values())
      .filter(g => g.pattern === pattern);
  }

  /**
   * Calculate pattern usefulness
   */
  calculatePatternUsefulness(pattern: string): number {
    const p = this.patterns.get(pattern);
    if (!p) return 0;

    return p.successRate * p.usageCount;
  }

  /**
   * Update pattern statistics
   */
  private updatePattern(patternName: string, success: boolean, example: string): void {
    let pattern = this.patterns.get(patternName);

    if (!pattern) {
      // Enforce pattern limit
      if (this.patterns.size >= this.maxPatternCount) {
        const worstPattern = Array.from(this.patterns.entries())
          .sort((a, b) => a[1].successRate - b[1].successRate)[0];
        this.patterns.delete(worstPattern[0]);
      }

      pattern = {
        id: `pattern_${Date.now()}`,
        pattern: patternName,
        successRate: success ? 1 : 0,
        usageCount: 1,
        lastUsed: Date.now(),
        examples: [example],
      };
      this.patterns.set(pattern.id, pattern);
    } else {
      // Update existing pattern
      const totalAttempts = pattern.usageCount;
      const currentSuccesses = pattern.successRate * totalAttempts;
      const newSuccesses = currentSuccesses + (success ? 1 : 0);

      pattern.successRate = newSuccesses / (totalAttempts + 1);
      pattern.usageCount++;
      pattern.lastUsed = Date.now();
      pattern.examples.push(example);

      // Keep only last 10 examples
      if (pattern.examples.length > 10) {
        pattern.examples = pattern.examples.slice(-10);
      }
    }
  }

  /**
   * Get archive statistics
   */
  getStats(): {
    totalGoals: number;
    completedGoals: number;
    failedGoals: number;
    totalPatterns: number;
    avgPatternSuccessRate: number;
  } {
    const goals = Array.from(this.archive.values());
    const patterns = Array.from(this.patterns.values());

    return {
      totalGoals: goals.length,
      completedGoals: goals.filter(g => g.status === 'completed').length,
      failedGoals: goals.filter(g => g.status === 'failed').length,
      totalPatterns: patterns.length,
      avgPatternSuccessRate: patterns.reduce((sum, p) => sum + p.successRate, 0) / patterns.length || 0,
    };
  }

  /**
   * Clear old archived goals (keep recent 100)
   */
  prune(maxKeep = 100): void {
    const goals = Array.from(this.archive.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);

    const toDelete = goals.slice(0, goals.length - maxKeep);
    for (const [id] of toDelete) {
      this.archive.delete(id);
      this.snapshots.delete(id);
    }
  }
}
