# Blaze v4 — the scheduling kernel: constraints are inputs, dates are derived

**Status:** draft for review · **Date:** 2026-08-23 · **Kernel spec, BLZ-360**

This settles one of the two kernel questions that must land before specs 2 (agile execution),
3 (Gantt / critical path) and 4 (hierarchy reporting + Excel) can be written. It defines the
constraint fields, the derived fields, which is authoritative when they disagree, how today's
hand-set dates migrate, how a schedule conflict is represented, which link store carries
dependency edges, and the scheduling semantics themselves.

**Reconciled with the sibling kernel spec** ([`2026-08-23-project-owned-views-design.md`](2026-08-23-project-owned-views-design.md),
BLZ-354) after both were written in parallel without sight of each other. Five points where the two
disagreed are now decided identically in both files, each recording which spec yielded and why: the
ADR number (§12), the schema-installation event and the `view` table's home (§6.4.1), the
`project_key = '*'` sentinel (§13.1), the two different `link_type` tables (§5.3), and this spec
answering the `start_date`/`due_date` question spec 1 had left open (spec 1 §10.2).

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
| `gantt.mjs` branches on `r.start`/`r.due` into `solid`/`open-end`/`open-start`/`unplanned` | **confirmed** | `scripts/model/gantt.mjs:67-73` |
| `ticket` carries `estimate_minutes`, `start_date`, `due_date` | **confirmed** | `scripts/model/sqlite-schema.mjs:41,44-45`; frontmatter keys are the short `estimate`/`start`/`due` (`scripts/model/index.mjs:214-215`) |
| The v4 `link` table's `DEFAULT_LINK_TYPES` has no dependency type | **confirmed** | `scripts/model/link-schema.mjs:12-23` — `Implements`, `Addresses`, `Verifies`, `Supersedes`, `Derives`. Nothing else. |
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
| **SCCs in the graph the scheduler actually solves** (delivery endpoints, terminal nodes removed) | **0, spanning 0 tickets** | **no cycle exists among open tickets** — §5.4 |
| Dangling targets | **0** | link hygiene is not the problem here; direction is |
| Cross-project edges | 22 | |

**The root cause is nameable, and it is a modelling gap rather than user error — but it is
narrower than "there is no inverse for `Blocks`", which is false of this repo.** The inverse
exists: `config-schema.mjs:26-28` declares `INVERSE = { Blocks: "Blocked by", Cloners: "Cloned by",
… }` and `configSeed` writes it to `blaze_config.link_type.inverse_name` (`:226-232`). Its own
comment says why it lives there — *"Display-only inverses. Not derivable from LINK_TYPES, which is
a bare Set."*

**The correct statement is one layer down: frontmatter has no way to write the inverse.**
`LINK_TYPES` (`links.mjs:14`) is a bare `Set` — `{Blocks, Relates, Duplicate, Cloners, Implements,
Addresses}` — and `lintLinks` (`links.mjs:28`) refuses any `type` outside it. `Blocked by` is a
display string the database knows and the authoring path cannot emit, so the only direction an
operator can author is `Blocks`, and "is blocked by" gets written as a second `Blocks` from the
other end. INF-276's body says *"**Blocked by INF-275** (need FreshRSS running…)"* while its
frontmatter says `{ type: Blocks, target: INF-275 }`, and INF-275 says the same thing back. That
is the whole 124-pair phenomenon.

The conclusion is unchanged by the correction: a **writable, directed** dependency type is what is
missing, and §5 introduces one.

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
| `deadline` | `deadline` | TEXT, ISO date | **new.** An external commitment. **Never clamps anything — this spec's decision, not the operator's** (see §3). |

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

Five new columns on `ticket`. **ADR-0018's cap is 200 filterable fields *per install*, not per
table** (ADR-0018:71) — one budget shared by every table in the installation, which is why spec 1
§4.2 refuses to spend any of it on view config. `ticket` had 31 columns of which 5 were indexed and
filtered (ADR-0018:66-69). This adds two indexed (`is_critical`, `deadline`) — comfortably inside
the install-wide cap, and it must show in `blaze db status` like every other promoted column.

---

## 3. Authority when input and output disagree

**One rule, stated once:** the operator owns the inputs, the scheduler owns the outputs, and
**neither ever writes the other's fields.**

