# Blaze v4 — spec 2: agile execution — a sprint belongs to a project, and velocity is measured

**Status:** draft for review · **Date:** 2026-08-24 · **Consumer spec, BLZ-364**

Spec **2** of the six v4 subsystems and the **fourth written**, after spec 3
([`2026-08-24-gantt-and-critical-path-design.md`](2026-08-24-gantt-and-critical-path-design.md),
BLZ-363). It settles the sprint record, the per-project active pointer **BLZ-354 §8.1 named and
handed over**, what capacity means on this board, how velocity is computed, how a sprint board is
expressed as a view, and how a sprint that disagrees with the schedule is reported.

**Two different gaps get handed to this spec by the two kernel specs and they are not the same
one:** BLZ-354 §8.1 hands over the **single global `active` pointer** (§1, §2), and BLZ-360 §8.1
hands over **sprint-membership-versus-schedule** (§4). Conflating them would lose one.

**Its inputs are merged and are not reopened:** the two kernel specs (BLZ-354, BLZ-360) and spec
3. The operator settled both kernel decisions on 2026-08-23.

Every number was measured against the live board on 2026-08-24 — **2,613 tickets, 11 projects, 5
sprints, 499 transitions** — by running the measurement, not by citing one.

---

## 0. The two decisions

> **1. A sprint belongs to exactly one project, and `active` becomes a per-project pointer.**
>
> **2. A sprint board forecasts from measured velocity, not from a computed capacity — because
> the obvious capacity denominator is wrong on this board by 3.97×.**

The first was named as a gap by BLZ-354 §8.1 and left unaddressed. The second is this spec's, and
§3 is the measurement that forces it.

---

## 1. The gap, measured

BLZ-354 §8.1 states it and hands it over:

> *"sprints are a registry at the data root — `sprints.json`, `model/sprints.mjs` — with a
> **single global `active` pointer**. A per-project sprint board wants a per-project active
> sprint. Real gap, named here so spec 2 finds it on day one rather than late."*

It is a real gap, and the corpus says it is further along than "wanted": **the operator is already
running per-project sprints and the registry cannot express it.**

### 1.1 Every sprint on this board is already single-project

| Sprint | Window | Tickets | Projects | Name |
|---|---|---|---|---|
| S1 | 2026-07-24 → 2026-07-29 | 16 | **OBA only** | "OBA CMS-foldin + demo-MVP close-out" |
| S2 | 2026-08-02 → 2026-08-05 | 11 | **OBA only** | "OBA-1 re-baseline + 2026-08-06 demo close-out" |
| S3 | 2026-08-07 → 2026-08-16 | 27 | **INF only** | "INF board integrity + observability critical path" |
| S4 | 2026-08-10 → 2026-08-16 | 6 | **OBA only** | "OBA brand-epic close-out + compliance-surface remediation" |
| S5 | 2026-08-11 → 2026-08-22 | 20 | **OBA only** | "OBA S5 — capture unblock, deploy defects, reliability, suite trust" |

**Five of five, single-project. Zero cross-project sprints have ever existed on this board.** The
registry's fields are `{ id, name, start, end }` — measured, there is no `project` field — so the
operator encodes the project **in the sprint's name**, four times as a prefix and once
(`S2`) as a ticket id that merely looks like one.

That last detail matters for §2.2: **the name is not a parseable source of the project.** `S2`'s
name begins `"OBA-1 re-baseline"`, where `OBA-1` is a ticket, not the project key `OBA`. A
migration that split the name on the first token would be right four times out of five and
silently wrong once, which is the worst available ratio.

### 1.2 The single pointer is not merely awkward — it is already wrong

Two independent measurements:

**Sprints overlap in time. Three of the ten possible pairs do:**

```
S3 (2026-08-07..08-16, INF)  ×  S4 (2026-08-10..08-16, OBA)
S3 (2026-08-07..08-16, INF)  ×  S5 (2026-08-11..08-22, OBA)
S4 (2026-08-10..08-16, OBA)  ×  S5 (2026-08-11..08-22, OBA)
```

