# ADR-0022 — Dependency edges, effort and date constraints are inputs; dates are derived

- **Status:** accepted
- **Date:** 2026-08-23
- **Ticket:** BLZ-360 (design spec `docs/superpowers/specs/2026-08-23-scheduling-kernel-design.md`; transcribed to the corpus under BLZ-366)
- **Written in ADR-0021's vocabulary** — it cites ADR-0018's *"200 filterable fields per install"* and an installation-level schema event, both of which read differently before ADR-0021 lands.

## Context

Today `start_date` and `due_date` are **hand-set inputs**. `scripts/model/gantt.mjs:67-73` branches
on them into four bar kinds, `EDITABLE_FIELDS` contains `"due"` and `"start"`, and
`new-runner.mjs:47-48` accepts `--start`/`--due` — while the comment above `EDITABLE_FIELDS` claims
*"id/project/dates are read-only"*. The comment contradicts the code.

A critical path makes those fields derived. That one choice decides the scheduler, sprint capacity
and date roll-up, so it had to be settled before any of the consumer specs could be written.

## Decision

> **Dependency edges, effort and date constraints are inputs; `start_date`, `due_date`, float and
> the critical path are outputs computed by the scheduler and never hand-set. Dependency edges are
> carried by a new `Precedes` link type in the v4 `link` table, leaving `Blocks` advisory and
> ADR-0001 intact.**

| | Field | Who sets it |
|---|---|---|
| **Input** | `estimate`, dependency edges, `constraint_start_no_earlier_than`, `deadline` | the operator |
| **Derived** | `start_date`, `due_date`, float/slack, critical path | the scheduler |

**One rule on authority:** the operator owns the inputs, the scheduler owns the outputs, and
**neither ever writes the other's fields.** A `deadline` and a derived `due_date` that disagree is
not a contradiction to be resolved — it is the finding the model exists to produce. Both values
persist and their delta is the output.

## Why `Precedes` and not `Blocks` — and why ADR-0001 survives

Measured 2026-08-23 over the same 2,610-ticket corpus as the migration cohorts below: **392
directed `Blocks` edges, of which 248 (63.3%) sit in 124 mutual pairs.** The majority of the corpus carries **no usable direction**, because frontmatter has
no way to write the inverse — `LINK_TYPES` (`links.mjs:14`) is a bare Set and `lintLinks` refuses
anything outside it, so `Blocked by` is a display string the database knows and the authoring path
cannot emit. "Is blocked by" gets written as a second `Blocks` from the other end.

Enforcing `Blocks` would mean enforcing a direction the corpus does not contain, and CPM over a
graph where two thirds of the edges point both ways produces a schedule that is confidently wrong.

**So `Blocks` keeps its advisory meaning, its `applyMove` warning pass, and ADR-0001 unchanged.**
`Precedes` is a new, separately declared type that has never been advisory and therefore reverses
nothing. **No superseding ADR is raised**, and the 392 existing edges are **not machine-migrated** —
`blaze schedule import-deps` reports each with a proposed direction and marks all 124 mutual pairs
**undecidable**. The operator resolves them; the tool never guesses.

## The migration, recorded verbatim

This ADR changes the meaning of two fields every existing board already populates, so the cohorts
are recorded here rather than only in the spec. Measured 2026-08-23 over 2,610 tickets:

```
40 of 2,610 tickets (1.53%) carry any date at all
  38 carry both start and due
   2 carry due with no start
   0 carry start with no due
```

| Cohort | Count | What happens to it |
|---|---|---|
| **Terminal, start + due** (all `done`) | **27** | **Kept verbatim and frozen as actuals.** Not constraints, not discarded. |
| **Terminal, due only** | **1** | kept verbatim as an actual |
| **Non-terminal, start + due** | **11** (`defined` 9, `in-progress` 2) | `due` → **`deadline`**; `start` → **`constraint_start_no_earlier_than`**; both derived columns cleared and recomputed |
| **Non-terminal, due only** | **1** — `OMA-4`, `due: 2026-10-20` | `due` → **`deadline`**; no start constraint |
| **No dates at all** | **2,570 (98.5%)** | nothing to interpret; no constraints created |

