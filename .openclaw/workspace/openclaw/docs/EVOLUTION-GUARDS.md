# Evolution Guards - Protection System for Auto-Evolution

## What It Does

Prevents the evolution daemon from modifying critical functions while allowing safe improvements to other code.

## Three Levels of Protection

### 1. **@evolution:ignore** - Complete Protection
Function will NEVER be auto-modified. Use for:
- Core infrastructure (event mesh, memory bridge)
- Security-critical code
- Delicate systems that could break everything

```typescript
/**
 * @evolution:ignore
 * Core memory system - never auto-modify
 */
export function criticalMemoryFunction(): void {
  // This code is protected forever
}
```

### 2. **@evolution:critical** - Extra Scrutiny
Function can be modified, but requires 2x test passes. Use for:
- Important but not critical functions
- Code that could benefit from optimization
- Functions where mistakes are expensive

```typescript
/**
 * @evolution:critical
 * Important function - requires extra scrutiny
 */
export function retrieveMemories(query: string): Episode[] {
  // Evolution can improve this, but must pass tests twice
}
```

### 3. **No Tag** - Normal Evolution
Function can be modified with normal testing (1 test pass). Use for:
- Regular utility functions
- Non-critical code
- Experimental features

```typescript
export function regularFunction(): void {
  // Evolution can freely improve this with normal testing
}
```

## File-Based Protection (.evolutionignore)

Create `.evolutionignore` in your project root:

```
# Core infrastructure
src/agents/neuro-memory-bridge.ts
src/agents/event-mesh.ts

# Security-sensitive code
src/security/*.ts

# MCP servers
mcp_server.py
```

Files matching these patterns are completely blocked from evolution.

## How It Works

1. Evolution daemon generates proposal
2. **Guard check runs** (new step):
   - Scans for @evolution:ignore tags → blocks if found
   - Scans for @evolution:critical tags → requires 2x tests if found
   - Checks .evolutionignore patterns → blocks if matches
3. If blocked: logs reason, skips proposal
4. If allowed: applies patch, runs tests
5. If @evolution:critical: runs tests multiple times

## Real Examples in OpenClaw

### Protected (Never Modify)
```typescript
// src/agents/neuro-memory-bridge.ts
/**
 * @evolution:ignore - Core memory system - never auto-modify
 */
export class NeuroMemoryBridge {
  // This entire class is protected
}
```

### Critical (Extra Scrutiny)
```typescript
// src/agents/neuro-memory-bridge.ts
/**
 * @evolution:critical - Important function - requires extra test scrutiny
 */
async retrieveMemories(query: string): Promise<Episode[]> {
  // Evolution can optimize, but must pass tests twice
}
```

### Normal (Free to Evolve)
```typescript
// src/utils/helpers.ts
export function formatDate(date: Date): string {
  // Evolution can freely improve this
}
```

## Monitoring

### Check What's Protected
```bash
# Find all protected functions
grep -r "@evolution:ignore" src/
grep -r "@evolution:critical" src/

# View ignore file
cat .evolutionignore
```

### Watch Guard in Action
```bash
# Evolution daemon logs show guard decisions
tail -f /tmp/evolution-daemon.log | grep "Guard:"

# Example output:
# [Evolution Daemon] ✗ Blocked by guards:
#   - Function has @evolution:ignore tag (criticalMemoryFunction)
# [Evolution Daemon] ⚠ Critical function detected - requires 2x test passes
```

## Configuration

### Default Settings
```typescript
{
  protectedTags: ['@evolution:ignore', '@evolution:protected', '@evolution:frozen'],
  protectedPatterns: [
    '**/neuro-memory-bridge.ts',
    '**/event-mesh.ts',
    '**/evolution-*.ts',
    '**/security/*.ts',
    '**/mcp_server.py'
  ],
  criticalTestThreshold: 2,  // @evolution:critical needs 2x tests
  enabled: true
}
```

### Disable Guards (Not Recommended)
```typescript
// In evolution daemon config
{
  evolutionConfig: {
    guardConfig: {
      enabled: false
    }
  }
}
```

## Why This Matters

**Before Guards:**
- Evolution could accidentally break core systems
- No way to protect critical code
- Risk of cascade failures

**After Guards:**
- Critical systems stay safe
- Evolution focuses on safe improvements
- Multiple levels of protection
- Clear documentation of what's important

## Testing

Run the test suite:
```bash
npm test src/services/evolution/evolution-guards.test.ts
```

Tests verify:
- @evolution:ignore blocks changes
- @evolution:critical requires extra tests
- .evolutionignore patterns work
- Normal functions can evolve freely

## Architecture

```
Evolution Daemon
       ↓
[Guard Check] ← NEW
       ↓
   Allowed? ──── No → Skip proposal
       ↓ Yes
   Critical? ──── Yes → Run tests 2x
       ↓ No
  Apply patch
       ↓
 Run tests 1x
       ↓
   Pass? ──── Yes → Keep
       ↓ No
  Rollback
```

## Future Enhancements

1. **@evolution:experimental** - Only evolve in test branch
2. **@evolution:review** - Requires human approval
3. **Context-aware guards** - Protect based on dependencies
4. **Evolution budget** - Limit changes per file per week
5. **Rollback patterns** - Auto-detect bad patterns and avoid

---

**Status:** ✅ IMPLEMENTED AND WIRED

**Files:**
- `src/services/evolution/evolution-guards.ts` - Guard logic
- `src/services/evolution/evolution-daemon.ts` - Wired to use guards
- `.evolutionignore` - File-based protection
- `src/services/evolution/evolution-guards.test.ts` - Test suite

**Next:** Restart evolution daemon to activate guards
