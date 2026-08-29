# ADR-0032 — a queued write is a fact blaze recorded, not a shape git reports

- **Status:** Accepted
- **Date:** 2026-08-29
- **Deciders:** Ryan Howman
- **Tickets:** BLZ-432 (the cross-pass design question), BLZ-499 (the surface this decision calls
  for), BLZ-433 (the wording defect underneath it), BLZ-128 (the alleged silent route, closed
  `cannot-reproduce`)

## Context

**BLZ-432.** `reconcile --apply` files only the current pass's own decisions — `touched`, the exact
list of files that pass wrote. Whether the board's ticket tree also carries a write left uncommitted
by an EARLIER pass is invisible to it. Four rounds of BLZ-404 tried to close that gap and each
attempt was refuted: a recovery write with an unbounded blast radius (it swept a human's `NOTES.md`
and another project's files into a reconcile commit, and reintroduced the porcelain path parser
BLZ-347 deleted); then a detect-and-report boolean that conflated three board states, exited 1 over a
healthy `commitMode: "batch"` queue, wedged permanently on a human's untracked file, and still
UNDER-fired on the symlinked-`projects/` case it was written to close. Round 5 deleted the detector
and corrected only the over-claiming `already in sync — nothing to do.` sentence beneath it.

Round 5 also recorded, without evidence, that telling those states apart "needs the pending ledger,
not `git status`". This ADR supplies the evidence, and acts on it.

**The measurement, which had never been taken.** Read-only, at `blaze-pm`
`70197405c278bc404ff92d0743e58c06406def62` (branch `BLZ-305-v4-spine`; 345 commits over 45 days,
2026-07-15 to 2026-08-29):

| Observation | Value | What it means |
|---|---|---|
| `git status --short` over the whole board | **0 lines** | no uncommitted ticket write exists — one sample, taken seconds after a flush |
| undrained ops in `.blaze/pending/` | **185**, in 8 of 14 queues | queued 2026-08-24 to 2026-08-27; every file they name already matches HEAD |
| of the 118 traceable ones, filed by a `blaze commit` flush | **0** | the flush path filed none of them |
| of the 118, filed by a hand-written commit | **118**, across 61 commits | a human files the board; the queue is abandoned |
| longest a traceable write waited before something filed it | **5.65 h** (p90 ≈ 2 min) | nothing survives a working day unfiled |
| board commits authored by `blaze commit` | **116 of 345 (33.6%)** | the flush is the minority path |

A fourth source was tried and discarded: comparing a committed blob's `updated:` frontmatter against
its commit date suggested 76% of writes were filed a day or more late. That figure is an artifact and
is not used. `reconcile.mjs` stamps `updated` only when a ticket MOVED (`if (d.moved) { fm.updated =
today; … }`), so its non-move writes carry a stale stamp by construction — verified at `fdb1375e`,
where 56 tickets gained `branch:`/`pr:` lines with `updated:` untouched. It is recorded here so it is
not re-derived and believed.

**What the measurement changes.** The condition BLZ-432 names was measured at zero. A different
condition — an orphaned session queue — was measured at 185 ops standing for five days. On a
`commitMode: "batch"` board the ticket tree is uncommitted BY DESIGN between every verb and the next
flush, so a cross-pass tree detector would have fired on approximately every applied pass and caught
nothing. That is design 2's defect, re-derived from data rather than from a review.

## Decision

### 1. Reconcile does not detect a cross-pass uncommitted tree, and this is now a MEASURED decision

Round 5 stands. `reconcile()` gains no probe, no flag, no field and no exit code for this condition,
and `scripts/reconcile.mjs` is not modified. Reconcile knows one thing — whether THIS pass found a
code-bound change to make — and says exactly that.

What is new is the standing: this was an argument from a review, and it is now a decision with a
figure behind it. A monitor whose measured true-positive count over 45 days is zero, and whose
false-positive state is the board's normal steady state, is not built. BLZ-353's rule — measure
before any severity or behaviour change — is what settles it.

### 2. The oracle is the LEDGER, not the tree, and it belongs to `blaze commit`

