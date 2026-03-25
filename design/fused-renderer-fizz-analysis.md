# Fizz Internals Analysis for Fused Renderer

Analysis of `packages/react-server/src/ReactFizzServer.js` and
`packages/react-dom-bindings/src/server/ReactFizzConfigDOM.js` to identify
insertion points for the fused single-pass renderer.

## 1. renderElement() Dispatch Table

Location: `ReactFizzServer.js:2917`

`renderElement(request, task, keyPath, type, props, ref)` dispatches on `type`:

| Type check | Handler | Notes |
|---|---|---|
| `typeof type === 'function'` + `shouldConstruct(type)` | `renderClassComponent()` | Class components with `isReactComponent` |
| `typeof type === 'function'` (else) | `renderFunctionComponent()` | **All function components go here — server components would too** |
| `typeof type === 'string'` | `renderHostElement()` | DOM elements (`div`, `span`, etc.) |
| `type === REACT_FRAGMENT_TYPE` | `renderNodeDestructive(props.children)` | Fragments, also StrictMode, Profiler, LegacyHidden |
| `type === REACT_ACTIVITY_TYPE` | `renderActivity()` | Activity (offscreen) |
| `type === REACT_SUSPENSE_LIST_TYPE` | `renderSuspenseList()` | SuspenseList ordering |
| `type === REACT_VIEW_TRANSITION_TYPE` | `renderViewTransition()` | View transitions (feature-flagged) |
| `type === REACT_SCOPE_TYPE` | `renderNodeDestructive(props.children)` | Scope API (feature-flagged) |
| `type === REACT_SUSPENSE_TYPE` | `renderSuspenseBoundary()` | **Suspense — key for async server components** |
| `type.$$typeof === REACT_FORWARD_REF_TYPE` | `renderForwardRef()` | ForwardRef wrappers |
| `type.$$typeof === REACT_MEMO_TYPE` | `renderMemo()` | Memo wrappers |
| `type.$$typeof === REACT_CONTEXT_TYPE` | `renderContextProvider()` | Context.Provider |
| `type.$$typeof === REACT_CONSUMER_TYPE` | `renderContextConsumer()` | Context.Consumer |
| `type.$$typeof === REACT_LAZY_TYPE` | `renderLazyComponent()` | Lazy loading |
| Otherwise | **throw** | "Element type is invalid" |

### Key observation for fused renderer

Today, `typeof type === 'function'` catches **all** function components. Fizz has no concept of "server component" vs "client component" — Flight resolves everything before Fizz sees it. In fused mode, we need to distinguish:

1. **Server component**: function without `'use client'` module reference → call it inline
2. **Client component**: function with module reference → render to HTML + emit hydration data
3. **Plain function component**: regular component (neither server nor client) → render as today

The detection mechanism will depend on how the bundler marks client components (typically via `$$typeof` on the module reference or a special property). See TIM-472 flight analysis for details.

## 2. Request Object Shape

Location: `ReactFizzServer.js:366` (opaque type), `ReactFizzServer.js:517` (RequestInstance constructor)

### Fields

```
Request {
  // Output
  destination: null | Destination       // The writable stream we flush to
  flushScheduled: boolean               // Whether a flush is pending

  // Configuration (immutable after creation)
  resumableState: ResumableState        // Tracks what instructions have been sent (deduplication)
  renderState: RenderState              // Precomputed chunks, script prefixes, boundary prefixes
  rootFormatContext: FormatContext       // HTML/SVG/MathML context for the root
  progressiveChunkSize: number          // Target chunk size for streaming (~12.8KB default)

  // Lifecycle state
  status: OPENING | OPEN | ABORTING | CLOSING | CLOSED | STALLED_DEV
  fatalError: mixed                     // Set when a fatal error occurs

  // Task tracking
  nextSegmentId: number                 // Auto-incrementing ID for new segments
  allPendingTasks: number               // Total pending tasks (when 0, connection can close)
  pendingRootTasks: number              // Pending tasks in the root/shell (when 0, shell is done)
  abortableTasks: Set<Task>             // All tasks that can be aborted
  pingedTasks: Array<Task>              // High-priority tasks to work on next (the work queue)

  // Output queues (flushed in priority order)
  completedRootSegment: null | Segment  // The root segment, once completed
  completedPreambleSegments: null | Array<Array<Segment>>  // Preamble segments (head content)
  byteSize: number                      // Accumulated shell bytes
  clientRenderedBoundaries: Array<SuspenseBoundary>  // Errored boundaries → client render
  completedBoundaries: Array<SuspenseBoundary>       // Done boundaries → stream replacement
  partialBoundaries: Array<SuspenseBoundary>         // Partially done → stream segments

  // Prerender tracking
  trackedPostpones: null | PostponedHoles  // Non-null during prerender to track holes

  // Callbacks
  onError: (error, errorInfo) => ?string
  onAllReady: () => void                // All tasks done (good for static generation)
  onShellReady: () => void              // Shell/root done (good for streaming start)
  onShellError: (error) => void         // Shell failed
  onFatalError: (error) => void         // Unrecoverable

  // Form state
  formState: null | ReactFormState      // For MPA form submission hydration
}
```

