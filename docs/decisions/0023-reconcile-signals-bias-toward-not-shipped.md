# ADR-0023 — Reconcile's signals bias toward not-shipped

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Ryan Howman
- **Ticket:** BLZ-130, BLZ-131

## Context

BLZ-130 and BLZ-131 are the same defect seen from opposite sides: reconcile's
reading of git and PR state diverged from delivery truth. Both were found by hand
on 2026-07-28 while closing out epic INF-645 in `hjr15/service-platform`, and
neither produced an error — reconcile simply said the wrong thing, quietly.

**BLZ-130 — over-reporting.** PR ranking was `MERGED 3 > OPEN 2 > CLOSED 1`, read
as "how far along the work is". So *any* merged PR carrying a key drove the ticket
to `done`. INF-645 had a docs-only PR #80 that merged at 12:05Z while PR #81 — the
actual work — was still open. The epic was reported complete. Terminal status is
sticky, so nothing re-opened it when #81 landed later, and because a MERGED signal
never changes, the wrong answer re-asserted on every `reconcile --apply`.

The premise behind the rank is false. A feature accumulates more than one PR over
its life; that is the whole point of the bundling model. Any feature that merges
an early spike, revert, or decision record is then permanently mis-reported.

**BLZ-131 — under-reporting.** The bundled-child signal (ADR-0003, delivered in
BLZ-117) reads `<KEY>-<n>:` commit *subjects* on the default branch. These repos
are squash-only — `blaze-pm` by deliberate design (INF-556/INF-557, so the
flush-owner produces exactly one commit per day), `service-platform` by convention
— and a squash collapses a branch into a single commit whose subject is the PR
title. Measured on `service-platform` immediately after PR #81 merged: six
children, six carefully-written commits, **zero** surviving on `main`. All six sat
in `defined/` with their work live in production.

"Stop squashing" is not available for the repos that matter most.

## Decision

### 1. An open pull request vetoes `done`

`PR_RANK` becomes `OPEN 3 > MERGED 2 > CLOSED 1`. It is a **selection precedence,
not a progress ordering**, and the comment at the constant says so, because the old
reading is the intuitive one and it is what caused the bug.

A ticket reaches `done` from a merged PR only while no PR carrying its key is open.
MERGED still beats CLOSED, and a ticket whose only PR is merged still reaches
`done` — the fix must not disable reconcile, and a test pins that.

This is type-independent. BLZ-130 asks whether `story` shares the failure; every
delivery type does, because ranking never sees the type. Scoping the veto to
`epic` would have left the identical bug in the four types that also legitimately
span more than one PR.

A terminal ticket's `branch` and `pr` record **only a merged PR**. The first cut
clamped `target` alone, which suppressed the move and rewrote the record anyway: a
`done` epic delivered by merged PR #80 had its frontmatter repointed at the later OPEN
#81 that now wins the rank, reported as `moved: false`. Those fields are the history of
what delivered the ticket, not live state.

The correction to that then over-corrected, recorded here because the shape recurs:
nulling both fields for *every* terminal ticket stopped the overwrite and stopped the
first write with it. Reconcile is the only producer of `branch`/`pr`, so a `done` ticket
that never had them recorded could never acquire them — on the board repo at `blaze-pm`
`ff5f36c2`, 1,064 of 1,594 `done` tickets **missing a `pr`**, permanently. Turning a
corruption into a silent omission is not a fix. (Two counts appear in this ADR and they
are different quantities, so each names itself, and both are measured with the shipped
`fsReadStorage.listTickets` at `blaze-pm` `ff5f36c2` — its `origin/main`, which anyone can
resolve: *missing a `pr`* is **1,064 of 1,594**; *carrying neither field* is **1,056 of
1,594**. An earlier draft also quoted 1,141 of 1,679 at `cd4b1d9d`; that is a local-only
branch on one machine, off every remote, so it is dropped rather than repeated. The same
conflation was in `decide()`'s comment in `scripts/reconcile.mjs` and is corrected there
too — a correction that fixes one instance and not its twin is how this figure was wrong
twice.)
That correction then under-corrected, which is recorded too. Gating on "the winning PR
is MERGED" stopped an open PR overwriting the record and left a merged one free to —
and ranking breaks ties on the higher PR number, so the *latest* merged PR always wins.
A follow-up docs PR titled `INF-645: follow-up docs tidy`, merged under the same key,
therefore repointed the epic away from the PR that delivered it, once again reported as
`moved: false`.