On 2026-08-11 through 2026-08-16, **three sprints were simultaneously live**, across two projects.
A single `active` string can name one of them. So the registry could not describe the board's own
state for at least six consecutive days, and no error was ever raised, because nothing checks.

**And the pointer is stale.** `sprints.json` says `"active": "S2"` — a sprint that **ended
2026-08-05**, 19 days before today, while S3, S4 and S5 all started *after* it. Spec 3 §1.1
measured the consequence from the other end: opening the Gantt today selects S2 and draws 11
bars on an axis that ended nineteen days ago.

**Note what this rules out.** `S4` and `S5` are *both* `OBA` and *both* live on 2026-08-11..16, so
"the current sprint" cannot be derived from dates alone even after the registry becomes
per-project. An explicit pointer is still required; it just has to be one per project. That is a
measurement, and it kills the tempting simplification of deleting `active` entirely.

### 1.3 Nine of eleven projects have never used a sprint

`ACA`, `BLZ`, `CRP`, `FL`, `KPA`, `NCA`, `OMA`, `SN`, `STA` — **zero** sprint-tagged tickets
between them, holding **184 of the 533 schedulable tickets (34.5%)**. Only `INF` and `OBA` have
ever run one. (The `BLZ` share of that 184 includes the three tickets this spec's own work
created, BLZ-363/364/365.)

This is the constraint that shapes §2: whatever the sprint record becomes, **a project that has
never had a sprint must keep working with no sprint at all**, and must not acquire a mandatory
one. `loadSprints` already returns `{ active: null, sprints: [] }` for a board with no registry
(`sprints.mjs:7`, `:13`) and that path stays.

---

## 2. The record

### 2.1 `project` is required and single-valued

```jsonc
{
  "active": { "OBA": "S5", "INF": "S3" },        // per project; a project may be absent
  "sprints": [
    { "id": "S5", "project": "OBA", "name": "…", "start": "2026-08-11", "end": "2026-08-22" }
  ]
}
```

**`project` is required on every sprint and holds exactly one key.** The alternative — a
multi-valued `projects: []` — is refused, and not on taste: it re-creates the ambiguity this spec
exists to remove. If two sprints both list `OBA`, *"the active sprint for OBA"* has two candidate
rows again and `active` needs a tie-break rule, which is the same defect one indirection later.

A genuinely cross-project sprint is modelled as **two sprints that share a window**, which is
exactly what S3 and S4 already are.

**Stated as this spec's inference, not the operator's instruction.** The operator has never asked
for a cross-project sprint and has never created one in five attempts, so the measurement supports
single-valued; but no ruling exists, and a later decision to allow one would change §2.1 and
nothing else.

### 2.2 Migration — from membership, never from the name

`project` is derived for the five existing sprints from **the project of the tickets tagged to
them**, which is unambiguous because §1.1 measured every sprint as single-project:

| Sprint | Tagged tickets | Derived `project` |
|---|---|---|
| S1 | 16, all `OBA` | `OBA` |
| S2 | 11, all `OBA` | `OBA` |
| S3 | 27, all `INF` | `INF` |
| S4 | 6, all `OBA` | `OBA` |
| S5 | 20, all `OBA` | `OBA` |

**A sprint whose tagged tickets span two projects, or which has no tagged tickets, is not
migrated — it is reported and the operator resolves it.** Zero such sprints exist today, so the
branch is defensive; it is specified because the migration is a one-time write and a machine that
guesses a project is wrong silently. This is the same rule BLZ-360 §5.5 applies to the 124
undecidable mutual pairs, for the same reason.

**The legacy scalar `active` is migrated, not dropped.** `"active": "S2"` becomes
`{ "OBA": "S2" }`, taking the key from S2's own derived project. `loadSprints` accepts both shapes
for one config-schema version and normalises the scalar on read, so a board that never re-saves
its registry keeps working — the guarantee BLZ-354 §6.1 gives `blaze.config.json` and the same
one applies here. It is then retired through `REMOVED_KEYS` in `scripts/model/schema-version.mjs`,
the mechanism BLZ-298 built for exactly this, with a message naming the replacement:

