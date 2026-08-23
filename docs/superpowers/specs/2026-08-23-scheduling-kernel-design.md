# Blaze v4 — the scheduling kernel: constraints are inputs, dates are derived

**Status:** draft for review · **Date:** 2026-08-23 · **Kernel spec, BLZ-360**

This settles one of the two kernel questions that must land before specs 2 (agile execution),
3 (Gantt / critical path) and 4 (hierarchy reporting + Excel) can be written. It defines the
constraint fields, the derived fields, which is authoritative when they disagree, how today's
hand-set dates migrate, how a schedule conflict is represented, which link store carries
dependency edges, and the scheduling semantics themselves.

**The operator's decision, recorded in BLZ-360 and not revisited here:**

> **Constraints are inputs; dates are derived.**

| | Field | Who sets it |
|---|---|---|
| **Input** | `estimate`, dependency edges, `constraint_start_no_earlier_than`, `deadline` | the operator |
| **Derived** | `start_date`, `due_date`, float/slack, critical path | the scheduler |

Every number below is measured against the live 2,610-ticket board or against a cited ADR
benchmark. Where something is a judgement call with no evidence behind it, it says so.

---

## 1. What the code actually says today

Verified, not assumed. Four of these contradict something the ticket or the plan asserts.

| Claim | Verdict | Evidence |
|---|---|---|
| `gantt.mjs` branches on `r.start`/`r.due` into `solid`/`open-end`/`open-start`/`unplanned` | **confirmed** | `scripts/model/gantt.mjs:67-74` |
| `ticket` carries `estimate_minutes`, `start_date`, `due_date` | **confirmed** | `scripts/model/sqlite-schema.mjs:41,44-45`; frontmatter keys are the short `estimate`/`start`/`due` (`scripts/model/index.mjs:214-215`) |
| The v4 `link` table's `DEFAULT_LINK_TYPES` has no dependency type | **confirmed** | `scripts/model/link-schema.mjs:12-24` — `Implements`, `Addresses`, `Verifies`, `Supersedes`, `Derives`. Nothing else. |
| Not one v4 table ships | **confirmed** | `createDbSchema` (`db-schema-version.mjs:127-160`) execs `SQLITE_DDL`/`PG_DDL` + `metaDdl` and nothing else. `linkDdl`, `hierarchyDdl`, `artifactDdl`, `documentDdl`, `fieldDdl` are all defined and **called by no create path**. |
| There are *two* competing link stores | **wrong — there are three** | v3 frontmatter `links:` (`links.mjs`), the v3 **`ticket_link` table which does ship** (`sqlite-schema.mjs:95`), and the v4 `link` table which does not. The ticket names only the first and third. |
| `fields.mjs` says "id/project/dates are read-only" | **the comment contradicts the code** | `EDITABLE_FIELDS` (`fields.mjs:13-16`) contains `"due"` and `"start"`; `new-runner.mjs:47-48` accepts `--start`/`--due`. §4 makes the comment true. |
| Recommended spec order 3 → 2 → 4, "spec 4 last because it is the schema-installation event" | **circular, and this spec breaks the circle** | the scheduler (spec 3) needs the v4 `link` table; spec 4 is where tables get installed; spec 4 runs last. See §6.4. |

### 1.1 The live dependency corpus, measured

```
2,610 tickets · 392 directed `Blocks` edges over 317 tickets · 1,691 tickets (64.8%) carry an estimate
```

| Measurement | Value | What it means |
|---|---|---|
| Distinct `Blocks` edges | 392 | |
| **Mutual pairs (`A→B` *and* `B→A`)** | **124 pairs = 248 edges = 63.3% of all edges** | the majority of the corpus carries **no usable direction** |
| Strongly-connected components | **39, spanning 135 tickets** | the `Blocks` graph is **not a DAG** |
| SCCs containing a non-terminal ticket | 15, spanning 27 open tickets | |
| Dangling targets | **0** | link hygiene is not the problem here; direction is |
| Cross-project edges | 22 | |

