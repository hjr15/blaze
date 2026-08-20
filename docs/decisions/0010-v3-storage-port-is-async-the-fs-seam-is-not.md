# 10. The v3 storage port is async; the transitional filesystem seam is not

Date: 2026-08-20

## Status

Proposed (BLZ-268)

## Context

[ADR-0009](0009-read-seam-is-query-shaped.md) settles the *shape* of the storage
contract. This settles whether it is synchronous.

The question was raised during the read-seam review and is genuinely consequential,
because answering it one way would have reversed a change already merged: the write
seam shipped in BLZ-267 is synchronous.

The argument put was: `node:sqlite` exposes only `DatabaseSync`/`StatementSync`;
`pg` has no synchronous API and never has; therefore no synchronous contract can host
both drivers, and choosing sync now guarantees a wholesale rewrite later.

**The premise is true.** Verified: a synchronous generator handed an async driver
throws `TypeError: its return value is not iterable`. The v3 service-architecture
port is Promise-returning throughout, with a single conformance suite mandated across
both drivers.

**The consequence is false**, and that distinction is the decision.

## Decision

**The v3 storage port is async.** It is written Promise-returning from its first
commit, because `pg` forces it and because one conformance suite has to run against
both drivers.

**The transitional filesystem seam (`scripts/model/storage.mjs`) stays synchronous
and is not reworked.** It is deleted at Phase 2 cutover.

### Why converting it would buy nothing

The two contracts share **zero methods and zero arguments**:

| transitional fs seam | v3 storage port |
|---|---|
| `exists` / `read` / `write` / `move` | `tx` / `create` / `getForUpdate` / `getForShare` / `allocateSeq` / `ancestors` / `update` |

Path-keyed blob I/O against a transactional ticket repository. Making
`write(file, text)` return a Promise moves it no closer to `create(t, input)`. The
cost of converting anyway was measured at 22 exported functions across 15 files — 14
of them under the coverage gate — and 38 of 117 test files, spent on code that Phase 2
deletes.

## Consequences

- **BLZ-267 stands as merged.** No rework, no churn against the coverage gate.
- **Sync and async coexist during Phases 1–2.** This is deliberate and bounded: the
  fs seam is condemned code with a known deletion date, not a parallel architecture.
- **The engine keeps two runtime paths in mind.** `node:sqlite` is synchronous and
  will be awaited trivially; `pg` is genuinely async. The port is written to the
  stricter of the two so the conformance suite is a single suite.
- **A blocking shim was demonstrated and rejected.** `worker_threads` +
  `SharedArrayBuffer` + `Atomics.wait` can block the main thread on an async call at
  ~66 µs per round trip, so "impossible" would have been too strong a word. It is
  nonetheless rejected: it is acceptable for a blocking CLI and fatal for a concurrent
  HTTP server, and the service handlers are Promise-returning regardless.

## Correction to the record

**No ADR mandated async before this one.** ADR-0006 and ADR-0007 contain zero
occurrences of async, promise or await. The requirement lived only in a TypeScript
snippet inside one planning document, and was described during review as the "design
of record" — an overstatement. It is now actually recorded, here.

Two stale comments were also found and corrected while settling this, both of which
had misled a reviewer who trusted them:

- `scripts/model/storage.mjs` claimed *"a SQLite driver satisfying this shape is a
  drop-in, which is the whole point"*. False, per the table above.
- `scripts/model/index.mjs` claimed four verbs break early out of the corpus walk.
  None of them do, and `locateTicket` documents the opposite thirty lines earlier.

A planning document elsewhere still states a Node 22 runtime floor; the engine floor
is Node 24 as of BLZ-264. That document is corrected separately.