```
active: "a scalar `active` is now per-project — use { \"<PROJECT>\": \"<SPRINT_ID>\" }.
         Yours was migrated at the per-project cutover; delete this form."
```

### 2.3 Validation

`validateSprintFields` (`sprints.mjs:37-51`) already refuses a `sprint` value absent from the
registry and validates ISO dates and `start > end`. Three rules are added, all decidable from the
item alone and therefore write-time blocks per BLZ-354 §5.3:

| Rule | Refusal |
|---|---|
| a sprint's `project` names a project that does not exist | names the key and lists the 11 that do |
| a ticket's `sprint` names a sprint owned by a **different** project than the ticket | *"BLZ-364 is in project BLZ; sprint S5 belongs to OBA"* |
| `active[K]` names a sprint whose `project` is not `K` | names both |

The second is the one with teeth, and it is currently unenforceable: **0 tickets violate it
today** (every tagged ticket is in its sprint's project, by §1.1's construction), so it ships with
no backlog. That zero is a measurement, not a prediction — and it is deliberately *not* used to
argue the rule should be hard on day one, because BLZ-353 shipped a hard gate on a predicted zero
that turned out to be a definition error. It is a write-time block on **new** writes, which is a
narrower claim than a corpus-wide gate and needs no migration.

---

## 3. Capacity — the obvious denominator is wrong by 3.97×

### 3.1 What BLZ-360 hands over

> *"`schedule.minutes_per_day` (default `480`) … is the single conversion between
> `estimate_minutes` and calendar arithmetic, and it is also spec 2's capacity unit — one number,
> two consumers, no second definition."* — BLZ-360 §2.3

That is the right rule for *the scheduler*, and this spec keeps it: `minutes_per_day` stays one
number with one definition, and §4 uses it. **What this spec refuses is the inference that
`working_days × minutes_per_day` is a sprint's capacity.**

### 3.2 The measurement

Over the transitions log's own span — **2026-07-16 → 2026-08-22, 38 calendar days, 27 working
days** — the board closed:

| | Value | Against a 1-person capacity of 27 × 480 = **12,960 min** |
|---|---|---|
| Distinct tickets reaching a terminal status | **399** | |
| Sum of their `estimate` | **51,470 min** | **3.97×** |
| Sum of their `worklog` | **40,669 min** | **3.14×** |

**Both measures exceed the denominator, and they agree with each other within 26%.** That
matters: `estimate` could be inflated, but `worklog` is separately recorded actual effort, and it
says the same thing. The board records **roughly four workers' worth** of throughput.

The per-sprint view says it too. Throughput inside each sprint's window, board-wide, against that
window's one-person capacity: **S1 7.38×, S2 3.14×, S3 3.80×, S4 3.95×, S5 3.93×.**

**The explanation is not a mystery and it is the point:** this is an agent-driven board — the
product it tracks is a tool for dispatching agents (ADR-0020, BLZ-345) — so work happens in
parallel and a human workday is not the unit of supply.

### 3.3 What that rules out

**A sprint board that draws a capacity bar at `working_days × 480` would show every sprint on this
board as 300–700% over-committed.** `scripts/model/audit.mjs`'s own header names the failure
mode: *"a gate that fails on the fill queue is a gate people learn to skip, which costs the hard
findings too."* A capacity bar that is always red is that gate with a progress bar drawn on it.

Three responses were considered:

| Option | Refused / taken |
|---|---|
| Add a `team_size` multiplier to board config | **Refused.** It makes the number configurable rather than correct — and BLZ-360's roll-up section already names the standard: *"a number you have to configure to be correct is not a number you can trust"* (`hierarchy-rollup.mjs:8-9`). It also has no natural value: measured, this board has **2 distinct assignees, one of which is `unassigned`** (2,531 of 2,613 tickets), so nothing in the corpus supplies the integer. |
| Derive capacity from assignees | **Refused, and it is the trap.** **521 of 533 schedulable tickets (97.7%) are unassigned.** An assignee-derived denominator computes a capacity of approximately zero and reports infinite over-commitment. |
| **Forecast from measured velocity** | **Taken.** §3.4. |

