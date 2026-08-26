# How it works

## Four ideas, load-bearing

- **A ticket is a markdown file** — frontmatter plus a body. No database, no
  login, nothing to migrate.
- **A ticket's status is the directory it sits in.** There is no `status:`
  field in the frontmatter, so status cannot drift out of sync with reality —
  the file's location *is* the fact.
- **Git is the history.** Every mutation — create, move, edit, resolve, log —
  is a small, revertable commit. `git log --follow` on a ticket file is its
  full audit trail.
- **The board is a rendering, never a second source of truth.** `blaze board`
  reads the same files you'd `ls`, `grep`, or `git mv` by hand. Delete the
  board process and the tickets are still there, still correct.

## Engine ⟂ data

The `@hjr15/blaze-board` package is the **engine** — the `blaze` CLI and its
web board, and nothing else. It ships no tickets and no config. Your tickets
live in a separate **data repo**: a `blaze.config.json` plus a
`projects/<KEY>/<status>/` tree, versioned in its own git history.

The engine finds a data repo by running from inside it (it looks for a
`projects/` directory under the current working directory) or via
`BLAZE_PROJECTS_DIR` pointed at one from anywhere. One global engine install
can drive any number of unrelated data repos this way.

See the [engine/data-split diagram](../diagrams/engine-data-split.md) for the
resolution order, and [`docs/architecture.md`](../architecture.md) for the
full as-built picture.

## Types and workflows, at a glance

Work items come in a handful of types — `goal`, `requirement`, `architecture`,
`feature`, `story`, `task`,
`bug`, `subtask`, `risk` — each with a legal parent type and a set of required
fields. Every type runs through one of three workflows (`delivery`, `goal`,
`risk`); a workflow's columns are exactly its status directories, and a ticket
can only move along an adjacent forward edge or jump back to a defined reopen
target. Full type table, workflow diagrams, and the fixed enums live in
[`schema.md`](schema.md) — this page won't repeat them.

## Two modes

**Standalone board.** You (or your agent) move tickets by hand — `blaze move`,
or drag-and-drop on the web board. Nothing outside the data repo is consulted.

**Mirror mode.** Set `codeRepos` on a project in its `project.json` and
`blaze reconcile` drives delivery-workflow ticket status from that repo's
branch and PR state, joining on the `<KEY>-<n>` ticket id found in branch
names. Reconcile is dry-run by default; `--apply` commits the resulting moves
locally. It never pushes — pushing is not something reconcile does, under any
flag.

## Forge support and status reachability

**Blaze reads pull requests through the GitHub CLI (`gh`), and that is the only
forge it supports.** This is a stated non-goal, not a gap (see
[`design.md`](../design.md) → Non-goals). There is no `provider` config key — it
was removed and is now a hard load error.

`gh` speaks GitHub.com and GitHub Enterprise Server. Reconcile derives ticket
status from three independent signals, and only one of them needs a forge:

| Signal | Read via | Drives |
|---|---|---|
| Branch named `<KEY>-<n>-…` | `git for-each-ref` | `in-progress` |
| `<KEY>-<n>: …` commit on the default branch, **or a `* <KEY>-<n>: …` bullet in the body of one** | `git log` | `done` (bundled children) |
| Pull request for `<KEY>-<n>` | `gh pr list` | `in-review` (any OPEN), `done` (MERGED, and only when none is OPEN), `in-progress` (CLOSED) |

So the reachable statuses depend on where the code repo's remotes point. Note
**remotes**, plural, and not just `origin`: `gh` resolves its base repo from *any*
GitHub remote, so a repo whose only GitHub remote is named `upstream` — or one with
`origin` on GitLab and `upstream` on GitHub — reads its pull requests normally.

| Remote host(s) | `in-progress` | `in-review` | `done` |
|---|---|---|---|
| At least one remote on GitHub.com | yes | yes | yes |
| At least one remote on GitHub Enterprise Server (`gh auth login --hostname …`, or `GH_HOST`) | yes | yes | yes |
| At least one remote on a host Blaze cannot classify | yes | yes, if `gh` can read it | yes |
| **Every** remote on GitLab, Bitbucket, Gitea, Forgejo/Codeberg, Azure DevOps or sourcehut | yes | **no** | yes, only via a commit signal on the default branch — never via a merged PR |
| No remotes, or only local-path remotes | yes | **no** | same as above |

An unclassifiable host is handed to `gh` rather than pre-rejected, because GitHub
Enterprise Server is self-hosted under an arbitrary hostname and guessing
"unsupported" would break a working board.

`in-review` is reachable **only** through a pull request, so when no remote is
readable that status cannot be reached at all. Until BLZ-350 that happened in
silence: the failed `gh` call was turned into an empty pull-request list and
reconcile reported a clean, in-sync run.

It now says so. Every unreadable forge is named on stderr, on every run,
regardless of `--quiet`:

```
reconcile: FORGE UNREADABLE — /path/to/svc has an `origin` remote on gitlab.com, but
Blaze reads pull requests through the GitHub CLI (`gh`), which supports GitHub.com and
GitHub Enterprise Server only. PR state could not be read, so "in-review" is unreachable
for this repo (branch and merged-commit signals are unaffected). …
```

The same line appears when `gh` is missing, unauthenticated, or fails for any
other reason — its own stderr is quoted — and the programmatic caller gets the
list as `forgeErrors` on the reconcile result.

It is a **warning, not a fatal error**: reconcile still exits 0, because the
branch and commit signals genuinely did reconcile, and on an unsupported forge
the condition is permanent — failing every run would be noise rather than
information. Exit 1 stays reserved for "nothing was scanned at all".

