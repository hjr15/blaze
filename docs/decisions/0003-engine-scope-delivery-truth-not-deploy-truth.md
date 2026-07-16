# ADR-0003: Engine scope is delivery-truth, not deploy-truth

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-16 |
| **Deciders** | Ryan Howman |

## Context

Reconcile-completeness work on BLZ-43 surfaced two failure modes in how the
board mirrors git state:

1. **Bundled children don't auto-move.** A child ticket bundled into an epic
   PR (epic-PR-bundling workflow) is only a `<KEY>-<n>:` commit on the epic
   branch — it has no branch or PR of its own. `reconcile` found no signal
   for it, so it sat behind in `defined`/`in-progress` even after the epic
   PR merged, requiring a hand-move through every delivery status. (BLZ-117
   fixed this: a `shipped` signal now fires when the ticket's commit is
   reachable from the code repo's default branch.)

2. **"Merged" is not "deployed".** A ticket reaching `done` means its commit
   landed on the default branch. It says nothing about whether that commit
   is running anywhere. A GitOps dashboard can report Synced/Healthy while
   the live workload still runs a stale revision — merged and deployed are
   observably different states, and the board only ever spoke to the first
   one.

Fixing (1) forced the question behind (2): now that reconcile actively
infers ticket state from git signals beyond an owned branch/PR, should it
also infer state from *deploy* signals — should `done` (or some new status)
reflect what's actually running, not just what's merged?

## Decision

**The engine's `reconcile` mirrors delivery state only.** `done` means "this
ticket's commit is reachable from the default branch" — merged, not
deployed. Reconcile reads `git`/`gh` exclusively: branch existence, PR
state, and now (BLZ-117) default-branch commit reachability for bundled
children. It does not, and will not, read any deploy-side signal (a live
pod's running digest, a GitOps sync/health status, a rollout timestamp).

Deploy-freshness is a real and valuable signal, but it belongs to the infra
layer that has the deploy-side context to observe it — GitOps sync state,
the live workload's running digest, the observability stack that already
watches for exactly this drift. That capability is already delivered in that
layer (surfacing merged-but-not-yet-deployed drift as a metric, a dashboard
panel, and an alert), tracked and decided in that layer's own records. This
ADR does not restate those specifics — infra-layer design is out of an
engine ADR's scope.

**The board tells the truth about delivery. Infra observability tells the
truth about deployment. Two truths, two layers**, and reconcile stays
honest about which one it speaks for.

The bundled-children default-branch-commit signal added in BLZ-117 is
squarely delivery-truth (shipped = merged to default branch) and is
correctly in engine scope under this decision — it does not cross into
deploy-truth.

## Alternatives considered

**(a) An engine-generic "deployed ref" config surface.** Let a board
declare, per project, how to query its own deploy state (a URL, a command,
a ref pattern) and have `reconcile` fold that into a ticket's status or a
new field. Rejected: speculative generality. There is no second consumer
today — one infra-managed workload's deploy signal does not justify a
config knob every board author would need to understand, whether they have
a deploy step or not. The zero-runtime-dependency engine, and the "simple
for an AI to drive" design north star, both exist specifically to resist
adding surface area like this without a concrete need driving it.

**(c) A minimal engine primitive that an external (infra) consumer wires
up.** Expose some smaller hook or event `reconcile` emits that an infra
watcher could subscribe to, keeping the engine "just" a primitive and
pushing the deploy-awareness elsewhere. Rejected for the same reason as
(a): no concrete consumer exists today wanting this primitive, and adding
one speculatively is the same YAGNI trade dressed differently — it still
grows the engine's surface area against a need nobody has yet expressed.

Both alternatives are revisit-able: if a second, portable consumer of
deploy-freshness ever needs to plug into the engine, that's new evidence
and this decision should be reopened against it. Until then, the two-layer
split costs nothing and keeps the engine's scope legible.

## Consequences

- The engine keeps zero deploy awareness and zero runtime dependencies —
  `reconcile` never gains a dependency on a cluster API, a registry, or any
  deploy-side tooling.
- Deploy-freshness for any workload — this board's own deployment included
  — is exclusively an infra-layer concern, observed and alerted on where
  the deploy-side context actually lives.
- A future reader should not read the BLZ-117 `shipped` signal as a step
  toward deploy-awareness; it is a delivery signal (default-branch
  reachability), and this ADR is the line marking where delivery-truth
  ends and deploy-truth begins.
- If a future portable (non-infra-specific) consumer of deploy-freshness
  emerges, revisit alternative (a) against that concrete need — this
  decision is not a permanent prohibition, only a rejection of building it
  speculatively.
