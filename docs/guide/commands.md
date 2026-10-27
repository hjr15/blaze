# Command reference

Every `blaze` invocation is `blaze <subcommand> [args] [flags]`. The table below covers the
subcommands documented on this page; `blaze --help` lists every one. Verbs that write change
the board's files (or its database rows) and never commit (BLZ-254); on a file board you
version the changes yourself. See [commitMode (ignored)](#commitmode-ignored) and
[Removed commands](#removed-commands) below.

| Subcommand | Purpose | Mutates? |
|---|---|---|
| [`start`](#start) | Boot the app — board + activity feed + reconcile/groomer loops | no (loops it drives can write) |
| [`board`](#board) | Serve the dashboard and its `/api/*` write endpoints | no (endpoints it serves can write) |
| [`reconcile`](#reconcile) | Mirror git/PR state onto delivery tickets | with `--apply` |
| [`groom`](#groom) | One agentic board-keeper pass | yes |
| [`new`](#new) | Create a ticket | yes |
| [`sprint`](#sprint) | Sprint registry | yes (`new`); no (`list`/`active`) |
| [`reindex`](#reindex) | Rebuild derived caches | no (cache-only) |
| [`move`](#move) | Change a ticket's status | yes |
| [`edit`](#edit) | Edit one field on a ticket | yes |
| [`link`](#link) | Add/remove a typed link between tickets | yes |
| [`resolve`](#resolve) | Set/override resolution without moving the file | yes |
| [`log`](#log) | Append a worklog entry | yes |
| [`import`](#import) | Create or update tickets from a canonical or mapped CSV or a Markdown tree | with `--apply` |
| [`rollup`](#rollup) | Print rolled-up time for a node or every goal/epic | no |
| [`matrices`](#matrices) | Regenerate the requirements and architecture matrices | yes; no with `--check` |
| [`migrate`](#migrate) | Import tickets from an external tracker | with `--live` |
| [`db`](#db) | Create the database schema, load the board into Postgres, check the load, seed its id counter, report the dual-write soak | yes (`init`, `seed-counter`, `load`); no (`verify`, `status`) |
| [`user`](#user) | Add a board user and issue its API token | yes |

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

This is a **second HTTP server**, separate from [`blaze board`](#board), and the same
access rules apply to it (ADR-0013). Its `/control/*` routes need a `write`-scoped
token once the board has users — `/control/groomer/run` dispatches the configured
agent and `/control/revert` runs `git revert` — and its `/events` stream and board
content need `read`. It **always binds `127.0.0.1`** and ignores `HOST`, so unlike
`blaze board` there is no configuration that exposes it beyond this machine.

## board

```
blaze board
```

Serves the read/write dashboard at `/` plus the `/api/*` endpoints (move,
edit, resolve, log, acceptance-criteria toggle, and — for the remote CLI, BLZ-684 — new and
link). Parses no CLI args.

A write from the page (or `POST /api/*`) changes the ticket file (`fs`, `dual`) or row (`db`)
and **makes no commit** (BLZ-254). The 200 body is `{ ok: true, db }` plus the route's own
fields.

**Access depends on whether the board has any users** (ADR-0013, and ADR-0034 for the
browser half). See [HTTP surface](../architecture.md#http-surface) for which route needs
which scope.

- **No users configured, bound to loopback** — served without authentication,
  exactly as Blaze always has. The bind address *is* the boundary, and that is
  unchanged for every single-operator board.
- **No users configured, bound to anything else** (`HOST=0.0.0.0`, a LAN address,
  a container) — `blaze board` serves the **first-run setup flow at `/setup`** and
  nothing else at all; every other route answers `503` until an administrator
  exists (BLZ-358).
- **One or more users** — every `/api/*` call and all board content (`GET /`,
  `GET /view/<name>`) needs a credential. There are **two**, and they are not
  interchangeable:
  - `Authorization: Bearer blz_…` — for the API, `curl`, the CLI and a reverse
    proxy that injects it. Issue one with `blaze user add`.
  - a **browser session**, obtained by signing in at `/signin` with an email
    address and a password. The session arrives as an `HttpOnly`,
    `SameSite=Strict` cookie that expires after 12 hours, and `POST /signout`
    revokes it.

  Whichever one is presented, its scopes are re-intersected with the owner's
  *current* role on every request, so demoting a user immediately narrows every
  token **and every live session** they hold. A bearer token presented in the
  cookie is not a session and a session presented in the header is not a token —
  the two credential spaces are disjoint by construction.

- **`.blaze/identity.db` exists but is unreadable** (truncated, corrupt, or not a
  database) — `blaze board` **refuses to start** and names the file. This is never
  read as "no users": on disk a stray file and a truncated roster look identical, and
  treating the second as the first would silently remove authentication from a board
  that had it.

  The sign-in and setup forms **POST**, and neither route accepts a query string:
  a request carrying one is refused with `400` rather than answered, so a password
  or a setup token can never reach browser history or a proxy access log. Both
  pre-auth responses carry `Cache-Control: no-store`, `Referrer-Policy:
  no-referrer` and a `default-src 'none'` CSP. JavaScript is required to submit
  either form; with it disabled the submission is refused, and the page says so.

  Both servers serve `/signin`, and both send a browser there: an unauthenticated
  request for board content that asks for HTML gets a `302` to `/signin`, while a
  request that does not (`curl`, a health check, the API) keeps the `401` it has
  always had and is told in prose where the door is. `/signin` is **absent** —
  a plain `404`, not a hidden route — on a board with no users, and unreachable
  during first-run setup, which owns the surface until an administrator exists.

  To set the password an address signs in with, on the machine hosting the board:

  ```
  blaze user passwd --email you@example.com
  ```

  It reads the password from **stdin**, never from a flag: `argv` is visible to
  every process on the box through `ps` and is written to shell history. A password
  flag is refused in every spelling — and, more generally, **no error this command
  prints ever repeats an argument it did not recognise**, naming its position
  instead, so a secret typed where a flag was expected never reaches stderr, a
  terminal scrollback or a CI log. Minimum 12
  characters. Only a scrypt verifier is stored — the password itself is never
  written to `identity.db`, to a log, or to the terminal. The first-run `/setup`
  form asks for one too, so a freshly deployed board is signable-into the moment
  setup completes.

An unclassified `/api/*` route returns `404`; a route added without a scope fails
closed rather than inheriting the last one's.

The `x-blaze-csrf` header is **not** authentication — on either server. It is a
per-process value embedded in the served page, readable by anyone who can `GET /`. It is
forgery protection for the browser flow, retained as defence-in-depth alongside the token
check, never as a substitute for it. On `blaze board`'s `POST /api/*` a request authenticated
by an `Authorization: Bearer` token, with **no** session cookie, a `content-type:
application/json` body and no cross-site `sec-fetch-site`, skips it (BLZ-684, ADR-0013's
addendum) — that is a CLI on another machine, never a browser; a request that carries the
`blaze_session` cookie, a form or text body, or a browser's cross-site fetch metadata still
needs it, even when a reverse proxy injected the bearer token, and so does every request on a
board with no users. `blaze start` also requires it on `/control/*`,
where it is the only control that covers a loopback board with no users at all: the gate
has no credential to ask for there, but a page in your own browser can still POST
cross-origin to `http://localhost:<port>/control/revert` without one.

## reconcile

```
blaze reconcile [--apply] [--fetch] [--quiet] [--project KEY] [--ticket ID]
```

Mirrors board status onto git/PR state for delivery-workflow tickets
(branch existence, PR open/merged/closed). Dry-run by default — it reports
what it would change and writes nothing.

| Flag | Meaning | Default |
|---|---|---|
| `--apply` | `--apply` writes the moves to the ticket files on a file board (`fs`, `dual`). **Reconcile never commits** (BLZ-254). On a file board, version the changed files yourself. The last line of an applied run says how many tickets moved and where. Reconcile never pushes either — push is hardcoded off. | off (dry-run) |
| `--fetch` | Fetch the linked code repo before comparing. | off |
| `--project KEY` | Restrict BOTH the scan and the write to the named project(s) — a session that owns three tickets should not write moves to fifteen it never touched (BLZ-394). Repeatable, comma-separated, and `--project=KEY`; all three spellings, because a filter that silently ignores the one you typed is worse than no filter. An **unknown** key refuses the whole run rather than scanning the subset it understood, and `--project=` with an empty value is a caller error, not an unfiltered run — `--project=$PROJ` with `$PROJ` unset used to reconcile the whole board silently. A filtered run always prints `reconcile: scanned project(s): …`, even under `--quiet`. | all configured projects |
| `--ticket ID` | Finer than `--project`: restrict the run to the named ticket(s) (BLZ-451). Same three spellings — repeatable, comma-separated, and `--ticket=ID` — deliberately, since a second flag accepting a different subset would be worse again. A ticket id is `<KEY>-<number>`; the key half is a project key and is **refused, never normalised** ([ADR-0025](../decisions/0025-a-project-key-is-refused-never-normalised.md)), so `inf-1` names a project this board does not configure rather than being read as `INF-1`. Four refusals, each naming what is wrong: the flag given no id, a value that is not a ticket id, an id outside this run's projects, and an id no ticket on this board carries. | all tickets in scope |
| `--quiet` | *Print only on change.* It gates whole-run lines only — never per-ticket output. Suppressed on a pass that decided nothing: `reconcile: no code-bound change found — nothing to do.`, `reconcile: no projects configured — nothing to reconcile.`, and `reconcile: scanned project(s): …` (that last one is printed anyway whenever `--project` was given, because a filtered run must never read as a whole-board one). Per-ticket `moved` / `would move` lines, the dry-run tail, and every `WARNING` / `FORGE UNREADABLE` / `FORGE DATA` / `NEEDS ATTENTION` line on stderr are printed under `--quiet` exactly as without it. | off |

**A db-mode board refuses (BLZ-723).** Under `BLAZE_WRITE_PORT=db` (a deployed board) status
changes only by an explicit `blaze move` (remote mode, on a deployed board), so `blaze reconcile`
exits `1` with a message naming that rule, and does so on a dry run too: the preview of a board
that never reconciles is noise. `GET /api/reconcile-preview` answers `409`, the page omits the
Reconcile button, and `blaze start`'s reconcile loop refuses each pass without publishing a feed
event (the loop's own "started" status still appears). In db mode `POST /control/reconcile/run`
answers 204 and does nothing.

PR state is read with the GitHub CLI (`gh`), which supports GitHub.com and GitHub
Enterprise Server only. On any other remote, `in-review` is unreachable and
reconcile prints a `FORGE UNREADABLE` line to stderr on every run (including under
`--quiet`) rather than reporting a clean board; it still exits 0, because the
branch and merged-commit signals are unaffected. See
[Forge support and status reachability](how-it-works.md#forge-support-and-status-reachability).

**An applied run leaves the board's tree dirty, by design (BLZ-254).** Reconcile
makes no git commit, so after an `--apply` on a file board the moved ticket files show
in `git status` until you commit them. A later run reports only what *it* found, never
a claim about the state of the git tree.

**A change line only ever claims a move it can prove (BLZ-401).** A ticket can be
written without its status changing — a blank `resolution` backfilled on an already-
`done` ticket, a delivery record filled in for the first time, or cleared because no
single PR delivered it (ADR-0023 §1) — and that entry stays on the report (dropping it
would erase the only account of a record deletion) but is rendered as `updated <id>
(still <status>): …`, never as a move. The `--apply` applied line and the dry-run tail
line both name two quantities for the same reason: how many tickets' status actually
moved, and — only when it is non-zero — how many files were written without a status
change.

**A ticket a single-project run cannot reconcile is reported, not resolved
(BLZ-406).** `--project <KEY>` scopes on the ticket's DIRECTORY (ADR-0001: the directory
is status, and it is where a write lands), while the signal that would move it is keyed
by the ticket's frontmatter `project`. A ticket sitting under one project's directory
while its frontmatter names another is therefore invisible to every single-`--project`
run — naming its directory excludes it before the signal is even consulted, and naming
its frontmatter key finds no signal keyed by the directory it is actually filed under.
Reconcile emits a `project-mismatch` finding for it on **every** run, filtered or not,
naming the ticket, its directory, and its frontmatter key, rather than silently picking
a side. See [ADR-0023 §7](../decisions/0023-reconcile-signals-bias-toward-not-shipped.md).

## groom

```
blaze groom
```

Runs one agentic board-keeper pass: picks the first ungroomed ticket in the
configured columns, spawns the configured agent command against it, and
auto-commits the result. If the agent renames the ticket file or edits its
`status` or `resolution` fields, groom refuses the change and rolls it back.
No CLI args.

Under `BLAZE_WRITE_PORT=db` (BLZ-673) the ticket is read from the database and written to a
fresh scratch directory as `<id>.md`; the agent edits that file, and the result is written
back through the write port — nothing is committed. The agent runs with `BLAZE_READONLY=1`,
so a `blaze` write it attempts **while following the rules** is refused — it is a guard, not a
sandbox: the agent controls its own environment and can unset it, or reach a running board
server that is not read-only. What catches that is the store check. The pass is refused, and
the groom not written, if:

- **the store changed while the agent ran** (`store-changed`) — any write through the write
  port by anyone, the agent included, moves the last `ticket_event` id, and on SQLite a swapped
  `.blaze/blaze.db`/`config.db` changes its inode. The store's own writes **stand** (a store
  cannot be rewound). Board files are left as found (`restoreSkipped`) — rewinding another
  session's receipt or git ref would half-revert it — **except** `.blaze/database.json`,
  `blaze.config.json`, `AGENTS.md`, `.blaze/identity.db` (and its `-journal`/`-wal`/`-shm`),
  `.git/config` and `.git/hooks/`, which are always restored (`restored`). Three tradeoffs come
  with that: a `blaze user add` from another session during the pass is undone, so is
  another session's own `.git/config` change (branch tracking, `git remote add`, `push -u`), and
  so is a person's own edit to `AGENTS.md` made during the pass (or pulled in by git) —
  judged smaller than an agent-written credential or `core.hooksPath`. The event carries
  `backedOff: true`: the ticket's current hash is recorded, so that same unchanged ticket is
  not offered to the agent again. This bounds reruns of **that one ticket**; it does not stop an
  agent that unset `BLAZE_READONLY` from grooming a ticket it planted itself. To re-queue a
  backed-off ticket, delete its entry under `groomed` in `.blaze/state.json`;
- **the agent wrote any other file** (`out-of-bounds`) — in the scratch directory or anywhere on
  the board (the whole data root is surveyed as on the fs path, except `.blaze/blaze.db`,
  `.blaze/config.db` and their `-wal`/`-shm`/`-journal` files, which the store check covers);
  the board files it touched are restored;
- it changed a field outside the editable set (`title`, `type`, `assignee`, `priority`,
  `labels`, `components`, `estimate`, `parent`, `likelihood`, `impact`, `sprint`,
  `not_before`, `deadline`) plus `updated`, or left a ticket `blaze edit` would reject.

`blaze groom` (and the `blaze start` loop) itself refuses under `BLAZE_READONLY` in db mode —
a db groom writes the store. In fs mode `blaze groom` is refused under `BLAZE_READONLY` by the CLI's dispatch gate; only a direct `node scripts/loops/groomer.mjs` in fs mode has no guard of its own (a named residual).

Not covered: store writes the agent makes after unsetting `BLAZE_READONLY` (refused as a pass,
but they stand); a raw SQL write that appends no `ticket_event` row — an agent that holds the database credentials and runs `psql`, a direct `sqlite3 … UPDATE`, or a crafted `-wal` file swapped in. That moves neither the event id nor a file identity (a re-read of the
groomed row still catches it on that one row). A db groom has no commit, so the feed offers
no revert for it.

## new

```
blaze new --project <KEY> --type <type> "<title>" [flags]
```

Creates a ticket in its type's initial status: allocates the next id,
writes a schema-valid file, and stops: it makes no commit (BLZ-254).
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
| `--sprint <id>` | Assign the ticket to a sprint by id. | none |
| `--start <date>` | Planned start date. | none |
| `--due <date>` | Due date. | none |

## sprint

```
blaze sprint new "<name>" --start <YYYY-MM-DD> --end <YYYY-MM-DD>
blaze sprint list
blaze sprint active <id>
```

The sprint registry. `sprint new` creates a sprint with a start and end
date. `sprint list` lists all sprints. `sprint active <id>` marks a sprint
active by id.

The registry is `sprints.json` at the data root — except on a db-mode
(`BLAZE_WRITE_PORT=db`) Postgres board at schema v6, where it lives in the database's
`sprint` and `sprint_registry` tables: `blaze sprint` reads and writes there, each save
in one transaction, and `sprints.json` is not read. The board, the gantt, `blaze reindex`
and `--sprint` validation read the same source. There, `new` and `active` name the
database (`created S3 (database: <host>/<database>)`); everywhere else the output is
unchanged. Import an existing `sprints.json` once with `blaze db migrate --sprints-from`
(see [db](#db)).

## reindex

```
blaze reindex [projectsDir]
```

Rebuilds the derived caches `.blaze/index.json` and `.blaze/transitions.json`
from the ticket files on disk. Cache-only — it touches no ticket file and
makes no commit. Optional positional `projectsDir` overrides which
`projects/` tree to index; the cache directory itself is overridable via
`BLAZE_DB_DIR`.

## audit

```
blaze audit [--projects A,B] [--kind <kind>] [--fail-on <kind,…>] [--json] [projectsDir]
```

Read-only corpus hygiene over the whole board. Findings split two ways, and the
split is the point (ADR-0011): a **hard** finding means the corpus is *wrong* and
fails the run; a **soft** finding is a *fill queue* and never fails one. A gate
that fails on the fill queue is a gate people learn to skip, which costs the hard
findings too.

| Severity | Kinds |
|---|---|
| hard | `duplicate-status`, `off-taxonomy-component`, `off-taxonomy-label`, `bad-link-key`, `unknown-link-type`, `dangling-target`, `dangling-parent`, `invalid-parent-type`, `parse-error`, `config-unloadable`, `schema-malformed`, `project-mismatch` |
| soft | `empty-components`, `empty-labels`, `missing-parent`, `terminal-goal-unverified-requirement`, `schema-invalid`, `deadline-unreachable`, `dependency-cycle`, `schedule-stale`, `schedule-empty`, `empty-body`, `config-project-drift`, `terminal-parent-open-child` |

`schema-malformed` and `schema-invalid` (BLZ-392, split by severity in BLZ-407) both come from
`auditCorpus` reading the tagged `collectSchemaProblems`. `schema-malformed` is HARD: the
override is internally inconsistent — a type mapping to an undeclared workflow, a partial type
or workflow record, a wrong-shaped `types`/`workflows` container — the same class the load
path's `assertSchemaValid` already refuses on for every non-exempt verb, so `blaze audit` must
refuse too or it is the one surface claiming a broken board is healthy. `schema-invalid` stays
SOFT: a `schema` block that is legal but did not do what it looks like it does, most often a
`linkTypes` entry the merge ignored, or a deliberately narrowed workflow. Soft because the
shipped declaration is still in force there, so the corpus is judged correctly; what is wrong is
the operator's expectation. See [ADR-0024](../decisions/0024-audit-and-the-load-path-agree-on-a-malformed-schema-override.md).

`config-unloadable` (BLZ-402 review finding 1, tightened by round-2 finding 3 and round-3)
fires on **any** `loadConfig` throw *except* the two BLZ-392 explicitly tolerates.
Concretely, it fires on: an invalid `key` or `projects[]` entry (BLZ-402's shape check); a
malformed `schedule` block — the wrong shape (e.g. a string instead of an object), an
unknown key (e.g. `minutesPerDay` instead of `minutes_per_day`), or a bad `minutes_per_day`
/ `working_days` value; and a `blaze.config.json` that sets a key this engine no longer
reads (`provider`, `terminal`, `codeRepo`; BLZ-298). That last case says nothing about the
`schemaVersion` stamp — a removed key and an out-of-window stamp are unrelated failures, so
`scripts/model/schema-version.mjs` tells them apart at the source (round 3) rather than
letting a removed-key board fall into the schemaVersion tolerance below. It does **not**
fire on the two cases BLZ-392 established a tolerance for: `blaze.config.json` failing to
*parse* as JSON, or carrying a `schemaVersion` stamp genuinely outside the engine's
supported window — both of those are treated as though the config were absent, `ok=true` if
the corpus itself is otherwise clean, exactly as before. Raised by the
runner rather than `auditCorpus`, the same way `duplicate-status` is: whether `loadConfig`
threw, and for which of the two reasons, is a property of the load attempt, not of any
ticket's frontmatter. HARD, deliberately — `audit` is exempt from `cli.mjs`'s schema
preflight on the ground that reporting exactly this class of problem IS its job, and a
report that reached `ok=true` on a board whose config failed to load for one of these
reasons would be exactly the silent pass this finding exists to prevent. It DOES still fall
back to a disk listing for the project set when the config fails to load this way (matching
`--projects` and matching the BLZ-392 parse-failure tolerance) — falling back to *report
nothing* instead was tried and reverted, because the distinction that actually matters is
`ok=true` vs `ok=false`, not whether a denominator gets reported at all.

The last four come from `scheduleFindings()` (ADR-0022, BLZ-379, BLZ-392) and are **all soft on purpose**: HARD means the *corpus* is wrong, and a missed deadline or an unschedulable pair of well-formed links means the *plan* is wrong, which is a true statement about a correct corpus. `terminal-goal-unverified-requirement` was already soft and already missing from this table before BLZ-379 — see `scripts/model/audit.mjs` for why each one is classified where it is.

| Arg | Meaning |
|---|---|
| `--projects A,B` | Audit only these project keys. Default: every project in the config. |
| `--kind <kind>` | List every finding of one kind, with its detail, instead of the summary. |
| `--fail-on <kind,…>` | Decide the exit code by these kinds only, hard or soft: `1` if any finding of one of them, else `0` — whatever else the run found. Exit `2` instead when the run could not observe the whole board (`unreadable-ticket-directory` or `config-unloadable` present), or when a kind is unknown. It judges every finding, whatever `--kind` narrowed the listing to. The plain report ends `fail-on <kinds>: N finding(s) — FAIL`, `— pass` or `— could not observe the whole board`; under `--json` the same verdict is `failOnVerdict` (`fail`, `pass`, `could-not-observe`, with the blinding kinds in `failOnBlind`), and a `fail` is also said on stderr. `ok` in the JSON is still the hard-kind verdict, not the gate's. |
| `--json` | Emit the full report as JSON. |
| `projectsDir` | Audit a `projects/` tree outside the current board. |

Exit code is `0` when clean or soft-only, `1` on any hard finding, and `2` when
the corpus is empty — a run that measured nothing is never reported as a pass. With
`--fail-on`, `1` means a finding of a named kind and nothing else, and `2` also covers a run
that could not read the whole board.

**Three kinds re-homed from blaze-pm's governance scripts** (BLZ-681). Each reads through the
resolved store, so it works under `fs`, `dual` and `db`. Each rule started as the script's own,
and BLZ-689 corrected the first one:

- **`terminal-parent-open-child`** (soft, was `terminal_parent_scan.py`): a terminal ticket with
  a child that is not terminal, any type pair, across projects. The parent says the work is
  finished while the child says it is not. **Terminal is judged per ticket, from its own type's
  workflow** (BLZ-689), on both sides of the edge. So a requirement in `implemented`, `verified`
  or `rejected` counts as terminal, the same as a feature in `done` or an ADR in `accepted`. A
  goal whose requirements are all `verified` is clean. A `verified` requirement with an open
  feature is a finding. **Open `risk` children are exempt.** A risk is parented to the decision
  or requirement it threatens, and it stays open while that parent is terminal. It stays soft:
  the owner has chosen to leave several real findings on blaze-pm's board for now, and a hard
  kind would turn the board gate red. Hard promotion is deferred until those rows are resolved.
  Until then, `blaze audit --fail-on terminal-parent-open-child` gates on this kind alone.
- **`empty-body`** (soft, was `empty_body_scan.py`): a non-terminal ticket whose body is only
  headings, blank lines, empty checkboxes, bare bullets and HTML comments — what `blaze new`
  leaves for a title-only ticket.
- **`config-project-drift`** (soft, was `config_drift_check.py`): `blaze.config.json`'s
  `projects` and the projects the store holds disagree, in either direction. Not raised when the
  config lists no projects at all. **What "the store holds" means differs by mode.** Under `fs`
  and `dual` it is the directories under `projects/` — a project directory with no tickets yet
  (only a `project.json`, or empty status folders) counts as held. Under `db` it is the project
  keys that have at least one live ticket row, so the same freshly created, still-empty project
  is reported as drift in `db` mode and not in `fs` mode. The fix either way is a ticket or a
  config line, never a code change.

`blaze audit --fail-on duplicate-status` is the gate `duplicate_id_check.py` was: it fails on a
duplicated id alone, on a board that already carries other hard findings.

**`--projects` scopes what is judged, never what resolves** (BLZ-681). A link target or parent in
a project outside the list still exists, so `blaze audit --projects BLZ` does not call
`BLZ-134 → INF-750` a `dangling-target`; only the listed projects' tickets are judged. The
governance kinds follow the same rule: an in-scope parent's open child in another project still
counts for `terminal-parent-open-child`, and `config-project-drift` names only listed projects.

**An unscoped run judges the configured projects but resolves against the whole store.** With no
`--projects`, the projects judged are `blaze.config.json`'s `projects` (or, when it lists none,
every project the store holds). Links and parents still resolve against *every* ticket the store
holds, including tickets in a project directory the config does not list. So a link into an
unlisted project is not a `dangling-target`, and an unlisted project's open child still counts
for its listed parent's `terminal-parent-open-child`. The unlisted project itself is never judged.
It shows up once, as `config-project-drift`.

**`duplicate-status`** is the one finding that comes from the *walk* rather than
from frontmatter. Status is the directory, so an id resolving to files under two
status directories has two contradictory statuses at once and every derived view
silently picks one. The finding names every path; the mutating verbs
(`move`/`edit`/`link`/`log`/`resolve`) refuse to act on such an id at all rather
than guess which copy is the ticket. Repair it by deleting the wrong-directory
*duplicate file* — never the ticket, and never its id claim.

**`project-mismatch`** (BLZ-406 AC-3) is another walk-raised finding: a ticket whose
directory disagrees with its frontmatter `project` — filed under one project's tree
while claiming another's. `auditCorpus` cannot see it (it is a function of frontmatter,
which carries no path); the runner can, the same way it sees `duplicate-status`. HARD
because the corpus really is wrong, not merely unfilled — re-measured at blaze-pm branch
`BLZ-305-v4-spine` (`1d172e1e6edfe481465609c9dfd05bd97f6b8930`), across 2,682 tickets in
11 projects, this is **zero**, so shipping it hard fails no existing board (the BLZ-353
lesson: measure before shipping hard). `reconcile`'s own `project-mismatch` finding is
this one's sibling on the write side — see [`reconcile`](#reconcile) above.

## move

```
blaze move <id> <status>
```

Validates the transition against the ticket type's workflow, sets
`resolution` if the target status is terminal, and relocates the ticket
file into the target status directory. It makes no commit (BLZ-254).

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
| `<field>` | One of: `title`, `type`, `assignee`, `priority`, `labels`, `components`, `estimate`, `parent`, `likelihood`, `impact`, `sprint`, `not_before`, `deadline`. |

**`start` and `due` are no longer editable** (ADR-0022, BLZ-386). They are the scheduler's derived outputs now; `not_before` and `deadline` are the constraints that drive them. Editing either is refused with a message naming its replacement — `start is derived by the scheduler; set 'not_before' to constrain it`. A `not_before` later than its own `deadline` is refused too: that pair cannot both hold, which is a different thing from a deadline the plan happens to miss.
| `<value>` | New value for the field. |

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

## import

```
blaze import [--apply] [--update] [--allocate-ids] [--mapping <m.json>] <file.csv>
blaze import --format markdown [--apply] [--update] <dir-or-glob>
blaze import repair [--apply] <receipt>
blaze import propose-mapping <file.csv>
```

Creates, updates or skips tickets from a canonical CSV, a mapped CSV or a tree of Markdown tickets
(design: [csv-import-and-export](../design/csv-import-and-export.md)). A dry run unless `--apply`
is given. `--apply` writes and makes no commit (BLZ-254). It writes the tickets (rows under
`BLAZE_WRITE_PORT=db`), their claims (fs/dual only; under db the ids are reserved in the database), and a receipt under `import-receipts/` (plus the
`source-ids/` map for a mapped import); on a file board you version those yourself. Exit 4 means
the board changed and the run did not finish cleanly.

## Removed commands

| Command | Removed in | Instead |
|---|---|---|
| `blaze commit` | 0.9.0 (BLZ-254) | Nothing to flush: no verb queues or commits any more. On a file board, commit the changed files yourself. |
| `blaze publish` | 0.9.0 (BLZ-254) | Nothing to sweep and no flush Job to trigger. For more than one writer, run the board in db mode (`BLAZE_WRITE_PORT=db`) and write to it over HTTP ([Remote mode](#remote-mode)). |

Both are refused by name, on stderr, with exit 1 (non-zero, so a script or a Job that still calls them fails loudly), whatever flags follow. The last release that has them is `@hjr15/blaze-board@0.8.0`.

## rollup

```
blaze rollup [<id>]
```

Read-only time roll-up. With an id, prints that node's own and rolled-up
estimate and worklog time plus a child breakdown. Without an id, prints a
summary across every goal and epic. Makes no writes.

## matrices

```
blaze matrices [--project <KEY>] [--check] [--out <dir>]
```

Regenerates the two **derived** traceability views per project — `<key>-requirements-matrix.md`
(each requirement, the delivery tickets that `Implements` it, the decisions that `Addresses` it)
and `<key>-architecture-matrix.md` (each decision and the requirement it answers) — from the
tickets, through the resolved store, so it works under `fs`, `dual` and `db`. It replaces
blaze-pm's `scripts/build_matrices.py` (BLZ-682) and writes the same bytes: the acceptance test
was a zero `diff -r` against that script's output for the live board.

| Flag | Meaning | Default |
|---|---|---|
| `--project <KEY>` | One project only. The key must be one `blaze.config.json` lists or the store holds; anything else (a typo, the wrong case) is refused with exit `1`, naming the known projects, and nothing is written or checked. | every project in `blaze.config.json` |
| `--check` | Write nothing; exit `1` naming each file that differs from the tickets. Allowed under `BLAZE_READONLY`. | off |
| `--out <dir>` | Where the files live. | `<data root>/docs/matrices` |

Exit `2` when there are no projects to render — a run that rendered nothing never reports
"in sync". Two rows that share a `ref` (or have none) are ordered by the ticket's path, which is
what the script produced when its `glob` happened to return paths sorted; on a filesystem that
returned them in another order the script's ties came out differently, so the first
`blaze matrices` run on such a board may reorder those rows once. Under `db` a ticket has no
file, so its link is the path the file would have today (`<KEY>/<status>/<id>-<slug>.md`).

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

## db

```
blaze db init [--force]
blaze db seed-counter
blaze db load [--replace]
blaze db verify
blaze db migrate [--identity-from <identity.db> | --no-identity-import] [--sprints-from <sprints.json> | --no-sprints-import]
blaze db status
```

The database behind `BLAZE_WRITE_PORT=dual|db`. `database.driver` in `blaze.config.json`
picks SQLite (the default — the shadow at `.blaze/blaze.db`) or Postgres
([ADR-0012](../decisions/0012-how-an-installation-selects-and-stores-its-database.md)).

| Subcommand | SQLite | Postgres |
|---|---|---|
| `init` | Creates the shadow, loads the board into it, and seeds the id counter. Refuses an existing shadow unless `--force`, which rebuilds both `.blaze/blaze.db` and `.blaze/config.db`. | Creates the schema and seeds the id counter — **the board's tickets are not loaded**; `blaze db load` does that. Refuses a database that already holds a Blaze schema, naming `blaze db seed-counter`. **`--force` is refused**: Blaze never drops a real database's tables from a CLI flag. |
| `load` | — (refused: `init` loads the shadow) | Loads this board's tickets — with their labels, components, worklog, parents and links, and the git history of their status moves as `transition` events — in **one transaction**, then raises the id counter from what it loaded, the files and the `.ids/` claims. **All or nothing**: a row the database refuses is named, every one of them, and nothing is loaded. Refuses a database that already holds tickets unless `--replace`, which empties the ticket tables (their event history included, never the id counter, the identity tables or the sprint tables) in the same transaction. **`--replace` is refused on an authoritative database** (one `blaze db migrate` has marked), naming `pg_restore`: that database is the board, with no file corpus to reload it from. `acceptance_criterion` stays empty — db mode reads criteria from the body. Rows it deliberately drops or collapses — a dangling parent or link, a repeated link, label or component, a worklog entry under half a minute — are counted, and the load says that `blaze db verify` will report each as a value difference. The git history is read before the transaction opens. |
| `seed-counter` | Raises each project's id counter to the highest number already taken — by a ticket file, an `.ids/` claim, or a database row — and prints `project  before → after`. Never lowers a counter; a second run prints `before → after` with the two equal. Refuses a database with no schema, naming `blaze db init`. | Same. |
| `verify` | — (refused, exit 2) | **The migration gate.** Compares the database with this board's files: every field value (unknown frontmatter keys included), the id sets, each table's row count against what the loader builds for these files, and every ticket's acceptance criteria (read by an independent matcher). Prints each difference; byte-order noise is shown but never gates. Exit `0` pass, `1` a difference, `2` could not run (no schema, no connection, a ticket file that will not parse). |
| `migrate` | — (refused: the shadow is derived — rebuild it with `blaze db init --force`) | Brings the schema forward to v6 in **one transaction** and marks the database **authoritative**. See below. |
| `status` | What the shadow holds, and what the dual-write soak has found. | — |

`verify` and `status` only read, so both run under `BLAZE_READONLY=1`; `init`, `seed-counter`,
`load` and `migrate` are refused. The exemption is decided by the subcommand itself — `blaze db load verify` is
still a load, and still refused.

**`blaze db migrate`** (Postgres only) brings a database forward to the engine's schema version —
v5 to v6 adds the identity tables and `sprint`/`sprint_registry` — and writes the `blaze_meta` row
`('authoritative', 'true')`, all in one transaction. It prints the transition and whether the mark
was written now or already present:

```
blaze db migrate — <host>/<database>
  schema         v5 → v6
  authoritative  yes (written now)
migrate: DONE — one transaction, committed.
```

A re-run is a no-op (`v6, already current`, `yes (already)`). A database newer than the engine,
one with tables but no stamp, an empty one (run `blaze db init`), or one stamped below 5 is
refused by name, before the stranded-file refusals below, and on any failure nothing is migrated. **Take a `pg_dump` first**: an
authoritative database is the board, so from then on `load --replace` refuses it and a too-old
stamp names `blaze db migrate`, never a rebuild — see
[schema versioning](../schema-versioning.md#authoritative-databases-migrate-derived-ones-rebuild).

**`--identity-from <path>`** copies all six identity tables (`app_user`, `user_identity`,
`membership`, `api_token`, `local_password`, `user_session`) from that `identity.db` **verbatim**
— token hashes, password verifiers and live sessions included — so no token is reissued and every
existing login keeps working. The copy runs inside the migrate transaction and is verified **row
for row** (paired by primary key, timestamps compared as instants) before the commit; any
difference rolls the whole migration back, naming the table, row key and column, never a value.
It refuses identity tables that already hold users. The source is opened read-only, and a table a
pre-password roster lacks is copied as empty and marked `(absent in source)`:

```
  identity       app_user 3 · user_identity 3 · membership 3 · api_token 3 · local_password 1 · user_session 2  (row-for-row verified)
```

`migrate` **refuses while `<board>/.blaze/identity.db` exists** unless `--identity-from` or
`--no-identity-import` says what to do with it: after the migrate the board reads its users from
Postgres only, so a roster left behind would lock every user out. `--no-identity-import` (the file
is not this board's roster) proceeds and copies nothing; the two flags together are refused.
On a **re-run after a successful copy** the file is still there; when the database already holds
users the refusal says the roster looks already imported, and `--no-identity-import` is the way on
(a second `--identity-from` is refused, because the tables are no longer empty).

**`--sprints-from <path>`** copies that `sprints.json` into `sprint` and `sprint_registry`, inside
the migrate transaction. The file is read once and parsed **strictly** before anything connects: a
file that is not JSON, a `sprints` that is not an array, a sprint with no id, a repeated id, a
non-string name, a `start`/`end` that is not a `YYYY-MM-DD` date, or a `registryVersion` that is not
an integer from 1 is refused by name (`sprints[i] (<id>) …`), and nothing is migrated. Every key
Blaze does not understand is kept, at both levels. The registry is then read back whole and must
equal the file, key for key and type for type, before the commit; a difference rolls the whole
migration back, naming the first differing sprint. It refuses sprint tables that already hold a
registry.

```
  sprints        2 sprint(s), active S2  (verified)
```

`migrate` **refuses while `<board>/sprints.json` exists** unless `--sprints-from` or
`--no-sprints-import` says what to do with it: at v6 the board reads sprints from Postgres only, so
a registry left behind would empty the gantt and refuse every `--sprint`. `--no-sprints-import`
proceeds and copies nothing; the two flags together are refused. As with the roster, a **re-run
after a successful copy** names the file as already imported (the database already holds a
registry) and points to `--no-sprints-import`. When both files are stranded, one run names both.

Each of `--identity-from` and `--sprints-from` may be given once. Both
`--identity-from <path>` and `--identity-from=<path>` (likewise `--sprints-from`) are accepted, and
the migrate flags are refused on every other `db` verb.

**Cutover to `BLAZE_WRITE_PORT=db` — do these in order:**

1. Stop the supervisor and every other writer (`blaze new`, `blaze import`, the groomer, any
   agent session) on **every** machine.
2. `git pull`, so this checkout holds every claim and ticket the other machines pushed.
3. `blaze db seed-counter`.
4. Set `BLAZE_WRITE_PORT=db` everywhere, then restart the long-lived processes (the
   supervisor and anything else that read the environment at start-up).

Why the order matters:

- Every id handed out on the filesystem path since `init` — by `blaze new`, `blaze import`, or
  another machine's claim — is invisible to the database's counter until it is re-seeded.
- `seed-counter` reads only **local** `.ids/` claims and ticket files. A claim another machine
  made but you have not pulled is invisible to it — hence step 2, after every writer stopped.
- A machine left in `fs` or `dual` mode after the flip still allocates from the file ledger,
  which the database's counter never sees, and the two can hand out the same number.
- db-mode allocation skips any number that already has a ticket row, so a stale counter can no
  longer overwrite a ticket — but it can leave gaps, and it cannot see a number that exists only
  as a file on a machine still writing in `fs` mode. `seed-counter` remains the cure.

**Expect the groomer to re-groom every ticket in its columns once after the flip.** Its
"already groomed" record (`.blaze/state.json`) hashes each ticket's text, and the database
serialises a ticket differently from the file it came from (it writes empty keys the file
omitted), so no hash matches. Each ticket costs one agent pass, then the records agree again.
The record is shared by both modes, so **flipping back to `BLAZE_WRITE_PORT=fs` costs the same
again**: the db-era hashes no longer match the files, and every ticket re-grooms once more.

---

## schedule

```
blaze schedule migrate-dates [--dry-run | --write]
blaze schedule import-deps   [--dry-run]
```

The two one-time steps that make the scheduling kernel live (ADR-0022; BLZ-360 §4 and §5.5).
**Dry-run is the default for both**, and `import-deps` has no `--write` at all.

`migrate-dates` reinterprets the dates already on the board, **split on terminality**, and the split
is the whole correctness argument:

| Cohort | What happens |
|---|---|
| terminal (`done`, `achieved`, …) | **frozen as actuals, kept byte-for-byte.** Re-deriving them would overwrite history with a forecast. |
| non-terminal | `due` → `deadline`, `start` → `not_before`; the derived fields are cleared and recomputed. |
| undated | untouched. |

It prints one line per affected ticket naming the cohort and both fields, for review before the
write. It is idempotent — a second `--write` is a no-op, not a clobber. The write should be **one
commit with the ids in its body**.

`import-deps` proposes `Precedes` edges from the existing advisory `Blocks` links. **It never
guesses**: a `Blocks` pair written from both ends carries no direction, so every mutual pair is
reported `undecidable` and you resolve it. A machine that picks a direction for one is right half
the time, and the wrong half is an invisible schedule error. Edges whose endpoints `Precedes` does
not declare are reported `refused` with the kind that refused them, never silently dropped.

`Blocks` and `Precedes` coexist indefinitely — `Blocks` stays the advisory human signal, `Precedes`
is the scheduler's input, and nothing lints them against each other. ADR-0001 is unchanged.

## user

```
blaze user add --email <address> [--role admin|member|viewer] [--name <display name>]
```

Creates a board user and issues its first API token. `--role` defaults to
`member`.

**Adding the first user turns authentication on for this board**, and is what a
non-loopback `blaze board` needs before it will start. There is no separate
bootstrap path: the first admin is created by exactly this command, through
exactly the code every later user takes (ADR-0013 §5).

**A server that is already running does not pick it up.** Both `blaze board` and
`blaze start` read the roster **once, at boot**, so a board that was serving before
this command keeps serving unauthenticated until it is restarted. Restart it — and
until you have, treat the board as still open.

The token is printed **once**. Only its SHA-256 hash is stored, so it cannot be
read back — if you lose it, issue another. Tokens carry a `blz_` prefix so they
are recognisable in a log and matchable by secret-scanning.

```
$ blaze user add --email you@example.com --role admin
user you@example.com created with role admin
identities: /path/to/board/.blaze/identity.db

API token (shown once — copy it now, it is not recoverable):

    blz_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

scopes: read, write, admin
Use it as:  Authorization: Bearer <token>

NOTE: a server that is ALREADY RUNNING does not pick this up — it read the
      roster at boot. Restart `blaze board` / `blaze start` to apply it.
```

Identities live in `<board>/.blaze/identity.db`, mode `0600` inside a `0700`
directory — local to the deployment, never committed with the tickets. `blaze user
add` **adds `.blaze/` to the board's `.gitignore` if no rule already covers it**, and
says so; if the board is not a git work tree it warns instead. A token's scopes can
never exceed its owner's role, at issue time or at use time.

**On a Postgres board, users live in the database** (BLZ-706). When all three hold —
`BLAZE_WRITE_PORT=db`, `database.driver` is `postgres`, and the database is at schema
**v6** or later — `blaze user add` and `blaze user passwd` write the identity tables in
Postgres, and **nothing is written under the board directory**: no `.blaze/`, no
`identity.db`, no `.gitignore` line (BLZ-701). The output names the database, never its
password:

```
identities: Postgres db.example.internal/blaze
```

A v5 database has no identity tables, so its board keeps `identity.db` exactly as above
until `blaze db migrate --identity-from` copies the roster across (see [`db`](#db)).

**db mode on a Postgres board needs the database reachable, even at v5.** The board servers,
`blaze user add|passwd` and `blaze sprint` connect when they start, to read the schema stamp that
decides whether identity and sprints come from Postgres or from the files. A database that is down
or has no schema is a refusal (exit 1), not a fallback to the files. For a deployed server this
means a restart during a database outage exits and crash-loops until the database is back, where an
engine before 0.10.0 started and answered `503` per request. `BLAZE_WRITE_PORT=db blaze user add`
against a database with no schema is refused, where an engine before 0.10.0 wrote `identity.db`.

**An empty Postgres roster beside a populated `identity.db` refuses to serve.** At v6, when the
identity tables hold no users but `<board>/.blaze/identity.db` holds some (a database made by
`blaze db init`, or migrated with `--no-identity-import`), both servers refuse to start and name
`blaze db migrate --identity-from <path>`. Serving it as "no users" would leave the board
unauthenticated on loopback while the roster the operator relies on is never read. Move the file
aside if it is not this board's roster.

## Help

`blaze --help` (or `-h`) prints a usage line plus the full command list with
one-line descriptions; `blaze <command> --help` prints that command's one-line
usage. `--help`/`-h` is intercepted at dispatch **before** any runner executes,
so asking for help can never trigger a mutation — `blaze move --help` describes
`move`, it does not move anything. An unknown command prints the same usage list and
exits non-zero. For anything past the one-liners — flags, defaults, behaviour —
this page is the reference.

## Remote mode

With **both** `BLAZE_REMOTE_URL` and `BLAZE_TOKEN` (or `BLAZE_TOKEN_FILE`) set, `blaze` writes
to a board server over HTTP instead of to a local tree (BLZ-684). Running a deployed board —
config, admin verbs, one token per machine, backups — is in
[Running a live board](../operations/live-board.md). This is how a second machine writes to the live
board once it is on Postgres (spec §5.4): the verb runs once, on the server, against the store
the server owns, and under `BLAZE_WRITE_PORT=db` the id comes from the database's counter, so
two machines creating at once never collide.

| Command | Endpoint |
|---|---|
| `blaze new …` | `POST /api/new` (**needs a db-mode board** — see below) |
| `blaze move <id> <status>` | `POST /api/move` |
| `blaze edit <id> <field> <value>` | `POST /api/edit` |
| `blaze resolve <id> <resolution>` | `POST /api/resolve` |
| `blaze log <id> <minutes> [--date] [--note]` | `POST /api/log` |
| `blaze link [--rm] <id> <TYPE> <target>` | `POST /api/link` |
| `blaze show <id> [--json]` | `GET /api/ticket?id=<id>` |
| `blaze list [--project K] [--status S] [--type T] [--json]` | `GET /api/tickets` |
| `blaze list --projects [--json]` | `GET /api/projects` |

`POST /api/new` is answered only when the server runs the database write port
(`BLAZE_WRITE_PORT=db`). On a file board it is refused `409` and `blaze new` prints that message:
a file board allocates ids from git, which is single-machine, and the fetch would stall the
server for every session. The other five verbs work on any board.

The arguments are the local command's own. Each prints one line ending `(remote: <origin>)`,
or the server's refusal and exit `1`. Every **other** command — `audit`, `reconcile`, `db`,
`import`, `sprint`, `board`, and the read verbs (`rollup`, `export`, `audit` …) — is refused with
`blaze: <cmd> is not available in remote mode`: it needs the board's data on this machine.
Read the board with `blaze show <id>` and `blaze list` (remote mode), or the page.

**Reading the live board (BLZ-709).** `blaze show` and `blaze list` exist only in remote mode;
run locally, they are refused (`… runs in remote mode only`) — read `projects/` or run
`blaze board` instead. Any token that carries `read` will do, a `viewer`'s included.

- `blaze show <id>` prints `<id>  <status>  <type>  <title>`, then each other frontmatter field
  as `  <key>: <value>` (lists joined with `, `, empty fields skipped), a blank line, and the
  body. An unknown id is the server's `404`, exit `1`.
- `blaze list` prints one `<id>  <status>  <type>  <title>` line per ticket, sorted by project
  and then id number. `--project`, `--status` and `--type` filter by exact match, and combine.
- `blaze list --projects` prints one `<KEY>  labels: …  components: …` line per project: the
  taxonomy a valid `blaze new` needs. It takes no filters.
- `--json` prints the answer's payload instead (the ticket, the ticket array, or the project
  array), and nothing else, so it pipes straight to `jq`. The count line
  (`2 ticket(s) (remote: <origin>)`) goes to **stderr** in every form.

Over HTTP, each route needs the `read` scope: `GET /api/ticket?id=` answers
`{ ok, ticket: { id, project, status, frontmatter, body } }` (`400` without an id, `404` for an
unknown one, `409` when a file board holds two records with that id);
`GET /api/tickets?project=&status=&type=` answers `{ ok, tickets }`, each without its body; and
`GET /api/projects` answers `{ ok, projects: [{ key, labels, components, requireLabels,
requireComponents, requireWorklogBeforeTerminal }] }`. No answer carries a server filesystem
path: a ticket's file and a project's `codeRepos` stay on the server. A remote mode set **half-way** (only
one of the two variables) is an error for every command, never a silent fallback to writing
locally. `BLAZE_READONLY` still refuses a write first.

**The token from a file (BLZ-710).** `BLAZE_TOKEN_FILE=/path/to/token` names a file (mode
`0600`) holding the token; its content, trimmed, is used when `BLAZE_TOKEN` is unset or blank.
`BLAZE_TOKEN` wins when both are set, and the URL plus the file alone is a complete remote mode.
For the half-set rule either one counts as the credential: the file with no URL is refused
(`remote mode needs both BLAZE_REMOTE_URL and BLAZE_TOKEN (or BLAZE_TOKEN_FILE)`). The file is
read as a regular file only — a FIFO or a directory is refused, never waited on — and a file
that cannot be read, is empty, or holds whitespace inside the token is refused with one line
naming the variable and the path (`blaze: BLAZE_TOKEN_FILE (<path>) could not be read (ENOENT)`,
`… is empty`, `… contains whitespace`), never its content.

**A server behind a private CA.** When the certificate is not trusted on this machine
(`SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `DEPTH_ZERO_SELF_SIGNED_CERT` or
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`), the failure line names the code and the fix:
`blaze <verb>: <origin>'s TLS certificate is not trusted on this machine (<code>). Point
NODE_EXTRA_CA_CERTS at the CA certificate that signed it — e.g.
NODE_EXTRA_CA_CERTS=/path/to/ca.crt — and run again.` Every other network failure keeps
`blaze <verb>: no answer from <origin> — <cause>`.

**Scope the two variables to the command, never to your whole shell.** Exported, they turn every
`blaze` write anywhere on the machine into a write to that server — an agent working on a
local board, a script, anything. Prefer
`BLAZE_REMOTE_URL=https://blaze.example.com BLAZE_TOKEN_FILE=/path/to/token blaze new …`,
or a dedicated shell (or a `direnv` directory) that exists only to write to the server. The
engine's own test suite deletes all three (`BLAZE_TOKEN_FILE` included) before any test runs
(`tests/setup/no-remote.mjs`), so an exported pair can never turn `npm test` into writes to a
real board.

The token is sent to `BLAZE_REMOTE_URL`'s origin and nowhere else: every request is built
against that origin, a redirect is refused rather than followed (`blaze <verb>: refused a
redirect from <origin>`), plain `http://` is accepted only for a loopback host spelled
`127.x.x.x`, `[::1]` or `localhost` (other spellings, such as `[::ffff:127.0.0.1]` or
`localhost.`, are refused), and no message prints the token. **Proxies:** with
`NODE_USE_ENV_PROXY=1`, Node's `fetch` honours `HTTP_PROXY`/`HTTPS_PROXY`, and a loopback
`http://` URL is sent through the proxy — token in clear — unless `NO_PROXY` covers it. Leave
`NODE_USE_ENV_PROXY` unset for remote mode, or set `NO_PROXY=127.0.0.1,::1,localhost`. To reach a board on another machine
that has no TLS — the cutover rehearsal's `blaze board` on machine 1, say — tunnel it rather
than send the token over the LAN in clear: `ssh -L 4321:127.0.0.1:<port> machine1`, then
`BLAZE_REMOTE_URL=http://127.0.0.1:4321`. (Machine 1's board must have users; it can stay on
loopback, since the tunnel arrives there.) Use a `member` token (`blaze user
add --role member`): a `viewer` token is refused `403` on every write. The server skips the
CSRF header for such a bearer request (ADR-0013's addendum), so remote mode needs a board with
users — a loopback board with none still requires the header, and remote mode cannot supply it.

**The two-machine proof** (the cutover rehearsal, BLZ-254 spec §7 step 3) is
`scripts/ops/concurrency-proof.mjs`, run in remote mode. On each machine,
`node scripts/ops/concurrency-proof.mjs create --project <KEY> --count 50 --label <machine> > <machine>.json`
creates the tickets (`--parallel 8` in flight by default) and prints their ids as JSON; then
`node scripts/ops/concurrency-proof.mjs verify m1.json m2.json` checks every id is distinct
across all the files and present on the server, and prints `PROOF: PASS` (exit `0`) or the
duplicated and missing ids (exit `1`). The tickets are real: run it against the rehearsal
database. The same shape runs in CI against Postgres (`tests/concurrency-proof.test.mjs`: two
processes × 50 → 100 distinct ids, 100 rows, no gaps).

## Environment variables

| Variable | Controls | Default |
|---|---|---|
| `BLAZE_PROJECTS_DIR` | Explicit path to the data repo's `projects/` directory. Lets the engine run from anywhere. | none — falls back to a `projects/` dir under the current working directory |
| `BLAZE_KEY` | Ticket id prefix override. Same shape rule as `key` in `blaze.config.json` (BLZ-402): upper-case letters and digits, starting with a letter (e.g. `ENG`, `OBA`, `BLZ2`) — refused, not silently accepted, otherwise, and never auto-corrected ([ADR-0025](../decisions/0025-a-project-key-is-refused-never-normalised.md)). Setting it to the **empty string** is a caller error and is refused (BLZ-410) — it used to be discarded, so `blaze.config.json`'s key silently won with no message on any stream. Only an *unset* `BLAZE_KEY` means "no override". The refusal is **defensive** (BLZ-461): `blaze move` reads no value from the config (its one use, `commitMode`, was removed by BLZ-254) and `blaze new`'s prefix comes from `--project`, so neither changes behaviour on `BLAZE_KEY` at all, and `key`'s derived matchers have exactly one consumer — the groomer's legacy flat-layout branch, which is reached by any board that has a status directory at the repo root, including a hybrid board that also has a `projects/` tree (BLZ-483: `statusDirs` is additive, not a choice). It buys that an empty override cannot silently become the file key for a consumer added later. | the `key` in `blaze.config.json` |
| `BLAZE_PORT` | Board port. | 4321, unless overridden (see below) |
| `PORT` | Board port; takes precedence over `BLAZE_PORT` and config. | — |
| `HOST` | Bind host for `blaze board`. `blaze start` / bare `blaze` always binds `127.0.0.1`. **A non-loopback value on a board with no users refuses to start** — see [`board`](#board) and [`user`](#user). | `127.0.0.1` |
| `BLAZE_AGENT_COMMAND` | The command `groom` spawns to act on a ticket. | `agentCommand` in `blaze.config.json` |
| `BLAZE_CODE_REPO` | Code repo `reconcile` mirrors against, when not set per-project. | none |
| `BLAZE_READONLY` | Read-only guard: any value except unset/empty/`0`/`false` makes `blaze` refuse to run a mutating command (non-mutating `board` and `rollup` still work). An env guard for inspection-only runs, not a sandbox — code that writes files directly bypasses it. | unset (writes allowed) |
| `BLAZE_WRITE_PORT` | Where a write goes: `fs`, `dual` or `db`. **Unset is not the same as `fs`** (BLZ-708): on a board whose `blaze.config.json` names `database.driver: "postgres"`, an unset value makes every file write refuse, naming this variable; an explicit `fs` states that a file write is deliberate. An empty or whitespace value counts as unset. Remote mode, `blaze db *` and `blaze init` are never refused. On any other board, unset behaves as `fs`. See [A Postgres board refuses file writes](../../AGENTS.md#a-postgres-board-refuses-file-writes). | unset |
| `BLAZE_DB_DIR` | Directory for the derived `.blaze/` caches. | `.blaze/` under the data repo |
| `BLAZE_REMOTE_URL` | The board server's origin, e.g. `https://blaze.example.com` — turns on [remote mode](#remote-mode) together with `BLAZE_TOKEN`. `https://` only (plain `http://` for `127.x.x.x`, `[::1]` or `localhost`); no path, query, fragment or `user:pass@`. | unset (local) |
| `BLAZE_TOKEN` | The API token remote mode sends as `Authorization: Bearer`, to `BLAZE_REMOTE_URL`'s origin and nowhere else. Setting only one of the URL and the credential (this or `BLAZE_TOKEN_FILE`) is an error for every command. | unset |
| `BLAZE_TOKEN_FILE` | A file (mode `0600`) holding remote mode's token, used when `BLAZE_TOKEN` is unset or blank (BLZ-710). Read as a regular file only; an unreadable, empty or whitespace-bearing file is refused naming the path, never the content. See [remote mode](#remote-mode). | unset |
| `NODE_EXTRA_CA_CERTS` | Node's own: a PEM file of extra CA certificates to trust. Set it to the CA that signed a remote board's certificate when that CA is private; remote mode's TLS-trust failure names it. | unset |

Port resolution order: `PORT` env, then `BLAZE_PORT` env, then `port` in
`blaze.config.json`, then 4321.

## commitMode (ignored)

`commitMode` and `BLAZE_COMMIT_MODE` are ignored since 0.9.0 (a one-time warning); the board never commits. `BLAZE_COMMIT_MODE_WARNED` is set after the first warning, and everything the process spawns inherits it, including the server's agents, so those children do not repeat the warning.

## Types, workflows, priorities, resolutions

The type registry (goal/requirement/architecture/feature/risk/story/task/bug/subtask), their
workflows, and how to customise them live in [`schema.md`](schema.md) —
not repeated here. Two enums you pass as literal command arguments above:

- `link` `<TYPE>`: `Blocks`, `Relates`, `Duplicate`, `Cloners`.
- `resolve` `<resolution>`: `done`, `wont-do`, `duplicate`, `cannot-reproduce`.

---

Next: [Schema and customisation](schema.md) ·
[Driving Blaze with an AI agent](driving-with-an-ai-agent.md) ·
[Guide index](README.md)