A `deadline` and a derived `due_date` that disagree is not a contradiction to be resolved. It is
the finding this whole model exists to produce (§4). The `deadline` is not moved to match the
schedule, and the `due_date` is not clamped to match the deadline. **Both values persist, and
their delta is the output.**

**Flagged as this spec's inference, not the operator's instruction.** BLZ-360 says only that a
deadline the derived dates cannot meet is *"a finding, not a silently-overwritten field"*; the word
**clamp** appears nowhere in the ticket. This spec escalates that to **`deadline` bounds nothing in
the forward pass at all** — it is read only by `scheduleFindings` (§7), never by the CPM passes
(§6.1). The escalation is deliberate: a `deadline` that participates in the forward pass would move
`due_date`, which is the overwrite the operator ruled out, one indirection later. But it is a
decision made here, and a later operator ruling that a deadline should act as a late-finish
constraint would change §6.1 and not §3.

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

**There are two tables called `link_type`, and only one of them is this one.**
`blaze_config.link_type` (`config-schema.mjs:131-137`) is `name text PRIMARY KEY` with no
`project_key`, seeded from `LINK_TYPES` + `INVERSE` in `links.mjs`; the v4 `link_type`
(`link-schema.mjs:29-44`) is `UNIQUE (project_key, name)`, seeded from `DEFAULT_LINK_TYPES`. Spec 1
§4.4 cites the **first** as the precedent for its seeded `view_type` table; everything in this
section and in §13.1 is about the **second**. The consequence is concrete: **adding `Precedes` to
`DEFAULT_LINK_TYPES` touches only the v4 table.** The frontmatter path seeds from `links.mjs` and
would not know the type exists — which is why §5.5's `import-deps` is an operator-driven tool and
not a lint, and why a `Precedes` written into frontmatter would be refused by `lintLinks` until
`LINK_TYPES` is extended too.

Endpoints are **declared, and anything undeclared is refused** (ADR-0015, already the file's
stated default). One new column on `link`:

```
lag_minutes  INTEGER NOT NULL DEFAULT 0
```

**Stated honestly: this is a scheduling-specific column on a generic table, and it is a smell.**
It is taken anyway because a zero-default column costs nothing now and retro-fitting one costs a
schema-version bump later, and because the alternative — a `link_schedule` side table for one
integer — is worse. Every non-dependency link type ignores it.

### 5.4 The default-deny endpoint rule does most of the cleanup for free — and the rest of it too

**Two different restrictions, measured separately, because the earlier draft of this section
conflated them and drew the wrong conclusion from the merged number.** Restricting `Precedes` to
delivery types is an *endpoint* rule and removes edges. Skipping terminal tickets is a *scheduling*
rule and removes nodes. They are applied at different layers and they do not produce the same
graph.

Measured by one Tarjan pass per column over the live 2,610-ticket corpus, counting only
non-trivial SCCs (size > 1, or a self-loop):

| | All `Blocks` edges, all tickets | Delivery endpoints only | Delivery endpoints **and** non-terminal nodes |
|---|---|---|---|
| Edges kept | 392 | **334 (85.2%)** — 58 refused (breakdown below) | — |
| Nodes in the graph | 317 touched | delivery endpoints on both ends | delivery **and** non-terminal on both ends |
| Non-trivial SCCs | 39 over 135 tickets | 25 over 99 tickets | **0 over 0 tickets** |
| SCCs *containing* a non-terminal ticket | 15, 27 open tickets | 3, 4 open tickets | n/a — no SCC survives |

**The corrected headline: there is no cycle among open tickets. Zero.** The earlier `3 SCCs /
4 open tickets` figure was the *delivery-only* column — SCCs that merely **contain** at least one
non-terminal member — and the caption wrongly described it as if terminal tickets had also been
removed. They had not. Removing them collapses all three:

| Delivery SCC | Members | What happens when terminal nodes leave the graph |
|---|---|---|
| `INF-275 ↔ INF-276` | INF-275 `done`, INF-276 `defined` | the only edge pair runs through a `done` node — dissolves |
| `OBA-246 ↔ INF-281` | OBA-246 `done`, INF-281 `defined` | same shape — dissolves |
| `INF-95/36/99/100/37` | INF-36, INF-99, INF-100 `done`; INF-95, INF-37 `defined` | the return path runs through the three `done` nodes; INF-95 and INF-37 have no cycle between themselves — dissolves |

**Every cycle in the delivery graph is held together by at least one `done` ticket.** That is not a
coincidence and it is the real finding: cycles accumulated where nobody was ever going to be
blocked, because under ADR-0001's advisory semantics they cost nothing.

