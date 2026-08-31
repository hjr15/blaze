# ADR-0035 — "nothing to commit" is a settled drain, not a failed one

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Ryan Howman
- **Ticket:** BLZ-590 (the drain), BLZ-502 and BLZ-422 (the same shape, one layer up)

## Context

`blaze commit` stages the files its queued ops recorded, commits them, and clears the
queue. On 2026-08-31, draining the 210 ops [ADR-0033](0033-the-queue-store-is-one-per-repository-not-one-per-working-copy.md)
had just consolidated, it printed:

```
On branch BLZ-305-v4-spine
nothing to commit, working tree clean
blaze commit: git commit failed (status 1) — ledger kept, resolve manually
```

Nothing had failed. Every op was **orphaned** — `blaze commit --status` read *0 outstanding,
20 orphaned* — because each op's recorded file had already been filed by hand during the
weeks the flush was broken. `git add` therefore staged nothing, `git commit` exited 1
because there was nothing to commit, and the runner read that exit code as a failure.

Two consequences, both wrong, and the second self-perpetuating: the operator was told to
*resolve manually* a situation with nothing to resolve, and **the ledger was kept**, so the
queue never emptied and every later run hit the same wall. **A board whose recorded work is
entirely settled could never drain.**

This is the third appearance of one shape:

| | conflated | separated by |
|---|---|---|
| BLZ-422 | "the staged tree already matched HEAD" vs "a commit exists" | a `committed` field, distinct from `ok` |
| BLZ-502 | `git add` failing vs `git commit` failing | a `step` field carried on the return |
| BLZ-590 | *nothing to commit* vs *the commit failed* | this ADR |

Each time, one exit code was carrying two facts and the caller composing the sentence had
no way to recover which.

## Decision

**A drain that stages nothing because its ops' recorded files already match HEAD is
SETTLED: the queue is cleared, what happened is said plainly, and the run exits 0.**

**A genuine commit failure — a hook refusing, a bad signature, a lock — still keeps the
queue, exits non-zero, and claims nothing about the work having been filed.**

**A drain that is partly settled commits the real part, settles the rest, and reports both
counts.** No op is silently dropped and none is committed twice.

**`absent` is a third bucket, and is never called `settled`.** An op whose every recorded
path is in none of the trees git keeps records nothing git can commit *and* nothing git can
compare to HEAD. Calling that "already matches HEAD" attests a comparison that, by
definition, was not made. `outstandingFiles` (`scripts/pending-ledger.mjs`) has kept
`outstanding` / `settled` / `absent` apart since BLZ-499 *"because two would lie"*; the
commit path now reports in the same vocabulary, with a sentence each.

**Absence is read from THREE trees, because there are three and they disagree.**
`existsSync` reads the **working tree**; `git ls-files --error-unmatch` reads the **index**;
`git cat-file -e HEAD:<path>` reads **HEAD**. An earlier attempt at this ADR read the first
two and made claims about the third. `git rm <boardfile>` — an ordinary hand action —
falsifies that outright: the path is in neither the working tree nor the index, but it *is*
in HEAD and the index holds a staged deletion, so `git diff --cached` reports a difference
and there is real work to commit. Reading two trees dropped the path, left the staged
deletion behind in the index, and called the op superseded. All three are read now, and the
commit pathspec is the wider list — `git add` refuses a pathspec matching nothing in the
working tree or index (measured: exit 128), and does not need to, because the deletion is
already staged and `git commit -- <path>` records it.

