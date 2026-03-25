# Fused Renderer: Complete Findings

**Date**: 2026-03-25
**Branch**: `fused-renderer`
**Status**: Server-side implementation complete. 2.6–3.2x throughput improvement validated.

---

## The Core Result

Fused rendering — having Fizz call server component functions directly instead of going through Flight serialize → deserialize → re-traverse — delivers a **2.6–3.2x throughput improvement** for RSC SSR under concurrent load, with full props serialization for client hydration.

### Concurrent throughput (226-product PLP, single Node.js thread)

| c | Full Pipeline | Fused (w/ client boundaries) | Improvement |
|---|-------------|---------------------------|-------------|
| 1 | 127 req/s | **330 req/s** | **2.6x** |
| 10 | 106 req/s | **274 req/s** | **2.6x** |
| 25 | 98 req/s | **292 req/s** | **3.0x** |
| 50 | 89 req/s | **285 req/s** | **3.2x** |

### Per-request breakdown (c=1)

| Mode | ms/req | req/s | Output | Heap |
|------|--------|-------|--------|------|
| renderToString (plain React) | 1.8ms | 547 | 121 KB | 42 MB |
| Full Flight→Fizz pipeline | 7.5ms | 133 | 122 KB | 246 MB |
| **Fused (server-only)** | **1.9ms** | **528** | **122 KB** | **73 MB** |
| **Fused (w/ client boundaries)** | **3.2ms** | **309** | **348 KB** | **83 MB** |

Server-only fused matches `renderToString` performance (528 vs 547 req/s). With client boundaries, props serialization adds ~1.3ms — bringing total to 3.2ms, still 2.3x faster than the full pipeline's 7.5ms.

## What We Built

### Implementation (merged to `fused-renderer` branch)

| PR | Task | What it does |
|----|------|-------------|
| #10 | TIM-474 | `fusedMode` + `bundlerConfig` on Fizz Request. Client reference detection via `Symbol.for('react.client.reference')` in `renderElement()`. Server components called inline via `renderFunctionComponent()`. |
| #11 | TIM-475 | `renderClientBoundary()`: wraps client components in `<!--C:ID-->` / `<!--/C-->` markers, queues hydration data. `flushCompletedQueues()` emits consolidated `<script data-fused-hydration>` tag. |
| #12 | TIM-476 | `ReactFizzHydrationSerializer.js`: focused props serializer (~150 lines). Handles primitives, objects, arrays, Dates, BigInt, NaN/Infinity, server actions, client refs. Tombstones children. |
| #14 | TIM-486 | Fast-path serializer: uses native `JSON.stringify` for common case, falls back to manual string building for exotic types. |
| #15 | TIM-478 | Integration tests proving fused SSR and Flight coexist. Per-request `fusedMode` gating. Sentinel test: Flight server has zero fused-mode code. |
| #16 | TIM-480 | Edge case tests (nested boundaries, errors, async/sync mixing, streaming, exotic props, server actions) + upstream sentinel tests. |
| #17 | TIM-487 | Consolidated hydration script + investigation of props overhead. Module ref deduplication. |

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
  │           └── Queue {moduleRef, serializedProps}
  │       └── flushCompletedQueues() → consolidated <script data-fused-hydration>
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

The Flight serialize → deserialize → re-traverse cycle adds 2.3–3.2x overhead vs fused rendering. At c=25: 98 req/s (full pipeline) vs 292 req/s (fused). The gap widens under load because Flight's wire format buffers create GC pressure.

### 2. The "Fizz-only ceiling" was misleading

Early benchmarks showed Fizz-only (pre-resolved by Flight) at ~500 req/s and assumed that was the ceiling. But apples-to-apples measurement shows Fizz-only at only **142 req/s** — nearly identical to the full pipeline (139 req/s). Flight client's element reconstruction is just as expensive as Flight's serialization. Fused mode bypasses both.

### 3. Props serialization is real work but not a blocker

Each client boundary's props need to be serialized for hydration. For 226 products at ~1.2 KB each, this adds ~1.3ms per request. This is inherent — the client needs this data to hydrate. V8's `JSON.stringify` is already near-optimal; three different serialization strategies (recursive processObject, direct string building, JSON.stringify with replacer) all performed within 7% of each other.

The 3.2ms total per request (1.9ms rendering + 1.3ms serialization) yields 309 req/s at c=1, which is 2.3x the full pipeline. This is a real, shippable improvement.

### 4. Server-dominated pages get the largest win

Pages where most components are server components (dashboards, content sites, blogs, docs) see the full renderToString-level performance (528 req/s). Pages with many client boundaries (e-commerce PLPs) see a 2.3–3.2x improvement. The win scales with the server-to-client component ratio.

### 5. The implementation is surprisingly small

Total new code: ~350 lines across the serializer, Fizz changes, and config exports. No changes to Flight, the reconciler, or client-side React. The `fusedMode` flag is per-request, so frameworks can enable it selectively.

## Performance Measurement Journey

We went through multiple iterations to get honest numbers:

| Version | What it measured | Result | Problem |
|---------|-----------------|--------|---------|
| v1 | Sync CPU time, no async, tiny props | 54-79% overhead | Unrealistic scenarios |
| v2 | Wall-clock time with simulated I/O | 1-4% overhead | Wrong metric — I/O wait is free for throughput |
| v3 | Concurrent throughput, CPU-bound | 3-6x drop | Correct metric but Fizz-only "ceiling" was bogus |
| v4 | Apples-to-apples, all modes | 4.8x server-only, 1.1x with clients | Stale build had TIM-487 props-skip baked in |
| **Final** | Fresh build, concurrent, props included | **2.6–3.2x with client boundaries** | Honest numbers |

Key lesson: always rebuild before benchmarking after source changes. And don't compare numbers across builds.

## Open Items

### Client-side hydration approach (TIM-485)

We deferred modifying the reconciler. The spike should evaluate:
- Option A: Modify reconciler hydration walker (complex, risky)
- Option B: Flight fetch fallback for hydration data (extra round-trip)
- Option C: Mini React roots per boundary (Islands Architecture)
- Option D: Forest coordination layer

For v1, the server-side win is shippable without any client-side changes.

### Future props optimization opportunities

Not blockers, but could improve client-heavy page throughput further:
- **Selective serialization**: Only serialize props the client can't extract from the DOM
- **Deduplication**: Common prop shapes/values across boundaries
- **Deferred serialization**: Stream HTML first, serialize props after shell flush
- **Compact format**: Binary encoding instead of JSON (trade-off: needs client decoder)

## How to Use

```js
import { renderToPipeableStream } from 'react-dom/server';

// Initial SSR — use fused mode
const { pipe } = renderToPipeableStream(<App />, {
  experimental_fusedMode: true,
  experimental_bundlerConfig: webpackManifest,
  onShellReady() { pipe(res); },
});

// Client navigation — use Flight (unchanged)
const { pipe } = renderToFlightStream(<App />, webpackMap);
```

Available on all server entry points: Node, Edge, Browser, Bun.
