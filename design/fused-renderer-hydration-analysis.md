# Client-Side Hydration Markers and DOM Walking Analysis

Analysis of the hydration system across:
- `packages/react-dom-bindings/src/client/ReactFiberConfigDOM.js` (DOM-level marker recognition)
- `packages/react-reconciler/src/ReactFiberHydrationContext.js` (hydration cursor/walker)
- `packages/react-reconciler/src/ReactFiberBeginWork.js` (hydration dispatch in beginWork)
- `packages/react-dom-bindings/src/server/ReactFizzConfigDOM.js` (server-side marker emission)

## 1. HTML Comment Markers Emitted by Fizz

Fizz emits HTML comment nodes as boundary markers. These are the complete set:

### Suspense markers

| Marker | Constant | Meaning |
|--------|----------|---------|
| `<!--$-->` | `SUSPENSE_START_DATA = '$'` | Completed Suspense boundary start |
| `<!--$?-->` | `SUSPENSE_PENDING_START_DATA = '$?'` | Pending (not yet resolved) boundary |
| `<!--$~-->` | `SUSPENSE_QUEUED_START_DATA = '$~'` | Queued for reveal by Fizz runtime |
| `<!--$!-->` | `SUSPENSE_FALLBACK_START_DATA = '$!'` | Client-rendered fallback boundary |
| `<!--/$-->` | `SUSPENSE_END_DATA = '/$'` | Suspense boundary end (shared by all states) |

### Activity markers

| Marker | Constant | Meaning |
|--------|----------|---------|
| `<!--&-->` | `ACTIVITY_START_DATA = '&'` | Activity (offscreen) boundary start |
| `<!--/&-->` | `ACTIVITY_END_DATA = '/&'` | Activity boundary end |

### Form state markers

| Marker | Constant | Meaning |
|--------|----------|---------|
| `<!--F!-->` | `FORM_STATE_IS_MATCHING = 'F!'` | useActionState match |
| `<!--F-->` | `FORM_STATE_IS_NOT_MATCHING = 'F'` | useActionState non-match |

### Segment/boundary streaming markers

Fizz also emits hidden `<div>` and `<template>` elements for streaming:
- `<div hidden id="S:0">...</div>` — hidden segment content (streamed late)
- `<template id="B:0"></template>` — pending boundary placeholder
- `<template data-rci="" data-bid="..." data-sid="..."></template>` — boundary completion data
- `<template data-dgst="..." data-msg="..."></template>` — error info for client-rendered boundaries

## 2. How `hydrateRoot()` Walks the DOM

### Entry point

`hydrateRoot()` → `createRoot()` with hydration flag → `beginWork()` on HostRoot
→ `enterHydrationState()` in `ReactFiberHydrationContext.js:162`

### State machine

The hydration walker maintains:
```
hydrationParentFiber: Fiber  — deepest fiber involved in hydration
nextHydratableInstance: HydratableInstance  — next DOM node to try matching
isHydrating: boolean  — whether we're currently in hydration mode
rootOrSingletonContext: boolean  — in root/singleton (skip mismatches)
```

### Walking algorithm

1. **Enter hydration**: `enterHydrationState(fiber)` sets `nextHydratableInstance` to the first child of the container
2. **For each fiber in beginWork**: The reconciler calls `tryToClaimNextHydratableInstance(fiber)` which:
   - Gets `nextHydratableInstance`
   - Calls `canHydrateInstance()` to see if the DOM node matches the fiber type
   - If match: claims it (`fiber.stateNode = instance`), advances cursor to first child
   - If no match: throws `HydrationMismatchException`
3. **Pop hydration**: `popHydrationState(fiber)` in completeWork:
   - Checks for unhydrated tail nodes (extra DOM the server sent)
   - Advances cursor to next sibling: `getNextHydratableSibling(fiber.stateNode)`