### 3.4 Velocity is measured, and it is the forecast

**A sprint's commitment is compared to the median of the last N sprints' completed work, not to a
theoretical supply.** That is what a velocity-based agile practice does, it needs no denominator
this board cannot supply, and every input already exists.

Velocity for sprint `S` = the sum of `estimate_minutes` over tickets that (a) carry `sprint = S`
and (b) reached a terminal status inside `[S.start, S.end]`, read from
`.blaze/transitions.json` — the same log `metricsModel` already consumes (`views/page.mjs:51`).

Measured, and reported here with its problems rather than as a clean series:

| Sprint | Tagged | Committed est. (min) | Closed **in window**, tagged | Velocity (min) |
|---|---|---|---|---|
| S1 | 16 | 1,845 | 9 | **1,485** |
| S2 | 11 | 615 | 5 | **180** |
| S3 | 27 | 1,655 | **0** | **0** |
| S4 | 6 | 540 | 6 | **540** |
| S5 | 20 | 1,955 | 9 | **1,070** |

**Three honest problems with this series, all measured:**

1. **S3's velocity is zero and its tickets were not abandoned.** 14 of its 27 tickets are terminal
   today; none of them transitioned inside the window. Work tagged to a sprint routinely closes
   after it ends, so a strict in-window rule under-reports.
2. **20.6% of all terminal arrivals (83 of 402) fall outside every sprint window.** Sprint-shaped
   accounting misses a fifth of the board's completions outright.
3. **The transitions log covers 16% of the corpus** — 417 distinct ticket ids of 2,613, starting
   2026-07-16. Velocity is computable only from that date forward, and any figure quoted over a
   longer window is wrong.

**So velocity ships with its denominator stated, not as a bare number.** The sprint board renders
*"velocity: median 540 min over 5 sprints (S3 = 0; 3 of 5 sprints closed work after their
window)"* rather than *"velocity: 540"*. **A number whose caveat is not on screen with it is a
number that will be quoted without the caveat.**

**And capacity is not drawn at all in v1.** Named as a gap in §9, not filled with a figure that
measurement says is wrong by 3.97×.

---

## 4. The sprint-vs-schedule conflict, split in two

BLZ-360 §8.1 hands this over, flagging it as unmeasured:

> *"sprint membership is a grouping, not a scheduling constraint. The scheduler does not treat
> `sprint: S3` as a date window… The consequence is a real and visible one — a ticket can sit in
> sprint S3 with a derived start after S3 ends — and it is surfaced as spec 2's own finding, not
> silently reconciled. **This is a judgement call with no measurement behind it.**"*

**Measured, the consequence is total: 26 of 26.** Every schedulable sprint-tagged ticket sits in a
sprint that ended before `project_epoch`, so under the kernel's rules every one of them gets a
derived start after its sprint's end.

**Raising one finding for all 26 would be a defect**, because they are not all the same fact. Two
kinds, split on whether the sprint is over:

**The split has to be total over sprint-tagged tickets, or it has the hole spec 3's bar
vocabulary had.** Enumerated by (is the sprint over?) × (is the ticket open?) × (does the schedule
fit?), every case has a stated outcome:

| Sprint | Ticket | Schedule | Outcome | Count today |
|---|---|---|---|---|
| **ended** | open | — | `sprint-overrun` | **26** |
| **ended** | terminal | — | no finding — it is history | 54 |
| **current** | open | derived start > `sprint.end` | `sprint-window-missed` | **0** |
| **current** | open | derived start ≤ `sprint.end` | no finding | **0** |
| **current** | terminal | — | no finding | **0** |
| **future** | any | — | no finding — nothing is late yet | **0** |

The `current` and `future` rows are all zero **because all five sprint windows ended before
2026-08-24** (§1.2), not because those cases cannot occur. So `sprint-window-missed` — the finding
BLZ-360 §8.1 actually asked for — ships with **no corpus row exercising it**, and must be tested
against a synthetic sprint whose window contains `now`. Saying so is the point: it is the same
position spec 3's `unscheduled` is in, and the same weaker guarantee.

