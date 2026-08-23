# ADR-0019 — The groomer's guard is advisory; the boundary is `enabled: false` and operator consent

- **Status:** accepted
- **Date:** 2026-08-23
- **Ticket:** BLZ-347
- **Supersedes:** the first draft of this ADR, which claimed a full-tree containment
  boundary. A security review defeated that claim three ways with live repros. The claim
  is withdrawn; the mechanism it described is kept and hardened, under an honest name.

## Context

`groomOnce` filtered `git status --porcelain` down to the configured groomable status
directories *before* any guard ran, so the rename guard, `isStructuralChange`, the revert
and the auto-commit only ever saw that filtered set. Anything written outside those
directories was never seen, never refused, never reverted. `blaze.config.json` holds
`agentCommand` — the string the *next* pass executes — and sits outside every status
directory, so the loop could rewrite what it would run next.

The first fix surveyed the whole `git status` output instead of a filtered slice and
called that containment. Review showed `git status` cannot carry that claim.

## Decision

**The guard is advisory defence-in-depth. It is not a boundary, and no code comment, doc
or ADR may describe it as one.**

The actual boundary is three things Blaze does not implement and cannot fake:

1. **`loops.groomer.enabled: false`** — the shipped default. Honoured at
   `supervisor.mjs:251`, pinned by tests in `tests/config.test.mjs`.
2. **The operator's decision to turn it on**, per board, knowing what it does.
3. **The permission posture of whatever `agentCommand` names.** Blaze spawns a process
   with the operator's own privileges. It cannot stop that process writing anywhere the
   operator can write. A sandboxed agent CLI is contained; an agent run with permissions
   bypassed is not, and that is not a property Blaze can supply from outside.

This is the third of the three options BLZ-347 offered — "the agent is trusted and the
guard is advisory" — chosen on evidence rather than by default. The ticket required that
choosing it means correcting the misleading `isStructuralChange` docblock; that is done,
along with the same false claim in `docs/design.md`.

## Why detect-and-revert cannot be the boundary

Each of these was a working repro against the reviewed implementation, not a theory.

- **The detector was itself an execution sink.** `core.fsmonitor` in `.git/config` names a
  program git executes on `git status`. The containment survey fired an attacker's script
  five times in one pass and still reported a clean groom. Measured independently here:
  one execution per `git status`, two more across `git add` + `git commit`. A detector that
  runs attacker-controlled code *while detecting* cannot be made into a boundary by
  effort.
- **`.git/` is inside the data root and invisible to `git status`.** A dropped
  `pre-commit` hook was executed by the groomer's own auto-commit and reported as a clean
  groom.
- **Gitignored paths are invisible to it too.** `.gitignore` covers `.blaze/` wholesale, so
  the index, a database DSN pointing at an attacker host, and a `commit.lock` directory
  that wedges every other Blaze write all survived a "successful" pass.
- **Detection is after the fact by construction.** A network call, a write outside the
  root, or a process that outlives the pass leaves no diff to find.

## What the guard now actually does

Worth keeping — it turns the specific self-escalating loops into loud, reverted refusals —
and materially stronger than what was reviewed:

- **The survey primitive is a filesystem hash snapshot of the data root, not `git status`.**
  That closes the `.git/`, gitignored, C-quoted-path and dropped-rename blind spots in one
  move. `parsePorcelain` was deleted rather than repaired: it dropped the `old` side of a
  rename and misparsed non-ASCII paths badly enough to brick a board, and it now has no
  caller.
- **Every git invocation is hardened** with `core.fsmonitor=false` and
  `core.hooksPath=/dev/null` (`GIT_HARDENING`). `commit --no-verify` was considered and
  rejected as strictly weaker — measured, it skips pre-commit and commit-msg but still
  runs post-commit.
- **Containment is file-level**: the only in-bounds path is the ticket being groomed, which
  is what the prompt already tells the agent. Directory-level let a pass delete every
  sibling ticket and commit it as a clean groom.
