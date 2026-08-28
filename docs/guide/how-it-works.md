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

**A nested git repository under `projects/` is skipped, not read (BLZ-430).** The walk
treats every directory under a project as a status directory and every `.md` inside it as a
ticket, so a submodule (or a plain clone) checked out there would have its `README.md`
parsed as a ticket — and a file with no frontmatter *throws*, which takes the whole walk
down and with it the board, the index, `blaze audit` and `reconcile`. One neighbouring
directory made a whole board unreadable. A directory carrying a `.git` entry is therefore
passed over. **A malformed ticket is still loud**: this skips other repositories, never
files that fail to parse.

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

**Scoping a run.** `--project <KEY>` restricts both the scan and the write to the
projects you name — repeatable, or comma-separated:

```
blaze reconcile --project BLZ
blaze reconcile --project BLZ,INF --apply
```

Without it, every configured project reconciles, exactly as before. The point is
blast radius: `--apply` writes ticket files directly, then commits every file it
touched the same way every other mutating verb does (or queues them for `blaze
commit`, under `commitMode: "batch"` — see "Commit modes" in AGENTS.md), so a
session that owns three tickets would otherwise author a commit moving fifteen it
never looked at. An unknown key is refused outright — it does
not quietly reconcile nothing, which would be indistinguishable from an in-sync
board — and every run says which projects it scanned, so a narrowed run cannot be
mistaken for one that found nothing.

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

## Three rules that keep the board honest

All three were bugs before they were rules, and all three are about the same thing: the
board must not say shipped when it is not, and must not say untouched when it is.

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

### A branch or PR that MENTIONS a ticket has not claimed it (INF-735, BLZ-440)

Reconcile finds a ticket id in a branch or PR head ref with an unanchored
`\b<KEY>-<n>` match, run over every ref in every one of a project's `codeRepos`. That
is deliberately loose, because ref names are: `feature/blz-408-work`,
`BLZ-408-a-mention-is-not-a-claim`, `docs-successor-kickoff-blz-408-439` all carry a key.

**A ref name is a naming convention, not evidence.** So a ref-derived claim needs a
second signal before it counts, and the second signal must describe the WORK:

