# Command reference

Every `blaze` invocation is `blaze <subcommand> [args] [flags]`. There are 15
subcommands. Most that write commit immediately (`commitMode: per-op`,
the default) or queue into a session ledger (`commitMode: batch`) — see
[Commit modes](#commit-modes) below.

| Subcommand | Purpose | Mutates? |
|---|---|---|
| [`start`](#start) | Boot the app — board + activity feed + reconcile/groomer loops | no (loops it drives can write) |
| [`board`](#board) | Serve the dashboard and its `/api/*` write endpoints | no (endpoints it serves can write) |
| [`reconcile`](#reconcile) | Mirror git/PR state onto delivery tickets | with `--apply` |
| [`groom`](#groom) | One agentic board-keeper pass | yes |
| [`new`](#new) | Create a ticket | yes |
| [`sprint`](#sprint) | Sprint registry (post-0.4.4) | yes (`new`); no (`list`/`active`) |
| [`reindex`](#reindex) | Rebuild derived caches | no (cache-only) |
| [`move`](#move) | Change a ticket's status | yes |
| [`edit`](#edit) | Edit one field on a ticket | yes |
| [`link`](#link) | Add/remove a typed link between tickets | yes |
| [`resolve`](#resolve) | Set/override resolution without moving the file | yes |
| [`log`](#log) | Append a worklog entry | yes |
| [`commit`](#commit) | Flush queued ops into one commit (batch mode) | yes |
| [`rollup`](#rollup) | Print rolled-up time for a node or every goal/epic | no |
| [`migrate`](#migrate) | Import tickets from an external tracker | with `--live` |

## start

```
blaze
blaze start
```

Boots the app: the HTTP board, the activity feed, and the reconcile and
groomer loops on their configured timers. Bare `blaze` is equivalent to
`blaze start`. Parses no CLI args — everything comes from env vars and
`blaze.config.json`. The loops it runs write through git the same as running
their commands directly.

## board

```
blaze board
```

Serves the read/write dashboard at `/` plus the `/api/*` write endpoints
(move, edit, resolve, log, acceptance-criteria toggle). Each write endpoint
is guarded by an `x-blaze-csrf` header. Parses no CLI args.

## reconcile

```
blaze reconcile [--apply] [--fetch] [--quiet]
```

Mirrors board status onto git/PR state for delivery-workflow tickets
(branch existence, PR open/merged/closed). Dry-run by default — it reports
what it would change and writes nothing.

| Flag | Meaning | Default |
|---|---|---|
| `--apply` | Commit the mirrored changes locally. Reconcile never pushes — push is hardcoded off. | off (dry-run) |
| `--fetch` | Fetch the linked code repo before comparing. | off |
| `--quiet` | Suppress output for tickets already in sync. | off |

## groom

```
blaze groom
```

Runs one agentic board-keeper pass: picks the first ungroomed ticket in the
configured columns, spawns the configured agent command against it, and
auto-commits the result. If the agent renames the ticket file or edits its
`status` or `resolution` fields, groom refuses the change and rolls it back.
No CLI args.

## new

```
blaze new --project <KEY> --type <type> "<title>" [flags]
```

Creates a ticket in its type's initial status: allocates the next id,
writes a schema-valid file, and commits it (or queues it, in batch mode).
`--project`, `--type`, and the title are required. Unknown flags are
rejected.

| Flag | Meaning | Default |
|---|---|---|
| `--priority <p>` | One of the fixed priority enum. | `medium` |
| `--labels a,b` | Comma-separated labels. | none |
| `--components a,b` | Comma-separated components. | none |
| `--estimate <m>` | Minutes, rounded to the nearest 5. | none |
| `--parent <ID>` | Parent ticket id (legality + cycle-checked). | none |
| `--assignee <name>` | Assignee. | `unassigned` |
| `--likelihood <v>` | Risk-type only. | none |
| `--impact <v>` | Risk-type only. | none |
| `--reason "<why blank>"` | Suppresses a required-labels/components warning. | none |
| `--sprint <id>` | Post-0.4.4. | none |
| `--start <date>` | Post-0.4.4. | none |
| `--due <date>` | Post-0.4.4. | none |

> **Version note.** `--sprint`, `--start`, and `--due` ship in the release
> after 0.4.4. `npm i -g @hjr15/blaze-board` today installs 0.4.4, which does
> not include them.

## sprint

```
blaze sprint new "<name>" --start <YYYY-MM-DD> --end <YYYY-MM-DD>
blaze sprint list
blaze sprint active <id>
```

> **Version note.** `sprint` ships in the release after 0.4.4. It is not in
> the currently-published npm package (0.4.4) — this section describes
> `main`.

The sprint registry. `sprint new` creates a sprint with a start and end
date. `sprint list` lists all sprints. `sprint active <id>` marks a sprint
active by id.

## reindex

```
blaze reindex [projectsDir]
```

Rebuilds the derived caches `.blaze/index.json` and `.blaze/transitions.json`
from the ticket files on disk. Cache-only — it touches no ticket file and
makes no commit. Optional positional `projectsDir` overrides which
`projects/` tree to index; the cache directory itself is overridable via
`BLAZE_DB_DIR`.

## move

```
blaze move <id> <status>
```

Validates the transition against the ticket type's workflow, sets
`resolution` if the target status is terminal, and relocates the ticket
file into the target status directory. Commits (or queues, in batch mode).

| Arg | Meaning |
|---|---|
| `<id>` | Ticket id. |
| `<status>` | Target status — must be a legal forward edge, or the reopen target. |

## edit

```
blaze edit <id> <field> <value>
```

In-place edit of one whitelisted field. Any other field name errors.

| Arg | Meaning |
|---|---|
| `<id>` | Ticket id. |
| `<field>` | One of: `title`, `assignee`, `priority`, `labels`, `components`, `estimate`, `parent`, `likelihood`, `impact`, `due`, `sprint`, `start`. |
| `<value>` | New value for the field. |

> **Version note.** The `sprint`, `start`, and `due` fields ship in the release
> after 0.4.4 — editing them isn't available in the currently-published package.

## link

```
blaze link [--rm] <id> <TYPE> <target>
```

Adds (or, with `--rm`, removes) a typed link on `<id>`. Adding a link
requires the target ticket id to resolve to a real ticket.

| Arg | Meaning |
|---|---|
| `<id>` | Ticket id the link is recorded on. |
| `<TYPE>` | One of `Blocks`, `Relates`, `Duplicate`, `Cloners`. |
| `<target>` | The other ticket's id. |

| Flag | Meaning | Default |
|---|---|---|
| `--rm` | Remove the link instead of adding it. | off (add) |

## resolve

```
blaze resolve <id> <resolution>
```

Sets or overrides `resolution` on a ticket without moving its file — the
non-Done close path (Won't Do, Duplicate, Cannot Reproduce, or an explicit
Done without a status move).

| Arg | Meaning |
|---|---|
| `<id>` | Ticket id. |
| `<resolution>` | One of `done`, `wont-do`, `duplicate`, `cannot-reproduce`. |

## log

```
blaze log <id> <minutes> [--date YYYY-MM-DD] [--note "..."]
```

Appends a worklog entry to a ticket.

| Arg / Flag | Meaning | Default |
|---|---|---|
| `<id>` | Ticket id. | — |
| `<minutes>` | Time spent, rounded to the nearest 1 minute. | — |
| `--date YYYY-MM-DD` | Date of the entry. | today |
| `--note "..."` | Free-text note on the entry. | none |

## commit

```
blaze commit [--all]
```

Flushes queued ops into one git commit. Only meaningful when
`commitMode: batch` — see [Commit modes](#commit-modes). Stages only the
files recorded against the flushed ops, never `git add -A`.

| Flag | Meaning | Default |
|---|---|---|
| `--all` | Sweep every session's queue plus the shared fallback queue. | off (drains only the caller's own session queue, keyed by `BLAZE_SESSION`) |

## rollup

```
blaze rollup [<id>]
```

Read-only time roll-up. With an id, prints that node's own and rolled-up
estimate and worklog time plus a child breakdown. Without an id, prints a
summary across every goal and epic. Makes no writes.

## migrate

```
blaze migrate [--dry-run|--live] [--project <KEY>] [--merge]
```

Imports tickets from an external tracker (Jira) via a reviewed disposition
ledger. Dry-run is the default: it writes an audit and a
`disposition-ledger.json` for review, but no ticket files. `--live` applies
the reviewed ledger.

| Flag | Meaning | Default |
|---|---|---|
| `--dry-run` | Write the audit + ledger only; no ticket files. | on |
| `--live` | Apply the reviewed ledger and write ticket files. | off |
| `--project <KEY>` | Restrict the migration to one project. | falls back to `blaze.config.json`'s `projects` list |
| `--merge` | Merge behaviour for tickets already present. | off |

> **Blast radius.** `--live` is the one Blaze command whose staging is not
> file-scoped: it runs `git add -A` over the data repo instead of staging
> only the files it wrote. Review the disposition ledger and your working
> tree before running it, especially if you have unrelated uncommitted
> changes sitting in the same repo.

---

## No `--help`

> There is no `--help` command and no per-subcommand `--help`, on 0.4.4 or
> on `main`. Running `blaze` with an unknown command prints a one-line
> usage listing the subcommands and exits 1. Some verbs print a usage line
> to stderr when a required argument is missing. Neither is a help system —
> this page is the reference.

## Environment variables

| Variable | Controls | Default |
|---|---|---|
| `BLAZE_PROJECTS_DIR` | Explicit path to the data repo's `projects/` directory. Lets the engine run from anywhere. | none — falls back to a `projects/` dir under the current working directory |
| `BLAZE_KEY` | Ticket id prefix override. | the `key` in `blaze.config.json` |
| `BLAZE_PORT` | Board port. | 4321, unless overridden (see below) |
| `PORT` | Board port; takes precedence over `BLAZE_PORT` and config. | — |
| `HOST` | Bind host for `blaze board`. `blaze start` / bare `blaze` always binds `127.0.0.1`. | `127.0.0.1` |
| `BLAZE_AGENT_COMMAND` | The command `groom` spawns to act on a ticket. | `agentCommand` in `blaze.config.json` |
| `BLAZE_COMMIT_MODE` | `per-op` or `batch`. | `per-op` |
| `BLAZE_CODE_REPO` | Code repo `reconcile` mirrors against, when not set per-project. | none |
| `BLAZE_SESSION` | Key for the batch-mode op queue, so parallel sessions isolate. | unset → a single shared fallback queue (`.blaze/pending-commit.jsonl`) |
| `BLAZE_DB_DIR` | Directory for the derived `.blaze/` caches. | `.blaze/` under the data repo |

Port resolution order: `PORT` env, then `BLAZE_PORT` env, then `port` in
`blaze.config.json`, then 4321.

## Commit modes

Default `commitMode` is `per-op`: every mutating verb commits immediately,
scoped to the files it touched. Set `commitMode: batch` in
`blaze.config.json` (or `BLAZE_COMMIT_MODE=batch`) to instead queue each op
into a per-session ledger and flush it later with `blaze commit`.
`BLAZE_SESSION` keys that ledger, so parallel sessions queue independently
without stepping on each other. See
[Driving Blaze with an AI agent](driving-with-an-ai-agent.md) for when to
choose which mode.

## Types, workflows, priorities, resolutions

The type registry (goal/epic/risk/story/task/bug/subtask), their
workflows, and how to customise them live in [`schema.md`](schema.md) —
not repeated here. Two enums you pass as literal command arguments above:

- `link` `<TYPE>`: `Blocks`, `Relates`, `Duplicate`, `Cloners`.
- `resolve` `<resolution>`: `done`, `wont-do`, `duplicate`, `cannot-reproduce`.

---

Next: [Schema and customisation](schema.md) ·
[Driving Blaze with an AI agent](driving-with-an-ai-agent.md) ·
[Guide index](README.md)