**The consequences, all three of them, are the opposite of what the earlier number implied:**

1. **The operator's cycle-resolution backlog for scheduling purposes is zero, not three and not
   thirty-nine.** The 39 SCCs are real and remain real as `Blocks` hygiene; none of them can stop a
   schedule, because a scheduler never traverses a terminal node (§6.2).
2. `dependency-cycle` **cannot be justified as soft by an existing-violations count**, because the
   count is zero. §7.1 is rewritten accordingly.
3. The proposed flip-to-hard trigger *"when the open-SCC count reaches zero"* **would fire on day
   one**, which makes it not a trigger. §7.1 replaces it.

The 58 refused edges, by endpoint type pair, measured:

| Pair | Count |
|---|---|
| `risk → feature` / `feature → risk` | 18 + 18 = **36 (62%)** |
| `story → risk` / `risk → story` | 5 + 5 = 10 |
| `task → goal` | 6 |
| `goal → goal` | 2 |
| `goal → feature`, `feature → goal`, `risk → goal`, `risk → task` | 1 each = 4 |

So "almost all `risk ↔ feature`" was an overstatement: it is 36 of 58, a clear majority but not
almost all, and a fifth of the refusals are `goal`-endpoint edges rather than risk edges at all.
The rule still holds — a risk does not belong in a delivery critical path, `gantt.mjs:24` already
excludes non-delivery types from bar rows, and the link meta-model's default-deny enforces the same
rule one layer down — but it is doing two jobs, not one.

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

**Stated plainly first, because §5.4's correction turns on it and because getting it wrong
destroys §4's frozen actuals: terminal tickets are NOT in the graph the scheduler solves.**

The solve graph is built by filtering, in this order, and the order is part of the rule:

1. **Edges** — keep a `Precedes` edge only if both endpoints are declared delivery kinds (§5.3's
   `source_kinds`/`target_kinds`). This is the meta-model's default-deny and it happens at the
   store.
2. **Nodes** — drop every ticket for which `isTerminal(type, status)` (`workflows.mjs:87`) is true.
   A terminal ticket is never a node, never a member of an SCC, and is **never marked
   `unscheduled`**. Its `start_date`/`due_date` are actuals owned by history (§3, §4) and the
   scheduler has no write path to them.
3. **Tarjan** runs over what is left. Over the live corpus that graph has **zero non-trivial SCCs**
   (§5.4).

The rule that makes this safe to state once: **`unscheduled` is a property only a node can carry,
and a terminal ticket is not a node.** If Tarjan ran over the full graph including terminal nodes,
the "every member is marked `unscheduled`" row below would mark `done` tickets unscheduled and
overwrite the 28 frozen actuals §4 exists to protect. It does not, because they are filtered out
one step earlier. Mutation 5 in §11 is the test that holds this: *remove the terminal-ticket
exemption so `done` tickets are rescheduled* must break at least one test.

A terminal ticket still *contributes* as a boundary condition — the "Terminal ticket" row below —
by supplying a finish time to its non-terminal successors. Supplying a boundary value is not
membership in the graph.

| Case | Behaviour | Why |
|---|---|---|
| **Cycle in the graph** | The SCC is found by one Tarjan pass **over the non-terminal delivery graph defined above**. **Every member is marked `unscheduled`, reason `dependency-cycle`, and the rest of the graph still schedules.** Edges *into* the SCC from outside are honoured; edges *out of* it are treated as unconstrained. | **Zero such SCCs exist today** (§5.4) — so this path is defensive, not remedial, and it must be tested against a synthetic cycle rather than a corpus one. It is still non-negotiable: the 39 SCCs in the raw `Blocks` graph show that cycles are what this corpus produces when nothing enforces direction, and a scheduler that refuses to produce any output because one was authored tomorrow is a scheduler nobody runs. The out-edge relaxation is an **approximation and is stated as one** — successors of a cycle get an optimistic date. |
| **Ticket with no estimate** | `duration = 0`. It is a **milestone**, not an error: `ES = EF`, and it still propagates its predecessors' finish to its successors. A soft finding is raised only if the ticket's *type* declares `estimate` required (`story`/`task`/`bug`, per `schema.mjs:20-22`). | 35.2% of the corpus has no estimate. Erroring is not available. A zero-duration node is the standard CPM answer and it keeps the chain connected. |
| **Constraint but no dependencies** | `not_before` is simply a lower bound in the forward pass; with no predecessors, `ES = max(project_epoch, not_before)`. A `deadline` with no dependencies still produces a finding when `EF > deadline`. | The constraint fields are not parasitic on the dependency graph. This is the common case for the 12 migrated open tickets in §4, and it must work with zero edges. |
| **Dependency crossing projects** | **Allowed and scheduled.** The scheduler's unit of solve is **the board, not the project.** | 22 cross-project `Blocks` edges exist today, and ADR-0014 forbids a board discriminator — so there is exactly one graph and pretending otherwise is a fiction. A project-scoped view that shows a date derived from a foreign chain **must say so**: every finding and every critical-path output carries the full chain including foreign ids. |

