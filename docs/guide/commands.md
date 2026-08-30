# Command reference

Every `blaze` invocation is `blaze <subcommand> [args] [flags]`. There are 16
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
| [`sprint`](#sprint) | Sprint registry | yes (`new`); no (`list`/`active`) |
| [`reindex`](#reindex) | Rebuild derived caches | no (cache-only) |
| [`move`](#move) | Change a ticket's status | yes |
| [`edit`](#edit) | Edit one field on a ticket | yes |
| [`link`](#link) | Add/remove a typed link between tickets | yes |
| [`resolve`](#resolve) | Set/override resolution without moving the file | yes |
| [`log`](#log) | Append a worklog entry | yes |
| [`commit`](#commit) | Flush queued ops into one commit (batch mode) | yes |
| [`rollup`](#rollup) | Print rolled-up time for a node or every goal/epic | no |
| [`migrate`](#migrate) | Import tickets from an external tracker | with `--live` |
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
edit, resolve, log, acceptance-criteria toggle). Parses no CLI args.

**Access depends on whether the board has any users** (ADR-0013). See
[HTTP surface](../architecture.md#http-surface) for which route needs which scope.

- **No users configured, bound to loopback** — served without authentication,
  exactly as Blaze always has. The bind address *is* the boundary, and that is
  unchanged for every single-operator board.
- **No users configured, bound to anything else** (`HOST=0.0.0.0`, a LAN address,
  a container) — `blaze board` **refuses to start** and tells you both fixes. It
  is checked before the socket is opened, so nothing is served. This is the
  behaviour *until a first-run setup flow exists*, not a permanent design choice.
- **One or more users** — every `/api/*` call needs
  `Authorization: Bearer blz_…`, **and so does board content** (`GET /`,
  `GET /view/<name>`): the page is rendered server-side and carries every ticket.
  The token's scopes are re-intersected with its owner's *current* role on every
  request, so demoting a user immediately narrows every token they hold.

- **`.blaze/identity.db` exists but is unreadable** (truncated, corrupt, or not a
  database) — `blaze board` **refuses to start** and names the file. This is never
  read as "no users": on disk a stray file and a truncated roster look identical, and
  treating the second as the first would silently remove authentication from a board
  that had it.

  A browser cannot set that header itself, so once a board has users its content is
  reachable from the API, from `curl`, or behind a reverse proxy that adds the
  header — not from a bare browser tab. The board was already unusable in a browser
  at that point (the page rendered while every XHR returned `401`); gating `/` makes
  that honest rather than leaky. A sign-in flow is tracked separately.

An unclassified `/api/*` route returns `404`; a route added without a scope fails
closed rather than inheriting the last one's.

The `x-blaze-csrf` header is **not** authentication — on either server. It is a
per-process value embedded in the served page, readable by anyone who can `GET /`. It is
forgery protection for the browser flow, retained as defence-in-depth alongside the token
check, never as a substitute for it. `blaze start` also requires it on `/control/*`,
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
| `--apply` | Commit the mirrored changes locally (or queue them, in batch mode — see [Commit modes](../../AGENTS.md#commit-modes)), through the same advisory-lock-serialised path every other mutating verb uses. Reconcile never pushes — push is hardcoded off. | off (dry-run) |
| `--fetch` | Fetch the linked code repo before comparing. | off |
| `--project KEY` | Restrict BOTH the scan and the write to the named project(s) — a session that owns three tickets should not author a commit moving fifteen it never touched (BLZ-394). Repeatable, comma-separated, and `--project=KEY`; all three spellings, because a filter that silently ignores the one you typed is worse than no filter. An **unknown** key refuses the whole run rather than scanning the subset it understood, and `--project=` with an empty value is a caller error, not an unfiltered run — `--project=$PROJ` with `$PROJ` unset used to reconcile and commit the whole board silently. A filtered run always prints `reconcile: scanned project(s): …`, even under `--quiet`. | all configured projects |
| `--ticket ID` | Finer than `--project`: restrict the run to the named ticket(s) (BLZ-451). Same three spellings — repeatable, comma-separated, and `--ticket=ID` — deliberately, since a second flag accepting a different subset would be worse again. A ticket id is `<KEY>-<number>`; the key half is a project key and is **refused, never normalised** ([ADR-0025](../decisions/0025-a-project-key-is-refused-never-normalised.md)), so `inf-1` names a project this board does not configure rather than being read as `INF-1`. Four refusals, each naming what is wrong: the flag given no id, a value that is not a ticket id, an id outside this run's projects, and an id no ticket on this board carries. A ticket-scoped `--apply` says so in the commit message (`… [--ticket BLZ-451]`), because that message is what a person reads months later asking why the pass moved three tickets and not thirty. | all tickets in scope |
| `--quiet` | *Print only on change.* It gates whole-run lines only — never per-ticket output. Suppressed on a pass that decided nothing: `reconcile: no code-bound change found — nothing to do.`, `reconcile: no projects configured — nothing to reconcile.`, and `reconcile: scanned project(s): …` (that last one is printed anyway whenever `--project` was given, because a filtered run must never read as a whole-board one). Per-ticket `moved` / `would move` lines, the dry-run tail, and every `WARNING` / `FORGE UNREADABLE` / `FORGE DATA` / `NEEDS ATTENTION` line on stderr are printed under `--quiet` exactly as without it. | off |

PR state is read with the GitHub CLI (`gh`), which supports GitHub.com and GitHub
Enterprise Server only. On any other remote, `in-review` is unreachable and
reconcile prints a `FORGE UNREADABLE` line to stderr on every run (including under
`--quiet`) rather than reporting a clean board; it still exits 0, because the
branch and merged-commit signals are unaffected. See
[Forge support and status reachability](how-it-works.md#forge-support-and-status-reachability).

Reconcile does **not** auto-recover an uncommitted prior pass, and it does
**not** detect one either. If a previous `--apply` moved ticket files but
failed to commit them (a held lock, a failing pre-commit hook), the board's
ticket tree stays dirty until a person notices and clears it — the next run
reports only what *it* found (no code-bound change, most likely, since the
prior pass already wrote the files), never a claim about the state of the git
tree. Telling a genuinely failed prior commit apart from a `commitMode:
"batch"` board that queued by design, or from a human's own uncommitted edit
under `projects/`, needs the pending ledger, not `git status`. That ledger read
is now built: [`blaze commit --status`](#commit) reports the queued-by-design
state. It cannot report the other two — neither leaves a ledger entry — and it
says so in its own output (ADR-0032). If a run reports nothing to do but `git status`
still shows changes under `projects/`, the remedy depends on which of those three
states you are in, and **`blaze commit` only addresses one of them** (BLZ-434) —
run [`blaze commit --status`](#commit) to see which of your queues, if any, still
holds outstanding work. It
flushes the pending queue, so it helps only on a `commitMode: "batch"` board that
queued by design — on a `per-op` board there is no queue and it has nothing to
flush, and it will not pick up a failed prior commit or your own in-flight edit
either, because it stages only the files recorded against queued ops (never
`git add -A`). Check `commitMode` first: on `batch`, run `blaze commit`; otherwise,
or for anything it leaves behind, commit the tree by hand.

**A change line only ever claims a move it can prove (BLZ-401).** A ticket can be
written without its status changing — a blank `resolution` backfilled on an already-
`done` ticket, a delivery record filled in for the first time, or cleared because no
single PR delivered it (ADR-0023 §1) — and that entry stays on the report (dropping it
would erase the only account of a record deletion) but is rendered as `updated <id>
(still <status>): …`, never as a move. The `--apply` commit message and the dry-run tail
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
blaze audit [--projects A,B] [--kind <kind>] [--json] [projectsDir]
```

Read-only corpus hygiene over the whole board. Findings split two ways, and the
split is the point (ADR-0011): a **hard** finding means the corpus is *wrong* and
fails the run; a **soft** finding is a *fill queue* and never fails one. A gate
that fails on the fill queue is a gate people learn to skip, which costs the hard
findings too.

| Severity | Kinds |
|---|---|
| hard | `duplicate-status`, `off-taxonomy-component`, `off-taxonomy-label`, `bad-link-key`, `unknown-link-type`, `dangling-target`, `dangling-parent`, `invalid-parent-type`, `parse-error`, `config-unloadable`, `schema-malformed`, `project-mismatch` |
| soft | `empty-components`, `empty-labels`, `missing-parent`, `terminal-goal-unverified-requirement`, `schema-invalid`, `deadline-unreachable`, `dependency-cycle`, `schedule-stale`, `schedule-empty` |

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
| `--json` | Emit the full report as JSON. |
| `projectsDir` | Audit a `projects/` tree outside the current board. |

Exit code is `0` when clean or soft-only, `1` on any hard finding, and `2` when
the corpus is empty — a run that measured nothing is never reported as a pass.

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

## commit

```
blaze commit [--all] [--shared] [--branch-ok] [--status]
```

Flushes queued ops into one git commit. Only meaningful when
`commitMode: batch` — see [Commit modes](#commit-modes). Stages only the
files recorded against the flushed ops, never `git add -A`. By default it drains
**only the caller's own queue** — keyed by `BLAZE_SESSION`, or an id auto-derived
from the agent harness session when that's unset. If there is no session identity
at all and you pass neither flag, `commit` refuses to drain the shared fallback
queue rather than risk taking another session's work.

The queue store is **one per repository** — `.blaze/` beside the shared `.git`, so
every worktree of the board reads and writes the same queues (BLZ-556, ADR-0033).
Seeing another worktree's ops is not permission to commit them: their files exist
only in the checkout that queued them, so `commit` drains just its own working
tree's ops, leaves the rest untouched, names where they belong, and **exits 3**.
Exit 3 means "flushed what this working tree could reach; ops remain that it
cannot" — 1 is a refusal (nothing happened), 2 is `--status` reporting
incompletely. Ops left in a pre-BLZ-556 per-working-copy store are reported the
same way; migrate them with
[queue-store-migration](../operations/queue-store-migration.md).

| Flag | Meaning | Default |
|---|---|---|
| `--all` | Sweep every session's queue plus the legacy shared fallback (the bundler / end-of-run path). | off (drains only the caller's own queue) |
| `--shared` | Drain **only** the shared fallback queue (the no-session-identity queue), never the caller's own. | off |
| `--branch-ok` | Override the INF-673 refusal to flush onto a branch the ops were not queued on. | off |
| `--status` | **Report every queue and flush nothing.** Read-only: names the resolved queue store on its first line, then prints each queue's op count, its age in days, whether it is `(yours)`, and how many of its recorded files still differ from `HEAD` (*outstanding*) versus already match it (*orphaned* — filed by something else, so the entry is a leftover). A queue it could not read is named as such and excluded from the totals, and the run then exits **2**. Runs under `BLAZE_READONLY=1`. | off |

### `--status`, and the one question the ledger can answer

A queue is abandoned the moment its session ends: `blaze commit` drains only the
caller's own queue, and a new agent session gets a new auto-derived id, so the
previous queue becomes invisible to it. Measured on this project's own board at
`70197405`, **185 ops were stranded across 8 sessions for up to five days** while
every file they named had already been filed by hand-written commits. `--status`
is the surface that makes that visible on the day it happens; `blaze commit --all`
is the remedy.

It answers exactly **one** of the three states described under
[reconcile](#reconcile) above — a write blaze queued by design. It cannot see a
failed prior commit or your own in-flight edit, because neither leaves a ledger
entry, and it says so in its own output rather than letting a clean report be read
as a clean tree. See `docs/decisions/0032-a-queued-write-is-a-fact-blaze-recorded-not-a-shape-git-reports.md`.

**A queue that could not be read is reported, not fatal** (BLZ-518). A ledger entry
with no `files` list, a queue path that is a directory, and a recorded path outside
the board each used to throw and abort the *whole* report — on the live board, eight
healthy queues' worth of state lost to one bad line, in exactly the situation where
an old malformed entry is most likely. Each is now contained to its own queue, which
is printed as `could not be read: <reason>` with `state UNKNOWN`, carries no
outstanding/orphaned buckets, and is excluded from the totals with an explicit
disclaimer. A path outside the board is still **refused**, never reported on — only
the blast radius of the refusal changed. Exit codes: **0** every queue was read,
**2** the report is incomplete, **1** the verb refused to run at all (unknown flag,
`BLAZE_READONLY`, no session identity, lock held, foreign branch).

**A queue that is fully drained is deleted, not emptied** (BLZ-498). Before this,
`blaze commit` truncated a drained queue to a zero-byte file and left it, so
`.blaze/pending/` grew by one entry for every session that had ever run and never
shrank — 28 queues in one checkout of this project's own board, 14 in another. A
queue with nothing left in it is not evidence of anything, and keeping it inflates
every count taken over the queue list. A queue only *partially* drained (an op
arrived from another session mid-commit) keeps both its file and those bytes.

### The subject line counts TICKETS, and used to count ops

`blaze commit` writes one commit whose subject reads
`blaze: <date> board update (2 new, 3 logged, 1 moved)` — one clause per op kind, in
first-seen order.

**Each number is a count of distinct tickets, not of operations** — so "3 logged"
means three *tickets* had time logged against them, and two `blaze edit` calls
against one ticket render as `1 edited`, not `2 edited`. The full per-op detail is
still in the commit body, which lists every queued entry's message.

**This is a change of meaning, and the words did not change with it** (BLZ-448).
Before BLZ-427 the same clauses counted queued ops. For every per-ticket verb
(`new`, `move`, `log`, `resolve`, `edit`, `link`, `ac`, `sprint`) one op is one
ticket and the two readings coincide, so those subjects mean what they always did.
`reconcile` is what broke the identity: one queued reconcile op covers every ticket
that pass wrote, and under the old rule a pass that moved a dozen tickets rendered
as `1 reconcile`. Counting tickets is the safe direction — it can only understate
op volume, never overstate ticket impact — but a reader who learned the old
vocabulary should know the unit moved under it. Commits written before BLZ-427 are
in the old units and are not restated.

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

## Help

`blaze --help` (or `-h`) prints a usage line plus the full command list with
one-line descriptions; `blaze <command> --help` prints that command's one-line
usage. `--help`/`-h` is intercepted at dispatch **before** any runner executes,
so asking for help can never trigger a mutation — `blaze commit --help` describes
`commit`, it does not flush. An unknown command prints the same usage list and
exits non-zero. For anything past the one-liners — flags, defaults, behaviour —
this page is the reference.

## Environment variables

| Variable | Controls | Default |
|---|---|---|
| `BLAZE_PROJECTS_DIR` | Explicit path to the data repo's `projects/` directory. Lets the engine run from anywhere. | none — falls back to a `projects/` dir under the current working directory |
| `BLAZE_KEY` | Ticket id prefix override. Same shape rule as `key` in `blaze.config.json` (BLZ-402): upper-case letters and digits, starting with a letter (e.g. `ENG`, `OBA`, `BLZ2`) — refused, not silently accepted, otherwise, and never auto-corrected ([ADR-0025](../decisions/0025-a-project-key-is-refused-never-normalised.md)). Setting it to the **empty string** is a caller error and is refused (BLZ-410) — it used to be discarded, so `blaze.config.json`'s key silently won with no message on any stream. Only an *unset* `BLAZE_KEY` means "no override". The refusal is **defensive** (BLZ-461): `blaze move` reads only `commitMode` from the config and `blaze new`'s prefix comes from `--project`, so neither changes behaviour on `BLAZE_KEY` at all, and `key`'s derived matchers have exactly one consumer — the groomer's legacy flat-layout branch, which is reached by any board that has a status directory at the repo root, including a hybrid board that also has a `projects/` tree (BLZ-483: `statusDirs` is additive, not a choice). It buys that an empty override cannot silently become the file key for a consumer added later. | the `key` in `blaze.config.json` |
| `BLAZE_PORT` | Board port. | 4321, unless overridden (see below) |
| `PORT` | Board port; takes precedence over `BLAZE_PORT` and config. | — |
| `HOST` | Bind host for `blaze board`. `blaze start` / bare `blaze` always binds `127.0.0.1`. **A non-loopback value on a board with no users refuses to start** — see [`board`](#board) and [`user`](#user). | `127.0.0.1` |
| `BLAZE_AGENT_COMMAND` | The command `groom` spawns to act on a ticket. | `agentCommand` in `blaze.config.json` |
| `BLAZE_COMMIT_MODE` | `per-op` or `batch`. | `per-op` |
| `BLAZE_CODE_REPO` | Code repo `reconcile` mirrors against, when not set per-project. | none |
| `BLAZE_SESSION` | Key for the batch-mode op queue, so parallel sessions isolate. | unset → an id auto-derived from the agent harness session (`auto-<id>`), so a session and its subagents share one queue; only with no harness id either does it fall back to the shared queue |
| `BLAZE_READONLY` | Read-only guard: any value except unset/empty/`0`/`false` makes `blaze` refuse to run a mutating command (non-mutating `board` and `rollup` still work). An env guard for inspection-only runs, not a sandbox — code that writes files directly bypasses it. | unset (writes allowed) |
| `BLAZE_DB_DIR` | Directory for the derived `.blaze/` caches. | `.blaze/` under the data repo |

Port resolution order: `PORT` env, then `BLAZE_PORT` env, then `port` in
`blaze.config.json`, then 4321.

## Commit modes

Default `commitMode` is `per-op`: every mutating verb commits immediately,
scoped to the files it touched. Set `commitMode: batch` in
`blaze.config.json` (or `BLAZE_COMMIT_MODE=batch`) to instead queue each op
into a per-session ledger and flush it later with `blaze commit`.
`BLAZE_SESSION` keys that ledger, so parallel sessions queue independently
without stepping on each other; when it's unset the id is auto-derived from the
agent harness session, so a session and the subagents it spawns share one queue.
See [Driving Blaze with an AI agent](driving-with-an-ai-agent.md) for when to
choose which mode.

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
