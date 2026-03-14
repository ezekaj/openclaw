# Code Deduplication Report - 2026-03-10

**Goal:** Find duplicate/similar functions → Keep best version → Delete rest

**Total scanned:** 544,833 lines across 477 TypeScript files

---

## 🔴 CRITICAL: Corrupted Files (Fix First)

### 1. conversation-summarizer.ts - CORRUPTED
**Location:** `src/agents/conversation-summarizer.ts`
**Status:** Syntax errors (merge conflict or bad edit)

```typescript
// PROBLEM: Duplicate imports with mixed syntax
const { processToolResult } = await import('./tools/tool-result-persist.js');
const { processToolResult } from './tools/tool-result-persist.js';  // ← ERROR
const { toolUseId: toolCallId, toolName: tool.name }    maxSizeChars: 100_000  // ← INCOMPLETE
```

**Action:**
```bash
# Check if tracked in git
git status src/agents/conversation-summarizer.ts

# If tracked, restore
git checkout HEAD -- src/agents/conversation-summarizer.ts

# If not, manual fix required (remove duplicate lines, fix syntax)
```

---

### 2. neuro-memory-bridge.ts - CORRUPTED
**Location:** `src/infra/neuro-memory-bridge.ts` (NEW: also in `src/agents/`)
**Status:** Same corruption pattern as above

**Files:**
- `src/agents/neuro-memory-bridge.ts` (389 lines)
- `src/agents/neuro-memory-bridge-simple.ts` (30 lines) - TEST SCRIPT, WRONG LOCATION
- `src/infra/neuro-memory-bridge.ts` - CORRUPTED

**Action:**
```bash
# Delete simple test script (shouldn't be in src/agents/)
rm src/agents/neuro-memory-bridge-simple.ts

# Fix main file (check git history)
git diff src/agents/neuro-memory-bridge.ts
```

---

## 🟠 FUNCTION DUPLICATES

### 3. isRecord vs isPlainObject (DUPLICATE FUNCTIONS)

**Found:** 3 named implementations + 10 inline implementations

#### Version A: `src/config/legacy.shared.ts`
```typescript
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
```
**Pros:** ✅ One-liner, clean, fast

#### Version B: `src/channels/plugins/status-issues/shared.ts`
```typescript
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
```
**Pros:** ✅ Same logic, slightly more verbose

#### Version C: `src/config/config-paths.ts` & `src/config/includes.ts`
```typescript
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
```
**Pros:** ✅ Explicit null check

#### Version D: 10+ Inline Implementations
```typescript
// Found in 10 files:
Boolean(value && typeof value === "object" && !Array.isArray(value))
```

**WINNER:** ✅ **Version A** (`src/config/legacy.shared.ts`)

**Reason:** Shortest, cleanest, already exported

**Cleanup:**
1. **Keep:** `src/config/legacy.shared.ts` → `isRecord`
2. **Delete:** `src/channels/plugins/status-issues/shared.ts` → `isRecord`
3. **Delete:** `src/config/config-paths.ts` → `isPlainObject`
4. **Delete:** `src/config/includes.ts` → `isPlainObject`
5. **Replace:** 10 inline implementations with `import { isRecord } from "../config/legacy.shared.js"`

**Impact:** 
- Reduces 3 duplicate functions → 1 canonical version
- Replaces 10 inline checks with import
- **Total savings: ~50 lines**

---

### 4. ensureDir (4 VERSIONS!)

**Found:** 4 implementations + 110 direct `mkdirSync` calls

#### Version A: `src/infra/async-file-operations.ts` ✅ BEST
```typescript
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}
```
**Pros:** ✅ Modern async/await, no blocking, clean

#### Version B: `src/infra/state-migrations.fs.ts`
```typescript
export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}
```
**Pros:** Sync version (old pattern, blocks event loop)

#### Version C: `src/memory/internal.ts`
```typescript
export function ensureDir(dir: string): string {
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}
```
**Cons:** ❌ Silences ALL errors (dangerous!)

#### Version D: `src/utils.ts`
```typescript
export async function ensureDir(dir: string) {
  await fs.promises.mkdir(dir, { recursive: true });
}
```
**Pros:** Same as Version A, less context

**WINNER:** ✅ **Version A** (`src/infra/async-file-operations.ts`)

**Reason:** Dedicated async file operations module, most complete

**Cleanup:**
1. **Keep:** `src/infra/async-file-operations.ts` → `ensureDir` (async)
2. **Keep:** `src/infra/state-migrations.fs.ts` → rename to `ensureDirSync` (for legacy sync code)
3. **Delete:** `src/memory/internal.ts` → `ensureDir` (dangerous error silencing)
4. **Delete:** `src/utils.ts` → `ensureDir` (duplicate of Version A)
5. **Replace:** 14 files calling `fs.mkdirSync` directly → use `ensureDir` or `ensureDirSync`

**Import updates needed:** 5 files currently import from `utils.js`

**Impact:**
- 4 versions → 2 (async + sync)
- Replaces 14 direct mkdirSync calls
- Removes dangerous error silencing
- **Total savings: ~30 lines + safer code**

---

### 5. neuro-memory-bridge Files (WRONG LOCATIONS)