Two more cases, decided here because they will otherwise be discovered in implementation:

| Case | Behaviour |
|---|---|
| **Terminal ticket** | **Not a node in the solve graph at all** (see above). Never scheduled, never an SCC member, never marked `unscheduled`; its `start_date`/`due_date` are actuals (§4) and the scheduler has no write path to them. As a *boundary condition* for a non-terminal successor it does not hold anything back: `EF = its actual due, or project_epoch if it has none`. |
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

**Resolution: this spec owns DB schema version 2, and it is the only owner.** `DB_SCHEMA_VERSION`
goes **1 → 2** (`db-schema-version.mjs:24`), and `applyCreate` (`:143-159`) gains three DDLs plus
the five `ticket` columns from §2. Spec 4 stops being the installation event and becomes an
ordinary consumer. The existing guard already handles the consequence correctly — an engine at
version 1 opening a version-2 database gets `state: "newer"` and a refusal naming the upgrade,
which is exactly the defect `db-schema-version.mjs` was written for.

**What version 2 installs, and the line that decides membership:**

| DDL | Table(s) | Why it is in version 2 |
|---|---|---|
| `linkDdl` (`link-schema.mjs:26`) | `link_type`, `link` | `Precedes` lives here. Without it the scheduler cannot be built at all — this is the circularity that forced the move. |
| `hierarchyDdl` (`hierarchy-schema.mjs:8`) | `hierarchy`, `hierarchy_membership` | §8.3 chooses `hierarchy-rollup.mjs`, which reads `hierarchy_membership`. A chosen roll-up with no create path is a decision that cannot be executed. |
| the five `ticket` columns (§2) | `ticket` | `ALTER TABLE ADD COLUMN`, the **9.0 ms metadata-only path** (ADR-0018), never a generated column. ~~`STRICT` stays on every SQLite table that holds them.~~ **CORRECTED under BLZ-376: `ticket` is not STRICT and never was.** Measured 2026-08-25, **zero of the seven tables in `SQLITE_DDL`** carry it — the only occurrence of the word in `sqlite-schema.mjs` is `ON DELETE RESTRICT`. The claim is true of the **v4** modules (`link`, `hierarchy`, `view` take ` STRICT` from `sql-dialect.mjs`'s `tbl` token), so this generalised from those to the whole schema. Whether the v3 tables *should* become STRICT is **BLZ-390**, which measured it: of the **25** installed tables only **4** are STRICT (`link_type`, `link`, `hierarchy`, `hierarchy_membership`), and **0 of 21,372 live rows** would be rejected by adding it to the rest. |
| **`viewDdl`** — spec 1 §3's `view` table | `view`, `view_type` | See below. Spec 1 deferred its installation and had no other home; this is that home. |

**And what version 2 deliberately does NOT install:** `artifactDdl`, `revisionDdl`, `documentDdl`,
`fieldDdl`. Those stay behind the db-primary Phase 2 cutover, because that is what the v4 spine
actually gates on them: spine `:265-267` says *"A document has no status directory to live in, so
the fs write port cannot represent this model."* **That rationale is specific to the
document/artifact model and it does not generalise.** `link`, `hierarchy` and `view` are all
representable on either write port; nothing about them requires the cutover, and holding them
behind it was an over-read of that line.

**Why one version bump rather than three.** Each table shipped separately means its own
`DB_SCHEMA_VERSION` bump, its own `MIN_DB_SCHEMA_VERSION` window, and its own upgrade refusal for
operators to sequence. `applyCreate` already installs the whole v3 schema in one `exec.run` per DDL
(`:149-154`); version 2 is the same shape with four more.

#### 6.4.1 The `view` table — resolving a collision with spec 1

**This is a decided cross-spec collision, recorded in both files.** Spec 1 (BLZ-354,
`2026-08-23-project-owned-views-design.md`) §6.2 declined the schema-installation event, deferring
`view` to *"the Phase 2 db-primary cutover, which v4 spine §6 already makes the prerequisite for
every new v4 table."* This spec §6.4 claimed the same event. Two specs written in parallel produced
one event with two answers, and the net effect was that `view` had **no** installation path at all.

**This spec yields nothing and spec 1 yields its deferral, for two reasons that are checkable
rather than a matter of preference:**

1. **The deferral rests on a misquotation of its own source.** Spine §6 does not make the cutover a
   prerequisite for every new v4 table; `:265-267` makes it a prerequisite for the
   *document/artifact* migration, and states a rationale — no status directory, fs write port
   cannot represent it — that is true of `document` and false of `view`.
2. **Version 2 has to happen regardless**, because `Precedes` needs `link` and the scheduler needs
   `Precedes`. Given one unavoidable version bump, adding `view` to it costs one DDL; deferring it
   costs a second bump later for no gained property.

So: **`viewDdl` ships in version 2, installed by this event.** Spec 1 keeps every other decision
about the `view` table untouched — its columns, its `scope` tag, its partial unique indexes, its
`CHECK`, its `view_type` FK and its seeded registry are spec 1's and are not restated here. This
spec owns only *when the DDL runs*. Spec 1 §6.2 has been amended to point here.

---

## 7. Conflict representation

**Both a `blaze audit` finding and a view-level warning — and they read from one function,
`scheduleFindings(schedule)`, so they cannot drift.** A conflict that shows on the Gantt but not
in CI is invisible to an agent; one that shows only in CI is invisible to the operator.

### 7.1 The findings

| Kind | Severity | Raised when |
|---|---|---|
| `deadline-unreachable` | **soft** | derived `due_date` > `deadline` |
| `dependency-cycle` | **soft, and the reason is not a violation count** | a `Precedes` SCC exists in the non-terminal delivery graph (§6.2) |
| `schedule-stale` | soft | `schedule_run_id` is not the latest run |

**Why `deadline-unreachable` is soft.** `audit.mjs`'s own header defines the split: HARD means
*the corpus is WRONG*. A missed deadline means the **plan** is wrong, which is a true and useful
statement about a correct corpus. And the file's load-bearing warning applies directly — *"a gate
that fails on the fill queue is a gate people learn to skip, which costs the hard findings too."*
Neither kind goes in `HARD_KINDS`.

**Why `dependency-cycle` is soft on day one — and it is not the reason an earlier draft gave.**
That draft argued it from a backlog of 3 open SCCs. **The measurement is zero** (§5.4): the
non-terminal delivery graph has no cycle, so there is no pre-existing debt to be lenient about, and
the *"a gate that fails on the fill queue is a gate people learn to skip"* argument does not apply
here at all.

It is soft for a different and narrower reason: **a `Precedes` cycle is a statement about the plan,
not about the corpus.** `scripts/model/audit.mjs:29-46` sets the test — HARD means *the corpus is
WRONG*. A `Precedes` cycle is two well-formed links whose combination is unschedulable; both rows
are valid, both endpoints resolve, and the FK holds. That is the same category as
`deadline-unreachable` above, and it gets the same severity for the same reason. Neither goes in
`HARD_KINDS`.

**The flip-to-hard trigger is replaced, because the old one was unfireable.** *"`dependency-cycle`
becomes HARD when the open-SCC count reaches zero"* was written against the wrong number; against
the real one it fires immediately, on day one, which makes it a condition rather than a trigger.
The replacement is a **coverage** trigger, not a debt trigger:

> **`dependency-cycle` flips to HARD once `Precedes` is the sole declared input to the scheduler —
> that is, once §5.5's `import-deps` reconciliation is closed and no scheduled ticket depends on a
> `Blocks` edge for its ordering.** Until then a cycle can be an artefact of a half-migrated graph,
> which is not the operator's error to be gated on.

The `terminal-goal-unverified-requirement` precedent (`scripts/model/audit.mjs:29-46`) is still the
one to follow, but for its **lesson** rather than its shape: BLZ-353 predicted zero pre-existing
violations, shipped hard on that prediction, and the prediction was wrong because it walked a
terminal set that omitted `achieved`. This spec's zero is a measurement over the real corpus rather
than a prediction — and it is still not being used to justify shipping hard, precisely because
BLZ-353 shows what a zero that turns out to be a definition error costs. The flip is tracked by its
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

`gantt.mjs` already returns `warnings: string[]` (`gantt.mjs:60`) and the caller renders it. The
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

The four bar kinds at `gantt.mjs:70-73` collapse:

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

**Attribution corrected.** An earlier draft twice credited this question to BLZ-360 — *"BLZ-360 asks
which implementation the scheduler uses"* and *"the condition BLZ-360 flagged"*. **BLZ-360 has no
roll-up acceptance criterion and asks no roll-up question.** Its only mention of the subject is one
clause of context at `BLZ-360:26` — *"the choice decides spec 3's scheduler, spec 2's sprint
capacity and spec 4's date roll-up"* — and its six ACs are about constraint fields, migration,
conflict representation, the link store, the ADR, and mutation discipline. The two-roll-ups
condition is flagged in the repo, not in the ticket: `scripts/audit-runner.mjs:100-106` already
records it — *"reconciling those two is a real question (their parent models and dedup policies
differ) but it is not this ticket's."*

