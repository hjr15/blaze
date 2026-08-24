# Blaze v4 — spec 2: agile execution — a sprint belongs to a project, and capacity is the number this board can measure

**Status:** draft for review · **Date:** 2026-08-24 · **Consumer spec, BLZ-364**

Spec **2** of the six v4 subsystems and the **fourth written**, after spec 3
([`2026-08-24-gantt-and-critical-path-design.md`](2026-08-24-gantt-and-critical-path-design.md),
BLZ-363). It settles the sprint record, the per-project active pointer **BLZ-354 §8.1 named and
handed over**, what capacity means on this board, why velocity is deferred, how a sprint board is
expressed as a view, and how a sprint that disagrees with the schedule is reported.

**Two different gaps get handed to this spec by the two kernel specs and they are not the same
one:** BLZ-354 §8.1 hands over the **single global `active` pointer** (§1, §2), and BLZ-360 §8.1
hands over **sprint-membership-versus-schedule** (§4). Conflating them would lose one.

**Its inputs are the two kernel specs (BLZ-354, BLZ-360) and spec 3, and none is reopened here.**
The operator settled both kernel decisions on 2026-08-23. All three are merged: the kernel specs on 2026-08-23 and
spec 3 as `9beb7e8` (PR #104).

Every number was measured against the live board on 2026-08-24 — **2,613 tickets, 11 projects, 5
sprints, 499 transitions** — by running the measurement, not by citing one.

---

## 0. The two decisions

> **1. A sprint belongs to exactly one project, and `active` becomes a per-project pointer.**
>
> **2. The sprint board draws a capacity bar at `working_days × minutes_per_day`. Velocity is
> deferred, because the transitions log records when the board was written, not when work
> happened.**

The first was named as a gap by BLZ-354 §8.1 and left unaddressed. The second is this spec's, and
§3 is the measurement that forces it — **after an earlier draft of §3 forced the opposite
conclusion from the wrong population.** That reversal is recorded in place rather than tidied
away.

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

That last detail matters for §2.2: **the name is not a reliable source of the project.** `S2`'s
name begins `"OBA-1 re-baseline"`, where `OBA-1` is a ticket id, not the project key `OBA`.

**Stated precisely, because an earlier draft overstated it.** That draft said name-parsing would be
*"right four times out of five and silently wrong once, which is the worst available ratio"*. It
would not be silently wrong: a first-token split yields `"OBA-1"`, which is **not a project key**,
so the migration would **refuse it loudly** — and a parser that also split on `-` would get `OBA`,
S2's **correct** project. No realistic parse assigns S2 a wrong project. The real argument needs no
rhetoric: **ticket membership is measured and exact, and a sprint name is a display string nobody
promised would parse.**

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

### 2.1 `project` is required on new sprints and single-valued

```jsonc
{
  "active": "S5",                                  // KEPT — installation-wide, legacy readers use it
  "activeByProject": { "OBA": "S5", "INF": "S3" }, // NEW — per project; a project may be absent
  "sprints": [
    { "id": "S5", "project": "OBA", "name": "…", "start": "2026-08-11", "end": "2026-08-22" }
  ]
}
```

**`active` is kept as a scalar and `activeByProject` is added beside it. An earlier draft replaced
`active` with the map, and that fails ADR-0004's own test.** ADR-0004 asks *"would an older engine
**silently misread** a board written by a newer one"* — and it would: `gantt.mjs:36`'s
`list.find(s => s.id === active)` cannot match an object, so it falls to `list[0]` and renders the
wrong sprint with no error. Adding a key instead is invisible to an older engine. Verified by
running the **unchanged** engine against the new shape:

```
unchanged ganttModel, registry carrying active:"S2" + activeByProject + per-sprint project
  → selected S2, 11 rows          — byte-identical to today
```

So `SCHEMA_VERSION` stays where it is, which matters more than an earlier draft realised: **it is
already 2** (`schema-version.mjs:17`), not 1, so that draft's conclusion — *"a prerequisite for
keeping `SCHEMA_VERSION` at 1"* — described a state that has not existed since BLZ-298. Its
reasoning was circular besides: a *deployed older engine* still contains its own `|| list[0]`, and
no edit in this repository can change what that engine does.

**The additive shape protects an older *reader*. It does not protect an older *writer*, and §2.2
measures exactly what that costs.** An earlier draft of this paragraph claimed `setActive`
(`sprints.mjs:76`) *"preserves `activeByProject` untouched"* — false, because `loadSprints` drops
the key one frame earlier, so an old `blaze sprint active` writes it back out of existence. That
correction landed in §2.2 and this paragraph was left standing, which is the fourth time in this
spec's review history that a fix stopped one section short of a claim it refutes.

**`project` is required on every *newly written* sprint, tolerated absent on legacy ones (§2.2),
and holds exactly one key.** The alternative — a multi-valued `projects: []` — is refused, and not on taste: it re-creates the ambiguity this spec
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

**`loadSprints` does NOT normalise — but it does have to change, and an earlier draft said it
would not.** Two separate points, and conflating them is what made that draft unimplementable.

**It must not normalise.** Turning `active: "S2"` into `{ OBA: "S2" }` requires knowing S2's
project, and **a legacy registry does not carry one** — `sprints.json` today is
`{id,name,start,end}` and nothing else, the shape `tests/model/sprints.test.mjs:125` writes. The
key is derivable only from ticket membership, a corpus query `loadSprints` has no index to run.

**It must still change, because it is a whitelist rather than a passthrough.**
`sprints.mjs:14` is `return { active: parsed.active ?? null, sprints: parsed.sprints }` — a
*reconstruction*. Measured against a migrated file:

```
file keys BEFORE : [ active, activeByProject, sprints ]
loadSprints keys : [ active, sprints ]        ← activeByProject never reaches a reader
```

So an earlier draft's *"`loadSprints` returns the file as-is"* and §6's *"`loadSprints` is
unchanged"* would have made `activeByProject` **dead on arrival**: `views/page.mjs:62` is the only
path to `ganttModel`, it gets its registry from `loadSprints`, and `activeFor` would fall through
to the scalar on every board forever. The change is one key wide — `activeByProject:
parsed.activeByProject ?? null` — and it is not optional.

**And the additive shape protects readers, not writers. That has to be said plainly because an
earlier draft claimed the opposite.** It argued an older `setActive` *"preserves `activeByProject`
untouched"*. It does not, and the reason is the same whitelist one frame earlier — `sprint-runner`
is `loadSprints → setActive → saveSprints`, so the key is dropped on read and never written back:

```
file keys BEFORE : [ active, activeByProject, sprints ]
file keys AFTER  : [ active, sprints ]        ← one `blaze sprint active` from an OLD engine
per-sprint project survives: OBA
```

**One `blaze sprint new` or `blaze sprint active` from an unmodified engine silently deletes every
project's pointer**, and an earlier draft called that *"repairable without the index"*. **It is
not, and the reason is this spec's own §1.2.** `activeByProject` is **not derivable from
anything**: ticket membership yields sprint → project, never project → *which* sprint is active,
and §1.2 already proves dates cannot supply it — *"S4 and S5 are both OBA and both live … an
explicit pointer is still required."* The scalar `active` names at most one project's. So it is
**operator-entered state**, and an old writer destroys it permanently.

What survives is narrower and still worth having: the per-sprint `project` fields, because
`sprints:` passes through wholesale. So `blaze sprint migrate` is idempotent for `project`, and on
a re-run it **re-seeds `activeByProject` with a stated default rather than reconstructing the
operator's choice** — the latest-*ending* sprint per project, which on this board gives
`{ OBA: "S5", INF: "S3" }`. That is a starting point the operator corrects, not a repair.

**Two consequences, both stated because an earlier draft left them implicit:**

- **The cost of the additive shape is real.** It buys an older reader that works and an older
  writer that loses one key of operator-entered state. §9 carries it as a gap; the alternative —
  refusing old engines outright — is a `MIN_SCHEMA_VERSION` bump this spec does not take.
- **Something must still write the scalar `active`, or it becomes dead.** `blaze sprint active
  <id>` **without** `--project` writes `active`; **with** `--project KEY` writes
  `activeByProject[KEY]`. Without that split nothing sets `active` after this spec ships, and
  §6.1's `project="all"` landing page would read `null` on a new board and the stale `"S2"` on
  this one, forever.

**`project` is required on *new* sprints and tolerated absent on old ones**, which keeps this on
the additive side of ADR-0004. That ADR's bump list includes *"making any currently-optional field
required — an old engine would happily write records a new engine rejects"*, and an old
`blaze sprint new` writes `{id,name,start,end}`. So the reader treats a sprint with no `project`
as installation-wide rather than refusing it, and §2.3's rules apply only where the field is
present. **`active` is never retired at all, and an earlier draft specified retiring it through
`REMOVED_KEYS`.** It is kept permanently as the installation-wide pointer (§2.1).

Even had it been retired, that mechanism could not have carried it. Three things rule it out, all
checkable:

1. **It reads the wrong file.** `REMOVED_KEYS` (`schema-version.mjs:30`) is consumed only by
   `checkSchemaVersion`, whose only caller is `config.mjs:56` on the parsed **`blaze.config.json`**,
   and whose error text is the hard-coded *"blaze.config.json sets a key this engine no longer
   reads"*. `sprints.json` never reaches it, so the specified message would name the wrong file.
2. **It fails BLZ-298's own entrance test**, stated in the doc comment above it: *"Each was
   accepted by `loadConfig` and **read by NOTHING** — verified by grep."* `active` is read at
   `gantt.mjs:33`, `sprints.mjs:67` and `sprints.mjs:83`. `REMOVED_KEYS` is for promises the
   software does not keep; `active` is a promise it does keep.
3. **`sprints.json` carries no version stamp at all**, so a windowed retirement is not
   expressible in it even in principle.

**ADR-0004's bump test is satisfied by §2.1's additive shape rather than argued around**, and it
was run rather than asserted: the unchanged engine reads the new registry and selects the same
sprint it selects today.

### 2.3 Validation

`validateSprintFields` (`sprints.mjs:37-51`) already refuses a `sprint` value absent from the
registry and validates ISO dates and `start > end`. Three rules are added. **All three pass both halves of the v4 spine §4.1 / ADR-0015 test —
decidable from the item alone **and** true of a legitimate draft** (an earlier draft of this
sentence quoted only the first half). **"The item" is whatever is being written**, which for rules
1 and 3 is a *sprint registry entry* rather than a ticket:

| Rule | Refusal |
|---|---|
| a sprint's `project` names a project that does not exist | names the key and lists the 11 that do |
| a ticket's `sprint` names a sprint owned by a **different** project than the ticket | *"BLZ-364 is in project BLZ; sprint S5 belongs to OBA"* — the only ticket-write rule of the three, and the reason §6.2 changes `validateSprintFields`'s options bag from `{ sprintIds }` to `{ sprints }`: a `Set` of ids cannot carry each sprint's project |
| `activeByProject[K]` names a sprint whose `project` is not `K` | names both |

The second is the one with teeth, and it is currently unenforceable: **0 tickets violate it
today** (every tagged ticket is in its sprint's project, by §1.1's construction), so it ships with
no backlog. That zero is a measurement, not a prediction — and it is deliberately *not* used to
argue the rule should be hard on day one, because BLZ-353 shipped a hard gate on a predicted zero
that turned out to be a definition error. It is a write-time block on **new** writes, which is a
narrower claim than a corpus-wide gate and needs no migration.

---

## 3. Capacity works. Velocity is what this board cannot yet measure.

**This section reverses an earlier draft of itself, and the reversal is the most useful thing in
this spec.** That draft claimed capacity was wrong by 3.97× and shipped velocity instead. It had
compared **board-wide throughput** against **one sprint's capacity** — two different populations —
and the number that actually answers the question was in the same measurement run, unused.

### 3.1 What BLZ-360 hands over

> *"`schedule.minutes_per_day` (default `480`) … is the single conversion between
> `estimate_minutes` and calendar arithmetic, and it is also spec 2's capacity unit — one number,
> two consumers, no second definition."* — BLZ-360 §2.3

BLZ-360 §8.1 is titled *"Spec 2 — sprint capacity: **served**"*. This spec agrees, and §3.2 is
why. **`minutes_per_day`'s second consumer is §3.2's capacity bar.** An earlier draft removed that
consumer and its §8 row then read *"Honoured literally … §3 declines to also call it capacity,
which is not a second definition — it is one fewer"* — which disclosed the loss rather than hiding
it, but left BLZ-360 §8.1's *"sprint capacity: served"* unserved.

### 3.2 Sprint commitment against a one-person capacity — the measurement that decides it

A capacity bar plots **that sprint's committed estimate** against **that sprint's capacity**.
Measured, with working days counted Mon–Fri inside each window:

| Sprint | Committed | Working days | Capacity @480 | Ratio |
|---|---|---|---|---|
| S1 | 1,845 | 4 | 1,920 | **0.96** |
| S2 | 615 | 3 | 1,440 | 0.43 |
| S3 | 1,655 | 6 | 2,880 | 0.57 |
| S4 | 540 | 5 | 2,400 | 0.23 |
| S5 | 1,955 | 9 | 4,320 | 0.45 |

**Every sprint is under capacity, and none has ever exceeded it.** S1 at **0.96** is almost exactly
one person-week, which is the strongest evidence available that `minutes_per_day = 480` with a
team of one is the operator's own implicit model — not an assumption this spec imposes.

**So the capacity bar ships**, at `working_days × schedule.minutes_per_day`, with the team size
left at 1 and no configuration knob. It is BLZ-360's one number with one definition and a second
consumer, exactly as §2.3 asks.

### 3.3 The board-wide 3.97× is real, and it does not mean what it looks like

Over the transitions log's own span — 2026-07-16 → 2026-08-22, 38 calendar days, **27 working
days** — the board closed **399 distinct tickets, 51,470 estimate-minutes and 40,669 logged
minutes** against a one-person capacity of **12,960**: **3.97×** and **3.14×**.

**The arithmetic is right and the inference an earlier draft drew from it — "roughly four workers'
worth of throughput" — does not follow.** Measured:

- The 402 terminal-arrival events occupy **62 distinct timestamps**.
- **346 of 402 (86%) arrive in identical-timestamp batches of five or more** — the largest are 38,
  35, 29, 28, 19 and 18 tickets sharing one instant.

Those are **bulk board writes**, not execution. A transition's `ts` records when the board was
reconciled, not when the work happened, so the ratio measures write batching and cannot be read as
parallelism. **Nothing in this spec now rests on it**, and it is kept only because the earlier
draft's conclusion was built on it and a reader deserves to know why that conclusion is gone.

The honest statement the two measurements support together is narrower and still worth having:
**sprint-tagged work is a small, comfortably-loaded slice of a board that closes far more than it
tracks in sprints** — 80 of 2,613 tickets carry a sprint at all (§1.1).

### 3.4 Velocity is deferred, because the log does not record when work happened

An earlier draft made velocity the forecast. **The transitions log cannot support it**, and the
per-sprint measurement is unambiguous. For each sprint's tagged tickets, classifying the latest
terminal arrival against the sprint window:

| Sprint | Tagged | In window | **After end** | **Before start** | **No record at all** |
|---|---|---|---|---|---|
| S1 | 16 | 9 | 0 | 0 | 7 |
| S2 | 11 | 5 | 0 | 0 | 6 |
| S3 | 27 | **0** | 0 | **8** | **19** |
| S4 | 6 | 6 | 0 | 0 | 0 |
| S5 | 20 | 9 | 0 | 0 | 11 |

**Three things follow, and the first two contradict what the earlier draft asserted:**

1. **Zero of five sprints closed tagged work after their window.** The earlier draft said *"3 of 5
   sprints closed work after their window"* and built problem 1 — *"work tagged to a sprint
   routinely closes after it ends"* — on it. Not one sprint-tagged ticket on this board did.
2. **S3's zero velocity is not late closure.** Of its 27 tagged tickets, **8 reached a terminal
   status *before* the sprint began** and **19 have no terminal transition on record at all**.
   That is retroactive tagging of already-finished work plus missing history — a different defect
   with a different fix, and relaxing the in-window rule recovers none of it.
3. **43 of the 80 sprint-tagged tickets (54%) have no terminal record**, against a log covering
   **417 of 2,613 ids (16%)** and starting 2026-07-16.

**So velocity is not computed in v1.** A number derived from a batch-written, 16%-complete log
would be presented as a measurement of throughput while measuring the reconcile cadence. §9 carries
it as the gap it is, and the condition to revisit is stated rather than left open: **a transitions
log whose terminal arrivals are not dominated by batch timestamps** — today 86% of them are.

## 4. The sprint-vs-schedule conflict, split in two

BLZ-360 §8.1 hands this over, flagging it as unmeasured:

> *"**One decision spec 2 inherits and may want to revisit:** sprint membership is a grouping, not
> a scheduling constraint. The scheduler does not treat `sprint: S3` as a date window. **If it did,
> sprint assignment and the dependency graph would fight, and there is no correct winner.** The
> consequence is a real and visible one — a ticket can sit in sprint S3 with a derived start after
> S3 ends — and it is surfaced as spec 2's own finding, not silently reconciled. **This is a
> judgement call with no measurement behind it.**"*

Quoted in full because an earlier draft's ellipsis removed both the reason (*"there is no correct
winner"*) and the framing (*"may want to revisit"*), presenting an explicitly reopenable ruling as
settled. **This spec does not revisit it** — §4 reports the disagreement and reconciles nothing —
but the option was BLZ-360's to offer and is not this spec's to quietly close.

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

**Four cases fall outside that table and each needs a stated outcome, because a classification
claimed total with a hole in it is this programme's most repeated defect:**

| Case | Outcome | Count today |
|---|---|---|
| A ticket whose `sprint` is **not in the registry** | **No sprint finding.** `buildIndex` already emits *"sprint 'X' not in registry"* as a **warning, never an error** (`index.mjs`, tested at `sprints.test.mjs:119`), and that stays the only report. There is no window to call ended or current. | **0** |
| An open ticket in a **current** sprint with **no derived start** (spec 3's `unscheduled`) | No finding — neither `> sprint.end` nor `≤ sprint.end` holds, and inventing one would report a schedule that does not exist. | **0** (spec 3 §4.2 measures `unscheduled` at 0) |
| `sprint.end === today` | **Current, not ended.** A sprint is over the day *after* its end date. Stated because "ended" was otherwise undefined on the boundary. | **0** |
| A **non-delivery** ticket carrying a sprint | No finding. `gantt.mjs:63` already drops non-delivery rows into `warnings`, and a schedule comparison is meaningless for a type with no derived dates. | **0** |

All four are zero today, so all four are **defensive and untested against corpus data** — the same
weaker guarantee §7's mutations 11 and 12 carry.

The `current` and `future` rows are all zero **because all five sprint windows ended before
2026-08-24** (§1.1), not because those cases cannot occur. So `sprint-window-missed` — the finding
BLZ-360 §8.1 actually asked for — ships with **no corpus row exercising it**, and must be tested
against a synthetic sprint whose window contains `now`. Saying so is the point: it is the same
position spec 3's `unscheduled` is in, and the same weaker guarantee.

`sprint-overrun` says *"this sprint is finished and this ticket did not make it"* — a statement
about the past, actionable by re-tagging or closing. `sprint-window-missed` says *"this ticket is
committed to a live sprint the schedule says it cannot make"* — a statement about the plan,
actionable by moving the commitment. Collapsing them produces 26 findings that all mean the first
thing while being named as if they meant the second.

Both are **soft**, by `audit.mjs:9-13`'s test — *"HARD — the corpus is WRONG … SOFT — a FILL
QUEUE"* — because the corpus is not wrong in either case. (`:29-46` is the BLZ-353 comment that
§2.3 cites for a different purpose; an earlier draft used it for both.) And
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

**One key ships with a deliberately different default.** `swimlaneBy: 'assignee'` is in the example
above because spec 1 proposed it, and it is **useless on this board** — but the figure that shows
that is not the board-wide one. A swimlane partitions *the sprint board's* cards, and measured,
**80 of 80 sprint-tagged tickets are `unassigned`: 100%, across all five sprints.** An assignee
swimlane renders exactly one lane. *(An earlier draft cited the board-wide 2,531 of 2,613 = 96.9%
and described "a second lane holding the rest". On a sprint board there is no second lane.)*
It ships because it is right for a board that assigns work and costs nothing when unused — but
**the default is `swimlaneBy: 'none'`**, and defaulting it to `'assignee'` would give every new
sprint board a degenerate layout on this corpus. Measured, not assumed.

---

## 6. What changes

**This table was byte-identical to the pre-reversal draft until review caught it.** It still
listed a `velocity.mjs` §3.4 defers, a `REMOVED_KEYS` entry §2.2 refutes, and **no row for the
capacity bar §3 actually ships** — so an implementer working from §6 would have built the deferred
feature, added the refuted config entry, and shipped nothing that renders §3.2. Corrected:

| File | Change |
|---|---|
| `scripts/model/sprints.mjs` | **`loadSprints` passes `activeByProject` through** — it is a whitelist today and would otherwise drop it (§2.2); it still does **not** normalise. New `activeFor(registry, project)` (§6.1). `addSprint` requires `project` on new sprints and auto-activates **per project** — `activeByProject[project] ?? id`, not today's global `registry.active ?? id` (`:67`), or a new project's first sprint is born inactive. `setActive(registry, project, id)` writes `activeByProject[project]` when `project` is a key and the scalar `active` when it is `null` — the two-target split §2.2 requires; a signature that always writes the map leaves `active` unwritable. `validateSprintFields`'s bag becomes `{ sprints }` for §2.3 rule 2. `formatSprintList` (`:79-85`) prints the project and marks active per project |
| new — `scripts/model/capacity.mjs` | pure; `(sprint, rows, { minutesPerDay, workingDays }) → { committed, workingDays, capacity, ratio }`. **Both come from board config, not from constants** — BLZ-360 §2.3 defines `schedule.minutes_per_day` **and** `schedule.working_days`, and hardcoding Mon–Fri would be the second definition §8 claims not to create. `now` is not an input, so it needs no injection |
| new — findings, in `scripts/model/audit.mjs`'s shape | `sprint-overrun` and `sprint-window-missed` (§4). **Neither exists** — `grep -rn "sprint-overrun\|sprint-window-missed" scripts/ tests/` returns nothing — and an earlier version of this table had no row for them at all, while §4 specifies 26 live corpus findings. `sprint-overrun` needs no scheduler and is buildable today |
| `scripts/views/data.mjs` | `boardModel` (`:24`) takes `{ project, focus, flat, index }` and has **no sprint parameter and no sprint filter**. It gains one, plus the sprint-scoped rows and **both** config values `capacity.mjs` needs — `schedule.minutes_per_day` **and** `schedule.working_days`. An earlier version named only the first, one row after the `capacity.mjs` row had gained the second |
| `scripts/views/page.mjs` | `renderView`'s `board` case (`:49`) is `board.render(m)` — the model only, no view config and no sprint registry. It gains both, the same way the `gantt` case already receives `sprints` at `:62` |
| `scripts/views/board.mjs` | renders the capacity bar when the view's config carries a `sprint` (§3.2, §5) |
| — | **Blocked on spec 1 (BLZ-354).** `columnSet`, `swimlaneBy` and `cardFields` (§5) appear **nowhere** in `scripts/` — the view-config registry is BLZ-354's unshipped deliverable, and a sprint board cannot read a `sprint` key from a config that does not exist yet. §5 is expressible; it is not yet buildable |
| — | **Blocked on BLZ-360 (the scheduler), and an earlier version of this table flagged only the spec-1 blocker.** `grep -ric "schedule" scripts/` returns **0**: `schedule.minutes_per_day`, `schedule.working_days`, `project_epoch` and derived ES/EF do not exist. So `capacity.mjs` has no source for its two config values, and §4's `sprint-window-missed` has no derived start to compare — which is why §4 measures it at 0 and not merely at 0-because-every-sprint-ended. **So the buildable set is exactly one thing, and it is not the capacity bar**: `sprint-overrun` (the findings row above) needs no scheduler and no view config, and ships 26 live corpus rows today. The **capacity bar is blocked on both** — on BLZ-360 for `schedule.*`, and on BLZ-354 for the view config that carries the `sprint` key it reads. An earlier version of this row named the bar as the only part buildable before the kernel ships, which contradicted the findings row four lines above it *and* the same cell's own statement that `schedule.*` does not exist |
| `scripts/model/gantt.mjs` | `:33` reads `activeFor(sprints, project)`; `:36` loses its `|| list[0]` tail and gains the `no-active-sprint` return (§6.1) |
| `scripts/sprint-runner.mjs` | `blaze sprint new --project KEY`; `blaze sprint list [--project KEY]`; **`blaze sprint active <id>` writes the scalar `active`, and `--project KEY <id>` writes `activeByProject[KEY]`** (§2.2) — without that split nothing sets `active` after this spec ships. **New `blaze sprint migrate`**: idempotent; derives `project` per sprint from ticket membership, and **seeds `activeByProject` with a default it names — the latest-*ending* sprint per project, `{ OBA: "S5", INF: "S3" }` on this board — which is a starting point the operator corrects, not a reconstruction of their choice** (§2.2: `activeByProject` is not derivable). **It does not touch `active`**, so §1.2's stale installation-wide pointer survives by design |
| — | **No `velocity.mjs`.** §3.4 defers it; §9 carries the condition to revisit |

### 6.1 The blast radius, measured — and it changed a design decision

**Spec 3's §9 was wrong about its test cost twice, in both cases by reasoning about the change
instead of grepping for it. So this section greps first.**

**Production callers of `loadSprints` — 7 call sites across 5 files, of which 4 are affected:**

| Call site | Reads | Affected |
|---|---|---|
| `edit.mjs:70` | `const { sprints } = …` | **no** |
| `new.mjs:83` | `const { sprints } = …` | **no** |
| `model/index.mjs:230` | `… .sprints` | **no** |
| `views/page.mjs:62` | passes the whole registry to `ganttModel`, which reads `.active` at `gantt.mjs:33` | **yes** |
| `sprint-runner.mjs:42` | reads `.active` | **yes** |
| `sprint-runner.mjs:52` | reads `.active` | **yes** |
| `sprint-runner.mjs:62` | reads `.active` | **yes** |

**Three of seven read only `.sprints` and do not change.** *(An earlier draft of this table said
"four of seven … only 3 affected" — it counted rows rather than call sites and inverted the
result. The three unaffected sites are a fact about the seam: ADR-0004 made sprints data read per
render, and `active` is touched only by the two surfaces that must **pick** a sprint.)*

**Test fixtures carrying a scalar `active` — 6 files:** `tests/model/sprints.test.mjs`
(**28** occurrences), `tests/model/gantt.test.mjs:20`, `tests/views/gantt.test.mjs:11`,
`tests/views/page.test.mjs:118`, `tests/new.test.mjs:124`, `tests/edit.test.mjs:96`. *(An earlier
draft said 7 files and 26 occurrences; the two extra "files" were the `active: null` empty-registry
lines at `model/gantt.test.mjs:30` and `views/gantt.test.mjs:93`, which carry no scalar id.)*

**Only 2 of those 6 bypass `loadSprints`** — `model/gantt.test.mjs:20` and `views/gantt.test.mjs:11`
pass a registry literal straight to `ganttModel`. The other four (`new`, `edit`, `views/page`, and
`sprints` itself) `writeFileSync` a real `sprints.json` and go **through** `loadSprints`;
`page.test.mjs`'s own comment says *"the fixture is a real data root"*. *(An earlier draft said
"five of the seven", and that sentence claimed to have been "produced by the grep rather than
recovered from a review". It was not: the grep says two. The claim is corrected and the boast is
withdrawn.)*

