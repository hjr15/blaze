# Driving Blaze with an AI agent

This is the audience Blaze is built for. An AI coding agent drives the board with
the tools it already has — no API client, no auth, no SDK. The whole contract is
a directory of markdown files and one rule: **a ticket's status is the folder it
sits in.**

## Two ways to drive it

An agent has two equally valid interfaces, and can mix them freely:

1. **Plain file tools.** Read, grep, edit, and `git mv` the ticket files
   directly. This is the lowest-common-denominator path — any agent with shell or
   filesystem access can do it, with nothing Blaze-specific installed. A ticket is
   markdown; moving it between status directories *is* the status change; a commit
   is the record.
2. **The `blaze` CLI.** The verbs (`new`, `move`, `edit`, `link`, `resolve`,
   `log`, `commit`, `reconcile`, …) do the same mutations but **validate** them —
   a `move` checks the transition is legal and sets `resolution` on a terminal
   status; `new` allocates the next id and enforces required fields. See the
   [command reference](commands.md).

Rule of thumb: **use the CLI when you want the engine to check your work**
(transitions, required fields, taxonomy, id allocation); **use raw file tools for
reads and for edits the CLI doesn't cover.** Both leave the same git history.

## The whole mental model (keep it small)

Blaze is deliberately tiny so there is almost nothing for you to hold in context:

- **A ticket is a markdown file** — YAML-subset frontmatter + a body. The body is
  the ticket's `description`.
- **Status is the directory.** `projects/<KEY>/<status>/<KEY>-n-slug.md`. There is
  no `status:` field to keep in sync.
- **Moving a ticket = moving the file** between status directories (`blaze move`,
  or `git mv` by hand). Legal moves follow the type's workflow — see
  [the schema](schema.md).
- **Git is the history and the undo.** Every change is a small commit; a bad one
  is a `git revert` away.
- **The board is a rendering.** `blaze board` never holds state the files don't.

The full, authoritative contract an agent should read before driving a board is
[`AGENTS.md`](../../AGENTS.md) in the data repo — the directory-is-status rule, the
frontmatter fields, the create→move→reconcile loop, and the branch join key. Point
your agent at that file first.

## The core loop

Most agent work on a board is the same three-step loop:

```bash
# 1. create work (id is allocated for you; task/story/bug need an estimate)
blaze new --project ENG --type task "Wire up CSV export" --estimate 30

# 2. drive its status as you work
blaze move ENG-1 in-progress
blaze log  ENG-1 45 --note "first pass"
blaze move ENG-1 in-review

# 3. close it
blaze move ENG-1 done          # auto-sets resolution: done
# or, for a non-Done outcome, without moving the file:
blaze resolve ENG-1 wont-do
```

Everything above is also doable with file tools alone — `blaze new` writes a file,
`blaze move` renames it across directories, `blaze log` appends a `worklog` entry.
The CLI is the guardrail, not a requirement.

## Mirror mode: let branch/PR state drive status

If the board mirrors a code repo (set a project's `codeRepos`), an agent doesn't
have to move delivery tickets by hand at all. `blaze reconcile` reads the code
repo's branches and PRs and drives `in-progress → in-review → done`, joining on the
`<KEY>-<n>` in the branch name. So an agent that names its branch `ENG-1-csv-export`
and opens a PR gets the board updated for it:

```bash
blaze reconcile            # dry-run: prints what it would move
blaze reconcile --apply    # commit the moves locally (never pushes)
```

This is the cleanest division of labour: the agent writes code and manages
branches; reconcile keeps the board truthful from git.

## Parallel agents / sessions

Multiple agents can share one board without corrupting it:

- **Batch mode.** Set `"commitMode": "batch"` (or `BLAZE_COMMIT_MODE=batch`). Each
  mutating verb queues its op instead of committing; `blaze commit` folds your
  queued ops into one commit.
- **Session isolation.** Each session's ops queue to its own ledger, and
  `blaze commit` flushes **only that** queue — a parallel agent's in-flight work
  never rides your commit. The queue key is `BLAZE_SESSION`; leave it unset and the
  id is derived from the agent harness session, so a session and the subagents it
  spawns share one queue (the parent flushes for them). `blaze commit --all` sweeps
  every session's queue (an end-of-run / bundler step).
- **Read-only subagents.** Set `BLAZE_READONLY=1` for a subagent that should only
  inspect the board — `blaze` then refuses every mutating verb, so a reader can't
  accidentally move or commit a ticket (`board` and `rollup` still work). An env
  guard, not a sandbox — direct file writes bypass it.
- Concurrent commits serialise on an advisory lock; the engine never pushes on its
  own. Reads (grep the files, `blaze rollup`, `blaze board`) need no coordination
  at all.

```bash
export BLAZE_SESSION="agent-42"
blaze new --project ENG --type task "..." --estimate 20   # queued
blaze move ENG-7 in-progress                               # queued
blaze commit                                               # one commit, your ops only
```

## Why this is safe to hand an agent

- The surface is tiny: one rule (directory-is-status) and a handful of verbs.
- Every mutation is a small, attributable, revertable commit — review and undo are
  ordinary git.
- The loops that run under `blaze start` only ever touch **ticket** files, never
  your code. Autonomy is bounded by construction.
- Nothing is hidden behind a service you can't inspect: the board is the files.
- Inspection-only agents can run under `BLAZE_READONLY=1`, which refuses every
  mutating verb — a reader can't change the board even by mistake.

---

Next: [Command reference](commands.md) · [How it works](how-it-works.md) ·
[The schema](schema.md)