**What this section is, then:** not an AC, but a consequence this spec cannot avoid answering,
because §6.4 decides which tables version 2 installs and a roll-up with no table is not installable.
Spec 4 owns the roll-up; this section fixes only the part §6.4 touches.

**The scheduler itself uses neither roll-up, and that is the first answer.** CPM runs over the
dependency graph; a parent's dates are a roll-up *of* the finished schedule, computed afterwards.
The two are different operations over different graphs.

For the roll-up itself:

| | `rollup.mjs` | `hierarchy-rollup.mjs` |
|---|---|---|
| Graph | `ticket.parent` — one parent per row, so a **tree** | `hierarchy_membership` — `UNIQUE (hierarchy_id, item_id, parent_id)` permits an item under several parents, so a **DAG** |
| Cycle guard | **yes** — a per-traversal `visited` Set (`rollup.mjs:30,34-35`) | yes — the same `seen` Set (`hierarchy-rollup.mjs:17,22-23`) |
| Duplicate exclusion | **not applicable** — a tree cannot reach a node twice, so the guard never fires on a well-formed corpus | **load-bearing** — a DAG can, and the header states duplicates are excluded by default |
| Operation | `+=` over `est`/`log`, hardcoded pair | `total += value`, hardcoded operator, arbitrary `values` map |
| Ships today | yes | **no** — depends on `hierarchy_membership`, installed by §6.4 |