Every rejected design asked git what the tree looks like. That question cannot be answered usefully:
a dirty ticket file looks identical whether a verb wrote it, a verb wrote it and failed to commit, or
a person wrote it.

The answerable question is a different one — *what did blaze record that it wrote?* — and blaze
already keeps that record. A pending-ledger entry stores repo-relative paths written by blaze itself
(`commit-or-queue.mjs`, `files: unique.map((f) => relative(root, f))`). Whether a recorded write is
still outstanding is one exit code per recorded path:

```sh
git -C <root> diff --quiet HEAD -- "<path recorded in the ledger>"
```

Paths go IN, after `--`; only an exit code comes OUT. Nothing parses a path out of git's output, so
BLZ-347's deleted parser is not reintroduced, and a filename with a space or a non-ASCII character
cannot wedge it. Nothing walks `projects/`, so a symlinked `projects/` cannot silence it — the case
design 2 was written to close and missed.

**The recorded path is not automatically the path git knows, and assuming it was cost this design a
review round.** `commitOrQueue` records `relative(root, f)` and nothing in `config.mjs` calls
`realpath`, so on a board whose `projects/` is a symlink the ledger holds the through-symlink
spelling while git's index holds the real one. `ls-files --error-unmatch` then never matches, and
EVERY op on such a board reports `outstanding` forever — including the already-filed ones this verb
exists to find. That is the OVER-fire twin of design 2's under-fire, on design 2's own fixture, and
it corrupts the verb's headline distinction. The implementation therefore resolves each recorded
path's longest existing prefix and re-relativises it against the real root before probing, and
reports under the recorded spelling, which is what the operator has on disk. Resolving a PREFIX
rather than the whole path is what keeps a move's already-deleted old path answerable.

Verified directly, end to end through the real `blaze new` runner on a symlinked batch board:

| probe | symlinked `projects/`, op already filed | symlinked, op genuinely unfiled | `ZZZ-1 spaced ünicode.md`, dirty |
|---|---|---|---|
| `git status --porcelain -- projects/` (design 2) | empty, exit 0 — **under-fires** | empty, exit 0 — **under-fires** | n/a |
| probing the RECORDED path verbatim | `outstanding` — **over-fires** | `outstanding` (right, by luck) | fires |
| probing the RESOLVED path (shipped) | **`settled`** | **`outstanding`** | **fires** |

The owner is `blaze commit`, which owns the queue. Reconcile does not own it, cannot see whether one
exists, and derives its answer from git rather than from anything a session wants (ADR-0023 §3).

### 3. TWO of the three states are decidable and the third is declared UNDECIDABLE rather than asserted

For a ticket file under `projects/` that differs from HEAD:

| State | Decidable | By what |
|---|---|---|
| (b) batch-queued by design | **yes** | a ledger entry names the file |
| (c) a human's own in-flight file | **yes, negatively** | no ledger entry names the file |
| (a) a genuinely failed prior commit | **NO** | nothing durable distinguishes it |

State (a) leaves no trace after the fact. On a `per-op` board no ledger entry is ever written; on a
`batch` board a failed flush KEEPS its queue by design, so it is byte-identical to a healthy queued
one. This is stated rather than papered over, because design 2's specific defect was claiming to
separate three states while separating none.

State (a) is not silent. It is reported at full volume by the pass that causes it — **at the invoking
surface, which is not always a process exit**: `FAILED TO COMMIT — … already written to disk and now
UNCOMMITTED (a dirty tree), not merely un-applied` on stderr with a non-zero exit for the CLI
(`tests/reconcile-commit-routing.test.mjs:247-258`), and a published error event for the supervisor
loop, which never exits at all (`:163`). On a `commitMode: "batch"` board the failure point moves
again: reconcile queues rather than commits, so a commit failure surfaces from `blaze commit` at
flush time, not from reconcile at pass time.

Saying simply "it exits 1" would be true of one surface and false of the other — the over-claim
ADR-0030 forbids — so this ADR does not say it.

