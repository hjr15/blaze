# Blaze v4 — spec 3: Gantt and critical path, on an axis the schedule owns

**Status:** draft for review · **Date:** 2026-08-24 · **Consumer spec, BLZ-363**

The third of the six v4 subsystem specs, and the first **consumer** written after the two kernel
specs merged. It specifies the view that renders the scheduler: the time axis, the bar
vocabulary, the critical-path decoration, the deadline pin, the findings surface, and the
`gantt` entry in the view-type registry.

**Its two inputs are merged and are not reopened:**

- [`2026-08-23-scheduling-kernel-design.md`](2026-08-23-scheduling-kernel-design.md) (BLZ-360) —
  constraints are inputs, dates are derived; `Precedes`/`Follows` in the v4 `link` table; DB
  schema version 2.
- [`2026-08-23-project-owned-views-design.md`](2026-08-23-project-owned-views-design.md)
  (BLZ-354) — a view is a `(scope, project_key, type, name, config)` row; the tenancy unit is an
  installation.

The operator settled both on 2026-08-23. **Nothing below re-litigates either**, and where this
spec answers a question one of them explicitly delegated, it says which one and quotes the
delegation.

Every number below was measured against the live board on 2026-08-24 — **2,613 tickets across 11
projects** — by re-running each measurement rather than by citing the kernel specs. Where the
kernel figure and this one differ, the difference is the three tickets this spec's own work
created (BLZ-363/364/365) and it is called out in place. Where something is a judgement call
with no evidence behind it, it says so.

---

## 0. The one-sentence decision

> **The Gantt's axis is the schedule's, not a sprint's. `axis` is a single enum key rather than
> two mutually exclusive ones, so there is no precedence rule to get wrong.**

Everything else in this spec follows from that plus the kernel's derived fields.

---

## 1. What the code actually says today

Verified against the working tree at `7e4ba4e`, not assumed.

| Claim | Verdict | Evidence |
|---|---|---|
| `ganttModel` scopes rows by `r.sprint === sel.id` and takes its axis window from the selected sprint | **confirmed** | `scripts/model/gantt.mjs:57-59` (rows), `:39-44` (axis) |
| Four bar kinds branch on `r.start`/`r.due` | **confirmed** | `gantt.mjs:67-73` |
| Sprint selection is *requested → active → first registered* | **confirmed** | `gantt.mjs:33-36` |
| The model already returns `warnings: string[]` and the caller renders it | **confirmed** | `gantt.mjs:60`, `:64`; `views/gantt.mjs` consumes `gm` only |
| Non-delivery rows in a sprint are dropped into `warnings`, never rendered | **confirmed** | `gantt.mjs:63-65`, guarded by `isDelivery` at `:23-25` |
| Groups are one header per distinct `parent` | **confirmed** | `gantt.mjs:89-98` — the code and its comment both say "epic", a type retired by BLZ-231 |
| `nowX` is `null` whenever `now` falls outside the axis | **confirmed** | `gantt.mjs:54` |
| The gantt is reached by a `switch` case and a boolean | **confirmed** | `views/page.mjs:47-67` (`renderView`), `:68` (`VIEW_NAMES`) |
| The model is pure and deterministic — no `Date.now()`, no `localeCompare` | **confirmed** | `gantt.mjs:6-8`, `:17`, `:29` (`now` injected) |
| The gantt has a test suite worth preserving | **confirmed, 27 tests** | `tests/model/gantt.test.mjs` (18), `tests/views/gantt.test.mjs` (9) |

### 1.1 What an operator sees when they open the Gantt today — measured

This is the state the spec is written against, and it is worse than the ticket assumed.

```
ganttModel({ index, sprints, sprint: undefined, now: 2026-08-24T00:00:00Z })
  → selected: "S2"   rows: 11   groups: 8   nowX: null
  → barKinds: { unplanned: 11 }
```

**Eleven identical full-width bars and no today-marker.** The registry's `active` pointer is
`S2`, a sprint that ran **2026-08-02 → 2026-08-05** and ended 19 days ago; not one of its 11
tickets carries a date, so every bar spans the whole window; and `now` is outside the axis, so
`gantt.mjs:54` returns `null` and the marker is not drawn.

The today-marker is absent on **four of the five** registered sprints — every axis except S5's
ends before 2026-08-24:

| Sprint | Window | Axis rendered | Rows | `nowX` |
|---|---|---|---|---|
| S1 | 2026-07-24 → 2026-07-29 | 2026-07-23 → 2026-07-31 | 16 | `null` |
| **S2 (active)** | 2026-08-02 → 2026-08-05 | 2026-08-01 → 2026-08-07 | 11 | `null` |
| S3 | 2026-08-07 → 2026-08-16 | 2026-08-06 → 2026-08-18 | 27 | `null` |
| S4 | 2026-08-10 → 2026-08-16 | 2026-08-09 → 2026-08-18 | 6 | `null` |
| S5 | 2026-08-11 → 2026-08-22 | 2026-08-10 → 2026-08-24 | 20 | 392 |

**This is not a defect in `gantt.mjs`.** Every line of it is doing what it was specified to do in
BLZ-109. It is a defect in *what the view is scoped to*: a sprint axis shows the past, because a
sprint registry describes the past. §2 is the fix.

### 1.2 The sprint corpus is small, and it is not where the dependencies are

| Measurement | Value |
|---|---|
| Registered sprints | **5** — S1…S5, spanning 2026-07-24 → 2026-08-22 |
| Tickets carrying a `sprint` | **80 of 2,613 (3.06%)** |
| Projects those 80 belong to | **2 of 11** — `INF` and `OBA` only |
| Schedulable tickets (delivery type, non-terminal) | **533** |
| …of those, carrying a `sprint` | **26 (4.88%)** |
| Sprint windows ending before today (2026-08-24) | **5 of 5** |

### 1.3 The decisive measurement: a sprint axis can never draw a dependency

Counted three ways over the live corpus, each stricter than the last, and all three agree:

| Edge set | Edges | …with **both** endpoints in the **same** sprint |
|---|---|---|
| All `Blocks` edges, no filter at all | 392 | **0** |
| Delivery-endpoint `Blocks` edges | 334 | **0** |
| Delivery **and** non-terminal `Blocks` edges (the graph the scheduler solves) | 36 | **0** |

**Zero, at every level of filtering.** A dependency arrow needs both of its endpoints on screen,
and the sprint-scoped row filter at `gantt.mjs:57-59` admits a row only if `r.sprint === sel.id`.
So the Gantt as it exists today **cannot draw a single dependency edge on this corpus, for any
sprint, ever** — not because the renderer lacks the code, but because the row filter guarantees
the far endpoint is off-screen.

The same fact from the node side: of the **47** tickets that sit in the scheduler's dependency
graph, exactly **one** (`INF-657`, sprint `S3`) carries a sprint at all.

This is what makes the axis question answerable by measurement rather than preference. BLZ-360
§8.2 asserted that *"a critical-path view is not sprint-shaped — a chain crosses sprints and
crosses projects"*; on this corpus the truth is stronger and simpler: **the chains are not in the
sprints at all.**

---

## 2. The axis

### 2.1 One key, not two

BLZ-354 §10.2 hands this spec the question and predicts the shape of the answer:

> *"`gantt` will carry two mutually exclusive axis keys and a rule for which wins. That rule is
> spec 3's and is not written here."*

**This spec declines the shape and answers the question.** Two mutually exclusive keys plus a
precedence rule is a state machine with an illegal state in it, and the precedence rule is the
part that ships wrong. One enum has no illegal state to rule on:

```
axis: 'schedule' | 'sprint'      // default: 'schedule'
```

`sprint` survives as BLZ-354 §5.2 requires — *"it is what the renderer does today and it must
keep working"* — but it is demoted to what it always was underneath: **a row filter**, which
additionally supplies the axis window when and only when `axis: 'sprint'`.

| `axis` | Rows | Window |
|---|---|---|
| `'schedule'` | every schedulable ticket in scope; `sprint`, if set, filters them | §2.2 |
| `'sprint'` | today's behaviour exactly — `r.sprint === sel.id` (`gantt.mjs:57-59`) | today's behaviour exactly — `[sel.start - 1d, sel.end + 1d]` (`gantt.mjs:39-44`) |

**The migrated builtin `gantt` row gets `axis: 'sprint'`**, so BLZ-354 §6.2's zero-diff oracle —
*"render all six views on the live 11-project board before and after the cutover and diff the
HTML"* — still diffs to nothing. A new view created by an operator gets `axis: 'schedule'`. **The
default that ships and the default that migrates are deliberately different, and that is a
one-release condition, not the end state:** once `import-deps` (BLZ-360 §5.5) has populated
`Precedes`, the builtin should flip to `'schedule'` too, and that flip is its own ticket with its
own zero-diff expected-delta list.