**Correction to an earlier draft: `rollup.mjs` was described as "Dedup: none", and that is false.**
It has a per-traversal `visited` Set at `rollup.mjs:30,34-35`, and its own header says
*"Cycle-guarded (a per-traversal visited set)"* and *"no node is counted twice within one
traversal."* One of the two stated reasons to prefer `hierarchy-rollup.mjs` therefore does not
exist.

**Re-examined, the preference still holds — but on one reason, not two, and it is a different
reason.** The surviving distinction is not *"one dedups and one does not"*; both guard. It is
**what the guard is for**: over `ticket.parent` a node is unreachable twice, so `rollup.mjs`'s Set
only ever catches a malformed cycle, while over `hierarchy_membership` a node is *legitimately*
reachable twice and `hierarchy-rollup.mjs`'s Set is what stops it being counted twice. A roll-up
that must serve multiple named hierarchies (v4 spine §3.3) needs the DAG-shaped one, and
`rollup.mjs` cannot be adapted to it without replacing its graph — at which point it is the other
function.

**Neither can roll dates as written, because dates do not sum.** A parent's start is the `min` of
its children's starts and its due is the `max` — not a total.

**Decision: `hierarchy-rollup.mjs` survives; it gains a `combine` parameter (default sum).** Dates
roll with `min`/`max`, time keeps summing, and there is one implementation over the graph that can
actually express several hierarchies. It is the one that keeps ADR-0016's measured fast path.

**This section called that "a small change to an 18-line pure function". Both halves are wrong, and
spec 4 measured it — amended under BLZ-368.** The function is **19** lines
(`hierarchy-rollup.mjs:10-28`), and `combine` alone is not sufficient:

- **The two functions have different *shapes*, not just different graphs.** `rollUp(index)` returns
  a **Map of every id** with **five** fields; `rollup({…, rootId})` returns **one number** for
  **one** root.
