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

## What the scheduler treats as a node — amended under BLZ-388

BLZ-360 §6.2's numbered filter list names the edge-kind rule and `isTerminal` and nothing else,
while §6.2's cycle row and §7.1 both call the population *"the non-terminal **delivery** graph"*.
The implementation had to pick one, flagged its choice as an inference (BLZ-383), and this records
the decision. It also closes BLZ-378, because the two turned out to be the same question.

> **A node is a ticket whose type is a declared `Precedes` source kind, and which is not terminal.
> The node set and the edge set are read from the SAME `link_type` entry, so they cannot drift.**

**This is narrower than "the delivery workflow", by exactly one type: `epic`.** Verified across the
whole registry: of the **ten** registered types (`goal`, `requirement`, `architecture`, `feature`,
`risk`, `story`, `task`, `bug`, `subtask`, `epic`), `epic` is the **only** one the two rules
classify differently. `Precedes`' `source_kinds` and `target_kinds` are also identical, so a node set taken
from the source set cannot disagree with the target set about what may be an endpoint.

Dropping `epic` is the substance of the decision, and the reason is not that it is retired — it is
that **an epic is a container, and a container's dates are a roll-up OF the finished schedule
rather than an input to it.** BLZ-360 §8.3 states exactly this, and it is the argument:

> *"The scheduler itself uses neither roll-up… CPM runs over the dependency graph; a parent's dates
> are a roll-up **of** the finished schedule, computed afterwards. The two are different operations
> over different graphs."*

Putting a parent in the CPM graph computes the same quantity twice by two methods, and §3's
authority rule has no way to arbitrate between two *derived* values that disagree.

**Stated plainly, because it is a real consequence and not a tidy one: the date roll-up does not
exist yet.** §8.3 is explicit that spec 4 owns it and that *"neither existing roll-up is the right
one as written"* — `rollup.mjs` and `hierarchy-rollup.mjs` both sum `estimate`/`worklog` numbers,
neither touches a date. So today an `epic` gets **no derived dates from anywhere**: it is no longer
given CPM dates it should never have had, and the roll-up that should supply them is unbuilt. That
is inert on this board — **zero** tickets of type `epic`, measured — and it is the honest position
rather than leaving a container holding dates computed the wrong way. An earlier draft of this
section said an epic *"draws a bar from rolled-up dates"*, which asserted machinery that does not
exist; the bar it draws today comes from whatever `start`/`due` it carries.

**The claim that matters is the invariant, not a count: the two rules differ by exactly `epic`, and
the board holds zero tickets of type `epic`, so they select the same set.** Verified 2026-08-25 by
running both against the live corpus — identical node sets, zero ids in either difference. The
cardinality that day was 538 and it moves whenever a ticket is created or closed, so it is recorded
here as incidental rather than as the evidence. (An earlier draft of this paragraph said 535, which
was true when written and stale three tickets later — in the same session.) So this changes no
schedule today. It is taken for the structural reason
rather than the behavioural one — a rule read from one place cannot drift from itself, and the
alternative left `workflowFor` as a second definition of "schedulable" sitting beside the declared
endpoint kinds.

**The limitation this rule introduced, and how it was closed — BLZ-392.** The old filter read
`workflowFor`, which resolves through the **override-merged** type registry; this one read
`DEFAULT_LINK_TYPES`, a constant. `resolveSchema` merged `schema.types` and `schema.workflows` and
had **no override path for link types at all** — so an installation that added its own delivery
type (`spike`, say) got a type that is not a `Precedes` endpoint and therefore **not a node**, where
the old rule would have scheduled it as an isolated one, and it could not be *made* one.

**The decision: endpoint kinds ARE overridable.** `resolveSchema` now layers `schema.linkTypes`
exactly as it layers `schema.types` and `schema.workflows` — default → top-level → project, later
wins — and `scheduleModel` takes the resolved list. The alternative, declaring a custom delivery
type deliberately unschedulable, was rejected: the engine already lets an installation add a
delivery type, and a capability that cannot be completed is worse than one that was never offered.
The coherence argument for the old behaviour — *a type that can never carry a dependency edge
gains nothing from CPM over its own estimate* — is exactly right, and it is the reason the fix is
an override of **which types may carry an edge** rather than a second definition of "schedulable"
sitting beside the endpoint kinds. **The invariant BLZ-388 took the constant for is preserved: the
node set and the edge set still come from one `Precedes` entry, now the resolved one.**

