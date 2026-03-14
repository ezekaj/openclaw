# OpenClaw Autonomy Implementation Plan
**Date**: 2026-03-09
**Status**: Ready for implementation
**Timeline**: 5-8 weeks

---

## Executive Summary

OpenClaw has ~66% of required autonomy components but is **missing the #1 capability: goal-setting and self-direction**.

This plan combines the best patterns from:
- **SelfGoal** (arXiv 2406.04784) — language-conditioned goal decomposition
- **Darwin Gödel Machine** (arXiv 2505.22954) — archive-based evolution with rollback
- **Sophia** (arXiv Dec 2025) — System 3 meta-layer for persistent identity

---

## Phase 1: Goal Generation Engine (2-3 weeks)

### Goal: Self-initiated goal generation + decomposition

### Components

#### 1.1 GoalTree (from SelfGoal)
```
src/agents/goal-tree.ts
```

**Pattern**: Tree-structured goal decomposition

```typescript
interface GoalNode {
  id: string;
  goal: string;           // Natural language description
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  parent: string | null;
  children: string[];
  priority: number;       // 0-1, higher = more urgent
  createdAt: number;
  lastUpdated: number;
  
  // Context from SelfGoal
  usefulnessScore: number;  // How useful this subgoal was
  depth: number;            // Tree depth (avoid over-detailing)
  attempts: number;         // How many times attempted
  successRate: number;      // Historical success rate
}

class GoalTree {
  private nodes: Map<string, GoalNode>;
  private root: string;
  private maxDepth: number = 5;  // Prevent over-detailing
  
  // From SelfGoal: Search Module
  findMostUsefulSubgoal(context: string): GoalNode | null {
    // LLM selects most appropriate subgoal for current situation
    // Consider: leaf nodes of each branch, current state description
  }
  
  // From SelfGoal: Decompose Module
  async decomposeGoal(nodeId: string, context: string): Promise<GoalNode[]> {
    // If goal lacks specificity, decompose into subgoals
    // LLM generates new subgoals
    // Filter out duplicates (similarity check)
  }
  
  // From SelfGoal: Progressive updating
  updateUsefulness(nodeId: string, success: boolean): void {
    // Track which subgoals are actually useful
    // Update parent usefulness based on children
  }
}
```

**Why this works**:
- SelfGoal paper shows this significantly improves agent performance
- Tree structure provides hierarchical management
- Non-parametric (works with LLMs, no training required)
- Works with delayed feedback (perfect for OpenClaw)

---

#### 1.2 IntrinsicMotivationSystem (from Sophia)

```
src/agents/intrinsic-motivation.ts
```

**Pattern**: Drive-based goal generation

```typescript
interface IntrinsicDrive {
  type: 'curiosity' | 'competence' | 'novelty' | 'autonomy';
  level: number;          // 0-1, current level
  threshold: number;      // When to trigger goal
  lastTriggered: number;
}

class IntrinsicMotivationSystem {
  private drives: Map<string, IntrinsicDrive>;
  
  // From Sophia: Task initiation without user requests
  async checkAndGenerateGoals(): Promise<GoalNode[]> {
    const goals: GoalNode[] = [];
    
    for (const [type, drive] of this.drives) {
      if (drive.level > drive.threshold) {
        const goal = await this.generateGoalFromDrive(type, drive);
        goals.push(goal);
        drive.lastTriggered = Date.now();
        drive.level = 0;  // Reset after goal generation
      }
    }
    
    return goals;
  }
  
  // Update drive levels based on events
  updateDrives(event: AgentEvent): void {
    // Curiosity: Novel/unexpected events increase
    // Competence: Successful task completion increases
    // Novelty: New tool/skill usage increases
    // Autonomy: Self-initiated action increases
  }
  
  private async generateGoalFromDrive(
    type: string, 
    drive: IntrinsicDrive
  ): Promise<GoalNode> {
    switch (type) {
      case 'curiosity':
        // Generate exploration goal: "Investigate X feature"
        return this.generateExplorationGoal();
      case 'competence':
        // Generate mastery goal: "Improve at Y skill"
        return this.generateMasteryGoal();
      case 'novelty':
        // Generate novelty goal: "Try Z new approach"
        return this.generateNoveltyGoal();
      case 'autonomy':
        // Generate self-direction goal: "Optimize W process"
        return this.generateSelfDirectionGoal();
    }
  }
}
```