**Absence is only "superseded" in the checkout the op says queued it.** Which checkout that
is comes from the op's own record — `worktree` when stamped, else `branch` — never from the
local filesystem. The local filesystem cannot answer it: `belongsHere` holds a
branch-recorded op back only while some *other* worktree currently has that branch checked
out, and `checkBranch` returns ok unconditionally on the default branch
(`scripts/branch-guard.mjs`), so a checkout on `main` has no second guard. **All 210 live
ops are exactly that shape** — `branch` recorded, `worktree` not. The moment a lane finishes
and its worktree moves off its branch, a drain from `board-main` would find none of that
lane's files present. `blaze publish` runs `commit-runner --all` unattended, so it would
fire silently at exit 0. "They can never be staged; no later run changes that" was
checkout-local reasoning applied to a store BLZ-556 deliberately made **repo-global**: a run
in the other checkout can stage them, and `git checkout HEAD -- <path>` restores the
`git rm` one.

So:

- **absent + provenance is this checkout** → superseded here. Cleared, and named. Its own
  checkout is the one place that can read absence as supersession, and holding it anyway
  would rebuild the un-drainable queue this ADR exists to remove.
- **absent + provenance is elsewhere, or not recorded at all** → **not this run's to judge.
  Put back in the queue, reported, exit 3** — the same treatment a foreign op gets, and the
  base's safety property kept. It costs the operator nothing: each lane drains its own ops
  from its own checkout, which is how the 210 are laid out.
- **an op recording zero paths** → nothing was measured, so nothing is claimed. Put back and
  reported. Not reachable from any current writer, and 0 of the 210 live ops have it.

**Correcting a false claim made in an earlier revision of this ADR.** It said the exposure
was limited to entries carrying *neither* `worktree` nor `branch`, and that the risk was
*"identical in the behaviour this replaces — it fires whenever the batch commits anything"*.
Both are wrong. The exposure is the far commoner `branch` recorded / `worktree` absent shape
— every live op. And the risk is **not** identical: the case this ADR adds is the batch that
commits **nothing**, which the base reported as a failed commit and whose ledger the base
**kept**. That is a new way to lose a record, not an existing one, and the provenance gate
above is what removes it.

**The two are told apart by asking the INDEX, never by matching git's message.** The fact is
`git diff --cached --quiet -- <the op's own recorded paths>`, asked per op with the same
pathspec `git add` was given. `nothing to commit, working tree clean` is a *message* —
localisable, version-dependent, and not a contract — and this codebase has been refuted
before for pinning a spelling where a property was meant.

[ADR-0030](0030-a-run-that-could-not-look-does-not-report-what-a-run-that-looked-reports.md)
applies unchanged: the probe is two-valued by contract, so any third answer, and a spawn
that never ran, is an absence of evidence. Such an op is bucketed *unknown*, is committed
with the rest, and is never reported as already filed.

## Consequences

- The queue can now drain to empty from any state it can legitimately be in. That was the
  property missing on 2026-08-31, and it is the point of the change.
- **Settling is not committing, and must never become it.** Clearing a queue whose work
  never landed destroys the record of that work — strictly worse than the bug this
  replaces, which at least kept it. The failure path keeps the ledger, and a test holds
  each side apart on its own.
- Exit 0 from `blaze commit` now means "the queue is drained", by a commit, by finding its
  ops already filed or superseded, or by any mix — not "a commit was made". A caller that
  needs to know whether HEAD moved must read the stdout line or git, not the exit code.
  This matches BLZ-422's `ok` / `committed` split rather than widening it.
  **One caller was broken by that widening and is fixed here:** `scripts/publish-runner.mjs`
  printed *"the local sweep committed"* on both of its failure paths off the sweep's exit 0.
  It cannot read what the sweep said (`stdio: "inherit"`), so it now compares HEAD across
  the sweep and reports what that shows — including "could not be determined" when git does
  not answer.
- **A commit message may only describe what the commit contains.** `summarizeEntries` ran
  over the whole drain, so one outstanding op alongside two already-filed ones wrote
  `(3 new)` onto a one-file commit. Subject and body are now composed from the ops that
  actually entered the commit.
- The per-op probe costs one `git diff --cached --quiet` per queued op. Measured against
  the alternative of one batch probe: the batch answer is derivable from the per-op
  answers (every staged path belongs to some op), the reverse is not, and the report needs
  the per-op split.
