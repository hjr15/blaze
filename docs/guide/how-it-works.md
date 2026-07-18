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

Work items come in a handful of types — `goal`, `epic`, `story`, `task`,
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
