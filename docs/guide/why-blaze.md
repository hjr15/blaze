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
  your board is still a complete, portable set of files. (This is the property
  v3 trades away — see [Where Blaze is going](#where-blaze-is-going) below.)
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
- you need a second git provider — GitHub via `gh` is the one implemented, and
  that remains a non-goal.

**A hosted API, an MCP server and a database backend used to be on that list.**
They were described here as "non-goals by design, not gaps waiting to be filled".
That position has been deliberately reversed — see below.

Blaze is intentionally small. Its bet is that for an agent-driven workflow, plain
files and git beat a database and an API — and that keeping the surface tiny is
what makes it safe for an agent to drive.

That bet held for one writer. It did not survive many.

## Where Blaze is going

Everything above describes `@hjr15/blaze-board`, the file-based line, and stays
true of it. **`@hjr15/blaze-board` is frozen at 0.6.0.**

Blaze v3 is a different product with the same purpose: the database becomes the
sole source of truth, behind an API, and it ships under a new name,
**`@hjr15/blaze`**. It is a rename rather than a major version bump precisely
because a major bump would silently convert an existing zero-dependency file
writer into a client that needs a server. The reasoning is recorded in
[ADR-0008](../decisions/0008-v3-ships-as-hjr15-blaze.md).

### Why the reversal

The ceiling was concurrency, and it was structural rather than a matter of
polish. Multiple agent sessions across multiple machines could not write to one
board without branch-and-worktree ceremony, merge conflicts, a daily
squash-flush job acting as sole committer, and a
[three-layer id allocator](../decisions/0005-three-layer-id-allocator.md) built
solely to stop two machines minting the same id.

Two failures make it concrete, and neither is hypothetical:

- A ticket was observed **in two status directories at once**. Status *is* the
  directory, so it had two statuses — and because the two paths differ, git had
  nothing to conflict on and merged them cleanly.
- Two *different* tickets held **the same id** in two divergent trees. The
  allocator cannot see across an unmerged branch, so it never fired.

Both are one problem: the filesystem cannot express an invariant that spans two
trees. A database expresses each in a line of DDL. The full argument is
[ADR-0006](../decisions/0006-database-is-the-sole-source-of-truth.md).

### What v3 gives up

Stated plainly, because these were real strengths and not marketing:

- **Zero runtime dependencies, on the Postgres path.** Node has no built-in
  Postgres client. The `npx` + SQLite path stays genuinely install-free; the
  cluster path does not.
- **`git log --follow` as the audit trail.** It is replaced by a ticket-events
  log and event-sourced revert — built before files freeze, not after.
- **"Delete the engine and your board is still a complete set of files."** After
  v3, that is no longer true, and this page will not go on implying it.

A git markdown mirror was considered as a way to keep that last property, and
**declined**: it reintroduces exactly the two-writers problem v3 exists to
remove.

### What stays true

- `npx @hjr15/blaze serve` still works on a clean machine — no Docker, no
  Postgres, no config.
- The board is still a rendering, never a second source of truth.
- These ADRs stay in this repo and stay readable without the board.
- `@hjr15/blaze-board@0.6.0` keeps working exactly as this page describes, for as
  long as you keep using it.

---

Next: [How it works](how-it-works.md) · [Getting started](getting-started.md) ·
[Driving Blaze with an AI agent](driving-with-an-ai-agent.md)