Two files is still two files, so the accessor stands — a literal registry reaching `ganttModel`
must not be misread:

```js
export function activeFor(registry, project) {
  const byProject = registry.activeByProject;
  if (byProject && project && project !== "all") return byProject[project] ?? null;
  return registry.active ?? null;                   // installation-wide, and the legacy answer
}
```

**Three cases, and each is the behaviour a reader already expects:**

| Registry | `project` | Returns |
|---|---|---|
| legacy (scalar `active` only) | anything | the scalar — **exactly today's behaviour**, which is what a board that never migrated should get |
| migrated | a real key | that project's pointer, or `null` |
| migrated | `"all"` | the installation-wide `active` — **not `null`** |

**That last row is the one an earlier draft got wrong, in the most embarrassing possible way.** It
defined `activeFor(map, "all")` as `a[project] ?? null` → `null`, and `"all"` is the **landing
page**: `ganttModel` defaults `project = "all"` (`gantt.mjs:29`) and so does `viewEnvelope`
(`page.mjs:108`). With the `|| list[0]` tail still present that selected **`S1`**, a sprint older
than the stale `S2` the board picks today — the accessor **reintroduced the exact defect it was
written to prevent, and made the symptom worse**. Keeping `active` as a scalar (§2.1) removes the
question: there is always an installation-wide answer.

