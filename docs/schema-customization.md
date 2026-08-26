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
    "types":     { "<name>": { "level": 0, "workflow": "<wf>", "parentTypes": ["feature"], "required": ["title", "description"] } },
    "workflows": { "<wf>":  { "statuses": ["a", "b"], "terminal": ["b"], "transitions": [["a", "b"]], "reopenTo": "a", "resolutionOnTerminal": { "b": "done" } } },
    "linkTypes": { "<Name>": { "source_kinds": ["task"], "target_kinds": ["task"], "inverse_name": "<Inverse>", "min_card": 0, "max_card": null } }
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

`linkTypes` follows the same rule, with two differences worth knowing (BLZ-392). The **key is
the identity** — a `name` field that disagrees with it is overwritten, not honoured — and a
malformed entry is **ignored, leaving the shipped declaration in force**, rather than throwing:
a throw here took `blaze audit` down with a stack trace and no report at all. `blaze audit`
reports the ignored block as a soft `schema-invalid` finding, so a block that did nothing does
not do it quietly.

**Narrowing `Precedes` narrows what can be scheduled.** `source_kinds` decides what the critical
path treats as a node, so an empty list or a single typo'd type name makes the whole board
unschedulable. `blaze audit` reports that as `schedule-empty` — an outcome check, because the two
likeliest mistakes are well-formed and no validation of the block's shape would catch them.

It fires when nothing is a node *and* the board holds tickets that ought to be: a type the engine
ships as a `Precedes` source kind, or a type you added **on the `delivery` workflow**, in
`blaze.config.json` or in any `project.json`. It stays
quiet on a board with nothing schedulable to begin with — a requirements-first project, one whose
delivery work is all done, or one whose custom types are non-delivery — because `goal`, `risk`,
`requirement`, `architecture` and `epic` are excluded from the critical path by design, not by
misconfiguration.

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
      "spike": { "level": 0, "workflow": "research", "parentTypes": ["feature"], "required": ["title", "description"] }
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
      "task":         { "level": 0, "workflow": "delivery", "parentTypes": ["feature", "story"], "required": ["title", "description", "estimate"] }
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

- **`task` no longer keeps `epic` in `parentTypes`.** Earlier revisions of this
  example did, on the reasoning that `epic` survives the merge regardless
  (`mergeTypes` is a spread, so an override can add or replace a type but never
  remove one) and existing `task → epic` edges would otherwise become illegal.
  That migration is **done** — 275 tickets retyped, `blaze-pm` `origin/main`
  holds zero epics — so the rule was tightened. **Do not re-add it**: doing so
  un-retires the type. Migrate a legacy board by retyping its epics to
  `feature`, not by widening the parent rules (see BLZ-249).
- **`approved`, `verified` (on `requirement`) and `superseded`/`deprecated`
  (on `architecture`) are deliberately absent** from the `statuses` lists
  above — they're designed, not shipped. Each needs a return visit after the
  triggering event, and return-visit obligations measure far below fields
  captured at creation, on the board this model was developed against.
- **The five `engineering`-specific link types** (`Implements`, `Addresses`,
  `Verifies`, `Supersedes`, `Derives`) still can't be installed for use by
  `blaze link`, which hard-rejects an unknown type outright — `LINK_TYPES` in
  `model/links.mjs` is a fixed `Set` and is a different registry.
  `work-item-types.md` documents these five as vocabulary/convention.

  **`schema.linkTypes` is a separate thing and does exist (BLZ-392).** It layers
  the SCHEDULER's link-type declarations — `source_kinds`/`target_kinds`, which
  decide what may be a `Precedes` endpoint and therefore what the critical path
  can schedule — the same way `types` and `workflows` layer. It does not teach
  `blaze link` a new type. Keyed by link-type name, and the key is the identity:

      "schema": {
        "types": { "spike": { "workflow": "delivery", "level": 0, "parentTypes": ["feature"], "required": ["title", "description", "estimate"] } },
        "linkTypes": {
          "Precedes": {
            "source_kinds": ["feature", "story", "task", "bug", "subtask", "spike"],
            "target_kinds": ["feature", "story", "task", "bug", "subtask", "spike"],
            "inverse_name": "Follows", "min_card": 0, "max_card": null
          }
        }
      }

  Without the `linkTypes` half, a custom delivery type is **not** a `Precedes`
  endpoint, so the scheduler treats it as no node at all. Replacement is
  wholesale per link type — restate every kind you want, not just the new one —
  and a malformed entry is ignored, leaving the shipped declaration in force, and
  reported by `blaze audit` as a soft `schema-invalid` finding.

## Gotchas

Three failure modes worth knowing before hand-writing a `schema` block —
each one has actually broken a board running this mechanism.

