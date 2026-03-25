# Fused Renderer Go/No-Go Checkpoint

**Task**: TIM-482
**Date**: 2026-03-25 (revised with v3 concurrent throughput data)
**Decision**: **GO — Narrow scope (Approach B+, sync server components first)**

---

## Performance Validation Update (v3)

The original performance spike (TIM-483) reported 54–79% Flight overhead using synthetic sync-only benchmarks. A v2 revision added async I/O simulation and reported only 1–4% overhead. **Both were measuring the wrong thing.** Wall-clock time including I/O wait is irrelevant for throughput — CPU time on the single-threaded Node.js event loop is the bottleneck.

v3 measures concurrent throughput under realistic server load (c=1 to c=50). Key findings:

| Metric (c=25, 226 products) | Full Pipeline | Fizz Only (fused target) | Improvement |
|------------------------------|--------------|------------------------|-------------|
| **Throughput** | 102 req/s | 526 req/s | **5.2x** |
| **p99 latency** | 342ms | 49ms | **7.0x** |
| **Heap pressure** | 282 MB | 72 MB | **-210 MB** |

The throughput drop **worsens under load** (4x at c=1 → 5.9x at c=50) due to GC pressure from transient 349 KB wire format buffers per request. This directly explains the observed 400 rps → 40 rps drop in real-world Next.js/timber deployments (React-level 3–6x × framework overhead 1.5–2x ≈ 10x).

See `design/fused-renderer-perf-validation.md` for full data.

---

## Spike Findings Summary

### TIM-471: Fizz Internals (fused-renderer-fizz-analysis.md)

Fizz's `renderElement()` dispatches on `typeof type` and already calls function components via `renderWithHooks()`. The Request object has a clean lifecycle (OPENING→OPEN→CLOSING→CLOSED) with task/segment queues. A `fusedMode` flag and `clientBoundaryQueue` can be added to Request without disrupting existing paths. The TODO at line ~5944 in `flushCompletedQueues()` ("Here we'll emit data used by hydration") is the exact insertion point for hydration data. Fizz's Suspense machinery (ping→retry, task suspension) already handles async components — no new concurrency model needed.

### TIM-472: Flight Wire Format (PR #2, fused-renderer-flight-analysis.md)

Client components are identified by `Symbol.for('react.client.reference')` with `$$id` and `$$async` properties. The wire format uses typed chunks (`I[]` for modules, `S[]` for strings, etc.). Module references carry `{id, chunks, name}` metadata resolved from the `ClientManifest`. Flight's serialization is deeply coupled to its Request/Task model (800+ lines in `renderModelDestructive`), but the detection functions (`isClientReference`, `resolveClientReferenceMetadata`) are pure functions with no renderer state dependencies.

### TIM-473: Hydration Markers (fused-renderer-hydration-analysis.md)

Fizz uses HTML comments as boundary markers (`<!--$-->`, `<!--/$-->`, `<!--&-->`, etc.). The hydration walker (`getNextHydratable()`) silently skips unknown comments, meaning new marker types (e.g., `<!--C:0-->`) are backwards-compatible by default. Selective hydration creates dehydrated fragment fibers — the same pattern works for client boundaries. Server-only DOM between client boundaries can be skipped during hydration (no fibers created, just cursor advancement).

### TIM-481: Feasibility Analysis (fused-renderer-feasibility.md)