**The shipped accessor returns the same thing the earlier one did for a legacy registry** —
`activeFor(legacy, "INF")` is `S2`, an OBA sprint — and only the justification changed, which is
worth being honest about rather than calling the earlier branch "wrong". A legacy board has **no
per-project pointers to return**, so the installation-wide answer is the only one available and it
is what today's engine already gives. §2.3 rule 3 forbids a *migrated* registry pointing `INF` at
an OBA sprint; it has nothing to say about a registry with no map at all.

**`gantt.mjs:36`'s `|| list[0]` tail is deleted, and the deletion is not safe on its own.**
Measured: applying it verbatim and calling `ganttModel` with no selectable sprint **throws**
`TypeError: Cannot read properties of undefined (reading 'start')` at `gantt.mjs:39`, because `sel`
is `undefined` and the axis block dereferences it immediately. The six sprint-touching fixture
files still pass 98/98 with the tail removed, and so does the full suite — **nothing anywhere
covers that path**, so the deletion would convert a wrong-sprint bug into a **render crash on the
default view**, silently.

So the deletion ships with the state it implies, specified rather than asserted:

```js
if (!sel) return { ...EMPTY, sprints: list, reason: "no-active-sprint" };
```

`EMPTY` already carries `empty: true` (`gantt.mjs:27`) and `views/gantt.mjs:40-44` already renders
that branch, so the renderer needs no new case — only the reason string, which follows spec 3
§2.1's read-time-reason rule. **A named no-selection state was asserted twice in an earlier draft
and specified nowhere**, which is how the crash survived review once. (One wrinkle to fix with it:
that branch's text reads *"Create one with `blaze sprint new`"*, which is wrong when five sprints
exist and none applies to this project.)