- **`rollUp` is not a leaf consumer.** It runs inside `boardModel` (`views/data.mjs:63`), which
  `page.mjs:115` and `:151` call for **every** view render — so it is computed under all six views
  and read by `views/board.mjs` alone.
- **Measured, the naive per-id swap is 842 ms against a 5.2 ms median** — and still one field short
  of what `boardModel` reads. A per-root API called once per row throws away exactly the whole-tree
  pass ADR-0016 measured at 6.0× faster than a recursive CTE.

So `hierarchy-rollup.mjs` gains **two** things: `combine`, and a **`rollupAll` whole-tree entry
point** returning a Map. Only then is `rollup.mjs` removable without a large regression on four
views' read model. **The decision itself is unchanged** — `hierarchy-rollup.mjs` survives and
`rollup.mjs` retires; only the cost estimate was wrong.
`rollup.mjs` keeps rolling time over `parent` until `hierarchyDdl` installs — **which §6.4 now does,
in DB schema version 2** — then is retired, and it is retired rather than left beside its
replacement, because two roll-ups that disagree is exactly the condition `audit-runner.mjs:100-106`
declined to resolve as a side effect.

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
| **ADR-0018 — hybrid custom fields** | Five typed columns, zero JSON tail, no `STORED` generated columns, `ALTER TABLE ADD COLUMN` + backfill, ~~`STRICT` retained~~ (**false — see BLZ-376**: zero of the **seven** tables in `SQLITE_DDL` are STRICT; the v4 modules are), well inside the **200-filterable-fields-per-install** cap (ADR-0018:71 — per install, not per table; §2.4). |
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

**ADR-0022.** One-line decision:

> **Number collision, resolved.** This spec and spec 1 (BLZ-354) were written in parallel and each
> independently computed *"next free number; 0020 is the highest present"* — so both claimed
> **ADR-0021**. **Spec 1 keeps 0021; this spec takes 0022.** The allocation rule is the lower
> ticket number, and it is not arbitrary here: ADR-0021 renames the tenancy unit to
> **installation** and is the vocabulary ADR-0022's own text has to be written in — 0022 cites
> ADR-0018's *"200 filterable fields per install"* and §6.4's installation event, both of which
> read differently before 0021 lands. A number is only reserved once the file exists in
> `docs/decisions/`; until then, two parallel authors will always compute the same next-free
> number, and this is the second time in this PR that a parallel-authoring collision was found by
> review rather than by either author.


> **Dependency edges, effort and date constraints are inputs; `start_date`, `due_date`, float and
> the critical path are outputs computed by the scheduler and never hand-set. Dependency edges are
> carried by a new `Precedes` link type in the v4 `link` table, leaving `Blocks` advisory and
> ADR-0001 intact.**

It must record the migration cohorts of §4 verbatim, because it changes the meaning of two fields
every existing board already populates, and the 40 affected ids are the evidence that the change
is small enough to review by hand.

## 13. Open questions

1. **A cross-project `Precedes` has no unambiguous `link_type` row.** The v4 `link_type` is
   `UNIQUE (project_key, name)` (`link-schema.mjs:39`), so `Precedes` is per-project — and the **22**
   cross-project edges (measured; §1.1 says 22 and an earlier draft of this line said 21, which was
   the typo) then have two candidate type rows.

   **Proposed: `project_key = '*'` for built-in system link types — and it is a reuse, not a new
   sentinel.** `BOARD_SCOPE = "*"` already exists at `config-schema.mjs:33` and already carries
   exactly this meaning — *installation-wide, not per project* — for **six** scope columns seeded by
   `configSeed` (`config-schema.mjs:236,240,247,257,265,267,270`): `workflow.scope`,
   `workflow_status.scope`, `workflow_transition.scope`, `ticket_type.scope`, `type_parent.scope`
   and `type_required_field.scope`. An earlier draft proposed it as new. It is not.

   **Cross-spec collision, decided.** Spec 1 (BLZ-354) §3.3 **rejects** this sentinel outright —
   *"Minting a third sentinel to fix a terminology collision is the mistake this ticket exists to
   stop."* Two specs in one PR proposing and forbidding the same sentinel is not a difference of
   taste, so one yields. **The resolution is a rule that decides both cases rather than a
   preference between them:**

   > **`'*'` is legal in a scope column on a config/meta table, and illegal in an owner column that
   > carries a foreign key to `blaze_config.project (key)`.**

   `link_type.project_key` is the first kind: `link-schema.mjs:29-44` declares no FK to `project`,
   and `link_type` is a meta table seeded from code constants exactly like the six columns
   `BOARD_SCOPE` already serves. `view.project_key` is the second kind: spec 1 §3 gives it
   `FOREIGN KEY (project_key) REFERENCES blaze_config.project (key) ON DELETE CASCADE`, and `'*'`
   is not a project, so the sentinel would have to delete the FK to exist.

   **So each spec yields half, and each half is the half it was wrong about.** This spec yields the
   claim that the sentinel is **new** — it is `BOARD_SCOPE`, five columns old. Spec 1 yields the
   claim that using it here would be **minting a third sentinel** and that scope sentinels are
   wrong in principle — its actual decisive argument is the FK, which stands on its own and is
   unaffected. Spec 1 §3.3 has been amended to the FK argument and to point here. Still open is
   only the mechanical question this proposal always had: whether `link_type`'s uniqueness contract
   should special-case `'*'` in lookup order (project row wins, `'*'` row is the fallback), which
   belongs to whoever owns that table.
