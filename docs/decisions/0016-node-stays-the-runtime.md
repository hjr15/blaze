# ADR-0016 — Node stays the runtime; the ceiling is the data model

- **Status:** accepted
- **Date:** 2026-08-22
- **Context:** the Blaze v4 redesign. The operator asked to *"explore the deep underlying
  architecture the engine sits on which is NPM… so we can meet all our requirements and
  maintain a system that has been design for high performance."*
- **Evidence:** `blaze-pm/docs/audits/2026-08-22-runtime-ceiling-benchmark.md` — six
  workloads measured against real Postgres and `node:sqlite` at engineering-firm scale
  (100k items, 6-deep hierarchy, 250k trace links, 10k-task CPM, 50k-row export, 200-way
  concurrency).

## Decision

**Keep Node.** A rewrite in a compiled runtime was measured, not assumed, and the
measurements do not support it. Direct the effort at the data model and the query shapes,
which is where the time actually goes.

## What the measurements said

| Workload | Where the time went | CPU-bound? |
|---|---|---|
| Hierarchy rollup, 100k items | 182.7ms DB + 580.0ms JS = **762.7ms** | Partly — but see below |
| Traceability matrix, 250k links | **91% in the database** (429.1ms of 470.5ms) | No |
| CPM, 10k tasks / 25k edges | 50.4ms DB + 45.3ms JS = **95.7ms** | **Yes — the honest exception** |
| Excel export, 50k rows | **76% inside `exceljs`** (1,540.8ms of 2,026.2ms) | Library-bound, not language-bound |
| JSON response, 5k items | 59.5ms of 78.1ms in JS — **caused by storing 40 custom fields as a JSON blob** | Partly, and it is a *schema* cause |
| 200 concurrent board queries | Postgres server CPU is the ceiling; pool=50 performed **worse** than pool=16 | No |

**The hierarchy result inverts the usual advice and is worth stating plainly:** a
whole-tree pass in JS (762.7ms) beat a database recursive CTE (4,585.9ms) by **6.0×**. The
existing pure-JS `rollup.mjs` is already the fast path, not a compromise to be migrated
into SQL later.

## The one honest exception, and why it does not decide anything

CPM is genuinely CPU-bound. A compiled language plausibly wins **3–5× on one 34–44ms
sub-phase** (adjacency-list construction), taking the full solve from 95.7ms to roughly
55–65ms.

**That 3–5× figure is the only unmeasured number in the benchmark** — no Go, Rust, JVM or
.NET toolchain was available in the environment, so it is a sourced estimate, not a
measurement, and the report flags it as such. It should not be treated as load-bearing
without verification against real compiled code.

Taken entirely at face value, it moves a sub-100ms internal computation to a different
sub-100ms internal computation — invisible beside one network round trip, and three orders
of magnitude smaller than the 1.77-second p50 Postgres already showed at 200-way
concurrency.

## The real Node hazard, which is architectural rather than about speed

Event-loop blocking is measured, not theoretical. Under 200-way concurrency,
`JSON.stringify` of overlapping 5,000-row result sets stalled the loop with **p50 lag of
210.6ms and a max of 272.1ms**, collapsing ~700 expected timer fires to 23 in 3.56 seconds.

This is the single most concrete cost of Node's model in the benchmark. **None of the
responses to it require a language change:**

- **Heavy synchronous jobs go off the main thread.** CPM and Excel export both qualify.
  `worker_threads` was tested directly and gave **5.63× throughput** on the sync
  `node:sqlite` path — at the cost of worse per-request p50 (42.3ms vs 20.5ms) from IPC.
  It fixes the throughput ceiling; it does not make one request faster.
- **Large responses stream or chunk** rather than serialising whole.
- **Pool to core count, not request count.** pool=16 beat both 10 and 50.

**Unresolved and deliberately so:** GC pause was not isolated. The p95/p99 tails (3.28–3.42s
against much lower medians) have a GC-shaped signature, but proving it needs a dedicated
`--trace-gc` pass under the same load. Recorded as unproven rather than assumed either way.

## `better-sqlite3` — adopted as an option, refused as a default

The benchmark found `better-sqlite3` **1.69× faster than `node:sqlite` on an identical
query** (8.09ms vs 13.69ms p50) — a larger and far more certain win than the compiled-
language estimate anywhere in this report, for the price of an `npm install`.

It was recommended as a swap. **We are not taking it as the default**, because it trades
against a product property ADR-0011 paid for deliberately:

> "A default install is **1 package with zero dependencies**."

`node:sqlite` is built into Node 24 and needs nothing. `better-sqlite3` is a native addon
requiring a prebuilt binary or a local compile — node-gyp, a toolchain, and a new class of
install failure, on every platform we support. For a product whose install story is a
differentiator against incumbents that ship thick clients (CS-040) and Docker-only
deployments (CS-042), that is not a free 1.69×.

**It fits ADR-0011's existing pattern exactly instead:** an optional peer dependency, used
when present, absent by default. Someone who wants the 1.69× runs one install command;
everybody else keeps the zero-dependency default. This costs one driver-selection branch
and no install friction.

## The counter-case for a compiled rewrite, which this ADR does not refute

Four arguments survive the benchmark because it does not measure them. They are real, and
none is about speed:

1. **Memory per instance** under one-process-per-tenant hosting. Nothing here characterises
   idle or baseline heap.
2. **Cold start** — single-digit ms for a static binary vs V8 startup plus module
   resolution. Matters only for scale-to-zero deployment, which is not the current model.
3. **Deployment size and supply-chain surface** — one binary vs a `node_modules` tree.
4. **Type safety at scale** — a 100k-item, 40-custom-field model is exactly the shape where
   a structural type system catches schema-drift and null-handling bugs at compile time.
   **This is the strongest of the four**, and the benchmark says nothing about it.

If a rewrite is ever revisited, it should be argued on these grounds — an
engineering-velocity and operational-cost case — and not on performance, which the
measurements have now closed.

## The trigger to watch, instead of a reassurance

**If production p95 board-query latency crosses roughly 500ms–1s under real peak
concurrency, revisit.** The fix every measurement points to is on the Postgres side —
materialised rollups, a columnar custom-field table instead of a JSON blob, read replicas,
a pool ceiling tuned to cores — not a language migration. A compiled host would not have
moved that number in this data.

## Consequences

**Good.** The ~1,267-test suite, the four-driver conformance work and the storage seam all
survive. Effort goes where the measurements point. The runtime question is now closed on
evidence rather than deferred on preference.

**Bad.** Event-loop blocking is a permanent engineering tax: every heavy synchronous
operation must be deliberately kept off the main thread, and that discipline has to hold
for the life of the product rather than being fixed once.

**Feeds directly into the custom-field decision.** The JSON-serialisation result — 59.5ms
of 78.1ms attributable to 40 custom fields held as an opaque JSON blob — is independent
evidence against a JSON-only custom-field strategy, arriving before that benchmark reports.
