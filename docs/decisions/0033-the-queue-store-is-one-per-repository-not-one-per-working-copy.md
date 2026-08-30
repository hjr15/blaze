# ADR-0033 — the queue store is one per repository, not one per working copy

- **Status:** Accepted
- **Date:** 2026-08-30
- **Deciders:** Ryan Howman
- **Tickets:** BLZ-556 (this decision), BLZ-525 (the `/data` mount the flush needed first),
  BLZ-529 (why draining ahead of the mount fix destroys the evidence), INF-673 (the
  foreign-branch guard this decision must not swallow), BLZ-124 / BLZ-498 (the session-scope
  rule this decision must not change)

## Context

`.blaze/pending/` was resolved against whichever working copy the process ran in. Every linked
worktree of the board repo therefore had a queue store of its own, and an op was queued into
whichever one the agent happened to be standing in. Counted three times independently on
2026-08-30, and re-counted at the close of this work:

| Working copy | Queue files | Ops |
|---|---|---|
| `blaze-pm` (main checkout — the only store the flush mounts) | 27 | **19** |
| `blaze-pm-worktrees/v4-spine` | 14 | **185** |
| `blaze-pm-worktrees/v3-phase0` | 2 | **6** |
| `blaze-pm-worktrees/board-main` | 18 | **0** |
| **Total** | | **210** |

The nightly flush mounts one store, drains it, and reports `outcome=published` having published
9%. Nothing in that exit code distinguishes "flushed everything" from "flushed the one store I
happen to mount".

**Refuted alternative, recorded so it is not retried.** Repointing the flush's hostPaths at
`board-main` — the checkout permanently on `main` — looks like the obvious fix and is *worse*.
It holds 0 ops, so the Job would exit 0 green every night having flushed nothing while 210 ops
accumulated elsewhere: invisible again, and this time believed fixed.

## Decision

**One queue store per repository, at `.blaze/` beside the repository's common git directory.**

`git rev-parse --git-common-dir` names the shared `.git` for any worktree of one repo — a linked
worktree's own `.git` is a *file* pointing there — so its parent is a single canonical location
for all of them. On the operator's board that parent is `blaze-pm`, which is the store the flush
**already mounts**. The flush needs no new mounts; the one it has becomes the only one there is.

This is the cause, not the symptom. The rejected shape of the same fix is a worktree-enumerating
flush: it needs N mounts, and it has to know the layout of the operator's disk.

### It is guarded, because `--git-common-dir` does not always mean the main working tree

Three layouts resolve it to something whose parent is **not** a working tree of this repo. Each
was verified by construction, not reasoned about (`tests/pending-ledger-queue-root.test.mjs`):

| Layout | `--git-common-dir` | parent would be |
|---|---|---|
| bare repo | `.` | the directory *containing* the repo |
| submodule | `<super>/.git/modules/<name>` | inside the superproject's git dir |
| ambient `GIT_DIR` / `GIT_COMMON_DIR` | an unrelated repository | that repository |

The `GIT_DIR` case is reachable, not theoretical: every git hook runs with `GIT_DIR` exported, and
`git -C` obeys it. So the child environment is scrubbed of the git path variables, and the
candidate must both (a) be a working tree whose own top level is that candidate, and (b) look like
a board. Anything else keeps the invoking root as its store rather than guessing. The two guards
overlap on the ordinary bare and submodule layouts and are pinned separately: a bare repo whose
containing directory happens to hold a `projects/` dir is caught only by (a).

### An op belongs to the working tree that queued it

One store makes every worktree's ops visible to every worktree. That is the fix, and on its own it
is a way to destroy 191 of the 210 ops. An op queued in worktree W records paths that exist in W's
checkout and nowhere else — measured: of the 186 distinct paths recorded by v4-spine's 185 ops, 4
exist in the main checkout; of v3-phase0's 2, none do. A flush in the main checkout would drop
those paths (`commit-runner` drops a path that is neither on disk nor tracked), commit almost
nothing, and then clear the ledger.

INF-673's `checkBranch` does **not** catch this. That guard returns ok the moment the checkout is
on the default branch, without reading a single entry's provenance — and the flush runs on the
default branch by design.

So the drain is provenance-aware. An op is drainable here when the working tree it was queued in
is this one, decided by:

1. the `worktree` the op recorded — relative to the store, so it survives a container mount, and
   written on **every** op including the empty string that means "the main working tree", else
2. its recorded `branch`, **but only when another worktree currently holds that branch**. All 210
   ops already on disk carry a branch and none carries a worktree, so this makes them safe with no
   migration-time rewriting of the ledger.

Condition 1 records the empty string rather than omitting it, and that is not a detail. Omitting
it — to keep the ledger shape unchanged for the ordinary case — reintroduced the false green at
the one place the flush runs. `currentBranch` returns null on a **detached HEAD**, so a main
checkout mid-rebase, mid-bisect, on `checkout <sha>`, or in a detached review worktree recorded
neither field, and condition 3 below then read "queued in the main tree" and "no provenance at
all" as the same signal: another worktree drained the op, staged nothing for it, committed
something else, and deleted the record, exiting 0. The saving was worth nothing and the stated
goal it served — an unchanged ledger shape — is what bought the bug.

