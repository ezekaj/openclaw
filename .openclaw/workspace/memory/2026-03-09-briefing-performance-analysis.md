# 2026-03-09 Briefing/Compaction Performance Analysis

## Issues Identified

### 1. Tool Analytics Database Corruption (FIXED ✅)
**Problem**: Schema creation failing, tables not created
- Database file: `~/.openclaw/tool-analytics.db`  
- Error: "no such table: tool_analytics_facts"
- **Root Cause**: CREATE TABLE + CREATE INDEX in single exec() call failing silently
- **Fix**: Split into separate exec() calls
- **Status**: Fixed in tool-analytics-olap.ts

### 2. Neuro-Memory Bridge Not Starting (INVESTIGATING)
**Problem**: Python MCP server process dies after startup
- Symptoms: "Neuro-memory-agent not running. Call start() first."
- PID file exists (33151) but process doesn't run
- Logs show: `neuro-memory=connected` at startup
- **Status**: Python process crashing, need to check stderr logs

### 3. PyTorch Dependency (FIXED ✅)
**Problem**: Python MCP server importing PyTorch (2GB dependency)
- Error: "No module named 'torch'"
- **Fix**: Created numpy-only Bayesian surprise engine
- File: `/Users/tolga/Desktop/neuro-memory-agent/src/surprise/bayesian_surprise_numpy.py`
- **Status**: ✅ Working (tested with `python3 -c "from src.surprise import BayesianSurpriseEngine"`)

## Performance Analysis

### Briefing System Flow
1. **Every Answer** → Briefing write to JSON file (`~/.openclaw/briefings/`)
2. **Every 25 Answers** → Auto-compact triggered
3. **Memory Batching** → Collect 10 items, flush every 2s
4. **Event Mesh** → Persist to SQLite + emit to neuro-memory

### Current Load
- Answer tracking: ~15 answers in this session
- Compaction threshold: 25 answers (34% fewer calls)
- Briefing writes: ~1 per answer (to JSON)
- Event emissions: ~1 per answer + 1 per tool execution

### Bottlenecks
1. **Sync file writes** - Every answer writes to briefing JSON
2. **Database schema failures** - Tool analytics failing on every tool call
3. **Neuro-memory down** - Memory batching retries on every flush

## Recommendations

### Short-term (Do Now)
1. ✅ Fix tool-analytics schema creation (DONE)
2. 🔄 Debug neuro-memory Python crash (IN PROGRESS)
3. ⚡ Disable tool-analytics OLAP if not needed (reduce noise)

### Medium-term (Next Session)
1. Make briefing writes async (don't block agent response)
2. Batch briefing writes (collect 5-10 answers before write)
3. Add neuro-memory health check (restart if process dies)

### Long-term (Architecture)
1. Event-sourced briefings (append-only log, not JSON rewrites)
2. SQLite for briefings (not JSON files)
3. Proper process supervision for Python MCP server

## Test Commands
```bash
# Check tool-analytics database
sqlite3 ~/.openclaw/tool-analytics.db "SELECT name FROM sqlite_master WHERE type='table';"

# Test numpy surprise engine
cd /Users/tolga/Desktop/neuro-memory-agent
python3 -c "from src.surprise import BayesianSurpriseEngine; print('✅ Works')"

# Check neuro-memory process
ps aux | grep "python.*mcp_server"
cat /tmp/neuro-memory-mcp.pid

# Monitor live logs
tail -f /tmp/openclaw/openclaw-2026-03-09.log | grep -E "neuro-memory|tool-analytics|briefing"
```

## Status Summary
- **PyTorch**: ✅ Fixed (numpy-only version)
- **Tool Analytics**: ✅ Fixed (schema creation)
- **Neuro-Memory**: 🔄 Investigating (process crash)
- **Briefing Performance**: 📊 Analyzed (recommendations provided)