### 2.2 The schedule axis window

`axis: 'schedule'` spans, in working days:

```
start = min(project_epoch, earliest deadline in scope, earliest frozen actual start in scope)
end   = max(latest EF in scope, latest deadline in scope) + 1 working day
```

**`min` with the earliest deadline, rather than starting at `project_epoch`, is a decision this
spec makes and it is forced by measurement.** Of the 12 open tickets BLZ-360 §4 migrates into
`deadline`, **11 already carry a deadline in the past**:

| Cohort | Count | Dates |
|---|---|---|
| Migrated `deadline` values | 12 | 2026-08-07 … 2026-10-20 |
| …already before a 2026-08-24 epoch | **11** | 2026-08-07 … 2026-08-16 |
| …in the future | **1** | `OMA-4`, 2026-10-20 |
| Migrated `not_before` values | 11 | all 11 already in the past |

So on day one after the migration, **11 of 12 deadline pins fall to the left of
`project_epoch`.** An axis that began at `project_epoch` would clamp all eleven to the same left
edge, and BLZ-360 §7.3's whole point — *"the deadline drawn as a separate pin at its own date, so
the gap is visible as a gap"* — would render an 8-day miss and a 60-day miss identically. The
`min` is what keeps the gap proportional.

The same measurement says something the kernel spec did not: **all 11 migrated `not_before`
values are also already in the past**, so every one of them is non-binding on day one
(`ES = max(project_epoch, not_before)` and `project_epoch` wins in all 11 cases). The
`not_before` half of the migration buys nothing until an operator sets a *future* one. That is
worth saying out loud because §4 of the kernel spec justified the migration partly on those 11
tickets; the justification holds for `deadline` and is currently vacuous for `not_before`.

### 2.3 Day columns, and the one thing that does not scale

`gantt.mjs:41-53` builds one column per day at `PX_PER_DAY = 28`. Over a sprint that is 6–14
columns. Over the schedule axis it is the span above.

Measured today, the schedule axis would span **2026-07-24 → 2026-10-21 = 90 calendar days =
2,520 px**. Each of the three terms in §2.2's `min`/`max` is doing work, and it is worth seeing
which:

| Term | Date | Set by |
|---|---|---|
| earliest frozen actual start | **2026-07-24** | a terminal ticket — this is what `start` actually resolves to |
| earliest migrated deadline | 2026-08-07 | the 11 past deadlines |
| `project_epoch` | 2026-08-24 | a Monday, so it floors to itself |
| latest EF | 2026-08-24 + 10.0 working days | `BLZ-253` (§5.1) |
| latest deadline | **2026-10-20** | `OMA-4` |

So the frozen actuals reach further back than any constraint does, and dropping them from the
`min` would shorten the axis to 2026-08-07 → 2026-10-21 — **76 days, 2,128 px**. They are kept:
§4.2 renders those 28 tickets, and an axis that excludes rows it draws is not an axis. Wide,
scrollable, and fine.

**It does not stay fine, and the trigger is stated rather than guessed:** one column per day at
28 px is 10,220 px per year. **When the schedule axis exceeds 180 days, the model switches its
column unit from day to week** and `axis.pxPerDay` becomes `axis.pxPerUnit` with a declared
`unit`. Not built in v1 — 75 days is inside the budget — but the field is named now so the
renderer is not rewritten later. `OMA-4` alone would trip a 60-day threshold, which is why the
threshold is 180 and not 60.

---

## 3. `dateSource` is deleted

BLZ-354 §10.2 kept it and predicted its removal:

> *"`dateSource` is now a closed key set with exactly one legal value. A key whose enum has one
> member decides nothing. It is kept for one release … **Whoever writes spec 3 should expect to
> delete it.**"*

**Deleted, and not for the reason the prediction gave.** Spec 1 kept it because *"the migration
leaves 28 terminal tickets carrying frozen actuals while every open ticket carries derived dates,
and a Gantt has to be able to say which it is rendering."*

**Measured, that premise does not survive: a single Gantt renders both kinds at once.** The board
holds **28 terminal tickets with frozen actual dates** and **533 schedulable tickets** with
derived ones, and no filter in this spec separates them — a project view over `INF` shows both.
So "which is it rendering" has no per-view answer; it has a **per-row** answer.

And the row already carries it. BLZ-360 §2.2 gives every scheduled row a `schedule_run_id`, and
§6.2 says a terminal ticket *"is never a node … and the scheduler has no write path to them"* —
so `schedule_run_id IS NULL` **is** the discriminator, exactly. A `dateSource` key would be a
second, coarser source of the same fact, able to disagree with the rows it describes. §4.2 makes
the distinction visible where it actually lives: in the bar.