**The root cause is nameable, and it is a modelling gap rather than user error.** `LINK_TYPES`
(`links.mjs:16`) is `{Blocks, Relates, Duplicate, Cloners, Implements, Addresses}` — **there is
no inverse for `Blocks`.** So "is blocked by" gets written as a second `Blocks`. INF-276's body
says *"**Blocked by INF-275** (need FreshRSS running…)"* while its frontmatter says
`{ type: Blocks, target: INF-275 }`, and INF-275 says the same thing back. That is the whole
124-pair phenomenon.

Under ADR-0001's advisory semantics a cycle costs nothing, so nothing ever surfaced it. Under
CPM semantics a cycle is fatal. **This measurement is the single most load-bearing input to §5.**

---

## 2. Field shape

**Typed columns on `ticket`. Nothing goes in the JSON tail.** ADR-0018's rule is that a field
which is *filterable, sortable, or constrained* becomes a real named column, and every field
below is all three: the scheduler filters on them, views sort on them, and spec 2's capacity
query and spec 4's export both read them from SQL without a JS pass.

`extra_json` keeps its existing job — round-tripping unrecognised frontmatter keys — and gains
nothing here.

### 2.1 Inputs — the operator writes these

| Column (`ticket`) | Frontmatter | Type | Notes |
|---|---|---|---|
| `estimate_minutes` | `estimate` | INTEGER | **unchanged.** Existing CHECK (`>0 AND %5=0`) stands. |
| `constraint_start_no_earlier_than` | `not_before` | TEXT, ISO date | **new.** A lower bound on the derived start. Nullable; most tickets have none. |
| `deadline` | `deadline` | TEXT, ISO date | **new.** An external commitment. **Never clamps anything** — see §4. |

The long column / short frontmatter key split follows the existing precedent exactly
(`estimate` → `estimate_minutes`, `start` → `start_date`, mapped in `sqlite-storage.mjs:25-26`).
The column keeps the operator's own name from BLZ-360 so the decision and the schema use one word.

### 2.2 Outputs — only the scheduler writes these

| Column (`ticket`) | Frontmatter | Type | Notes |
|---|---|---|---|
| `start_date` | `start` | TEXT, ISO date | **same column, opposite ownership.** Was an input; is now a derived earliest start. |
| `due_date` | `due` | TEXT, ISO date | same, derived earliest finish. |
| `float_minutes` | `float` | INTEGER | late start − early start. `0` = critical. |
| `is_critical` | `critical` | INTEGER 0/1 | denormalised so a SQL view can filter without a JS pass. **A plain column, never a `STORED` generated column** (ADR-0018: 2,002 ms rewrite on Postgres, impossible on SQLite). |
| `schedule_run_id` | `schedule_run` | TEXT | the id of the run that wrote the four fields above. Makes staleness detectable and makes the derived set atomically identifiable. |

**No rename.** `start_date`/`due_date` keep their names, so every reader — `gantt.mjs`,
`sqlite-storage.mjs`, `pg-storage.mjs`, `write-port.mjs`, `zero-diff.mjs` — keeps working. What
changes is **who is allowed to write them**, which is §4's migration and a write-path change,
not a schema break for readers.

### 2.3 Calendar

`schedule.minutes_per_day` (default `480`) and `schedule.working_days` (default `Mon–Fri`) live
in board config, not on the ticket. `minutes_per_day` is the single conversion between
`estimate_minutes` and calendar arithmetic, and it is also spec 2's capacity unit — one number,
two consumers, no second definition. **Holidays and per-person calendars are not solved** (§9).

### 2.4 Field-budget impact

Five new columns on `ticket`. ADR-0018's cap is **200 filterable fields per table**; `ticket`
had 31 columns of which 5 were indexed and filtered. This adds two indexed (`is_critical`,
`deadline`) — comfortably inside the cap, and it must show in `blaze db status` like every other
promoted column.

---

## 3. Authority when input and output disagree

**One rule, stated once:** the operator owns the inputs, the scheduler owns the outputs, and
**neither ever writes the other's fields.**

A `deadline` and a derived `due_date` that disagree is not a contradiction to be resolved. It is
the finding this whole model exists to produce (§4). The `deadline` is not moved to match the
schedule, and the `due_date` is not clamped to match the deadline. **Both values persist, and
their delta is the output.**

The one exception is stated in §6.4: a ticket in a **terminal** status is never scheduled, and
its `start_date`/`due_date` are actuals owned by history, not by either party.

