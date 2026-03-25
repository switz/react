# Fused Renderer: Complete Findings

**Date**: 2026-03-25
**Branch**: `fused-renderer`
**Status**: Server-side implementation complete. 1.6–2.0x throughput improvement verified.

---

## The Core Result

Fused rendering — having Fizz call server component functions directly instead of going through Flight serialize → deserialize → re-traverse — delivers a **1.6–2.0x throughput improvement** under concurrent load, with identical HTML output, 4–5x less memory, and stable performance under pressure.

### Verified concurrent throughput (226-product PLP, single Node.js thread)

| c | Full Pipeline | Fused | Improvement | Heap |
|---|-------------|-------|-------------|------|
| 1 | 128 req/s | **200 req/s** | **1.6x** | 239→73 MB |
| 10 | 108 req/s | **187 req/s** | **1.7x** | 277→70 MB |
| 25 | 99 req/s | **187 req/s** | **1.9x** | 277→57 MB |
| 50 | 93 req/s | **185 req/s** | **2.0x** | 297→60 MB |

**Key property**: Fused throughput is **rock stable** (185–200 req/s regardless of concurrency) while the full pipeline **degrades under load** (128→93 req/s) due to GC pressure from intermediate Flight wire format buffers.

### Audit results

All numbers verified by automated audit:
- ✅ HTML output is byte-identical between full pipeline and fused (after stripping markers/scripts)
- ✅ Client component functions are actually called (counted invocations)
- ✅ All product names present in rendered HTML
- ✅ Boundary markers and hydration data present
- ✅ Module resolution uses O(1) Map lookup (same cost as `__webpack_require__`)
- ✅ Same React build used for both paths
- ✅ Node.js streams (`renderToPipeableStream`), not web streams

## What We Built

### Implementation (merged to `fused-renderer` branch)

| PR | Task | What it does |
|----|------|-------------|
| #10 | TIM-474 | `fusedMode` + `bundlerConfig` on Request. Client ref detection. Server components called inline. |
| #11 | TIM-475 | `renderClientBoundary()`: markers, hydration data queue, consolidated `<script>`. |
| #12 | TIM-476 | `ReactFizzHydrationSerializer.js`: focused props serializer (~150 lines). |
| #14 | TIM-486 | Fast-path serializer using native `JSON.stringify`. |
| #15 | TIM-478 | Flight coexistence tests. Sentinel: Flight server untouched. |
| #16 | TIM-480 | Edge case tests + upstream assumption sentinels. |

### Architecture

```
Framework request arrives
  ├── Initial SSR (fusedMode: true)
  │   Fizz receives original tree with server component functions
  │   ├── Server component → renderFunctionComponent() → HTML
  │   └── Client component → renderClientBoundary()
  │       ├── resolveClientComponent($$id) → actual module
  │       ├── <!--C:ID--> marker
  │       ├── renderFunctionComponent(resolvedModule, props) → HTML
  │       ├── <!--/C--> marker
  │       └── Queue {moduleRef, serializedProps}
  │   └── flushCompletedQueues() → consolidated <script data-fused-hydration>
  │
  └── Client navigation (fusedMode: false, default)
      └── Flight server → wire format (completely unchanged)
```

### Key design decisions

1. **`resolveClientComponent` on bundlerConfig** — the framework provides a function that maps `$$id` to the actual server-side module. This is equivalent to `__webpack_require__` in the Flight client but runs inside Fizz. The proxy function itself returns `undefined` — you MUST resolve the real module.

2. **Consolidated hydration script** — one `<script data-fused-hydration>` per flush instead of per-boundary. Deduplicates module refs. Format: `{"m":["moduleUrl"],"b":[[boundaryId,moduleIdx],...]}`

3. **Props serialized per-boundary** — `serializeProps()` handles common types via JSON.stringify fast path. ~1.3ms for 226 boundaries. This is irreducible work — the client needs props to hydrate.

## Where the speedup comes from

Per-request breakdown (c=1, 226 products):

| Phase | Full Pipeline | Fused | Saved |
|-------|-------------|-------|-------|
| Flight serialize (tree walk + wire format) | ~2.5ms | 0ms | 2.5ms |
| Flight deserialize + element reconstruction | ~2.5ms | 0ms | 2.5ms |
| Module resolution | via Flight client | ~0.003ms | — |
| Component rendering (Fizz) | ~2.0ms | ~2.0ms | 0ms |
| Props serialization | 0ms (in Flight wire) | ~1.3ms | -1.3ms |
| Hydration script emission | 0ms | ~0.2ms | -0.2ms |
| **Total** | **~7.0ms** | **~3.5ms** | **3.5ms** |

Net savings: ~3.5ms per request from eliminating Flight serialize + deserialize, offset by props serialization + hydration script costs. The props serialization is work that Flight was also doing (it serialized props in the wire format) — we're just doing it in a different location.

## Measurement journey

| Version | Claimed | Actual | Error |
|---------|---------|--------|-------|
| v1 (sync-only) | 54-79% overhead | CPU ratio was correct | No async/data fetch |
| v2 (wall-clock + I/O) | 1-4% overhead | Irrelevant metric | I/O wait isn't CPU |
| v3 (concurrent) | 3-6x drop | Measured the problem correctly | "Fizz ceiling" was wrong |
| v4 (apples-to-apples) | 2.3-3.2x | **Client proxy bug** | Fused wasn't rendering components |
| **v5 (audited)** | **1.6-2.0x** | **Verified identical HTML** | **Honest** |

The proxy bug: `clientExports()` creates `function(){}` with `$$typeof` set. Calling this proxy returns `undefined`. The fused renderer was emitting empty markers, benchmarking "doing nothing" as faster. Fixed by adding `resolveClientComponent` to resolve the actual module via bundlerConfig.

## Open items

### Client-side hydration (TIM-485, TIM-477)
The server emits `<!--C:ID-->` markers and a consolidated hydration `<script>`. The client strategy is undecided:
- Option A: Modify reconciler hydration walker (complex)
- Option B: Flight fetch fallback
- Option C: Mini React roots per boundary (Islands)
- Option D: Forest coordination layer

### Integration
The `experimental_fusedMode` option is available on all server entry points. A framework needs to provide `experimental_bundlerConfig.resolveClientComponent($$id)` to map client reference IDs to actual server-side modules.

## How to use

```js
import { renderToPipeableStream } from 'react-dom/server';

const { pipe } = renderToPipeableStream(<App />, {
  experimental_fusedMode: true,
  experimental_bundlerConfig: {
    resolveClientComponent(id) {
      // Map client reference $$id to the server-side module
      return ssrModuleMap.get(id);
    },
  },
  onShellReady() { pipe(res); },
});
```
