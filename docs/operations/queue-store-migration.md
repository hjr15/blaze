# Migrating the pending-op queue store (BLZ-556)

[ADR-0033](../decisions/0033-the-queue-store-is-one-per-repository-not-one-per-working-copy.md)
moved the queue store from *one per working copy* to *one per repository* — `.blaze/` beside the
repository's common `.git`, which is the main checkout.

Ops queued **after** the engine upgrade go there automatically. Ops queued **before** it are still
in each working copy's own `.blaze/`, and nothing reads them there. This procedure moves them.

**Nothing here deletes anything.** Migrated files are *moved aside* into a dated holding
directory in the working copy they came from. **The engine performs no part of this** — it counts
what is stranded, names it, and refuses to report success while it exists.

Every step runs through [`migrate-queue-store.sh`](migrate-queue-store.sh), which is a script
rather than snippets in a document for one reason: the first draft of this runbook was a set of
shell fragments, and a `chmod 000` source made `grep -c` print nothing, `$((before + ))` evaluate
as zero, the destination verify clean, and the source get moved aside — **permanent op loss with
a green report**, which is the exact failure this whole ticket exists to remove. A FIFO named
`*.jsonl` hung it instead. The script refuses both, and every refusal below is exercised against
a fixture.

## What the script will not do

Each of these was reproduced against a fixture and is refused, not warned about:

| Condition | Behaviour |
|---|---|
| A source that cannot be read (`chmod 000`) | refuses — an unreadable queue must never count as zero |
| A FIFO, socket, or directory named `*.jsonl` | refuses without opening it (would block forever) |
| A source or destination with no trailing newline | refuses — appending would fuse two ops into one invalid line |
| A working-copy path containing a space | handled; paths are NUL-delimited throughout |
| The `mv` failing after a successful append | refuses, and a **re-run detects the completed append and does not repeat it** |
| A **partial** append that stopped on a line boundary | the resume asks *how much* is already there and appends only the remainder — a whole-file comparison never matched a prefix, so the overlap was silently duplicated |
| A session queue literally named `pending-commit.jsonl` | routed to the store, not to the board's legacy ledger; `*/pending-commit.jsonl` matched both and the two sources then collided in the hold directory |
| Byte-identical queues in two working copies | both migrate — the resume is keyed on the source **path** (a marker file), not on content, so an identical twin is not mistaken for an already-migrated file |
| Any `blaze` process running, or a `commit.lock` held in **any** of the working copies | refuses, re-checked immediately before every write |
| A target that is not a board, or is a bare repo / `.git` dir | refuses |
| The engine resolving a **different** store than the script derived | refuses |
| Migrating the main checkout onto itself | refuses |

Verification is a **SHA-256 of (destination ‖ source)** computed before the append and compared
against the destination after — not a line count. A hash cannot pass on an input it could not
read; a line count can, and did.

## Step 0 — quiesce every writer

The script re-checks this before every write, but stop the writers deliberately rather than
relying on a race being lost in your favour.

```sh
kubectl -n <namespace> patch cronjob <flush-cronjob> -p '{"spec":{"suspend":true}}'
kubectl -n <namespace> get jobs --no-headers | grep -i flush     # must show none running
```

Re-enable it in step 4, not before.

## Step 1 — count, before touching anything

```sh
cd /path/to/your/board
docs/operations/migrate-queue-store.sh count
```

This walks **every** working copy `git worktree list` reports, not a `<board>-worktrees/*` glob —
on the board this was written for the glob finds 4 where git reports **9**, and a total
reconciled over the wrong 4 passes vacuously. Keep the output; `TOTAL` is what must survive.

Cross-check it against the engine's own view, which derives the store independently:

```sh
blaze commit --status          # first line names the resolved store
```

If the two disagree about the store path, **stop** — the script refuses to migrate in that case
anyway.

## Step 2 — migrate, one working copy at a time

```sh
docs/operations/migrate-queue-store.sh migrate "/path/to/blaze-pm-worktrees/v4-spine"
```

Re-run `count` after each one. A migrated working copy reads `ops=0`, and the board's own count
rises by exactly what left. A filename collision between two working copies **merges** (the
append is the correct handling, and is why `cp` appears nowhere).

The ops need no rewriting — each already records the branch it was queued on, and git allows one
branch to be checked out in at most one worktree, so the drain can tell whose they are. Do not
edit the JSONL.

## Step 3 — verify

```sh
docs/operations/migrate-queue-store.sh count      # TOTAL unchanged; every lane now 0
blaze commit --status                             # run from a migrated working copy: silent
```

`blaze commit --status` lists any queue still stranded in the working copy it runs from, and
exits **2** if one of them could not be read. Silence means done.

The `migrated-*` holding directories may be deleted once the totals reconcile. Nothing depends on
it, and keeping them costs nothing.

## Step 4 — flush, from the working tree each op belongs to

The shared store holds every working copy's ops, but a flush may only commit the ops queued in
its **own** working tree: an op's files exist in the checkout that queued it and nowhere else.

```sh
cd /path/to/blaze-pm-worktrees/v4-spine && blaze commit --all
```

`blaze commit` exits **3** when it flushed everything this working tree could reach and ops
remain that it could not, and names which working tree each remaining op belongs to. While other
lanes are unflushed that is the correct result, not a failed run — and the nightly flush will
keep exiting 3 until they are done, which is it reporting the truth: ops queued on a feature
branch are not a nightly main-branch flush's to commit.

```sh
kubectl -n <namespace> patch cronjob <flush-cronjob> -p '{"spec":{"suspend":false}}'
```

## Rollback

Nothing is deleted, so rollback is a move back:

The hold directory mirrors the source's own layout under `.blaze/`, so a session queue and the
legacy ledger can never collide there:

```sh
HOLD="<working-copy>/.blaze/migrated-<timestamp>"
cp -a "$HOLD/pending/." "<working-copy>/.blaze/pending/"          # session queues
[ -e "$HOLD/pending-commit.jsonl" ] && \
  cp -a "$HOLD/pending-commit.jsonl" "<working-copy>/.blaze/pending-commit.jsonl"
```

An interrupted run also leaves a marker under `<working-copy>/.blaze/migrating/`. Remove that
tree if you are abandoning the migration rather than resuming it — while it is there, a re-run
treats the matching source as one it has already begun.

The appended copies are still in the store. Remove those lines only if you are reverting the
engine too, and copy the store first. If the script stopped on a hash mismatch, the source was
**not** moved — compare the two files before doing anything else.
