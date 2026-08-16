# The default schema & how to customise it

Every ticket belongs to a **type**, and every type runs through a **workflow**.
Both are built into the engine — no config file ships them, no per-project
setup is required to start using them. This page has two parts: what you get
by default, and how to change it.

## Part 1 — The defaults

### Work-item types

`description` is not a frontmatter field — it maps to the ticket **body**.

| Type | Level | Legal parent(s) | Required fields | Workflow |
|---|---|---|---|---|
| `goal` | 4 | top-level | title, description | goal |
| `requirement` | 3 | goal | title, description | requirement |
| `architecture` | 2 | requirement or goal | title, description | architecture |
| `feature` | 1 | architecture, requirement or goal | title, description | delivery |
| `risk` | 1 | goal, requirement, architecture or feature | title, description, likelihood, impact | risk |
| `story` | 0 | requirement or feature | title, description, estimate | delivery |
| `task` | 0 | feature or story | title, description, estimate | delivery |
| `bug` | 0 | feature or story | title, description, estimate | delivery |
| `subtask` | -1 | story, task, or bug | title, description | delivery |
| `epic` | 1 | — (unparentable) | title, description | delivery — **retired, legacy only** |

`epic` is retired in favour of `feature` (BLZ-231) and retained only because the
engine cannot delete a type — see "The engineering model" below. Never create one.

Parent legality and cycle detection are enforced on every write — you cannot
park a `story` under a `goal`, or create a parent/child loop.

### Workflows

A workflow's columns are exactly its status directories.

| Workflow | Types | Status sequence | Terminal | Reopen target |
|---|---|---|---|---|
| delivery | feature, story, task, bug, subtask | `defined → in-progress → in-review → done` | `done` | `defined` |
| goal | goal | `defined → in-progress → achieved` | `achieved` | `defined` |
| risk | risk | `identified → { mitigated \| accepted \| obsolete }` | `mitigated`, `accepted`, `obsolete` | `identified` |
| requirement | requirement | `proposed → { implemented \| rejected \| obsolete }` | `implemented`, `rejected`, `obsolete` | `proposed` |
| architecture | architecture | `proposed → { accepted \| rejected }` | `accepted`, `rejected` | `proposed` |

A move is legal only along an adjacent forward edge in that sequence, or a
jump back to the reopen target — nothing else. Entering a terminal status
auto-sets `resolution`: delivery's `done` and goal's `achieved` both resolve
`done`; risk's `mitigated`/`accepted` resolve `done`; risk's `obsolete`
resolves `wont-do`. `blaze resolve` exists for the cases that don't fit that
mapping — see [`commands.md`](commands.md).

### Fixed enums

These two are **not** overridable via config, top-level or per-project:

| Enum | Values |
|---|---|
| priority | `highest, high, medium, low, lowest, none, urgent` (CLI default: `medium`) |
| resolution | `done, wont-do, duplicate, cannot-reproduce` |

### Frontmatter fields

`blaze new` writes:

```
id, title, type, project, priority, resolution (null), parent (or null),
assignee (default "unassigned"), labels ([]), components ([]), estimate,
created, updated
```

Conditionally, on the same write: `likelihood`/`impact` for `risk`, and
`sprint`/`start`/`due` if you pass them.

Other verbs add fields later — don't hand-edit any of these:

| Field | Added by |
|---|---|
| `worklog` | `blaze log` |
| `links` | `blaze link` |
| `branch`, `pr` | `blaze reconcile` |

Field order on disk is fixed by the serializer, not by write order.

## Part 2 — Customising it

Two layers, plus a fixed engine default under both. Start closest to the
ticket and work outward.

### Per-project: `projects/<KEY>/project.json`

| Key | Effect |
|---|---|
| `components`, `labels` | Non-empty → a **hard** taxonomy; `blaze new`/`blaze edit` reject any value not on the list. Empty or undeclared → opt-out, no enforcement. |
| `requireComponents`, `requireLabels` | Default `false`. `true` makes `blaze new` print a warning (never a hard failure) when the field is left empty. Suppress with `--reason "<why blank>"`. |
| `codeRepos` | Wires `blaze reconcile` to a git repo for that project — mirror mode. |
| `requireWorklogBeforeTerminal` | Blocks a terminal move until the ticket has a worklog entry. |

### Top-level: `blaze.config.json`

The real, consumed keys:

| Key | Effect |
|---|---|
| `key` | Legacy id prefix. In practice the prefix you get is whatever `--project <KEY>` you pass. |
| `projects` | Which `projects/<KEY>/` directories the reconcile loop, groomer loop, and `blaze migrate` operate over by default. The board itself renders any `projects/<KEY>/` it finds on disk, regardless of this list. |
| `boardTitle` | Board header text. |
| `defaultLabels` | The label set fed to the groomer's prompt — the labels it may apply when triaging. It is **not** a fallback taxonomy: `blaze new`/`edit` don't enforce it, and a project with no `labels` of its own stays unconstrained. |
| `port` | Board port (see [`getting-started.md`](getting-started.md) for the full override order). |
| `agentCommand` | Command the groomer loop spawns per ticket. |
| `commitMode` | `"per-op"` (default) or `"batch"`. |
| `loops.reconcile`, `loops.groomer` | Enable/cadence/columns for each background loop. |
| `views` | Toggles Board / List / Live / Metrics / Map / Gantt. `board` can't be disabled. |
| `schemaVersion` | Compat stamp — see below. |
| `schema` | Type/workflow overrides — see below. |

