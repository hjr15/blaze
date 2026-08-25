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

**Cost, accepted:** a delayed `done`. A ticket waits in `in-review` until the last
PR carrying its key closes. That is the safe direction — the board understating
progress is recoverable by looking; overstating it is not.

### 2. The shipped signal reads a squash commit's body, and requires a bullet

GitHub's default squash message concatenates the collapsed commits' messages, each
subject as a `* ` bullet. Verified on this repo's own history: 104 commits carry
bulleted `<KEY>-<n>:` body lines, and **30 ticket ids appear only there** — the
blind spot, measured rather than argued.

The bullet is required, and that is the entire safety argument. Over the same
history, unbulleted body lines beginning `<KEY>-<n>:` are common and are *not*
evidence of delivery — plan listings (`BLZ-103: config-schema versioning +
migration guard`) and ordinary prose that wrapped onto a ticket id. Accepting them
would have marked sixteen untouched tickets `done`: BLZ-130's failure reintroduced
through the other door, inside the fix for its sibling.

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
*divergent intents* — two sessions each asserting something different about the
same ticket. Reconcile has no intent. It is a deterministic, idempotent function of
git state, so two sessions running it converge on the same answer rather than
racing; scoping it to a session would add a merge step to reach a result both
sessions already agree on.

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