---

## 4. Migration — answered, not deferred

The ticket calls this "the question that will bite." Here is the measurement it needs.

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

**The answer is therefore "a one-time interpretation, split on terminality" — and the split is
what makes it correct.** The two rejected uniform answers both destroy information:

- *Everything becomes a constraint.* Wrong for the 28 terminal tickets: pinning a finished
  ticket's actual finish date as a future `deadline` invents 28 commitments nobody made, all of
  them already in the past, and every one would immediately raise a `deadline-unreachable`
  finding on day one. That is the exact "gate people learn to skip" failure `audit.mjs`'s own
  header warns about.
- *Everything is discarded.* Wrong for the 12 open ones. `OMA-4`, a `defined` task carrying
  `due: 2026-10-20` with no `start`, is a hand-typed external commitment — the single clearest
  proof in the corpus that the `deadline` field has the right shape. Throwing it away throws away
  the only real evidence the model is right.

**Why terminal dates become actuals rather than anything else.** A done ticket's dates already
describe what happened. Re-deriving them would overwrite history with a forecast, and a forecast
of the past is not a number anyone wants. `isTerminal(type, status)` (`workflows.mjs:87`) is the
existing predicate; the scheduler uses it and nothing new is invented.

### 4.1 How the migration is executed and proven

1. `blaze schedule migrate-dates --dry-run` prints one line per affected ticket naming the cohort
   and both the old and new field. **All 40 ids fit on one screen.** It is reviewed by a human
   before the write.
2. The write is one commit, and the 40 ids are listed in the commit body.
3. **The zero-diff oracle is extended, not weakened.** `scripts/migrate/zero-diff.mjs:63` already
   compares `start` and `due`. Under this migration those two fields change *on purpose*, so the
   oracle gains an explicit expected-delta list of exactly those 40 ids. A 41st changed ticket
   fails the oracle. Silencing the two fields instead would delete the check that catches the
   real accident.

### 4.2 The write path closes behind it

`start` and `due` leave `EDITABLE_FIELDS` (`fields.mjs:13-16`) and `--start`/`--due` leave
`new-runner.mjs:47-48`. `not_before` and `deadline` take their place. The comment already sitting
above `EDITABLE_FIELDS` — *"id/project/dates are read-only"* — becomes true for the first time.

A write to `start`/`due` through `/api/edit` is refused with a message naming the replacement
field: `start is derived by the scheduler; set 'not_before' to constrain it`. **A refusal that
does not name the replacement field is a defect** — that is spec 1 §4.2's rule and it applies here.

---

## 5. Which link store carries dependency edges

**The v4 `link` table, with a new declared type `Precedes` / inverse `Follows`. Not `Blocks`.**

### 5.1 Why not `Blocks`

Because 64.8% of the live `Blocks` edges carry no usable direction (§1.1). Enforcing `Blocks`
means enforcing a direction the corpus does not contain, and CPM over a graph where two thirds of
the edges point both ways produces a schedule that is confidently wrong. The measurement, not a
preference, decides this.

### 5.2 What this buys: ADR-0001 is not reversed

The ticket anticipated that enforcing `Blocks` would reverse ADR-0001 and need a superseding ADR.
**It does not, because `Blocks` is not the field being enforced.** `Blocks` keeps its advisory
meaning, its `applyMove` warning pass, and its ADR unchanged. `Precedes` is a new, separately
declared type that has never been advisory and so reverses nothing.

**The contingent ADR, drafted as BLZ-360 asks, and deliberately not raised.** If a later decision
does make `Blocks` a hard gate:

> **ADR-00xx (not raised):** `Blocks` is a hard gate — a move to `in-progress` is refused while
> an open ticket holds a `Blocks` link targeting it, moving the existing check from `applyMove`'s
> `warnings` pass into `planMove`'s `{ ok: false, errors }` path.

ADR-0001 §Consequences already documents that exact mechanical move as the reversal path, so the
option stays cheap. It is not exercised here.

### 5.3 What `Precedes` looks like

Added to `DEFAULT_LINK_TYPES` (`link-schema.mjs:12`):