---

## 4. The bar vocabulary

### 4.1 What collapses, and what it costs — measured

BLZ-360 §8.2 predicts the four kinds collapse. Measured on the live corpus, two of them are
**already unreachable**:

| Kind (`gantt.mjs:70-73`) | Rows on the live corpus | Fate |
|---|---|---|
| `solid` — start + due | **38** (S1: 13, S3: 25) | becomes `scheduled` / `actual` (§4.2) |
| `open-end` — start only | **0** — the corpus holds **zero** start-without-due tickets | **deleted** |
| `open-start` — due only | **0 in any sprint** — the 2 due-only tickets carry no sprint | **deleted** |
| `unplanned` — neither | **42** (S2: 11, S4: 6, S5: 20, S1: 3, S3: 2) | renamed `unscheduled`, narrowed (§4.2) |

`gantt.mjs:71` and `:72` are **dead code paths on this board**, and have been since the view
shipped. Deleting them costs nothing in the corpus and costs exactly **two tests** —
`"open-end bar (start only) runs start → sprint end"` (`tests/model/gantt.test.mjs:105`) and
`"open-start bar (due only) runs sprint start → due"` (`:113`), both of which build their own
fixtures. **Those two tests are deleted with the branches, deliberately and by name.** Deleting a
test to make a change pass is the thing this repo's review bar exists to catch, so the rule
applied here is: a test may be deleted only when the *behaviour* it describes is deleted, and the
PR names it. Both are.

### 4.2 The four kinds after

| Kind | When | Why it is its own kind |
|---|---|---|
| `scheduled` | non-terminal, in the solve graph, `estimate > 0` | ES → EF, the ordinary bar |
| **`actual`** | **terminal, carrying frozen dates** | **new — see below** |
| `milestone` | non-terminal, in the solve graph, no estimate | **zero-width — see below** |
| `unscheduled` | outside the solve graph, or an SCC member | carries the reason string; never a date. **Zero members today** — see below |

**`unscheduled` has no members on this corpus, and that is worth stating before the kind is
built.** It has exactly three causes, and all three measure zero: the non-terminal delivery graph
holds **0** SCCs (BLZ-360 §5.4, re-measured here and confirmed); there are **0** dangling
`Precedes` targets, because there are no `Precedes` edges at all yet; and every one of the **533**
schedulable tickets is a node in the solve graph by construction, so none is "outside" it. The
486 tickets with no edge and the 505 with no predecessor are **`scheduled`** — they start at
`project_epoch` and finish at `project_epoch + duration`, which is a perfectly ordinary bar. So
`unscheduled` is **defensive, exactly as BLZ-360 §6.2 says the cycle path is**, and it must be
tested against a synthetic fixture rather than against a corpus row.

**`actual` is new, and the kernel spec does not name it.** BLZ-360 §4 freezes 28 terminal
tickets' dates as actuals and §3 says they are *"owned by history, not by either party"*. Under
today's renderer those 28 rows have both `start` and `due`, so they render `solid` — **pixel-identical to a
forecast**. A view that draws a finished fact and a derived prediction the same way is the
failure BLZ-360 §6.3 names in a different context: *"a stale date that looks live is worse than
no date."* The same argument applies to an actual that looks like a forecast, so `actual` is a
distinct kind with a distinct fill, and §3's deleted `dateSource` is unnecessary precisely
because this carries the information per-row.

**`milestone` exists because a zero-duration bar is zero pixels wide.** BLZ-360 §6.2 rules that a
ticket with no estimate gets `duration = 0` and is *"a milestone, not an error: `ES = EF`"*. That
is right for the solve and invisible in the render: `xForMs(EF) - xForMs(ES) = 0`.

Measured, this is not an edge case:

```
schedulable tickets                              533
  with an estimate                               393  (73.7%)
  with NO estimate → duration 0 → 0-px bar       140  (26.3%)
```

**Just over a quarter of every bar the schedule axis would draw is zero pixels wide.** So
`milestone` renders as a fixed-width diamond centred on `ES`, in the standard Gantt convention,
and `w: 0` never reaches the SVG. This is a rendering consequence the kernel decision creates and
this spec owns; it is not a disagreement with the kernel decision, which stays exactly as
written.

### 4.3 Decorations

