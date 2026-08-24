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
| The model already returns `warnings: string[]` and the caller renders it | **confirmed** | declared `gantt.mjs:60`, pushed `:64`, returned `:100`; `views/gantt.mjs` consumes `gm` only |
| Non-delivery rows in a sprint are dropped into `warnings`, never rendered | **confirmed** | `gantt.mjs:63-65`, guarded by `isDelivery` at `:23-25` |
| Groups are one header per distinct `parent` | **confirmed** | `gantt.mjs:89-98` — the code and its comment both say "epic", a type retired by BLZ-231 |
| `nowX` is `null` whenever `now` falls outside the axis | **confirmed** | `gantt.mjs:54` |
| The gantt is reached by a `switch` case and a boolean | **confirmed** | `views/page.mjs:47-67` (`renderView`), `:68` (the `VIEW_NAMES` array), `:114` (the enabled-boolean gate) |
| The model is pure and deterministic — no `Date.now()`, no `localeCompare` | **confirmed** | `gantt.mjs:6-8`, `:17`, `:29` (`now` injected) |
| The gantt has a test suite worth preserving | **confirmed, 27 tests** | `tests/model/gantt.test.mjs` (18), `tests/views/gantt.test.mjs` (9) |

### 1.1 What an operator sees when they open the Gantt today — measured

This is the state the spec is written against, and it is worse than the ticket assumed.

```
ganttModel({ index, sprints, sprint: undefined, now: 2026-08-24T00:00:00Z })
  → selected: "S2"   rows: 11   groups: 8   nowX: null
  → barKinds: { unplanned: 11 }
```

**Eleven identical bars, all the same width, and no today-marker.** The registry's `active` pointer is
`S2`, a sprint that ran **2026-08-02 → 2026-08-05** and ended 19 days ago; not one of its 11
tickets carries a date, so every bar spans the sprint window — `w = 112` against an
`axis.width` of `168`, i.e. **67%**, since `gantt.mjs:73` runs an `unplanned` bar from `winStart`
to `winEnd`, not across the padded axis; and `now` is outside the axis, so `gantt.mjs:54` returns
`null` and the marker is not drawn.

The today-marker is absent on **four of the five** registered sprints — every axis except S5's
ends before 2026-08-24:

| Sprint | Window | Day columns rendered | Rows | `nowX` | axis width |
|---|---|---|---|---|---|
| S1 | 2026-07-24 → 2026-07-29 | 2026-07-23 → 2026-07-30 | 16 | `null` | 224 |
| **S2 (active)** | 2026-08-02 → 2026-08-05 | 2026-08-01 → 2026-08-06 | 11 | `null` | 168 |
| S3 | 2026-08-07 → 2026-08-16 | 2026-08-06 → 2026-08-17 | 27 | `null` | 336 |
| S4 | 2026-08-10 → 2026-08-16 | 2026-08-09 → 2026-08-17 | 6 | `null` | 252 |
| S5 | 2026-08-11 → 2026-08-22 | 2026-08-10 → 2026-08-23 | 20 | **392** | **392** |

The column range is the **last day column**, not `axis.endMs`, which is exclusive
(`gantt.mjs:43`). Getting that wrong is easy and it hides the next row.

**S5's marker is a boundary artefact, and the table above is drawn at exactly midnight UTC.**
`nowX = 392` equals `axis.width = 392`: `gantt.mjs:54` admits `now` when `now <= endMs` and
`endMs` is *exclusive*, so `2026-08-24T00:00:00Z` passes while having **no day column on the
axis**, and the marker paints on the chart's right border for a date the chart does not contain.

**One second later it is gone.** Measured: at `00:00:01Z`, `09:00:00Z`, and every other instant of
that day, `nowX` is `null` on **all five sprints**. So the honest statement is *"absent on all five
at any real clock time, with an off-by-one at the exclusive boundary that paints a marker outside
the axis for exactly one instant."* An earlier draft claimed "absent on four and degenerate on the
fifth", which promoted a midnight-UTC artefact into a standing property.

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

`sprint` survives as BLZ-354 **§8.2** requires — *"it is what the renderer does today and it must
keep working"* — but it is demoted to what it always was underneath: **a row filter**, which
additionally supplies the axis window when and only when `axis: 'sprint'`.

| `axis` | Rows | Window |
|---|---|---|
| `'schedule'` | every schedulable ticket in scope; `sprint`, if set, filters them | §2.2 |
| `'sprint'` | today's behaviour exactly — `r.sprint === sel.id` (`gantt.mjs:57-59`) | today's behaviour exactly — `[sel.start - 1d, sel.end + 1d]` (`gantt.mjs:39-44`) |

**The enum removes the precedence rule between two axis keys; it does not remove every rule, and
an earlier draft overstated that.** Two cases stay explicit, both found by review:

- **`{ axis: 'schedule', sprint: 'S3' }`** — `sprint` filters the rows and does **not** touch the
  window. "In scope" in §2.2 means *the rows this view renders after every filter*, `sprint`
  included, so a schedule-axis view filtered to S3 spans S3's tickets' derived dates, not S3's
  window. Stated because it was undefined.
