# Driving Blaze with an agent

Blaze is a file-based issue tracker. **A ticket's status is the directory it sits
in** — `projects/<KEY>/<status>/<KEY>-<n>-slug.md` — there is no `status:` field, so
it cannot drift. Any coding agent can drive it with ordinary file tools (`ls`,
`grep`, `git mv`), or with the `blaze` CLI, which is the recommended path since it
validates every write against the schema below and commits scoped to the files it
touched.

## Types & workflow

Every ticket has a `type`. Each type follows one of three workflows — its own
sequence of statuses:

| Type | Parent | Required fields | Workflow | Statuses (initial → terminal) |
|---|---|---|---|---|
| `goal` | — | title, description | `goal` | `defined → in-progress → achieved` |
| `epic` | goal | title, description | `delivery` | `defined → in-progress → in-review → done` |
| `story` / `task` / `bug` | epic | title, description, **estimate** | `delivery` | `defined → in-progress → in-review → done` |
| `subtask` | story/task/bug | title, description | `delivery` | `defined → in-progress → in-review → done` |
| `risk` | goal or epic | title, description, likelihood, impact | `risk` | `identified → mitigated` / `accepted` / `obsolete` |

A terminal move auto-sets `resolution` (`done` for `achieved`/`done`/`mitigated`/
`accepted`; `wont-do` for `obsolete`). Use `blaze resolve <id> <resolution>` for a
non-default resolution (`wont-do`, `duplicate`, `cannot-reproduce`) without moving
the file. These are the engine's **defaults**, defined once in `scripts/model/schema.mjs`
(`DEFAULT_TYPES`) and `scripts/model/workflows.mjs` (`DEFAULT_WORKFLOWS`). A data
repo can override or extend them — add or modify types and workflows — via a
`schema` block in `blaze.config.json` (all projects); the engine applies this
**top-level** override at load, so `blaze new`/`move`, validation, and the board
all read it. A `projects/<KEY>/project.json` `schema` block is layered by the
`resolveSchema` helper, available to any future feature that calls it — as of
today nothing in the engine does, including the built-in commands. With no
override the table above applies unchanged. See [`docs/schema-customization.md`](docs/schema-customization.md).
`validateSchema` (also in `scripts/model/schema-config.mjs`) is a pure structural
check — every type's `workflow` must name a declared workflow — returning a list
of human-readable errors (`[]` when valid); nothing in the engine calls it
automatically yet.

## The loop

1. **Create**: `blaze new --project <KEY> --type <type> "<title>" [--estimate m]
   [--parent ID] [--labels a,b] [--components a,b] [--reason "<why blank>"]`. It
   lands in the type's initial status (`defined` or `identified`). See
   "Labels/components taxonomy" below for what `--labels`/`--components` and
   `--reason` do.
2. **You** move it forward by hand — `blaze move <id> <status>` — when you commit
   to working it (intent is a human/agent decision, not automatic).
3. If the project has a `codeRepos` entry, `blaze reconcile` takes over for
   **delivery-workflow tickets only** (epic/story/task/bug/subtask): a branch
   embedding the ticket's key moves it to `in-progress`; opening its PR moves it to
   `in-review`; merging moves it to `done`. Goals and risks are always manual.
   Never hand-move a delivery ticket through the reconcile-owned statuses once a
   branch/PR exists for it — let reconcile own it.

## The join key

The only coupling between the tracker and code is the branch name: it must embed
`<KEY>-<n>`, e.g. `KEY-12-add-export`. `reconcile` greps `KEY-12` out of every
branch/PR head ref in the project's `codeRepos` and matches it to
`projects/KEY/*/KEY-12-*.md`. No API, no webhook, no stored id.

## Frontmatter

Field order as written by the engine: `id`, `title`, `type`, `project`,
`priority`, `resolution`, `parent`, `assignee`, `labels`, `components`,
`estimate`, `worklog`, `links`, `likelihood`, `impact`, `branch`, `pr`, `created`,
`updated`.

- `id` — `<KEY>-<n>`, matches the filename, sequential, never reused.
- `priority` — one of `highest`/`high`/`medium`/`low`/`lowest`/`none`/`urgent`.
- `resolution` — `null` until terminal; one of `done`/`wont-do`/`duplicate`/
  `cannot-reproduce`.
- `parent` — another ticket's `id`; must satisfy the parent-type rule in the table
  above (validated, including cycle detection).
- `labels` / `components` — set via `blaze new --labels a,b` / `--components a,b`,
  or `blaze edit <id> labels a,b` / `components a,b`. When the project declares a
  non-empty `labels`/`components` list in `project.json`, values are validated
  against it (see below); `defaultLabels` in `blaze.config.json` is the
  tracker-wide fallback for projects with no taxonomy of their own.