| Decoration | Source | Rule |
|---|---|---|
| Critical | `is_critical` (BLZ-360 §2.2) | stroke weight, not colour — colour is already bound to type (`views/gantt.mjs:12-16`) |
| Deadline pin | `deadline` | drawn at its own date, never clamped to the bar (BLZ-360 §7.3); §2.2 keeps it inside the axis |
| Stale | `schedule_run_id` ≠ latest | *"views must render it as stale rather than as a date"* — BLZ-360 §6.3 |
| Dependency edge | `Precedes` | drawn only when both endpoints are on screen; §5.2 |

---

## 5. The critical path, and the honest state of it

### 5.1 On this board, today, the critical path is one isolated ticket

A full CPM forward and backward pass was run over the live corpus — all 533 schedulable tickets,
the 36 delivery non-terminal `Blocks` edges standing in for the `Precedes` edges that do not
exist yet, `duration = estimate` in minutes, isolated nodes included:

| Measurement | Value |
|---|---|
| Schedulable tickets | 533 |
| …with at least one predecessor | **28** |
| …starting at `project_epoch` because nothing precedes them | **505 (94.7%)** |
| Tickets in the dependency graph at all | 47 |
| Dependency edges | 36 |
| Longest chain **by ticket count** | **4** — `SN-27 → SN-28 → SN-33 → SN-36`, 840 min total |
| Heaviest **chain** by duration | 3,780 min = 7.88 working days — `BLZ-254 → BLZ-265` |
| **Latest early finish over the whole corpus** | **4,800 min = 10.0 working days** |
| **The critical path** | **`BLZ-253` — one ticket, 4,800 min, 0 predecessors, 0 successors** |
| Tickets at zero float | **1 of 533 (0.2%)** |

**The critical path is a single isolated node, because the longest chain (7.88 days) is shorter
than the largest single ticket (10 days).** `BLZ-253` is a 4,800-minute `feature` in
`in-progress` with nothing before it and nothing after it. CPM is answering correctly; the corpus
has no chains long enough to beat one big ticket.

This is the most useful thing in this spec and it must not be smoothed over. **A critical-path
view built today would ship a highlight around one bar and call it a plan.**

### 5.2 What the view does about it

Three rules, and the first two are the ones that matter.

1. **The critical path is reported with its length, always.** The view states
   *"critical path: 1 ticket, 10.0 working days"* beside the decoration. A number the operator
   can read as absurd is worth more than a highlight they read as authoritative.

2. **A degenerate path raises a named finding.** When the critical path is one ticket — or more
   generally when the zero-float set contains no edge — the view raises
   `critical-path-degenerate`, **soft**, reading:

   ```
   critical-path-degenerate   critical path is 1 ticket (BLZ-253, 10.0 working days) and
                              contains no dependency. 505 of 533 schedulable tickets (94.7%)
                              have no predecessor; 36 Precedes edges exist over 47 tickets.
                              Run `blaze schedule import-deps` to reconcile the 392 Blocks
                              edges (BLZ-360 §5.5).
   ```

   It follows BLZ-360 §7.2's rule exactly — *"a finding that says only 'deadline missed' is a
   defect"* — by carrying the counts and naming the action. It is **soft** by
   `scripts/model/audit.mjs:29-46`'s own test: HARD means the corpus is *wrong*, and a corpus
   with few dependencies is not wrong, it is just sparse.

3. **A dependency edge is drawn only when both endpoints are on screen.** With `axis: 'schedule'`
   and no filter that is every edge; under a `project` filter or `axis: 'sprint'` it is often
   none (§1.3 — zero, on this corpus). When edges are hidden by scope, the view says how many:
   *"14 dependencies not shown (endpoint out of scope)"*. Silently dropping them would make a
   filtered Gantt look like a board with no dependencies, which is the exact false picture §1.3
   shows the current view already paints.

### 5.3 `showCriticalPath: true` with `axis: 'sprint'` is legal, and warns

It is decidable at write time that this combination cannot draw a chain. It is **not blocked**,
because BLZ-354 §5.3 sets the test — *blocks at write time only if decidable from the item alone
**AND** never true of a legitimate draft* — and this is a legitimate draft: "which of this
sprint's tickets sit on the board's critical path" is a real question with a useful answer, and
the answer is per-ticket, not per-chain. What it cannot do is show the chain. So it renders, with:

```
critical-path decoration is on and the axis is sprint-scoped: 0 of this sprint's
dependencies have both endpoints in the sprint, so no chain is drawn.
```