2. **Frontmatter key spelling.** `not_before` vs the column's full
   `constraint_start_no_earlier_than`. §2.1 picks the short form on the existing
   `estimate`/`estimate_minutes` precedent, but the operator named the long one.
3. **~~The schedule horizon that seeds the backward pass.~~ Closed by decision under BLZ-380:**
   the horizon is **`max(EF)` over the completed forward pass**, one constant over every scheduled
   node on the board, falling back to `project_epoch` when no node is scheduled. The
   self-reference is apparent — the forward pass completes before the backward pass starts. The
   rule, the alternatives it beat, and the proof that it makes `float ≥ 0` unconditional are
   recorded in **ADR-0022, §The backward pass's horizon**.
4. **~~Is the delivery-workflow node filter part of §6.2's rule, or the implementation's
   inference?~~ Closed by decision under BLZ-388 (BLZ-383 + BLZ-378).** The rule is recorded in
   **ADR-0022, §What the scheduler treats as a node**: a node is a ticket whose type is a declared
   `Precedes` source kind and which is not terminal — read from the same `link_type` entry as the
   edge rule, so the two cannot drift. It is narrower than "the delivery workflow" by exactly
   `epic`, which is a container whose dates are a roll-up OF the finished schedule rather than a
   CPM input (§8.3) — and that roll-up is spec 4's and is not built, so an epic currently has no
   derived dates at all. The two rules differ by exactly `epic` and the board holds zero of them, so they
   select the same set — verified 2026-08-25 against the live corpus. The
   original text follows.

   **Opened by BLZ-379's implementation, tracked as BLZ-383, and deliberately NOT resolved by
   editing §6.2 above.** §6.2's numbered filter list names the edge-kind rule and `isTerminal` and
   nothing else, while §6.2's cycle row and §7.1 both call the population *"the non-terminal
   **delivery** graph"*. `scripts/model/schedule.mjs` filters on both and flags the second half as
   an inference in its own comment. Without it the solve hands derived dates to **203** non-terminal
   non-delivery tickets (goal 43, risk 65, requirement 89, architecture 6, measured 2026-08-24)
   against **538** delivery ones — none of which can carry an edge, because `Precedes`' endpoint
   kinds refuse all four. It does not move the horizon on this board (largest non-delivery estimate
   `OBA-1` at 830 minutes against `BLZ-253`'s 4,800). Adding a filter to a merged spec's normative
   list is a decision, not a fact correction, so it gets a ticket rather than an edit.
5. **Whether `schedule_run_id` is a timestamp or a content hash.** A hash makes an unchanged
   re-solve a no-op — worth it only if re-solves turn out to be frequent.
6. **~~Whether the 3 open cycles are fixed before or after the scheduler ships.~~ Closed by
   measurement: there are none** (§5.4 — 0 SCCs over 0 tickets in the non-terminal delivery graph).
   Nothing has to be fixed before the scheduler ships. What replaces it is a *hygiene* question that
   is not the scheduler's: **the 39 SCCs in the raw `Blocks` graph, 15 of which contain an open
   ticket, are still there** and still misdescribe the board to a human reader. They cannot block a
   schedule, so they are not this spec's gate — but §5.5's `import-deps` reconciliation is where an
   operator will actually see them, and that is the moment to decide whether they get cleaned up or
   left as advisory noise.