- **`transitions` is an array of `[from, to]` pairs, not an object map.**
  `{"proposed": "accepted"}` reads like a reasonable shorthand and is wrong.
  It used to pass validation cleanly and then throw a raw `TypeError` at the
  first `blaze move` that hit it; BLZ-56 made it a load-path refusal (see
  [A malformed override fails loud](#a-malformed-override-fails-loud-blz-56)),
  so it is now caught before the verb runs.
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
| **Default → top-level only** | **`linkTypes`, and therefore the scheduler** — `blaze audit`'s critical path and `blaze schedule import-deps` (BLZ-392). A CPM solve runs over the whole corpus at once, so there is no single project whose endpoint kinds could apply; a per-project `linkTypes` block resolves correctly but reaches nothing. |
| **The union of every layer** | **Which type names an endpoint kind may legitimately mention** (BLZ-392). One `Precedes` list serves the whole installation, so it may name a type that only one project declares — judging it against the top layer alone reported a real type as undeclared. The same union decides whether a custom type counts as schedulable. |

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

## A malformed override fails loud (BLZ-56)

A **valid-JSON but wrong-shape** override used to be accepted in silence. `level` as a
string, `parentTypes` as a bare string, a type whose `workflow` names a workflow that
does not exist, a workflow whose `terminal`/`reopenTo`/`transitions` name a status not
in its own `statuses` — all resolved, and the board only found out much later, when
`workflowDef` threw deep inside a verb or a validation rule quietly stopped firing.

The resolved schema is now checked on load: every type has a numeric `level`, a
`workflow` naming a declared workflow, `parentTypes` that are declared types, and
`required` as an array of field names; every workflow has a non-empty `statuses`, and
its `terminal`, `transitions`, `reopenTo` and `resolutionOnTerminal` reference only
statuses it declares and resolutions the engine knows.

> **A partial type entry is invalid, and this is the trap worth knowing.** `mergeTypes`
> is a **per-entry replace**, not a deep merge — so `"task": { "workflow": "delivery" }`
> does not "adjust task's workflow", it *replaces the whole record* and `task` loses its
> `level`, `parentTypes` and `required`. Write the complete record.

### Two paths, deliberately separate

This is the decision BLZ-56's AC-4 asks to be recorded, and it exists because the two
halves genuinely pull in opposite directions.

| Path | Function | Behaviour |
|---|---|---|
| **Reporting** | `validateSchema(resolved)` | Returns a list of **every** problem, hard and soft. **Never throws.** |
| **Load** | `assertSchemaValid(resolved)` | **Throws** a named `SchemaOverrideError` listing every **hard** problem at once. |

### Hard and soft, and why the load path takes only the hard half

Both read one internally tagged list, so the two can never drift apart.

- **Hard — the override is malformed, and the verb is refused.** A type mapping to a
  workflow nothing declares; a `level` that is not a number, a `workflow` that is not a
  name, `parentTypes` or `required` that is not an array, a `parentTypes` entry naming no
  declared type; a partial type record (the trap above); a workflow with no `statuses`, or
  whose `terminal`, `transitions`, `reopenTo` or `resolutionOnTerminal` name a status it
  does not have or a resolution the engine does not know.
- **Soft — the configuration is legal, and only reported.** A deliberately narrowed
  `requirement` workflow (BLZ-361/R48 — the message itself says "add them, or drop the gate
  deliberately"); a `Precedes` endpoint kind naming no declared type (BLZ-392); a
  `schema.linkTypes` block that was ignored, leaving the shipped declaration in force; and
  a per-project `schema.linkTypes` block, which resolves correctly but reaches nothing.

The split is not cosmetic. `blaze audit` files every soft class above as a soft finding and
reports such a board **`ok=true`**, so refusing the same board on the load path would leave
an operator with a board audit calls clean and not one non-exempt verb that will run. A
check that disagrees with audit on the same board is worse than no check.

`blaze audit` calls the reporting path and surfaces each problem as a `schema-invalid`
finding. It is **exempt from the loud path on purpose**: reporting this class is its
entire job, so refusing to start it would delete the report that tells you what to fix.
BLZ-392 closed exactly that defect — a throw from inside `auditCorpus` killed `blaze
audit` outright, losing the whole hygiene report for one bad field — and
`tests/audit-malformed-linktypes.test.mjs` exists to keep it closed.

Every other verb runs the check before it starts, in `scripts/cli.mjs`, which is the one
place every verb dispatches through. There are two more exemptions — **three in all** —
**`blaze init`**, which runs before a board exists, and **`blaze commit`**, a git flush of
the pending ledger that imports nothing from the model: refusing it would strand ticket
files other verbs have already relocated but not committed. That leaves **18 of the 21
subcommands** running the check.

**The preflight judges the board the way `blaze audit` does**, and that is not a detail.
It validates each project layer as well as the top one, and it finds the projects the way
audit does: from `resolveRoots().projectsDir` (which is **not** `dataRoot/projects` when
`BLAZE_PROJECTS_DIR` names a directory called something else), and falling back to the
directories on disk when `blaze.config.json` carries no `projects` array. Earlier cuts did
none of this: one refused every non-exempt verb on a board `blaze audit` called clean;
another let a malformed `project.json` through while audit reported it, twice over — once
because it looked in `dataRoot/projects` for projects that were not there, and once because
it validated an empty project set and called that a pass. A check that disagrees with audit
in either direction on the same board is worse than no check.

There is **one deliberate departure**. `auditCorpus` also builds an `endpointTypes` union —
every type declared anywhere, across all projects — because a top-level `Precedes` list may
legitimately name a type only one project declares. The preflight does **not**, because that
union feeds exactly one check, the endpoint-kind finding, and that finding is **soft**: the
load path takes the hard entries only, so the union cannot change any decision the preflight
makes. Building it there would be a mechanism that runs and can decide nothing. Re-tagging
that finding hard therefore has to restore the union in `scripts/cli.mjs` in the same change,
or the preflight would refuse every board whose top-level `Precedes` names a project-declared
type — and the re-tagging cannot happen quietly, because a test pins the classification.

The check is **not** inside `ambientSchemaOverride`, and must never be. `TYPES` and
`WORKFLOWS` are module-scope constants resolved through it at **import time**, so a
throw there would make merely importing the model kill every verb before it ran — `blaze
audit` included, with a raw stack trace. That is BLZ-392's defect one level worse, and
the guarded catch there stays exactly as it is (ADR-0002).

Anything else the preflight meets — no board, an unreadable or unparseable config, a
packaged install with no data dir — is not its business and does not stop the verb.
Those cases behave exactly as they did before.