`sprint-overrun` says *"this sprint is finished and this ticket did not make it"* — a statement
about the past, actionable by re-tagging or closing. `sprint-window-missed` says *"this ticket is
committed to a live sprint the schedule says it cannot make"* — a statement about the plan,
actionable by moving the commitment. Collapsing them produces 26 findings that all mean the first
thing while being named as if they meant the second.

Both are **soft**, by `audit.mjs:29-46`'s test: the corpus is not wrong in either case. And
`sprint-overrun` is rendered **grouped with a count**, per spec 3 §8's rule — *"26 tickets remain
open in sprints that have ended (S2: 2, S3: 13, S5: 11)"* — because 26 individual rows on first
open is the same noise problem in a different colour.

**Neither finding moves anything.** The kernel's rule that sprint membership is a grouping stands
untouched; these are reports about a disagreement, not a reconciliation of it.

---

## 5. The sprint board is not a new view type

BLZ-354 §8.1 already expressed it as a `board` row and this spec confirms it, which is the
falsification test passing rather than being satisfied:

```
scope='project'  project_key='OBA'  type='board'
name='S5 sprint'  slug='s5'
config: { sprint: 'S5', statusFilter: 'active', columnSet: 'delivery',
          swimlaneBy: 'assignee', types: ['task','bug','story'] }
```

**No `report`-shaped hole here** — unlike spec 4, this reuses `views/board.mjs`, which exists. The
registry entry for `board` gains `sprint` alongside spec 1 §5.2's proposed `columnSet`,
`swimlaneBy` and `cardFields`.

**One key is refused rather than added.** `swimlaneBy: 'assignee'` is in the example above because
spec 1 proposed it, and it is **useless on this board**: 2,531 of 2,613 tickets are `unassigned`,
so an assignee swimlane renders one lane holding 96.9% of the cards and a second holding the rest.
It ships because it is right for a board that assigns work and costs nothing when unused — but
**the default is `swimlaneBy: 'none'`**, and defaulting it to `'assignee'` would give every new
sprint board a degenerate layout on this corpus. Measured, not assumed.

---

## 6. What changes

| File | Change |
|---|---|
| `scripts/model/sprints.mjs` | `loadSprints` normalises a scalar `active` → per-project map; new `activeFor(registry, project)`; `addSprint` requires `project`; `setActive(registry, project, id)`; `validateSprintFields` gains §2.3's rules; `formatSprintList` (`:79-85`) prints the project and marks active per project |
| `scripts/sprint-runner.mjs` | `blaze sprint new --project KEY`; `blaze sprint active --project KEY <id>`; `blaze sprint list [--project KEY]` |
| `scripts/model/gantt.mjs` | `:33` reads `activeFor(sprints, project)` rather than `sprints.active` |
| `scripts/model/schema-version.mjs` | `REMOVED_KEYS` entry for the scalar `active` (§2.2) |
| new — `scripts/model/velocity.mjs` | pure; `(sprints, index, transitions, now) → per-sprint velocity + its caveats`. `now` injected, no `Date.now()`, following `metrics.mjs:9-10` |

### 6.1 The blast radius, measured — and it changed a design decision

**Spec 3's §9 was wrong about its test cost twice, in both cases by reasoning about the change
instead of grepping for it. So this section greps first.**

**Production callers of `loadSprints` — 7 call sites across 5 files, and only 3 are affected:**

| Call site | Reads | Affected |
|---|---|---|
| `edit.mjs:70` | `const { sprints } = …` | **no** |
| `new.mjs:83` | `const { sprints } = …` | **no** |
| `model/index.mjs:230` | `… .sprints` | **no** |
| `views/page.mjs:62` | passes the whole registry to `ganttModel`, which reads `.active` at `gantt.mjs:33` | **yes** |
| `sprint-runner.mjs:42`, `:52`, `:62` | reads `.active` | **yes** |

**Four of seven call sites read only `.sprints` and do not change at all.** That is a fact about
the seam rather than luck: `ADR-0004` made sprints data read per render, and the `active` pointer
is used by exactly the two surfaces that need to *pick* a sprint.