```js
{ name: "Precedes", inverse_name: "Follows",
  source_kinds: ["feature", "story", "task", "bug", "subtask"],
  target_kinds: ["feature", "story", "task", "bug", "subtask"],
  min_card: 0, max_card: null }
```

Endpoints are **declared, and anything undeclared is refused** (ADR-0015, already the file's
stated default). One new column on `link`:

```
lag_minutes  INTEGER NOT NULL DEFAULT 0
```

**Stated honestly: this is a scheduling-specific column on a generic table, and it is a smell.**
It is taken anyway because a zero-default column costs nothing now and retro-fitting one costs a
schema-version bump later, and because the alternative — a `link_schedule` side table for one
integer — is worse. Every non-dependency link type ignores it.

### 5.4 The default-deny endpoint rule does most of the cleanup for free

Restricting `Precedes` to delivery types, and skipping terminal tickets because they are never
scheduled, collapses the cycle problem measured in §1.1:

| | All `Blocks` edges | Restricted to delivery types |
|---|---|---|
| Edges | 392 | **334 (85.2%)** — 58 refused, almost all `risk ↔ feature` pairs |
| SCCs | 39 over 135 tickets | **25 over 99 tickets** |
| **SCCs containing a non-terminal ticket** | **15, 27 open tickets** | **3, 4 open tickets** |

The three survivors are `INF-275↔INF-276`, `OBA-246↔INF-281`, and `INF-95/36/99/100/37`.
**The operator's real cycle-resolution backlog is three items, not thirty-nine.** A risk does not
belong in a delivery critical path, `gantt.mjs:24` already excludes non-delivery types from bar
rows, and the link meta-model's default-deny enforces the same rule one layer down.

### 5.5 The 392 existing `Blocks` edges are not machine-migrated

`blaze schedule import-deps --dry-run` reports each of the 392 `Blocks` edges with a proposed `Precedes`
direction and marks each of the 124 mutual pairs **undecidable**. The operator resolves them; the
tool never guesses. Rationale: a machine that picks a direction for a mutual pair is right half
the time, and the wrong half becomes an invisible schedule error.

`Blocks` and `Precedes` **coexist indefinitely**. `Blocks` stays the advisory human signal;
`Precedes` is the scheduler's input. They are not required to agree, and nothing lints them
against each other — that would be a rule with no correct answer while §5.5 is in progress.

### 5.6 The third link store

`ticket_link (src_id, link_type, target_id)` ships today in `SQLITE_DDL`/`PG_DDL` and is the v3
projection of frontmatter `links:`. It carries `Blocks` and therefore keeps carrying `Blocks`.
It is **not** where `Precedes` lives: it has no inverse, no cardinality, no endpoint declaration
and no room for `lag_minutes`. Naming it here so the "two link stores" framing does not persist.

---

## 6. Scheduling semantics

### 6.1 The passes

Standard CPM over the `Precedes` DAG, **finish-to-start only** in v1:

- **Forward pass** → early start (ES), early finish (EF). `ES = max(project_epoch, not_before, max over predecessors of (EF_pred + lag))`. `EF = ES + duration`.
- **Backward pass** → late start (LS), late finish (LF), seeded at the schedule horizon.
- **Float** = `LS − ES`, written to `float_minutes`.
- **Critical path** = the maximal chain of zero-float tickets. `is_critical = (float_minutes == 0)`.
- `start_date = ES`, `due_date = EF`.

`project_epoch` is the injected `now`, floored to the next working day. A plan that starts in the
past is not a plan.

**Determinism is a hard requirement**, inherited verbatim from `gantt.mjs`'s header: no
`Date.now()` and no `Math.random()` inside the model, `now` injected by the caller, a
locale-independent `cmp` (never `localeCompare`), and ties broken by ticket id. The golden-output
tests depend on it.

### 6.2 The four cases BLZ-360 names

