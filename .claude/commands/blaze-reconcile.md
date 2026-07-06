---
description: Sync the board to the code repo's git/PR state (mirror mode).
---

Run `blaze reconcile` to mirror each project's configured `codeRepos` branches and PRs
onto its delivery tickets. For a project with no `codeRepos` set, this is a no-op —
tell the user to set `codeRepos` in that project's `project.json` (or the
tracker-wide `codeRepos` in `blaze.config.json`) if they expected moves.