**The rule that holds all three cases is write-once.** A terminal ticket may ACQUIRE a
delivery record it never had — reconcile is the only thing that writes those fields — and
may never have one replaced. The MERGED gate is kept as well, so an open PR cannot even
fill a blank. `decide` reports that the rule applies (`recordIfAbsentOnly`); the caller,
which holds the current frontmatter, enforces it.

Three attempts, three shapes of wrong: overwrite anything, write nothing, overwrite with
the latest merge. It is recorded at this length because the same shape keeps recurring
across this ADR's own history.

**A fourth shape, found by review: the record is ONE UNIT, not two fields.** Write-once
was first enforced per field, against that field's own current value. A `done` ticket
with `branch` recorded and `pr` blank therefore still had its `pr` filled — from the
top-ranked PR, which by the tie-break above is the *latest* merged one. The follow-up
docs PR of the paragraph before still stamped itself onto half the record while `branch`
went on naming the real deliverer: one record naming two different PRs, which is the
third shape again, reached through the blank half. 8 of 1,594 `done` tickets at `blaze-pm`
`ff5f36c2` are in that shape — `branch` recorded, `pr` blank. (The mirror shape, `pr`
recorded and `branch` blank, is 0 of 1,594 at that ref.) So `hadRecord` is snapshotted
from the ticket's frontmatter BEFORE either field is written, and governs both: a
terminal ticket with *either* field keeps *both*.

**Cost, accepted:** a terminal ticket holding half a record never gains the other half —
8 of 1,594 at `blaze-pm` `ff5f36c2`, but the cost is **ongoing, not a fixed historical
set**: any ticket that reaches a terminal status while half-recorded and later has a
merged PR for its key is locked out the same way. That is the same asymmetry as above — a blank `pr` understates and is true; a `pr` naming the
wrong PR overstates and is false, and write-once then locks it in permanently, since `pr`
is not in `EDITABLE_FIELDS` and `blaze edit` will not repair it. Recovering the *right*
PR for a half-recorded ticket (by corroborating `headRefName` against the recorded
`branch`) is a
separate change and is not made here: a new inference path is exactly the shape that has
already failed three times above.

**BLZ-398 adds a THIRD verb to this rule: reconcile may now DELETE a delivery record.**
Recorded here because the rule above — "may ACQUIRE … may never have one replaced" — reads
as though acquire and keep are the only directions, and that is no longer true.

The reason is that write-once alone could not hold the record honest. `PR_RANK` puts OPEN
above MERGED, so while any PR carrying the key is open the record is chosen by **rank, not
by any deliverer rule** — `prTitleClaim` never runs on that path. A follow-up PR that
happens to be open at the sample moment therefore writes itself into the record during
`in-review`; when it later merges, the merged set becomes unresolvable, and merely refusing
to write froze that rank-chosen value as the ticket went terminal. The board then held the
wrong PR permanently, with a finding beside it that claimed nothing had been recorded and
then fell silent, because a frozen record makes the write-once test true and the finding is
gated on it.

So when the deliverer is ambiguous and write-once does **not** apply, both fields are
cleared. That is safe exactly where it applies: write-once not applying means the record is
either live pre-terminal state reconcile itself wrote, or absent. Reconcile is the only
producer of `branch`/`pr` — neither is in `EDITABLE_FIELDS` — so nothing a person authored
is reachable. A cleared record is reported as `cleared` on the change, because a
destructive direction that reports itself as `{from: "done", to: "done"}` is
indistinguishable from a `resolution` backfill.

**The residual, stated rather than papered over — and it is the same shape as §1's.** The
clear and the finding are both gated on write-once not applying. A ticket **hand-moved** to
`done` while a follow-up PR is still open arrives at terminal-with-a-record by a route
reconcile never sees, and neither the clear nor the report fires: the rank-chosen record is
frozen exactly as before, silently. That is not a regression — `origin/main` freezes the
same value — but it is not closed either. Closing it means either overriding write-once on
a terminal ticket, or reporting on the ~54 terminal tickets at `blaze-pm` `ff5f36c2` that
already hold a record drawn from an ambiguous set, most of which are probably right.
Tracked separately rather than decided here, for the same reason BLZ-395 was: it is a
second, larger decision about a deliberate rule, not an oversight in this one — until
BLZ-403 measured it and decided it; see §5.

**Cost, accepted:** a delayed `done`. A ticket waits in `in-review` until the last
PR carrying its key closes. That is the safe direction — the board understating
progress is recoverable by looking; overstating it is not.

