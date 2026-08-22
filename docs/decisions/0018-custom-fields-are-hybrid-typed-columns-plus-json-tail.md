# ADR-0018 — Custom fields are typed columns for what is queried, JSON for the tail

- **Status:** accepted
- **Date:** 2026-08-22
- **Evidence:** `blaze-pm/docs/audits/2026-08-22-custom-field-storage-benchmark.md` — five
  strategies benchmarked on Postgres 17 and `node:sqlite` at 100k items × 40 custom fields
  × 250k trace links. 20 result tables; harness and raw `results.ndjson` committed beside it.
- **Context:** the one item the model assessment named as deciding evolution-vs-redesign,
  and which had to be settled **before v3's ticket/projection schema ships**.

## Decision

**Strategy 4 — hybrid.** Every custom field that is **filterable, sortable, or
constrained** becomes a real, named, typed column on the one shared item table. The
unconstrained tail lives in `jsonb`.

**EAV is eliminated on measurement, not taste.** It lost the board query by **11.6×** on
Postgres (43.8 ms vs 5.18 ms) and **17.5×** on SQLite (10.3 ms vs 0.615 ms), took **3.42×
the disk** (110 MB vs 32 MB), and was 3.8× slower on batched writes. It also **cannot
express "required" at all** — a missing value is simply a missing row.

## Three expectations I held that the benchmark refuted

Recorded because the design would have been wrong in three places.

**1. I predicted schema-change cost would kill the column-based strategies. It does not.**
Postgres 11+ made `ALTER TABLE ADD COLUMN` metadata-only: **9.0 ms on 100k rows**, with a
concurrent reader never stalling past 5.3 ms. The pre-allocated slot pool of strategy 3
buys nothing.

**The blocking operation is somewhere I did not look**: a `STORED` generated column is a
**2,002 ms table rewrite** with readers blocked for 1,930 ms — and it is **flatly
impossible on SQLite** (`cannot add a STORED column`). Since generated-column promotion is
the obvious way to implement a hybrid, **this refutation directly shapes the design below.**

**2. I asserted JSON can only be validated in application code. False.** `jsonb` accepts
ordinary `CHECK` constraints, and both engines enforced required, type, range and enum. Its
only real gap is unregistered keys — a narrower gap than EAV's.

**3. Jira's ~800-field cliff is real, but it is an INDEXING cliff, not a storage one.** The
knee sits between **200 and 400 indexed fields**: insert p50 goes 1.73 → 9.31 ms, p95 3.15
→ **51.4 ms**, index size 240 → 479 MB. It is **identical under all five strategies** —
so no storage choice avoids it, and the mitigation must be a product rule.

## Why hybrid over per-project physical tables

They are **within noise on Q1, Q2, Q3 and Q5** — the benchmark explicitly declined to
manufacture a winner on speed. Per-project even wins bulk export (2.1×) and Postgres disk
(1.52×).

Hybrid wins on one thing that matters more than any of that: **per-project tables collapse
on cross-project queries.** Already 130 ms at 1,000 project tables, and Postgres raises
`out of shared memory` at 5,000. The obvious mitigation — a shared base table plus a
per-project custom-field table — was measured, not assumed, and costs **2.4× server-side
on Q1**.

A tool whose entire value proposition is a traceability matrix spanning projects cannot
adopt a storage model that fails at cross-project queries.

## The cap this forces, and why it is generous

The benchmark's decision variable is **distinct constrained-or-filterable fields
install-wide** — not total fields. Under 800, hybrid holds. Above ~1,500, strategy 5 is
forced and caps the install near 1,000 projects.

**Measured against the live model rather than assumed:** v3's `ticket` table has **31
columns**, of which exactly **5 are indexed and filtered** — `project_key`, `status`,
`type`, `parent_id`, `id`. That is **16.1% filterable**, against the benchmark's assumed
17.5%. The assumption holds.

**Therefore: a hard product cap of 200 filterable fields per install.** At the observed
ratio that corresponds to roughly **1,250 total custom fields** — which is *above*
Atlassian's own "exceeding limit" threshold of 1,200, and well past the 800 they call
optimal. **The cap is more generous than Jira's entire field budget**, while sitting below
the measured indexing knee rather than beyond it.

This is a **product rule, not a schema fix**, and it must be enforced and surfaced. CS-008
is the anti-pattern: Atlassian is imposing hard caps in March 2026 on instances that grew
past them unwarned. A cap you learn about by email is worse than one you were shown from
the start.

## What the design must therefore do

1. **Plain typed columns, never `STORED` generated columns.** Generated columns are the
   2,002 ms rewrite and are impossible on SQLite. Promote with `ALTER TABLE ADD COLUMN`
   plus a backfill — the 9.0 ms metadata-only path.
2. **Promote at field-definition time, never later.** Promoting a field that already holds
   data costs **6.5 s on Postgres / 2.1 s on SQLite** (online, 9.7 ms max reader stall).
   Deciding "is this filterable?" when the field is created is cheap; deciding it later
   is not.
3. **`STRICT` is mandatory on every SQLite table holding custom fields.** Without it a
   `REAL` column silently accepts `'oops'`. Note the cost this carries: `ADD COLUMN` goes
   0.3 ms plain → 9.5 ms `STRICT` → **93.8 ms** with `STRICT` plus 14 CHECKs. Still
   acceptable; still worth knowing.
4. **Do NOT rely on SQLite's `ALTER TABLE … ADD CHECK`.** The benchmark found it works and
   enforces on a populated table in 22 ms — contradicting the folklore that a 12-step
   rebuild is required — but it **rides undocumented text-append behaviour**. Working
   today is not a contract. Treat constraints as fixed at table creation, and if the
   shortcut is ever used, pin the SQLite version and test it on every upgrade.
5. **Guard the 1,600-column Postgres hard limit.** Refuse promotion past ~1,590 with an
   error that names the limit, rather than letting `ALTER TABLE` fail raw.

## SQLite does not change the ranking

Same ordering on both engines, which matters because ADR-0011 makes both first-class. The
two divergences both hit non-winners: wide-sparse's unused NULL slots cost +2.8% on
Postgres but **+39% on SQLite** (a serial-type byte per column per row), and EAV's rollup
needs a hand-written `CROSS JOIN` hint on SQLite that Postgres does not — **59.7 ms → 0.114
ms, a 953× difference** on a query nobody would think to hint.

## Consequences

**Good.** Filterable fields get real columns with real database constraints, which is what
the operator's strictness requirement needs. The tail costs nothing. Cross-project queries
stay fast, so the traceability matrix scales. The independent JSON-serialisation finding
from ADR-0016 — 59.5 ms of a 78.1 ms response attributable to custom fields held as an
opaque blob — is resolved by the same decision.

**Bad.** Two storage paths exist for one logical concept, and the promotion boundary is a
decision someone has to make per field. Getting it wrong is recoverable but not free
(6.5 s). A hard cap will eventually annoy someone.

**Watch.** Count of promoted columns against both the 200-filterable product cap and the
1,590 Postgres ceiling. Both should be visible in `blaze db status` long before either
binds.
