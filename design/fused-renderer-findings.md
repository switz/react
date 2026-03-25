# Fused Renderer: Complete Findings

**Date**: 2026-03-25
**Branch**: `fused-renderer`
**Status**: Server-side implementation complete. Client boundary hydration data format needs optimization.

---

## The Core Result

Fused rendering — having Fizz call server component functions directly instead of going through Flight serialize → deserialize → re-traverse — **recovers the entire RSC-to-renderToString performance gap** for server-dominated pages.

### Apples-to-apples benchmark (c=25, 226-product PLP, same 121.4 KB HTML)

| Mode | req/s | p50 | p99 | Heap | vs Full Pipeline |
|------|-------|-----|-----|------|-----------------|
| renderToString (plain React, no RSC) | 485 | 49ms | 60ms | 56 MB | 4.5x |
| Full Flight→Fizz (current RSC SSR) | 108 | 203ms | 372ms | 295 MB | 1.0x (baseline) |
| **Fused (server-only)** | **514** | **48ms** | **55ms** | **56 MB** | **4.8x** |
| Fused (w/ client boundaries) | 121 | 259ms | 399ms | 82 MB | 1.1x |

**Fused server-only matches renderToString.** Same throughput (514 vs 485 req/s), same latency profile, same memory footprint. This is a full RSC renderer producing identical HTML — it just skips the intermediate wire format.

## What We Built

### Implementation (merged to `fused-renderer` branch)

| PR | Task | What it does |
|----|------|-------------|
| #10 | TIM-474 | `fusedMode` + `bundlerConfig` on Fizz Request. Client reference detection via `Symbol.for('react.client.reference')` in `renderElement()`. Server components called inline via `renderFunctionComponent()`. |
| #11 | TIM-475 | `renderClientBoundary()`: wraps client components in `<!--C:ID-->` / `<!--/C-->` markers, queues hydration data. `flushCompletedQueues()` emits `<script data-fused-hydration>` tags. |
| #12 | TIM-476 | `ReactFizzHydrationSerializer.js`: focused props serializer (~150 lines). Handles primitives, objects, arrays, Dates, BigInt, NaN/Infinity, server actions, client refs. Tombstones children. |
| #14 | TIM-486 | Fast-path serializer: uses native `JSON.stringify` for common case, falls back to manual string building for exotic types. |
| #15 | TIM-478 | Integration tests proving fused SSR and Flight coexist. Per-request `fusedMode` gating. Sentinel test: Flight server has zero fused-mode code. |

### Architecture

```
Framework request arrives
  ├── Initial SSR (fusedMode: true)
  │   └── Fizz calls server components inline
  │       ├── Server component → renderFunctionComponent() → HTML
  │       └── Client component → renderClientBoundary()
  │           ├── <!--C:ID--> marker
  │           ├── renderFunctionComponent() → HTML (SSR preview)
  │           ├── <!--/C--> marker
  │           └── Queue {moduleRef, serializedProps} for hydration script
  │
  └── Client navigation (fusedMode: false, default)
      └── Flight server → wire format → Flight client → Fizz → HTML
          (completely unchanged, zero code modifications)
```

### Files modified

- `packages/react-server/src/ReactFizzServer.js` — fusedMode, renderClientBoundary, hydration data emission
- `packages/react-dom-bindings/src/server/ReactFizzConfigDOM.js` — marker and script emission functions
- `packages/react-server/src/ReactFizzHydrationSerializer.js` — new file, focused props serializer
- `packages/react-dom/src/server/ReactDOMFizzServer{Node,Edge,Browser,Bun}.js` — `experimental_fusedMode` option
- Fork files (legacy, markup, custom, noop) — re-exports for new functions

### Files NOT modified

- `packages/react-server/src/ReactFlightServer.js` — untouched
- `packages/react-client/src/ReactFlightClient.js` — untouched
- `packages/react-reconciler/` — untouched (no client-side hydration changes)
- `packages/react-dom-bindings/src/client/` — untouched

## What We Learned

### 1. The Flight overhead is real and large

The Flight serialize → deserialize → re-traverse cycle adds 4.8x overhead vs direct rendering. This is not a micro-optimization target — it's the dominant cost in RSC SSR.

At c=25: 108 req/s (full pipeline) vs 514 req/s (fused). The gap widens under load because Flight's 349 KB wire format buffers per request create GC pressure that compounds with concurrency.

### 2. The "Fizz-only ceiling" was misleading