- **`{ axis: 'sprint' }` where no sprint applies** — `gantt.mjs:30-31` returns `EMPTY`, and
  **9 of 11 projects have never had a sprint** (§1.2). The enum does not rule this out, and
  **neither does a write-time block, which an earlier draft of this bullet proposed.** The
  decisive ground is **mutability after write**, and it is BLZ-354 §5.3's own, given there for
  `focus`: *"the ticket can be deleted **after** the view is saved. Blocking at write time would
  not stop it, and blocking at read time would make a saved view retroactively invalid. Render an
  empty view with a named reason — never a 500, never a silent empty."* A sprint is data re-read per render (ADR-0004), so it can
  vanish the same way, and §5.3's next row says exactly that about a stale `sprint` value. **This
  is advisory for the same reason `focus` is, and the fix is the same: a named reason at render
  time.**

  **A later draft argued it from ADR-0015's decidability test instead — that a registry lookup is
  "not decidable from the item alone" — and that was wrong twice.** ADR-0015's own write-time
  example is *"link endpoint validity"* (`:129`), an existence check against another record, and
  BLZ-354 §5.3 lists *"`project_key` naming a project that does not exist — FK; decidable"* as a
  **write-time block**. A sprint-registry lookup is that same shape, so decidability is not what
  separates them. Mutability is. The rule is therefore **read-time only**: the view renders the
  named reason *"this view's axis is sprint-scoped and no sprint applies"* rather than an empty
  frame — which is the same treatment §5.3 gives a `focus` pointing at a deleted ticket. (An
  earlier draft also scoped this per project. Sprints carry no project key until spec 2 changes
  the registry, so there is nothing per-project to test here yet.)

The sprint-selection chain itself — requested → active → first registered (`gantt.mjs:33-36`) —
is a rule about *which sprint*, not about *which axis*, and this spec changes none of it.

**Spec 2 (BLZ-364) does.** It deletes the chain's `|| list[0]` tail, on the ground that a silent
fall-through to an arbitrary sprint is the mechanism behind §1.1's stale-`S2` picture, and
replaces it with a named no-selection state. That is spec 2's call and this spec does not
contradict it — but a reader of both should know the chain is *"unchanged"* only as far as spec 3
is concerned.

**The migrated builtin `gantt` row gets `axis: 'sprint'`**, so the *row set and the axis window*
are unchanged for every existing user. A new view created by an operator gets `axis: 'schedule'`.
**The default that ships and the default that migrates are deliberately different, and that is a
one-release condition rather than the end state:** once `import-deps` (BLZ-360 §5.5) has populated
`Precedes`, the builtin should flip to `'schedule'` too, and **that flip is its own ticket** with
its own expected-delta list. **What exactly triggers it is not settled — §13.2 carries the
question**, and "once `import-deps` has populated `Precedes`" is this section's proposal rather
than a decision.

**But the zero-diff oracle does NOT diff to nothing, and an earlier draft of this section claimed
it would.** BLZ-354 §6.4's oracle — *"render all six views on the live 11-project board before and
after the cutover and diff the HTML"* — compares HTML, and §4.2 replaces the bar vocabulary
**unconditionally, on both axes**. `views/gantt.mjs:74` emits `class="bar bar-${barKind}"`, so a
renamed kind is a changed attribute. Measured by running the real `ganttModel` over all five
sprints and mapping each row through §4.2:

| | Today | After |
|---|---|---|
| Bars drawn | **80** (`solid` 38, `unplanned` 42) | **80** (`actual` 27, `complete` 27, `scheduled` 24, `milestone` 2) |
| Bars whose class changes | — | **80 of 80** |

Transitions: `solid→actual` 27, `solid→scheduled` 10, `solid→milestone` 1, `unplanned→complete`
27, `unplanned→scheduled` 14, `unplanned→milestone` 1. Geometry moves too, because a `scheduled`
bar runs ES→EF rather than `start`→`due`.

**So the gantt view ships with an expected-delta list, in the shape BLZ-360 §4.1 requires of the
date migration** — *"the oracle gains an explicit expected-delta list"* — and a changed bar outside
it fails the oracle.

**Its size depends on something BLZ-354 §6.4 does not specify, and that has to be fixed here.** The
oracle as described renders *"all six views"* once per scope, and the gantt at the registry
default selects `S2` and draws **11** bars — not 80. The 80 is every sprint's rows summed. So
either the oracle enumerates all five sprints, or the delta list is 11 and the other 69 changed
bars are never rendered by it. **This spec requires the enumeration**, because a per-sprint bar
vocabulary change that only ever gets checked against the one sprint the stale `active` pointer
happens to name is not checked at all — and §1.1 measured that pointer as 19 days out of date.

### 2.2 The schedule axis window

`axis: 'schedule'` spans, in working days:

```
start = min(project_epoch, earliest deadline in scope,
            earliest frozen actual date in scope)          -- its start, or its due if it has no start
end   = max(latest EF in scope, latest deadline in scope, latest frozen actual due in scope)
        + 1 working day
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

`gantt.mjs:47-53` builds one column per day at `PX_PER_DAY` (`:16`) `= 28`. Over a sprint that is 6–14
columns. Over the schedule axis it is the span above.

Measured today, the schedule axis would span **2026-07-24 → 2026-10-21 = 90 calendar days =
2,520 px**. Each of the three terms in §2.2's `min`/`max` is doing work, and it is worth seeing
which:

| Term | Date | Set by |
|---|---|---|
| earliest frozen actual date | **2026-07-24** | a terminal ticket — this is what `start` actually resolves to |
| earliest migrated deadline | 2026-08-07 | the 11 past deadlines |
| `project_epoch` | 2026-08-24 | a Monday, so it floors to itself |
| latest EF | 2026-08-24 + 10.0 working days | `BLZ-253` (§5.1) |
| latest deadline | **2026-10-20** | `OMA-4` |

So the frozen actuals reach further back than any constraint does, and dropping them from the
`min` would shorten the axis to 2026-08-07 → 2026-10-21 — **76 days, 2,128 px**. They are kept:
§4.2 renders those 28 tickets, and an axis that excludes rows it draws is not an axis. Wide,
scrollable, and fine.

**`latest frozen actual due` is in the `max` for symmetry with that same argument, and it is
latent today** — the latest terminal `due` is 2026-08-14, well inside `OMA-4`'s 2026-10-20. It is
specified anyway because the asymmetry is only invisible while some deadline happens to sit
further out, and a board with no far-future deadline would clip the actuals it draws. An earlier
draft omitted it and the omission was found by review.

**It does not stay fine, and the trigger is stated rather than guessed:** one column per day at
28 px is 10,220 px per year. **When the schedule axis exceeds 180 days, the model switches its
column unit from day to week** and `axis.pxPerDay` becomes `axis.pxPerUnit` with a declared
`unit`. Not built in v1 — 90 days is inside the budget — but the field is named now so the
renderer is not rewritten later. `OMA-4` alone would trip a 60-day threshold, which is why the
threshold is 180 and not 60.

---

## 3. `dateSource` is deleted

BLZ-354 §10.2 kept it and predicted its removal:

> *"`dateSource` is now a closed key set with exactly one legal value. A key whose enum has one
> member decides nothing. It is kept for one release … **Whoever writes spec 3 should expect to
> delete it.**"*

**Deleted — and an earlier draft of this section claimed the reason was novel, which was false
because it had trimmed the source mid-sentence.** Spec 1's full sentence is:

> *"…and a Gantt has to be able to say which it is rendering — **but it should be re-examined once
> that distinction lives on the row (`schedule_run_id`) rather than in a view's config.** Whoever
> writes spec 3 should expect to delete it."*

The clause after the dash **is** the `schedule_run_id` argument this section makes. So spec 1
named both the decision and its reason, and this spec supplies neither. What it does supply is the
**measurement that closes it**, which spec 1 did not have:

**A single Gantt renders both kinds at once, so the question spec 1 wanted the key to answer has
no per-view answer at all.** The board holds **28 terminal tickets with frozen actual dates** and
**533 schedulable tickets** with derived ones, and no filter in this spec separates them — a
project view over `INF` shows both. "Which is it rendering" is therefore not a property of the
view; it is a property of each row.

And the row already carries it. BLZ-360 §2.2 gives every scheduled row a `schedule_run_id`, and
§6.2 says a terminal ticket *"is never a node … and the scheduler has no write path to them"* —
so `schedule_run_id IS NULL` **is** the discriminator, exactly. A `dateSource` key would be a
second, coarser source of the same fact, able to disagree with the rows it describes. §4.2 makes
the distinction visible where it actually lives: in the bar.

**The one-release deferral spec 1 attached to the deletion is therefore not needed**, and that —
rather than the reason — is what this section adds.

---

## 4. The bar vocabulary

### 4.1 What collapses, and what it costs — measured

BLZ-360 §8.2 predicts the four kinds collapse. Measured on the live corpus, two of them are
**already unreachable**:

| Kind (`gantt.mjs:70-73`) | Rows on the live corpus | Fate |
|---|---|---|
| `solid` — start + due | **38** (S1: 13, S3: 25) | **splits**: 27 → `actual`, 10 → `scheduled`, 1 → `milestone` (§4.2) |
| `open-end` — start only | **0** — the corpus holds **zero** start-without-due tickets | **deleted** |
| `open-start` — due only | **0 in any sprint** — the 2 due-only tickets carry no sprint | **deleted** |
| `unplanned` — neither | **42** (S2: 11, S4: 6, S5: 20, S1: 3, S3: 2) | **splits**: 27 → `complete`, 14 → `scheduled`, 1 → `milestone` (§4.2). It is not renamed `unscheduled`; an earlier draft said so and contradicted §4.2's own count. |

**The two "0" rows are not measured over the same population.** `open-end`'s zero is
**corpus-wide** — 0 start-without-due tickets among all 2,613 — so it holds on either axis.
`open-start`'s is **sprint-scoped**: *"0 in any sprint"*. On the schedule axis the two due-only
tickets **are** in scope — `OBA-668` (terminal) and `OMA-4` (non-terminal). §4.2 gives `OBA-668` a
rule and BLZ-360 §4 turns `OMA-4`'s `due` into a `deadline` rather than a bar end, so neither
needs the deleted branch; but "costs nothing in the corpus" is a sprint-axis statement and is
recorded as one.

`gantt.mjs:71` and `:72` are **dead code paths on this board**, and have been since the view
shipped. Deleting them costs nothing in the corpus and costs exactly **two tests** —
`"open-end bar (start only) runs start → sprint end"` (`tests/model/gantt.test.mjs:105`) and
`"open-start bar (due only) runs sprint start → due"` (`:113`), both of which build their own
fixtures. **Those two tests are deleted with the branches, deliberately and by name.** Deleting a
test to make a change pass is the thing this repo's review bar exists to catch, so the rule
applied here is: a test may be deleted only when the *behaviour* it describes is deleted, and the
PR names it. Both are.

### 4.2 The four kinds after

**The partition must be total, and an earlier draft's was not.** Its four kinds all required
either non-terminal status or frozen dates, so a **terminal delivery ticket carrying no dates**
matched none of them — and measured, that is **27 of the 80 bars the sprint Gantt draws today
(34%)**, `OBA-621`, `OBA-622`, `OBA-623`, `OBA-413`, `OBA-485` and 22 more. Review found it; the
fix is a fifth kind, and the fifth kind is also what §4.1's `unplanned` rows actually become.

| Kind | When | Rows today (sprint axis / schedule axis) |
|---|---|---|
| `scheduled` | non-terminal, `estimate > 0` | **24 / 393** |
| `milestone` | non-terminal, no estimate — zero-duration | **2 / 140** |
| **`actual`** | terminal, carrying frozen dates | **27 / 28** |
| **`complete`** | terminal, carrying no dates | **27 / excluded** |
| `unscheduled` | in an SCC, or a dropped edge leaves it unsolvable | **0 / 0** |

The first four are **exhaustive over every delivery ticket** — 2,179 of them, partitioning as
28 `actual` + 1,618 undated-terminal + 393 `scheduled` + 140 `milestone` with **no remainder**,
verified by construction rather than asserted.

**The schedule axis's 28 `actual` rows are not 28 of the same shape.** 27 carry both dates;
**`OBA-668` (`feature`, `done`, `due: 2026-08-04`, no `start`) carries only a due.** §4.1 deletes
the `open-start` branch on the ground that *"the 2 due-only tickets carry no sprint"* — which is
true on the sprint axis and irrelevant on the schedule axis, where `OBA-668` is in scope. So an
`actual` bar with one endpoint needs a rule, and it is the same one §2.2 uses: **a frozen actual
with only a due is drawn as a zero-extent marker at that due**, not as a bar running from an
invented start. It is one ticket today and it is named because a rule discovered during
implementation is a rule someone invents under time pressure.

**`complete` exists because a done ticket with no dates has no extent, and today the renderer
invents one.** `gantt.mjs:73` runs an `unplanned` bar from `winStart` to `winEnd`, so those 27
rows currently claim to have taken the whole sprint. On a sprint axis the window is at least a
true statement to sprint precision, so `complete` renders as a filled fixed-width marker at the
sprint's end. **On the schedule axis it is excluded with a stated count**, because there is no
window to be imprecise within and inventing a position is a lie. Excluded, not silently dropped:
the view says *"1,618 completed tickets carry no dates and are not shown"*.

That exclusion is also what keeps the schedule axis's row set sane: **561 rows** (533 schedulable
+ 28 dated terminal), not 2,179 — of which **74.3% would be undated done work**.

**`unscheduled` really does have zero members, and one of its three reasons is vacuous.** 0 SCCs
is a genuine measurement (BLZ-360 §5.4, re-measured here and confirmed); "no schedulable ticket
outside the solve graph" is a tautology; and "0 dangling `Precedes` targets" is **vacuous, because
there are 0 `Precedes` edges of any kind**. The 486 tickets with no edge and the 505 with no
predecessor are **`scheduled`**, not `unscheduled` — they start at `project_epoch` and finish at
`project_epoch + duration`, which is an ordinary bar. So the kind ships **defensive, exactly as
BLZ-360 §6.2 says the cycle path is**, tested against synthetic fixtures only, which is a weaker
guarantee than every other kind in this table gets. §13.4 carries what happens to it after
`import-deps`.

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
| Longest chain **by ticket count** | **4 tickets — and it is a four-way tie**: `SN-27→SN-28→SN-33→SN-36`, `SN-19→SN-20→SN-23→SN-36`, `SN-19→SN-21→SN-23→SN-36`, `SN-19→SN-22→SN-23→SN-36` |
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
                              contains no dependency. 0 Precedes edges exist, so all 533
                              schedulable tickets start at the project epoch.
                              Run `blaze schedule import-deps` to reconcile the 392 Blocks
                              edges (BLZ-360 §5.5).
   ```

   **The counts in that string are read from the solve, never hardcoded — and getting that right
   took two attempts, both caught by review.** The first draft wrote *"36 Precedes edges exist"*,
   taking the count from the 36 **`Blocks`** edges this spec uses as a measurement stand-in, while
   §4.2 said there were none. The second fixed the edge count and left *"505 of 533 (94.7%) have
   no predecessor"* beside it — the same error in the other half of the sentence, because **with 0
   `Precedes` edges the figure is 533 of 533**. The 505 is what the number becomes *after* the 36
   `Blocks` edges are imported, and §5.1's table is where that projection belongs. A string that
   mixes the current state with a projected one is a defect however accurate each half is alone.

   It follows BLZ-360 §7.2's rule exactly — *"a finding that says only 'deadline missed' is a
   defect"* — by carrying the counts and naming the action. It is **soft** by
   `scripts/model/audit.mjs:9-11`'s own test: HARD means the corpus is *wrong*, and a corpus
   with few dependencies is not wrong, it is just sparse.