| Case | Behaviour | Why |
|---|---|---|
| **Cycle in the graph** | The SCC is found by one Tarjan pass. **Every member is marked `unscheduled`, reason `dependency-cycle`, and the rest of the graph still schedules.** Edges *into* the SCC from outside are honoured; edges *out of* it are treated as unconstrained. | Non-negotiable: 25 SCCs exist in the live delivery graph today. A scheduler that refuses to produce any output because of a cycle among four `done` tickets is a scheduler nobody runs. The out-edge relaxation is an **approximation and is stated as one** — successors of a cycle get an optimistic date. |
| **Ticket with no estimate** | `duration = 0`. It is a **milestone**, not an error: `ES = EF`, and it still propagates its predecessors' finish to its successors. A soft finding is raised only if the ticket's *type* declares `estimate` required (`story`/`task`/`bug`, per `schema.mjs:20-22`). | 35.2% of the corpus has no estimate. Erroring is not available. A zero-duration node is the standard CPM answer and it keeps the chain connected. |
| **Constraint but no dependencies** | `not_before` is simply a lower bound in the forward pass; with no predecessors, `ES = max(project_epoch, not_before)`. A `deadline` with no dependencies still produces a finding when `EF > deadline`. | The constraint fields are not parasitic on the dependency graph. This is the common case for the 12 migrated open tickets in §4, and it must work with zero edges. |
| **Dependency crossing projects** | **Allowed and scheduled.** The scheduler's unit of solve is **the board, not the project.** | 22 cross-project `Blocks` edges exist today, and ADR-0014 forbids a board discriminator — so there is exactly one graph and pretending otherwise is a fiction. A project-scoped view that shows a date derived from a foreign chain **must say so**: every finding and every critical-path output carries the full chain including foreign ids. |

Two more cases, decided here because they will otherwise be discovered in implementation:

| Case | Behaviour |
|---|---|
| **Terminal ticket** | Never scheduled. Its `start_date`/`due_date` are actuals (§4). As a predecessor it does not hold anything back: `EF = its actual due, or project_epoch if it has none`. |
| **Dangling `Precedes` target** | The edge is dropped from the solve and raises the existing `dangling-target` HARD audit finding. Zero exist today, and the link meta-model's FK makes it unreachable in the DB path — the rule exists for the frontmatter path until §5.5 completes. |

### 6.3 Eager or lazy

**Lazy. The schedule is computed on read by a pure whole-graph JS pass. The derived columns are a
cache, not the truth.**

Evidence:

- ADR-0016 measured **CPM at 10k tasks / 25k edges = 95.7 ms** (50.4 ms DB + 45.3 ms JS). The live
  board is **2,610 tickets and 334 delivery edges** — roughly 4× and 75× below that point
  respectively. A full re-solve at real size is single-digit milliseconds.
- ADR-0016 measured a whole-tree JS pass beating a recursive CTE **6.0×** (762.7 ms vs 4,585.9 ms
  at 100k). Both existing roll-ups already follow this shape.
- **Eager loses on write fan-out, which is the decisive argument.** Editing one dependency edge
  changes the dates of an unbounded set of downstream tickets. An eager writer must write N rows
  per edit — and on the filesystem write port there is no transaction spanning N files, so a
  crash mid-fan-out leaves the board internally inconsistent with no way to tell. Lazy has no
  fan-out to lose.

**How the cache stays honest:**

- `blaze schedule --write` is the one explicit command that persists the derived columns, stamping
  `schedule_run_id`.
- Any reader may recompute instead of reading, and **a conformance test asserts the two agree** on
  the real corpus, on both engines. Recomputed-vs-persisted divergence is a bug in the writer.
- Persisted columns exist for exactly the consumers that cannot run the JS pass: Excel export
  (spec 4), a SQL view filtering `is_critical`, and spec 2's capacity query.
- A row whose `schedule_run_id` is not the latest is **stale, and views must render it as stale**
  rather than as a date. A stale date that looks live is worse than no date.

**The ADR-0016 event-loop hazard is real and scoped, not hand-waved.** `JSON.stringify` of
overlapping 5k-row sets stalled the loop at p50 210.6 ms. A CPM solve is the same class of heavy
synchronous work. The measured answer is `worker_threads` (5.63× throughput). **There is no
`worker_threads` usage anywhere in the repo today**, so this is new machinery, and it is
deliberately not in v1. The trigger to build it: **a solve exceeding 50 ms, or a board exceeding
10k schedulable tickets** — whichever comes first, measured, not guessed.

### 6.4 The schema-installation event moves to this kernel

