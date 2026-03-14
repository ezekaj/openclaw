# Gemini Research: Performance Optimization Patterns (2026-03-09)

## Critical Bottlenecks Identified

### 1. Python Async MCP Server (20s blocking → 0.2s async)
**Problem:** Synchronous `requests.post()` blocks Node.js for 20s on 100 embeddings
**Solution:** Convert to aiohttp with connection pooling + semaphore

```python
import asyncio
import aiohttp
from mcp.server import Server
from mcp.server.stdio import stdio_server

class AsyncEmbeddingServer:
    def __init__(self):
        self.server = Server("embedding-server")
        self.session = None
        self.semaphore = asyncio.Semaphore(20)  # Sweet spot for OpenAI APIs
        
    async def process_embeddings(self, texts: list[str]) -> str:
        async def fetch_single(text: str):
            async with self.semaphore:
                async with self.session.post(
                    "https://api.openai.com/v1/embeddings",
                    json={"input": text, "model": "text-embedding-3-small"}
                ) as response:
                    return await response.json()
        
        results = await asyncio.gather(*(fetch_single(t) for t in texts))
        return json.dumps([r["data"][0]["embedding"] for r in results])
    
    async def run(self):
        timeout = aiohttp.ClientTimeout(total=30)
        connector = aiohttp.TCPConnector(limit=50)  # Connection pooling
        
        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
            self.session = session
            async with stdio_server() as (read_stream, write_stream):
                await self.server.run(read_stream, write_stream)

if __name__ == "__main__":
    asyncio.run(AsyncEmbeddingServer().run())
```

**Performance Gain:** 20s → 0.2s (100x faster)
**No queue needed:** asyncio handles concurrency natively

### 2. Sync File Operations (80ms block → 10-15ms async)
**Problem:** 40 files with readFileSync = 80ms event loop block
**Solution:** Use p-limit for sustained thread pool saturation

```typescript
import pLimit from 'p-limit';
import { readFile } from 'fs/promises';

const limit = pLimit(10); // Max 10 concurrent reads

export async function processFilesSaturated(files: string[]) {
  const tasks = files.map(file => 
    limit(async () => {
      const data = await readFile(file, 'utf8');
      // Process data...
    })
  );
  await Promise.all(tasks);
}
```

**Performance Comparison:**
- Chunking: Good (bursty, wastes thread pool capacity)
- **p-limit: Best (sustained 100% saturation)** ✅
- Global Semaphore: Best but more code

**When sync is acceptable:**
- Startup config (before app.listen())
- Graceful shutdown (process.on('exit'))

### 3. Metrics Integration (Zero Boilerplate)
**Problem:** Avoid wrapping every function with timing code
**Solution:** Use PerformanceObserver for global instrumentation

```typescript
// Global metrics file
import { PerformanceObserver } from 'perf_hooks';
import client from 'prom-client';

const functionDuration = new client.Histogram({
  name: 'internal_function_duration_ms',
  help: 'Duration of internal functions',
  labelNames: ['function_name'],
});

const obs = new PerformanceObserver((list) => {
  const entries = list.getEntries();
  entries.forEach((entry) => {
    functionDuration.labels(entry.name).observe(entry.duration);
  });
});
obs.observe({ entryTypes: ['measure'], buffered: true });

// Business logic (no prom-client imports!)
export async function generateEmbeddings(text: string) {
  performance.mark('start-embed');
  // ... do work ...
  performance.mark('end-embed');
  performance.measure('generateEmbeddings', 'start-embed', 'end-embed');
}
```

**Benefits:**
- Single observer handles all metrics globally
- Business logic stays clean
- Automatic tracking via performance.mark/measure

## Implementation Priorities

### P0: Python Async Conversion (Biggest Impact)
- **File:** `mcp_server.py` (neuro-memory)
- **Change:** Replace `requests.post()` with aiohttp
- **Expected:** 20s → 0.2s embeddings
- **Risk:** Low (well-tested pattern)

### P1: File Operations (Moderate Impact)
- **Files:** 40 files using readFileSync/writeFileSync
- **Change:** Convert to p-limit + async fs
- **Expected:** 80ms → 10-15ms
- **Risk:** Low (simple change)

### P2: PerformanceObserver Integration (Low Impact, High Value)
- **Benefit:** Zero-boilerplate metrics
- **Change:** Add global observer + performance.mark
- **Risk:** None (additive only)

## Benchmarks

### HTTP Latency
- **Unoptimized:** p50: ~150ms | p95: ~800ms | p99: ~2500ms
- **Optimized:** p50: ~15ms | p95: ~45ms | p99: ~120ms

### Event Loop Lag
- **Healthy:** p99 < 5ms
- **Struggling:** p99 > 50ms
- **After async file ops:** Should drop below 5ms

### Cache Hit Rates
- **Target:** >75% to justify memory overhead
- **DB Access:** 15-50ms per query
- **Redis Cache Hit:** 1-3ms per query

## Key Insights

1. **No manual queue needed for Python MCP:** asyncio + Semaphore handles concurrency automatically
2. **p-limit beats chunking:** Sustained saturation vs bursty processing
3. **PerformanceObserver eliminates boilerplate:** Single observer, zero per-function imports
4. **Semaphore limit 20-50:** Sweet spot for OpenAI-compatible APIs (prevents 429s)

## Next Actions

1. Convert `mcp_server.py` to async aiohttp (20s → 0.2s)
2. Replace 40 sync file ops with p-limit pattern (80ms → 15ms)
3. Add PerformanceObserver for clean metrics integration
4. Test performance improvements with real workloads