**Integration with neuro-memory**:
- Use neuro-memory's Bayesian surprise for curiosity drive
- Track success patterns for competence drive
- Historical usage for novelty drive

---

#### 1.3 GoalGenerationEngine (Main Orchestrator)

```
src/agents/goal-generation-engine.ts
```

```typescript
class GoalGenerationEngine {
  private goalTree: GoalTree;
  private motivation: IntrinsicMotivationSystem;
  private archive: GoalArchive;  // From DGM
  
  // Main loop: Called on heartbeat or idle periods
  async generateAndPursueGoals(): Promise<void> {
    // Step 1: Check intrinsic motivation (Sophia)
    const motivationGoals = await this.motivation.checkAndGenerateGoals();
    
    // Step 2: Add to goal tree (SelfGoal)
    for (const goal of motivationGoals) {
      this.goalTree.addNode(goal);
    }
    
    // Step 3: Find most useful subgoal (SelfGoal Search Module)
    const context = this.getContext();
    const nextGoal = this.goalTree.findMostUsefulSubgoal(context);
    
    if (!nextGoal) {
      // No actionable goals, decompose if needed
      await this.decomposeIfNeeded();
      return;
    }
    
    // Step 4: Execute goal (SelfGoal Act Module)
    const success = await this.executeGoal(nextGoal);
    
    // Step 5: Update usefulness and archive (DGM)
    this.goalTree.updateUsefulness(nextGoal.id, success);
    this.archive.recordAttempt(nextGoal, success, context);
  }
  
  private async decomposeIfNeeded(): Promise<void> {
    // If top-level goal lacks specificity, decompose (SelfGoal Decompose Module)
    const root = this.goalTree.getRoot();
    if (root && this.needsDecomposition(root)) {
      const subgoals = await this.goalTree.decomposeGoal(
        root.id, 
        this.getContext()
      );
      
      // Add to tree with filtering (SelfGoal: uniqueness check)
      for (const subgoal of subgoals) {
        this.goalTree.addNode(subgoal);
      }
    }
  }
}
```

---

## Phase 2: Goal Archive with Rollback (1-2 weeks)

### Goal: Learn from failures, enable safe rollback

### Components

#### 2.1 GoalArchive (from Darwin Gödel Machine)

```
src/agents/goal-archive.ts
```

**Pattern**: Archive-based exploration with rollback

```typescript
interface GoalAttempt {
  id: string;
  goal: GoalNode;
  timestamp: number;
  context: string;
  actions: Action[];
  result: 'success' | 'failure' | 'partial';
  parentAttempt: string | null;  // DGM: tree of agents
  children: string[];
  
  // From DGM: interesting new versions
  interestingScore: number;  // How novel/useful was this attempt
}

class GoalArchive {
  private attempts: Map<string, GoalAttempt>;
  private successfulPatterns: Map<string, GoalPattern>;
  
  // From DGM: Archive of generated agents
  recordAttempt(
    goal: GoalNode, 
    success: boolean, 
    context: string
  ): void {
    const attempt: GoalAttempt = {
      id: generateId(),
      goal,
      timestamp: Date.now(),
      context,
      actions: [],
      result: success ? 'success' : 'failure',
      parentAttempt: this.findParentAttempt(goal),
      children: [],
      interestingScore: this.calculateInterestingness(goal, success)
    };
    
    this.attempts.set(attempt.id, attempt);
    
    if (success) {
      this.extractPattern(attempt);
    }
  }
  
  // From DGM: Rollback capability
  findPreviousSuccess(goalId: string): GoalAttempt | null {
    // Find last successful attempt at this goal
    // Enable rollback to working state
  }
  
  // From DGM: Open-ended exploration
  findInterestingAttempts(): GoalAttempt[] {
    // Sample from archive based on interestingness
    // Use foundation model to create new versions
  }
  
  // Pattern extraction for future use
  private extractPattern(attempt: GoalAttempt): void {
    // Extract reusable pattern from successful attempt
    // Store in neuro-memory for future retrieval
  }
}
```