---

## 6. The `gantt` registry entry

Per BLZ-354 §5.1, a view type is a code-side descriptor seeded into `view_type`.

```js
{
  name: "gantt",
  label: "Gantt",
  scopes: ["installation", "project"],
  instantiable: true,
  configKeys: {
    axis:              { enum: ["schedule", "sprint"], default: "schedule" },
    sprint:            { type: "string|null", default: null },   // row filter; window iff axis='sprint'
    showCriticalPath:  { type: "boolean", default: true },
    showDependencies:  { type: "boolean", default: true },
    groupBy:           { enum: ["parent", "project", "none"], default: "parent" },
  },
  render(model, config),
}
```

**Five keys, and the count is deliberate.** BLZ-354 §8.4 audited its own falsification test and
found the honest verdict was *"satisfied, not passed … the vocabulary was largely written to
fit"*, then named the real test: *"spec 2, 3 and 4 being written by someone else and needing a
key §5.2 does not have."* This spec is the first half of that test, so its result is reported
plainly:

| Spec 1 §5.2 proposed for `gantt` | Outcome here |
|---|---|
| `sprint` | **kept**, narrowed to a row filter (§2.1) |
| `dateSource` | **deleted** (§3) |
| `showCriticalPath` | **kept** as proposed |
| `groupBy` | **kept**, with a closed 3-member enum §5.2 did not specify |
| `hierarchy` | **deferred to spec 4** — see below |
| — | `axis` **added** (§2.1) |
| — | `showDependencies` **added** (§5.2 rule 3) |

**Score: of five proposed keys, three survive, one is deleted, one is deferred, and two are
added.** So the vocabulary needed changing but the *record shape* did not — no second table, no
key that is not `(scope, project_key, type, name, config)`. That is the thing §8.4 said the test
actually discriminates on, and it holds.

**`hierarchy` and `groupBy: 'hierarchy'` are deferred to spec 4, and the reason is not
sequencing.** BLZ-360 §6.4 installs `hierarchyDdl` in DB schema version 2 — but *installing*
`hierarchy_membership` is not *populating* it, and nothing writes a row to it until spec 4
defines what a named hierarchy is. A `groupBy: 'hierarchy'` shipped in v1 would group every one
of the 533 schedulable tickets into a single empty bucket. `groupBy: 'parent'` covers it for now:
**525 of 533 (98.5%) carry a `parent`.**

**One rename inside `groupBy: 'parent'`.** `gantt.mjs:89-98` calls the group key `epicId` and its
comment says *"one header per distinct parent epic"*. `epic` was retired as a type by BLZ-231;
the field groups by `parent`, whatever type that parent is. It becomes `parentId`. Pure rename,
no behaviour change, and it is in this spec only because BLZ-354 §2.1's rule — per-meaning
renames, never a global substitution — means somebody has to name each one.

---

## 7. What changes in `gantt.mjs`

Structural, as BLZ-360 §8.2 warns: *"That is a change to the existing file's core, not an
addition beside it."*

| Today | After |
|---|---|
| `sprints` + `sprint` are required inputs; empty registry → `EMPTY` (`:30-31`) | required only for `axis: 'sprint'`. `axis: 'schedule'` needs no registry — **which is the unlock for the 9 of 11 projects that have never used a sprint** |
| Axis from `sel.start`/`sel.end` (`:39-44`) | §2.2 for `'schedule'`; unchanged for `'sprint'` |
| Rows via `r.sprint === sel.id` (`:57-59`) | §2.1 |
| Bar kind from `r.start`/`r.due` (`:67-73`) | §4.2, from the derived fields and `isTerminal` |
| No edges | `Precedes` edges, both-endpoints-visible (§5.2) |
| `groups[].epicId` (`:96`) | `groups[].parentId` (§6) |

**What does not change, and is load-bearing:** purity. No `Date.now()`, no `Math.random()`, `now`
injected by the caller, the locale-independent `cmp` at `:17`, ties broken by id. BLZ-360 §6.1
inherits this rule from `gantt.mjs`'s own header verbatim, so the scheduler and the view already
agree on it. The golden-SVG tests depend on it and they stay the gate.

**The model still receives a built index and returns positioned rows.** It gains the schedule as
an input — computed by the kernel's pure pass (BLZ-360 §6.3: lazy, recomputed on read) — and does
not compute it itself. A view that ran its own CPM would be a second implementation able to
disagree with `blaze schedule --write`, which is the condition BLZ-360 §6.3's conformance test
exists to prevent.

