# Neuro-Memory System Performance Analysis

## Task
Analyze this neuro-memory system code for performance bottlenecks and suggest optimizations WITH ACTUAL CODE EXAMPLES. Focus on:
1. Python mcp_server.py query_insights() method - currently scans ALL 10,000 episodes every query
2. TypeScript memory-batch-queue.ts - batch storage optimization
3. Neuro-memory bridge timeout handling
4. LM Studio embedding generation (sequential HTTP requests)

## PERFORMANCE BOTTLENECK #1: query_insights() O(n) scan

### Current Code (SLOW):
```python
# mcp_server.py lines 234-240
def query_insights(self, query_type: str = "all", time_range: Dict = None, limit: int = 10) -> Dict:
    insights = {...}
    
    # SCANS ALL EPISODES EVERY QUERY - O(10,000) iterations
    episodes_with_surprise = []
    for ep in self.memory.episodes:  # SLOW: O(n) scan
        surprise = getattr(ep, 'surprise', 0) if hasattr(ep, 'surprise') else 0
        episodes_with_surprise.append((ep, surprise))
    
    # SLOW: O(n log n) sort every query
    episodes_with_surprise.sort(key=lambda x: x[1], reverse=True)
    
    # SLOW: Linear scan for failures
    for ep, surprise in episodes_with_surprise[:limit]:
        content = getattr(ep, 'content', {}) if hasattr(ep, 'content') else {}
        if isinstance(content, dict):
            metadata = content.get("metadata", {})
            if metadata.get("type") in ["error", "failure", "bug", "issue"]:
                insights["failure_patterns"].append({...})
```

### Problem:
- Scans all 10,000 episodes on EVERY query
- Sorts all episodes on EVERY query
- Linear scans for metadata.type
- Total complexity: O(n log n) per query

## PERFORMANCE BOTTLENECK #2: Sequential LM Studio requests

### Current Code (SLOW):
```python
# mcp_server.py lines 96-108
def _get_embedding(self, content: str, provided_embedding: Optional[List[float]] = None):
    if provided_embedding is not None:
        return self._components['np'].array(provided_embedding)
    
    # SLOW: ONE HTTP REQUEST PER EMBEDDING
    response = self._components['requests'].post(
        self._components['LM_STUDIO_URL'],
        json={"input": content, "model": self._components['LM_STUDIO_MODEL']},
        headers={"Authorization": "Bearer lm-studio"},
        timeout=10
    )
    # ... process response
```

### Problem:
- Sequential HTTP requests (one per embedding)
- 100 embeddings = 100 sequential HTTP requests
- Total time: 100 * 200ms = 20 seconds

## PERFORMANCE BOTTLENECK #3: Fixed timeouts

### Current Code (INflexible):
```typescript
// neuro-memory-bridge.ts lines 373-387
private static readonly METHOD_TIMEOUTS: Record<string, number> = {
  consolidate_memories: 600000,  // Fixed 10 minutes
  store_memory: 60000,  // Fixed 1 minute
  retrieve_memories: 30000,  // Fixed 30 seconds
  get_stats: 10000,  // Fixed 10 seconds
};
```

### Problem:
- No adaptation to system load
- 10 minutes may be too short under high load
- 1 minute may be too long for simple stores

## OPTIMIZATIONS NEEDED:

### Priority 1: Pre-compute sorted episodes cache
**Goal:** O(1) access to top-N episodes by surprise
**Approach:** Maintain sorted cache, update on new episodes
**Expected improvement:** 10x faster queries (100ms → 10ms)

### Priority 2: Index episodes by metadata.type
**Goal:** O(1) lookups for failure/success patterns
**Approach:** Maintain dict mapping type → episode list
**Expected improvement:** 5x faster pattern extraction

### Priority 3: Batch LM Studio embedding generation
**Goal:** Send 100 embeddings in ONE HTTP request
**Approach:** Accumulate embeddings, flush batch to LM Studio
**Expected improvement:** 7x faster embedding generation (20s → 3s)

### Priority 4: Adaptive timeouts
**Goal:** Adjust timeouts based on system load
**Approach:** Monitor average response time, scale timeouts
**Expected improvement:** Better reliability under load

### Priority 5: Parallel embedding generation
**Goal:** Generate embeddings in parallel using ThreadPoolExecutor
**Approach:** Use concurrent.futures for parallel requests
**Expected improvement:** 4x faster (4 workers)

## REQUIRED OUTPUT FORMAT:

For each optimization, provide:

### Optimization #N: [Name]
**Priority:** High/Medium/Low
**Expected improvement:** Xx faster (Yms → Zms)

#### Before (Current Code):
```python
# Current slow code
```

#### After (Optimized Code):
```python
# Optimized code
```

#### Tradeoffs:
- [List any tradeoffs or risks]

#### Implementation notes:
- [Specific implementation details]

---

Please analyze the code and provide DETAILED code examples for each optimization. Focus on the 3 files:
1. /Users/tolga/Desktop/neuro-memory-agent/mcp_server.py
2. /Users/tolga/.openclaw/workspace/openclaw/src/agents/memory-batch-queue.ts
3. /Users/tolga/.openclaw/workspace/openclaw/src/agents/neuro-memory-bridge.ts

Be specific with line numbers, function names, and exact code changes.