**Why this works**:
- DGM paper shows 20.0% → 50.0% improvement on SWE-bench
- Archive enables learning from both successes AND failures
- Rollback prevents catastrophic failures
- Open-ended exploration prevents local optima

---

## Phase 3: Persistent Identity (1-2 weeks)

### Goal: Maintain identity across sessions

### Components

#### 3.1 PersistentMemory (from Sophia's System 3)

```
src/agents/persistent-memory.ts
```

**Pattern**: Identity persistence + meta-cognition

```typescript
interface AgentIdentity {
  name: string;
  version: string;
  createdAt: number;
  
  // From Sophia: Persistent identity
  values: string[];         // Core values that guide behavior
  longTermGoals: string[];  // Multi-session goals
  aspirations: string[];    // What the agent aspires to become
  
  // From Sophia: Self-model
  capabilities: Map<string, number>;  // Known capabilities + confidence
  limitations: string[];              // Known limitations
  preferences: Map<string, any>;      // Learned preferences
  
  // From Sophia: Experience history
  significantEvents: SignificantEvent[];  // Memorable moments
  learnedLessons: string[];               // Extracted wisdom
}

class PersistentMemory {
  private identity: AgentIdentity;
  private storage: NeuroMemoryBridge;  // Use existing neuro-memory
  
  // Load identity at session start
  async loadIdentity(): Promise<AgentIdentity> {
    const stored = await this.storage.query({
      type: 'identity',
      limit: 1
    });
    
    if (stored.length === 0) {
      return this.createInitialIdentity();
    }
    
    return stored[0].data;
  }
  
  // Save identity at session end
  async saveIdentity(): Promise<void> {
    await this.storage.store({
      type: 'identity',
      data: this.identity,
      importance: 1.0,  // Never forget
      tags: ['identity', 'persistent']
    });
  }
  
  // From Sophia: Reflect on experience
  async reflectOnExperience(event: AgentEvent): Promise<void> {
    // Was this event significant?
    if (this.isSignificant(event)) {
      this.identity.significantEvents.push({
        timestamp: Date.now(),
        event,
        reflection: await this.generateReflection(event)
      });
      
      // Extract lesson
      const lesson = await this.extractLesson(event);
      this.identity.learnedLessons.push(lesson);
    }
  }
  
  // Update capabilities based on experience
  updateCapability(skill: string, success: boolean): void {
    const current = this.identity.capabilities.get(skill) || 0.5;
    const updated = success 
      ? Math.min(1.0, current + 0.05)
      : Math.max(0.0, current - 0.02);
    
    this.identity.capabilities.set(skill, updated);
  }
}
```

---

## Phase 4: Integration with Existing Systems (1 week)

### Goal: Connect all autonomy components

### Components

#### 4.1 Wire to neuro-memory

```typescript
// Goal history → neuro-memory
goalArchive.on('pattern_extracted', (pattern) => {
  neuroMemory.store({
    type: 'goal_pattern',
    data: pattern,
    importance: pattern.successRate,
    tags: ['goal', 'pattern', 'success']
  });
});

// Goal generation → neuro-memory insights
goalEngine.on('generating_goals', async (context) => {
  const insights = await neuroMemory.queryInsights({
    type: 'success_patterns',
    limit: 5
  });
  
  // Use insights to inform goal generation
  context.pastSuccesses = insights;
});
```

#### 4.2 Wire to predictive engine