**This contradicts BLZ-360's recommended ordering and the contradiction is real.** The ticket
says spec 4 goes last *because* it is the schema-installation event, and simultaneously that spec 3
(the scheduler) comes first. But `Precedes` lives in the v4 `link` table, and **`createDbSchema`
installs no v4 table at all**. Spec 3 cannot be built on a table spec 4 has not yet installed.

**Resolution:** installation moves here. `DB_SCHEMA_VERSION` goes **1 → 2**, and `createDbSchema`
gains `linkDdl(dialect)` plus the five `ticket` columns from §2. Spec 4 stops being the
installation event and becomes an ordinary consumer. The existing guard already handles the
consequence correctly — an engine at version 1 opening a version-2 database gets `state: "newer"`
and a refusal naming the upgrade, which is exactly the defect `db-schema-version.mjs` was written
for.

`blaze db migrate` must add the five columns via `ALTER TABLE ADD COLUMN` — the **9.0 ms
metadata-only path** (ADR-0018), never a generated column, and `STRICT` stays on every SQLite
table that holds them.

---

## 7. Conflict representation

**Both a `blaze audit` finding and a view-level warning — and they read from one function,
`scheduleFindings(schedule)`, so they cannot drift.** A conflict that shows on the Gantt but not
in CI is invisible to an agent; one that shows only in CI is invisible to the operator.

### 7.1 The findings

| Kind | Severity | Raised when |
|---|---|---|
| `deadline-unreachable` | **soft** | derived `due_date` > `deadline` |
| `dependency-cycle` | **soft, with a named flip trigger** | a `Precedes` SCC contains a non-terminal ticket |
| `schedule-stale` | soft | `schedule_run_id` is not the latest run |

**Why `deadline-unreachable` is soft.** `audit.mjs`'s own header defines the split: HARD means
*the corpus is WRONG*. A missed deadline means the **plan** is wrong, which is a true and useful
statement about a correct corpus. And the file's load-bearing warning applies directly — *"a gate
that fails on the fill queue is a gate people learn to skip, which costs the hard findings too."*
Neither kind goes in `HARD_KINDS`.

**Why `dependency-cycle` is soft on day one.** Because 3 open SCCs exist (§5.4). This follows the
`terminal-goal-unverified-requirement` precedent in `audit.mjs:30-48` **including its lesson**:
BLZ-353 predicted zero pre-existing violations, shipped on that prediction, and was wrong. The
prediction here is replaced by a measurement of exactly 3, and the ADR names the flip-to-hard
trigger: **`dependency-cycle` becomes HARD when the open-SCC count reaches zero**, tracked by its
own ticket, exactly as BLZ-353's was.

### 7.2 What a finding says

The rule from spec 1 §4.2 — *every refusal names the rule and lists every failing item* — applies
to findings too. A finding that says only "deadline missed" is a defect.

```
BLZ-360  deadline-unreachable  deadline 2026-10-20; earliest finish 2026-11-04
                               (11 working days late); binding chain
                               BLZ-341 → BLZ-352 → BLZ-360, float 0
```

```
INF-276  dependency-cycle      Precedes cycle INF-275 → INF-276 → INF-275;
                               2 tickets unscheduled. Both edges are the same
                               `Blocks` pair written from each end.
```

The **binding chain is the payload**, not the lateness. "You are 11 days late" is a complaint;
"you are 11 days late and here are the three tickets that decide it" is the thing the operator can
act on. The chain is the zero-float predecessor walk from the deadline ticket, and it is what makes
this model worth more than a hand-set date.

### 7.3 On the views

`gantt.mjs` already returns `warnings: string[]` (`gantt.mjs:61`) and the caller renders it. The
same strings go there. Beyond the string, the bar itself carries `is_critical` and a
`deadline-unreachable` marker with the deadline drawn as a separate pin at its own date — **so the
gap is visible as a gap**, which is the entire point of not clamping one field to the other.

---

## 8. What specs 2, 3 and 4 each need — and whether this serves them

### 8.1 Spec 2 — sprint capacity: **served**

Needs `estimate_minutes` (already there, 64.8% populated), `schedule.minutes_per_day` (§2.3), and
derived ES/EF so committed work can be checked against the sprint window — `sprints.json` already
carries `start`/`end` per sprint (`sprints.mjs`).