Minimal:

```json
{ "key": "ENG", "projects": ["ENG"] }
```

A bit richer:

```json
{
  "key": "ENG",
  "projects": ["ENG"],
  "boardTitle": "Engineering",
  "defaultLabels": ["needs-triage"],
  "commitMode": "batch",
  "views": { "map": false }
}
```

A handful of keys exist in the engine's internal defaults object
(`columns`, `terminal`, `provider`, a singular `codeRepo`) but have no live
consumer today. They aren't documented here as working knobs — don't rely
on them.

### The `schema` block

Shape:

```json
{
  "schema": {
    "types":     { "<name>": { "level": 0, "workflow": "<wf>", "parentTypes": ["feature"], "required": ["title", "description"] } },
    "workflows": { "<wf>":  { "statuses": ["a", "b"], "terminal": ["b"], "transitions": [["a", "b"]], "reopenTo": "a", "resolutionOnTerminal": { "b": "done" } } }
  }
}
```

Resolution is per-entry: `default → top-level → per-project`, later wins. An
entry you name **replaces the whole entry**; entries you don't mention keep
their built-in defaults.

> **Caveat:** only the **top-level** `schema` block (in `blaze.config.json`)
> takes effect today. A `schema` block inside a per-project `project.json` is
> currently a no-op — the layered resolver exists in code but nothing calls
> it for per-project scope yet.

For a worked example — adding a `spike` type on a two-column `research`
workflow — see [`docs/schema-customization.md`](../schema-customization.md).

### `schemaVersion`

An optional integer that stamps which schema contract a board was written
against. Absent means `1`. The engine refuses to load a board stamped outside
the window it currently supports, rather than silently misreading older or
newer ticket history. New boards don't need to set it. Full compat-window
detail: [`docs/schema-versioning.md`](../schema-versioning.md).

---

Fixed: priorities, resolutions, the type/workflow shapes the engine ships by
default. Customisable: which types and workflows are active, per project or
board-wide, via the top-level `schema` block.

---

## The engineering model (now the built-in default)

This started as an opt-in `engineering` preset installed via a `schema` block.
**It has since been adopted as the engine's built-in default** — the registry in
Part 1 above is this model, so a new board runs it with no `schema` block at
all. The section is kept because it explains the *reasoning* behind the
hierarchy, which the Part 1 table only states.

The relationship it's built on, in one line:

**A project builds workable items. `REQ` and `ADR` are the references
inside that project that those items trace to.** Only `requirement` and
`architecture` carry a `ref` — the ticket id (`BLZ-150`) is identity, the
`ref` (`REQ-014`) is the citation. Write the `ref` in prose, never the
ticket's path — a ticket's status is its directory, so its path changes on
every transition; the `ref` doesn't.

| Type | Level | Legal parents | Workflow |
|---|---|---|---|
| `goal` | 4 | (top-level) | `goal` |
| `requirement` | 3 | `goal` | `requirement` |
| `architecture` | 2 | `requirement`, `goal` | `architecture` |
| `feature` | 1 | `architecture`, `requirement`, `goal` | `delivery` |
| `story` | 1 | `requirement` | `delivery` |
| `risk` | 1 | `goal`, `requirement`, `architecture`, `feature` | `risk` |
| `task` | 0 | `feature`, `story` | `delivery` |
| `bug` | 0 | `feature`, `story` | `delivery` |

`feature` occupies the altitude other tools call `epic` — the PR unit, one
integration branch, typically 4–8 child tasks. Adopting this registry doesn't
remove `epic`/`subtask`, because the engine can add or replace a type but never
delete one.

**Do not re-add `epic` to `task`/`bug`/`story`'s `parentTypes`.** Earlier
guidance here suggested keeping it there until existing tickets were migrated;
that migration is done (275 tickets, `blaze-pm` `origin/main` holds zero epics),
and re-adding it un-retires the type. If you are migrating a board that still
holds epics, retype them to `feature` rather than widening the parent rules —
see BLZ-249 for a branch that got this wrong.

The `approved`/`verified` (on `requirement`) and `superseded` (on
`architecture`) gates are designed but not shipped in the documented
configuration — each needs a return visit after the triggering event has
passed, and return-visit obligations measure far below fields captured at
creation time on the board this model was developed against.

Full type reference, field requirements, link vocabulary, and what the
engine can't yet express: [`../method/work-item-types.md`](../method/work-item-types.md).
The reasoning behind the model: [`../method/engineering-method.md`](../method/engineering-method.md).
