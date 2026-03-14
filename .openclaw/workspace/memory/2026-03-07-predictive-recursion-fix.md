# Predictive Integration Infinite Recursion Fix

**Date:** 2026-03-07
**Bug:** Maximum call stack size exceeded on gateway startup

## Stack Trace
```
RangeError: Maximum call stack size exceeded
at initPredictiveIntegration
at ensureInitialized
at getEventMesh
at initPredictiveIntegration (loop)
```

## Root Cause

Two functions named `getEventMesh` in `predictive-integration.ts`:

1. **Import** from `event-mesh.js` (line 28) - the singleton getter
   ```ts
   import { getEventMesh, ... } from "./event-mesh.js";
   ```

2. **Local export** (line 248) - calls `ensureInitialized()`
   ```ts
   export function getEventMesh(): AgentEventMesh | null {
     ensureInitialized();  // <-- triggers recursion
     return eventMesh;
   }
   ```

When `initPredictiveIntegration()` called `getEventMesh(meshConfig)` at line 155, JavaScript resolved it to the LOCAL function (which shadowed the import), causing:

```
initPredictiveIntegration → getEventMesh (local) → ensureInitialized → initPredictiveIntegration → ...
```

## Fix

Renamed the import to avoid shadowing:

```ts
// Before
import { AgentEventMesh, getEventMesh, ... } from "./event-mesh.js";

// After
import { AgentEventMesh, getEventMesh as getSingletonEventMesh, ... } from "./event-mesh.js";
```

And updated the call site:

```ts
// Before (line 155)
eventMesh = getEventMesh(meshConfig);

// After
eventMesh = getSingletonEventMesh(meshConfig);
```

## Commits

1. `fix: export createPredictiveDb for predictive-service`
2. `fix: rename import to avoid shadowing local getEventMesh function`

## Lesson Learned

Avoid naming local exports the same as imports - JavaScript will resolve to the local binding, not the import. Use explicit aliases for imports when there's a naming conflict.