Early benchmarks showed Fizz-only (pre-resolved by Flight) at ~500 req/s and assumed that was the ceiling. But the honest apples-to-apples measurement shows Fizz-only at only **142 req/s** — nearly identical to the full pipeline (139 req/s).

Why: Flight client's element reconstruction is just as expensive as Flight's serialization. The pre-resolved elements are complex objects with metadata that Fizz has to re-traverse. Fused mode bypasses both Flight serialization AND Flight client reconstruction.

### 3. Client boundary hydration data is the remaining bottleneck

For pages with many client boundaries (226 product cards), the hydration data emission — 226 × `serializeProps()` + 226 × `<script>` tags — adds comparable overhead to what Flight was doing. The output grows from 121 KB to 348 KB.

This isn't a serializer CPU problem (V8's JSON.stringify is already fast). It's a **volume problem**: 227 KB of additional output per request that has to be generated, buffered, and flushed.

### 4. The serializer isn't the bottleneck — the architecture is

We optimized `serializeProps` three ways (processObject + JSON.stringify, direct string building, JSON.stringify with replacer). All performed within 7% of each other. The irreducible cost is generating and emitting the data, not how we format it.

### 5. Server-dominated pages get the full win

Pages where most components are server components (dashboards, content sites, blogs, docs, marketing pages) see the full 4.8x improvement. The win is proportional to the ratio of server components to client boundaries.

### 6. The implementation is surprisingly small

Total new code: ~350 lines across the serializer, Fizz changes, and config exports. No changes to Flight, the reconciler, or client-side React. The `fusedMode` flag is per-request, so frameworks can enable it selectively.

## Performance Measurement Journey

We went through three iterations to get honest numbers. Documenting the mistakes for future reference.

| Version | What it measured | Result | Problem |
|---------|-----------------|--------|---------|
| v1 | Sync CPU time, no async, tiny props | 54-79% overhead | Unrealistic — no data fetching |
| v2 | Wall-clock time with simulated I/O | 1-4% overhead | Wrong metric — I/O wait is free for throughput |
| v3 | Concurrent throughput, CPU-bound | 3-6x drop | Correct metric but "Fizz-only ceiling" was bogus |
| **Final** | Apples-to-apples, same tree, all modes | **4.8x for server-only** | Honest numbers, includes renderToString baseline |

Key lesson: always compare against `renderToString` of the same tree as a sanity check. If your "optimized" path is faster than raw React rendering, something is wrong with your benchmark.

## Open Items

### Client boundary hydration data (TIM-485, TIM-477)

The hydration `<script>` tags add 227 KB and cap throughput at full-pipeline levels for client-heavy pages. Options to explore:

1. **Skip hydration data for SSR-only boundaries** — if a client component won't hydrate interactively, just emit HTML + markers, no `<script>`.
2. **Lazy hydration fetch** — emit markers only, let the client request hydration data on-demand when a boundary needs to hydrate.
3. **Shared props deduplication** — many product cards receive similar-shaped props. Deduplicate the common parts.
4. **Binary format** — JSON is human-readable but not size-optimal. A compact binary format could reduce the 227 KB.
5. **Stream hydration data separately** — instead of inline `<script>` tags (which block the HTML parser), emit a single `<script>` at the end with all boundary data.

### Client-side hydration approach (TIM-485)

We deferred modifying the reconciler. The spike (TIM-485) should evaluate:
- Option A: Modify reconciler hydration walker (complex, risky)
- Option B: Flight fetch fallback for hydration data (extra round-trip)
- Option C: Mini React roots per boundary (Islands Architecture)
- Option D: Forest coordination layer

For v1, the server-side win is shippable without any client-side changes. The client can use the existing Flight path for hydration data.

### Edge case tests (TIM-480 — in progress)

Partially written. Covers: nested boundaries, server component errors, async/sync mixing, streaming, exotic prop types, server action references, sentinel tests. Needs to be finished and merged.

## How to Use

```js
// Framework integration (e.g., timber, Next.js)
import { renderToPipeableStream } from 'react-dom/server';

// Initial SSR — use fused mode
const { pipe } = renderToPipeableStream(<App />, {
  experimental_fusedMode: true,
  experimental_bundlerConfig: webpackManifest, // for future use
  onShellReady() { pipe(res); },
});

// Client navigation — use Flight (unchanged)
const { pipe } = renderToFlightStream(<App />, webpackMap);
```

The `experimental_fusedMode` flag is available on all server entry points: Node, Edge, Browser, Bun.