**Test fixtures carrying a scalar `active` — 7 files, not one:**
`tests/model/sprints.test.mjs` (26 occurrences), `tests/model/gantt.test.mjs:20`, `:30`,
`tests/views/gantt.test.mjs:11`, `:93`, `tests/views/page.test.mjs:118`, `tests/new.test.mjs:124`,
`tests/edit.test.mjs:96`.

**This measurement is why `activeFor(registry, project)` exists.** The first draft of §2.1 had
`ganttModel` read `sprints.active` directly and normalise inside `loadSprints`. But **five of the
seven fixture files construct a registry literal and hand it straight to `ganttModel`, bypassing
`loadSprints` entirely** — so normalising on read would leave those five fixtures feeding an
un-normalised scalar into a reader expecting a map, and `gantt.mjs:36`'s
`list.find(s => s.id === active)` would silently fall through to `list[0]`. **A silent fallback to
the wrong sprint is exactly the class of defect this board has been bitten by**, so the accessor
takes both shapes and is the single normalisation point:

```js
export function activeFor(registry, project) {
  const a = registry.active;
  if (a == null) return null;
  return typeof a === "string" ? a : (a[project] ?? null);   // legacy scalar | per-project map
}
```

With it, **only `tests/model/sprints.test.mjs` must change**; the other six fixture files keep
working unchanged. That is the design's justification, and it was produced by the grep rather than
recovered from a review.

### 6.2 What must be rewritten in `sprints.test.mjs`

Of its **28** tests, classified by opening the file rather than by inference:

| Tests | Why they change |
|---|---|
| `:13`, `:19` — `loadSprints` degrades to empty | assert `{ active: null, … }`; the empty registry's `active` becomes `{}` |
| `:26`, `:34` — reads a registry / round-trips | assert the scalar survives `loadSprints` |
| `:151`, `:159`, `:167`, `:172`, `:183`, `:190` — `addSprint` ×6 | `project` becomes required |
| `:195`, `:202` — `setActive` ×2 | the signature gains `project` |
| `:209`, `:223` — `formatSprintList` ×2 | output gains the project and per-project active markers |
| `:59`–`:83` — `validateSprintFields` ×8 | **only if** the options bag changes from `{ sprintIds }` to `{ sprints }` |

**So 16 of 28 change outright, and 8 more change only under a signature choice this spec can
avoid.** It avoids it: `validateSprintFields` keeps `{ sprintIds }` and takes the sprint registry
as an **additional optional** key, so its 8 existing tests and its 2 production callers
(`new.mjs:84`, `edit.mjs:71`) are untouched and the new §2.3 rules get their own tests.

**Final count: 16 of 28 rewritten in `sprints.test.mjs`, 0 elsewhere, 0 deleted.** Any test outside
that file that breaks is a defect in `activeFor`, not an expected cost — which makes it a check
rather than a budget.

---

## 7. Testing and mutation discipline

TDD throughout. Mutations, each of which must break at least one test:

1. Migrate a sprint's `project` from the first token of its `name` instead of from ticket
   membership (§2.2 — this is the one that is right 4 times in 5).
2. Migrate a sprint whose tagged tickets span two projects instead of reporting it.
3. Drop the scalar-`active` normalisation so a legacy registry loads with `active: null`.
4. Let `active[K]` name a sprint owned by a project other than `K`.
5. Compute velocity over all closed tickets rather than only those tagged to the sprint.
6. Compute velocity without the in-window restriction (S3 goes from 0 to non-zero).
7. Report velocity as a bare number without its caveat line (§3.4).
8. Raise `sprint-window-missed` for a sprint that has already ended (§4 — collapses the 26/0
   split).
9. Draw a capacity bar at `working_days × minutes_per_day` (§3.3).
10. Default `swimlaneBy` to `'assignee'` (§5).
11. Make `activeFor` reject a legacy scalar `active` instead of accepting both shapes (§6.1 — this
    is the mutation that catches the silent `list[0]` fallback, and it must break a test that
    feeds a scalar registry straight to `ganttModel`, not only one that goes through
    `loadSprints`).