4. **Special handling for Suspense/Activity**:
   - `tryHydrateSuspense()` — recognizes comment nodes as Suspense boundaries
   - Creates a dehydrated fragment fiber, does NOT step into children on first pass
   - Later re-enters to hydrate the content (selective hydration)

### `getNextHydratable()` — what's considered hydratable

Location: `ReactFiberConfigDOM.js:4114`

```js
function getNextHydratable(node) {
  for (; node != null; node = node.nextSibling) {
    const nodeType = node.nodeType;
    if (nodeType === ELEMENT_NODE || nodeType === TEXT_NODE) break;
    if (nodeType === COMMENT_NODE) {
      const data = node.data;
      if (data === '$' || data === '$!' || data === '$?' || data === '$~'
          || data === '&'
          || data === 'F!' || data === 'F') {
        break;  // This is a hydratable boundary marker
      }
      if (data === '/$' || data === '/&') {
        return null;  // End marker — we've reached the boundary end
      }
    }
    // Skip other comment nodes (unknown markers, etc.)
  }
  return node;
}
```

**Key insight**: Unknown comment markers are silently skipped. This means we can
add new marker types (like `<!--client:ID-->`) and they won't break existing
hydration — they'll just be skipped until we add explicit handling for them.

## 3. Suspense Boundary Hydration Flow

### Server side (Fizz)

1. Fizz emits `<!--$-->` before the Suspense content
2. Content HTML follows
3. Fizz emits `<!--/$-->` after the content
4. If the content wasn't ready, Fizz emits `<!--$?--><template id="B:0"></template>` instead, then streams the replacement later via `<script>$RC("B:0","S:0")</script>`

### Client side (hydration)

