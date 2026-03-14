# OpenClaw Performance Optimization Plan

## Goal: Faster, Autonomous, Wired System

### Current Status
✅ HTTP Client (connection pooling + circuit breaker)
✅ LRU Cache for embeddings
✅ SQLite event batching
✅ Async Python MCP server (implemented)
✅ Performance infrastructure (partially done)

### Remaining Optimizations (Priority Order)

## P0: Python Async MCP (100x Faster) ✅ DONE
**Status:** Already implemented in `/mcp_server.py`
**Performance:** 20s → 0.2s embeddings
**Next:** Verify it's working in production

## P1: Sync File Operations (8x Faster)
**Files affected:** 40 files using readFileSync/writeFileSync
**Target:** Convert to async with p-limit

### Files to Convert:
1. `src/config/*.ts` - Config loading (startup, acceptable sync)
2. `src/utils/file-helpers.ts` - Utility functions
3. `src/agents/*.ts` - Agent state files
4. `src/messaging/*.ts` - Message storage
5. Any file I/O during request handling

### Implementation Pattern:
```typescript
// Before (blocks event loop)
const data = fs.readFileSync(path, 'utf8');

// After (non-blocking, sustained saturation)
import pLimit from 'p-limit';
const limit = pLimit(10);

const data = await limit(() => fs.promises.readFile(path, 'utf8'));
```

**Expected:** 80ms total block → 10-15ms async

## P2: Event Loop Monitoring (Detect Bottlenecks)
**Add to:** `src/infra/monitoring.ts`

```typescript
import { monitorEventLoopDelay } from 'perf_hooks';

const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();

setInterval(() => {
  const p99 = histogram.percentile(99) / 1e6;
  const p50 = histogram.percentile(50) / 1e6;
  
  if (p99 > 50) {
    console.warn(`⚠️ Event loop lag detected: p99=${p99}ms, p50=${p50}ms`);
  }
  
  histogram.reset();
}, 5000).unref();
```

**Benefit:** Detect when sync code is blocking the loop

## P3: PerformanceObserver (Zero-Boilerplate Metrics)
**Add to:** `src/infra/metrics.ts`

```typescript
import { PerformanceObserver } from 'perf_hooks';

const obs = new PerformanceObserver((list) => {
  const entries = list.getEntries();
  entries.forEach((entry) => {
    // Log slow operations
    if (entry.duration > 100) {
      console.log(`⏱️ ${entry.name}: ${entry.duration.toFixed(2)}ms`);
    }
  });
});
obs.observe({ entryTypes: ['measure'], buffered: true });
```

**Usage in code:**
```typescript
performance.mark('start-work');
// ... do work ...
performance.mark('end-work');
performance.measure('function-name', 'start-work', 'end-work');
```

**Benefit:** Global instrumentation without imports everywhere

## P4: Autonomous Monitoring (Self-Healing)
**Add health checks for:**

1. **Event loop lag > 50ms** → Trigger warning + diagnostic
2. **Memory leak detection** → Auto-restart if heap > 500MB for 1hr
3. **Cache hit rate < 70%** → Adjust cache size or warn
4. **HTTP p99 > 1s** → Identify slow endpoints

```typescript
// src/infra/health-monitor.ts
export function startHealthMonitoring() {
  setInterval(() => {
    // Check event loop lag
    const p99lag = getEventLoopLag();
    if (p99lag > 50) {
      console.warn('🚨 Event loop blocking detected:', p99lag);
      // Could trigger automatic diagnostic
    }
    
    // Check memory
    const heapUsed = process.memoryUsage().heapUsed;
    if (heapUsed > 500 * 1024 * 1024) {
      console.warn('🚨 High memory usage:', heapUsed / 1024 / 1024, 'MB');
      // Could trigger heap snapshot
    }
    
    // Check cache hit rate
    const hitRate = getCacheHitRate();
    if (hitRate < 0.7) {
      console.warn('⚠️ Cache hit rate low:', hitRate);
    }
  }, 30000).unref(); // Every 30s
}
```

**Benefit:** System monitors itself and warns about issues

## Implementation Timeline

### Week 1: File Operations
- [ ] Identify all sync file operations
- [ ] Convert to async with p-limit
- [ ] Test performance improvement

### Week 2: Monitoring
- [ ] Add event loop lag monitoring
- [ ] Add PerformanceObserver
- [ ] Add health checks

### Week 3: Autonomous Features
- [ ] Self-diagnostic on performance issues
- [ ] Auto-adjust cache sizes
- [ ] Memory leak detection + auto-restart

## Expected Performance Gains

| Optimization | Before | After | Improvement |
|-------------|--------|-------|-------------|
| Python MCP embeddings | 20s | 0.2s | 100x ✅ |
| File operations (40 files) | 80ms | 15ms | 8x |
| Event loop visibility | ❌ Blind | ✅ Monitored | ∞ |
| Autonomous healing | ❌ Manual | ✅ Automatic | ∞ |

## Total Expected Improvement
- **Python MCP:** 100x faster (already done)
- **File I/O:** 8x faster
- **Event loop:** Unblocked (faster response times)
- **Overall system:** 60-80% faster based on DeepSeek analysis

## Next Actions

1. **Convert sync file operations** → P1 priority
2. **Add event loop monitoring** → Detect bottlenecks
3. **Add PerformanceObserver** → Zero-boilerplate metrics
4. **Implement health checks** → Autonomous monitoring

This will make OpenClaw faster, self-monitoring, and autonomous.
