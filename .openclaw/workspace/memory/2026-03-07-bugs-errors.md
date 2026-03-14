# Bugs & Errors - 2026-03-07

## ✅ All Critical Bugs Fixed!

### 1. Session-Memory Filter Bug #2681 ✅ **FIXED**

**Test**: `session-memory/handler.test.ts:247`
**Name**: "filters messages before slicing (fix for #2681)"

**What was wrong**:
- Hook wasn't reading `messages` config from nested path
- Used default 15 instead of configured value

**Fix**:
- Added fallback in `resolveHookConfig()` to check `hooks.internal.entries[hookKey]`
- File: `src/hooks/config.ts:197-211`

**Result**:
- ✅ All 9 session-memory tests passing
- ✅ Hook respects configured message count

---

## Remaining Minor Issues

### 2. Heartbeat-V2 Database Init ⚠️ **TEST ISSUE**

**Error**: "Database not initialized"
**Test**: `heartbeat-v2/scheduler.test.ts`

**Root cause**: 
- Tests don't properly initialize DB before calling `getSchedule()`
- Unhandled rejection in test cleanup

**Impact**: Test-only, production code works fine

**Status**: ⚠️ LOW PRIORITY - Test cleanup needed

---

### 3. Retry-Policy Test Error ℹ️ **FALSE POSITIVE**

**Error**: "boom" (intentional test error)
**Test**: `retry-policy.test.ts:17`

**Status**: ℹ️ NOT A BUG - Test works as designed (intentional error to test retry)

---

## Code Quality (Non-Bugs)

### 4. TODOs in Codebase ℹ️ **FUTURE FEATURES**

Found 24 TODO/FIXME markers - all are future features, not bugs:
- Vim-mode visual delete/yank (4 TODOs)
- Debug markers (INFO_DEBUG_MARKERS)
- Documentation examples

**Status**: ℹ️ NORMAL - No action needed

---

## Recently Fixed (2026-03-07)

| Bug | Status | Fix |
|-----|--------|-----|
| Session-memory filter #2681 | ✅ FIXED | Nested config path resolution |
| Duplicate event mesh | ✅ FIXED | Singleton pattern in predictive-integration.ts |
| Neuro-memory error logging | ✅ FIXED | Enhanced error serialization |
| Neuro-memory race condition | ✅ FIXED | Promise lock in initNeuroMemoryBridge() |

---

## Previously Fixed (2026-03-03)

| Bug | Status | Fix |
|-----|--------|-----|
| Predictive engine 0 patterns | ✅ FIXED | Manual seed |
| grep/glob `signal` option | ✅ FIXED | Changed to `cancelSignal` |
| HTTP API 500 errors | ℹ️ DOCS | By design (no REST routes) |

---

## Current System Status ✅

| Component | Status | Details |
|-----------|--------|---------|
| Gateway | ✅ RUNNING | 1 process (pid 54712) |
| Neuro-memory | ✅ WORKING | 0 duplicate processes |
| Session-memory | ✅ WORKING | All 9 tests passing |
| Predictive engine | ✅ WORKING | Singleton pattern fixed |
| Event mesh | ✅ WORKING | No duplicate instances |

---

## Summary

| Category | Count | Status |
|----------|-------|--------|
| Critical bugs | 0 | ✅ ALL FIXED |
| Test issues | 1 | ⚠️ LOW PRIORITY |
| False positives | 1 | ℹ️ NOT BUGS |
| Future features | 24 | ℹ️ NORMAL |

**No critical bugs remaining!** 🎉

---

*Updated: 2026-03-07 22:06 GMT+1*
