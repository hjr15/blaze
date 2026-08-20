# 9. The storage read seam is query-shaped, not a corpus walk

Date: 2026-08-20

## Status

Proposed (BLZ-268)

## Context

[ADR-0006](0006-database-is-the-sole-source-of-truth.md) moves ticket storage into a
database. The write seam shipped first (BLZ-267) as a four-method funnel —
`exists`/`read`/`write`/`move`. The read path is the harder half, and it had to be
decided before a driver was written, because the shape of the read contract
determines what the database is *allowed* to do.

Today `walkTickets()` lists status directories, reads every `.md`, parses it, and
caches parsed results against `{mtimeMs, size}`. A database has no files and no
mtime. Three candidate boundaries were put to a six-lens review panel: the driver
returns whole ticket records (a *walk*); the driver returns only a staleness token
and shared code keeps parsing markdown; or defer the whole question to cutover.

**Four of six reviewers chose the walk. An adversarial pass then refuted it, and the
refutation reproduced.**

## Decision

The read seam is a small set of **named, parameterised read operations** — the
database is asked a question and answers it with an index. Not a generator over the
whole corpus.

The filesystem driver implements the same names over a walk, so every existing call
site keeps working while files remain the store.

### The measurement that decided it

`scripts/v3_seam_shape_probe.mjs`, against the live 2,534-ticket corpus with real
bodies loaded:

| Operation | walk-shaped | query-shaped | ratio |
|---|---|---|---|
| resolve one ticket by id | 22.721 ms | 0.039 ms | **578×** |
| drill one parent | 21.175 ms | 0.076 ms | **280×** |

Both shapes return identical results — the fast path is correct, not
fast-because-broken.

**The cost centre is `locateTicket`, not the board.** It has seven call sites across
six verbs, and `model/index.mjs` *requires* it to scan the entire walk — an early
return is the BLZ-122 bug, not an optimisation. Under a walk-only seam, every
`blaze log` would ship roughly 5.6 MiB to find one primary key.

## Consequences

- **Larger Phase 1 diff**, and the query set is named before the database exists.
  That is genuine speculative-design risk and it was argued fairly by the panel. It
  is accepted because the alternative freezes an access pattern that only made sense
  when `readdir` was the sole primitive.
- **Filters, projections and pagination become reachable.** A walk-shaped seam makes
  every index in the v3 design unreachable from engine code — the design specifies
  them and the seam would forbid their use.
- **Parity is testable per operation**, which is what the design's divergence
  register already assumes: one named operation, one parity test across both drivers.
- **`file` stops being a path that callers do arithmetic on.** `move` and `reconcile`
  currently derive a destination via `dirname`/`basename`; handed an opaque handle
  they compute `destFile="done/BLZ-9"` and return `ok: true` — a ticket silently
  relocated, which is the BLZ-122 class reintroduced by the seam itself. Records must
  carry `project` and `status` as first-class fields.
- **The parse cache does not survive.** It exists to avoid re-reading markdown; the
  database's *uncached* read is faster than the filesystem's *cached* one. It stays
  on the exported fs driver singleton until cutover, then is deleted rather than
  ported.

## Alternatives rejected

**Walk-shaped** — the panel majority. Smallest diff and still faster than today's
cold read, but 578×/280× slower than indexed and structurally forbids the indexes.

**Staleness token only** — rejected unanimously by all six reviewers. It requires the
database to serialise rows back into markdown so shared code can re-parse them into
the objects the database already had, measured at ~115 ms per board render.

**Defer to cutover** — nobody chose it. The zero-diff migration oracle is itself a
read path, so the seam gets cut in Phase 1 either way, just informally and outside
the coverage gate.

**Walk now, queries at Phase 2** — considered and rejected: at cutover both contracts
are live and every call site is written against the wrong one, which is the deferred
option's cost arriving anyway with more code committed to it.

## Note on a supporting argument that does not hold

One reviewer argued the design had *already* chosen this shape, citing its
`searchBodies(q, filters)` adapter contract. That is a level confusion — that
register describes the **Postgres-versus-SQLite** adapter, not the
**filesystem-versus-database** seam, and a filesystem driver would never implement
`nowExpr()`. The conclusion stands on the measurements above; the cited proof does
not, and is recorded here so it is not repeated.
