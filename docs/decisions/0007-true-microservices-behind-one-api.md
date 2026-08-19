# 7. Blaze v3 runs as true microservices behind one API

Date: 2026-08-20

## Status

Proposed (BLZ-260)

Supersedes the "microservices rejected" position recorded on BLZ-98 (*Blaze v2 —
persistent Postgres backend + AI-facing API*), which was parked with 3 of its 11
decision axes resolved.

## Context

[ADR-0006](0006-database-is-the-sole-source-of-truth.md) moves ticket storage
into a database behind an API. That leaves an open question the v2 design parked:
one deployable, or several?

A modular monolith is the safer default and was the recorded preference. The
operator chose true microservices on 2026-08-19 having been shown that trade-off
explicitly.

The usual objection to microservices at this scale is real: a request that fans
out to three services to answer is slower and less reliable than one that does
not, and a "microservice" that cannot serve a request while a sibling is down is
a distributed monolith wearing a costume.

## Decision

Eight services: `blaze-core` (the **sole** ticket writer), `blaze-config`,
`blaze-query`, `blaze-docs`, `blaze-render`, `blaze-mcp`, `blaze-reconciler`,
`blaze-groomer`. Index maintenance is explicitly **not** a service.

### The mechanism that makes this safe

This is the load-bearing part. An ADR that says "microservices" without it has
not recorded the decision.

The type/workflow/taxonomy registry is compiled by `blaze-config` into a
**content-addressed, versioned snapshot** published into `core.schema_snapshots`.
`blaze-core` validates against **its own row**, never a live cross-service read.

Therefore `blaze new` makes **zero cross-service calls**. Id allocation, schema
validation, the parent `FOR SHARE` plus cycle CTE, the row write, the event row
and the outbox row are one `BEGIN…COMMIT` inside `blaze-core`. **Config being
down cannot block a write.**

`blaze-reconciler` and `blaze-groomer` are **API clients** carrying `If-Match`
and idempotency keys — not direct database writers. That is what makes the
single-writer rule structural rather than aspirational: there is no second code
path to the tables, so there is no second path to keep honest.

## Consequences

- **Phases 0–3 are structurally a modular monolith with every seam pre-cut.**
  Phase 5 turns seams into deployables one at a time, with the conformance suite
  green between each. Nothing is deployed as eight services before it passes as
  one.
- The acceptance suite must pass **identically** in the all-in-one and
  distributed compositions, running under both a `LoopbackCaller` and an
  `HttpCaller`. Loopback round-trips JSON through strict OpenAPI validation —
  without that, all-in-one silently accepts what HTTP rejects and the two
  compositions drift.
- Eight deployables cost eight sets of build, deploy, probe and alert wiring.
  That cost is accepted; it is bounded by the umbrella Helm chart carrying
  per-service subcharts but **one** ArgoCD Application.
- "Zero cross-service calls on the write path" is a claim that must be **proven**
  in Phase 5, not assumed. If it stops being true, this decision has lapsed and
  should be revisited rather than quietly tolerated.
