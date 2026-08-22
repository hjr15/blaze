# ADR-0014 — Tenancy is deferred, and row-level shared-schema is ruled out

- **Status:** accepted
- **Date:** 2026-08-22
- **Context:** the Blaze v4 redesign; commissioned by the adversarial audit in
  `blaze-pm/docs/audits/2026-08-22-evolution-vs-rebuild-refutation.md`, which named
  row-level multi-tenancy as the one condition that would flip v4 from evolution to
  full rebuild.

## Context

Blaze v3 has **no tenant dimension**. `board`, `board_config`, `projection_meta` and the
two write-rules tables are all `id integer PRIMARY KEY CHECK (id = 1)` — a deliberate
singleton. One installation is one board.

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

1. **No table may be designed on the assumption that rows from more than one board
   coexist in it.** Every new v4 table — documents, baselines, custom field values,
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