**Scope, stated precisely because an earlier draft of this ADR overstated it.** The
veto applies to a ticket that is *not yet terminal*. It does **not** re-open one that
already reached `done`: terminal status is sticky by design, so if reconcile runs in
the window between an early PR merging and the next one opening, the ticket goes to
`done` and stays there. The veto narrows that window to the time both PRs are visible
at once; it does not close it, and BLZ-130's own report of the failure as
"self-reinforcing" therefore remains partly open. Tracked as BLZ-395 rather than
resolved here, because closing it means revisiting terminal-stickiness itself — a
deliberate, separate design decision with its own blast radius.

**BLZ-395's resolution, since this paragraph is where a reader will look for it: the
window is still not closed, and it is no longer silent.** Of the three options this ADR
recorded — un-stick on a corroborated open PR, report rather than move, or document and
do nothing — the middle one shipped. Terminal-stickiness is **unchanged**, deliberately
and not by omission: un-sticking would let any open PR whose branch merely carries the
key drag back a ticket a person closed on purpose, trading a silent over-report for a
silent over-write, which is this record's own failure shape in the other direction. So
reconcile now emits a **finding** — `open-pr-on-terminal` — on `reconcile.findings` for
every terminal ticket carrying a *corroborated* open PR, on dry runs and applies alike.
It reaches the CLI on stderr regardless of `--quiet` (the same rule as the missing-repo
and unreadable-forge warnings: `--quiet` means "print only on change", and this is a
reason not to trust the absence of one), the `blaze start` activity feed as a
`warning` deduped per message, and `/api/reconcile-preview`. The supervisor loop is the
one that matters, because a timer sampling git is what opens the window in the first
place.

The finding is gated on the same corroboration as the veto, per the qualifier below —
an open PR INF-735's gate drops is invisible to both. And it is recorded before the
loop's dirty check, because the whole condition is that *nothing changed*: `changes` is
empty by construction here, so a finding gated on a change would never fire. **The cost,
stated: the board can still be wrong, and now says so instead of only being wrong.**
Correcting it stays a person's move.

Second qualifier: "no PR is open" is really "no *corroborated* PR is open". An open PR
whose claim INF-735's gate drops is not visible to the veto at all.

### 2. The shipped signal reads a squash commit's body, under two conditions

GitHub's default squash message concatenates the collapsed commits' messages, each
subject as a `* ` bullet. On this repo at `blaze` `7a5ddb0` — the sha its `origin/main`
held when this was measured, named as a sha because `origin/main` moves and `312`
self-invalidates the moment the next PR merges — **23** of those **312** commits carry
such a bullet under a ticket subject, **102** bullet lines in total, and reading them
recovers **28** ticket ids that no subject at that ref mentions. That is the blind spot,
measured rather than argued.

**Two conditions must both hold, and each is load-bearing.**

1. The marker is `* `, which is what GitHub writes and what nothing else here writes.
2. The commit's own subject must **open with a ticket-id list** — `<KEY>-<n>:`, and
   the multi-ticket forms the house also writes, `<KEY>-a/b/c:` and
   `<KEY>-a + <KEY>-b:`. It must itself be a squashed *ticket* PR. This is BLZ-131's
   own premise: a bundled child lives inside a feature's PR, titled that way by
   convention. Every id in the leading list counts, and the list ends at the colon, so
   `BLZ-1: fixes BLZ-4` still claims only BLZ-1.

   The multi-ticket forms were missed on the first attempt, which read only the leading
   id. `BLZ-286/287/288: config projection … (#71)` is a real squashed feature PR on
   this repo's default branch and two of its three tickets were discarded; the PR that
   introduced this rule was itself titled `BLZ-130 + BLZ-131: …` and would have
   stranded BLZ-131. A gate resting on "a feature PR is titled that way by convention"
   has to accept the conventions actually in use.

Condition 2 was not in the first cut, and an adversarial review is why it exists.
`scripts/commit-runner.mjs` writes every batch board commit's body as
`- <KEY>-<n>: <board op> [session]`, and the board repo is itself a configured
`codeRepo` for its own project — the hazard INF-735's comment already names. Honouring
any bullet under any subject therefore turned the board's own ledger into a delivery
signal. Measured on the board repo at `blaze-pm` `ff5f36c2` — its `origin/main`, 156
commits — for the `INF` key alone: **426** ids harvested beyond the subjects, **386** of
them named by nothing but a `- INF-<n>: <board op> [session]` ledger line. Re-run at that
same ref, the first cut drives `decide()` to move **141** `INF` tickets `defined → done`,
every one of them named by such a ledger line (**268** across all eleven project keys the
board configures, 266 of those named by a ledger line). An earlier draft of this ADR
quoted **137** against "the board's local `HEAD`, the 299-id tree" — not a ref anyone off
that machine can resolve, which is why it is restated here at `ff5f36c2`. That is this
ADR's own §1 failure at a hundred times the scale, re-introduced inside the fix for its
sibling.

