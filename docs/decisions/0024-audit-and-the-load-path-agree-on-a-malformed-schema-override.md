# ADR-0024 — `blaze audit` and the load path agree on a malformed schema override

- **Status:** Accepted
- **Date:** 2026-08-27
- **Deciders:** Ryan Howman
- **Ticket:** BLZ-407

## Context

A board whose `blaze.config.json` carries `{"schema": {"types": {"spike": 7}}}` gets two
contradictory answers from the same engine:

- `blaze audit` → exit 0, `ok=true`. The malformation surfaces only as a **soft**
  `schema-invalid` finding, and soft findings never flip `ok`.
- `blaze rollup` (and every other non-exempt verb) → exit 1, `SchemaOverrideError`. The
  load path's `assertSchemaValid` treats the same override as **hard** and refuses.

Reproduced on this tree and on `2047f30`; it is long-standing, not a regression, and
BLZ-396 did not introduce it — BLZ-396 only put a second malformation class beside it on
the same reporting path.

An operator runs the hygiene gate, is told the board is clean, and then cannot run a
single non-exempt verb. The one surface whose job is to say whether the board is healthy
is the only surface that says it is.

The mechanism is a lost tag, not a difference of opinion. `collectSchemaProblems`
(`scripts/model/schema-config.mjs`) already returns `{ message, hard }` records, and the
two entry points read the same list:

- `validateSchema` — the reporting path — maps every record to its `message` and drops
  `hard`.
- `assertSchemaValid` — the load path — filters on `hard` and throws.

`auditCorpus` calls `validateSchema`, so by the time a problem reaches a finding the
severity the load path acts on has already been thrown away, and every problem is filed
under one kind, `schema-invalid`, which sits in `SOFT_KINDS`.

`SCHEMA_PREFLIGHT_EXEMPT = new Set(["audit", "init", "commit"])` (`scripts/cli.mjs`), so
`blaze audit` cannot be made to refuse by the load path at all — whatever it reports, it
reports under its own severity rules. The disagreement has to be closed in the audit
layer or in the load layer; there is no third place.

## The two options

**Option A — the audit finding becomes hard, so `ok=false` matches the refusal.**

**Option B — the load path stops refusing on this class of malformation.**

## Decision

**Option A.** `auditCorpus` reads the tagged list and files a hard problem under a new
hard kind, `schema-malformed`, while soft problems keep the existing soft
`schema-invalid`. `blaze audit`'s `ok` is then false exactly when `assertSchemaValid`
would throw, on the same board, for the same reason.

### Why not Option B

Option B reverses [[BLZ-56]]'s acceptance criterion that a malformed override must fail
loud, and BLZ-56's malformation-vs-inert split is what this repo has been building on
since. The split is not being reopened here; it is being carried into the layer that had
dropped it.

The refusal is also load-bearing on its own terms. An override the operator wrote and
the engine could not parse means the resolved registry is not the one the config
describes. Continuing would run the board on built-in defaults nobody chose — silently
substituting a schema for the one on disk — which is precisely the failure BLZ-56
existed to end. Making the load path permissive would buy agreement by making both
sides quiet, not by making either side right.

### Why the "soft gate" argument does not apply

`scripts/model/audit.mjs`'s header sets the rule this decision has to clear: HARD means
the corpus is WRONG; SOFT is a fill queue; and *"a gate that fails on the fill queue is a
gate people learn to skip, which costs the hard findings too."* Two things separate this
class from that concern.

First, a malformed `schema` override is not a fill queue. It is not absent metadata to be
backfilled at leisure — it is a statement about the board that the board does not honour.

Second, the "people learn to skip the gate" failure needs a board where the gate is
annoying but the verbs still work. On a board carrying this malformation there are no
working verbs: `audit`, `init` and `commit` are the entire set that runs, and every other
one already refuses. There is no habit to erode, because there is no working board to
have a habit on.

### Measured before shipping, per BLZ-353's lesson

BLZ-353 shipped a severity on a prediction, and the prediction was wrong. So this one was
measured first. At `blaze-pm` `2535a6ae` — named as a sha, not as a branch, because
`BLZ-305-v4-spine` moves and every figure here self-invalidates the moment it does
(ADR-0023 §2 states the same rule, and BLZ-417 is this ADR having broken it): the
top-level `schema` block resolves with **0** problems, hard or soft, and **no**
`project.json` on the board carries a `schema` block at all — across **2,717** tickets in
**11** projects. Promoting this class to hard fails **0** boards that exist today.

*(Re-measured at `2535a6ae` when the branch reference was replaced. The original
measurement, taken on the same branch two days earlier, read 2,655 tickets — the ticket
count is the one figure here that moves, which is precisely why the ref has to be a sha.
The **0**s did not move.)*

The same check was run against every checked-in fixture board in this repo
(`tests/fixtures/board-gate-bad-schema-version`, `board-gate-good`, `board-gate-real-shape`,
`board-gate-removed-key`, `legacy-board`): **0** of them carry a `schema-malformed` finding,
so this change flips `ok` on **0** fixtures. `board-gate-real-shape` already carries one soft
`schema-invalid` finding and stays `ok=true`; `legacy-board` already reports `ok=false`, for
an unrelated pre-existing hard finding (`invalid-parent-type`), not for anything this ticket
touches.

## Consequences

- `blaze audit` exits 1, and prints `ok=false`, on a board whose schema override is
  malformed — the same board every non-exempt verb already refuses.
- A new hard kind, `schema-malformed`, joins `HARD_KINDS`. `schema-invalid` stays in
  `SOFT_KINDS` and keeps its meaning: legal-but-inert configuration and advisories (an
  inert per-project `linkTypes` block, a deliberately narrowed workflow). Those must stay
  soft — `assertSchemaValid` deliberately does not throw on them, and a hard finding there
  would recreate this ADR's own defect in the opposite direction.
- `validateSchema`'s public shape is unchanged. It still returns strings, because
  `auditCorpus` compares them across layers and prints them as a finding's `detail`, and
  handing it objects renders every detail as `[object Object]` — BLZ-392's defect by
  another route. The tag reaches `auditCorpus` through a separate tagged accessor.
- The agreement is pinned by an oracle rather than by examples: over a generated
  cross-product of config-layer × project-layer override shapes, `auditCorpus(...).ok ===
  false` iff `assertSchemaValid` throws on the same input. Ground truth is whether
  `assertSchemaValid` actually throws, computed independently of the audit.
- ADR-0023 is untouched. This decision is about the audit/load severity boundary and says
  nothing about reconcile's signals.