Three consequences, stated because none is free:

- **Replacement is wholesale at the link-type name**, as `mergeWorkflows` already replaces a
  workflow. Deep-merging `source_kinds` would make *removing* a kind unexpressible. BLZ-361's
  lesson about wholesale replacement silently dropping what it does not restate is answered by
  `validateSchema` reporting an endpoint kind that names no declared type — a typo'd kind matches
  nothing, which would leave the type it was meant to schedule silently unschedulable again.
- **`scheduleModel` defaults `linkTypes` to the constant**, so the pure model stays usable
  standalone. That default is a trap for exactly one caller, the production one, because
  forgetting to pass the resolved value reinstates the old bug with no visible symptom.
  `tests/model/link-type-overrides.test.mjs` greps `audit-runner.mjs` to keep it passing them.
- **A list declaring no `Precedes` schedules nothing**, rather than falling back to the default
  behind the operator's back. That is the honest reading of the declaration.

Still invisible on this board, which has no `schema.linkTypes` override — so this changes no
schedule today either.

**The rejected alternative and why it lost.** Adding `epic` to `Precedes`' endpoint kinds would
have made the two definitions agree the other way, at the cost of amending the declared list above
*and* putting a container on the critical path. The roll-up argument rules it out on its own: an
epic with a CPM-derived finish and a rolled-up finish would carry two dates that disagree, and
§3's authority rule has no way to arbitrate between two derived values.

## The backward pass's horizon — amended under BLZ-380

BLZ-360 §13.3 left this open: *"the latest EF is self-referential; the latest `deadline` is
undefined when no deadline exists."* Spec 3 §13 item 1 proposed `max(EF)` and argued the
self-reference is apparent. That was a proposal into an open question; this is the decision, taken
before the backward pass was written because a backward pass cannot be tested against an unstated
seed. It follows the `viewDdl` precedent above — an implementation-forced closure recorded here
rather than only in a spec.

> **The horizon is `max(EF)` over the completed forward pass: one constant, computed once, over
> every scheduled node on the board. When no node is scheduled, the horizon is `project_epoch`.**

**The self-reference is apparent, not real.** The forward pass runs to completion before the
backward pass starts, so by the time the horizon is read it is an ordinary number, not a value
being defined in terms of itself.

**The fallback guards "no node is scheduled", not "the graph is empty", and the difference is
reachable.** §6.2 marks every member of a `Precedes` SCC `unscheduled`, so a graph consisting
solely of a cycle is non-empty and yet has nothing to take a maximum over. Both cases take
`project_epoch`, and the synthetic cycle §6.2 already requires is the test that proves it — an
earlier draft of this section guarded the graph rather than the scheduled set and would have left
that path at `-Infinity`.

**What it buys: float is never negative, so `is_critical` is total.** *Sink* below means a node
with no successor **in the solved graph** — §6.2 has already removed terminal nodes and SCC
members, so a node whose only successors were filtered out is a sink here, and no step of the
induction ever asks for an `LS` that does not exist.

- **Base case.** For a sink `s`, `LF(s) = H`. `H` is a max over the *same* EFs the forward pass
  finished with, so `H ≥ EF(s)` and therefore `LS(s) = H − dur(s) ≥ ES(s)`.
- **Step.** `LF(n) = min over successors s of (LS(s) − lag)`. The forward pass took a max, so
  `ES(s) ≥ EF(n) + lag` holds **for either sign of `lag`** — `link` puts no CHECK on it, and a
  negative lag is a lead. With `LS(s) ≥ ES(s)` from the induction, `LS(s) − lag ≥ EF(n)`, so
  `LF(n) ≥ EF(n)` and `float(n) = LS(n) − ES(n) ≥ 0`.