Narrowing the marker alone was not sufficient, and neither was the subject gate alone:

**This table is one measurement at one named ref, and it moves as the board grows.**
Measured on `blaze-pm` `ff5f36c2` (its `origin/main`, 156 commits), harvesting each of the
**eleven project keys the board configures** — that is the population, because the board
repo is a configured `codeRepo` for its own project and every key's ledger lines are in
scope. Where a figure is for the `INF` key alone it says so.

| Rule | Ids harvested beyond the subjects | What those ids are |
|---|---|---|
| Any bullet, any subject | **1,323** (426 for `INF` alone) | board bookkeeping, not deliveries: 1,205 of the 1,323 are named by nothing but a `- <KEY>-<n>: <board op> [session]` ledger line (386 of the 426) |
| Any bullet, ticket subject only | **63** (49 for `INF` alone) | the same: 60 of the 63 are ledger-only (47 of the 49) |
| `* ` bullet, ticket subject only — the shipped rule | **3** (2 for `INF` alone): `BLZ-259`, `INF-672`, `INF-701` | none is a ledger line. `INF-672` and `INF-701` are `done` on the board and really shipped. `BLZ-259` is harvested from two real `* BLZ-259:` bullets in merged commit `e3beaec3` — the rule did not misfire — but it sits in `projects/BLZ/accepted/` at this ref, so this cell can no longer claim "0 delivered nothing" |

The first two rows are measured with the wide `[*+-]` marker and the third with `* `,
which is the point of the comparison — each row drops one condition from the shipped
rule. The two conditions still cut hard: 1,323 → 63 → 3 across the board's keys, and
426 → 49 → 2 for `INF` alone.

**The third row drifted from 2 to 3, and the drift is the point.** At `blaze-pm`
`bd1d151d` (131 commits, an ancestor of `ff5f36c2` on the same `origin/main`) the row was
genuinely **2**; `BLZ-259` joined it when `e3beaec3` — subject `BLZ-261: the docs seam
(ADR-0020) …`, carrying two `* BLZ-259:` bullets — landed between the two refs. An earlier
draft asserted "the **2** is stable", and it is not; a snapshot of a growing corpus never
is. Any figure in this section that does not name a sha is unreproducible, and an earlier
draft quoted this table against a local `HEAD` on a branch that exists on one machine.

**`BLZ-259` is not a defect in the rule, and is not claimed as one.** The
`- BLZ-259: log 150m [auto-…]` ledger lines in that same commit are correctly rejected by
the `* ` marker; the two `* BLZ-259:` lines are real squash-body commit subjects from a
merged PR. What the row exposes is a board fact, not an engine fact: real merged work
landed under `BLZ-259` while the ticket sits in `accepted/`. Reconcile moving it to `done`
would be right; the ADR's old "delivered nothing: **0**" cell was the wrong shape of claim
to make about it.

**A claim this ADR made in an earlier draft, withdrawn.** It argued that the bullet
requirement was load-bearing because unbulleted body lines beginning `<KEY>-<n>:`
would otherwise mark "sixteen untouched tickets" done. Re-measured under the shipped
rule, unbulleted lines inside gated commits add **zero** ids on this repo at `blaze`
`7a5ddb0` (and **4** on the board at `blaze-pm` `ff5f36c2` — `INF-667`, `INF-683`,
`INF-707`, `INF-708`) — the sixteen lived in commits the subject gate now excludes
anyway, and the figure had also counted lines where it said tickets. The bullet
requirement earns its place on the ledger evidence above (63 → 3 across the board's keys
at `ff5f36c2`, 49 → 2 for `INF` alone), not on that argument.

**What this deliberately does not claim:** a bullet is not proof of work. A squashed
ticket PR whose body lists a ticket it did not implement will be believed. The two
conditions make that a narrow case rather than the common one, and the safe direction
holds elsewhere — the commit must be reachable from the default branch, so an open PR
strands nothing.

**Consequence for INF-735, which an earlier draft said was untouched.** The
corroboration *gate* is unchanged, but its *input* is not: `shippedSet` corroborates
both PR and branch ref-claims, and widening it widens what the gate admits. A ref-name
claim whose PR title never names the ticket can now be corroborated by a bullet. That
is a real widening, it is the price of the fix, and the two conditions above are what
keep it narrow.