**The state is reachable** — a migrated registry whose `activeByProject` has no entry for the
viewed project, which is **9 of 11 projects** today — so it needs a test, and today has none.

With those, **only `tests/model/sprints.test.mjs` changes** among fixture files — plus one new test
for the no-selection state.


### 6.2 What must be rewritten in `sprints.test.mjs`

Of its **28** tests, classified by opening the file rather than by inference:

**This table was byte-identical to the pre-reversal draft until the third review caught it — the
same defect §6's own opener describes, one section further along.** **One** of its rows described
the replaced-map shape §2.1 abandoned (`:13`/`:19`, *"`active` becomes `{}`"*); the other
(`:26`/`:34`) described the additive shape correctly and was wrong only about *why* those tests
change. An earlier correction said "two rows" — itself the fourth retrospective in this spec to
misdescribe an earlier draft. Corrected:

| Tests | Why they change |
|---|---|
| `:13`, `:19` — `loadSprints` degrades to empty | **unchanged.** They assert `{ active: null, sprints: [] }`, which stays correct under the additive shape — an earlier row claimed `active` becomes `{}` |
| `:26`, `:34` — reads a registry / round-trips | **changed, but not as an earlier row said.** It asked them to *"assert the scalar survives `loadSprints`"* — which is now the correct behaviour, so that is not why they change. They change because `loadSprints` gains the `activeByProject` passthrough (§2.2) and its return shape grows a key |
| `:151`, `:159`, `:167`, `:172`, `:183`, `:190` — `addSprint` ×6 | `project` becomes required |
| `:195`, `:202` — `setActive` ×2 | the signature gains `project` |
| `:209` — `formatSprintList` ×**1** | output gains the project and per-project active markers |
| `:223` — `formatSprintList` on an empty registry | **unchanged.** It asserts `formatSprintList({active:null,sprints:[]}) === "(no sprints)"`, which returns early at `sprints.mjs:81` and no project-or-marker change touches |
| `:59`, `:62`, `:67`, `:70`, `:74`, `:79`, `:82` — `validateSprintFields` ×**7** | the options bag gains the registry (below) |