3. **A dependency edge is drawn only when both endpoints are on screen.** With `axis: 'schedule'`
   and no filter that is every edge. Measured, the two filters differ enormously: a `project`
   scope hides at most **1** edge on this corpus (`CRP-8 → SN-5`, the only cross-project one of
   the 36), while `axis: 'sprint'` hides **all 36** (§1.3). When edges are hidden by scope, the
   view says how many: *"1 dependency not shown (endpoint out of scope)"*, with the count read
   from the solve. Silently dropping them would make a
   filtered Gantt look like a board with no dependencies, which is the exact false picture §1.3
   shows the current view already paints.

### 5.3 `showCriticalPath: true` with `axis: 'sprint'` is legal, and warns

This combination draws no chain **on this corpus** — §1.3's zero same-sprint edges — and that is
knowable in advance. It is **not blocked** —
it is **advisory**, which is BLZ-354 §5.3's third bucket, *"Advisory, never blocking"*.

**Three drafts of this paragraph reached that conclusion by three different arguments, and the
third was the worst.** It is worth recording, because the error was over-claiming a rule rather
than getting a fact wrong:

- **Draft 1** quoted BLZ-354 §5.3 with a "never" silently inserted — a misquotation that happened
  to reach the right answer.
- **Draft 2** removed the inserted word and kept the conclusion, quoting faithfully.
- **Draft 3** misread the faithful quotation's subject, declared the source self-contradictory,
  and instructed that it be **edited at source**.
