# Phantom Features Audit - 2026-03-14

**Summary:** 11 claimed features that exist as code but aren't wired or are partially implemented.

---

## 🔴 CRITICAL: Imported but Never Used

### 1. **Neuro-Memory → Evolution Integration**
- **Claimed (MEMORY.md 2026-03-08):** "Evolution service queries neuro-memory for failure patterns, success patterns, recent usage history"
- **Reality:** `evolution-service.ts` imports `getNeuroMemoryBridge` but NEVER calls it
- **Evidence:** Line 17 has import, zero usages in 451 lines
- **Impact:** Evolution runs blind—no learning from past failures
- **Fix:** Wire `queryInsights()` into `generateProposals()`

### 2. **HttpClient with Connection Pooling**
- **Claimed (MEMORY.md 2026-03-09):** "Wired HTTP client into embeddings-openai.ts, embeddings-gemini.ts"
- **Reality:** `embeddings-openai.ts` uses raw `fetch`, no HttpClient import
- **Evidence:** Line 51: `const res = await fetch(url, {...})` (not HttpClient)
- **Impact:** No connection pooling, no circuit breaker, no retry logic
- **Fix:** Replace fetch with `getHttpClient().request()`

### 3. **Memory Batch Queue**
- **Claimed (MEMORY.md 2026-03-08):** "Modified neuro-memory-bridge.ts to use batch queue transparently"
- **Reality:** `memory-batch-queue.ts` exists (193 lines) but ZERO imports anywhere
- **Evidence:** `grep -r "memory-batch-queue" src/` returns empty
- **Impact:** Every memory store = separate Python IPC call (slow)
- **Fix:** Import and wrap Python calls in `MemoryBatchQueue`

### 4. **Exec Circuit Breaker**
- **Claimed (HEARTBEAT.md):** "Circuit breaker not connected to HTTP client"
- **Reality:** `exec-circuit-breaker.ts` exists (354 lines) but not imported by exec-scheduler
- **Evidence:** Exec scheduler imports `exec-scheduler-advanced` but not circuit breaker
- **Impact:** Runaway agents can execute unlimited commands
- **Fix:** Import in `exec-scheduler.ts`, wrap command execution

---

## 🟡 PARTIAL: Exists but Not Wired to Main Flow

### 5. **Goal Autonomy System**
- **Files:** `goal-tree.ts`, `goal-generation-engine.ts`, `goal-autonomy-integration.ts`
- **Status:** Implemented (5 files, tests passing)
- **Wiring:** `initGoalAutonomy()` exists but NEVER called from gateway/cron/startup
- **Evidence:** Only referenced in `demo-goal-autonomy.ts` (demo script)
- **Impact:** Sophisticated goal system sits dormant
- **Fix:** Call `initGoalAutonomy()` in `server-cron.ts` alongside predictive service

### 6. **Event Partition Manager**
- **Claimed (MEMORY.md 2026-03-08):** "Integrated into AgentEventMesh with automatic routing"
- **Reality:** `event-partition-manager.ts` exists but not imported by event-mesh.ts
- **Evidence:** Event mesh still uses single `events` table
- **Impact:** No partitioning, queries slow down as events grow
- **Fix:** Import and initialize in `event-mesh.ts` constructor

---

## 🟢 WORKING: Properly Wired

### 7. **Predictive Service** ✅
- **Files:** `predictive-service.ts`, `predictive-integration.ts`
- **Wiring:** Imported in `server-cron.ts`, dashboard routes, server methods
- **Status:** FULLY WIRED (12 files reference it)

### 8. **Evolution Service** ✅
- **Files:** `evolution-service.ts`, `instance.ts`
- **Wiring:** Imported in `server-cron.ts`, initializes on gateway start
- **Status:** WIRED (but doesn't query neuro-memory despite import)

### 9. **Auto-Compaction** ✅
- **Files:** `auto-compact.ts`, `answer-briefing-tracker.ts`
- **Wiring:** Triggered after 10 answers (LM Studio local compaction)
- **Status:** WORKING (threshold lowered 40→10 for LM Studio)

### 10. **Neuro-Memory Bridge** ✅
- **Files:** `neuro-memory-bridge.ts`
- **Wiring:** Used by predictive service, event mesh, compaction
- **Status:** WORKING (race condition fixed 2026-03-07)

### 11. **Timer Wheel** ✅
- **Files:** `timer-wheel.ts`
- **Wiring:** Imported by `exec-scheduler.ts` for O(1) timeout management
- **Status:** WORKING

---

## Root Cause Analysis

**Pattern:** Developer creates feature file → writes tests → adds import to integration point → **never calls the functions**

Examples:
1. `evolution-service.ts` imports `getNeuroMemoryBridge` but never calls it
2. `embeddings-openai.ts` could use HttpClient but uses fetch
3. `memory-batch-queue.ts` written but never imported
4. `goal-autonomy-integration.ts` has `initGoalAutonomy()` but no caller

**Why:**
- No CI check for "imported but unused"
- Memory.md entries written before wiring complete
- Demo scripts mask the issue (goal autonomy has demo)

---

## Priority Fix Order

1. **Neuro-Memory → Evolution** (P0) - Breaks learning loop
2. **Memory Batch Queue** (P0) - Performance critical
3. **HttpClient in Embeddings** (P1) - API resilience
4. **Goal Autonomy Wiring** (P1) - Unlocks proactive behavior
5. **Exec Circuit Breaker** (P1) - Safety critical
6. **Event Partitioning** (P2) - Scalability

---

## Verification Commands

```bash
# Check if memory batch queue is used
grep -r "memory-batch-queue" src/ --include="*.ts" | grep -v test

# Check if HttpClient is used in embeddings
grep -r "HttpClient\|http-client" src/memory/

# Check if goal autonomy is initialized
grep -r "initGoalAutonomy" src/ --include="*.ts" | grep -v test | grep -v demo

# Check if neuro-memory insights are queried
grep -r "queryInsights\|getFailurePatterns" src/services/evolution/
```

---

**Lesson:** Code existing ≠ feature working. Always verify wiring, not just file existence.
