# Compaction System Optimization - 2026-03-10

## Problem Analysis

### Current Issues
1. **Too Aggressive**: Compacts every 10 answers regardless of token count
2. **Wasteful**: Runs compaction even on small contexts (<30k tokens)
3. **No Intelligence**: Doesn't consider actual context size
4. **Inefficient**: Compacts small chunks instead of batching

### Current Flow
```
Every answer → Track count
↓
10 answers → Trigger compaction (always!)
↓
Briefing aggregation every 20 answers
```

**Result**: 1,083 compactions today - many unnecessary!

---

## Optimization Strategy

### 1. Hybrid Trigger System
Only compact when **BOTH** conditions met:
- Answer count >= threshold (25)
- Token count >= minimum (40k)

### 2. Adaptive Thresholds
Scale thresholds based on context window:
```typescript
if (contextWindow >= 1_000_000) { // Gemini 1M
  answerThreshold = 40;
  tokenThreshold = 200_000; // 20% of context
} else if (contextWindow >= 256_000) { // GLM-5
  answerThreshold = 25;
  tokenThreshold = 64_000; // 25% of context
} else { // Default 128k
  answerThreshold = 20;
  tokenThreshold = 32_000; // 25% of context
}
```

### 3. Smart Batching
Instead of compacting every 10 answers:
- Collect candidates (answers with tokens)
- Batch compact at 25+ answers or 64k+ tokens
- Single larger compaction = more efficient

### 4. Skip Small Contexts
Don't compact if:
- Token count < 30k (too small to matter)
- Session just started (<5 answers)
- Last compaction <5 minutes ago

---

## Implementation

### File: `src/agents/answer-briefing-tracker.ts`

**Changes:**
1. Add token tracking to answer count
2. Implement hybrid trigger logic
3. Add adaptive threshold calculation
4. Add cooldown period (5 min between compactions)

```typescript
// Track both answers AND tokens
interface SessionTracker {
  count: number;
  agentId: string;
  answerTexts: string[];
  totalTokens: number; // NEW: track tokens
  lastCompaction: number; // NEW: timestamp
}

// Hybrid trigger check
function shouldTriggerCompaction(
  tracker: SessionTracker,
  model: string,
  contextWindow: number
): boolean {
  // Cooldown check (5 min)
  const cooldownMs = 5 * 60 * 1000;
  if (Date.now() - tracker.lastCompaction < cooldownMs) {
    return false;
  }

  // Minimum thresholds
  if (tracker.count < 10) return false; // Too few answers
  if (tracker.totalTokens < 30_000) return false; // Too small

  // Adaptive thresholds
  const thresholds = getAdaptiveThresholds(contextWindow);
  
  // BOTH conditions must be met
  return tracker.count >= thresholds.answers && 
         tracker.totalTokens >= thresholds.tokens;
}

function getAdaptiveThresholds(contextWindow: number) {
  if (contextWindow >= 1_000_000) { // Gemini 1M
    return { answers: 40, tokens: 200_000 };
  } else if (contextWindow >= 256_000) { // GLM-5
    return { answers: 25, tokens: 64_000 };
  } else { // Default 128k-200k
    return { answers: 20, tokens: 32_000 };
  }
}
```

### File: `src/agents/compaction-thresholds.ts`

**Changes:**
1. Replace fixed 64k threshold with adaptive calculation
2. Add context window detection
3. Add percentage-based thresholds

```typescript
export function calculateAutoCompactThreshold(model: string): number {
  const contextWindow = getContextWindow(model);
  
  // Adaptive: 25% of context window
  const percentageThreshold = Math.floor(contextWindow * 0.25);
  
  // Minimum: 32k (don't trigger too early)
  const minThreshold = 32_000;
  
  // Maximum: 200k (for 1M context models)
  const maxThreshold = 200_000;
  
  return Math.max(minThreshold, Math.min(maxThreshold, percentageThreshold));
}
```

---

## Expected Improvements

### Before Optimization
- 1,083 compactions/day
- ~50% unnecessary (small contexts)
- Wasted cycles on 10-answer compactions

### After Optimization
- ~300-400 compactions/day (60-70% reduction)
- Only compact when actually needed
- Smart batching = larger, more efficient compactions

### Token Savings
- 50% fewer LLM calls for compaction
- Less context churn
- Better conversation continuity

---

## Configuration

### Disable Old System
```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "mode": "safeguard",
        "compactionModel": "openai/liquid/lfm2-24b-a2b",
        "adaptiveThresholds": true, // NEW
        "cooldownMinutes": 5, // NEW
        "minAnswersBeforeCompact": 20, // NEW
        "minTokensBeforeCompact": 30000 // NEW
      }
    }
  }
}
```

---

## Testing Plan

1. **Unit Tests**
   - Test hybrid trigger logic
   - Test adaptive threshold calculation
   - Test cooldown enforcement

2. **Integration Tests**
   - Run with real sessions
   - Monitor compaction frequency
   - Compare token savings

3. **Benchmarks**
   - Before: 1,083 compactions, ~500 unnecessary
   - After: ~350 compactions, 95% necessary
   - Goal: 60% reduction in wasted cycles

---

## Migration Path

1. **Phase 1**: Add hybrid trigger (backward compatible)
2. **Phase 2**: Enable adaptive thresholds
3. **Phase 3**: Add cooldown + smart batching
4. **Phase 4**: Monitor and tune thresholds

---

## Rollback Plan

If issues arise:
```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "adaptiveThresholds": false,
        "forceCompactAfterAnswers": 10
      }
    }
  }
}
```

---

## Next Steps

1. ✅ Analyze current bottlenecks
2. ⏳ Design hybrid trigger system
3. ⏳ Implement adaptive thresholds
4. ⏳ Add token-aware checks
5. ⏳ Test with real sessions