- `estimate` — minutes, rounded to the nearest 5 (`blaze new --estimate`).
- `worklog` — list of `{ date, minutes, note? }`, appended by `blaze log`; minutes
  round to the nearest whole minute.
- `likelihood` / `impact` — risk-only fields.
- `branch` / `pr` — filled by `reconcile`; don't hand-edit.
- `links` — set via `blaze link`, see "Links" below.

## Links

`blaze link [--rm] <id> <TYPE> <target>` adds (or, with `--rm`, removes) a typed
link on `<id>`'s `links:` frontmatter. `TYPE` is one of `Blocks` / `Relates` /
`Duplicate` / `Cloners` (`scripts/model/links.mjs` → `LINK_TYPES`) — any other
value is rejected. Adding validates that `target` resolves to a real ticket id;
`<id>` itself must also resolve. Add is idempotent — linking the same
`{type, target}` pair twice is a no-op, not a duplicate entry. `--rm` removes a
matching `{type, target}` pair if present (also a no-op if it's already gone).

```bash
blaze link ENG-12 Blocks ENG-9        # ENG-12 blocks ENG-9
blaze link --rm ENG-12 Blocks ENG-9   # remove that link
```

**`Blocks` is advisory, not a hard gate.** Moving a ticket to `in-progress`
while an open (non-terminal) ticket holds a `Blocks` link targeting it prints
a warning to stderr — the move still proceeds. `blaze move` never refuses a
transition because of a `Blocks` link; see
[ADR-0001](docs/decisions/0001-blocks-link-advisory-not-hard-gate.md) for why.

Link data doesn't need a separate integrity check: `blaze reindex` already
lints every ticket's `links` for malformed entries and dangling targets (see
"Derived caches" below), and the board renders link edges in both the graph
view and each ticket's detail panel — `blaze link` and `--rm` are additive to
those existing surfaces, not new ones.

## Labels/components taxonomy

`projects/<KEY>/project.json` can declare `labels: [...]` and/or
`components: [...]` — the project's closed taxonomy for those two fields. Both
`blaze new` and `blaze edit` run every `labels`/`components` value through
`validateTaxonomy` (`scripts/model/taxonomy.mjs`): a value not in the declared
list is a **hard reject** (non-zero exit, nothing written) — add it to
`project.json` first. A project that declares an empty (or omitted) list for a
field opts out of validation for that field entirely — existing projects with
no taxonomy configured see no behavior change.

Separately, `requireComponents` / `requireLabels` in `project.json` (both
default `false`) are a **soft** gate: when `true` and `blaze new` would create a
ticket with that field empty, it prints a warning to stderr but still exits 0
and writes the ticket — pass `--reason "<why blank>"` to suppress the warning
(the reason is not itself stored). This only fires on `new`; it's a nudge at
creation time, not an ongoing constraint `blaze edit` re-checks.

## Data-root ladder

The engine (this install) and the data (`blaze.config.json` + `projects/` + the git
history tickets commit into) can live in different trees. Every command resolves
roots the same way:

1. `BLAZE_PROJECTS_DIR` env — an explicit `projects/` directory; the data root is
   its parent.
2. `./projects` under the current working directory — running from inside the
   data repo.
3. The engine tree itself — single-tree back-compat only, and **only when the
   engine isn't installed under `node_modules`**. For a global/npx install
   (the normal packaged case), if neither rung 1 nor 2 matched, `resolveRoots`
   throws `blaze: no data dir found — set BLAZE_PROJECTS_DIR or run from a
   directory containing projects/` instead of silently falling back to the
   engine's own tree.

## Live activity feed

`<dataRoot>/.blaze/activity.jsonl` is an **append-only, gitignored, truncatable**
feed of agent activity — one JSON object per line:
`{ts, key, branch, tool, cwd}` (`ts` ISO-8601 UTC, `key` a `<KEY>-<n>`). It is a
*view input*, not a source of truth: delete or `truncate` it any time; the board
rebuilds the Live view from whatever remains. Producer: the claude-config
`blaze-activity.sh` PostToolUse hook (writes only for branches whose `KEY-n` this
board tracks). Consumer: the board's **Live** view (`scripts/model/activity.mjs`
→ `/api/live`), which tails the last N lines, groups by ticket, and marks a
ticket active when its latest event is within a ~2-minute TTL. Malformed lines
are skipped, never fatal. Read it yourself with `tail -f .blaze/activity.jsonl`.

## Derived caches

`.blaze/index.json` (the ticket index) and `.blaze/transitions.json` (status-move
history derived from git rename history, powering the Metrics view's cumulative-flow
diagram) are both derived, regenerable caches — safe to delete any time. `blaze
reindex` rebuilds both from `projects/` and git history respectively.