**Approach B+ (Flight as a library + focused props serializer) is the recommended path.** Client boundary detection and module resolution are trivially extractable (~50 lines of pure functions). Props serialization should NOT be extracted from Flight (too coupled); instead, a focused serializer handling common prop types (~150 lines) is sufficient. The assumption inventory identified 10 assumptions, most rated Stable. The highest-risk assumption (#7) is the hydration data TODO — if upstream acts on it, it could align with or conflict with our approach.

### TIM-483: Performance Validation (fused-renderer-perf-validation.md)

Flight overhead is **54–79% of total SSR time** across all scenarios. The large e-commerce scenario (226 products, ~1000 components): 1.89ms of 3.51ms is Flight overhead. Flight wire format accounts for 55-68% of total bytes — pure intermediate waste. Projected improvement: **2x throughput**, 52% render time reduction, 54% smaller total transfer. Memory: 401 KB heap delta per large request from intermediate Flight buffers.

---

## Question 1: What Did We Learn That We Didn't Expect?

**Surprise 1: Flight overhead is even larger than assumed.** We hypothesized "significant cost" but measured **54-79% of total SSR time**. For small/deep/wide trees, Flight is the overwhelming bottleneck (>70%). Even for the most HTML-heavy scenario (large), Flight is still the majority.

**Surprise 2: Detection functions are trivially extractable.** We assumed some extraction difficulty. In reality, `isClientReference()` is a single symbol comparison and `resolveClientReferenceMetadata()` is a map lookup. These have zero renderer state dependencies.

**Surprise 3: The hydration marker system is more accommodating than expected.** `getNextHydratable()` silently skips unknown comment types. We can add `<!--C:ID-->` markers without any risk to existing hydration. This was a risk we hadn't quantified before the TIM-473 spike.

**Surprise 4: Flight's full serializer is NOT needed.** We originally assumed we'd need to extract or reimplement `renderModelDestructive` (800+ lines). The feasibility analysis showed that client boundary props in practice contain only common types (primitives, objects, arrays, dates) — a ~150-line focused serializer handles 99% of cases.

## Question 2: Do We Still Believe Fused Renderer Is the Right Approach?

**Yes, with the narrow scope (Approach B+).** The evidence is clear:

1. The performance win is real and large (54-79% of SSR time is eliminable overhead)
2. The implementation path is clean (pure function imports + focused serializer + additive Fizz changes)
3. The risk surface is small (10 assumptions, most Stable)
4. There is no simpler alternative that delivers comparable wins:
   - Caching Flight output? Still pays serialization cost on cache miss, doesn't reduce memory pressure
   - Streaming optimization? Doesn't eliminate the fundamental three-pass architecture
   - Framework-level workarounds? Can't fix what's inside the React render loop

## Question 3: Top 3 Risks If We Proceed

### Risk 1: Upstream hydration data emission (Assumption #7)

**What**: The TODO at `flushCompletedQueues()` line ~5944 suggests React plans to emit hydration data from Fizz themselves. If they ship an implementation, our insertion point could conflict.

**Mitigation**: Sentinel test that asserts the TODO comment exists. Monitor React PRs touching this area. If upstream ships their own hydration data emission, evaluate alignment — it could actually make our work easier.

**Abandon trigger**: Upstream ships a hydration data system that's fundamentally incompatible with our marker scheme AND we can't adapt within a week of work.

### Risk 2: Props serializer coverage gaps

**What**: The focused serializer handles common types but throws on exotic types (ReadableStreams, TypedArrays, Maps, Sets). If real apps frequently pass these at client boundaries, the fallback path gets used too often.

**Mitigation**: Progressive approach — start with common types, measure fallback frequency in real apps, expand as needed. The fallback is graceful (component works, just no hydration optimization for that boundary).

**Abandon trigger**: >20% of client boundaries in real apps hit the fallback path, AND expanding the serializer to cover them approaches the complexity of Flight's full serializer.

### Risk 3: Upstream React refactors to Fizz internals

**What**: React refactors `renderElement()`, the Request object, or the task/segment model in ways that break our additions.

**Mitigation**: Our changes are additive (new code paths gated on `fusedMode`). Upstream refactors to existing paths won't affect fused-mode-specific code unless they change the dispatch interface or Request shape. Git merge conflicts will be the main signal.

**Abandon trigger**: Upstream rewrites Fizz from scratch (extremely unlikely) or changes the fundamental dispatch model in `renderElement()` (never happened in 3+ years).

## Question 4: Is Our Task Breakdown Still Correct?

The existing tasks (TIM-474 through TIM-480) are **mostly correct** with these modifications:

| Task | Status | Modification |
|------|--------|-------------|
| TIM-474 (server component execution) | ✅ Keep as-is | No changes needed |
| TIM-475 (client boundary detection + markers) | 🔧 Simplify | Use Flight's `isClientReference` directly instead of reimplementing. Reduce estimated scope. |
| TIM-476 (props serializer) | 🔧 Rewrite scope | Focused serializer for common types only. Throw on exotic types with helpful error. NOT a Flight extraction. |
| TIM-477 (client hydration) | ✅ Keep as-is | Independent of approach choice |
| TIM-478 (Flight coexistence) | ✅ Keep as-is | Still needed for client navigation |
| TIM-479 (benchmarks) | ✅ Keep as-is | Will use the harness from TIM-483 as a starting point |
| TIM-480 (edge case tests) | ✅ Keep as-is | Important for correctness validation |

**New tasks to add:**
- Sentinel tests for upstream assumption monitoring (can be part of TIM-480 or separate)
- Fallback path for unsupported prop types (can be part of TIM-476)

**Dependency order**: TIM-474 → TIM-475 → TIM-476 → TIM-477 → TIM-478, with TIM-479 and TIM-480 after TIM-477.

## Question 5: What's Our Exit Strategy?

If we hit a wall during implementation:

**After TIM-474 (server component execution)**: This is the lowest-risk task — it adds a fusedMode branch to renderElement() that calls server component functions inline. If this works, we already have a partial win (server components skip Flight serialization). If it fails, we've learned something about Fizz's function dispatch and can back out cleanly.

**After TIM-475-476 (client boundaries + serializer)**: We have the core server-side fused renderer. We can measure real throughput improvement at this point. If the numbers don't match projections, we stop. The sunk cost is ~2 tasks of work (~200-300 lines of new code).

**After TIM-477 (client hydration)**: This is the hardest task. If hydration integration proves too fragile, we can fall back to "server-side fusion only" — the server emits optimized HTML without Flight overhead, but the client uses a full Flight fetch for hydration data instead of inline scripts. This is still a significant win (TTFB improvement) without the hydration complexity.

**Salvageable partial work**: Even if we abandon full fusion, TIM-474 (inline server component execution in Fizz) is independently valuable. It's a single-pass optimization that reduces the number of tree walks from 3 to 2.

## Question 6: What's the Minimum We Could Ship?

**Minimum viable: TIM-474 + TIM-475 (no client hydration optimization)**

- Fizz calls server component functions inline (single pass for server components)
- Client boundaries are detected and rendered to HTML normally
- **No** inline hydration data — client uses normal Flight fetch for hydration
- **No** changes to the reconciler or hydration walker

**What this delivers:**
- Eliminates Flight serialize/deserialize for the server render (~50-70% of SSR time)
- Reduces TTFB proportionally
- Server memory: no intermediate Flight buffers
- **Does NOT** reduce client payload (still needs Flight for hydration)

**What it defers:**
- Inline hydration data (TIM-476, TIM-477)
- Client-side hydration optimization
- Payload size reduction

This minimum scope still delivers the **majority of the throughput win** (the server-side render is the bottleneck, not client hydration data transfer).

## Question 7: Are There Upstream Signals We Should Wait For?

**No. We should proceed now.**

Rationale:
- The hydration data TODO has been in Fizz for years with no movement
- View Transitions, Fragment Refs, and Activity are all **additive** — they add new marker types but don't change the fundamental dispatch or hydration architecture
- No open RFCs propose replacing Flight's wire format or Fizz's rendering model
- The features that were experimental (`enableHalt`, `enablePostpone`) have been cleaned up, suggesting a stable period
- `enableHydrationChangeEvent` and `enablePartialHydration` are evolving but affect the hydration walker (our TIM-477), not the server-side fused renderer (TIM-474-476)

**One signal to monitor**: If React ships a native "RSC SSR optimization" (eliminating the Flight round-trip themselves), we should evaluate alignment immediately. But there's no indication this is imminent.

---

## Decision

### GO — Narrow Scope (Approach B+)

**Phase 1** (immediate): TIM-474, TIM-475 — Server-side fusion with synchronous server components. Measure throughput improvement.

**Phase 2** (if Phase 1 validates): TIM-476, TIM-477 — Client boundary props serialization and inline hydration data. Measure payload + hydration improvement.

**Phase 3** (if Phase 2 validates): TIM-478, TIM-479, TIM-480 — Flight coexistence, benchmarks, edge cases.

Each phase is a decision point. If the measured improvement at any phase doesn't justify the next phase's complexity, we stop and ship what we have.

### Updated Risk Register

| Risk | Severity | Likelihood | Mitigation |
|------|----------|-----------|------------|
| Upstream hydration data emission | High | Low | Sentinel test, PR monitoring |
| Props serializer coverage gaps | Medium | Medium | Progressive expansion, graceful fallback |
| Fizz internal refactors | Medium | Low | Additive changes, fusedMode gating |
| Client hydration integration fragility | High | Medium | Phase 2 gate; fall back to Flight fetch |
| Merge conflicts on upstream sync | Low | High | Small, isolated changes; clean branch discipline |