### Lifecycle

1. **OPENING** (10): Created, initial work scheduled via `scheduleMicrotask`
2. **OPEN** (11): First `scheduleWork` callback fired
3. **ABORTING** (12): `abort()` called, tasks are being torn down
4. **CLOSING** (13): All tasks done, flushing final output
5. **CLOSED** (14): Done, destination closed

### Where to add fused renderer state

A `fusedMode: boolean` flag on Request would gate the new behavior. Additionally:
- `clientBoundaryQueue: Array<{id, moduleRef, serializedProps}>` for hydration data
- `nextClientBoundaryId: number` for generating boundary IDs

These would be added to RequestInstance constructor and the Request opaque type.

## 3. Task/Segment Model

### Task types

Two task types share the `Task` union:

**RenderTask** — produces HTML into a Segment:
```
RenderTask {
  replay: null                          // null = render mode (not replay)
  node: ReactNodeList                   // The React node being rendered
  childIndex: number                    // Position within parent's children
  ping: () => void                      // Callback to re-queue this task
  blockedBoundary: Root | SuspenseBoundary  // The Suspense boundary this renders into
  blockedSegment: Segment               // The segment being written to
  blockedPreamble: null | PreambleState // Preamble state for head content
  hoistableState: null | HoistableState // Hoistable resources (stylesheets, etc.)
  abortSet: Set<Task>                   // Which abort set this belongs to
  keyPath: Root | KeyNode               // React element key path
  formatContext: FormatContext           // HTML/SVG/MathML rendering context
  context: ContextSnapshot              // React context state
  treeContext: TreeContext               // ID generation tree context
  row: null | SuspenseListRow           // SuspenseList row tracking
  componentStack: ComponentStackNode    // For error messages
  thenableState: null | ThenableState   // Saved thenable state for resumption
  legacyContext: LegacyContext           // Legacy context (being removed)
}
```

**ReplayTask** — replays a prerendered tree (used for resume):
- Same shape but `replay: ReplaySet` (non-null) and `blockedSegment: null`

### Segment

```
Segment {
  status: PENDING | COMPLETED | FLUSHED | ABORTED | ERRORED | POSTPONED | RENDERING
  parentFlushed: boolean                // Can this be flushed (parent already sent)?
  id: number                            // Lazily assigned segment ID
  index: number                         // Position within parent's chunks
  chunks: Array<Chunk | PrecomputedChunk>  // THE HTML OUTPUT BUFFER
  children: Array<Segment>              // Child segments (from Suspense boundaries)
  preambleChildren: Array<Segment>      // Preamble child segments
  parentFormatContext: FormatContext     // Context when this segment was created
  boundary: null | SuspenseBoundary     // Associated boundary (for fallback segments)
  lastPushedText: boolean               // Text separator tracking
  textEmbedded: boolean                 // Text separator tracking
}
```

### How they interact

1. `createRequest()` creates a root Segment and a root RenderTask pointing at it
2. The task is pushed to `request.pingedTasks`
3. `performWork()` iterates `pingedTasks`, calling `retryTask()` on each
4. `retryTask()` → `retryRenderTask()` → `retryNode()` → `renderNodeDestructive()` → `renderElement()`
5. HTML chunks are pushed into `segment.chunks` via `pushStartInstance()` / `pushEndInstance()`
6. When a Suspense boundary is encountered, new child Segments and Tasks are created
7. When a Task completes, `finishedSegment()` and `finishedTask()` update counters
8. When all tasks for a boundary complete, it moves to `completedBoundaries`
9. `flushCompletedQueues()` writes segments to the destination stream

## 4. Suspense Boundary Flow (suspend → resolve → stream)

Location: `ReactFizzServer.js:1337` (`renderSuspenseBoundary`)

### Normal render path (not prerender)

1. **Create boundary**: `createSuspenseBoundary()` — tracks pending tasks, completed segments
2. **Create segments**: 
   - `boundarySegment` — holds the fallback content (child of parent segment)
   - `contentRootSegment` — holds the actual content (independent)
3. **Try to render content synchronously**:
   - Temporarily swap `task.blockedBoundary` and `task.blockedSegment` to the new boundary/segment
   - Call `renderNode(request, task, content, -1)`
   - If it succeeds without suspending → boundary is COMPLETED immediately
   - If the boundary is small enough, skip creating the fallback entirely (early return)
4. **If content throws a thenable** (suspends):
   - Caught in `renderNode()` catch block (~line 4268)
   - `spawnNewSuspendedRenderTask()` creates a new task for the suspended subtree
   - New task gets a new child segment, registered with the boundary
   - The thenable's `.then(ping, ping)` ensures the task is re-queued when resolved