**One decision spec 2 inherits and may want to revisit: sprint membership is a grouping, not a
scheduling constraint.** The scheduler does not treat `sprint: S3` as a date window. If it did,
sprint assignment and the dependency graph would fight, and there is no correct winner. The
consequence is a real and visible one — a ticket can sit in sprint S3 with a derived start after
S3 ends — and it is surfaced as spec 2's own finding, not silently reconciled. **This is a
judgement call with no measurement behind it.**

### 8.2 Spec 3 — the scheduler and Gantt: **served, and it changes `gantt.mjs` structurally**

The four bar kinds at `gantt.mjs:69-74` collapse:

| Today | Under this model |
|---|---|
| `solid` (start + due) | the **only** kind for a scheduled ticket — a derived schedule always produces both ends |
| `open-end` (start only) | **ceases to exist** |
| `open-start` (due only) | **ceases to exist** |
| `unplanned` (neither) | **survives**, and narrows to a precise meaning: cycle members and tickets outside the graph |

New decorations: `is_critical`, and the deadline pin from §7.3.

**A second, larger change the ticket does not mention.** `gantt.mjs:57-59` scopes rows by
`r.sprint === sel.id` and builds its axis from the selected sprint's window. A critical-path view
is not sprint-shaped — a chain crosses sprints and crosses projects (§6.2). Spec 3 needs a
**non-sprint axis** driven by the schedule horizon. That is a change to the existing file's core,
not an addition beside it.

### 8.3 Spec 4 — date roll-up: **served, but neither existing roll-up is the right one as written**

BLZ-360 asks which implementation the scheduler uses. **The scheduler uses neither, and that is
the answer.** CPM runs over the dependency graph; a parent's dates are a roll-up *of* the finished
schedule, computed afterwards. The two are different operations over different graphs.

For the roll-up itself:

| | `rollup.mjs` | `hierarchy-rollup.mjs` |
|---|---|---|
| Graph | `ticket.parent` | `hierarchy_membership` (a v4 table — **does not ship**) |
| Dedup | none | **yes**, and it is also the cycle guard |
| Operation | `+=` over `est`/`log`, hardcoded | `total += value`, hardcoded |

**Neither can roll dates as written, because dates do not sum.** A parent's start is the `min` of
its children's starts and its due is the `max` — not a total.

**Decision: `hierarchy-rollup.mjs` survives; it gains a `combine` parameter (default sum).** Dates
roll with `min`/`max`, time keeps summing, and there is one dedup-and-cycle guard rather than two.
This is a small change to a 25-line pure function and it is the one that keeps ADR-0016's measured
fast path. `rollup.mjs` keeps rolling time over `parent` until the hierarchy tables ship (§6.4),
then is retired — **and it is retired, not left beside its replacement**, because two roll-ups that
disagree is the condition BLZ-360 flagged.

A parent's rolled dates are **derived from derived data** and are never persisted to
`start_date`/`due_date` on the parent row. Persisting them would make a parent's dates writable by
two different computations.

---

## 9. What this spec does NOT solve

Stated plainly, as ADR-0014's and spec 1's convention requires.

- **Resource levelling.** One person on two zero-float tasks schedules both in parallel. There is
  no assignee capacity model, and CPM without levelling produces optimistic dates whenever a
  chain shares a person. **This is the largest honest gap.**
- **Working calendars beyond a fixed week.** No holidays, no part-time, no per-person calendars,
  no timezones.
- **Dependency types other than finish-to-start.** No SS, FF or SF. `lag_minutes` ships; the type
  discriminator does not.
- **Elapsed vs effort duration.** A 30-minute task that waits three days for a review is scheduled
  as 30 minutes.
- **Baselines and schedule variance.** Planned-vs-actual belongs to spec 1's baseline work.
- **Probabilistic estimates.** No PERT, no ranges, no confidence.
- **Sprint-vs-dependency conflict resolution** (§8.1) — surfaced, never resolved.
- **Automatic `Blocks → Precedes` migration** (§5.5) — 124 mutual pairs are undecidable by
  machine and stay that way.
- **The cycle out-edge relaxation** (§6.2) gives successors of a cycle an optimistic date. Named,
  not fixed.