A `constraint_start_no_earlier_than` does not threaten this, and the reason is the base case rather
than the step: raising `ES(s)` raises `EF(s)`, and `H` is a maximum over post-constraint EFs, so
the constraint is already inside the number the induction bottoms out on. (An earlier draft argued
it "strengthens the inequality" — that pointed at `ES(s) ≥ EF(n) + lag`, which was never the
inequality at risk.)

**One consequence of a lead worth stating, so nobody later "fixes" it.** With a negative lag,
`LF(n)` can exceed `H`: the horizon bounds late finish for sinks, not for every node. Clamping
`LF` to `H` would look tidier and can drive `LS` below `ES`, which is the negative float this whole
rule exists to make impossible.

### The alternatives, and why each lost

| Rejected | Why |
|---|---|
| **`max(deadline)`** | It stops being a function of the plan. Undefined when **no** ticket carries a deadline — BLZ-360 §13.3's actual condition, and the ordinary case for a board that uses none. When it *is* defined it is unanchored in either direction: on this corpus the single future deadline dominates all eleven past ones, so `max(deadline)` is `OMA-4`'s **2026-10-20** against a latest EF of `project_epoch + 10.0 working days` (spec 3 §2.3), pushing every sink's `LF` weeks out so that **nothing has zero float and `is_critical` is empty**; on a board whose deadlines are all past it fails the opposite way, driving float negative board-wide. Measured 2026-08-24: **11 of the 12** non-terminal deadlines are already in the past, which is the evidence for the second mode and says nothing about the maximum. |
| **`max(max(EF), max(deadline))`** | When a deadline is the maximum it makes `deadline` bound `float_minutes` and `is_critical` — on this corpus that is the live case, not the corner one. When it is not, it is `max(EF)` exactly. So it buys nothing except in the one case this ADR forbids. |
| **Per-sink horizon — `LF(sink) = its own EF`** | Every sink then has zero float. Not every *path* back from one does — only the binding predecessor chain reaches zero — but making every sink critical by construction is enough to stop `is_critical` discriminating on a board that is mostly isolated nodes. It is not a horizon; it is the absence of one. |
| **Per-connected-component horizon** | Gives every island its own critical path, so `is_critical` comes to mean *"critical within my island"* and the consumers that read the column board-wide — the SQL view, spec 4's Excel export, spec 2's capacity query — get hundreds of trivially-critical rows. §6.2 fixes the unit of solve as **the board, not the project**, and that is the whole argument. An earlier draft also cited ADR-0014 here; ADR-0014 rules out a tenancy discriminator **column** and does not mention the scheduler, a graph or a component, so the citation was decoration and is withdrawn. |
| **An operator-configured horizon** | An input that moves a derived output, which is the same objection as `max(deadline)` one step further out, plus a second number that has to be kept true by hand. |

**The decisive argument is the one already in §Decision.** Within the solve, `deadline` bounds
nothing in the CPM passes and is read only by `scheduleFindings` — the view layer reads it too, for
spec 3 §2.3's axis window and its deadline pin, and that is a rendering rather than a bound. A
`deadline` in the forward pass would move `due_date`; a `deadline` in the backward pass's seed
would move `float_minutes` and `is_critical`. Both are the overwrite the operator ruled out, one
indirection later, and the same rule refuses both.

## What this does NOT solve

**Resource levelling is the largest honest gap** — one person on two zero-float tasks schedules both
in parallel. Also unsolved: working calendars beyond a fixed week; dependency types other than
finish-to-start; elapsed-vs-effort duration; baselines and schedule variance; probabilistic
estimates; sprint-vs-dependency conflict resolution; and automatic `Blocks → Precedes` migration.

## What would reverse this

A ruling that a `deadline` should act as a late-finish constraint would change the forward pass
and the backward pass's horizon —
this ADR deliberately has `deadline` bound nothing in those passes, read only by `scheduleFindings`
within the solve, and that
escalation beyond BLZ-360's own wording is flagged in the spec as the spec's inference. And if
`Blocks` were later made a hard gate, ADR-0001 §Consequences already documents the mechanical
reversal path; that option stays cheap and is not exercised here.
