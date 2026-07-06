---
name: blaze
description: Use when working in a Blaze board repo — creating, moving, or grooming tickets, or wiring the board to a code repo. Explains the directory-is-status model and the reconcile/groomer loops.
---

# Driving a Blaze board

Blaze is a file-based issue tracker: a ticket's status is the directory it sits in,
`projects/<KEY>/<status>/<KEY>-<n>-slug.md`. The default (delivery) workflow for
epic/story/task/bug/subtask is `defined → in-progress → in-review → done`; goals and
risks follow their own workflow. The full contract, including all workflows and the
frontmatter schema, is in the repo's `AGENTS.md` — read it before acting.

- **Create:** `blaze new --project <KEY> --type <type> "Title"` (or `/blaze-new`), e.g.
  `blaze new --project ENG --type task "Fix the export bug" --estimate 30`. Move
  forward by hand with `blaze move <id> <status>`.
- **Mirror a code repo:** set `codeRepos` in the project's `project.json` (or the
  tracker-wide `codeRepos` in `blaze.config.json`); `blaze reconcile` (or
  `/blaze-reconcile`) drives `in-progress → in-review → done` for delivery tickets
  from branch + PR state. The `<KEY>-<n>` in a branch name is the only link.
- **Groom:** `blaze groom` (or `/blaze-groom`) runs the agentic board-keeper over the
  backlog per `AGENTS.md` → "Grooming rules", auto-committing each change.
- **Run the app:** `blaze start` (or bare `blaze`, or `npm start`) boots the
  supervisor — the board, a live activity feed, and loop controls — at
  http://localhost:4321.

Never hand-move a ticket through the reconcile-owned statuses; let reconcile do it.
