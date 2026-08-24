# ADR-0014 — Tenancy is deferred, and row-level shared-schema is ruled out

- **Status:** accepted
- **Date:** 2026-08-22
- **Context:** the Blaze v4 redesign; commissioned by the adversarial audit in
  `blaze-pm/docs/audits/2026-08-22-evolution-vs-rebuild-refutation.md`, which named
  row-level multi-tenancy as the one condition that would flip v4 from evolution to
  full rebuild.

## Context

> **Amended 2026-08-25 (BLZ-362): facts and language only — the decision is unaltered.**
> See *Amendment — 2026-08-25* at the foot of this ADR for what changed and why.

Blaze v3 has **no tenant dimension**. Four tables are `id integer PRIMARY KEY CHECK
(id = 1)` — a deliberate singleton:

| Singleton table | Declared at |
|---|---|
| `blaze_config.board` | `scripts/model/config-schema.mjs:87` |
| `blaze_config.config_version` | `scripts/model/config-schema.mjs:99` |
| `projection_meta` | `scripts/model/projection-schema.mjs:28` |
| `migration_mode` | `scripts/model/write-rules.mjs:69` (SQLite), `scripts/model/write-rules.mjs:119` (Postgres) |

`migration_mode` is **one** table declared once per dialect, not two. `blaze_config.board`
is the table ADR-0021 renames to `blaze_config.installation`; that rename is not yet in the
code, so the name above is the one the DDL emits today.

**One installation is one installation.** The tenancy unit is the installation, not the
board — `deriveBoards()` already returns several boards per installation, so `board` was
never the singular thing this sentence needed. ADR-0021 retires the word for that reason.

A SaaS offering for engineering firms is a **stated future goal**, not current scope. The
operator's direction is explicit: *"this is fine for a saas but we should be focusing on
the stand alone app product engine first and focus on making it saas as a future item to
be worked on. Unless confirming the shape will determine the product engine initially then
I am happy to engage in these decisions now."*

That conditional is the actual question this ADR answers: **does the tenancy model
constrain the standalone engine's schema?**

## Decision

**Defer multi-tenancy. Rule out row-level shared-schema permanently. Design the engine as
a single-tenant database, which is by construction a database-per-tenant deployment with
N = 1.**

Three models were considered:

| Model | Table shape | Verdict |
|---|---|---|
| **Database per tenant** | unchanged — no tenant column anywhere | **Chosen.** A standalone install already IS this, at N = 1. |
| **Schema per tenant** (Postgres namespaces) | unchanged | **Rejected** — Postgres-only. SQLite has no equivalent, so the two first-class drivers would have genuinely different tenancy models, violating ADR-0011's premise that a driver is a swappable backend rather than a different product. |
| **Shared schema, `tenant_id` on every row** | every table changes | **Ruled out, permanently.** See below. |

## Why row-level is ruled out rather than merely deferred

Deferring a choice is only free if every option stays open. This one does not:

1. **It is the flip condition.** Adopting it later means adding a discriminator column,
   composite index and query predicate to every table — which is the rebuild the
   evolution recommendation exists to avoid. Leaving it "open" means v4 is designed under
   an unresolved constraint that silently prices itself in.

2. **Its failure mode is a breach, not a bug.** One query missing its tenant predicate
   shows one engineering firm another firm's requirements. For regulated engineering
   work — the target market — that is existential, and it is a failure that correctness
   tests do not naturally catch, because every such query returns *plausible* data.

3. **It sells worse to this market.** Regulated firms ask whether their data is
   physically separated. Under database-per-tenant the answer is yes, with a per-firm
   backup file to point at. Under row-level the answer is "logically, and you may audit
   our WHERE clauses."

4. **It is the wrong shape for the customer profile.** Row-level's advantage is cheap
   scaling to very many small tenants. Engineering firms are few and large. The advantage
   lands where we do not need it and the cost lands where we cannot afford it.

**Ruling it out is what makes deferral safe.** Without this half of the decision,
"defer tenancy" would be an unpriced liability rather than a deferral.

## What this obliges v4 to do now — the whole cost of the decision

Two things, neither of which is a schema change:

1. **No table may be designed on the assumption that rows from more than one
   installation coexist in it.** Every new v4 table — documents, baselines, custom field values,
   trace links — inherits the single-tenant premise. A design that only makes sense with
   a discriminator column is a design that has assumed the ruled-out model.

