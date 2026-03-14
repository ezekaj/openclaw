# Long-Running Task Handling - Critical Lesson

**Date**: 2026-03-11
**Issue**: Main session auto-compaction interrupted LinkedIn connection task (20 connections requested, stopped at 11-13 after 2 compactions)

## Root Cause
- Auto-compaction triggers at 25 answers or 167k tokens in main session
- Long browser automation tasks (>10 clicks) exceed these limits
- Compaction kills ongoing work without resumption capability

## Solution - Two-Tier Task Strategy

### Tier 1: Quick Tasks (Handle in Main Session)
- <10 browser actions
- Single-page operations
- Quick lookups/reads
- Examples: Check email, read article, send 1-2 messages

### Tier 2: Long Tasks (Spawn Sub-Agent)
- >10 browser actions
- Multi-page navigation
- Batch operations (follow 20 accounts, send 20 connections, like 50 posts)
- Examples: LinkedIn engagement blocks, Twitter growth sessions, data scraping

## Implementation Rule
```
IF task.actions > 10 OR task.includes("batch", "multiple", "X connections", "X follows"):
  → Use sessions_spawn with isolated session
  → Include progress tracking in prompt
  → Set cleanup: "keep" for audit trail
ELSE:
  → Handle in main session
```

## Example Prompts

### Wrong (Main Session)
"Send 20 LinkedIn connection requests" → Gets interrupted by compaction

### Right (Sub-Agent)
```
sessions_spawn({
  task: "Send 20 LinkedIn connection requests. Progress: Track as 'X/20 sent'. Stop if LinkedIn rate limits. Resume from last position if interrupted.",
  agentId: "main",
  cleanup: "keep"
})
```

## Vision MCP Usage
- I have browser automation with vision capabilities
- Use `browser` tool with `profile="openclaw"` for isolated browser
- For Chrome takeover: `profile="chrome"` (requires extension attached)
- Take snapshots regularly to track progress visually

## Metrics
- Compaction threshold: 25 answers / 167k tokens
- Average answer: ~2-3k tokens
- Max browser actions before compaction: ~10-15 (depends on response size)

## Action Items
1. Always estimate task complexity upfront
2. Spawn sub-agent for long tasks BEFORE starting
3. Track progress explicitly (X/20, Y/50)
4. Use vision MCP to verify state before/after
5. Set cleanup: "keep" for debugging

---

**Status**: Active learning - apply immediately