**The answer is "a one-time interpretation, split on terminality", and the split is what makes it
correct.** Both uniform alternatives destroy information: making everything a constraint invents 28
commitments nobody made, all already in the past; discarding everything throws away `OMA-4`, the
clearest evidence in the corpus that `deadline` has the right shape.

**The 40 affected ids are the evidence the change is small enough to review by hand.** They are
listed in the migration commit body, and `scripts/migrate/zero-diff.mjs` gains an explicit
expected-delta list of exactly those 40 — a 41st changed ticket fails the oracle. Silencing the two
fields in the oracle instead would delete the check that catches the real accident.

## Consequences

**Five typed columns on `ticket`**, no JSON tail: `constraint_start_no_earlier_than` and `deadline`
(inputs), `float_minutes`, `is_critical` and `schedule_run_id` (derived). `start_date` and
`due_date` keep their names — **no rename** — so every reader keeps working; what changes is who is
allowed to write them. Two are indexed, comfortably inside ADR-0018's **200-filterable-fields-per
install** cap, and `is_critical` is a plain column, never a `STORED` generated column.

**The write path closes behind it.** `start` and `due` leave `EDITABLE_FIELDS`; `not_before` and
`deadline` take their place, making that file's existing comment true for the first time. A write to
`start`/`due` is refused with a message naming the replacement field — a refusal that does not name
the replacement is a defect.

**DB schema version goes 1 → 2**, installing `linkDdl`, `hierarchyDdl` and the five `ticket`
columns.

**`viewDdl` was in this list and is not installed** — amended under BLZ-370 after implementation
measured why it could not be. `view` must live in the `blaze_config` namespace, because its
foreign keys to `project` and `view_type` cannot cross a SQLite database file; and **nothing in
`scripts/` installs `blaze_config` at all** — `configDdl` is exported and called only from its own
test. The original reasoning was *"given one unavoidable version bump, adding `view` costs one
DDL"*; it costs a namespace with no install path. Nothing in the scheduler reads `view`, so
deferring it blocks nothing. **BLZ-377** installs `blaze_config` and `viewDdl` together, and a test
pins the current absence so it inverts deliberately rather than drifting.

**`MIN_DB_SCHEMA_VERSION` rises to 2 as well**, which this ADR originally left unstated. A
version-1 database has no `link` table and none of the five columns, so a version-2 engine that
accepted it would fail later with a raw SQL error rather than a named refusal. That is affordable
because the database is derived: the shadow lives under `.blaze/` and `blaze db init --force`
rebuilds it from the corpus. There is no upgrade path and version 2 adds none. This is the installation event the scheduler cannot be built without, because
`Precedes` lives in the v4 `link` table and `createDbSchema` installs no v4 table at all.

**The schedule is computed lazily** by a pure whole-graph JS pass; the derived columns are a cache,
not the truth. ADR-0016 measured CPM at 10k tasks / 25k edges = 95.7 ms, and eager writing loses on
write fan-out — editing one edge changes an unbounded set of downstream dates, and the filesystem
write port has no transaction spanning N files.

## What this does NOT solve

**Resource levelling is the largest honest gap** — one person on two zero-float tasks schedules both
in parallel. Also unsolved: working calendars beyond a fixed week; dependency types other than
finish-to-start; elapsed-vs-effort duration; baselines and schedule variance; probabilistic
estimates; sprint-vs-dependency conflict resolution; and automatic `Blocks → Precedes` migration.

## What would reverse this

A ruling that a `deadline` should act as a late-finish constraint would change the forward pass —
this ADR deliberately has `deadline` bound nothing, read only by `scheduleFindings`, and that
escalation beyond BLZ-360's own wording is flagged in the spec as the spec's inference. And if
`Blocks` were later made a hard gate, ADR-0001 §Consequences already documents the mechanical
reversal path; that option stays cheap and is not exercised here.