**This includes a code repo with no remotes at all.** A local-only mirror is a
legitimate setup, but `in-review` is just as unreachable there, so it is reported
on the same terms rather than being treated as a special quiet case. If that is
your deliberate configuration, the line is expected and harmless.

## Two rules that keep the board honest

Both were bugs before they were rules, and both are about the same thing: the board
must not say shipped when it is not, and must not say untouched when it is.

### An open pull request vetoes `done` (BLZ-130)

A ticket that is **not yet terminal** reaches `done` from a merged PR only while no
corroborated PR carrying its key is still open. A feature accumulates more than one PR
over its life, and any early one — a spike, a decision record, a docs-only precursor —
used to satisfy "a merged PR carrying this key ⇒ done" and report the whole feature
complete while its actual work sat unmerged.

The cost of the veto is a delayed `done`: the ticket waits in `in-review` until the
last PR carrying its key closes.

> **What the veto does not do is re-open a ticket that already reached `done`.**
> Terminal status is sticky by design — reconcile never pulls a ticket out of a
> terminal status automatically — so if reconcile happens to run in the window between
> an early PR merging and the next one opening, the ticket goes to `done` and stays
> there. The veto narrows that window to the time when both PRs are visible at once;
> it does not close it. Tracked as BLZ-395.
>
> A terminal ticket's `branch` and `pr` are **written once and never replaced**. A
> `done` ticket with no record yet can still acquire one — reconcile is the only thing
> that writes those fields — but nothing later overwrites it, so neither a still-open PR
> nor a follow-up docs PR merged under the same key can claim to have delivered the work.
>
> **The record is one unit, and the two fields move together.** A terminal ticket
> carrying *either* `branch` or `pr` already has a record, so neither half is topped up
> later — otherwise a follow-up PR could fill a blank `pr` beside a `branch` that names
> a different PR, and the record would name two.

### A squash merge's body is read, not just its subject (BLZ-131)

These repos are squash-only, and a squash collapses a branch into one commit whose
*subject* is the PR title — so a bundled child's `<KEY>-<n>:` subject does not survive
the merge, and the child was never moved at all. GitHub's default squash message keeps
each collapsed commit's subject as a `* ` bullet in the body, and reconcile reads those
bullets. On this repo that recovers **28** ticket ids that no subject on the default
branch mentions.

**Two conditions must both hold, and each one is load-bearing.**

1. The marker is `* ` — what GitHub writes, and what nothing else here writes.
2. The commit's own subject must open with a ticket-id list — `<KEY>-<n>: …`, or the
   multi-ticket forms `<KEY>-a/b/c:` and `<KEY>-a + <KEY>-b:`. A bundled child lives
   inside a *feature's* PR, titled that way by convention; a commit whose subject names
   no ticket is not a bundle manifest, whatever its body lists. Every id in the leading
   list counts, and the list ends at the colon — `BLZ-1: fixes BLZ-4` claims only BLZ-1.

The reason both are needed is measured, on the board repo, where the board itself is a
configured code repo for its own project:

Measured on the board repo's `origin/main` (156 commits):

| Rule | Ids harvested beyond the subjects | Of those, delivered nothing |
|---|---|---|
| Any bullet, any subject | **426** | 426 |
| Any bullet, ticket subject only | **49** | 49 |
| `* ` bullet, ticket subject only | **2** | **0** — `INF-701` and `INF-672` both really shipped |

Each row drops one condition from the shipped rule: the first two use the wide `[*+-]`
marker, and only the third is what actually runs.

`blaze`'s own batch commits write their ledger as `- <KEY>-<n>: <board op>`, so
"moved a ticket" and "edited its labels" read as delivery under the loosest rule. That
is BLZ-130's failure — the board saying shipped when it is not — arriving through the
other door, and it is why neither condition was dropped as redundant.

**What this deliberately does not claim:** a bullet is not proof of work. A squashed
ticket PR whose body lists a ticket it did not implement will be believed. The two
conditions make that a narrow case rather than the common one; the commit must still be
reachable from the default branch, so an open PR strands nothing.

> **This depends on one repository setting.** GitHub's *Default commit message for
> squash merges* must be **"Default message"** or **"Pull request title and commit
> details"**. Set to "Pull request title" (or "title and description"), the bullets
> are never written, and a bundled child needs a manual `blaze move` as before.
> Reconcile cannot detect the difference — an absent bullet and an unshipped child
> look identical — so it fails the safe way and says nothing.

## The loops behind `blaze start`

`blaze start` (or bare `blaze`) boots the board plus two loops on timers:

- **Reconcile loop** — deterministic. Runs the same mirror-mode logic as
  `blaze reconcile --apply` on a schedule, so delivery tickets track their
  linked repo without anyone running the command by hand.
- **Groomer loop** — agentic. On each pass it picks the first ungroomed ticket
  in a configured column, spawns your configured agent command against it to
  triage, label, or dedupe, and auto-commits whatever the agent changed as its
  own small, revertable commit. It only ever touches ticket files — if the
  agent renames the file or edits `status`/`resolution` directly, the groomer
  refuses the change and rolls it back.

Both loops write through the same git-commit path every other verb uses.
See [`commands.md`](commands.md) for the verbs themselves.

## Commit model

By default (`commitMode: "per-op"`) every mutating verb commits immediately,
scoped to only the files it touched — one ticket created, one commit. Opt into
`commitMode: "batch"` to queue ops instead and flush them with `blaze commit`;
`BLAZE_SESSION` keys the queue so parallel sessions (multiple agents, multiple
terminals) don't collide. Detail on both modes, and on running several agents
against one board at once, lives in [`commands.md`](commands.md) and
[`driving-with-an-ai-agent.md`](driving-with-an-ai-agent.md).

---

Next: [Getting started](getting-started.md) · [Command reference](commands.md)