2. **Widen by column, not by rewrite, where a seam is cheap.** `membership.scope_key` is
   the pattern already done correctly and is the precedent this ADR generalises:

   > *"scope_key is NOT called board_id or tenant_id: today it is always `'*'`, and when
   > there are tenants to scope to the column already exists and its meaning widens
   > without a schema change."* — `scripts/model/identity-schema.mjs:60`

   That column costs nothing today and buys per-project scoping later. Prefer that shape
   where it is free; do not manufacture it where it is not.

## Consequences

**Good.** The engine ships single-tenant with no speculative tenancy machinery. The
`CHECK (id = 1)` singletons stay correct under both the standalone product and the future
SaaS. The identity layer's `scope_key` seam already exists. No schema work is spent on a
goal with no delivery date.

**Bad.** A future SaaS runs N databases: schema migrations execute N times, cross-tenant
analytics needs a separate rollup path, and per-tenant connection overhead is real. Those
costs are accepted, and they are operational — they do not touch the data model, which is
the point.

**Deliberately unresolved.** How N databases get provisioned, migrated in lockstep, and
monitored is a SaaS-era question. ADR-0012 already covers how one installation selects and
stores its database; the multi-installation control plane extends that and does not
contradict it.

## Revisit if

The customer profile inverts — many small tenants rather than few large firms — such that
per-database overhead dominates. That is a genuine reversal of this ADR's core premise and
would justify reopening it, at the cost this ADR describes. Nothing short of that should.

## Amendment — 2026-08-25 (BLZ-362)

**The decision is unaltered.** Database-per-tenant stands, row-level shared-schema stays
permanently ruled out, and no table may assume rows from more than one installation coexist.
The Decision, *Why row-level is ruled out*, Consequences and *Revisit if* sections are
untouched. Three things changed: the Context's inventory of what exists, its framing sentence,
and — in *What this obliges v4 to do now* — item 1's "more than one **board**" became "more than
one **installation**", which is the same obligation with the ambiguous word removed.

The Context read: *"`board`, `board_config`, `projection_meta` and the two write-rules tables
are all `id integer PRIMARY KEY CHECK (id = 1)` — a deliberate singleton. One installation is
one board."* Four things in it were wrong, all re-verified against the working tree on
2026-08-25:

| The ADR said | What is true |
|---|---|
| `board_config` is a singleton | It has never existed — `grep -rn 'board_config' scripts/` returns 0 |
| *(omitted `config_version`)* | `blaze_config.config_version` is a real singleton, `config-schema.mjs:99` |
| "the two write-rules tables" | One table counted twice — `write-rules.mjs:69` and `:119` are the SQLite and Postgres dialects of `migration_mode` |
| "One installation is one board" | `deriveBoards()` returns **4** — `delivery` (folding `goal`), `requirement`, `architecture`, `risk` |

**The fourth was already false on the day this ADR was written**, so it is not a claim that
went stale. `deriveBoards()` landed 2026-07-09 in `9960a84` and renders as board pills at
`scripts/views/page.mjs:156`; this ADR is dated 2026-08-22, forty-four days later.

This is recorded rather than quietly fixed because other work reasons from an ADR, and this
one had already been reasoned from wrongly: BLZ-362 records the *"one installation is one
board"* sentence being quoted to the operator as the settled model, to explain why their own
mental model — a project owning several boards — did not match Blaze. The code had already
agreed with the operator. This ADR was the only thing that disagreed.

`tests/adr-0014-singletons.test.mjs` now derives the singleton inventory from the DDL the
engine actually emits and asserts the Context's table against it, together with every
`file:line` that table cites. **All four errors are now mechanically prevented.** Three fall to
that set equality, which catches a named table that does not exist, a real one left out, and one
counted twice alike, because it compares sets rather than spell-checking the names present —
and the inventory refuses to parse partially, so a row it cannot read is a failure rather than a
row it silently skips. BLZ-362 judged only three detectable; set equality catches the omission
too. The fourth is pinned POSITIVELY — the Context must still say what is true, so REPLACING the
corrected sentence with a rephrasing fails the assertion rather than evading a banned spelling —
and the refuted sentence is additionally banned across every section but this one, which quotes
it deliberately. The honest limit: a paraphrase ADDED beside the true sentence, rather than
replacing it, still passes. No text check bounds paraphrase, and claiming otherwise would be the
same kind of overstatement this amendment exists to correct. ADR-0021 carries the same correction forward
in prose and is the record of the `board` → `installation` rename.
