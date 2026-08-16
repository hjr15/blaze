# Customizing the schema (types, hierarchy, required fields, workflows)

Blaze ships a built-in **default** schema — the ten types and five workflows of the
requirements-driven model (`goal → requirement → architecture → feature → story/task/bug`,
plus `risk` and `subtask`). A data repo customizes it
**without editing engine source** by adding a `schema` block to its config. The
engine applies the **top-level** override at load, so validation, the board
columns, and the CLI all read it. A `resolveSchema` helper additionally layers
`default → top-level → per-project`, which the write path and the hygiene gate
resolve so a single project can carry its own type rules. See
[What reads the resolved schema](#what-reads-the-resolved-schema) below for which
scope actually takes effect where.

> **Breaking change (BLZ-231).** The shipped defaults were the Jira-inherited seven types
> (`goal/epic/risk/story/task/bug/subtask`) and are now the requirements-driven model. Two
> consequences for a board that has not migrated:
>
> - **`epic` is retained but unparentable.** It cannot be removed — `mergeTypes` is a spread
>   merge, so an override can replace or add an entry but never delete one, and a board that
>   still holds epics must keep loading. It now has no legal parent, so existing epics stay
>   readable and **no new one can be created**.
> - **`story`/`task`/`bug` hang off `feature`, not `epic`.** A board with `task → epic` edges
>   will report them as illegal.
>
> A board that wants the old behaviour restores it with a top-level `schema.types` override —
> the same mechanism this page documents. A board that wants the new model now gets it with no
> override at all, which is the point. **Migrate first, then tighten**: `validateTicket` does
> not run on `reindex`, so a registry change that outruns the corpus is silent.

## Where overrides live

- **Top-level** — `blaze.config.json` at the data repo root. Applies to every
  project.
- **Per-project** — `projects/<KEY>/project.json`. `resolveSchema` resolves it
  to win over the top-level block for the same entry, and the **write path**
  (`blaze new`, `blaze edit`) and the **hygiene gate** (`blaze audit`) each
  judge a ticket against its own project's registry (BLZ-238). Board columns
  and transition legality still read the top-level registry board-wide. See
  [What reads the resolved schema](#what-reads-the-resolved-schema).

Both use the same shape:

```json
{
  "schema": {
    "types":     { "<name>": { "level": 0, "workflow": "<wf>", "parentTypes": ["epic"], "required": ["title", "description"] } },
    "workflows": { "<wf>":  { "statuses": ["a", "b"], "terminal": ["b"], "transitions": [["a", "b"]], "reopenTo": "a", "resolutionOnTerminal": { "b": "done" } } }
  }
}
```

## Precedence and merge semantics

Resolution is **per entry**: `default → top-level → per-project`, later wins.
An override entry for a type or workflow **replaces that whole entry** (or adds it
if the name is new); entries you don't mention keep their defaults. There is no
deep-merge of sub-fields — supply the complete `{level, workflow, parentTypes,
required}` for a type and the complete `{statuses, terminal, transitions,
reopenTo, resolutionOnTerminal}` for a workflow.

- A **type** entry: `level` (2=goal … 0=leaf … -1=subtask), `workflow` (the name
  of a workflow — built-in or one you define), `parentTypes` (which parent types
  it may hang under), `required` (frontmatter fields that must be present;
  `description` maps to the body).
- A **workflow** entry: `statuses` (ordered; the first is the initial status),
  `terminal`, `transitions` (allowed `[from, to]` pairs; a move to `reopenTo` from
  any other status is always allowed), `reopenTo`, `resolutionOnTerminal` (maps a
  terminal status to a resolution).

## Worked example 1 — manual (a human edits the config)

Add a `spike` type on a fast two-column `research` workflow, top-level, so every
project can use it. Edit `blaze.config.json`:

```json
{
  "key": "ENG",
  "projects": ["ENG"],
  "schema": {
    "types": {
      "spike": { "level": 0, "workflow": "research", "parentTypes": ["epic"], "required": ["title", "description"] }
    },
    "workflows": {
      "research": {
        "statuses": ["open", "answered"],
        "terminal": ["answered"],
        "transitions": [["open", "answered"]],
        "reopenTo": "open",
        "resolutionOnTerminal": { "answered": "done" }
      }
    }
  }
}
```

`blaze new --project ENG --type spike "Investigate export perf"` now lands in
`open`; the board renders an `open → answered` column set for it; the other types
are unchanged.

## Worked example 2 — AI-driven (an agent edits the config)

An agent customizes the schema with ordinary file tools — no engine change:

1. **Read** this page and the current `blaze.config.json`.
2. **Edit** `blaze.config.json` at the data repo root to add the `schema`
   block, using the shapes above.
3. **Verify** with `blaze` — e.g. create a ticket of the new type and confirm it
   lands in the new initial status, or open the board and confirm the columns.
4. **Commit** the config change to the data repo. The engine picks it up on its
   next load; no engine source is touched and no version bump is needed.

**Scoping to one project:** you can put the same `schema` block in
`projects/<KEY>/project.json` instead. It is resolved by `resolveSchema` and
**takes effect on the write path** — `blaze new`, `blaze edit`, and `blaze
audit` each judge a ticket against its own project's registry, so one project
can widen or narrow its type rules without touching another's. Step 3 above
verifies it: create a ticket that only the overriding project should accept,
and confirm a second project still refuses it.

Board columns and transition legality remain **board-wide** — they come from the
ambient registry, not the per-project one. See the table below for exactly which
reads resolve which scope.

## Worked example 3 — a substantial override: the `engineering` preset

Most overrides touch one or two entries. A larger one — new types **and** new
workflows together — works the same way, just with more entries in the same
two objects. This is the mechanical piece behind the `engineering` preset's
type hierarchy, documented in full (reasoning, field requirements, link
vocabulary, engine limits) in
[`method/work-item-types.md`](method/work-item-types.md); shown here
abbreviated to `requirement`, `architecture`, and one delivery type, since the
rest of `feature`/`story`/`risk`/`bug` follow the same shape:

```json
{
  "schema": {
    "types": {
      "goal":         { "level": 4, "workflow": "goal", "parentTypes": [], "required": ["title", "description"] },
      "requirement":  { "level": 3, "workflow": "requirement", "parentTypes": ["goal"], "required": ["title", "description", "ref", "verification", "derived"] },
      "architecture": { "level": 2, "workflow": "architecture", "parentTypes": ["requirement"], "required": ["title", "description", "ref"] },
      "feature":      { "level": 1, "workflow": "delivery", "parentTypes": ["architecture", "requirement", "goal"], "required": ["title", "description", "estimate"] },
      "task":         { "level": 0, "workflow": "delivery", "parentTypes": ["feature", "story", "epic"], "required": ["title", "description", "estimate"] }
    },
    "workflows": {
      "requirement": {
        "statuses": ["proposed", "implemented", "rejected", "obsolete"],
        "terminal": ["implemented", "rejected", "obsolete"],
        "transitions": [["proposed", "implemented"], ["proposed", "rejected"], ["proposed", "obsolete"], ["implemented", "obsolete"]],
        "reopenTo": "proposed",
        "resolutionOnTerminal": { "implemented": "done", "rejected": "wont-do", "obsolete": "wont-do" }
      },
      "architecture": {
        "statuses": ["proposed", "accepted", "rejected"],
        "terminal": ["accepted", "rejected"],
        "transitions": [["proposed", "accepted"], ["proposed", "rejected"]],
        "reopenTo": "proposed",
        "resolutionOnTerminal": { "accepted": "done", "rejected": "wont-do" }
      }
    }
  }
}
```

Three things worth flagging, each covered in full in `work-item-types.md`'s
own "Engine limits" section:

- **`task` keeps `epic` in `parentTypes`** even though this registry defines
  no `epic` type. `mergeTypes` merges by spread, so an override can add or
  replace a type but never remove one — `epic` survives regardless. Drop it
  from `parentTypes` only after every existing `task`/`bug`/`story` parented
  under an `epic` has been migrated (see the Gotchas section below).
- **`approved`, `verified` (on `requirement`) and `superseded`/`deprecated`
  (on `architecture`) are deliberately absent** from the `statuses` lists
  above — they're designed, not shipped. Each needs a return visit after the
  triggering event, and return-visit obligations measure far below fields
  captured at creation, on the board this model was developed against.
- **The five `engineering`-specific link types** (`Implements`, `Addresses`,
  `Verifies`, `Supersedes`, `Derives`) can't be installed this way at all —
  the `schema` block exposes `types` and `workflows` only, there is no
  `links` path. `blaze link` hard-rejects an unknown type outright;
  `work-item-types.md` documents these five as vocabulary/convention, not an
  installable schema.

## Gotchas

Three failure modes worth knowing before hand-writing a `schema` block —
each one has actually broken a board running this mechanism.

- **`transitions` is an array of `[from, to]` pairs, not an object map.**
  `{"proposed": "accepted"}` reads like a reasonable shorthand and is wrong.
  `validateSchema` only checks that a type's `workflow` names a declared
  workflow — it does not check the shape of `transitions` — so the wrong
  shape passes validation cleanly and then throws a raw `TypeError` at the
  first `blaze move` that hits it.
- **`mergeTypes` can add or replace a type, never remove one.** It merges by
  spread (`{ ...defaults, ...override }`), so `"epic": null` or `"epic":
  undefined` in an override leaves the `epic` key present in the merged
  registry — `isType("epic")` still returns `true`, and
  `hierarchyLevel("epic")` throws instead of giving the clean `unknown type`
  error you'd expect from actually deleting it.
- **A type left out of an existing type's `parentTypes` makes existing
  tickets parented that way silently parent-illegal.** "Silently" because
  `validateTicket` runs on `new`, `edit`, and `migrate` — never on
  `reindex` — so the board indexes and renders fine, and the first symptom
  is an unrelated `blaze edit <id> --priority high` failing with `invalid
  parent: task cannot be a child of epic`, an error about a field nobody
  touched. On the board this model was developed against, that pattern
  affected 1,599 parent edges.

## What reads the resolved schema

| Scope | Read by |
|---|---|
| **Default → top-level** | Board columns, transition legality, and every read that goes through the ambient registry. |
| **Default → top-level → per-project** | **Ticket validation on the write path** — `blaze new` and `blaze edit` (BLZ-238) — and **corpus hygiene**, `blaze audit` (BLZ-137). |

`blaze new` validates a create against the **target project's** registry, and `blaze edit`
validates against the **edited ticket's** project. A retype's child sweep judges each child by
**its own** project's registry, since a child may live elsewhere.

Call `loadProjectSchema(projectsDir, key, { config })` from `scripts/model/schema-config.mjs` to
resolve one project's registry, or `resolveSchema({ config, project })` if you already hold both
objects. **`config` is not optional in practice**: it carries the top-level layer, and omitting it
resolves `default → per-project` only — the board's `blaze.config.json` override is skipped without
a word. Load it the way every other call site does, `loadConfig({ root: dirname(projectsDir) })`.
BLZ-246 is what that footgun cost: `blaze new` and `blaze edit` both omitted it, so a board that
declared `task.parentTypes: ["epic", …]` still had its creates refused with `invalid parent: task
cannot be a child of epic`, while the read path honoured the very same block.

**A project with no `schema` block resolves to the ambient registry, not to nothing** — so
per-project customisation is opt-in rather than a cliff, and adding a block to one project cannot
affect another.

> Two things still read the ambient registry only: **board columns** and **transition legality**.
> A project that overrides a type's `workflow` will therefore see its tickets validated by its own
> rules but rendered in the ambient board's columns. That is a real gap, not a design choice —
> narrowing it means threading the project through the view layer.