BLZ-128 alleged a silent route to state (a) (a stale old-path pathspec in `git add`) and would have
overturned this reasoning had it held. It was verified independently against `1b00f3a` with live
fixtures and closed `cannot-reproduce`: the pre-rename `touched.push(t.file)` is load-bearing, not
stale — with no `git add -A` anywhere (deliberate; `serve-commit.mjs`), naming the old path is the
only way to stage the DELETION side of the rename, and BLZ-128's own AC-2 would have broken it. The
whole-pathspec rejection is reachable only for a ticket whose old path was never committed, and fails
loudly there.

What is missing is only a reminder on a later pass, and that is not worth a durable failure record
with its own write-failure mode and its own garbage to collect. Refused, in writing, so it is not
re-proposed.

### 4. The report is READ-ONLY, and the read-only-ness is pinned, not asserted

`blaze commit --status` reads the ledgers and runs `git diff --quiet`. It stages nothing, commits
nothing, and clears nothing — including the orphaned queues it names, whose clearing is a separate
decision. It returns before the branch guard, the lock, the `git add` and the `git commit`, the same
position `checkBranch` occupies and for the same reason: a read must leave nothing half-made.

`blaze commit` stays `mutates: true` — the flush very much mutates. What makes this ONE
invocation runnable under `BLAZE_READONLY=1` (BLZ-121) is `readOnlyFlags: ["--status"]` on the
verb's table entry, an opt-in per-invocation exemption, so every other spelling of the verb is
still refused. Declaring the whole verb read-only would have been the wrong fix, and
that is pinned by a test rather than left to the flag's declaration.

Consequently BLZ-394's blast-radius rule is untouched: the set of files a reconcile commit can name
is still exactly `touched`, and the set a flush stages is still exactly the files recorded against
drained ops. Nothing here widens either, because nothing here commits.

### 5. The last unqualified "sync" claim is removed and pinned

`cli.mjs` described reconcile as `"sync board status to git/PR state"`, rendered to the operator as
`usage: blaze reconcile — sync board status to git/PR state`. It named the whole board, promised a
settled two-way state, and omitted that the verb is dry-run by default — the last surviving instance
of the claim BLZ-404 round 5 removed from every other surface, and pinned by no test. It is replaced
with a bounded description, and a test now pins it so it cannot drift back.

## Consequences

- Reconcile is unchanged. No new flag, field, exit code, probe or failure mode; `scripts/reconcile.mjs`
  is not modified by this decision.
- An operator gains one read-only surface that makes an abandoned queue visible on the day it is
  abandoned, instead of five days later by accident.
- **Cost, accepted:** state (a) remains undecidable after the fact, and `--status` will not surface a
  `per-op` board's failed commit at all, because a `per-op` board keeps no ledger. Both are stated
  in the `--status` report's own trailer rather than left to be discovered.
- **Cost, accepted:** `--status` reports queues belonging to sessions the caller does not own. That is
  deliberate — the 185 orphans span several — and it is a read, never a write, so BLZ-394 is not
  engaged.
- The decision has a scheduled expiry: BLZ-254 retires the git write path in favour of the database,
  at which point the ledger, the flush and this verb are all superseded.

## Alternatives rejected

- **A cross-pass detector in reconcile, in any form.** Rejected on measurement: zero true positives
  over 45 days and 345 commits, against a false-positive state that is the board's normal steady
  state on a `batch` board. This is the fourth rejection of this shape and the first with a figure.
- **A recovery sweep that finishes a previous pass's commit** (BLZ-404 round 2). Rejected already,
  and not narrowed here — nothing in this decision files anything. Its discovery step could not be
  made safe: it named files blaze never wrote, and parsed those names out of porcelain output.
- **A durable failed-commit record**, to make state (a) decidable later. Rejected: it adds a
  persistent artifact, a new failure mode when the record itself cannot be written, and a garbage-
  collection problem, to catch a condition measured at zero and already reported at exit 1 when it
  happens.
- **Having `--status` clear the orphaned queues it finds.** Rejected: a read-only verb that deletes is
  not a read-only verb. `blaze commit --all` already drains them safely; whether stale queues should
  expire on their own is a separate decision on its own ticket.