- **Draft 4** promoted ADR-0015 to *"the one rule"* deciding this and §2.1 — and then applied its
  decidability test in **opposite directions** in the two sections, calling a board-wide edge
  query "decidable at write time" here while calling a single registry lookup "not decidable from
  the item alone" there. Both cannot be right.

**What ADR-0015 actually settles, and what it does not.** Its rule is real and this spec honours
it:

> *"A check blocks at **write time** only if it is **both** decidable from the item alone **and**
> true of a legitimate draft. Fail either test and it belongs at a **gate**."*
> — v4 spine §4 (`:199-200`), restating `docs/decisions/0015-…:124-125`

But **it does not decide this case, because "legitimate" is its input rather than its output.**
Frame the check as *"can this view draw a chain"* and it is false of a legitimate draft; frame it
as *"is this config combination well-formed"* and it is true of one, and blockable. ADR-0015
chooses neither framing. **The framing is a product judgement and this spec owns it:** an operator
asking *"which of this sprint's tickets sit on the board's critical path"* is asking a real
question with a useful per-ticket answer, and refusing to save that view would refuse the
question. So the combination is legitimate, and it is advisory.

**ADR-0015's matrix has two outcomes — block and gate — and "advisory" is neither. The third
mechanism is v4 spine §4.3, and it is established *per ADR-0015* rather than against it.** Spine
§4's heading is *"Enforcement — three mechanisms, per ADR-0015"*, and its three subsections are
**§4.1 Write-time blocks, §4.2 Gates, §4.3 Advisory** — *"Reported, never blocking"*. BLZ-354
§5.3's "Advisory, never blocking" table is downstream of it: the spine is dated 2026-08-22 and
BLZ-354 2026-08-23.

**That matters because it removes a question an earlier draft created and could not answer.** That
draft named BLZ-354 §5.3 as *"the operative authority"* over ADR-0015 — a spec outranking an
accepted ADR, which would be a real problem. It is not the situation: the spine adds a third
mechanism under the ADR's own authority, and this spec is using it, not overriding anything. The
spec quoted spine §4 two paragraphs above and missed §4.3 twenty-five lines below it.

So it renders, with:

```
critical-path decoration is on and the axis is sprint-scoped: <n> of this sprint's
<m> dependencies have both endpoints in the sprint. <n=0 → no chain is drawn.>
```

**Both numbers are read from the solve; neither is written into the string.** This sentence has
now carried a wrong constant twice. One draft put *"36 dependencies"* here — a board-wide count of
`Blocks` stand-in edges, in a string scoped to one sprint, where no sprint has 36. The next
removed the 36 and left *"**0** of this sprint's dependencies … so no chain is drawn"*, which is
still a hardcoded count and an unconditional consequence: both are true of this corpus today and
false the moment one sprint holds both endpoints of one edge. §5.2 rule 2's requirement — counts
read from the solve, never hardcoded — applies to every finding string in this spec, including
the ones written as illustrations.

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

**One rename inside `groupBy: 'parent'`, and it is not confined to the model.** `gantt.mjs:89-98`
calls the group key `epicId` and its comment says *"one header per distinct parent epic"*. `epic`
was retired as a type by BLZ-231; the field groups by `parent`, whatever type that parent is. It
becomes `parentId`.