---

## 8. Findings

Rendered from `scheduleFindings(schedule)` — BLZ-360 §7's single function, *"so they cannot
drift"*. This spec adds one kind and renders four.

| Kind | Owner | Severity | Rendered as |
|---|---|---|---|
| `deadline-unreachable` | BLZ-360 §7.1 | soft | pin + gap, plus the binding chain in the warning string |
| `dependency-cycle` | BLZ-360 §7.1 | soft | every SCC member as `unscheduled`, reason attached |
| `schedule-stale` | BLZ-360 §7.1 | soft | bars rendered stale, never as dates |
| **`critical-path-degenerate`** | **this spec, §5.2** | **soft** | banner above the chart |

**On day one, the `deadline-unreachable` count will be exactly 11 of 12.** All 11 migrated
deadlines earlier than 2026-08-24 are unreachable because `project_epoch` alone already exceeds
them. `OMA-4` is the one survivor and it is not a close call: it carries **zero** incoming and
zero outgoing `Blocks` edges, so nothing can be scheduled in front of it, and its 30-minute
estimate finishes on the epoch day itself — 57 days clear of its 2026-10-20 deadline. That is a
measured prediction rather than an estimate, and it is exactly the situation
`scripts/model/audit.mjs`'s header warns about: *"a gate that fails on the fill queue is a gate
people learn to skip."*

**It does not change the severity, and it should not.** BLZ-360 §7.1 already ruled
`deadline-unreachable` soft, on the ground that *"a missed deadline means the plan is wrong, which
is a true and useful statement about a correct corpus."* Eleven true statements are still true.
What this spec adds is the **presentation** rule that keeps 11 findings from being noise:

> **Findings are grouped by kind with a count, and a kind whose every member is a migration
> artefact says so.** The banner reads *"11 deadlines unreachable — all 11 are dates migrated from
> `due` by `schedule migrate-dates` and already in the past"*, expandable to the list. Eleven
> separate red rows on first open is how a view teaches an operator to ignore it.

That framing is checkable rather than cosmetic: a migrated deadline is exactly one whose ticket
appears in the 40-id expected-delta list BLZ-360 §4.1 requires the zero-diff oracle to carry, so
the view can name the set without guessing.

---

## 9. Testing, and the mutation discipline

TDD throughout. The 27 existing gantt tests are the regression floor: **25 must still pass**, and
the 2 deleted are named in §4.1 and in the PR body.

BLZ-360 §11 requires that a mutation which does not break a test be reported plainly rather than
quietly fixed. The same discipline, on this spec's own computation — **each must break at least
one test:**

1. Make `axis: 'sprint'` also widen the window to the schedule horizon.
2. Clamp a past deadline pin to the axis start instead of extending the axis (§2.2).
3. Render a `milestone` as a zero-width rect instead of a diamond (§4.2).
4. Render an `actual` bar with the `scheduled` fill (§4.2).
5. Draw a dependency edge when only one endpoint is in scope (§5.2 rule 3).
6. Suppress `critical-path-degenerate` when the path length is 1 (§5.2 rule 2).
7. Report the critical path without its length (§5.2 rule 1).
8. Default `axis` to `'sprint'` for a newly created view (§2.1).
9. Let `ganttModel` compute its own CPM rather than consuming the kernel's (§7).

**Any mutation that survives is named in the PR body as a hole in the suite.**

Fixtures come from the corpus rather than from invention, because each already exists:
`BLZ-253` (the one-ticket critical path), `OMA-4` (the only future deadline), `INF-657` (the only
sprint-tagged ticket in the dependency graph), the `SN-27 → SN-36` chain (the longest by count),
and the S2 registry state (an active sprint whose axis excludes today).

---

## 10. What this spec does NOT solve

- **Resource levelling.** BLZ-360 §9 calls it *"the largest honest gap"*; the view inherits it
  whole and draws two zero-float tasks for one person side by side.
- **Editing from the Gantt.** No drag-to-reschedule. Dates are derived (BLZ-360 §3), so a drag
  has nothing to write; it would have to author a `not_before`, which is a different gesture and
  is not designed here.
- **Baselines.** No planned-vs-actual overlay. BLZ-360 §9 puts it in spec 1's baseline work.
- **A week/month column unit.** Named in §2.3 with a 180-day trigger; not built.
- **Printing or export of the chart.** Spec 4's `export` key is about the report, not the SVG.
- **`groupBy: 'hierarchy'`.** Spec 4's (§6).
- **The `Blocks` → `Precedes` reconciliation.** BLZ-360 §5.5. Until it runs, §5.1 is the picture,
  and this spec's job is to make that legible rather than to fix it.
