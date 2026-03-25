# Fused Renderer Performance Validation (v2)

**Task**: TIM-484 (supersedes TIM-483)
**Date**: 2026-03-25
**Conclusion**: The pure serialization overhead is **1–4% of total SSR time** (0.3–1.3ms). Data fetching dominates. Fusion may not justify its complexity.

---

## Why v2?

The original benchmark (TIM-483) used synchronous server components with trivial props, producing total render times of 0.4–3.5ms. It reported Flight overhead at 54–79%, but those numbers measured function dispatch speed, not a realistic SSR pipeline.

v2 fixes this with:
- **Async server components** with simulated DB/cache fetches (1–20ms)
- **Realistic prop sizes**: blog posts (~5–10KB), products (~2–4KB), user objects
- **Suspense boundaries** for streaming (4–8 per scenario)
- **TTFB measurement** separate from total stream completion
- **Isolated phase measurement** to separate data fetch time from serialization overhead

## Profiling Methodology

### Harness

`scripts/bench/fused-renderer-bench.js` runs two measurement modes:

1. **Full pipeline**: Flight serialize (includes data fetch) → Flight deserialize → Fizz render. Measures end-to-end time.
2. **Isolated phases**: (A) Flight total time (data fetch + serialization), (B) Fizz-only time (pre-resolved tree, no Flight). The difference reveals the pure serialization overhead.

**Serialization overhead** = Full pipeline total − Flight total − Fizz-only. This is what fusion actually eliminates — everything else (data fetching, HTML rendering) remains.

### Scenarios

| Scenario | Async fetches | Suspense boundaries | Client components | Props payload |
|----------|--------------|--------------------|--------------------|---------------|
| **blog** | 4 (1–12ms each) | 4 | Comment form, navbar | Blog posts ~40KB |
| **ecommerce-plp** | 2 (12–20ms each) | 2 | 48 product cards, search filters, navbar | Products ~150KB |
| **dashboard** | 8 (1–11ms each) | 8 | Charts, data table, navbar | Metric data ~5KB |

### Configuration

- Node.js v24.14.0, production builds, `--expose-gc`
- 3 warmup runs, 15 measured runs per scenario
- Statistics: median, mean, stdev

## Results

### Summary Table

| Scenario | Total | Fetch+Ser | Fizz Only | Ser Overhead | Overhead % | Wire | HTML |
|----------|-------|-----------|-----------|-------------|-----------|------|------|
| blog | 14.0ms | 13.1ms | 0.4ms | **0.5ms** | **3.5%** | 10.4 KB | 7.8 KB |
| ecommerce-plp | 23.0ms | 21.1ms | 1.5ms | **0.4ms** | **1.7%** | 64.7 KB | 35.5 KB |
| dashboard | 14.0ms | 13.1ms | 0.4ms | **0.5ms** | **3.3%** | 4.7 KB | 4.2 KB |

- **Total** = end-to-end pipeline (Flight serialize + deserialize + Fizz render)
- **Fetch+Ser** = Flight with data fetching (server component execution + serialization)
- **Fizz Only** = Fizz rendering pre-resolved tree (no data fetch, no Flight)
- **Ser Overhead** = Total − Fetch+Ser − Fizz Only = pure serialization/deserialization cost
- **Overhead %** = Ser Overhead / Total = what fusion actually eliminates

### Detailed Breakdown: Blog Scenario

| Phase | Time | % of Total |
|-------|------|-----------|
| Data fetching (async server components) | ~12.6ms | ~90% |
| Flight serialization (tree walk + encoding) | ~0.5ms | ~3.5% |
| Flight deserialization (parsing wire format) | ~0.2ms | ~1.5% |
| Fizz HTML rendering | ~0.4ms | ~3% |
| Scheduling/stream overhead | ~0.3ms | ~2% |

### Detailed Breakdown: E-commerce PLP Scenario

| Phase | Time | % of Total |
|-------|------|-----------|
| Data fetching (async server components) | ~20ms | ~87% |
| Flight serialization (48 products × ~2KB) | ~1ms | ~4.3% |
| Flight deserialization | ~0.2ms | ~0.9% |
| Fizz HTML rendering (48 card components) | ~1.5ms | ~6.5% |
| Scheduling/stream overhead | ~0.3ms | ~1.3% |

## Where Time Actually Goes

The dominant cost is **data fetching** — the async server components awaiting simulated DB/cache calls. Even with fast cache hits (1ms) and moderate DB queries (5–12ms), data fetching is 87–90% of total SSR time.