Measured, the rename touches **four production sites and one test**: `gantt.mjs:96` and `:98`,
**`views/gantt.mjs:85` and `:89`** (which read `g.epicId` both to label the header and to look up
the group's rows), and `tests/model/gantt.test.mjs:164`. Pure rename, no behaviour change — but an
earlier draft called it exactly that while §9 counted none of it, which is how §9's floor went
wrong the second time.

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

**A golden fixture with bars in it does not exist and must be built first** — see §9. **What does
not change, and is load-bearing:** purity. No `Date.now()`, no `Math.random()`, `now`
injected by the caller, the locale-independent `cmp` at `:17`, ties broken by id. BLZ-360 §6.1
inherits this rule from `gantt.mjs`'s own header verbatim, so the scheduler and the view already
agree on it. **The golden-SVG tests gate determinism and nothing else**, because §9 measures that
no golden in this repo contains a single bar — so they are not a gate on anything in §4.

**The model still receives a built index and returns positioned rows.** It gains the schedule as
an input — computed by the kernel's pure pass (BLZ-360 §6.3: lazy, recomputed on read) — and does
not compute it itself. **That plumbing does not exist yet and is named here rather than assumed:**
`ganttModel`'s only production caller is `views/page.mjs:63`, and `renderView`'s parameter object
(`page.mjs:47`) carries nothing schedule-shaped, so `renderView` gains a `schedule` argument
alongside `transitions` — which is the same shape `metrics` already uses at `page.mjs:53`.

A view that ran its own CPM would be a second implementation able to
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

**That framing needs a set the view can compute, and an earlier draft named the wrong one.** It
said a migrated deadline is *"exactly one whose ticket appears in the 40-id expected-delta list"* —
but BLZ-360 §4's 40 ids are **28 terminal + 12 non-terminal**, so membership identifies a *dated*
ticket, not a *migrated deadline*. The correct set is the 12-id non-terminal cohort, and the
migration must therefore record **which** of the 40 became a `deadline` rather than only that they
changed. That is a one-line addition to BLZ-360 §4.1's expected-delta list and it is flagged here
rather than assumed.

---

## 9. Testing, and the mutation discipline

TDD throughout, and the regression floor is **lower than an earlier draft claimed**. That draft
said *"25 of 27 must still pass"*, counting only the two tests that die with §4.1's deleted
branches. Review found two more, and the count is now measured against the files rather than
inferred:

| Test | Asserts | Fate under this spec |
|---|---|---|
| `tests/model/gantt.test.mjs:105` "open-end bar (start only)" | the deleted branch | **deleted with the behaviour** (§4.1) |
| `tests/model/gantt.test.mjs:113` "open-start bar (due only)" | the deleted branch | **deleted with the behaviour** (§4.1) |
| `tests/model/gantt.test.mjs:100` | `barKind === "solid"` | **rewritten** — and to `milestone`, not `scheduled`. The `R()` helper (`:11-15`) defaults `status: "defined"` and sets **no `estimate` at all**, so every fixture row built from it is non-terminal and zero-duration |
| `tests/model/gantt.test.mjs:124` | `barKind === "unplanned"` | **rewritten** — the kind splits (§4.2) |
| `tests/model/gantt.test.mjs:131` "a start one day later lands at a strictly greater, EXACT x" | `x === 224` / `x === 252`, derived from each row's `start` | **rewritten** — those rows are non-terminal and estimate-less, so §4.2 makes them `milestone` and §2.1 positions them at ES, not at `start` |
| `tests/model/gantt.test.mjs:164` "two rows under different epics → two groups" | `groups[].epicId`, three times (`:167`, `:168`, `:172`) | **rewritten** — §6 renames the field to `parentId` |
| `tests/views/gantt.test.mjs:42` "a bar `<rect>` carries data-id and the model's EXACT x + width" | `data-id="A-1"` at `x = GUTTER+224`, `width = 84` | **rewritten** — same fixture shape, same reason as `:131` |
| `tests/views/gantt.test.mjs:85` "status drives the bar fill" | `data-id="B-1"[^>]*fill-opacity="0.35"` where `B-1` is `{task, done, start, due}` | **rewritten — and it is the load-bearing one** |

**That last row is a trap and it must be named.** `B-1` is precisely §4.2's `actual`, which
requires a distinct fill; but `fillFor()` (`views/gantt.mjs:33-37`) derives fill from **status
alone**. So implementing §4.2 correctly breaks `:85`, and leaving `:85` passing means `actual` has
no distinct fill — **which makes §9's mutation 4 survive by construction**. The test and the
decoration cannot both stand as written, and the resolution is that `fillFor` takes the bar kind
as well as the status.

So: **19 of 27 pass unchanged, 2 are deleted with their behaviour, 6 are rewritten**, and all
eight are named here and in the PR body.

**That 19 holds only because `ganttModel`'s own `axis` default is `'sprint'`, and this spec has to
say so explicitly.** `ganttModel`'s signature today is
`({ index, sprints, sprint, project = "all", now })` (`gantt.mjs:29`) — it has no `axis` parameter
at all, so adding one means choosing its default, and **that default is not the same as §6's
registry default**:

| Layer | Default | Why |
|---|---|---|
| `ganttModel`'s parameter | **`'sprint'`** | every existing production caller passes a sprint registry and expects sprint behaviour |
| A newly created view's `config_json` (§6) | **`'schedule'`** | the axis this spec argues for |
| The migrated builtin row (§2.1) | `'sprint'` | so the row set and window are unchanged |

**One rule makes the two layers agree instead of race, and without it they do not.** A stored
`config_json` omitting `axis` would otherwise resolve to `'schedule'` by the registry and
`'sprint'` by the model — opposite axes for one row, decided by whichever layer fills the gap.
BLZ-354 §5.1's registry sketch carries no `default` field at all, so nothing currently settles it.
The rule:

> **A view's defaults are materialised into `config_json` at create time. The model parameter's
> default is a fallback for direct callers only, and no stored row ever relies on it.**

**That rule needs one amendment to BLZ-354 §6.2, and without it the rule and the migration
contradict each other.** §6.2's seed emits every builtin row with **`config_json = '{}'`**, so the
migrated `gantt` row would store no `axis` and would have to rely on a fall-through default —
which this rule forbids — or take the registry's `'schedule'`, which flips the builtin to the
schedule axis and destroys §2.1's whole expected-delta argument. **The amendment is one line: the
seeded `gantt` row gets `config_json = '{"axis":"sprint"}'`, not `'{}'`.** It is BLZ-354's file to
change and it is named here rather than assumed.

With the rule and the amendment, §9's mutation 8 — *"default `axis` to `'sprint'` for a newly
created view"* — is killable. Without them the fall-through path already produces that mutant, so
it is not a mutation at all.

**If the model parameter defaulted to `'schedule'` instead, at least four tests break**, and the
count is stated as a floor because a full counterfactual needs the implementation:

| Test | Breaks because |
|---|---|
| `tests/model/gantt.test.mjs:29` "no sprints → empty" | §7 removes the `EMPTY` return for `axis: 'schedule'`; it passes `{ active: null, sprints: [] }` |
| `tests/views/gantt.test.mjs:92` "empty model shows a create-a-sprint prompt" | same branch |
| `tests/model/gantt.test.mjs:147` "nowX is a number when now is inside the axis" | asserts `nowX === X("2026-07-20") === 224`, and `X` (`:25`) is anchored to **S1's window**. §2.2's schedule window is not that window, so the constant cannot survive |
| `tests/views/gantt.test.mjs:52` "the today-marker renders at nowX" | asserts `x1="444"` = `GUTTER + 224`, the same anchor |
| `tests/model/gantt.test.mjs:37` "absent sprint param falls back to active" | asserts `selected === "S1"`; on a schedule axis either the selection chain still runs — contradicting §7's *"needs no registry"* — or `selected` is null |

**Two earlier drafts got this wrong in opposite directions.** The first listed eleven tests, of
which seven do not break: `:177` is the determinism test; `:70`, `:78`, `:87` assert the
delivery-type filter with every fixture row carrying `sprint: "S1"`; `:43`, `:52`, `:62` pass an
explicit `sprint`, which stays a row filter on either axis. The second corrected that to *"the two
asserting the empty-registry branch"* — and dropped `:37`, `:147`, `:152` and `:157` without
addressing them, three of which do break. **This is the third time this paragraph has been wrong,
and each time by reasoning about the change instead of running it.** The honest statement is a
floor, not a count.

**This table has now been wrong twice.** The first draft said "25 of 27", counting only the two
deleted. The second said "22 … 3 rewritten", having re-measured the `barKind` assertions and
stopped there — it missed the three tests that assert **geometry** and **group field names**
rather than kind names. The lesson is narrow and worth recording: a change to what a field is
called, or to how a row is positioned, breaks tests that never mention the thing being changed —
so the search has to run over the model's whole output shape, not over the vocabulary being
renamed.

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

**Three of these nine are not killable by the suite as it stands, and saying so is the point of
the exercise:**

- **Mutation 9 is behaviourally unobservable and cannot be killed by any output assertion.** A
  *correct* second CPM inside `ganttModel` produces byte-identical output; only an incorrect one
  differs, and the mutation does not require incorrectness. It is killable only **structurally** —
  by injecting a schedule whose values deliberately disagree with what a re-solve would produce
  and asserting the *injected* values reach the bars. That test is named here because without it
  the mutation is untestable, and an untestable mutation in a discipline list is decoration.
- **Mutations 3 and 4 have no existing coverage to build on.** Measured: `grep -rn "bar-" tests/`
  returns **0 hits**, and `tests/views/page-golden.html` contains **0** `<rect` elements — the
  golden fixture ships no `sprints.json`, so it renders the `gantt-empty` branch. **No golden
  anywhere in this repo contains a single Gantt bar.** §7's statement that the golden-SVG tests
  gate determinism *and nothing else* is a consequence of this measurement, and **a golden with
  bars in it is a prerequisite for this spec rather than a nicety**.

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
| **ADR-0015 — write-time blocks vs gates** | Honoured: this spec proposes **no** write-time block. Its two candidates (§2.1, §5.3) are both **advisory with a named reason at render time**, which is BLZ-354 §5.3's third bucket and not a cell in ADR-0015's block/gate matrix. **ADR-0015 is the principle; BLZ-354 §5.3's table is the operative authority**, because it carries the advisory bucket and the ADR does not. An earlier draft called ADR-0015 "the one rule" these turn on, which it is not — its "true of a legitimate draft" test takes legitimacy as an input rather than deciding it. |
| **BLZ-354 §3 — the record shape** | `gantt` is a `(scope, project_key, type, name, config)` row with five config keys and no second table (§6). |

---

## 12. No ADR

**This spec raises none, and the reason is a test rather than an omission.** Every decision above
is either a view-layer default (`axis`, bar kinds, group key), a rendering consequence of a
decision an ADR already carries (`milestone`, `actual`, the deadline pin), or a config-key
addition inside the `view` table BLZ-354 §3 establishes.

**One correction to that sentence's earlier form, which cited "a table ADR-0021 already
establishes".** When this spec merged, `docs/decisions/` stopped at **ADR-0020** and ADR-0021 was a
`status: proposed` draft living in BLZ-354 Appendix A with no file behind it. An argument that this
spec needs no ADR cannot lean on an unwritten one, so it leaned on the spec instead. **That
prerequisite is now discharged: BLZ-366 transcribed both drafts into
[`0021`](../../decisions/0021-the-tenancy-unit-is-an-installation-a-board-is-a-view-type.md) and
[`0022`](../../decisions/0022-constraints-are-inputs-dates-are-derived.md).** None of §1–§11 changes a system-wide invariant, none is expensive
to reverse, and none contradicts an ADR that does exist.

**What would need one:** making the schedule axis the *only* axis (retiring `axis: 'sprint'`
rather than defaulting away from it) — because that deletes the sprint Gantt BLZ-109 shipped and
BLZ-354 §8.2 promised would keep working. §2.1 deliberately does not do that, and the flip of the
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
4. **What does `import-deps` do with an edge whose target is not schedulable?** Measured, **33
   `Blocks` edges have a schedulable source and a non-schedulable target** (54 the other way).

   **An earlier draft turned that into a claim that `import-deps` would raise up to 33
   `dangling-target` HARD findings, and that was wrong in all three of its steps** — the numbers
   were right and the inference was not. Corrected, against the code:

   - `dangling-target` fires only when the **target id does not exist**
     (`audit.mjs:115` — `if (!ids.has(link.target))`). Measured, **all 392 `Blocks` targets
     resolve to a known ticket**, so none of the 33 can raise it. A terminal target is not a
     dangling one.
   - BLZ-360 §5.3 restricts `Precedes` to
     `target_kinds: ["feature","story","task","bug","subtask"]`. Of the 33 targets, **23 are
     `risk` (16) or `goal` (7)** and are refused by the endpoint rule before any solve;
     **only 10** could become `Precedes` edges at all.
   - BLZ-360 §5.5 is operator-driven — *"the operator resolves them; the tool never guesses"* —
     so nothing lands "on the day it runs".

   **The real question, which is smaller and still open.** Those ≤10 edges point *at* a terminal
   ticket — the terminal ticket is the **successor**, not the predecessor:

   ```
   BLZ-97→INF-556  INF-276→INF-275  INF-281→OBA-246  INF-37→INF-100  INF-789→OBA-693
   INF-95→INF-100  INF-657→INF-650  OBA-724→OBA-717  OBA-869→OBA-859  OBA-706→OBA-707
   ```

   **That orientation matters, and an earlier draft cited the wrong rule for it.** BLZ-360 §6.2's
   boundary-condition clause — *"supplying a finish time to its non-terminal successors"* — is
   about a terminal **predecessor**. A terminal **successor** is not a boundary condition at all:
   §6.2's node filter (step 2) drops it from the graph, and an edge cannot connect a node that is
   not there.

   **§6.2 does not spell that last step out, so this spec is asserting it rather than citing
   it.** §6.2's only rule about an edge with an unusable target is the *"Dangling `Precedes`
   target"* row, which raises a **HARD** finding and concerns a target id that does not resolve —
   not this case. **An edge whose target is filtered out as terminal is therefore dropped silently
   and raises nothing, and that is a gap in §6.2 this spec is naming rather than a rule it is
   quoting.** The conclusion — `unscheduled` gains no members — holds either way.

   **And 4 of the 10 are mutual pairs** — `INF-276↔INF-275`, `INF-281↔OBA-246`, `INF-37↔INF-100`,
   `INF-95↔INF-100` — so they are among §5.5's 124 undecidable pairs and have no direction to
   import in the first place. What is genuinely undecided is whether `import-deps` should
   **offer** an edge whose target is terminal at all, given the solve discards it.
5. **What does the schedule axis cost to render at 11 projects?** BLZ-354 §11.2 asks the same of
   project-scoped `metrics` and this repo's own rule applies: *"needs a measurement, not an
   assumption."* 561 rows × 90 day columns is unmeasured. The current view's worst case is
   **27 rows × 12 columns** (S3); the widest axis is S5's 14 columns over 20 rows.
