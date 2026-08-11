# Customizing the schema (types, hierarchy, required fields, workflows)

Blaze ships a built-in **default** schema — the ten types and five workflows of the
requirements-driven model (`goal → requirement → architecture → feature → story/task/bug`,
plus `risk` and `subtask`). A data repo customizes it
**without editing engine source** by adding a `schema` block to its config. The
engine applies the **top-level** override at load, so validation, the board
columns, and the CLI all read it. A `resolveSchema` helper additionally layers
`default → top-level → per-project`, available to any future feature that
calls it — as of today nothing in the engine does. See
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
- **Per-project** — `projects/<KEY>/project.json`. Resolved by `resolveSchema`
  to win over the top-level block for the same entry, available to any future
  feature that calls it. The built-in `blaze new`/`move`/board commands don't
  call it — see
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
`projects/<KEY>/project.json` instead. That block is resolved by
`resolveSchema`, available to any future feature that calls it — as of today
nothing in the engine does, so a per-project block has no effect on the
built-in `blaze new`/`move`/board commands. Verifying a per-project override
with step 3 above won't show anything; there is no feature yet to verify it
against.

## What reads the resolved schema

| Scope | Read by |
|---|---|
| **Default → top-level** | Board columns, transition legality, and every read that goes through the ambient registry. |
| **Default → top-level → per-project** | **Ticket validation on the write path** — `blaze new` and `blaze edit` (BLZ-238). |

`blaze new` validates a create against the **target project's** registry, and `blaze edit`
validates against the **edited ticket's** project. A retype's child sweep judges each child by
**its own** project's registry, since a child may live elsewhere.

Call `loadProjectSchema(projectsDir, key)` from `scripts/model/schema-config.mjs` to resolve one
project's registry, or `resolveSchema({ config, project })` if you already hold both objects.

**A project with no `schema` block resolves to the ambient registry, not to nothing** — so
per-project customisation is opt-in rather than a cliff, and adding a block to one project cannot
affect another.

> Two things still read the ambient registry only: **board columns** and **transition legality**.
> A project that overrides a type's `workflow` will therefore see its tickets validated by its own
> rules but rendered in the ambient board's columns. That is a real gap, not a design choice —
> narrowing it means threading the project through the view layer.