- **Multi-board / multi-tenant** — ADR-0014, and no discriminator column is introduced anywhere
  above.
- **Any UI.** Views consume `scheduleFindings` and the derived columns; none is designed here.

---

## 10. Constraints honoured

| Constraint | How |
|---|---|
| **ADR-0011 — no new required runtime dependency** | Nothing is added. `package.json` has zero `dependencies`; `pg` is an optional peer. CPM, Tarjan and the roll-up are pure JS over already-loaded data, in the shape both existing roll-ups already use. |
| **ADR-0014 — no board or tenant discriminator** | Not one column above discriminates a board. The scheduler's unit of solve is the whole board precisely *because* there is only ever one (§6.2). |
| **ADR-0016 — Node stays the runtime** | Its CPM benchmark is what makes §6.3's lazy choice affordable, and its event-loop finding is what scopes the `worker_threads` trigger. |
| **ADR-0018 — hybrid custom fields** | Five typed columns, zero JSON tail, no `STORED` generated columns, `ALTER TABLE ADD COLUMN` + backfill, `STRICT` retained, well inside the 200-field cap. |
| **ADR-0001 — `Blocks` stays advisory** | Untouched (§5.2). No superseding ADR is raised. |

---

## 11. Testing, and the mutation discipline BLZ-360 requires

TDD throughout, plus spec 1 §7's three project rules (guards proven to discriminate, conformance
on both engines, enforcement tested through the API).

**AC-6 requires mutation discipline on the computation, and a mutation that does not break a test
must be reported plainly.** The named mutation set, each of which must break at least one test:

1. Flip `EF > deadline` to `EF >= deadline` in the conflict test.
2. Drop the `+ lag` term from the forward pass.
3. Replace the backward pass's `min` over successors with `max`.
4. Return float as `ES − LS` instead of `LS − ES`.
5. Remove the terminal-ticket exemption so `done` tickets are rescheduled.
6. Return SCC members as scheduled rather than `unscheduled`.
7. Treat a missing estimate as duration 1 day instead of 0.
8. Drop the `project_epoch` floor so a schedule may start in the past.

Any mutation that survives is **named in the PR body as a hole in the suite**, not quietly fixed
by adding a test that happens to catch it.

Three fixtures are drawn from the real corpus rather than invented, because each already exists:
the `INF-275 ↔ INF-276` mutual pair, the 22 cross-project edges, and `OMA-4`, the `defined` task
carrying `due: 2026-10-20` with no start.

---

## 12. The ADR

**ADR-0021** (next free number; 0020 is the highest present). One-line decision:

> **Dependency edges, effort and date constraints are inputs; `start_date`, `due_date`, float and
> the critical path are outputs computed by the scheduler and never hand-set. Dependency edges are
> carried by a new `Precedes` link type in the v4 `link` table, leaving `Blocks` advisory and
> ADR-0001 intact.**

It must record the migration cohorts of §4 verbatim, because it changes the meaning of two fields
every existing board already populates, and the 40 affected ids are the evidence that the change
is small enough to review by hand.

## 13. Open questions

1. **A cross-project `Precedes` has no unambiguous `link_type` row.** `link_type` is
   `UNIQUE (project_key, name)` (`link-schema.mjs:38`), so `Precedes` is per-project — and the 21
   cross-project edges then have two candidate type rows. **Proposed:** a reserved
   `project_key = '*'` for built-in system link types. Not decided; it touches `link_type`'s
   uniqueness contract and belongs to whoever owns that table.
2. **Frontmatter key spelling.** `not_before` vs the column's full
   `constraint_start_no_earlier_than`. §2.1 picks the short form on the existing
   `estimate`/`estimate_minutes` precedent, but the operator named the long one.
3. **The schedule horizon** that seeds the backward pass. The latest EF is self-referential; the
   latest `deadline` is undefined when no deadline exists. Needs one rule.
4. **Whether `schedule_run_id` is a timestamp or a content hash.** A hash makes an unchanged
   re-solve a no-op — worth it only if re-solves turn out to be frequent.
5. **Whether the 3 open cycles (§5.4) are fixed before or after the scheduler ships.** Before is
   cleaner; after is what the soft-finding design is for.
