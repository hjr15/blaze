<p align="center">
  <img src="brand/readme_graphic.jpg" alt="Blaze" width="420">
</p>

<p align="center"><b>Agentic AI for App Development</b><br>
A file-based, git-native issue tracker built for AI coding agents to drive.</p>

---

Blaze is plain files, all the way down:

- **A ticket is a markdown file** — frontmatter + a body. No database, no login.
- **A ticket's status is the directory it sits in.** There is no `status:` field, so
  it cannot drift out of sync with reality.
- **Git is the history.** `git log --follow` on a ticket file is its full audit trail;
  every mutation is a small, revertable commit.
- **The board is a rendering, never a second source of truth** — `blaze board` reads
  the same files you'd `ls` / `grep` / `git mv` by hand.

It's built AI-first: an agent drives the tracker with the file tools it already has,
or with the `blaze` CLI. No API client, no auth, no SDK required either way.

## Install

```bash
npm i -g @hjr15/blaze-board
# or, without installing:
npx @hjr15/blaze-board <command>
```

Requires Node 20+ and `git` on `PATH`.

## The engine ⟂ data split

This package is the **engine** — the `blaze` CLI and its web board. Your tickets
live in a separate **data repo**: a `blaze.config.json` plus a
`projects/<KEY>/<status>/` tree, versioned in its own git history.

Attach the engine to a data repo one of two ways:

- run `blaze` from inside the data repo (it looks for a `projects/` directory in
  the current working directory), **or**
- set `BLAZE_PROJECTS_DIR` to the data repo's `projects/` directory, from anywhere.

One global `npm i -g @hjr15/blaze-board` install can drive any number of unrelated
data repos this way — upgrade the engine once, keep every board's ticket history in
its own repo.

## Quickstart

```bash
# 1. a data repo — just a directory with its own git history
mkdir my-tracker && cd my-tracker && git init

# 2. the engine needs a key and at least one project
mkdir -p projects/ENG
cat > blaze.config.json <<'EOF'
{ "key": "ENG", "projects": ["ENG"] }
EOF
git add -A && git commit -m "init board"

# 3. create a ticket — task/story/bug require --estimate; every type gets a
#    scaffolded description body
blaze new --project ENG --type task "Fix the export bug" --estimate 30

# 4. open the board
blaze board   # → http://localhost:4321
```

`blaze new` writes the ticket, validates it against the schema, and commits it — one
small commit per ticket, scoped to the files it actually touched.

## CLI verbs

| Command | Does |
|---|---|
| `blaze new --project <KEY> --type <type> "<title>" [--estimate m] [--parent ID] [--priority p] [--labels a,b]` | Create a ticket in its type's initial status |
| `blaze move <id> <status>` | Change status (validates the transition; auto-sets `resolution` on a terminal status) |
| `blaze resolve <id> <done\|wont-do\|duplicate\|cannot-reproduce>` | Set a non-default resolution without moving the file |
| `blaze log <id> <minutes>` | Append a worklog entry |
| `blaze rollup [<id>]` | Print rolled-up estimate/logged time for one node, or a summary of every goal/epic |
| `blaze reconcile [--apply] [--fetch]` | Mirror a linked code repo's branch/PR state onto delivery-workflow tickets (dry-run by default) |
| `blaze edit <id> ...` | Edit ticket fields |
| `blaze reindex` | Rebuild/validate the on-disk index |
| `blaze commit` | Flush queued ops into one commit (`commitMode: batch`) |
| `blaze migrate [--dry-run\|--live] [--project <KEY>]` | Import tickets from an external tracker via a reviewed disposition ledger (`--project` optional — falls back to `blaze.config.json`'s `projects` list) |
| `blaze board` | Serve the read-only kanban view |

See [`AGENTS.md`](AGENTS.md) for the full contract — types, workflows, the git join
key, and how an agent should drive the board.

## Configuration

`blaze.config.json` lives at the data repo's root. Minimally:

```json
{ "key": "ENG", "projects": ["ENG"] }
```

`key` is the ticket id prefix (`ENG-1`, `ENG-2`, ...); `projects` lists which
`projects/<KEY>/` directories the board renders. Per-project settings (labels,
`codeRepos` to mirror, `requireWorklogBeforeTerminal`) live in
`projects/<KEY>/project.json` — see [`AGENTS.md`](AGENTS.md#configuration).

The type registry and workflows are themselves configurable: add a `schema` block
(top-level or per-project) to override or extend the built-in defaults without
editing engine source — see
[`docs/schema-customization.md`](docs/schema-customization.md).

## Origin

This is a public continuation of [`sychyoboN/blaze`](https://github.com/sychyoboN/blaze).

## License

MIT.