- **The revert is per path and content-first.** Batching every path into one
  `git restore --staged -- <all>` meant git failed the whole pathspec list whenever it
  contained one untracked entry, so a mixed tracked/untracked set reverted *nothing* while
  still reporting `refused: true`. That was a plain bug and is fixed independently of any
  of the above.
- **The result is verified by re-observing the tree**, not by trusting that the revert
  commands ran. A revert that did not clean the tree reports `revertFailed`, the residual
  paths, and the errors that were previously swallowed.
- **Any symlink in the touched set is refused** and the walk never follows one.
- **Secret redaction has generic arms**, not only a vendor-prefix allowlist. The allowlist
  leaked `glpat-`, `xoxb-`, `AIza…`, `ASIA…`, `sk_live_`, `hf_`, `npm_`, raw AWS secret
  keys and JWTs during review.

## Alarm quality is part of the guard, not decoration

A guard whose alarm fires on ordinary conditions is a guard that gets ignored, so the
report is held to the same standard as the mechanism. Three rules fell out of review:

- **An alarm must be baselined against what it did not cause.** The revert check
  originally tested `git status` for any output at all. On a board with ordinary
  uncommitted work that meant `revertFailed: true` on every refusal, next to
  `residual: []` — the same event claiming the revert failed and that nothing was left
  behind — while the console printed the operator's own files as "still dirty". The
  porcelain check is now compared against a baseline captured before the agent runs, so
  only dirt this pass introduced counts.
- **Keep a check that observes something the others cannot.** The porcelain term was
  baselined rather than deleted: `residual` is a *content* diff and never looks at the
  index. An agent that stages a change and then restores the file's bytes leaves
  before == after, so the path never enters the touched set and never reaches the revert,
  while the index still diverges from HEAD. Only git sees that.
- **Do not conflate two different failures under one flag.** `surveyIncomplete`
  (truncated walk, unreadable region) is a **detection** gap and undermines every claim
  the guard makes. `restoreDegraded` (a file over the snapshot's content cap) is a
  **remediation** gap — the change is still detected, but the snapshot holds no bytes to
  put back. They are reported separately, and both name the region rather than raising an
  opaque boolean. Neither is baselined, and that is deliberate: a region the guard could
  not observe is unobserved whoever made it so.

## What it does not cover — the exhaustive list

- Anything that is not a file write inside the data root: network calls, writes outside the
  root, a process that outlives the pass.
- Writes through a symlink that **already existed** before the pass. A new or retargeted
  link is refused; one the operator put there is followed by the filesystem, not by Blaze.
- `.git/objects`, `.git/logs`, and git's transient index/`*_HEAD`/lock files, which the
  snapshot skips by name (`SNAPSHOT_SKIP_DIRS`, `SNAPSHOT_SKIP_FILES`). `objects/` is
  content-addressed: a write there cannot change what a ref resolves to and cannot execute.
- A tree larger than the snapshot caps. That is reported as `surveyIncomplete` on the
  event, never passed off as a clean tree.
- Races: anything that changes the tree between the survey and the commit.
- `agent_command` as a plaintext, user-writable **database** column
  (`scripts/model/config-schema.mjs`) — the same escalation reachable by a DB write rather
  than a file write. The file path is closed; the DB path belongs with the v4 storage work.
- A refused pass does not record the ticket as groomed, so a poisoned ticket is retried
  every interval. Pre-existing behaviour, left unchanged under a security fix.

## Consequences

- **The loop ships `enabled: false`**, and that is now load-bearing rather than cautious —
  it is item 1 of the boundary. `reconcile` stays enabled; it only runs git and moves files.
- **`spawnSync` still blocks the event loop.** `supervisor.mjs` calls `groomOnce`
  synchronously from the HTTP server process, so an agent run is a full board outage for
  its duration. Accepted, not fixed: async `spawn` changes the signature and every caller
  and test. It is bounded by the wall-clock `timeout` (default 900s, `killSignal: SIGKILL`
  — SIGTERM is deferred by a shell waiting on a foreground child, and a timeout that can
  itself hang is not a timeout), and the default flip means no install takes the outage
  unasked.
- **Untrusted ticket content is no longer last in the prompt**: a per-call 72-bit nonce
  delimits it and a guard restatement follows it.