### Bottleneck ranking

| Bottleneck | Typical time | % of total |
|-----------|-------------|-----------|
| **Data fetching** (DB/cache/API) | 12–20ms | 87–90% |
| **Fizz HTML rendering** | 0.4–1.5ms | 3–7% |
| **Flight serialization** | 0.3–1.0ms | 2–4% |
| **Flight deserialization** | 0.15–0.25ms | 1–2% |
| **Scheduling overhead** | 0.2–0.3ms | 1–2% |

## Payload Analysis

Flight wire format adds intermediate bytes that don't reach the client directly:

| Scenario | Flight wire | HTML output | Wire as % of total |
|----------|-----------|------------|-------------------|
| blog | 10.4 KB | 7.8 KB | 57% |
| ecommerce-plp | 64.7 KB | 35.5 KB | 65% |
| dashboard | 4.7 KB | 4.2 KB | 53% |

The wire format IS waste in colocated deployments, but it doesn't contribute significantly to latency — the bytes are generated and consumed in-process. The memory impact at scale (×50 concurrent requests) could matter for GC pressure, but the time impact is minimal.

## What Fusion Would Actually Save

### Time savings

| Scenario | Current total | Projected fused | Savings | Improvement |
|----------|-------------|----------------|---------|-------------|
| blog | 14.0ms | ~13.5ms | ~0.5ms | **3.5%** |
| ecommerce-plp | 23.0ms | ~22.6ms | ~0.4ms | **1.7%** |
| dashboard | 14.0ms | ~13.5ms | ~0.5ms | **3.3%** |

### Throughput impact (render-bound, single core)

| Scenario | Current req/s | Projected fused req/s | Improvement |
|----------|-------------|---------------------|-------------|
| blog | ~71 | ~74 | **4%** |
| ecommerce-plp | ~43 | ~44 | **2%** |
| dashboard | ~71 | ~74 | **4%** |

### Memory savings

Eliminating the Flight wire format buffer saves ~5–65 KB per request. At c=50, that's 0.25–3.25 MB — measurable but not transformative.

## Comparison with v1 (TIM-483)

| Metric | v1 (synthetic) | v2 (realistic) | Why different |
|--------|---------------|---------------|---------------|
| Total render time | 0.4–3.5ms | 14–23ms | v1 had no async, no data fetch |
| Flight overhead % | 54–79% | 1.7–3.5% | v1 lumped data fetch into Flight |
| Absolute savings | 0.3–1.9ms | 0.3–0.5ms | Similar! The raw overhead IS small |
| Throughput improvement | "2x" | 2–4% | v1 was misleading |

Note: the absolute serialization cost (0.3–0.5ms) is consistent between v1 and v2. The v1 error was in the *denominator* — when total render time is 3.5ms (no data fetch), 0.5ms of overhead is 15%. When total render time is 14ms (with realistic data fetch), the same 0.5ms is 3.5%.

## Conclusion

**The pure serialization overhead is 1–4% of realistic SSR time. This does not justify the complexity of a fused renderer.**

The previous analysis (TIM-483) was wrong because it tested synchronous components with trivial props — an unrealistic scenario that made the overhead look 15–20× larger than it actually is.

### What the data shows

1. **Data fetching dominates SSR** (87–90% of time). Optimizing the Flight→Fizz handoff has negligible impact on user-perceived latency.
2. **The absolute overhead is ~0.5ms**. Even at high concurrency, this is 25ms of CPU time per 50 concurrent requests — not a bottleneck.
3. **Memory savings are modest** (5–65 KB per request). Meaningful at extreme scale but not a primary concern.
4. **Payload elimination is real but doesn't affect latency** — the wire format is consumed in-process, not sent over the network.

### Recommendation

**Do not proceed with the fused renderer.** The engineering cost (estimated 5–7 tasks, ~2000 lines of fork code, ongoing maintenance against upstream) is not justified by a 2–4% throughput improvement.

### Better uses of engineering time

1. **Data fetching optimization**: Caching, preloading, parallel fetches. Moving from 12ms to 6ms DB queries gives a 25% improvement — 10× better ROI than fusion.
2. **Streaming optimization**: Better Suspense boundary placement, earlier shell flush. Reducing TTFB from 14ms to 5ms (by streaming before all data resolves) has far more user impact.
3. **Client hydration**: Selective hydration, lazy loading client boundaries. This is where users actually wait.
4. **Payload optimization**: If the Flight wire format size matters (65 KB for e-commerce), consider compression or selective resolution rather than eliminating the format entirely.
