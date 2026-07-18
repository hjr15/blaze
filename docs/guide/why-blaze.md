# Why Blaze

Blaze is a file-based, git-native issue tracker built for AI coding agents to
drive. If you already run a coding agent against your repo, Blaze gives it a
project board it can read, write, and move with the file tools it already has —
no API client, no auth, no SDK on either side.

## The problem it solves

Most issue trackers are a database behind an API. To let an agent use one you
wire up an API client, hand it a token, and hope the model calls the endpoints
correctly. The board becomes a second source of truth that drifts from the code,
and every interaction is a network round-trip through a schema the agent has to
learn.

Blaze removes the layer. The board **is** files in a git repo:

- **A ticket is a markdown file** — frontmatter plus a body.
- **A ticket's status is the directory it sits in.** There is no `status:`
  field, so status cannot drift out of sync with where the file actually lives.
- **Git is the history.** `git log --follow` on a ticket file is its full audit
  trail; every change is a small, revertable commit.
- **The board is a rendering, never a second source of truth.** `blaze board`
  reads the same files you would `ls`, `grep`, or `git mv` by hand.

An agent operates the board the way it operates the codebase: read a file, edit a
file, move a file, commit. The tracker and the work it tracks live in the same
substrate.

## Who it's for

- **AI coding agents** — the primary audience. An agent drives Blaze with plain
  file operations or the `blaze` CLI. Because the rules live in the tree
  (`AGENTS.md`) and the state is just directories, there is almost nothing for
  the agent to hold in context beyond "the folder is the status."
- **The humans steering them** — you get a live web board (`blaze board`) to see
  where work stands, plus ordinary git tooling for history, review, and revert.
  Nothing an agent does is hidden behind a service you can't inspect.
- **Anyone who wants a plain-text kanban** — Blaze runs standalone as a personal
  or team markdown board, with or without any coding agent in the loop.

## The one-paragraph pitch

Point your coding agent at a directory, give it a one-line `blaze.config.json`,
and it has a project board: tickets are markdown files, status is the folder,
history is git, and the board is a rendering you can throw away and regenerate at
any time. The agent drives it with the tools it already has; you watch and steer
from a live board and plain `git log`. No database, no login, no API keys, no
lock-in — if you ever walk away, what you keep is a git repo full of markdown.

## Strengths

- **Plain files, all the way down.** Every ticket is human-readable markdown you
  can edit in any editor. There is no export step because there is nothing to
  export from.
- **Git-native.** History, blame, branching, revert, and review are the ones you
  already use. A bad change is one `git revert` away, and the audit trail is free.
- **AI-first, not AI-bolted-on.** The agent needs no client library and no
  credentials for the tracker itself. The contract it reads is one file in the
  repo.
- **Zero lock-in.** The engine is a separate npm package
  (`@hjr15/blaze-board`); your data is your own git repo. Delete the engine and
  your board is still a complete, portable set of files.
- **The board can't lie.** Because status is the directory and the board is a
  render over the files, there is no cache or field that can silently disagree
  with reality.
- **Cheap to run.** No server to host, no database to operate, no per-seat
  billing. It is Node built-ins and git.

## When to reach for it — and when not

Reach for Blaze when:

- an AI agent is a first-class user of your tracker;
- you want the board and the code to share one substrate (git);
- you value inspectability and zero lock-in over a hosted feature set;
- a single person or a small, coordinated team (or their agents) owns the board.

Look elsewhere when:

- you need a **multi-tenant, multi-user SaaS** with accounts, permissions, and
  server-side concurrency — Blaze coordinates parallel writers with **advisory,
  single-host locking**, not a transactional database. It is built for one host
  (you and your agents), not a shared cloud instance many strangers write to at
  once.
- you want the tracker to **write code for you**. Blaze's loops keep the *board*
  — they triage, label, dedupe, and reconcile status from your code repo's
  branch/PR state. They never cut branches or edit code in the mirrored repo.
  That boundary is deliberate.
- you need integrations Blaze deliberately omits — a hosted API, an MCP server,
  a second git provider (GitHub via `gh` is the one implemented), or a database
  backend. These are non-goals by design, not gaps waiting to be filled.

Blaze is intentionally small. Its bet is that for an agent-driven workflow, plain
files and git beat a database and an API — and that keeping the surface tiny is
what makes it safe for an agent to drive.

---

Next: [How it works](how-it-works.md) · [Getting started](getting-started.md) ·
[Driving Blaze with an AI agent](driving-with-an-ai-agent.md)
