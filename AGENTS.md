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

## Commit modes

`blaze.config.json`'s `commitMode` decides how CLI verbs commit:

- `per-op` (default) — each `new`/`move`/`log`/`resolve`/`edit` commits immediately,
  scoped to exactly the file(s) it touched (never a broad `git add -A`).
- `batch` — the op is appended to `.blaze/pending-commit.jsonl` instead; run
  `blaze commit` to flush everything queued into one commit (subject = a per-op
  count summary, body = one line per queued op).

## Querying the board

```bash
for s in defined in-progress in-review; do echo "## $s"; ls projects/*/$s/*.md 2>/dev/null; done
grep -rl '^priority: urgent' --include='*.md' projects/
blaze rollup            # every goal/epic's rolled-up estimate + logged time
blaze rollup KEY-12      # one ticket's own vs. rolled totals, with child breakdown
```

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
