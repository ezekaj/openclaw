# Gemini Performance Optimization Advice - March 9, 2026

**Source**: Gemini Pro via browser at https://gemini.google.com/app

## Executive Summary

Gemini validated all bottleneck findings and provided ruthless prioritization based on ROI and stability.

## Key Recommendations

### 1. Async Python MCP vs. LRU Caches
**Verdict**: Make Async Python MCP the DEFAULT immediately.

**Reasoning**:
- 20-second blocking HTTP call is a "stop-the-world" event
- Adding LRU cache first is putting a band-aid on a broken leg
- Cache miss penalty of 20s will cause cascading timeouts
- Fix I/O bottleneck at source, then add LRU cache to reduce costs

**Strategy**: Swap to async MCP server (aiohttp/httpx), then implement LRU cache.

### 2. SQLite Connection Pooling vs. Reduced Cache
**Verdict**: Keep reduced cache (64MB), enable WAL, multiplex connections.

**Reasoning**:
- SQLite file-level locking fights with multiple connections
- 8 distinct database files = 8 connections necessary
- If multiple connections to same DB, consolidate to single connection

**Strategy**:
- Keep 64MB cache reduction ✅ (already done)
- Ensure WAL mode enabled (PRAGMA journal_mode=WAL)
- One long-lived connection per database file

### 3. Batch SQLite Writes vs. Async File I/O
**Verdict**: Focus entirely on batching via transactions.

**Reasoning**:
- Individual INSERT causes full disk sync (fsync) = 50ms per write
- Transaction (BEGIN...COMMIT) defers fsync until batch end
- Libraries like better-sqlite3 are synchronous by design for speed

**Strategy**: In-memory queue in Node.js that flushes every X ms or Y events.

## Validated Expected Improvements

### Async Python (20s → 0.2s | 100x)
**Gemini's Caveat**: Watch for API Rate Limits! 
- 100 concurrent requests will hit HTTP 429 errors
- **Need concurrency semaphore** (max 20 concurrent) in async MCP server

### Query Caching (100ms → 1ms | 100x)
**Validated**: Accurate, in-memory LRU is sub-millisecond.
**Caveat**: Ensure cache key generation isn't computationally heavy.

### Batch Writes (50ms → 5ms | 10x)
**Conservative estimate**: Will likely see better than 10x.
- 100 rows in single transaction = same 5-10ms as single row

### Cache Reduction (2GB → 512MB)
**Validated**: Confirmed by tests.

## 🚨 Critical Warning: Timer/EventEmitter Leaks

**Gemini's Assessment**: FATAL stability issue.

189 rogue timers + 118 EventEmitters = ticking clock to OOM crash.

**Impact**: 
- 512MB memory footprint will grow until crash every 4 hours
- Performance gains don't matter if process crashes

## Recommended Action Plan (Priority Order)

1. **Enable Async Python MCP** (Highest immediate UX impact)
   - 100x faster embeddings
   - Add concurrency semaphore (max 20 concurrent)
   
2. **Implement SQLite Transaction Batching** (Frees Node event loop)
   - In-memory queue
   - Flush every 100ms or 50 events
   
3. **Patch Timer/EventEmitter Leaks** (Ensures stability)
   - CRITICAL for long-running process
   - Find and fix all 189 timers + 118 EventEmitters
   
4. **Add LRU Caching** (Optimizes efficiency and cost)
   - After async MCP is stable
   - Reduces network egress

## Next Steps

- [ ] Modify neuro-memory-bridge.ts to use async MCP by default
- [ ] Add concurrency semaphore to Python async server
- [ ] Implement batch write queue for event mesh
- [ ] Audit and fix timer/EventEmitter leaks
- [ ] Add LRU cache to predictive engine
- [ ] Add LRU cache to event mesh queries

## Questions for Follow-up

Gemini offered:
1. Draft SQLite transaction batching logic for Node.js
2. Tackle tracking down Timer/EventEmitter leaks first

**Decision**: Should prioritize leak fixing (stability) before batching (performance)?
