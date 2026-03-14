# OpenClaw Architecture: 4 High-Priority Improvements

Please analyze these 4 proposed improvements to OpenClaw's core systems. For each:
1. Review the current implementation code
2. Assess pros/cons of the proposed change
3. Identify any risks or edge cases
4. Suggest the best implementation approach

---

## Feature 1: Batch Memory Storage

**Current Code** (`neuro-memory-bridge.ts`):
```typescript
// Every storeMemory call goes to Python process immediately
async storeMemory(content: string, metadata?: Record<string, unknown>): Promise<StoreResult> {
  this.ensureReady();
  return this.request("store_memory", { content, metadata }); // <--- Single Python call per store
}

// Called from event-mesh.ts on every event:
private async storeToNeuroMemory(event: AgentEvent): Promise<void> {
  if (!neuroMemory) return;
  const content = this.eventToText(event);
  try {
    const result = await neuroMemory.storeMemory(content, {...}); // <--- Sequential call
  } catch (error) { ... }
}
```

**Problem**: During high activity (many events), each `storeMemory` call spawns a Python IPC request. This can overwhelm the Python process and add latency.

**Proposed Solution**: Batch storage with debouncing
```typescript
class BatchedMemoryStore {
  private batch: Memory[] = [];
  private timer: NodeJS.Timeout | null = null;
  
  async store(memory: Memory): Promise<void> {
    this.batch.push(memory);
    if (this.batch.length >= 10) {
      await this.flush();
    } else {
      this.scheduleFlush(100); // 100ms debounce
    }
  }
  
  private async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    const batch = [...this.batch];
    this.batch = [];
    await this.neuroMemory.storeBatch(batch); // Single Python call
  }
}
```

**Questions**:
- Should batch size be configurable or adaptive?
- How to handle urgency (e.g., consolidation needs all data flushed)?
- Risk of data loss on crash with pending batch?

---

## Feature 2: Event Table Partitioning

**Current Code** (`event-mesh.ts`):
```typescript
private initializeDatabase(): void {
  this.db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      data TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at INTEGER DEFAULT (unixepoch())
    )
  `).run();

  // Indexes
  this.db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_agent_events_type 
    ON agent_events(type, timestamp)
  `).run();
}
```

**Problem**: Single unbounded table grows forever. History queries slow down as events accumulate.

**Proposed Solution**: Time-based partitioning
```typescript
// Create monthly tables
private initializeDatabase(): void {
  const now = new Date();
  const tableSuffix = `${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}`;
  
  this.db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_events_${tableSuffix} (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      data TEXT NOT NULL,
      metadata TEXT DEFAULT '{}'
    )
  `).run();
  
  // View for unified queries
  this.db.prepare(`
    CREATE VIEW IF NOT EXISTS agent_events AS
    SELECT * FROM agent_events_${tableSuffix}
  `).run();
}

// Periodic cleanup of old partitions (keep last N months)
private async pruneOldPartitions(): Promise<void> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 3); // Keep 3 months
  // Drop tables older than cutoff
}
```

**Questions**:
- SQLite doesn't support native partitioning - is view-based approach performant?
- How to handle cross-partition queries efficiently?
- Should partitioning be optional (config flag)?

---

## Feature 3: Adaptive Compaction Thresholds

**Current Code** (`answer-briefing-tracker.ts`):
```typescript
const DEFAULT_COMPACT_AFTER_ANSWERS = 40;  // Fixed threshold

function handleAgentEvent(evt: AgentEventPayload): void {
  // ... track answers ...
  
  const compactAfter = config.compactAfterAnswers || DEFAULT_COMPACT_AFTER_ANSWERS;
  if (tracker.count >= compactAfter) {  // <--- Fixed threshold
    // Trigger compaction
    if (config.onCompactNeeded) {
      void config.onCompactNeeded(sessionKey, agentId);
    }
  }
}
```

**Problem**: Fixed threshold (40 answers) doesn't account for:
- Different model context windows (GPT-4: 128k, Claude: 200k, local: 32k)
- Conversation complexity (dense vs sparse)
- Token usage patterns

**Proposed Solution**: Adaptive thresholds
```typescript
class AdaptiveCompaction {
  async shouldCompact(session: Session): Promise<boolean> {
    const model = session.model;
    const windowSize = this.getContextWindow(model);
    const used = session.tokenCount;
    const ratio = used / windowSize;
    
    // Start compaction at 70% of context window
    if (ratio > 0.7) return true;
    
    // Check semantic density (redundant content detection)
    const density = await this.calculateDensity(session);
    if (density < 0.3) return true; // Low info density
    
    // User preference
    if (session.userPreference === 'detail') {
      return ratio > 0.85; // Compact later for detail lovers
    }
    
    return false;
  }
  
  private getContextWindow(model: string): number {
    const windows: Record<string, number> = {
      'gpt-4': 128000,
      'claude-3': 200000,
      'local-7b': 32000,
    };
    return windows[model] || 128000;
  }
}
```

**Questions**:
- How to calculate "semantic density" efficiently?
- Should this replace or supplement the answer count threshold?
- Risk of over-compaction losing important context?

---

## Feature 4: Parallel Tool Execution

**Current Code**: Tools are executed one at a time through the event system
- `handleToolExecutionStart` → `handleToolExecutionEnd` per tool
- No explicit parallel execution in OpenClaw code
- pi-agent-core library handles execution (not visible here)

**Problem**: When LLM requests multiple independent tools (e.g., read 3 files), they execute sequentially, adding latency.

**Proposed Solution**: Dependency-aware parallel execution
```typescript
class ParallelToolExecutor {
  async executeTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const graph = this.buildDependencyGraph(toolCalls);
    const results = new Map<string, ToolResult>();
    
    // Process in topological batches (independent tools in parallel)
    for (const batch of graph.topologicalBatches()) {
      const batchResults = await Promise.all(
        batch.map(call => this.executeWithRetry(call, results))
      );
      
      for (const [id, result] of batchResults) {
        results.set(id, result);
      }
    }
    
    return toolCalls.map(c => results.get(c.id));
  }
  
  private buildDependencyGraph(calls: ToolCall[]): DependencyGraph {
    // Detect dependencies:
    // - write(file) → read(file) = dependent
    // - exec(cmd) → exec(cmd with output) = dependent
    // - read(file1), read(file2) = independent
    
    const graph = new DependencyGraph();
    for (const call of calls) {
      const deps = this.detectDependencies(call, calls);
      graph.add(call.id, deps);
    }
    return graph;
  }
}
```

**Questions**:
- How to detect dependencies reliably without false positives/negatives?
- What's the max parallelism (Promise.all limit)?
- How to handle failures in parallel batch (cancel others? continue?)?

---

## Summary

Please provide for each:
1. **Feasibility**: Easy/Medium/Hard to implement
2. **Risk Level**: Low/Medium/High (what could break)
3. **Priority**: Which should be done first
4. **Implementation Sketch**: Key classes/functions needed
5. **Edge Cases**: What to watch out for