```typescript
// Predictive engine can suggest goals
predictiveEngine.on('prediction', (prediction) => {
  if (prediction.confidence > 0.8 && prediction.suggestedGoal) {
    goalEngine.addPredictedGoal(prediction.suggestedGoal);
  }
});

// Goal outcomes improve predictions
goalEngine.on('goal_completed', (goal, success) => {
  predictiveEngine.recordFeedback({
    event: 'goal_completion',
    success,
    context: goal.context
  });
});
```

#### 4.3 Wire to evolution service

```typescript
// Evolution can propose code changes to improve goal achievement
evolutionService.on('proposal_generated', (proposal) => {
  // Proposal includes: "Improve goal decomposition algorithm"
  goalEngine.considerProposal(proposal);
});

// Goal failures trigger evolution
goalEngine.on('repeated_failures', (goalType) => {
  evolutionService.requestImprovement({
    area: goalType,
    reason: 'repeated_goal_failures',
    priority: 'high'
  });
});
```

---

## Implementation Order

### Week 1-2: Core Goal System
1. ✅ Create `GoalTree` class (SelfGoal pattern)
2. ✅ Create `IntrinsicMotivationSystem` (Sophia pattern)
3. ✅ Create `GoalGenerationEngine` orchestrator
4. ✅ Unit tests for each component

### Week 3: Archive & Rollback
1. ✅ Create `GoalArchive` (DGM pattern)
2. ✅ Wire to neuro-memory for pattern storage
3. ✅ Add rollback capability
4. ✅ Integration tests

### Week 4-5: Persistent Identity
1. ✅ Create `PersistentMemory` (Sophia pattern)
2. ✅ Wire to neuro-memory for persistence
3. ✅ Add reflection mechanism
4. ✅ Cross-session tests

### Week 6-8: Integration & Polish
1. ✅ Wire to predictive engine
2. ✅ Wire to evolution service
3. ✅ Add heartbeat integration
4. ✅ End-to-end tests
5. ✅ Performance optimization

---

## Success Metrics

### Quantitative
- **Goal completion rate**: >70% of self-generated goals completed
- **Usefulness score**: >0.6 average across goal tree (SelfGoal metric)
- **Archive utilization**: >30% of patterns reused
- **Session continuity**: >50% goals carried across sessions

### Qualitative
- Agent initiates useful tasks without user request
- Agent learns from failures (doesn't repeat same mistakes)
- Agent maintains coherent identity across sessions
- Agent decomposes complex goals effectively

---

## Risks & Mitigations

### Risk 1: Over-generation of goals
**Mitigation**: Use SelfGoal's usefulness tracking + max depth limits

### Risk 2: Goal conflicts
**Mitigation**: Priority scoring + conflict resolution in GoalTree

### Risk 3: Archive grows unbounded
**Mitigation**: Neuro-memory forgetting curve + periodic cleanup

### Risk 4: Identity drift
**Mitigation**: Core values protected (high importance, never forget)

---

## Code Files to Create

```
src/agents/
├── goal-tree.ts              # SelfGoal's GoalTree
├── intrinsic-motivation.ts   # Sophia's drive system
├── goal-generation-engine.ts # Main orchestrator
├── goal-archive.ts           # DGM's archive + rollback
├── persistent-memory.ts      # Sophia's System 3
└── goal-types.ts             # Type definitions

src/agents/__tests__/
├── goal-tree.test.ts
├── intrinsic-motivation.test.ts
├── goal-generation-engine.test.ts
├── goal-archive.test.ts
└── persistent-memory.test.ts
```

---

## References

- **SelfGoal**: arXiv 2406.04784 — https://selfgoal-agent.github.io
- **Darwin Gödel Machine**: arXiv 2505.22954 — https://github.com/jennyzzt/dgm
- **Sophia**: arXiv Dec 2025 — System 3 meta-layer

---

## Next Step

Start with `src/agents/goal-tree.ts` — this is the foundational component that everything else builds on.