**BLZ-440 narrowed the gate's OTHER arm, and it is worth reading beside the widening
above.** INF-735's title arm tested `new RegExp("\\b" + id + "\\b", "i")` against the PR
title — a bare **mention**. `\bBLZ-408\b` matches inside `BLZ-408..439` (the `.` is a
non-word character, so the right-hand boundary holds), so a PR named for a ticket RANGE
corroborated its own first element. Live on 2026-08-28, `blaze reconcile --project BLZ`
proposed `BLZ-408: defined → done` from PR #140 — branch
`docs-successor-kickoff-blz-408-439`, title `docs: successor kickoff for the
BLZ-408..439 follow-up lane` — for a ticket that had never been worked. This ADR's own
asymmetry names the cost: a `pr` naming the wrong PR **overstates and is false**, and
write-once then locks it in permanently.

The title arm now calls `idsFromSubject` — the same predicate the shipped signal's
second condition already used, and the same one `prTitleClaim` ranks with. The house
rule reaches all three paths from one implementation, because two implementations of
"does this subject claim this ticket" is exactly how these two drifted apart. A title
must OPEN with `<KEY>-<n>` followed by `:`, list forms included; `supersedes BLZ-408`,
`follow-up to BLZ-408`, `(BLZ-408)` and `BLZ-408..439` all corroborate nothing.

**The `shippedSet` arm is untouched** — it is built from `idsFromCommitMessage`, which is
already strict, and it stays the route by which a legitimately non-conventional title is
corroborated by a real commit. The narrowing is therefore only on the arm that trusted
the forge's prose.

**Stated cost, in this ADR's own direction of bias:** a PR whose branch names a ticket
and whose title does not claim it may no longer **advance** the ticket, so it sits where
it is until someone moves it. That is an understatement, and understatement is the side
this record deliberately errs on. See the round-2 section below before reading that as
"the claim is discarded" — it is not, and the difference is a shipped bug.

### BLZ-440 round 2: an uncorroborated claim is NEUTERED, not DROPPED

The first cut of BLZ-440 **dropped** uncorroborated claims out of the candidate pool, on
INF-735's reasoning that "an uncorroborated claim is dropped rather than trusted, so a
misnamed branch costs a missed signal, not a corrupted ticket". Adversarial review refuted
that, and this record already contained the refutation: `PR_RANK` puts `OPEN` above
`MERGED`, and `decide` reads the **top-ranked** PR, so removing a candidate is not a
subtraction — it is a **substitution**, and the next-ranked PR is promoted. This is the
same lesson the unnumberable-PR case learned, on a second axis.

Measured on the repo's own selection-invariant pool, with no shipped signal:

```
BEFORE  winner=open/weak/null    target=in-review  record=#41  resolution=undefined
ROUND 1 winner=merged/strong/10  target=done       record=#10  resolution=done
```

Dropping the uncorroborated **open** PR deleted BLZ-130's veto and handed the ticket to an
earlier merged one: `in-review` to `done`, with `resolution: done` and a **write-once**
`pr:` record naming the wrong pull request, while the PR carrying the real work was still
open. `openPrOnTerminal` was `false`, so no finding fired. Silent, permanent, overstating —
this record's own worst shape, reached through the door opened by fixing the other one.

**The rule, which satisfies both directions at once:**

> **An uncorroborated claim may only ever hold a ticket BACK. It may never advance one.**
> It stays in the pool so it keeps whatever veto its STATE earns (BLZ-130), and it can
> supply neither a delivery RECORD nor a TERMINAL target.

Neutering as the unnumberable case does it — `number: null`, record suppressed — is
**necessary but not sufficient here**, and copying it would have been wrong. That PR
genuinely belongs to the ticket and merely has a broken number, so keeping its state
signal is right. A BLZ-440 PR does not belong to the ticket at all, so its MERGED state
must not drive anything either; otherwise PR #140 still takes BLZ-408 to `done`, just
without a `pr:` line, which is no better.

Two consequences, both recorded because they are behaviour, not implementation:

- `betterPr` gains a **CORROBORATED tier directly under RANK** and above the claim tier.
  Rank is the only thing an uncorroborated claim may win on — that is its veto. Within a
  rank there is no reason to prefer it, and without the tier an uncorroborated claim ties
  with a shippedSet-corroborated weak-titled peer and takes the tie on **lower number**,
  suppressing a record that was available. That is the unnumberable-PR defect re-entered
  on the corroboration axis.
- An uncorroborated PR **masks a corroborated branch signal** for the same ticket, since
  `decide` reads the PR arm first. Falling through to the branch arm was rejected: it
  would also expose the `shipped` arm, which could then drive `done` while an open PR sat
  in the pool — destroying the very BLZ-130 veto this rule exists to preserve. A missed
  advance is the acceptable cost; a granted one is not.

