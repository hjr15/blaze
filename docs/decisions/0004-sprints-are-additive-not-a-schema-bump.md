# ADR-0004: Sprints are an additive change — `SCHEMA_VERSION` stays 1

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-17 |
| **Deciders** | Ryan Howman |

## Context

BLZ-109 gives Blaze a real sprint concept: a top-level `sprints.json`
registry (read per-render, like `.blaze/transitions.json`) plus three new
optional per-ticket frontmatter fields — `sprint` (a registry id), `start`,
and `due` (`YYYY-MM-DD` dates). [ADR-0002](0002-config-schema-versioning.md)
established a `schemaVersion` stamp and an explicit compat window
(`MIN_SCHEMA_VERSION <= schemaVersion <= SCHEMA_VERSION`), so any change to
the schema now has to answer one question before it ships: does it bump
`SCHEMA_VERSION`?

The bump test [ADR-0002](0002-config-schema-versioning.md) set is not "did
the schema change" but "would an older engine **silently misread** a board
written by a newer one". That is the failure mode the stamp exists to make
loud. So the question for sprints is narrower than it looks: can a v1 engine
(one that has never heard of `sprint`/`start`/`due`) load a sprint-annotated
board and be *harmlessly ignorant*, or does it become *quietly wrong*?

## Decision

`SCHEMA_VERSION` and `MIN_SCHEMA_VERSION` both **stay 1** for the
`sprint`/`start`/`due` fields and the `sprints.json` registry. No stamp is
written; existing boards remain un-versioned (which ADR-0002 defines as v1)
and keep loading. This is a purely additive, backwards-compatible schema
change — exactly the category the versioning policy says never bumps the
stamp.

The evidence that a v1 engine is *harmlessly ignorant* of the new fields,
rather than quietly wrong, is in the engine itself:

- **The frontmatter parser accepts any identifier-style key.**
  `parseTicket` (`scripts/model/ticket.mjs:72`) matches every
  `^([A-Za-z0-9_]+):` line into the frontmatter map — it has no allow-list,
  so `sprint`/`start`/`due` parse into a v1 engine's ticket object without
  special-casing.
- **The serializer preserves unknown keys.** `serializeTicket`
  (`scripts/model/ticket.mjs:116-117`) writes `FIELD_ORDER` keys first, then
  appends *every remaining key* in insertion order. A v1 engine that
  re-serializes a sprint-annotated ticket writes the three fields back out
  in its unknown-key tail — it round-trips them without ever understanding
  them. This holds **even without the `FIELD_ORDER` addition** BLZ-110 made:
  the tail-append is what preserves the value; the `FIELD_ORDER` entry only
  controls *where* the line is placed. The `FIELD_ORDER` change is a
  formatting nicety, not the thing that makes the round-trip safe — which
  strengthens the not-a-bump case, since the compatibility does not depend
  on the schema change at all.
- **Validation never rejects unknown keys.** `validateTicket`
  (`scripts/model/rules.mjs`) checks required fields, priority/resolution
  enums, and parent integrity — it has no "unexpected field" error path, so
  a v1 engine does not reject a ticket carrying fields it doesn't recognise.
- **The index projection is explicit, not reflective.** `buildIndex`
  (`scripts/model/index.mjs`) projects a fixed row shape; a v1 engine simply
  omits `sprint`/`start`/`due` from its rows and every existing view keeps
  working. A new field cannot corrupt an old engine's derived index because
  the old engine never looks for it.

`tests/model/forward-compat.test.mjs` pins this: it round-trips a
sprint-annotated ticket through a shim replicating a v1 engine's key
ordering (`FIELD_ORDER` keys first, then the unknown-key tail) and asserts
`sprint`/`start`/`due` survive by value. The test was proven to
discriminate — with the unknown-key tail dropped, the assertions go red.
`tests/compat-legacy.test.mjs` remains the check that the *real* serializer
round-trips legacy boards.

