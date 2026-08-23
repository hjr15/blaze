# Project-owned views — design spec

**Goal:** BLZ-354. **Date:** 2026-08-23. **Status:** design; no code written under it.
**Sits alongside:** [`2026-08-22-blaze-v4-spine-design.md`](2026-08-22-blaze-v4-spine-design.md).
**Blocks:** specs 2 (agile execution), 3 (Gantt / critical path), 4 (hierarchy reporting).

A project owns N named, configured view instances. The installation keeps its own set —
the existing six. This spec settles the record, its storage, its config shape and
validation, the migration, and the URL and CLI surface, so specs 2–4 can be written
against something instead of around it.

**Reconciled with the sibling kernel spec** ([`2026-08-23-scheduling-kernel-design.md`](2026-08-23-scheduling-kernel-design.md),
BLZ-360) after both were written in parallel without sight of each other. Five points where the two
disagreed are now decided identically in both files, each recording which spec yielded and why:
the ADR number (Appendix A), the schema-installation event and the `view` table's home (§6.2), the
`project_key = '*'` sentinel (§3.3), the two different `link_type` tables (§4.4), and the
`start_date`/`due_date` question this spec had left open (§10.2).

---

## 0. What is already decided, and is not reopened here

**Operator decision, 2026-08-23:** *views belong to a project, AND an install-level set is
kept.* Both exist, clearly separated.

| Level | Views | Spans |
|---|---|---|
| **Installation** | the existing six — `board`, `list`, `live`, `metrics`, `map`, `gantt` | all projects (11 today) |
| **Project** | named instances the operator creates | that project only |