12. Raise no finding at all when a sprint is **current** and the derived start is after its end
    (§4 — the row with zero corpus members).

**Any mutation that survives is named in the PR body as a hole in the suite**, not quietly fixed.
**Mutations 11 and 12 have no corpus row behind them** — 12 because every sprint has ended, 11
because the legacy scalar is what exists today and the map does not yet. Both need synthetic
fixtures, and that is a weaker guarantee than the other ten get.

Fixtures from the corpus: the S3/S4/S5 three-way overlap; `S2`'s name (`"OBA-1 re-baseline…"`,
the one that defeats name-parsing); S3's 27 tagged tickets with zero in-window closures; and the
stale `active: "S2"` pointer itself.

---

## 8. Constraints honoured

| Constraint | How |
|---|---|
| **ADR-0004 — sprints are data, re-read per render** | Unchanged. `sprints.json` stays at the data root and stays read per render (`sprints.mjs:1-3`). The shape changes; the seam does not. |
| **ADR-0011 — no new required runtime dependency** | Nothing added. Velocity is a pure reduce over two arrays. |
| **ADR-0014 — no board or tenant discriminator** | `project` is not one: it names a project inside one installation, the same way `ticket.project` already does. |
| **ADR-0018 — hybrid custom fields** | No new ticket column. `sprint` stays the existing frontmatter field. |
| **BLZ-360 §2.3 — one `minutes_per_day`** | Honoured literally: it stays one number with one definition, used for schedule arithmetic. §3 declines to *also* call it capacity, which is not a second definition — it is one fewer. |

---

## 9. What this spec does NOT solve

- **Capacity.** §3 measures the obvious denominator wrong by 3.97× and ships velocity instead. A
  real capacity model needs a supply number this board does not contain. **This is the largest
  honest gap.**
- **Burndown.** Needs a daily remaining-work series; the transitions log covers 16% of the corpus
  and starts 2026-07-16, so a burndown before that date is undrawable. Deferred with its reason.
- **Sprint close-out as an event.** No ceremony, no carry-over gesture, no "move unfinished to the
  next sprint" command. §4 reports the 26 overruns; it does not offer to fix them.
- **Cross-project sprints.** §2.1 refuses them on measurement; a later ruling would reopen it.
- **Per-person capacity or assignment.** 2 distinct assignees exist, one of them `unassigned`.
- **Reconciling sprint membership with the schedule.** BLZ-360 §8.1's rule stands; §4 reports.
- **Sprint templates, cadence, or auto-creation.** All five sprints were hand-created with
  irregular windows — 4, 3, 6, 5 and 9 working days — and nothing suggests a cadence to automate.

---

## 10. Open questions

1. **Should a sprint's window be working-day-aligned?** Measured, **S2 starts on a Sunday, S3 ends
   on a Sunday, and S5 ends on a Saturday**, and the registry has no opinion. It makes
   `working_days` (4, 3, 6, 5, 9 for S1–S5) differ from calendar span (6, 4, 10, 7, 12) by up to
   4 days. Whether to warn, refuse, or stay silent is not decided.
2. **Does velocity count `estimate` or `worklog`?** §3.4 uses `estimate`, because 73.7% of
   schedulable tickets carry one and it is what a commitment is denominated in. But **worklog is
   the better-calibrated series** — measured over 1,244 terminal tickets carrying both, the median
   `worklog / estimate` ratio is **1.00** and the mean **0.97**, with only 21.4% over estimate.
   That calibration is good enough that the choice may not matter; it has not been tested.
3. **What is N in "the last N sprints"?** §3.4 says median-of-last-N without fixing N. Five
   sprints exist in total, so any N ≥ 5 is the whole history and any N ≤ 2 is noise.
4. **Should `sprint-overrun` auto-clear?** A ticket closed after its sprint ended is still an
   overrun by §4's definition, forever. Whether the finding is about the ticket's *current* state
   or a permanent historical fact is unresolved, and it decides whether the count ever goes down.