### When sprints *would* have forced a v2

The bump is reserved for a change an old engine would **misread**, not one
it would **ignore**. Concretely, `SCHEMA_VERSION` must go to 2 for any of:

- making `sprint`/`start`/`due` (or any currently-optional field)
  **required** — an old engine would happily write tickets a new engine
  rejects;
- **renaming or repurposing** an existing indexed field — an old engine
  keeps writing the old meaning into a slot a new engine reads differently;
- **changing the meaning of a status or a type** — an old engine's moves
  would land in a workflow position the new engine interprets differently;
- **reshaping the hierarchy** (parent-type rules) — an old engine would
  create parentage a new engine considers invalid.

The common thread: anything where an old engine, running against a
new-contract board, produces or accepts data the new contract treats as
*wrong* — as opposed to data it merely doesn't surface. Adding three
optional, independently-ignorable fields is squarely the latter.

### No migrator, still

[ADR-0002](0002-config-schema-versioning.md) rejected a
`blaze schema-migrate` verb on the grounds that at v1 there is nothing to
migrate. That reasoning is unchanged here: this change does not bump the
version, so no board needs migrating, and shipping a migration verb that
cannot act would still fail the "simple for an AI to drive" gate. The
`blaze migrate` name remains reserved for the external-tracker importer.

### The mixed-engine field-order edge

There is one observable — and benign — artefact when a board is edited by
both engine versions. A v1 engine re-serializing a sprint-annotated ticket
writes `sprint`/`start`/`due` in its unknown-key tail (after `updated`); a
v2 engine writes them in `FIELD_ORDER` position (after `estimate`). So a
ticket that ping-pongs between engines can show a **reorder-only diff** — the
same keys and values, different line positions. This is cosmetic: no value
is lost, validation is unaffected, and the index is key-addressed, not
position-addressed. It converges the moment a v2 engine next writes the
ticket, since v2's `FIELD_ORDER` placement is stable. It is not a
correctness concern and does not, on its own, justify a version bump.

## Alternatives considered

**(a) Bump `SCHEMA_VERSION` to 2 for the new fields.** Rejected: it would
stamp every sprint-using board as v2 and, once `MIN` ever moved, lock out
engines that read those boards perfectly well today. The stamp is a scarce
signal — spending it on an additive change trains readers to ignore it,
which defeats the "fail loud on a *real* incompatibility" purpose ADR-0002
built it for.

**(b) Write a `schemaVersion: 1` stamp into boards that adopt sprints, to
be explicit.** Rejected: absent already *means* v1 (ADR-0002), so an
explicit `1` stamp is redundant, and writing it would touch
`blaze.config.json` on every sprint-adopting board for no behavioural gain.

**(c) Ship a no-op `blaze schema-migrate` now, to have the plumbing ready.**
Rejected for the same reason ADR-0002 rejected it: a verb that exists but
cannot act is a command an agent can invoke to no effect — the exact
surprise the design north star rules out. The first genuinely breaking
change ships its own migration, in the PR that has a real migration to
write.

## Consequences

- Every board in existence keeps loading on this engine with no stamp change
  and no migration; a v1 engine and a v2 engine can both read and write a
  sprint-annotated board, with only the cosmetic field-order tail edge above.
- The versioning policy in [`docs/schema-versioning.md`](../schema-versioning.md)
  now has its first worked example of an additive change that deliberately
  does **not** bump the stamp — a reference point for the next field
  addition.
- A future reader deciding whether *their* schema change bumps the version
  should apply the misread-vs-ignore test above, not "did the schema change"
  — the fields added here changed the schema and correctly did not bump it.
- The compat guarantee is pinned by two tests, not asserted: the
  forward-compat round-trip (`tests/model/forward-compat.test.mjs`, proven to
  discriminate) and the legacy-load contract
  (`tests/compat-legacy.test.mjs`, unchanged by this decision).
