# Fused Renderer Long-Term Feasibility Analysis

## Executive Summary

**Recommendation: Approach B (Flight as a library) for detection and resolution, with a new minimal serializer for props. Narrow the initial scope to synchronous server components only.**

Approach A (reimplement Flight logic in Fizz) is fragile — Flight's serialization is deeply coupled to its Request/Task/chunk model, and upstream changes at 90 commits/year would create constant maintenance burden. Approach B is viable because the two critical functions we need — client boundary detection and module reference resolution — are already pure functions with no renderer state dependencies. Props serialization is NOT extractable from Flight (it's deeply entangled), but we don't need Flight's full serializer — we need a smaller, focused one.

---

## 1. Current Flight→Fizz Contract

Today, Flight and Fizz communicate through React elements. The framework (Next.js) orchestrates:

```
Framework calls Flight.renderToReadableStream(tree, manifest)
  → Flight walks tree, resolves server components, serializes to wire format
  → Framework pipes Flight stream to client OR to Flight client for SSR

Framework calls FlightClient.createFromReadableStream(flightStream)
  → Flight client deserializes wire format back into React elements
  → These elements are passed to Fizz as children

Framework calls ReactDOM.renderToPipeableStream(flightClientOutput)
  → Fizz walks the pre-resolved React elements, emits HTML
```

**Key contract**: Fizz receives **fully resolved React elements** — no server components, no module references, just plain `<div>`, `<span>`, function components (client), and their props. Flight has already done all the RSC work.

**What the fused renderer bypasses**: The middle step. Fizz receives the original tree with server component functions and client module references still present.

## 2. Approach A vs Approach B

### Approach A: Reimplement Flight Logic in Fizz

