# Customizing the schema (types, hierarchy, required fields, workflows)

Blaze ships a built-in **default** schema — the seven types and three workflows
described in [`AGENTS.md`](../AGENTS.md#types--workflow). A data repo customizes it
**without editing engine source** by adding a `schema` block to its config. The
engine applies the **top-level** override at load, so validation, the board
columns, and the CLI all read it. A `resolveSchema` helper additionally layers
`default → top-level → per-project`, available to any future feature that
calls it — as of today nothing in the engine does. See
[What reads the resolved schema](#what-reads-the-resolved-schema) below for which
scope actually takes effect where.

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

The top-level resolved registry is what `blaze` validation (required fields,
parent rules, transition legality) and the board columns read. For per-project
resolution, any future feature would call `resolveSchema({ config, project })`
from `scripts/model/schema-config.mjs` after loading `config`/`project` via
`scripts/config.mjs` — as of today nothing does.