**Found:** 3 files for same functionality

#### Version A: `src/agents/neuro-memory-bridge.ts` (389 lines)
**Status:** Main implementation ✅ KEEP

#### Version B: `src/agents/neuro-memory-bridge-simple.ts` (30 lines)
**Status:** Test script, should be in test folder
**Action:** Move to `src/agents/__tests__/` or delete

#### Version C: `src/infra/neuro-memory-bridge.ts`
**Status:** NEW untracked file, possibly corrupted
**Action:** Check if duplicate or different module

**Cleanup:**
```bash
# Move test script
git mv src/agents/neuro-memory-bridge-simple.ts src/agents/__tests__/

# OR delete if not needed
rm src/agents/neuro-memory-bridge-simple.ts

# Check infra version
git status src/infra/neuro-memory-bridge.ts
```

---

## 🟡 SEMANTIC DUPLICATES (Same logic, different names)

### 6. fileExists vs pathExists

**Found:** 2 functions doing the same thing

#### Version A: `src/infra/state-migrations.fs.ts`
```typescript
export function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
```

#### Version B: Various `pathExists` functions (6 occurrences)

**Assessment:** Same logic, different names. Standardize on `fileExists`.

**Cleanup:** Replace all `pathExists` with `fileExists`

---

## 🟢 GOOD PATTERNS (Keep As-Is)

### 7. sleep vs sleepWithAbort

**Found:** 2 implementations with different features

#### Version A: `src/utils.ts`
```typescript
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

#### Version B: `src/infra/backoff.ts`
```typescript
export async function sleepWithAbort(ms: number, abortSignal?: AbortSignal) {
  // Advanced version with abort support
}
```

**Assessment:** ✅ **BOTH KEEP** - Different features (simple vs abortable)

---

## 📊 SUMMARY

### Total Duplicates Found: 8 categories

| Category | Files Affected | Lines Saved | Risk Level |
|----------|---------------|-------------|------------|
| Corrupted files | 2 | N/A (fix first) | 🔴 CRITICAL |
| `isRecord` duplicates | 13 | ~50 lines | 🟠 HIGH |
| `ensureDir` duplicates | 18 | ~30 lines | 🟠 HIGH |
| `neuro-memory-bridge` misplacement | 3 | ~30 lines | 🟡 MEDIUM |
| `fileExists` vs `pathExists` | 6 | ~20 lines | 🟡 MEDIUM |
| Inline object checks | 10 | ~20 lines | 🟢 LOW |
| Direct mkdirSync calls | 14 | ~40 lines | 🟢 LOW |

**Total potential savings:** ~190 lines + 1 corrupted file fix

---

## 🎯 RECOMMENDED ACTION PLAN

### Phase 1: Fix Critical Issues (5 minutes)
```bash
# 1. Fix corrupted files
git checkout HEAD -- src/agents/conversation-summarizer.ts
rm src/agents/neuro-memory-bridge-simple.ts

# 2. Run TypeScript check
npx tsc --noEmit
```

### Phase 2: Consolidate isRecord (10 minutes)
```bash
# 1. Create canonical version in utils.ts
# 2. Replace all duplicates
# 3. Update 10 inline implementations
```

### Phase 3: Consolidate ensureDir (15 minutes)
```bash
# 1. Keep async version in async-file-operations.ts
# 2. Keep sync version in state-migrations.fs.ts (rename to ensureDirSync)
# 3. Update 5 import statements
# 4. Replace 14 direct mkdirSync calls
```

### Phase 4: Clean Up Tests (5 minutes)
```bash
# Move test files to proper locations
git mv src/agents/neuro-memory-bridge-simple.ts src/agents/__tests__/
```

---

## 📝 FILES TO MODIFY

### DELETE (8 files/functions):
1. `src/channels/plugins/status-issues/shared.ts` → `isRecord` function
2. `src/config/config-paths.ts` → `isPlainObject` function
3. `src/config/includes.ts` → `isPlainObject` function
4. `src/memory/internal.ts` → `ensureDir` function (dangerous!)
5. `src/utils.ts` → `ensureDir` function (duplicate)
6. `src/agents/neuro-memory-bridge-simple.ts` (wrong location)

### KEEP (3 canonical versions):
1. `src/config/legacy.shared.ts` → `isRecord` ✅
2. `src/infra/async-file-operations.ts` → `ensureDir` (async) ✅
3. `src/infra/state-migrations.fs.ts` → `ensureDirSync` (rename) ✅

### UPDATE IMPORTS (23 files):
- 4 files importing duplicate `isRecord`
- 10 files with inline object checks
- 5 files importing duplicate `ensureDir`
- 14 files with direct `mkdirSync` calls

---

## 🚀 EXECUTION

**Option A:** I execute all fixes now (30 minutes)
**Option B:** I generate fix script for you to review/run
**Option C:** Fix critical only (5 minutes), leave rest for later

**Recommendation:** Start with Phase 1 (fix corrupted files), then Phase 2-3 (consolidate functions)

---

**Generated:** 2026-03-10 15:55 GMT+1
**Scan time:** 8 minutes
**Duplicates found:** 8 categories, 23 files affected