Ops held back are rewritten to the queue **byte-for-byte** from their raw lines, composing with the
drain-exact clear that preserves a mid-commit append.

Condition 2's "only when another worktree holds it" is load-bearing and not a refinement. A
recorded branch that differs from the current one, which *no other worktree holds*, is INF-673's
incident — the same checkout moved underneath the ops, the files are right here, and the correct
answer is that guard's hard refusal of the whole batch with its recovery steps. Filtering it here
would silently swallow that refusal.

### A flush that leaves ops behind does not exit 0

`blaze commit` exits **3** when it has flushed everything this working tree can reach and ops
remain that it cannot — whether they belong to another worktree, or sit in a not-yet-migrated
per-working-copy store. Exit 1 stays the verb's refusals (nothing happened at all) and exit 2 stays
`--status` reporting incompletely. `outcome=published` can no longer be true while ops remain
queued in a working copy the flush does not reach.

`blaze commit --status` now names the store it resolved, from any working copy. Before this, no
output blaze produced said which `.blaze/` a given invocation was reading — which is how 210 ops
came to sit in four of them without anyone noticing.

## What this decision does NOT change

- **BLZ-124 / BLZ-498's session scope.** A run still drains exactly the queue its own session id
  resolves to, and a session still shares its queue with its subagents because the harness exports
  `CLAUDE_CODE_SESSION_ID` to descendants. Nothing here drains across sessions automatically; the
  store moved, the scoping rule did not. Pinned by
  `tests/commit-session-queue-scope.test.mjs`, unchanged.
- **The legacy shared fallback** `.blaze/pending-commit.jsonl` (session `null`) is still listed by
  `listQueues` and still drained by `--all` — now from the shared store. The known gap that the
  flush's `queueops=` counter does not count it is filed separately and is neither fixed nor
  widened here.
- **INF-673's branch guard**, per the previous section.

## Consequences

- The 210 ops already on disk must be moved into the shared store by the operator. This is a data
  operation on a live board and the engine performs no part of it: it counts what is stranded,
  names it, and refuses to report success while it exists. See
  [queue-store-migration](../operations/queue-store-migration.md).
- Until the operator flushes the lanes, the nightly flush exits 3 rather than 0. That is the
  intended outcome: 185 ops queued on `BLZ-305-v4-spine` are not the nightly main-branch flush's to
  commit, and a green run that says so is the defect this ADR removes.
- The file-based queue is transitional — BLZ-305 is migrating the board to Postgres. This is
  deliberately the small fix: one resolver, one provenance predicate, one exit code.
- **`blaze commit` takes two locks: the store's, then the working tree's.** This was first
  written up as a widened race and deferred. That was wrong — it is a demonstrated corruption,
  not a window. `clearLedger` applies byte-offset arithmetic (`buf.subarray(consumedBytes)`) to a
  file it read *before* the git commit ran, and `commit-lock.mjs` keys on the invoking
  `dataRoot`. With one store, two worktrees flushing concurrently hold **different** lock objects
  while read-modify-writing the **same** file: one op is resurrected (already committed, back in
  the queue, and will commit twice) and another is shredded into an unparseable line — the one
  shape this codebase has no recovery path for. Two agents flushing at once is this operator's
  normal cadence, so it is reachable on an ordinary day.

  The trade that motivated deferring it does not have to be taken. There are two shared
  resources with different extents — the **ledger**, shared by every worktree of the repo, and
  the **git index**, which is per-worktree and is what `serve-commit.mjs` locks on the invoking
  root. So `blaze commit` acquires the store lock first and the working-tree lock second (a
  global order; `acquireLock` retries 10 times at 200 ms and then gives up, so the wait is
  bounded rather than fail-fast, and `serve-commit.mjs` takes exactly one lock and releases it in
  a `finally` — so no cycle exists to deadlock on), and holds both. In the main checkout the two are the same directory and
  it takes one, which is exactly today's behaviour. Nothing is given up.

  That collapse to one lock rests on `queueRoot` echoing the root it was handed verbatim when
  that root already **is** the store — the `parent === root` early return. Measured rather than
  asserted, and the earlier draft of this line overstated it: deleting that early return leaves
  every flush test green, because a normalised root still string-matches itself. The lock would
  split only under a normalising resolver **and** a non-normalised `dataRoot`, which
  `resolveRoots` cannot produce. So the early return is a fast path in production and a
  spelling-preserving API contract, and it is pinned as the latter.

  **What the two locks do not give.** `acquireLock`'s 60 s `staleMs` steals the lock from a
  *live* owner by design (`tests/commit-lock.test.mjs` pins that deliberately), so a flush
  running longer than 60 s has its store lock stolen by another worktree and the
  resurrect/shred window reopens. That was harmless while the queues were one file per working
  copy and is not harmless now they are one file. Filed separately — the lease is not
  redesigned under this ticket, and this paragraph exists so the lock is not read as providing
  an exclusion it does not.
- `config.mjs`'s `mainWorktreeFor` (INF-763) answers a similar question for relative `codeRepos`
  and is **not** reused. A wrong answer there makes reconcile fail loudly; a wrong answer here
  silently writes ops somewhere nothing drains, so this resolver carries guards that one does not.
  Unifying them behind the hardened resolver is filed separately.