1. `beginWork` hits a `SuspenseComponent` fiber
2. `mountDehydratedSuspenseComponent()` is called (line 2914 in BeginWork)
3. If the DOM has `<!--$-->` (completed): schedule OffscreenLane hydration
4. If the DOM has `<!--$!-->` (fallback): schedule DefaultLane (need to client-render)
5. `tryHydrateSuspense()` in HydrationContext:
   - Calls `canHydrateSuspenseInstance()` — looks for comment node that isn't Activity
   - Creates `SuspenseState` with `dehydrated: suspenseInstance`
   - Creates a dehydrated fragment fiber as child
   - Sets `nextHydratableInstance = null` (won't step into children yet)
6. Later, selective hydration re-enters:
   - `reenterHydrationStateFromDehydratedSuspenseInstance()`
   - Gets first hydratable child within the Suspense instance
   - Hydrates the subtree

### Key: dehydrated fragments

When a Suspense boundary is encountered during hydration, React does NOT
immediately hydrate its children. Instead it:
1. Creates a `DehydratedFragment` fiber pointing to the DOM comment
2. Leaves the DOM in place (it's already correct from SSR)
3. Schedules re-entry at a lower priority (selective/progressive hydration)

This is the exact pattern the fused renderer's client boundaries should follow.

## 4. Where Client Boundary Markers Would Plug In

### New marker format

Following the existing convention (single-char or short-string comment data):

| Marker | Proposed data | Meaning |
|--------|--------------|---------|
| `<!--C:0-->` | `'C:' + id` | Client boundary start (with hydration data ID) |
| `<!--/C-->` | `'/C'` | Client boundary end |

Alternative: use a single-char prefix like `'@0'` / `'/@'` to be more compact.

### Server side changes (ReactFizzConfigDOM.js)

Add alongside existing Suspense marker definitions:
```js
const CLIENT_BOUNDARY_START_1 = stringToPrecomputedChunk('<!--C:');
const CLIENT_BOUNDARY_START_2 = stringToPrecomputedChunk('-->');
const CLIENT_BOUNDARY_END = stringToPrecomputedChunk('<!--/C-->');
```

New functions:
```js
export function pushStartClientBoundary(chunks, id) { ... }
export function pushEndClientBoundary(chunks) { ... }
export function writeClientBoundaryScript(destination, id, moduleRef, props) { ... }
```

### Client side changes (ReactFiberConfigDOM.js)

1. **`getNextHydratable()`** — add `'C:'` prefix check to the comment data matching:
   ```js
   if (data.startsWith('C:')) break;  // Client boundary marker
   if (data === '/C') return null;     // Client boundary end
   ```

2. **New function `canHydrateClientBoundary()`**:
   ```js
   export function canHydrateClientBoundary(instance, inRootOrSingleton) {
     const hydratableInstance = canHydrateHydrationBoundary(instance, inRootOrSingleton);
     if (hydratableInstance !== null && hydratableInstance.data.startsWith('C:')) {
       return hydratableInstance;
     }
     return null;
   }
   ```

3. **New function `getClientBoundaryId()`** — extract ID from `'C:<id>'`

### Reconciler changes (ReactFiberHydrationContext.js)

Add `tryHydrateClientBoundary()` following the pattern of `tryHydrateSuspense()`:
- Recognize the comment marker
- Create a state object with `{ dehydrated, moduleRef, serializedProps }`
- Create a dehydrated fragment fiber as child
- Set `nextHydratableInstance = null` (don't step into children on first pass)

### BeginWork changes (ReactFiberBeginWork.js)

Add a new case or extend the existing `SuspenseComponent` handling for client
boundaries. Options:

1. **New fiber tag**: `ClientBoundaryComponent` — cleanest but most invasive
2. **Extend SuspenseComponent**: Add a `clientBoundary` flag to SuspenseState — less invasive but conflates concepts
3. **Use a wrapper component**: A special component type that the fused renderer emits, handled in `beginWork` — most isolated

Option 3 is recommended for the fork: minimal changes to core reconciler code,
easier to maintain as upstream React evolves.

## 5. What "Skip Server-Only DOM" Means

In the fused renderer, server components produce HTML that has no corresponding
client-side component. During hydration, this HTML should be:

1. **Left in place** — the DOM is already correct from SSR
2. **Not reconciled** — no fiber is created for server-only DOM between client boundaries
3. **Cursor advanced past** — the hydration walker skips these nodes

This is analogous to how dehydrated Suspense boundaries work:
- The DOM exists from the server
- React creates a dehydrated fragment (lightweight placeholder)
- The actual DOM nodes are not individually matched to fibers
- When re-entering hydration later, only client boundary subtrees are hydrated

The key difference: Suspense boundaries eventually hydrate their full subtree.
Client boundaries in the fused renderer hydrate ONLY the client component tree,
permanently skipping server-only DOM.

### Implementation approach

Between two client boundary markers, the hydration walker would:
1. Encounter `<!--C:0-->` — enter client boundary mode
2. Load the module, deserialize props
3. Hydrate the client component subtree (creating fibers, matching DOM)
4. When reaching `<!--/C-->` — exit, advance cursor past the end marker
5. Continue to next hydratable node (which might be another `<!--C:1-->` or regular DOM)

Server-only DOM between `<!--/C-->` of one boundary and `<!--C:1-->` of the next
would be handled by the parent fiber's `popHydrationState` — it sees extra DOM
nodes it doesn't expect but since they're between boundaries, the parent can
skip them. This may require adjusting the "unhydrated tail nodes" warning logic.

## 6. Progressive/Selective Hydration Compatibility

React's selective hydration (hydrating boundaries on demand when the user
interacts with them) works by:

1. Initial pass: create dehydrated fragment fibers for all Suspense boundaries
2. Schedule low-priority hydration for each
3. If user interacts with a boundary, bump its priority

Client boundaries in the fused renderer should integrate with this:
- Client boundaries are treated as independently hydratable units
- Each can hydrate on its own schedule (lazy module loading)
- User interaction with a client boundary bumps its hydration priority
- Server-only DOM between boundaries never hydrates (no fibers needed)

This aligns perfectly with the existing infrastructure. The main addition is
the module loading step: before hydrating a client boundary, load its module
via dynamic import, then create the element with deserialized props and hydrate.