**11 of 28 change outright** — 0 + 2 + 6 + 2 + **1**. This number has now been wrong three times
(16, then 14, then 12), so here is the arithmetic: `:13`/`:19` **0** (unchanged under the additive
shape); `:26`/`:34` **2**; `addSprint` **6**; `setActive` **2**; `formatSprintList` **1**, not 2 —
`:223` asserts `formatSprintList({active:null,sprints:[]}) === "(no sprints)"`, which no
project-or-marker change touches.

**The `validateSprintFields` 7 change too, and its 2 production callers with them.** An earlier
draft kept its `{ sprintIds }` bag "additional optional" so those 9 sites stayed untouched — but
§2.3's rule 2 needs each sprint's **project**, and a `Set` of ids cannot carry it. Both callers
build the bag inline (`new.mjs:84`, `edit.mjs:71` — `{ sprintIds: new Set(sprints.map(s => s.id)) }`),
so keeping the signature means the registry never arrives and **rule 2 — "the one with teeth" —
never fires in production.** The bag becomes `{ sprints }` and the two callers pass the registry
they already loaded.

**Final count: 18 of 28 rewritten in `sprints.test.mjs`** (11 above plus the 7
`validateSprintFields` tests whose options bag changes), **plus 2 production call sites; 0 tests
elsewhere, 0 deleted**, and one new test for §6.1's no-selection state. Any test outside that file that breaks is a defect in `activeFor` rather
than an expected cost — a check, not a budget.