Fizz learns to:
- Detect client boundaries (`isClientReference`)
- Resolve module references (`resolveClientReferenceMetadata`)
- Serialize props at boundaries (reimplementation of Flight's `renderModelDestructive`)
- Handle server component execution (already similar to `renderFunctionComponent`)

**What we'd reimplement:**
| Function | Lines | Complexity | Stability |
|----------|-------|-----------|-----------|
| `isClientReference()` | 3 | Trivial | Stable (5 commits/year) |
| `resolveClientReferenceMetadata()` | 30 | Low | Stable (5 commits/year) |
| `renderModelDestructive()` + value serializers | ~800 | Very High | Volatile (90 commits/year) |
| `serializeClientReference()` | 40 | Medium | Evolving |
| `emitImportChunk()` | 10 | Low | Evolving |

**Risk**: `renderModelDestructive` is 800+ lines handling 20+ value types (elements, promises, maps, sets, typed arrays, streams, iterables, taint, temporary references, client references, server references, symbols, dates, bigints, etc.). It changes frequently. Reimplementing it creates a permanent maintenance burden.

### Approach B: Flight as a Library

Fizz calls into Flight's existing code for specific capabilities:

| Capability | Flight function | Extractable? | Dependencies |
|-----------|----------------|-------------|--------------|
| Is this a client component? | `isClientReference(type)` | ✅ Yes — pure function | `Symbol.for('react.client.reference')` only |
| Get module metadata | `resolveClientReferenceMetadata(config, ref)` | ✅ Yes — pure function | `ClientManifest` (passed in) |
| Get client reference key | `getClientReferenceKey(ref)` | ✅ Yes — pure function | `ref.$$id`, `ref.$$async` |
| Is this a server reference? | `isServerReference(ref)` | ✅ Yes — pure function | `Symbol.for('react.server.reference')` only |
| Get server reference ID | `getServerReferenceId(config, ref)` | ✅ Yes — pure function | `ref.$$id` |
| Get bound args | `getServerReferenceBoundArguments(config, ref)` | ✅ Yes — pure function | `ref.$$bound` |
| Serialize arbitrary props | `renderModelDestructive()` | ❌ No — deeply coupled | `Request`, `Task`, chunk IDs, dedup maps, abort state, taint registry |

**Key finding**: Detection and resolution are trivially extractable. Serialization is not.

### Approach B+: Extractable functions + New minimal serializer

Instead of extracting Flight's full serializer, write a **focused props serializer** that handles only what appears at client boundaries:

**What client component props actually contain:**
- Primitives (string, number, boolean, null) — trivial
- Plain objects and arrays — recursive JSON
- Server component children (`children` prop) — tombstone reference to server-rendered DOM
- Server Actions (functions with `$$typeof === SERVER_REFERENCE_TAG`) — serialize as action refs
- Client references (other client components passed as props) — serialize as module refs
- Dates, undefined, NaN, Infinity, BigInt — tagged values

**What client component props almost never contain:**
- ReadableStreams, TypedArrays, Maps, Sets — these are data-fetching artifacts, not UI props
- Promises — resolved before reaching the client boundary
- Tainted values — server-only, never cross the boundary
- Temporary references — flight-specific mechanism

A focused serializer handling the common cases is ~150 lines, not ~800. Edge cases (streams, typed arrays) can throw a clear error pointing to the full Flight path for client navigation.

## 3. Assumption Inventory

### Assumptions for Approach B+ (recommended)

| # | Assumption | Stability | Evidence | Breakage scenario | Blast radius |
|---|-----------|-----------|----------|-------------------|-------------|
| 1 | Client components are marked with `Symbol.for('react.client.reference')` | **Stable** | 5 commits/yr to references file. Symbol is part of public bundler protocol. | React changes the marker symbol | Fixable: update one constant |
| 2 | Client references have `$$id` and `$$async` properties | **Stable** | Bundler protocol, documented in multiple bundler integrations | React changes the reference shape | Fixable: update property access |
| 3 | `ClientManifest` maps module IDs to `{id, chunks, name, async?}` | **Stable** | Multiple bundler implementations depend on this. Webpack, Turbopack, Parcel all use it. | React changes manifest format | Painful: update resolution + client loading |
| 4 | Fizz's `renderElement()` dispatches on `typeof type` | **Stable** | Core dispatch hasn't changed structurally in years | React rewrites Fizz dispatch | Fatal: but this would break everything, not just us |
| 5 | Fizz's Suspense machinery handles thenables via `ping`→`retry` | **Stable** | Core architecture, 8 commits/yr to hydration context | React changes Suspense internals | Painful: rework async server component handling |
| 6 | HTML comment markers are the hydration boundary protocol | **Stable** | 8 commits/yr to HydrationContext. `getNextHydratable()` skips unknown comments. | React changes to a different marker system | Painful: update markers |
| 7 | `flushCompletedQueues()` has a clear insertion point for hydration data | **Evolving** | The TODO at line 5944 suggests this is planned but not yet implemented | React implements their own hydration data emission | Painful to Fatal: our insertion point disappears or conflicts |
| 8 | Server components are "just functions" without a special marker | **Stable** | This is by design — server components are the default, client is opt-in | React adds a server component marker | Fixable: check for it |
| 9 | Server Actions use `Symbol.for('react.server.reference')` with `$$id` and `$$bound` | **Stable** | Part of the bundler protocol like client references | React changes action serialization | Fixable: update serializer |
| 10 | `renderWithHooks()` in Fizz can execute arbitrary functions | **Stable** | This is how all function components work in Fizz | React restricts what Fizz can execute | Fatal: but extremely unlikely |

### Evolving features that touch the boundary

| Feature | Status | Flight impact | Fizz impact | Our impact |
|---------|--------|--------------|-------------|-----------|
| View Transitions | Landed (RN), DOM flag on | New format context in Flight | New markers in Fizz (`pushStartViewTransition`) | Low: additive, doesn't change client boundary protocol |
| Fragment Refs | Shipped (`enableFragmentRefs: true`) | None | DOM config changes for ref handles | Low: doesn't affect boundaries |
| Activity (Offscreen) | Shipping | None | New boundary type (`<!--&-->`) | Low: parallel to Suspense, not conflicting |
| Partial Hydration | Active (`enableHydrationChangeEvent`) | None | HydrationContext changes | Medium: may change how we skip server-only DOM |
| Fizz Blocking Render | Experimental | None | Shell size limits | Low: orthogonal to fused rendering |
| Preamble System | Active (frequent commits) | None | Segment/boundary management | Medium: our boundary emission must not conflict |
| Server Actions encryption | N/A (framework-level) | Action bound args | None | Low: we serialize action refs, not decrypt |
| `enableHalt` | Cleaned up (removed) | Prerender behavior | None | None: already removed |
| `enablePostpone` | Cleaned up (removed) | Prerender behavior | None | None: already removed |

### The hydration data TODO (Assumption #7) — deep dive

The comment at `ReactFizzServer.js:5944`:
```js
// TODO: Here we'll emit data used by hydration.
```

This suggests the React team plans to emit hydration data from Fizz themselves. If they implement this, it could either:
- **Align with our approach**: They implement something similar, making our fork easier to maintain
- **Conflict with our approach**: They implement something different, and our insertion point breaks

**Mitigation**: Watch the React repo for PRs touching this TODO. If React ships their own hydration data emission, we evaluate merging their approach. This is actually the best possible outcome — it means upstream is solving the same problem.

**Detection**: A test that asserts the TODO comment still exists at the expected location. If it disappears, we know upstream has acted.

## 4. The Minimal Viable Fused Renderer

Instead of handling all cases, start with:

### Phase 1: Synchronous server components only
- Server component functions that return JSX synchronously
- No async server components (they fall back to regular Suspense)
- No streaming server component resolution
- Client boundaries with simple props (primitives, objects, arrays)
- Server Action references in props

**What this still delivers:**
- Single-pass rendering for the common case (most server components are sync)
- Elimination of Flight serialize→deserialize round-trip for sync content
- Hydration data emission at client boundaries
- Significant throughput improvement (the sync path is where most time is spent)

**What it defers:**
- Async server components (use existing Flight path as fallback)
- Complex prop types (streams, typed arrays — error with clear message)
- Nested server-in-client-in-server (the deep composition case)

### Phase 2: Async server components
- Use Fizz's existing Suspense suspension for async server components
- This is straightforward — Fizz already has the machinery

### Phase 3: Complex props and edge cases
- Expand the props serializer as needed
- Handle the server-component-children-as-client-prop case

## 5. Concrete Extraction Plan for Approach B+

### What we import from Flight (unchanged, no fork needed)

```
From packages/react-server-dom-webpack/src/ReactFlightWebpackReferences.js:
  - isClientReference(type)        → check $$typeof === CLIENT_REFERENCE_TAG
  - isServerReference(type)        → check $$typeof === SERVER_REFERENCE_TAG
  - CLIENT_REFERENCE_TAG           → Symbol.for('react.client.reference')
  - SERVER_REFERENCE_TAG           → Symbol.for('react.server.reference')

From packages/react-server-dom-webpack/src/server/ReactFlightServerConfigWebpackBundler.js:
  - resolveClientReferenceMetadata(config, ref)  → manifest lookup
  - getClientReferenceKey(ref)                    → ref.$$id + async flag
  - getServerReferenceId(config, ref)             → ref.$$id
  - getServerReferenceBoundArguments(config, ref) → ref.$$bound
```

These are all pure functions. We can import them directly or copy the ~50 total lines. They have no dependencies on Flight's renderer state.

### What we write new (in Fizz)

```
packages/react-server/src/ReactFizzHydrationData.js (~150 lines):
  - serializePropsForHydration(props, bundlerConfig)
    Handles: primitives, objects, arrays, dates, bigints, undefined, NaN, Infinity
    Handles: client references → module ref metadata
    Handles: server references → action ref with ID + bound args
    Handles: server component children → tombstone marker
    Throws on: streams, typed arrays, maps, sets (with helpful error)

packages/react-dom-bindings/src/server/ReactFizzConfigDOM.js (additions):
  - pushStartClientBoundary(chunks, id)    → <!--C:id-->
  - pushEndClientBoundary(chunks)          → <!--/C-->
  - writeClientBoundaryScript(dest, id, moduleRef, serializedProps)

packages/react-server/src/ReactFizzServer.js (modifications):
  - Request object: add fusedMode, bundlerConfig, clientBoundaryQueue
  - renderElement(): add client/server component detection before function dispatch
  - flushCompletedQueues(): emit hydration data at the TODO
```

### What we don't touch

- `ReactFlightServer.js` — untouched, still used for client navigation
- `ReactFlightClient.js` — untouched, still used for client navigation
- `ReactFiberHydrationContext.js` — separate task (TIM-477), additive only
- `ReactFiberBeginWork.js` — separate task (TIM-477), additive only

## 6. Risk Mitigation

### Automated breakage detection

Create sentinel tests that fail if upstream assumptions change:

```js
// test: client reference protocol hasn't changed
test('client references use expected symbol', () => {
  expect(Symbol.for('react.client.reference')).toBe(CLIENT_REFERENCE_TAG);
});

// test: manifest format hasn't changed
test('resolveClientReferenceMetadata returns expected shape', () => {
  const result = resolveClientReferenceMetadata(mockManifest, mockRef);
  expect(result).toHaveLength(3); // or 4 for async
  expect(typeof result[0]).toBe('string'); // module ID
  expect(Array.isArray(result[1])).toBe(true); // chunks
  expect(typeof result[2]).toBe('string'); // export name
});

// test: the hydration data TODO still exists
test('flushCompletedQueues has hydration data insertion point', () => {
  const source = fs.readFileSync('packages/react-server/src/ReactFizzServer.js', 'utf8');
  expect(source).toContain("// TODO: Here we'll emit data used by hydration.");
});
```

### Fallback path

When fusedMode is enabled but encounters an unsupported case (e.g., a complex prop type), fall back gracefully:
- Log a dev warning
- Emit the component as a regular Fizz render (no hydration data)
- The client will need a full Flight fetch for this component on navigation

This means the fused renderer is **progressive** — it handles what it can and falls back for what it can't.

## 7. Conclusion

| Criterion | Approach A | Approach B+ |
|-----------|-----------|-------------|
| Lines of Flight code reimplemented | ~900 | ~0 (import ~50 lines of pure functions) |
| New code written | ~200 (in Fizz) | ~350 (serializer + Fizz changes) |
| Maintenance burden from upstream | High (800+ lines to keep in sync) | Low (sentinel tests catch breaks) |
| Breakage from Flight changes | Frequent (90 commits/yr) | Rare (only if bundler protocol changes) |
| Feature completeness | Full | Progressive (sync first, async later) |
| Time to first measurable result | Longer | Shorter (narrower scope) |

**Approach B+ wins.** The critical insight: we don't need to reimplement Flight's serializer. We need a much smaller, focused serializer for the specific case of client boundary props. The detection and resolution functions we need are already pure functions we can call directly.

### Recommended task changes

1. **TIM-474** (server component execution): Keep as-is — this is the same in both approaches
2. **TIM-475** (client boundary detection): Simplify — use Flight's `isClientReference` directly instead of reimplementing
3. **TIM-476** (props serializer): Rewrite scope — focused serializer, not Flight extraction. Handle common types only, throw on exotic types.
4. **TIM-477** (client hydration): Keep as-is — client-side changes are independent of the approach
5. **New task**: Sentinel tests for upstream assumption monitoring
6. **New task**: Fallback path for unsupported prop types