**The cost is bidirectional and the two directions are not symmetric.** Withholding a
move is recoverable by hand. Granting one is not: terminal status is sticky, `pr` is not
in `EDITABLE_FIELDS`, and the record is write-once. Round 1's cost sentence — "a missed
signal, not a corrupted ticket" — was true of the rule it described and false of the code
it shipped, and both this file and `docs/guide/how-it-works.md` said so. They now say what
is actually true.

**Rejected: matching on the merged PR's body.** BLZ-131 lists it first and calls it
cheapest, and it was still declined. It widens trust to the forge for a claim that
moves a ticket to `done`, and a PR body naming a ticket is weaker evidence than a
commit demonstrably on the default branch. It would also have re-created BLZ-130
exactly — INF-645's early docs PR #80 was merged, and anything its body listed
would have shipped its children while the real work was open.

**Rejected: requiring a `Blaze-Ticket:` trailer.** It fixes nothing already merged,
and changes the commit convention for every repo to buy what the bullets already
give.

**Accepted cost — one repository setting.** GitHub's *Default commit message for
squash merges* must be "Default message" or "Pull request title and commit
details". Set to "Pull request title", the bullets are never written and bundled
children need a manual move, as before. Reconcile cannot detect the difference: an
absent bullet and an unshipped child are identical to it. It therefore fails the
safe way and says nothing, and the requirement is documented at
`docs/guide/how-it-works.md`.

### 3. `reconcile --apply` stays a direct write, and is not session-scoped

BLZ-130's second observation: `--apply` writes ticket files directly rather than
queueing session-scoped ops, so a dry run proposing 22 changes included ~15 `OBA-*`
tickets belonging to concurrent sister sessions.

**Decided: it stays direct-write.** The session-queue machinery exists to serialise
*divergent intents* — two sessions each asserting something different about the same
ticket. Reconcile has no intent: it derives its answer from git rather than from
anything the session wants, so scoping it to a session would add a merge step to reach
a result neither session authored.

**A stronger claim, made in an earlier draft and withdrawn as false.** That draft said
reconcile is "a deterministic, idempotent function of git state, so two sessions
running it converge". It is not. Terminal status is sticky, so the board's answer
depends on *when* reconcile sampled git, not only on what git holds: a run that sees
only the early merged PR writes `done` and sticks, while a later run seeing both PRs
would have written `in-review`. Same end state, two different answers, decided by run
history. That is the same residual as §1's window (BLZ-395) and it is an argument for
fixing stickiness, not for session queues — which would not help, since both sessions
read the same git and neither is wrong about it.

What the observation actually reports is **blast radius, not correctness**: a
session that owns three tickets should not author a commit that moves fifteen it
never touched. That is a real problem and a different one — the fix is a
`--project` filter on the verb, not session queues. Tracked separately as BLZ-394;
deliberately not bundled here, because it changes the write path and this change
does not touch it.

**Shipped 2026-08-27 (BLZ-394).** `blaze reconcile --project <KEY>` restricts both
the scan and the write, repeatable or comma-separated. An unknown key — or a
`--project` that resolves to no key at all, which a shell produces from an unset
variable — refuses the whole run rather than reconciling nothing or, worse,
everything. Scope is checked on the ticket's DIRECTORY, not its frontmatter,
because blast radius is a property of the path. The ruling above is unchanged:
`--apply` is still a direct write and is still not session-scoped.

### 4. "Tickets stay 1:1 with commits" is true of the branch, not of the trunk

The `feature-pr-bundling` skill's wording — *"Tickets stay 1:1 with commits and
`done/` moves"* — is true on the feature branch and false on the default branch the
moment the PR squashes. That mismatch is what BLZ-131 was.

**Decided: keep the per-ticket commits and keep the wording's intent, and make the
engine meet it.** The alternative — telling authors their per-ticket commits do not
survive, so stop writing them — would discard the only record of which ticket did
what, which is the thing the squash body preserves and the thing reconcile now
reads. `AGENTS.md`'s "The loop" states the squash behaviour explicitly rather than
leaving the 1:1 claim to be read as trunk-level.

### 5. A terminal ticket's unverifiable record is reported, never overwritten (BLZ-403)