---

## 7. Testing and mutation discipline

TDD throughout. Mutations, each of which must break at least one test:

1. Migrate a sprint's `project` from the first token of its `name` instead of from ticket
   membership (§2.2 — this is the one that is right 4 times in 5).
2. Migrate a sprint whose tagged tickets span two projects instead of reporting it.
3. Drop `loadSprints`'s passthrough of `activeByProject` (§2.2 — the whitelist defect; it must
   break a test that loads a migrated registry and reads a per-project pointer, not one that goes
   only through `activeFor` with a literal).
4. Let `activeByProject[K]` name a sprint owned by a project other than `K`.
5. Count a sprint's capacity over **calendar** days rather than working days (§3.2 — S3's
   capacity moves from 2,880 to 4,800 and its ratio from 0.57 to 0.34).
6. Derive the capacity denominator from **assignees** rather than `minutes_per_day` (§9 — 2,531 of
   2,613 tickets are unassigned, and 80 of 80 sprint-tagged ones are, so it computes ≈0 and every
   sprint reads as infinitely over-committed).
7. Ship a **velocity** number computed from `.blaze/transitions.json` (§3.4 — deferred precisely
   because that log records reconcile cadence rather than when work happened).
8. Raise `sprint-window-missed` for a sprint that has already ended (§4 — collapses the 26/0
   split).
