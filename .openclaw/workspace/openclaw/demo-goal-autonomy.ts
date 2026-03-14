/**
 * Demo: How Goal Autonomy Works
 *
 * This script demonstrates the end-to-end flow of goal autonomy.
 */

import { GoalGenerationEngine } from './src/agents/goal-generation-engine.js';

// Mock LLM client for demonstration
const mockLLMClient = {
  generate: async (prompt: string): Promise<string> => {
    console.log('🤖 LLM Prompt:', prompt.substring(0, 100) + '...');

    // Simulate LLM response with subgoals
    return JSON.stringify([
      { goal: "Analyze codebase for optimization opportunities", usefulnessScore: 0.8 },
      { goal: "Identify top 3 performance bottlenecks", usefulnessScore: 0.7 },
      { goal: "Generate automated test cases for critical paths", usefulnessScore: 0.9 }
    ]);
  }
};

async function demo() {
  console.log('\n🎯 Goal Autonomy Demo\n');
  console.log('='.repeat(50, '=') + '\n');

  // Create engine
  const engine = new GoalGenerationEngine({
    maxActiveGoals: 5,
    enableIntrinsicGoals: true,
  usefulnessThreshold: 0.5
  });

  console.log('📊 Initial State:');
  console.log('  - Motivation:', engine.getMotivation().getState());
  console.log('  - Archive:', engine.getArchiveStats());
  console.log('  - Goal Tree:', engine.getGoalTreeStats());

  // Step 1: Add external goal
  console.log('\n📝 Step 1: Add External Goal');
  const goalId = engine.addExternalGoal('Fix neuro-memory bugs', 0.9);
  console.log('  ✅ Goal added:', goalId);

  // Step 2: Generate and pursue goals
  console.log('\n🔄 Step 2: Generate and Pursue Goals');
  const result = await engine.generateAndPursueGoals(mockLLMClient);
  console.log('  Generated:', result.generated);
  console.log('  Active:', result.active);
  console.log('  Completed:', result.completed);
  console.log('  Failed:', result.failed);

  // Step 3: Check updated state
  console.log('\n📊 Updated State:');
  console.log('  - Motivation:', engine.getMotivation().getState());
  console.log('  - Archive:', engine.getArchiveStats());
  console.log('  - Goal Tree:', engine.getGoalTreeStats());

  // Step 4: Get proactive actions
  console.log('\n🚀 Step 3: Get Proactive Actions');
  const actions = engine.generateProactiveActions();
  console.log('  Actions:', actions);

  // Step 5: Get top patterns
  console.log('\n📚 Step 4: Get Top Patterns');
  const patterns = engine.getTopPatterns(3);
  console.log('  Patterns:', patterns.map(p => `- ${p.pattern} (${(p.successRate * 100).toFixed(1)}% success)`));

  console.log('\n✅ Demo Complete!\');

  // Show what this means
  console.log('\n📝 How It Works:');
  console.log('  1. External goal added: "Fix neuro-memory bugs"');
  console.log('  2. LLM decomposed into 3 subgoals (analyze, identify, generate tests)');
  console.log('  3. Intrinsic motivation checked (curiosity, competence, autonomy)');
  console.log('  4. Goal archived with patterns extracted');
  console.log('  5. Proactive actions generated from successful patterns');
  console.log('\n💡 Real-World Example:');
  console.log('  - User creates plan: "social-media-master-plan.md"');
  console.log('  - Engine adds as external goal');
  console.log('  - LLM decomposes: post daily, engage weekly, analyze monthly');
  console.log('  - System executes automatically without user input');
  console.log('  - Patterns learned: "daily posting increases engagement"');
  console.log('  - Future: System proactively executes similar plans');

  console.log('\n🔧 Integration Points:');
  console.log('  - Wire to neuro-memory: Store goal history');
  console.log('  - Wire to predictive engine: Prioritize goals');
  console.log('  - Wire to heartbeat: Execute on idle');
  console.log('  - Wire to tools: Actually execute goals');

  console.log('\n📈 Metrics to Track:');
  console.log('  - Goals generated per day');
  console.log('  - Goal completion rate');
  console.log('  - Average goal usefulness');
  console.log('  - Proactive actions executed');
  console.log('  - Patterns learned');
}

demo().catch(console.error);
 console.error('❌ Demo failed:', error);
 process.exit(1);
});