§1's residual, closed. A ticket **hand-moved** to a terminal status while a follow-up PR
is still open arrives at terminal-with-a-record by a route reconcile never sees: the
clear and the `ambiguous-deliverer` finding at §1 are both gated on `d.recordAmbiguous
&& !keep()`, and `keep()` reads true for exactly this ticket — it is already terminal and
already holds a record before the run that discovers the merged set is unresolvable. So
neither the clear nor the report fires, and the rank-chosen record is frozen forever
(`pr` is not in `EDITABLE_FIELDS`, so `blaze edit` cannot repair it either). Not a
regression — `origin/main` freezes the same value — but not closed either, until now.

**The two options were the same two §1 already named:** override write-once on a
terminal ticket to let this path CLEAR and re-report like §1's does, or leave write-once
standing and REPORT the state without touching the record.

**The measurement that decided it.** At blaze-pm
`57212799269cb946c3949da459c04e0e4e765afb` (branch `BLZ-305-v4-spine`), NCA excluded,
computed with the engine's own exports (`fsReadStorage.listTickets`, `isTerminal`,
`gatherPrs`, `idsFromCommitMessage`, `ambiguousDeliverers`) over all 18 configured
`codeRepos`, every one of which read cleanly: 2,614 tickets, 1,890 terminal, 534 terminal
tickets holding a delivery record, and of those, **73** whose merged set is unresolvable.
Of the 73, **1** holds a record that is not even among the tied deliverers at all —
`OBA-773` (`done`, records `#336`; tied set `{#339, #341}`) — the one case where the
frozen record is arguably WRONG rather than merely unresolvable. This is a DIFFERENT
figure from the ADR's own earlier "~54 at `ff5f36c2`" — that count is a different ref and
is kept beside this one, not overwritten by it; a newer measurement does not erase an
older one pinned to its own sha.