- **Per-project sprints.** Spec 2's (BLZ-354 §8.1). `axis: 'sprint'` inherits the single global
  `active` pointer exactly as `gantt.mjs:33` reads it today.

---

## 11. Constraints honoured

| Constraint | How |
|---|---|
| **ADR-0011 — no new required runtime dependency** | Nothing added. Positioning is arithmetic; the SVG is a template string, as today. |
| **ADR-0014 — no board or tenant discriminator** | No column is introduced at all; the axis spans the installation because BLZ-360 §6.2 solves the whole board. |
| **ADR-0016 — Node stays the runtime** | The view consumes a solve measured at 95.7 ms for 10k tasks / 25k edges; this board is 533 and 36. The `worker_threads` trigger (>50 ms, or >10k schedulable) is BLZ-360's and is nowhere near. |
| **ADR-0018 — hybrid custom fields** | No new column. The view reads BLZ-360 §2's five; `config_json` is a JSON tail excluded from promotion by BLZ-354 §4.2. |
| **ADR-0001 — `Blocks` stays advisory** | Untouched. §1.3 counts `Blocks` edges as evidence about the corpus and draws none of them; the view draws `Precedes`. |
| **BLZ-354 §3 — the record shape** | `gantt` is a `(scope, project_key, type, name, config)` row with five config keys and no second table (§6). |

---

## 12. No ADR

**This spec raises none, and the reason is a test rather than an omission.** Every decision above
is either a view-layer default (`axis`, bar kinds, group key), a rendering consequence of a
decision an ADR already carries (`milestone`, `actual`, the deadline pin), or a config-key
addition inside a table ADR-0021 already establishes. None changes a system-wide invariant, none
is expensive to reverse, and none contradicts an existing ADR.

**What would need one:** making the schedule axis the *only* axis (retiring `axis: 'sprint'`
rather than defaulting away from it) — because that deletes the sprint Gantt BLZ-109 shipped and
BLZ-354 §5.2 promised would keep working. §2.1 deliberately does not do that, and the flip of the
builtin's default is its own ticket for the same reason.

---

## 13. Open questions

1. **What is the backward pass's horizon?** BLZ-360 §13.3 leaves it open — *"the latest EF is
   self-referential; the latest `deadline` is undefined when no deadline exists."* **Proposed:
   `horizon = max(EF)` over the completed forward pass, and the self-reference is apparent rather
   than real** — the forward pass runs to completion before the backward pass starts, so `max(EF)`
   is an ordinary constant by then. It is measurable today: **4,800 minutes, 10.0 working days**
   (§5.1). This is a proposal into a question the kernel left open, not a re-opening of one it
   closed; it belongs to whoever owns the scheduler.
2. **Should the builtin `gantt` row's `axis` flip to `'schedule'`, and when?** §2.1 says after
   `import-deps` closes. The trigger wants a measurement — plausibly *"once the zero-float set
   contains at least one edge"*, which is exactly the condition §5.1 shows is false today. Not
   settled.
3. **Does a project-scoped Gantt show foreign chain members?** BLZ-360 §6.2 requires that a
   project-scoped view showing a foreign-derived date *"must say so"*, and that every finding
   carries the full chain including foreign ids. Whether the *bars* for those foreign tickets are
   drawn, greyed, or omitted with a count is not decided here. Only **1** of the 36 open
   dependency edges crosses a project today, so the question is real but cheap.
4. **Is `unscheduled` worth building in v1 at all?** §4.2 measures **zero** members from all
   three of its causes — 0 SCCs, 0 dangling `Precedes` targets, and no schedulable ticket outside
   the solve graph. It is specified because BLZ-360 §6.2 makes the cycle path non-negotiable
   (*"a scheduler that refuses to produce any output because one was authored tomorrow is a
   scheduler nobody runs"*), and the same argument carries to rendering it. But it will ship
   tested only against synthetic fixtures, and that is a weaker guarantee than every other kind
   in §4.2 gets.
5. **What does the schedule axis cost to render at 11 projects?** BLZ-354 §11.2 asks the same of
   project-scoped `metrics` and this repo's own rule applies: *"needs a measurement, not an
   assumption."* 533 rows × ~75 day columns is unmeasured. The current view's worst case is 27
   rows × 13 columns.