9. Replace the scalar `active` with the map instead of adding `activeByProject` beside it (§2.1 —
   an older engine then falls to `list[0]`, which is ADR-0004's bump condition).
10. Default `swimlaneBy` to `'assignee'` (§5).
11. Make `activeFor` reject a legacy scalar `active` instead of accepting both shapes (§6.1 — this
    is the mutation that catches the silent `list[0]` fallback, and it must break a test that
    feeds a scalar registry straight to `ganttModel`, not only one that goes through
    `loadSprints`).
12. Raise no finding at all when a sprint is **current** and the derived start is after its end
    (§4 — the row with zero corpus members).

13. Delete `gantt.mjs:36`'s `|| list[0]` tail **without** adding the `no-active-sprint` return
    (§6.1 — the mutation that catches the render crash; today the suite passes **98/98** with the
    tail simply removed — that is the **six sprint-touching fixture files**, not the whole suite,
    and the full suite's counts are byte-identical with the tail removed too, so nothing anywhere
    covers that path).

**Any mutation that survives is named in the PR body as a hole in the suite**, not quietly fixed.

**Mutations 11, 12 and 13 have no corpus row behind them** — 12 because every sprint has ended, 11
because the legacy scalar is what exists today and the map does not yet, and 13 because no test
reaches the no-selection path. All three need synthetic fixtures, which is a weaker guarantee than
the other ten get.

Fixtures from the corpus: the S3/S4/S5 three-way overlap; `S2`'s name (`"OBA-1 re-baseline…"`,
the one that defeats name-parsing); S3's 27 tagged tickets with zero in-window closures; and the
stale `active: "S2"` pointer itself.

