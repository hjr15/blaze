# Conventions — the ticket shape

The canonical shape is `TEMPLATE.md`. This file explains each field.

## File naming

`<STATUS-DIR>/<KEY>-<n>-<short-slug>.md`, e.g. `todo/TASK-008-fix-overlap.md`.
`<KEY>` defaults to `TASK` (set `key` in `blaze.config.json`). Ids are sequential,
never reused; next id is `max(existing) + 1`.

## Status = directory (no field)

There is no `status:` field. The directory is the single source of truth.

| Directory | Meaning |
|---|---|
| `backlog/` | Captured, not yet committed to |
| `todo/` | Committed to, ready to pick up |
| `in-progress/` | Actively being worked |
| `in-review/` | PR open / awaiting review |
| `done/` | Shipped |
| `canceled/` | Won't do |
| `duplicate/` | Superseded — point to the surviving id |

## Frontmatter fields

| Field | Required | Values |
|---|---|---|
| `id` | yes | `<KEY>-<n>` — matches the filename |
| `title` | yes | Short imperative summary |
| `type` | yes | `feature` · `bug` · `improvement` · `chore` |
| `priority` | yes | `urgent` · `high` · `medium` · `low` · `none` |
| `labels` | no | area/intent labels — see below |
| `project` | no | optional grouping |
| `assignee` | no | a name, or `unassigned` |
| `estimate` | no | story points (integer) |
| `parent` | no | parent ticket id when this is a sub-issue of an epic |
| `branch` | no | the code-repo branch — auto-filled by reconcile in mirror mode |
| `pr` | no | the PR as `#<n> — <url>` — auto-filled by reconcile |
| `created` | yes | `YYYY-MM-DD` |
| `updated` | yes | `YYYY-MM-DD` — bump on every edit |

## Labels

Free-form, but keep to a consistent taxonomy so search stays useful. The default set
(`blaze.config.json` → `defaultLabels`): `frontend`, `backend`, `infra`, `docs`, `bug`,
`chore`. Customize for your project.

## Epics & sub-issues

An epic is a ticket whose children set `parent: <KEY>-<n>`. The epic stays in
`in-progress/` while its sub-issues move independently; it reaches `done/` when the last
child does.