While building the index, `blaze reindex` also lints every ticket's `links`
(`scripts/model/links.mjs` → `lintLinks`) and prints one warning per issue —
never a hard failure: a link entry using `to:` instead of `target:` (previously
silently dropped), a `type` outside `Blocks`/`Relates`/`Duplicate`/`Cloners`, or
a `target` that doesn't resolve to a known ticket id (dangling). Warnings are
also stored on the index (`idx.warnings`) for any consumer that wants them.

## Commit modes

`blaze.config.json`'s `commitMode` decides how CLI verbs commit:

- `per-op` (default) — each `new`/`move`/`log`/`resolve`/`edit` commits immediately,
  scoped to exactly the file(s) it touched (never a broad `git add -A`).
- `batch` — the op is appended to a pending queue instead; run `blaze commit` to
  flush your queue into one commit (subject = a per-op count summary, body = one
  line per queued op).

### Sessions (parallel agents on one board)

Export a unique `BLAZE_SESSION` (letters, digits, `._-`) at session start — e.g.
your harness session UUID. Batch ops then queue to your own
`.blaze/pending/<session>.jsonl`, and:

- `blaze commit` flushes **only your queue** — a parallel session's queued WIP
  never rides your commit.
- `blaze commit --all` sweeps every session queue plus the shared fallback
  (end-of-day / bundler path); body lines are tagged `[<session>]`. It's the
  quiescent/end-of-day sweep: ops a session appends mid-sweep survive (each
  queue clears exactly the bytes it read, so a late append isn't lost), but
  prefer running it when sessions are idle.
- No `BLAZE_SESSION` → the shared `.blaze/pending-commit.jsonl` fallback, exactly
  the pre-0.4 behavior.

Concurrent commits serialize on an advisory `.blaze/commit.lock/` (stale locks
from dead processes are stolen automatically). If your flush is behind an
already-fetched `origin/main`, `blaze commit` warns — rebase before publishing;
the engine itself never pushes.

Working-tree cross-talk is tolerated by design: sessions sharing one checkout
see each other's on-disk ticket moves in `git status` until the owning session
flushes. Use a git worktree per session when you need hard isolation.

## Querying the board

```bash
for s in defined in-progress in-review; do echo "## $s"; ls projects/*/$s/*.md 2>/dev/null; done
grep -rl '^priority: urgent' --include='*.md' projects/
blaze rollup            # every goal/epic's rolled-up estimate + logged time
blaze rollup KEY-12      # one ticket's own vs. rolled totals, with child breakdown
```

## Board UI — search, filter chips, board switcher, focus drill, map, detail panel

All of these are pure client-side **views over the served model** — no new source
of truth, full CLI/`grep` parity preserved:

- **Search** — a header search box filters visible cards/rows by a `data-search`
  index (id + title + labels + assignee, lowercased) that each card/row carries.
  Pure substring match, no round-trip. Model seam: `scripts/model/search.mjs`.
- **Status chips** — one chip per resolved-schema status with a live count, plus
  `All` and `Active` presets (`Active` = every non-terminal status, schema-driven
  via `scripts/model/filters.mjs`). Selection serialises to the URL hash
  (`#status=all|active|<status>`) so a filtered board is a shareable link. Search
  and chips **compose** — a card is visible iff it passes both. Counts re-render on
  the existing reload-on-mutation path.
- **Board switcher** (`.boardtoggle`) — a workflow can produce more than one
  board (`scripts/model/boards.mjs` → `deriveBoards`, fed the resolved
  `types`/`workflows` so a data-repo schema override flows through): the
  primary board folds any workflow whose non-terminal statuses are a subset of
  its own, and every other workflow gets its own standalone board. The default
  schema shows one `delivery` board (epic/story/task/bug/subtask) and one
  `risk` board; a single-workflow config shows one board and no switcher pills.
  Switching boards composes into the same `#status=` hash as the chips — it
  never clobbers an active chip filter, and there's no hash write on load.
- **Focus drill** — `?focus=<id>` on `/` scopes the board, list, **and map**
  to that ticket's direct children only, not transitive descendants
  (`scripts/model/focus.mjs` → `scopedRows`, the one shared drill-scope rule
  all three views consume so they can't disagree about what a level
  contains). A `.crumbs` breadcrumb bar renders the ancestor chain back to
  `All` for drilling up. A card/row with children shows a `⤵ N` drill-down
  link to `?focus=<id>`, preserving the active `?project=`.
- **Map** — a **dependency neighbourhood** graph (`scripts/views/map.mjs`, on by
  default). Drilling a ticket (`?focus=<id>`) renders its 1-hop link
  neighbourhood in role columns: tickets that **Block it** on the left
  (upstream), the anchor in the centre, tickets **it Blocks** on the right
  (downstream), and `Relates`/`Duplicate`/`Cloners` in a neutral band below.
  Direction reads by column position **and** an arrowhead on each (directed)
  `Blocks` edge; `Relates` edges are dashed and undirected. `Blocks` is
  advisory (ADR-0001), not a hard gate. Clicking a node opens the shared detail
  panel; a per-neighbour **→** re-centres the map on that ticket's own
  neighbourhood (`data-drill` → `?focus=`, the seam BLZ-35's client tests lock).
  With no focus the map shows a "Select a ticket to see its dependencies"
  prompt; a link-less ticket shows a plain "No links" caption; the anchor's own
  unresolvable links (dangling target, or a malformed entry) surface a count
  note rather than being silently dropped. Deterministic, zero-dep, no force
  simulation. `?flat=1` and whole-corpus rendering were removed with BLZ-108 (a
  neighbourhood is inherently small); the `flat` escape hatch remains only for
  board/list/metrics.
- **Detail panel** — clicking a card/row id opens a side panel with the rendered
  description, a full frontmatter table, parent breadcrumb + children list, and
  links. Served (escaped) by **`GET /api/panel?id=<KEY-n>`** → the panel-content
  HTML (`scripts/views/panel-content.mjs`); 404 JSON for an unknown id. AC
  checkboxes in the panel toggle via the existing commit-on-edit `/api/ac` path.
  `window.blazePanel.open(id)` / `.close()` is the shared seam other views (map
  node-click, field editing) build on.
- **Inline field editing** — the panel's Fields table and title heading are
  schema-driven off `scripts/model/fields.mjs`: `fieldInputs` turns a ticket's
  frontmatter into per-field descriptors (editable or not, `text` or `select`
  kind), and the single `EDITABLE_FIELDS` allowlist there is consumed by both
  the panel (what renders as an editable span) and **`POST /api/edit`**'s
  `applyEdit` (what it accepts) — no field the UI offers can be one the server
  rejects. `id`/`type`/`status`/`resolution`/`project`/dates are always
  read-only; status/resolution only change via drag/move + resolve. An edit
  commits through the same commit-on-mutation path as move/log/resolve.

## Grooming rules

When grooming a freshly-captured ticket (in its type's initial status), make these
and only these edits to its `.md` file, then stop:

- **Type & priority**: set `type` and `priority` from the ticket's content.
- **Labels**: add labels from the project's configured taxonomy that match the
  area/intent. Do not invent new labels.
- **Acceptance criteria**: if the `## Acceptance Criteria` list is empty or a
  placeholder, draft 2–4 concrete, testable checkboxes from the context.
- **Duplicates**: if the ticket clearly duplicates another, note it in `## Notes`
  pointing at the surviving id (do not move or delete it — that stays a human
  decision).
- **Links**: in `## Notes`, link closely related tickets by id.

Bump `updated:` to today on any edit. Never touch `id`, never change the
directory, never edit code or any file outside the tracker.

## Configuration

`blaze.config.json` (data-repo root): `key`, `projects` (array of project keys the
board renders), `commitMode`, `port`, and more.

`schemaVersion` (top-level, optional integer): which schema contract the board
was written against. Absent = `1` (the pre-versioning baseline). The engine
refuses to load a board stamped outside its supported window (currently `1..1`)
instead of silently misreading it — see
[`docs/schema-versioning.md`](docs/schema-versioning.md).

`projects/<KEY>/project.json` (optional, per project): `labels`, `components`
(the project's taxonomy for those fields — see "Labels/components taxonomy"
above; empty/omitted = no validation), `requireLabels`/`requireComponents`
(default `false` — soft-warn on `blaze new` when the field is left empty; see
above), `codeRepos` (repos `reconcile` mirrors for this project),
`requireWorklogBeforeTerminal` (default `false` — when `true`, a leaf ticket
(story/task/bug/subtask) needs at least one `worklog` entry before it can enter a
terminal status; epics/goals/risks are exempt since their time rolls up from
children), and `schema` (a per-project type/workflow override — see
[`docs/schema-customization.md`](docs/schema-customization.md)).

`views` (top-level, `blaze.config.json`): `{ board, list, live, metrics, map }`,
each defaulting to `true` — set any to `false` to hide that view's pill and
404 its `/view/<name>` fragment endpoint (zero model computation for a disabled
view). `board` cannot be disabled — it is forced back to `true` after the merge,
since the shell always needs a default view to render. A board with a view
disabled and a stale `localStorage` save for it falls back to `board` on
first load.