---

## 8. Constraints honoured

| Constraint | How |
|---|---|
| **ADR-0004 — sprints are data, re-read per render** | Unchanged. `sprints.json` stays at the data root and stays read per render (`sprints.mjs:1-3`). The shape changes; the seam does not. |
| **ADR-0011 — no new required runtime dependency** | Nothing added. `capacity.mjs` is arithmetic over rows already loaded. |
| **ADR-0014 — no board or tenant discriminator** | `project` is not one: it names a project inside one installation, the same way `ticket.project` already does. |
| **ADR-0018 — hybrid custom fields** | No new ticket column. `sprint` stays the existing frontmatter field. |
| **BLZ-360 §2.3 — one `minutes_per_day`** | Honoured with both consumers intact: the scheduler's arithmetic, and §3.2's sprint capacity bar. One number, one definition, two readers — which is what §2.3 asks and what BLZ-360 §8.1 means by *"sprint capacity: served"*. |

---

## 9. What this spec does NOT solve

- **Velocity.** §3.4 measures the transitions log unable to support it — 0 of 5 sprints closed
  tagged work after their window as an earlier draft assumed, 43 of 80 sprint-tagged tickets have
  no terminal record at all, and 86% of arrivals are batch writes. **This is the largest honest
  gap**, and the condition to revisit it is stated rather than left open: a log whose terminal
  arrivals are not batch-dominated.
- **Burndown.** Same source, same problem, and worse — a burndown needs a *daily* series from a log
  carrying 62 distinct timestamps across 38 days.
- **Team size above one.** §3.2's capacity bar assumes one person, because S1's 0.96 is the only
  evidence the corpus offers and nothing in it supplies a larger integer — the board has **2
  distinct assignee values, one of which is `unassigned`** (2,531 of 2,613 tickets). A `team_size`
  field is deferred, not refused; it needs a second person first.
- **An older engine silently destroys `activeByProject`.** §2.2 measures it: `loadSprints`
  whitelists two keys, so one `blaze sprint active` from an unmodified engine writes the map out of
  existence, and it is **operator-entered state that nothing can reconstruct** — ticket membership
  gives sprint → project, never project → which sprint is active. `blaze sprint migrate` re-seeds a
  named default; it does not recover the operator's choice. The alternative is a
  `MIN_SCHEMA_VERSION` bump that refuses old engines outright, which this spec does not take. **This
  is the cost of the additive shape and it is unrecoverable**, which makes it a larger gap than the
  velocity one above in kind, if not in frequency.
- **Sprint close-out as an event.** No ceremony, no carry-over gesture, no "move unfinished to the
  next sprint" command. §4 reports the 26 overruns; it does not offer to fix them.
- **Cross-project sprints.** §2.1 refuses them on measurement; a later ruling would reopen it.
- **Per-person capacity or assignment.** 2 distinct assignees exist, one of them `unassigned`.
- **Reconciling sprint membership with the schedule.** BLZ-360 §8.1's rule stands; §4 reports.
- **Sprint templates, cadence, or auto-creation.** All five sprints were hand-created with
  irregular windows — 4, 3, 6, 5 and 9 working days — and nothing suggests a cadence to automate.

---

## 10. Open questions

1. **Should a sprint's window be working-day-aligned?** Measured, **S2 starts on a Sunday, S3 and
   S4 both end on a Sunday, and S5 ends on a Saturday**, and the registry has no opinion. It makes
   `working_days` (4, 3, 6, 5, 9 for S1–S5) differ from calendar span (6, 4, 10, 7, 12) by up to
   4 days. Whether to warn, refuse, or stay silent is not decided.
2. **Does "committed" mean tagged *now* or tagged *at sprint start*?** §3.2 uses tagged-now,
   which is all the corpus can answer — `.blaze/transitions.json` records status changes, not
   `sprint` reassignments, so membership history does not exist. It matters: **8 of S3's tagged
   tickets reached a terminal status before its window opened**, carrying 375 estimate-minutes, so
   S3's 0.57 is **0.44** net of work already finished when it was tagged. The ratio stays under 1
   either way; the column label is doing more work than the data supports.
3. **Is a capacity bar worth drawing at 0.23–0.57?** §3.2's case leans on S1's 0.96; the other four
   sit between 0.23 and 0.57 (mean of five, **0.53**). A bar never near full may be no more useful
   than the permanently-red one the earlier draft refused — that argument was **deleted with the
   reversal rather than answered**. Relatedly, §3.2's *"strongest evidence available that this is
   the operator's own implicit model"* rests on **one** of five points; §9 states the same fact
   more carefully.
4. **Should `sprint-overrun` auto-clear?** A ticket closed after its sprint ended is still an
   overrun by §4's definition, forever. Whether the finding is about the ticket's *current* state
   or a permanent historical fact is unresolved, and it decides whether the count ever goes down.