5. **Create fallback task**: Always created (unless early return), queued to `pingedTasks`
6. **When suspended content resolves**:
   - `ping()` → `pingTask()` → pushes task to `pingedTasks`
   - Next `performWork()` calls `retryRenderTask()` on it
   - Rendering continues from where it left off (same node, same context)
   - On completion: `finishedSegment()` + `finishedTask()` 
7. **When boundary completes**:
   - `finishedTask()` decrements `boundary.pendingTasks`
   - When it reaches 0: boundary moves to `completedBoundaries` queue
   - `flushCompletedQueues()` writes a streaming `<script>` instruction to replace the fallback

### Streaming replacement mechanism

In `flushCompletedQueues()` (line 5831):
1. **Root segment**: Flushed first (the shell HTML)
2. **Client-rendered boundaries**: `writeClientRenderBoundaryInstruction()` — tells client to render fallback
3. **Completed boundaries**: `writeCompletedBoundaryInstruction()` — replaces fallback with content
4. **Partial boundaries**: `writeCompletedSegmentInstruction()` — streams individual segments

The streaming instructions are inline `<script>` tags that call runtime functions:
- `$RC(boundaryId, segmentId)` — replace completed boundary
- `$RS(segmentId, placeholderId)` — complete a segment
- `$RX(boundaryId, ...)` — client-render a boundary (error case)

### Key insight for fused renderer

Fizz already handles async components via this same mechanism. When a server component
returns a Promise in fused mode, we can treat it exactly like any other suspension:
the task suspends, a new task is spawned, the promise's resolution pings the task.
**No new concurrency model needed.**

## 5. The Hydration Data TODO

Location: `ReactFizzServer.js:5944`

```js
// Allow anything written so far to flush to the underlying sink before
// we continue with lower priorities.
completeWriting(destination);
beginWriting(destination);

// TODO: Here we'll emit data used by hydration.

// Next we emit any segments of any boundaries that are partially complete
// but not deeply complete.
```

This TODO sits between:
- **Completed boundaries** (high priority — full boundary replacements)
- **Partial boundaries** (low priority — individual segment streaming)

This is the **exact insertion point** for emitting client boundary hydration data.
The fused renderer would:

1. Iterate `request.clientBoundaryQueue`
2. For each entry, write an inline `<script>` tag containing:
   - The client boundary ID
   - The module reference (chunk URL + export name)
   - The serialized props
3. Clear the queue

This interleaving is correct: hydration data should be emitted after boundary
HTML is in place but can be lower priority than full boundary completions.

## 6. How Components Are Called

Location: `ReactFizzServer.js:2346` (`renderWithHooks`)

```js
function renderWithHooks(request, task, keyPath, Component, props, secondArg) {
  const prevThenableState = task.thenableState;
  task.thenableState = null;
  prepareToUseHooks(request, task, keyPath, componentIdentity, prevThenableState);
  let result = Component(props, secondArg);  // <-- THE CALL
  return finishHooks(Component, props, result, secondArg);
}
```

`renderFunctionComponent()` calls `renderWithHooks()` then passes the result to
`finishFunctionComponent()` which calls `renderNodeDestructive()` on the returned elements.

For server components in fused mode, we'd use the same `renderWithHooks` mechanism
(it handles hook state, thenable resumption, etc.) but the component function is the
server component itself rather than a pre-resolved element tree.

If the server component uses `async/await`, it returns a Promise. This throws a
`SuspenseException` via the `use()` hook mechanism or is caught as a thenable in
`renderNode()`'s catch block. Either way, Fizz's existing suspension machinery handles it.

## 7. Entry Points for Fused Renderer Changes

### In ReactFizzServer.js

1. **Request object** (line 366): Add `fusedMode`, `clientBoundaryQueue`, `nextClientBoundaryId`
2. **renderElement()** (line 2917): Before the `typeof type === 'function'` check, add:
   - If `fusedMode` and type has module reference → client component path
   - If `fusedMode` and type is plain function → server component path (call inline)
   - The existing `renderFunctionComponent` already handles calling functions and processing results
3. **flushCompletedQueues()** (line 5944, the TODO): Emit hydration data scripts
4. **createRequest()** (line 555): Initialize fused mode fields

### In ReactFizzConfigDOM.js

1. **New marker functions**: `pushStartClientBoundary()` / `pushEndClientBoundary()`
   - Similar to existing Suspense boundary markers (`<!--$-->` / `<!--/$-->`)
   - Would emit `<!--client:ID-->` / `<!--/client:ID-->`
2. **New script emitter**: `writeClientBoundaryScript()`
   - Similar to `writeCompletedBoundaryInstruction()` 
   - Emits `<script>` with module ref + serialized props

### What does NOT change

- The Flight server (`ReactFlightServer.js`) — still used for client navigation
- Server Actions — unchanged
- Suspense streaming — additive, no modifications to existing flow
- The reconciler — client-side changes are in a separate task (TIM-477)