Rejected, and not re-argued below: **project-only** (loses the cross-project overview, or
forces a synthetic all-projects pseudo-project) and **views-span-any-set** ("which project
owns this view" stops having an answer, which complicates permissions later).

**ADR-0014's ruling is untouched.** Database-per-tenant; row-level shared schema
permanently ruled out. Everything in §2 is *terminology*. Nothing in §3 requires rows from
two installations to coexist, and §4 states the test that proves it.

---

## 1. Ground truth — what a "view" actually is today

Verified against the working tree, not assumed. **Three of the ticket's premises are wrong,
and one of them changes the design.**

### 1.1 A view is a case label plus a boolean

| Fact | Location |
|---|---|
| The six are a flat boolean map in engine defaults | `scripts/config.mjs:39` |
| Merged from `blaze.config.json`, non-object ignored | `scripts/config.mjs:64` |
| `board` force-enabled after the merge | `scripts/config.mjs:65` |
| The legal names are a hardcoded array | `scripts/views/page.mjs:68` — `VIEW_NAMES` |
| Dispatch is a `switch` over that array | `scripts/views/page.mjs:47-67` — `renderView()` |
| The clamp is re-applied twice more in the view layer | `scripts/views/page.mjs:113`, `:145` |

So **a view today has no identity, no name, and no configuration.** It is a renderer module
reached by a string, gated by a boolean. There is nothing to give three Gantts.

### 1.2 The config a view instance needs already exists — as a query string

`pageHtml()` and `viewEnvelope()` take `{ project, focus, flat, sprint, view }`
(`page.mjs:108`, `:129-139`), fed straight from the URL at `serve.mjs:202-206`. The status
chips resolve through `model/filters.mjs:statusFilter()`. Those parameters *are* the
per-view configuration; they are simply thrown away on every request.

**This is the single most useful thing in the codebase for this design.** A saved view and a
URL are the same object at two different lifetimes, and §5 invents almost no new keys.

### 1.3 The terminology collision is three-way, not two-way

The ticket says *"'board' is already one view among six."* True, and incomplete.
`scripts/model/boards.mjs` — `deriveBoards()` — groups workflows into **N boards per
installation**, each with its own column set, rendered as board pills at `page.mjs:156`.

So `board` today means, simultaneously:

1. the **tenancy unit** — ADR-0014: *"One installation is one board"*;
2. the **kanban view type** — `VIEW_NAMES[0]`, `views/board.mjs`;
3. a **workflow-derived column grouping**, of which one installation already has several.

**ADR-0014's "one installation is one board" was already not literally true in the render
layer on the day it was written.** Meaning (3) is the one that makes "a project owns N
boards" unwritable: the installation already owns N boards, derived from workflows, and
they are a different thing. This is why §2 retires the word rather than redefining it.

### 1.4 What the v4 schema actually contains — ADR-0014's description is wrong in three ways

ADR-0014:12 says *"`board`, `board_config`, `projection_meta` and the two write-rules tables
are all `id integer PRIMARY KEY CHECK (id = 1)`"*. The ticket says a grep found only
`projection_meta`. **Both are wrong.** Four distinct singleton tables exist:

| Table | Declared at |
|---|---|
| `blaze_config.board` | `scripts/model/config-schema.mjs:87` |
| `blaze_config.config_version` | `scripts/model/config-schema.mjs:99` |
| `projection_meta` | `scripts/model/projection-schema.mjs:28` |
| `migration_mode` | `scripts/model/write-rules.mjs:69` (sqlite) and `:119` (postgres) — **one table, declared once per dialect** |

ADR-0014 therefore names a table that has never existed (`board_config`), omits one that
does (`config_version`), and counts `migration_mode` twice as "the two write-rules tables".
Corrected in Appendix B.

### 1.5 Views are already a DB-resident blob hanging off the installation singleton

`blaze_config.board` carries **`views_json text NOT NULL DEFAULT '{}'`**
(`config-schema.mjs:93`). The boolean map already has a home in the database, attached to
the `CHECK (id = 1)` installation row. §6's migration reads it rather than re-deriving from
`blaze.config.json`.

### 1.6 `blaze board` silently swallows arguments

`cli.mjs:31` classifies `board` with `noArgs: true`, and `cli.mjs:94` is
`node(sub.file, sub.noArgs ? [] : rest)`. `blaze board BLZ` today exits 0 and ignores
`BLZ`. Not an error — a silent drop. Anything in §7 that adds an argument must flip that
flag first, and until it is flipped `blaze board <KEY>` must not be documented anywhere.

---

## 2. The tenancy word: **installation**

The tenancy unit is an **installation**; `install` in identifiers.

**Why not the alternatives:**

| Candidate | Refused because |
|---|---|
| `workspace` | already taken twice in adjacent work — `workspace_ref` in the agent-run schema (`2026-08-23-agent-driven-execution-design.md:103`), and the operator's own git-worktree practice (`plans/2026-08-22-blaze-v4-spine-execution-ledger.md:307`). Fixing a collision with a colliding word. |
| `instance` | collides with **view instance**, the central noun this spec introduces. |
| `tenant` | the word ADR-0014 exists to rule out. |
| `site` | implies a deployment URL, which is ADR-0012's territory. |

**Why `installation` wins:** it is already the word the ADR corpus uses in prose. ADR-0012's
*title* is "How an installation **selects, verifies and stores** its database"; ADR-0014's own decision
sentence is "one installation is one board". Adopting it introduces nothing — it **promotes
a word already in informal use into the structural slot "board" wrongly occupies**. The
rename is a deletion, not an addition.

### 2.1 What "board" means afterwards: exactly one thing

A **board is a kanban view type.** That meaning survives untouched. Everything else moves:

| Today | Means | Becomes |
|---|---|---|
| "one installation is one board" (ADR-0014:14) | tenancy unit | installation |
| `blaze_config.board` table | installation config singleton | `blaze_config.installation` |
| `cfg.boardTitle` (`config.mjs:15`) | display name | `installationTitle`; `boardTitle` retired via `REMOVED_KEYS` |
| `blaze board` (`cli.mjs:31`) | serve the web UI | `blaze serve`, with `board` kept as a permanent alias |
| `deriveBoards()` / board pills (`model/boards.mjs`, `page.mjs:156`) | workflow-derived column groupings | `deriveColumnSets()` / `column_set` — the "Delivery / Risk" pills |
| `boardModel()` (`views/data.mjs:24`) | the read model behind board, list, map **and** metrics | `itemModel()` — it was never board-specific |
| `views.board`, `VIEW_NAMES[0]`, `views/board.mjs` | the kanban renderer | **unchanged** |

**Cost, stated:** 430 occurrences of "board" across 77 `.mjs` files under `scripts/`, plus **49**
doc files under `docs/` (51 including the two root `.md` files). Most
are prose or meaning (2), which is correct and must survive.

**Therefore the rename is per-meaning, never global.** A single `sed s/board/installation/g`
would corrupt the one meaning that is right, and would do so silently — the repo has already
been bitten by half-applied chained substitutions. One ticket per row of the table above,
each landing with the tests that name the old word.

---

## 3. The record

One table. Ownership is a **discriminated union with an explicit tag**, not a nullable
column read for its NULL-ness.

```sql
CREATE TABLE view (
  id           text    PRIMARY KEY,
  scope        text    NOT NULL CHECK (scope IN ('installation','project')),
  project_key  text,                                  -- NULL iff scope = 'installation'
  type         text    NOT NULL,
  name         text    NOT NULL,
  slug         text    NOT NULL,
  ord          integer NOT NULL DEFAULT 0,
  is_builtin   <bool>  NOT NULL DEFAULT <false>,
  enabled      <bool>  NOT NULL DEFAULT <true>,
  config_json  <json>  NOT NULL DEFAULT <'{}'> CHECK (<jsonIsObject(config_json)>),
  created_at   <ts>    NOT NULL,
  updated_at   <ts>    NOT NULL,
  CHECK ( (scope = 'installation' AND project_key IS NULL)
       OR (scope = 'project'      AND project_key IS NOT NULL) ),
  FOREIGN KEY (project_key) REFERENCES blaze_config.project (key) ON DELETE CASCADE,
  FOREIGN KEY (type)        REFERENCES blaze_config.view_type (name)
)<tbl>;

CREATE UNIQUE INDEX view_slug_project ON view (project_key, slug) WHERE scope = 'project';
CREATE UNIQUE INDEX view_slug_install ON view (slug)              WHERE scope = 'installation';
```

`<bool>`, `<json>`, `<ts>`, `<tbl>`, `<jsonIsObject>` are the existing tokens from
`scripts/model/sql-dialect.mjs` — no new dialect divergence, and ` STRICT` arrives on SQLite
by the same route as every other table.

### 3.1 Why a tag, and the rule that makes it hold

The ticket's requirement is that a nullable owner must not accidentally mean two things.
The tag is the answer, but only if it is honoured:

> **`project_key` is never interpreted without `scope`. No query in the codebase may say
> `WHERE project_key IS NULL`; it says `WHERE scope = 'installation'`.**

That is a written rule with a grep test, not a convention. The `CHECK` makes the two columns
inseparable at the store; the rule makes them inseparable at the call sites.

### 3.2 The `NULL`-in-`UNIQUE` trap, and why the index is partial

A naive `UNIQUE (project_key, slug)` **would not work.** On both SQLite and Postgres, `NULL`
is distinct in a unique index, so two installation views could both be slugged `gantt` and
the constraint would permit it. The two partial indexes above are the fix, and they are also
the reason this section exists: it is exactly the kind of defect that ships green.

**Measured, on `node:sqlite` (SQLite 3.53.3 under Node 24), not asserted from documentation.**
Four cases, run against the exact DDL above:

| Case | Result |
|---|---|
| Naive `UNIQUE (project_key, slug)`, two installation rows both slugged `gantt` (`project_key` NULL) | **accepted both** — the trap is real, not theoretical |
| Partial `view_slug_install`, same two rows | refused: `UNIQUE constraint failed: v.slug` |
| Partial `view_slug_project`, two `BLZ` rows both slugged `gantt` | refused: `UNIQUE constraint failed: v.project_key, v.slug` |
| Same slug `gantt` under `BLZ` and under `OBA` | accepted, which is correct |

The `CHECK` pairing `scope` with `project_key` was exercised in the same run and refuses
`('installation','BLZ')`. So the DDL as written does what §3 claims on the SQLite side.

**And the pattern is already in this repo**, which the first draft of this section missed:
`hierarchy-schema.mjs:38-42` solves the identical NULL-distinct trap with a partial unique index,
and its comment already says *"NULLs compare distinct under UNIQUE in both engines… Both SQLite and
Postgres support partial indexes."* This section is applying an existing house solution, not
inventing one.

**What is still owed:** the Postgres half. This repo's own precedent is that 32 conformance
assertions missed a Postgres date bug because not one compared a date value, so the two-engine
conformance test still gates the DDL — but it is now confirming a measured SQLite result rather
than testing an assumption on both sides. Narrowed accordingly in §11.3.

### 3.3 Rejected shapes

| Shape | Refused because |
|---|---|
| **Sentinel `project_key = '*'`** (as in `membership.scope_key`, `identity-schema.mjs:61`, and the six `scope` columns seeded from `BOARD_SCOPE`, `config-schema.mjs:33`) | **destroys the FK to `blaze_config.project (key)` — `'*'` is not a project.** That is the whole argument and it is sufficient: the `view` table declares `FOREIGN KEY (project_key) REFERENCES blaze_config.project (key) ON DELETE CASCADE`, and adopting the sentinel means deleting that FK and re-implementing referential integrity in application code. See the correction immediately below — an earlier draft argued this from "a third sentinel" instead, which was wrong on the facts. |
| **A synthetic `__ALL__` project row** | explicitly rejected by the operator as the "synthetic all-projects pseudo-project". |
| **Two tables, `installation_view` + `project_view`** | every consumer — switcher, router, renderer, validator — then UNIONs and duplicates its rules. The union is one table and one `CHECK`. |
| **Nullable `project_key` with no tag** | the thing the ticket flagged. `NULL` would mean both "installation-owned" and "owner not yet set", and nothing would stop the second from existing. |

**Correction, and a cross-spec collision decided in both files.** An earlier draft of the first row
added a second argument — *"`'*'` already carries two different sentinel meanings here… minting a
third sentinel to fix a terminology collision is the mistake this ticket exists to stop."* **That
argument is withdrawn, because it is wrong twice over.** `'*'` is not two meanings plus a proposed
third: `BOARD_SCOPE = "*"` at `config-schema.mjs:33` is *one* established meaning —
*installation-wide, not per project* — already seeded to six columns (`workflow.scope`,
`workflow_status.scope`, `workflow_transition.scope`, `ticket_type.scope`, `type_parent.scope`,
`type_required_field.scope`, at `:236-270`). Using it in a seventh place is reuse, not minting.

This mattered because the sibling kernel spec in this PR — BLZ-360,
[`2026-08-23-scheduling-kernel-design.md`](2026-08-23-scheduling-kernel-design.md) §13.1 — **proposes
exactly this sentinel** for `link_type.project_key`, so the two specs forbade and proposed the same
thing. **The resolution, recorded identically in both files, is a rule rather than a preference:**

> **`'*'` is legal in a scope column on a config/meta table, and illegal in an owner column that
> carries a foreign key to `blaze_config.project (key)`.**

`link_type` (`link-schema.mjs:29-44`) declares no FK to `project` and is a meta table seeded from
code constants, exactly like the six columns `BOARD_SCOPE` already serves — so the sentinel is
legal there. `view.project_key` has the FK — so it is illegal here, and the `scope` tag stands.

**Each spec yields the half it was wrong about.** This spec yields the *principle* (scope sentinels
are not a mistake, and this one is not new) and keeps the *outcome* (no sentinel in `view`), which
the FK decides on its own. BLZ-360 §13.1 yields its claim that the sentinel would be **new**.

---

## 4. Storage, and how it complies

### 4.1 ADR-0014 — no discriminator

There is no `tenant_id`, no `installation_id`, no `board_id`, and no column that identifies
*which* installation a row belongs to. **`scope` is not a discriminator**, and the test that
distinguishes them is decisive: a discriminator takes one value per installation and grows
without bound; `scope` takes exactly two values, forever, and they name a *level of ownership
inside one installation*. Projects already coexist in one installation's database
(`blaze_config.project`); a view owned by a project is the same kind of row as a ticket owned
by a project.

**The falsification test ADR-0014 asks for:** does this design still make sense at N = 1
installation? Yes — it is *only* written for N = 1. Nothing here would gain meaning from a
second installation's rows being present, and nothing would need a predicate added.

### 4.2 ADR-0018 — the shape, deliberately not the machinery

`config_json` follows ADR-0018's **hybrid shape**: typed columns for everything the engine
queries or constrains (`scope`, `project_key`, `type`, `slug`, `enabled`, `ord`,
`is_builtin`), a JSON tail for the per-type config, with a real `CHECK` on the tail — the
benchmark's refuted-assumption #2 ("JSON means app-level validation only. False.").

**But view config is explicitly excluded from ADR-0018's promotion machinery.** No
`ALTER TABLE ADD COLUMN` promotion, ever, for a view config key.

Stated plainly because a reviewer will otherwise demand it: ADR-0018's promotion rule exists
for *user-defined* custom fields on a *100k-row* item table, where a filter without an index
is a table scan. The `view` table holds tens of rows, its config keys are defined by the
**engine** per view type rather than by users, and nothing filters items by a view's config.
Promotion would spend the install-wide 200-filterable-field budget on a table that cannot
benefit from it. The budget belongs to `artifact` and `ticket`.

### 4.3 ADR-0011 — no new required runtime dependency

Validation (§5.3) is a hand-written pure module, `scripts/model/view-config.mjs`, in the
shape of `model/sprints.mjs:validateSprintFields()` and `model/field-validation.mjs`:
a declared key table, a loop, an array of error strings. **No JSON Schema library.** The
repo's zero-dependency count is unchanged.

### 4.4 `view_type` is a seeded table, matching the existing pattern

`blaze_config.priority`, `blaze_config.resolution` and `blaze_config.link_type` are all
tables **seeded from code constants** (`config-schema.mjs:120-137`, seeded at `:226-232`).
`view_type` follows them exactly: seeded from the code registry (§5.1) at migrate time, so
`view.type` gets a real FK and a real refusal rather than an application-layer string check.

**Which `link_type` — because there are two, and neither this spec nor its sibling noticed at first
draft.** `blaze_config.link_type` (`config-schema.mjs:131-137`) is `name text PRIMARY KEY`, no
`project_key`, seeded from `LINK_TYPES` + `INVERSE` in `links.mjs`. The v4 `link_type`
(`link-schema.mjs:29-44`) is a different table with a surrogate `id` and
`UNIQUE (project_key, name)`, seeded from `DEFAULT_LINK_TYPES`. **The precedent cited here is the
first one** — installation-wide, code-seeded, one row per name — which is the shape `view_type`
wants. BLZ-360 §5.3 and §13.1 build on the **second**. They are not the same table and the two
specs are not citing the same precedent.

The honest gap, carried as open question §11.4: no constraint can express *"this type row has
a renderer module behind it"*. A type row whose module was deleted is a row that cannot
render. The registry-to-table seed is what keeps them in step, and it is a convention.

---

## 5. What a view type IS

Today: a `switch` case. It becomes a **declared type descriptor, in code**.

### 5.1 The registry

```js
// scripts/views/registry.mjs
{
  name: "gantt",
  label: "Gantt",
  scopes: ["installation", "project"],   // where this type may be instantiated
  instantiable: true,                     // may an operator create more than the builtin?
  configKeys: { /* §5.2 */ },
  render(model, config),
}
```

**The registry is code, not user data,** and that is the difference from the **v4** `link_type`
(`link-schema.mjs:29-44`), which is per-project and is a thing users define. A view type is a
renderer module — a row without a module cannot render, and a module without a row is invisible.
One source of truth, seeded into `view_type` per §4.4. (The `blaze_config.link_type` cited in §4.4
as the *table shape* precedent is code-seeded and installation-wide, which is why it is the right
shape and the v4 one is not.)

`scopes` is the mechanism that keeps the two levels genuinely separated: a type may declare
itself installation-only or project-only, and the registry is where that argument is
recorded rather than assumed. (See §11.1 — `live` is the live candidate.)

### 5.2 The config shape — a closed key set, in three tiers

**Tier 1 — universal, honoured by every type.** Every one of these exists today as a query
parameter or chip state. Nothing invented.

| Key | Type | Today |
|---|---|---|
| `focus` | ticket id \| null | `?focus=`, `model/focus.mjs:scopedRows` |
| `flat` | bool | `?flat=`, `views/data.mjs:24` |
| `statusFilter` | `all` \| `active` \| a status | `model/filters.mjs:statusFilter` |
| `types` | array \| null | chip/type filtering |
| `labels`, `components` | array \| null | frontmatter fields |
| `assignee` | string \| null | frontmatter field |

`project` is deliberately **not** a config key — it is the `scope`/`project_key` pair. A view
cannot re-scope itself out from under its owner.

**Tier 2 — per type. Illustrative, each spec owns its own row, and — unlike tier 1 — most of these
keys are *proposed here*, not lifted from something that exists.** Marked so, because §8.4 depends
on the distinction:

| Type | Keys | Provenance |
|---|---|---|
| `board` | `columnSet`, `swimlaneBy`, `cardFields` | `columnSet` is **this spec's own rename** of `deriveBoards()`'s output (§2.1) — it does not exist under that name today. `swimlaneBy` and `cardFields` are **new**. |
| `list` | `columns`, `sortBy` | `columns` exists in `blaze.config.json` (`config.mjs:16`) as the status-column list — a different meaning, reused here. `sortBy` is **new**. |
| `gantt` | `sprint`, `dateSource`, `showCriticalPath`, `groupBy`, `hierarchy` | `sprint` exists (`?sprint=`, `gantt.mjs:57-58`). `hierarchy` is specified by v4 spine §3.3. `dateSource`, `showCriticalPath`, `groupBy` are **new** — see §10.2 for what BLZ-360 does to `dateSource`. |
| `metrics` | `window`, `transitionsSince` | both **new**; `metricsModel` takes `transitions` and `now` but neither key exists. |
| `map` | `linkTypes`, `depth` | both **new**; `graphModel` takes `focus` only. |
| `live` | `pollSec` | **new**; `live.render()` takes no arguments at all (`views/live.mjs:3`). |

The tier-2 set being mostly new is not a defect — a view type's config is exactly the thing this
spec exists to invent. It is recorded because §8.4 originally claimed the opposite.

**Tier 3 — unknown keys are refused, not ignored.** This is the direct descendant of
`REMOVED_KEYS` in `scripts/model/schema-version.mjs`, which already rules that *"a config key
nothing reads is a promise the software does not keep."* Same rule, moved to write time: an
unrecognised key in `config_json` is a validation error that names the key and lists the
type's legal keys.

### 5.3 Validation — and where each rule lives

Per v4 spine §4.5, **enforcement is in the API layer**, below HTTP. A view created through
the API and one created through the UI hit the same validator, and the tests exercise it
through the API.

Split by ADR-0015's test — *blocks at write time only if decidable from the item alone AND
true of a legitimate draft*:

| Write-time block | Because |
|---|---|
| unknown `type` | decidable; never legitimate |
| unknown config key | decidable; §5.2 tier 3 |
| wrong config value type / outside enum / out of range | decidable |
| `scope` not in the type's declared `scopes` | decidable |
| `slug` format, and uniqueness within its scope | decidable; §3.2 |
| `project_key` naming a project that does not exist | FK; decidable |

| Advisory, never blocking | Because |
|---|---|
| `focus` naming a ticket that does not exist **now** | the ticket can be deleted *after* the view is saved. Blocking at write time would not stop it, and blocking at read time would make a saved view retroactively invalid. Render an empty view with a named reason — never a 500, never a silent empty. |
| `sprint` naming a sprint no longer in the registry | same shape; `sprints.json` is data, re-read per render (`model/sprints.mjs`, ADR-0004) |

Every refusal **names the rule and the offending key**, per v4 spine §4.2.

---

## 6. Migration — exactly what happens

### 6.1 An existing `blaze.config.json` carrying `views: {...}`

**It keeps working, unchanged, with no warning and no error, for the whole of v3.**
`config.mjs:39`, `:64` and `:65` do not change. No `schemaVersion` bump. **A board that never
creates a project view never notices this spec exists.**

### 6.2 The six become installation-scoped rows — at DB schema version 2

**Corrected, and it resolves a collision that left this table with no installation path at all.**
An earlier draft of this section declined the schema-installation event, on the grounds that *"v4
spine §6 already makes the Phase 2 db-primary cutover the prerequisite for every new v4 table."*
**It does not.** Spine `:265-267` states that prerequisite for the **document/artifact** migration
specifically, and gives a rationale that is specific to it: *"A document has no status directory to
live in, so the fs write port cannot represent this model."* That is true of `document`, and false
of `view` — a view row is representable on either write port. The deferral was an over-read of one
line.

Meanwhile the sibling kernel spec in this PR — BLZ-360,
[`2026-08-23-scheduling-kernel-design.md`](2026-08-23-scheduling-kernel-design.md) §6.4 — **claimed**
the schema-installation event, because `Precedes` needs the v4 `link` table and nothing installs it.
One spec claiming the event and the other declining it meant `view` had no create path in either.

**Resolution, recorded in both files: BLZ-360 §6.4 owns DB schema version 2, and `viewDdl` ships in
it.** This spec yields the installation event; it keeps every other decision about the table —
the columns, the `scope` tag, the two partial unique indexes, the `CHECK`, the `view_type` FK and
the seeded registry are all §3's and §4's and are unchanged. What changes is only *when the DDL
runs*: `DB_SCHEMA_VERSION` 1 → 2, alongside `linkDdl`, `hierarchyDdl` and BLZ-360's five `ticket`
columns. `artifactDdl` / `documentDdl` / `fieldDdl` stay behind the Phase 2 cutover, which is what
spine `:265-267` actually gates.

**This does not weaken §6.1.** An existing `blaze.config.json` carrying `views: {...}` keeps working
unchanged through v3 regardless of when the table is installed; the seed below runs when the
database becomes the source of truth for views, and the two events are separable.

The seed reads **`blaze_config.board.views_json`** (`config-schema.mjs:93`) — which already
holds this map in the database — and emits six rows:

```
scope        = 'installation'
project_key  = NULL
type         = <name>                     -- from VIEW_NAMES, in order
name         = <Label>                    -- "Board", "List", …
slug         = <name>
ord          = <index in VIEW_NAMES>      -- preserves today's switcher order
is_builtin   = true
enabled      = <the boolean from views_json, default true>
config_json  = '{}'
```

`views: { map: false }` becomes `enabled = false` on the `map` row. Order is preserved from
`VIEW_NAMES`, so the switcher renders identically.

**The `board` clamp becomes one rule instead of three.** `cfg.views.board = true` is
currently re-asserted in three places — `config.mjs:65`, `page.mjs:113`, `page.mjs:145` —
which is itself a finding. It becomes a single store-level invariant: **the builtin
installation `board` row may not be deleted or disabled.** Its intent (the shell always has a
default view) is kept; its triplication is not.

### 6.3 `views: {...}` is retired one schema version later, by the mechanism that exists

Add `views` to `REMOVED_KEYS` in `scripts/model/schema-version.mjs`:

```
views: "views are rows now — `blaze view list --installation`. Your six were migrated
        at the db-primary cutover; delete this key."
```

and raise `MIN_SCHEMA_VERSION` past the current `SCHEMA_VERSION = 2` — the **config** schema
version in `schema-version.mjs`, which is a different number from the `DB_SCHEMA_VERSION` of §6.2.
That produces a
**hard, named error carrying its own fix** — precisely what `REMOVED_KEYS` was built for
(BLZ-298) — rather than a silent drop, which is the behaviour it was built to stop.

### 6.4 How the migration is proven

Per v4 spine §6 and §7.2: a **zero-diff oracle**. Render all six views on the live
11-project board before and after the cutover and diff the HTML. That is the method that
caught six data-loss defects in the v3 corpus migration, and it caught them by running
against real data rather than fixtures.

---

## 7. The URL and CLI surface

### 7.1 Today, verified

- `GET /?view=&project=&focus=&flat=&sprint=` → full page (`serve.mjs:201-211`; the five parameters are read at `:202-206`)
- `GET /view/<name>` → JSON envelope for the client-side swap (`serve.mjs:187-198`)
- `blaze board` → `serve.mjs`, arguments silently discarded (`cli.mjs:31`, `:94`)

### 7.2 After

| Route | Serves |
|---|---|
| `GET /` | the installation's default view — the builtin `board` row. **Unchanged for every existing user.** |
| `GET /v/<slug>` | an installation view |
| `GET /p/<KEY>` | that project's default view (lowest `ord`; else the installation board scoped to that project) |
| `GET /p/<KEY>/v/<slug>` | a project view |
| `GET /view/<slug>`, `GET /p/<KEY>/view/<slug>` | the JSON envelope, **same shape as today** |
| `?view=`, `?project=`, `?focus=`, `?flat=`, `?sprint=` | **kept, permanently** |

The query parameters are kept not for compatibility but because they are load-bearing:
**they are an unsaved view.** "Save this as a view" is literally *take the current query
string, validate it as `config_json`, insert a row* — and conversely, opening a saved view
sets those parameters. Every existing bookmark keeps working, and the feature ships with a
one-click origin story instead of a new form.

### 7.3 What `blaze board` means afterwards

**`blaze board` keeps working and keeps serving the installation.** It becomes a permanent
alias for `blaze serve`. Nothing an operator types today breaks.

New verb `blaze view`, as its own `view-runner.mjs` matching every other verb's shape:

```
blaze view list  [--project KEY | --installation]
blaze view new   --type gantt --name "Q3 schedule" [--project KEY] [--set k=v …]
blaze view edit  <slug> [--project KEY] --set k=v
blaze view rm    <slug> [--project KEY]
blaze view open  <slug> [--project KEY]               # prints the URL
blaze serve      [--project KEY] [--view <slug>]
```

**`mutates` is classified per verb, not per subcommand — corrected.** An earlier draft annotated
`view list` and `view open` as `mutates: false` beside a mutating `view new`/`edit`/`rm`. That
split is not expressible today: `mutates` is a property of the `SUBCOMMANDS` entry
(`cli.mjs:27-51`), and `cli.mjs:89` refuses to **spawn** the runner under `BLAZE_READONLY` before
any argument is parsed. There is exactly one flag per verb.

**Decision: `blaze view` is classified `mutates: true` unconditionally**, following the precedent
the dispatch table already sets and states — `reconcile` defaults to a dry run but `--apply`
commits, and `cli.mjs:21-26` classifies it *"true unconditionally (simpler and safer than
flag-dependent classification)"*. The cost is real and small: under `BLAZE_READONLY=1`,
`blaze view list` is refused even though it writes nothing. **Whoever wants read-only listing under
`BLAZE_READONLY` must change the dispatch table** — either a per-subcommand `mutates` map (a real
change to `cli.mjs`'s single-lookup shape) or a separate read-only verb. That is a decision for the
CLI, not something a view spec can assert by annotating a code block.

**Precondition:** `blaze serve --project KEY` requires flipping `noArgs` at `cli.mjs:31`.
Until that lands, `blaze board BLZ` exits 0 and ignores the argument (§1.6) — so it must not
appear in any doc, help text or example before the flag changes.

---

## 8. Specs 2–4 expressed as view instances — the falsification test

If the three cannot be expressed as `(type, name, config)` rows, the model is wrong.

### 8.1 Spec 2 — agile execution is a sprint board

```
scope='project'  project_key='BLZ'  type='board'
name='Team A sprint'  slug='team-a-sprint'
config: { columnSet: 'delivery', statusFilter: 'active', sprint: 'S14',
          swimlaneBy: 'assignee', types: ['task','bug','story'], labels: ['backend'] }
```

Three teams in one project = three rows differing only in `labels`/`assignee`. **Passes.**

**What it exposes, which is spec 2's to fix and not this spec's:** sprints are a registry at
the *data root* — `sprints.json`, `model/sprints.mjs` — with a **single global `active`
pointer**. A per-project sprint board wants a per-project active sprint. Real gap, named here
so spec 2 finds it on day one rather than late.

### 8.2 Spec 3 — Gantt / critical path is a schedule view

```
scope='project'  project_key='BLZ'  type='gantt'
name='Delivery schedule'  slug='delivery'
config: { dateSource: 'derived', showCriticalPath: true, groupBy: 'hierarchy',
          hierarchy: 'default', statusFilter: 'all' }
```

Two Gantts with different filters = two rows. **Passes.**

**What it exposes, updated for the sibling spec that landed in the same PR:** the *other* kernel
question the ticket names — are `start_date` / `due_date` inputs or derived outputs? — surfaced here
as a single config key, `dateSource`. **BLZ-360 has since answered it: constraints are inputs, dates
are derived, always.** The separability evidence stands (the two kernel questions really were
answerable independently), but the consequence for this spec has changed — see §10.2. `dateSource`
is now a closed key set with one legal value, which is a key that decides nothing.

**Second exposure, also from the sibling spec:** the `sprint` key listed for `gantt` in §5.2 is
today's mechanism (`gantt.mjs:57-58` scopes rows to the selected sprint and builds its axis from
that sprint's window), and BLZ-360 §8.2 states that a critical-path Gantt **cannot** be sprint-shaped
— a zero-float chain crosses sprints and crosses projects. So `gantt` needs a second, mutually
exclusive axis key. This spec keeps `sprint` (it is what the renderer does today and it must keep
working) and records the conflict rather than resolving it; §10.2 carries it.

### 8.3 Spec 4 — hierarchy reporting is a report view

```
scope='project'  project_key='BLZ'  type='report'
name='Goal rollup'  slug='goal-rollup'
config: { hierarchy: 'safety', rootTypes: ['goal'], depth: 3,
          columns: ['id','title','status','estimate','logged','rollup.estimate'],
          rollupDuplicates: 'exclude', export: 'xlsx' }
```

**This one strains, and saying it passes would be dishonest.** Two things it needs do not
exist:

1. **`report` is a seventh view type with no renderer.** There is no `scripts/views/report.mjs`.
   Every instance in §8.1 and §8.2 reuses an existing module; this one does not. The registry
   is designed to be extended, so the *model* holds — but the model is **verified** against
   two specs and only **structurally plausible** for the third.
2. **`hierarchy` is v4 spine §3.3 and is not built.** `rollupDuplicates: 'exclude'` is that
   section's rule ("rollup must exclude duplicates by default").

Also worth flagging outside this spec's scope: `export: 'xlsx'` collides with ADR-0011 — an
xlsx writer is a runtime dependency. Spec 4's problem, but it should not be discovered inside
spec 4.

**Verdict:** the view model is not the risk for spec 4. The renderer and the hierarchy table
are.

### 8.4 What the test actually proved — restated honestly

An earlier draft of this section claimed: *"Every config key above maps to something that already
exists … No key was invented to make the model work. That is the test passing rather than being
satisfied."* **That claim is false, and §8.3 already models the right tone for saying so —
"this one strains, and saying it passes would be dishonest."** The same standard applies here.

**Keys used in §8.1–§8.3 that do not exist anywhere in `scripts/`:** `swimlaneBy`,
`showCriticalPath`, `dateSource`, `rootTypes`, `cardFields`, `pollSec`, `transitionsSince` — seven,
verified by grep. And `columnSet` was listed as existing when it is **this spec's own proposed
rename** of `deriveBoards()` (§2.1); it exists as a concept, under a different name, only because
this spec renames it.

**What is genuinely pre-existing** is the tier-1 set and a small tail: `focus`, `flat` and `sprint`
(live query parameters, read at `serve.mjs:202-206`), `statusFilter`
(`model/filters.mjs:statusFilter`), and the chip/type/label/component/assignee filters. **What is
specified but unbuilt:** `hierarchy` and `columns` (v4 spine §3.3), and `rollupDuplicates`, which
is that section's rule — *"Rollup must exclude duplicates by default"* (spine `:107`) — spelled as
a key here for the first time. **What is invented here:** the eight above, plus `sortBy` and
`groupBy`, which appear nowhere in `scripts/`, and `linkTypes` / `depth` / `window`, which appear
in `scripts/` only as unrelated identifiers in other modules and are new *as view config*.

**So what did the test actually establish?** Something weaker than the earlier claim and still
worth having:

1. **The record shape holds.** All three specs are `(scope, project_key, type, name, config)` rows
   differing only in `config`. No spec needed a second table, a nullable owner, or a column the
   others do not use. **That is what §8 set out to falsify, and it survived.**
2. **The universal tier is real.** Tier 1 was derived from live query parameters, not designed —
   that half of §5.2 is evidence, not invention.
3. **The per-type tier is design, not discovery.** Most tier-2 keys are proposed here for the first
   time (§5.2 marks each one), which is legitimate — a view type's configuration is precisely what
   this spec exists to define — but it means the three examples cannot corroborate the key set.
   They were written by the same author, in the same week, from the same table.

**Verdict: satisfied, not passed.** The test discriminates on structure and it passed on structure.
It does not discriminate on the config vocabulary, because the vocabulary was largely written to
fit. The real test of the key set is spec 2, 3 and 4 being written by someone else and needing a
key §5.2 does not have — and §9 already carries that as a live risk ("config keys drift from what
renderers honour").

---

## 9. Risks

| Risk | Mitigation | Honest residual |
|---|---|---|
| The `board` rename half-applies and leaves the codebase in two vocabularies | per-meaning tickets (§2.1), each landing with the tests that name the old word; never a global substitution | 430 occurrences across 77 files; a partial rename is worse than none, and the window is real |
| `NULL`-distinct-in-`UNIQUE` lets two installation views share a slug | partial unique indexes (§3.2), the same fix `hierarchy-schema.mjs:38-42` already uses | **verified on `node:sqlite` 3.53.3** — both duplicate cases refused, the naive `UNIQUE` shown to accept them; Postgres still owed (§11.3) |
| Someone reads `project_key IS NULL` instead of `scope` | written rule plus a grep test (§3.1) | a convention with a test is still a convention |
| Per-project `metrics` views multiply an expensive recompute | measure before promising (§11.2) | unmeasured today |
| Config keys drift from what renderers honour | tier-3 closed key set, refused at write time (§5.2) | the registry and the renderer can still disagree; only a test catches it. Sharpened by §8.4: most tier-2 keys are proposed here, so the falsification test corroborates the *shape* and not the *vocabulary* |
| An operator creates 40 views and cannot find any of them | `ord`, and a default view per scope | no answer for search or grouping of views |

---

## 10. What this spec does NOT solve

Stated plainly, because several of these are things a reader will reasonably expect here.

1. **Permissions on views.** `membership.scope_key` (`identity-schema.mjs:61`) is the seam and
   is always `'*'` today. A project view is precisely the thing you would eventually scope a
   token to — and the operator's rejected option (views-span-any-set) was rejected *for*
   permissions reasons, so the expectation is fair. **There is no answer here.**
2. **`start_date` / `due_date` — inputs or derived outputs. Answered, by the sibling spec in this
   PR, and this entry is corrected rather than removed.** An earlier draft left it "open on
   purpose". BLZ-360
   ([`2026-08-23-scheduling-kernel-design.md`](2026-08-23-scheduling-kernel-design.md)) answers it:
   **constraints are inputs; `start_date`, `due_date`, float and the critical path are derived and
   never hand-set.** Two consequences land on this spec:

   - **`dateSource` (§5.2, §8.2) is now a closed key set with exactly one legal value.** A key whose
     enum has one member decides nothing. It is kept for one release rather than deleted, because
     the migration (BLZ-360 §4) leaves 28 terminal tickets carrying *frozen actuals* while every
     open ticket carries derived dates, and a Gantt has to be able to say which it is rendering —
     but it should be re-examined once that distinction lives on the row (`schedule_run_id`) rather
     than in a view's config. **Whoever writes spec 3 should expect to delete it.**
   - **`gantt`'s `sprint` key is not sufficient.** BLZ-360 §8.2 states that a critical-path view
     cannot be sprint-shaped — a zero-float chain crosses sprints and crosses projects — and needs
     a schedule-horizon axis instead. `sprint` stays (it is what `gantt.mjs:57-58` does today and it
     must keep working), so `gantt` will carry two mutually exclusive axis keys and a rule for
     which wins. **That rule is spec 3's and is not written here.**
3. **Per-project sprints.** Named in §8.1; spec 2's.
4. **Sharing or duplicating a view across projects.** A view has one owner, by the operator's
   decision. "Duplicate into project X" is a client-side copy producing a second row, not a
   shared row, and this spec does not design that UI.
5. **A per-user default view.** `localStorage.getItem("tracker.view")` (`page.mjs:172`) is
   today's per-browser memory. Whether a *user* has a default view is an identity-layer
   question (ADR-0013), not this one.
6. **Sequencing the rename.** §2.1 decides the word and enumerates what changes. It does not
   order 430 occurrences into tickets.
7. **A view-builder UI.** Configuration UI is out of scope in v4 spine §10 and stays out.
8. **Anything cross-installation.** Out by ADR-0014, permanently.

---

## 11. Open — could not be settled

1. **Does `live` belong at project scope?** `live.render()` takes **no arguments at all**
   (`views/live.mjs:3`) and `liveModel` streams installation-wide activity. Project-scoping it
   is a change to the model, not a config key. Until that is decided, `live` should declare
   `scopes: ["installation"]` and be the case that proves the `scopes` field earns its place.
2. **What does project-scoped `metrics` cost?** `renderView`'s metrics branch recomputes
   `boardModel(..., flat: true)` per render (`page.mjs:50-56`). Eleven per-project metrics
   views is 11× that compute. **Needs a measurement, not an assumption** — this repo's own
   rule.
3. **Partial unique indexes — narrowed to Postgres.** No longer open on SQLite: measured on
   `node:sqlite` 3.53.3 (§3.2), where the naive `UNIQUE (project_key, slug)` accepts two
   installation rows both slugged `gantt` and the partial-index DDL refuses both duplicate cases
   with the `CHECK` enforced. The repo already relies on the same construct at
   `hierarchy-schema.mjs:38-42`. **Still open:** the Postgres half, and the two-engine conformance
   test still gates the DDL — this repo's own precedent is 32 conformance assertions that missed a
   Postgres date bug because not one compared a date value.
4. **Seeded `view_type` table vs. code-only registry.** Recommending the seeded table for
   consistency with `priority` / `resolution` / `link_type`. The counter-argument stands: no
   constraint can express "this type has a renderer module", so the table is a convention with
   an FK attached.
5. **May builtin installation rows be deleted once project views exist?** Recommending
   undeletable-but-disableable, with `board` neither deletable nor disableable (§6.2). Not
   argued from evidence.
6. **Slug collision with a route segment.** `/v/<slug>` and `/p/<KEY>/v/<slug>` mean a slug
   like `p` or `api` is a routing hazard. A reserved-slug list is the obvious fix; it is not
   specified here.

---

## Appendix A — ADR-0021, draft

**Number collision with the sibling spec, resolved.** This spec and BLZ-360
([`2026-08-23-scheduling-kernel-design.md`](2026-08-23-scheduling-kernel-design.md) §12) were
written in parallel and each independently computed *"next free number; 0020 is the highest
present"*. Both claimed **ADR-0021**. **This spec keeps 0021; BLZ-360's becomes ADR-0022.** The
allocation rule is the lower ticket number, and here it also matches the dependency: ADR-0021 renames
the tenancy unit to **installation**, and ADR-0022's text has to be written in that vocabulary — it
cites ADR-0018's *"200 filterable fields per install"* and an installation-level schema event, both
of which read differently before 0021 lands. A number is only reserved once the file exists in
`docs/decisions/`; until then two parallel authors will always compute the same next-free number.

> **ADR-0021 — The tenancy unit is an installation; a board is a view type**
>
> **Status:** proposed · **Date:** 2026-08-23 · **Goal:** BLZ-354
>
> **Context.** `board` names three different things: the tenancy unit (ADR-0014:14), the
> kanban view type (`VIEW_NAMES[0]`), and a workflow-derived column grouping of which one
> installation already has several (`scripts/model/boards.mjs`). The operator's model —
> a project owns N named views — cannot be written in a vocabulary where the installation is
> already called a board and already owns several of them.
>
> **Decision.** The tenancy unit is an **installation**. `board` names **only** the kanban
> view type. Workflow-derived groupings become **column sets**. A **view** is a row owned
> either by the installation or by exactly one project, discriminated by an explicit `scope`
> tag rather than by a nullable owner.
>
> **This is terminology plus one new table. ADR-0014's ruling is unchanged and is restated
> here as unchanged:** database-per-tenant; row-level shared schema permanently ruled out;
> no table may assume rows from more than one installation coexist. The `view` table carries
> no tenant, board or installation discriminator, and `scope` is not one — it takes exactly
> two values forever and names a level of ownership *within* one installation.
>
> **Consequences.** 430 occurrences of "board" across 77 `.mjs` files under `scripts/` and 49 doc
> files are
> re-read per meaning; the one correct meaning survives untouched, which is why the rename is
> per-meaning and never a global substitution. `blaze board` survives as an alias.
> `blaze.config.json`'s `views: {...}` keeps working through v3 and is retired via
> `REMOVED_KEYS` afterwards.

## Appendix B — the ADR-0014 amendment, language only

**AC fidelity, flagged rather than silently exceeded.** BLZ-354 AC-2 constrains this amendment to
*"language ONLY — its ruling is explicitly restated as unchanged."* Edits 1 and 3 below are pure
language. **Edit 2 is not: it rewrites ADR-0014:12's singleton list on factual grounds** (§1.4 —
the ADR names `board_config`, a table that has never existed; omits `blaze_config.config_version`,
which does; and counts `migration_mode` twice as "the two write-rules tables"). It is kept, because
the correction is verified against the working tree and leaving a known-wrong sentence in an ADR to
satisfy a scope word would be the worse outcome — and because AC-3 independently requires that
*"what the v4 schema actually contains (vs ADR-0014's description of v3) is verified and recorded"*,
which is exactly what edit 2 records. But it **exceeds AC-2 as written**, it is a Context edit rather
than a Decision edit, and it should be approved as such rather than waved through as language.

Three edits. **The Decision, Consequences and "Revisit if" sections are not touched.**

1. **Line 14**, *"One installation is one board."* → *"One installation is one
   installation."* with a footnote: *"This sentence read 'one installation is one board'
   before ADR-0021. `board` now names only the kanban view type. The ruling below is
   unchanged."*
2. **Line 12**, the singleton list, is factually wrong (§1.4). *"`board`, `board_config`,
   `projection_meta` and the two write-rules tables"* → *"`blaze_config.board` (renamed
   `blaze_config.installation` by ADR-0021), `blaze_config.config_version`,
   `projection_meta` and `migration_mode` — four tables; `board_config` never existed, and
   `migration_mode` is one table declared once per dialect."*
3. **"What this obliges v4 to do now", item 1**, *"rows from more than one **board**
   coexist"* → *"rows from more than one **installation** coexist"*. Same obligation, no
   ambiguity about which of the three meanings is intended.