**Decided: report, do not mutate.** 72 of the 73 hold a record that IS one of the
plausible deliverers — reconcile simply cannot prove which one delivered it. Overriding
write-once to clear all 73 (or all 72, sparing only the 1 provably wrong) would destroy
up to 72 probably-correct records that **nothing can restore**: reconcile is the only
producer of `branch`/`pr`, and neither field is in `EDITABLE_FIELDS`. Fixing 1 record by
destroying up to 72 is the wrong trade, and it would reverse write-once — a deliberate
design rule with its own history of three prior shapes of wrong (§1) — to make it. So
reconcile now emits a finding of a new kind, `terminal-record-unverifiable`, on exactly
this condition (`d.recordAmbiguous && keep()`), and never touches the record. Volume is
controlled the same way a raw per-ticket count would otherwise bury the one finding that
matters: the `recordOutsideCandidates` case (`OBA-773`'s shape) is reported on its own,
per ticket; every other affected ticket is folded into ONE aggregate finding per run that
still names all of them in an `ids` array, so nothing is hidden, only not repeated once
per terminal ticket.

**This is a finding on the STATE, not the ROUTE.** Reconcile cannot see that a ticket was
hand-moved — it can only see a terminal ticket already holding a record it cannot verify.
The condition this reports is therefore a SUPERSET of "hand-moved": any route that leaves
a ticket terminal-with-a-record before its merged set becomes unresolvable trips it, not
only a hand-move.

**What remains open.** Reconcile still cannot identify which of the tied PRs actually
delivered a ticket — that inference is rejected here for the same reason §1 rejects a new
inference path for the half-recorded case: it is exactly the shape that has already
failed three times. `pr` is still not in `EDITABLE_FIELDS`, so `OBA-773`'s one
provably-wrong record must be repaired by hand, or not at all.
### 6. A change entry is not a claim of a move

**BLZ-401 — `r.changes` conflated "this ticket's file changed" with "this ticket's
status moved".** The per-ticket loop pushes an entry onto `changes` whenever `dirty`,
and `dirty` can be set by a resolution backfill or a record clear/fill with the status
never changing at all — `d.moved` was already computed correctly, but the CLI printed
every entry as `would move <id>: <from> → <to>` regardless, and `from === to` for a
non-moving entry, so a `done` ticket with a blank `resolution` read as `would move
INF-645: done → done` — a status line for a move that never happened. The `--apply`
commit message compounded it: it counted `changes.length`, so a run that only backfilled
a resolution on three already-`done` tickets committed a message claiming "3 tickets"
moved when zero did.

**Decided: keep the entry, stop the renderer conflating it with a move.** Dropping a
non-moving entry from `changes` was rejected outright — a `cleared` record deletion
(§1 above, BLZ-398) is *also* `moved: false`, and dropping it would erase the only
machine-readable account of the one direction reconcile destroys data. `changes` stays
"what this run did to the file"; `moved` stays "whether the status changed"; the fix is
in the two READERS (the CLI line, the commit message), not in what gets recorded. A
non-moving entry now renders as `updated <id> (still <status>): <what changed>` — its
resolution backfilled, its branch/pr recorded for the first time, and/or (the existing
`cleared` suffix, unchanged in wording, working in both the move and non-move branches)
cleared because no single PR delivered it. The `--apply` commit message and the CLI's
own summary line both state two quantities: tickets whose status actually moved, and —
only when it is non-zero — tickets updated without a status change. Hiding the second
number was rejected for the same reason as dropping the entry: a commit touching three
files that says "1 ticket" replaces an overstatement with an understatement, not with
the truth.

### 7. A ticket a single-project run cannot reconcile is reported, not resolved

**BLZ-406 — a ticket a single-project run can never reconcile, and nothing said so.**
`--project <KEY>` (§3 above, BLZ-394) scopes on the ticket's DIRECTORY
(`keys.includes(t.project)`), because blast radius is a property of the path. The
signal map that would move a ticket is keyed by its FRONTMATTER `project`
(`sig.get(t.frontmatter.project)`). A ticket filed at `projects/OBA/defined/INF-2-t.md`
carrying `project: INF` is therefore reconciled by **neither** single-project run: a
`--project OBA` run excludes it by directory before the signal is even consulted, and a
`--project INF` run finds no `INF`-keyed signal for a ticket the scan never scoped in
under that key (the signal map was built for the projects actually named, and this
ticket's directory is not one of them). Only an unfiltered run reaches it, through its
frontmatter key. Exit 0, no finding, no warning — indistinguishable from an in-sync
board, which is the INF-763 lesson in a new place.

**Decided: the directory wins, and the mismatch is reported, not resolved either way.**
Two separate questions were at risk of being collapsed into one. *Which key is
authoritative for where a write lands* is not open for re-litigation: the directory is
status (ADR-0001), `walkTickets` in `scripts/model/index.mjs` yields it first-class from
the walk with a BLZ-271 comment stating frontmatter `.project` is "NOT a substitute",
and BLZ-394's directory-based scoping is UNCHANGED here — deliberately, this ADR is not
reopening it. *Whether the ticket can be reconciled at all* is the real, separate
question, and the answer is no: its id is `INF-2`, so the `OBA` project's `idFromRef`
will never match it, and there is no signal to apply under either key. Un-sticking the
signal lookup to follow the frontmatter instead would silently launder a filing error
into a normal reconcile — the corpus is genuinely wrong (a ticket sitting in the wrong
project's directory), and resolving that silently one way is exactly the shape of wrong
this ADR's other decisions have already rejected (§1's terminal-sticky veto, §3's
directory-scoped blast radius). So reconcile emits a `project-mismatch` finding naming
the ticket, its directory, and its frontmatter key, on **every** run — filtered or not,
including the one that filters the ticket out of scope entirely — because the silent
skip is the whole defect this finding exists to close.

**`blaze audit` gets the same check, HARD (BLZ-406 AC-3).** `auditCorpus` is pure over
frontmatter and cannot see the directory a ticket sits in; the audit RUNNER can, the
same way it already does for `duplicate-status` and
`terminal-goal-unverified-requirement`. Decided HARD rather than soft: a misfiled ticket
is a wrong corpus, not an unfilled one, which is the test `scripts/model/audit.mjs`'s own
header sets for HARD. Licensed by measurement, per the BLZ-353 lesson that a hard finding
shipped on an unmeasured assumption fails the live board on day one — re-verified at
blaze-pm branch `BLZ-305-v4-spine` (`1d172e1e6edfe481465609c9dfd05bd97f6b8930`), across
2,682 tickets in 11 projects: tickets whose `frontmatter.project` differs from their
directory, and tickets whose id prefix differs from their directory, both measure
**zero**. See [`commands.md`](../guide/commands.md#audit).

## Consequences

- Reconcile is closer to trustworthy enough to re-enable on `blaze-pm`, which is
  what BLZ-189 asks for. It is not re-enabled here; that is a separate decision
  with its own soak.
- Both changes bias the same way: when reconcile cannot tell, it does not say
  `done`. BLZ-131 moves tickets *to* done, so it is gated on git-side evidence
  (a bullet on the default branch) rather than on forge-side prose.
- ADR-0003's bundled-child signal is unchanged in principle and widened in reach:
  the signal is still "a commit reachable from the default branch says this
  shipped", and BLZ-131 only corrects *where in that commit* the engine looks.
- The squash-message setting becomes a documented prerequisite for auto-moving
  bundled children in any repo Blaze reconciles.
