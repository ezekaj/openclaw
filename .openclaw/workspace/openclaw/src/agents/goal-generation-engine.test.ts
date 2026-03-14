/**
 * Tests for Goal Autonomy System
 */

import { describe, it, expect } from 'vitest';
import { GoalTree } from './goal-tree.js';
import { IntrinsicMotivation } from './intrinsic-motivation.js';
import { GoalArchive } from './goal-archive.js';
import { GoalGenerationEngine } from './goal-generation-engine.js';

describe('GoalTree', () => {
  it('should create root goal', () => {
    const tree = new GoalTree();
    const id = tree.addRootGoal('Test goal', 0.8);
    const goal = tree.getGoal(id);
    expect(goal).toBeDefined();
    expect(goal?.goal).toBe('Test goal');
    expect(goal?.usefulnessScore).toBe(0.8);
    expect(goal?.status).toBe('active');
  });

  it('should decompose goals', () => {
    const tree = new GoalTree();
    const rootId = tree.addRootGoal('Root goal', 0.7);
    const subgoals = tree.decompose(rootId, [
      { goal: 'Subgoal 1', usefulnessScore: 0.6 },
      { goal: 'Subgoal 2', usefulnessScore: 0.8 }
    ]);

    expect(subgoals).toHaveLength(2);
    const stats = tree.getStats();
    expect(stats.total).toBe(3); // 1 root + 2 subgoals
    expect(stats.pending).toBe(2); // 2 subgoals
  });

  it('should get next pending goal by usefulness', () => {
    const tree = new GoalTree();
    const rootId = tree.addRootGoal('Root', 0.5);
    tree.decompose(rootId, [
      { goal: 'Low priority', usefulnessScore: 0.3 },
      { goal: 'High priority', usefulnessScore: 0.9 }
    ]);

    const next = tree.getNextPendingGoal();
    expect(next?.usefulnessScore).toBe(0.9);
  });
});

describe('IntrinsicMotivation', () => {
  it('should track motivation state', () => {
    const motivation = new IntrinsicMotivation();
    const state = motivation.getState();
    expect(state.curiosity).toBe(0.5);
    expect(state.competence).toBe(0.5);
    expect(state.autonomy).toBe(0.5);
  });

  it('should update motivation on success', () => {
    const motivation = new IntrinsicMotivation();
    motivation.recordSuccess('Test task');
    const state = motivation.getState();
    expect(state.competence).toBeGreaterThan(0.5);
  });

  it('should update motivation on failure', () => {
    const motivation = new IntrinsicMotivation();
    motivation.recordFailure('Test task');
    const state = motivation.getState();
    expect(state.curiosity).toBeGreaterThan(0.5);
  });

  it('should generate intrinsic goals when thresholds exceeded', () => {
    const motivation = new IntrinsicMotivation();
    motivation.updateMotivation('curiosity', 0.8, 'Test trigger');
    const goals = motivation.generateIntrinsicGoals();
    expect(goals.length).toBeGreaterThan(0);
    expect(goals.some(g => g.includes('Explore')));
  });
});

describe('GoalArchive', () => {
  it('should archive goals', () => {
    const archive = new GoalArchive();
    archive.add({
      id: 'test-1',
      goal: 'Test goal',
      status: 'completed',
      usefulnessScore: 0.8,
      pattern: 'testing',
      attemptCount: 1,
      timestamp: Date.now()
    });

    const stats = archive.getStats();
    expect(stats.totalGoals).toBe(1);
    expect(stats.completedGoals).toBe(1);
  });

  it('should extract patterns', () => {
    const archive = new GoalArchive();
    archive.add({
      id: 'test-1',
      goal: 'Fix bug in code',
      status: 'completed',
      usefulnessScore: 0.9,
      pattern: 'bugfix',
      attemptCount: 1,
      timestamp: Date.now()
    });

    const patterns = archive.getTopPatterns();
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns[0].pattern).toBe('bugfix');
  });
});

describe('GoalGenerationEngine', () => {
  it('should create engine with config', () => {
    const engine = new GoalGenerationEngine({
      maxActiveGoals: 5,
      usefulnessThreshold: 0.6
    });
    expect(engine).toBeDefined();
  });

  it('should add external goal', () => {
    const engine = new GoalGenerationEngine();
    const id = engine.addExternalGoal('Test goal', 0.8);
    expect(id).toBeDefined();
    const treeStats = engine.getGoalTreeStats();
    expect(treeStats.total).toBe(1);
  });

  it('should integrate all components', () => {
    const engine = new GoalGenerationEngine();
    engine.addExternalGoal('Test goal', 0.7);

    const motivation = engine.getMotivation();
    expect(motivation).toBeDefined();

    const archiveStats = engine.getArchiveStats();
    expect(archiveStats).toBeDefined();

    const treeStats = engine.getGoalTreeStats();
    expect(treeStats).toBeDefined();
  });
});
