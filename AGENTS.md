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

## The loop

1. **Create**: `blaze new --project <KEY> --type <type> "<title>" [--estimate m]
   [--parent ID]`. It lands in the type's initial status (`defined` or
   `identified`).
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
- `labels` / `components` — free-form; keep to whatever taxonomy the project sets
  in `project.json` (`defaultLabels` in `blaze.config.json` is the tracker-wide
  fallback).
- `estimate` — minutes, rounded to the nearest 5 (`blaze new --estimate`).
- `worklog` — list of `{ date, minutes, note? }`, appended by `blaze log`; minutes
  round to the nearest whole minute.
- `likelihood` / `impact` — risk-only fields.
- `branch` / `pr` — filled by `reconcile`; don't hand-edit.

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

## Board UI — search, filter chips, detail panel

All three are pure client-side **views over the served model** — no new source of
truth, full CLI/`grep` parity preserved:

- **Search** — a header search box filters visible cards/rows by a `data-search`
  index (id + title + labels + assignee, lowercased) that each card/row carries.
  Pure substring match, no round-trip. Model seam: `scripts/model/search.mjs`.
- **Status chips** — one chip per resolved-schema status with a live count, plus
  `All` and `Active` presets (`Active` = every non-terminal status, schema-driven
  via `scripts/model/filters.mjs`). Selection serialises to the URL hash
  (`#status=all|active|<status>`) so a filtered board is a shareable link. Search
  and chips **compose** — a card is visible iff it passes both. Counts re-render on
  the existing reload-on-mutation path.
- **Detail panel** — clicking a card/row id opens a side panel with the rendered
  description, a full frontmatter table, parent breadcrumb + children list, and
  links. Served (escaped) by **`GET /api/panel?id=<KEY-n>`** → the panel-content
  HTML (`scripts/views/panel-content.mjs`); 404 JSON for an unknown id. AC
  checkboxes in the panel toggle via the existing commit-on-edit `/api/ac` path.
  `window.blazePanel.open(id)` / `.close()` is the shared seam other views (map
  node-click, field editing) build on.

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

`projects/<KEY>/project.json` (optional, per project): `labels`, `components`,
`codeRepos` (repos `reconcile` mirrors for this project),
`requireWorklogBeforeTerminal` (default `false` — when `true`, a leaf ticket
(story/task/bug/subtask) needs at least one `worklog` entry before it can enter a
terminal status; epics/goals/risks are exempt since their time rolls up from
children), and `schema` (a per-project type/workflow override — see
[`docs/schema-customization.md`](docs/schema-customization.md)).