1. the PR **title CLAIMS the ticket** — it opens with `<KEY>-<n>` followed by `:` or an
   em-dash, in the same leading-id-list form as a commit subject (see
   [where the list ends](#where-the-leading-id-list-ends) and
   [its separators](#the-leading-id-list-and-its-separators)); or
2. a `<KEY>-<n>:` commit for it is **reachable from the default branch** (the shipped
   signal of the previous rule).

Neither is satisfied by a *mention*. `docs: successor kickoff for the BLZ-408..439
follow-up lane` names BLZ-408, and claims nothing — it is a range. So do
`supersedes BLZ-408`, `follow-up to BLZ-408`, and a bare `(BLZ-408)` in parentheses. This
is the same rule the shipped signal already applies to commit subjects, stated once: **a
downstream mention is never a claim.**

Until BLZ-440 the title arm tested `\bBLZ-408\b` against the title — a bare mention
anywhere. `\bBLZ-408\b` matches *inside* `BLZ-408..439`, because `.` is a non-word
character and the boundary holds, so a range corroborated its own first element. On the
real board that proposed `BLZ-408: defined → done` for a ticket that had never been
worked, on the evidence of a PR whose branch and title both named the range 408..439.

#### Where the leading id list ends

Both rules above read the same **leading id list**, parsed by `idsFromSubject`
(`scripts/reconcile.mjs`). It starts at column 0 with `<KEY>-<n>` and it ends at a
**terminator** — `BLZ-1: fixes BLZ-4` claims only `BLZ-1`.

Two terminators are accepted, and no others
([ADR-0026](../decisions/0026-a-pr-title-claims-a-ticket-with-a-colon-or-an-em-dash-and-nothing-else.md)):
a **colon** (`BLZ-455: a title claims a ticket`) and an **em-dash, U+2014**
(`INF-327 — Author the 3 Excalidraw-flagged diagrams`). An em-dash immediately after the
id is as unambiguous a separator as the colon: there is no reading of that title on which
it is about anything but INF-327. **One code point was decided, and its neighbours are not
it** — en-dash (U+2013), hyphen-minus, minus sign (U+2212), horizontal bar (U+2015) and
`--` are all still rejected.

**Words between the id and the terminator stay rejected, and that is the load-bearing
half.** `INF-889 to INF-892: corpus landing` is a real merged PR title; admitting
words-before-colon would make it claim INF-889 — which is a *range*, and therefore exactly
the defect this rule exists to stop. So are `feat(KEY-n):`, `[KEY-n]`, `KEY-n desc`,
`Revert "KEY-n: …"` and `WIP: KEY-n: …`.

A terminator is not a separator. The em-dash **ends** the list; it never continues one,
and it is absent from the table below for that reason.

#### The leading id list, and its separators

**Four separators are accepted, and no others:**

| Separator | Example | Bare number continues the list? |
|---|---|---|
| `/` | `BLZ-286/287/288: config projection` | **yes** — `<KEY>-a/b/c:` is the house shorthand |
| `+` | `BLZ-96 + BLZ-97: close batch-mode bypasses` | no — the key must be repeated |
| `,` | `BLZ-1, BLZ-2: two tickets` | no — the key must be repeated |
| `&` | `BLZ-1 & BLZ-2: two tickets` | no — the key must be repeated |

A bare number continues the list only after `/`. Allowing it everywhere let
`BLZ-1 + 2026: annual review` claim a `BLZ-2026` that does not exist.

#### A bundle names one ticket in the subject and the rest in the body

A PR delivering sixteen tickets cannot list sixteen ids in its title and stay readable.
`BLZ-414 + 15 more: the oracles are non-vacuous` used to claim **nothing at all** — after
`+` the key must be repeated, so `15` is not `BLZ-15`, the head match failed, and not even
BLZ-414 was claimed. All sixteen were hand-moved.

The manifest form fixes that: **`<KEY>-<n> + N more: desc`** claims `<KEY>-<n>` from the
subject and nothing else, and the squash body's `* <KEY>-<m>:` bullets at column 0 claim
the rest, through the manifest reader described below. `N` is a **count** and is never
read as an id — it sits exactly where a bare list element sits after `/`, and reading it
as one would claim a ticket that does not exist.

A range still claims nothing under this form: `BLZ-408..439 + 15 more:` fails the head
match on the `..` before the manifest tail is reached. And `BLZ-408 + 15 others:` — a
bundle marker Blaze does not know — claims nothing rather than silently falling back to
its leading id.

`tests/how-it-works-doc-pins.test.mjs` runs this table against `idsFromSubject` in both
directions — every separator this page documents is accepted, and no separator it omits
is — so the two cannot drift apart again.

**An uncorroborated claim is neutered, not dropped.** The rule is:

> **An uncorroborated claim may only ever hold a ticket BACK. It may never advance one.**

It stays in the **ranking pool** — the set `buildPrMap` picks a winner from — so it keeps
whatever veto its **state** earns under the rule above, and an uncorroborated *open* PR
still stops `done`. What it cannot do is supply a **delivery record** or a **forward
status**. Reaching the top of the ranking buys it the power to withhold a move, and
nothing else.

It does **not** stay among the `candidates`: in the code that name is the
**corroborated-only DELIVERER set** (`corroboratedByTicket`, which feeds the tied-deliverer
check), and the ranking pool is the separate, wider set built with
`includeUncorroborated: true`. The one collection an uncorroborated claim is not in is the
one it would be natural to call it by.

**Dropping it instead would be a substitution, not a subtraction**, and that is a real
bug rather than a theoretical one. Reconcile reads the top-ranked PR, and an open PR
outranks a merged one — so deleting an uncorroborated open PR *promotes* the merged PR
behind it. A ticket in `in-review` then goes to `done`, takes `resolution: done`, and
writes a write-once `pr:` record naming the wrong pull request, while the open PR
carrying the real work is still open. Nothing reports it, and `pr` cannot be edited
afterwards. That is worse than the bug this rule was written to fix.

**The cost runs in both directions, and only one of them is safe.** Withholding a move
costs a missed signal, and the ticket sits where it is until someone moves it by hand —
recoverable, and the direction this design deliberately errs in. Granting a move on
uncorroborated evidence costs a *corrupted* ticket: terminal status is sticky and a
terminal delivery record is write-once, so there is no route back. The rule above is what
keeps every uncorroborated claim on the recoverable side.

One consequence worth naming: an uncorroborated PR masks the OTHER signals for the same
ticket, because the pull-request arm is read first and returns without falling through.
Two are masked, not one:

* the corroborated **branch** signal — reachable within a single repo;
* the **shipped** signal — masked by the same clause, but reachable only **across
  repos**. Within one repo it cannot arise: `shippedSet` is what corroborates a claimant,
  so a PR for a ticket that repo has shipped is corroborated by definition. Across repos
  it can: `gatherProject` **unions** every repo's `shippedSet` while corroboration is
  computed per repo, so a ticket shipped in repo B can carry an uncorroborated PR in
  repo A and the union's `shipped` never gets a hearing.

Both are missed advances rather than wrong ones, so both fall on the safe side of the
same rule.

**Naming a branch after a range stays safe and ordinary.** It just is not read as
delivery.

### A squash merge's body is read, not just its subject (BLZ-131)

These repos are squash-only, and a squash collapses a branch into one commit whose
*subject* is the PR title — so a bundled child's `<KEY>-<n>:` subject does not survive
the merge, and the child was never moved at all. GitHub's default squash message keeps
each collapsed commit's subject as a `* ` bullet in the body, and reconcile reads those
bullets. On this repo at `blaze` `7a5ddb0` — a sha, because `origin/main` moves — that
recovers **28** ticket ids that no subject at that ref mentions.

**Two conditions must both hold, and each one is load-bearing.**

1. The marker is `* ` — what GitHub writes, and what nothing else here writes.
2. The commit's own subject must open with a ticket-id list — `<KEY>-<n>: …` or
   `<KEY>-<n> — …`, or one of the multi-ticket forms below (including the
   `<KEY>-<n> + N more:` bundle form). A bundled child lives
   inside a *feature's* PR, titled that way by convention; a commit whose subject names
   no ticket is not a bundle manifest, whatever its body lists. Every id in the leading
   list counts, and the list ends at its terminator — `BLZ-1: fixes BLZ-4` claims only
   BLZ-1.

The reason both are needed is measured, on the board repo, where the board itself is a
configured code repo for its own project:

This is one measurement at one named ref, and it moves as the board grows. Measured on
`blaze-pm` `ff5f36c2` (its `origin/main`, 156 commits), harvesting each of the **eleven
project keys the board configures** — the whole board is the population, because the
board repo is a configured code repo for its own project. Where a figure is for the
`INF` key alone it says so.

| Rule | Ids harvested beyond the subjects | What those ids are |
|---|---|---|
| Any bullet, any subject | **1,323** (426 for `INF` alone) | board bookkeeping, not deliveries — 1,205 of them are named by nothing but a `- <KEY>-<n>: <board op> [session]` ledger line |
| Any bullet, ticket subject only | **63** (49 for `INF` alone) | the same — 60 of the 63 are ledger-only |
| `* ` bullet, ticket subject only | **3** (2 for `INF` alone): `BLZ-259`, `INF-672`, `INF-701` | no ledger lines. `INF-672` and `INF-701` are `done` and really shipped; `BLZ-259` comes from two real `* BLZ-259:` bullets in merged commit `e3beaec3`, so the rule did not misfire, but the ticket sits in `accepted/` at this ref |

Each row drops one condition from the shipped rule: the first two use the wide `[*+-]`
marker, and only the third is what actually runs. The two conditions still cut hard —
1,323 → 63 → 3 across the board's keys, 426 → 49 → 2 for `INF` alone.

The third row was **2** at `blaze-pm` `bd1d151d` (131 commits, an ancestor of
`ff5f36c2`); `BLZ-259` joined it when `e3beaec3` landed. Quote this table with its sha or
it is not reproducible.

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

**A persistent failure is stated once, not once per tick (BLZ-425).** The reconcile loop's
forge errors, its findings, and its own run failures are each deduplicated before they
reach the activity feed. Under `BLAZE_READONLY` every pass returns the same refusal, and at
the default 60-second interval that would be 1,440 identical error events a day in the feed
that is the operator's whole account of the run. A run failure is remembered only until a
healthy pass, so a condition that returns after you fix it is reported again.

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
