# ADR-0023: Reconcile's signals bias toward not-shipped

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-08-25 |
| **Deciders** | Ryan Howman |

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

A terminal ticket's `branch` and `pr` are clamped along with its status. The first
cut clamped `target` alone, which suppressed the move and rewrote the record anyway:
a `done` epic delivered by merged PR #80 had its frontmatter repointed at the later
OPEN #81 that now wins the rank, reported as `moved: false`. Those fields are the
history of what delivered the ticket, not live state.

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
subject as a `* ` bullet. On this repo, **22** of 312 commits on `origin/main` carry
such a bullet under a ticket subject — **99** bullet lines in total — and reading them
recovers **28** ticket ids that no subject on the default branch mentions. That is the
blind spot, measured rather than argued.

**Two conditions must both hold, and each is load-bearing.**

1. The marker is `* `, which is what GitHub writes and what nothing else here writes.
2. The commit's own subject must parse as `<KEY>-<n>:` — it must itself be a squashed
   *ticket* PR. This is BLZ-131's own premise: a bundled child lives inside a feature's
   PR, and a feature PR is titled `<KEY>-<n>: …` by house convention.

Condition 2 was not in the first cut, and an adversarial review is why it exists.
`scripts/commit-runner.mjs` writes every batch board commit's body as
`- <KEY>-<n>: <board op> [session]`, and the board repo is itself a configured
`codeRepo` for its own project — the hazard INF-735's comment already names. Honouring
any bullet under any subject therefore turned the board's own ledger into a delivery
signal. Measured on the live board, and reproduced end-to-end by the review: **299**
ids harvested that had shipped nothing, and `decide()` moving **137** tickets
`defined → done` off lines reading `edit labels` and `defined → in-progress`. That is
this ADR's own §1 failure at a hundred times the scale, re-introduced inside the fix
for its sibling.

Narrowing the marker alone was not sufficient, and neither was the subject gate alone:

| Rule | Ids harvested on the board repo that shipped nothing |
|---|---|
| Any bullet, any subject | 299 |
| Any bullet, ticket subject only | 41 |
| `* ` bullet, ticket subject only | **2** — and both are genuine bundled children |

**A claim this ADR made in an earlier draft, withdrawn.** It argued that the bullet
requirement was load-bearing because unbulleted body lines beginning `<KEY>-<n>:`
would otherwise mark "sixteen untouched tickets" done. Re-measured under the shipped
rule, unbulleted lines inside gated commits add **zero** ids — the sixteen lived in
commits the subject gate now excludes anyway, and the figure had also counted lines
where it said tickets. The bullet requirement earns its place on the ledger evidence
above (41 → 2), not on that argument.

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
