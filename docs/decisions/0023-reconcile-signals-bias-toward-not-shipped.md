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
that never had them recorded could never acquire them — on the board repo's `origin/main`,
1,064 of 1,594 `done` tickets **missing a `pr`**, permanently. Turning a corruption into a
silent omission is not a fix. (Two counts appear in this ADR and they are different
quantities, so each names itself: *missing a `pr`* is 1,064 of 1,594 at `blaze-pm`
`ff5f36c2`; *carrying neither field* is 1,056 of 1,594 at that ref, and 1,141 of 1,679 at
`cd4b1d9d`. The same conflation was in `decide()`'s comment in `scripts/reconcile.mjs`
and is corrected there too — a correction that fixes one instance and not its twin is
how this figure was wrong twice.)
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
third shape again, reached through the blank half. 8 of 1,679 `done` tickets at `cd4b1d9d`
are in that shape. So `hadRecord` is snapshotted from the ticket's frontmatter BEFORE
either field is written, and governs both: a terminal ticket with *either* field keeps
*both*.

**Cost, accepted:** a terminal ticket holding half a record never gains the other half —
8 of 1,679 at `cd4b1d9d` today, but the cost is **ongoing, not a fixed historical set**:
any ticket that reaches a terminal status while half-recorded and later has a merged PR
for its key is locked out the same way. That is
the same asymmetry as above — a blank `pr` understates and is true; a `pr` naming the
wrong PR overstates and is false, and write-once then locks it in permanently, since `pr`
is not in `EDITABLE_FIELDS` and `blaze edit` will not repair it. Recovering the *right*
PR for a half-recorded ticket (by corroborating `headRefName` against the recorded
`branch`) is a
separate change and is not made here: a new inference path is exactly the shape that has
already failed three times above.

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
