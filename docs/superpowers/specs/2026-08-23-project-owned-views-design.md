# Project-owned views — design spec

**Goal:** BLZ-354. **Date:** 2026-08-23. **Status:** design; no code written under it.
**Sits alongside:** [`2026-08-22-blaze-v4-spine-design.md`](2026-08-22-blaze-v4-spine-design.md).
**Blocks:** specs 2 (agile execution), 3 (Gantt / critical path), 4 (hierarchy reporting).

A project owns N named, configured view instances. The installation keeps its own set —
the existing six. This spec settles the record, its storage, its config shape and
validation, the migration, and the URL and CLI surface, so specs 2–4 can be written
against something instead of around it.

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
| The clamp is re-applied twice more in the view layer | `scripts/views/page.mjs:111`, `:145` |

So **a view today has no identity, no name, and no configuration.** It is a renderer module
reached by a string, gated by a boolean. There is nothing to give three Gantts.

### 1.2 The config a view instance needs already exists — as a query string

`pageHtml()` and `viewEnvelope()` take `{ project, focus, flat, sprint, view }`
(`page.mjs:113`, `:130-143`), fed straight from the URL at `serve.mjs:206-211`. The status
chips resolve through `model/filters.mjs:statusFilter()`. Those parameters *are* the
per-view configuration; they are simply thrown away on every request.

**This is the single most useful thing in the codebase for this design.** A saved view and a
URL are the same object at two different lifetimes, and §5 invents almost no new keys.

### 1.3 The terminology collision is three-way, not two-way

The ticket says *"'board' is already one view among six."* True, and incomplete.
`scripts/model/boards.mjs` — `deriveBoards()` — groups workflows into **N boards per
installation**, each with its own column set, rendered as board pills at `page.mjs:158-163`.

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
*title* is "how an installation selects and stores its database"; ADR-0014's own decision
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
| `deriveBoards()` / board pills (`model/boards.mjs`, `page.mjs:158`) | workflow-derived column groupings | `deriveColumnSets()` / `column_set` — the "Delivery / Risk" pills |
| `boardModel()` (`views/data.mjs:24`) | the read model behind board, list, map **and** metrics | `itemModel()` — it was never board-specific |
| `views.board`, `VIEW_NAMES[0]`, `views/board.mjs` | the kanban renderer | **unchanged** |

**Cost, stated:** 430 occurrences of "board" across 77 `.mjs` files, plus 47 doc files. Most
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

**Not measured.** Partial unique indexes on `node:sqlite` are asserted from documentation.
This repo's own precedent is that 32 conformance assertions missed a Postgres date bug
because not one compared a date value — so this needs a conformance test on both engines
before the DDL is trusted. Carried as open question §11.3.

### 3.3 Rejected shapes

| Shape | Refused because |
|---|---|
| **Sentinel `project_key = '*'`** (matching `membership.scope_key`, `identity-schema.mjs:61`, and `workflow.scope`, `config-schema.mjs:33`) | destroys the FK to `blaze_config.project(key)` — `'*'` is not a project. And `'*'` already carries **two different** sentinel meanings here: identity's *"every scope"* and config's *"installation-wide, not per project"*. Minting a third sentinel to fix a terminology collision is the mistake this ticket exists to stop. |
| **A synthetic `__ALL__` project row** | explicitly rejected by the operator as the "synthetic all-projects pseudo-project". |
| **Two tables, `installation_view` + `project_view`** | every consumer — switcher, router, renderer, validator — then UNIONs and duplicates its rules. The union is one table and one `CHECK`. |
| **Nullable `project_key` with no tag** | the thing the ticket flagged. `NULL` would mean both "installation-owned" and "owner not yet set", and nothing would stop the second from existing. |

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
tables **seeded from code constants** (`config-schema.mjs:120-137`, seeded around `:233`).
`view_type` follows them exactly: seeded from the code registry (§5.1) at migrate time, so
`view.type` gets a real FK and a real refusal rather than an application-layer string check.

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

**The registry is code, not user data,** and that is the difference from `link_type`. A link
type is a thing users define. A view type is a renderer module — a row without a module
cannot render, and a module without a row is invisible. One source of truth, seeded into
`view_type` per §4.4.

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

**Tier 2 — per type.** Illustrative, and each spec owns its own row:

| Type | Keys |
|---|---|
| `board` | `columnSet`, `swimlaneBy`, `cardFields` |
| `list` | `columns`, `sortBy` |
| `gantt` | `sprint`, `dateSource`, `showCriticalPath`, `groupBy`, `hierarchy` |
| `metrics` | `window`, `transitionsSince` |
| `map` | `linkTypes`, `depth` |
| `live` | `pollSec` |

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

### 6.2 The six become installation-scoped rows — at the db-primary cutover, not before

v4 spine §6 already makes the Phase 2 db-primary cutover the prerequisite for every new v4
table. `view` inherits that prerequisite; it does not add one.

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
currently re-asserted in three places — `config.mjs:65`, `page.mjs:111`, `page.mjs:145` —
which is itself a finding. It becomes a single store-level invariant: **the builtin
installation `board` row may not be deleted or disabled.** Its intent (the shell always has a
default view) is kept; its triplication is not.

### 6.3 `views: {...}` is retired one schema version later, by the mechanism that exists

Add `views` to `REMOVED_KEYS` in `scripts/model/schema-version.mjs`:

```
views: "views are rows now — `blaze view list --installation`. Your six were migrated
        at the db-primary cutover; delete this key."
```

and raise `MIN_SCHEMA_VERSION` past the current `SCHEMA_VERSION = 2`. That produces a
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

- `GET /?view=&project=&focus=&flat=&sprint=` → full page (`serve.mjs:206-211`)
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

New verb `blaze view`, as its own `view-runner.mjs` matching every other verb's shape, with
`cli.mjs`'s `mutates` classification applied per subcommand:

```
blaze view list  [--project KEY | --installation]     # mutates: false
blaze view new   --type gantt --name "Q3 schedule" [--project KEY] [--set k=v …]
blaze view edit  <slug> [--project KEY] --set k=v
blaze view rm    <slug> [--project KEY]
blaze view open  <slug> [--project KEY]               # prints the URL; mutates: false
blaze serve      [--project KEY] [--view <slug>]
```

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

**What it exposes:** the *other* kernel question the ticket names — are `start_date` /
`due_date` inputs or derived outputs? — surfaces here as a single config key, `dateSource`.
That is useful evidence: it shows the two kernel questions are **separable**. This spec
defines the key's existence; spec 3 decides its legal values and its default. **This spec
does not answer it** (§10.2).

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

### 8.4 What the test actually proved

All three are `(type, name, config)` differing only in `config`. Every config key above maps
to something that **already exists** (`statusFilter`, `sprint`, `focus`, `flat`,
`columnSet`) or is **already specified** by the v4 spine (`hierarchy`, `rollupDuplicates`,
`columns`). **No key was invented to make the model work.** That is the test passing rather
than being satisfied.

---

## 9. Risks

| Risk | Mitigation | Honest residual |
|---|---|---|
| The `board` rename half-applies and leaves the codebase in two vocabularies | per-meaning tickets (§2.1), each landing with the tests that name the old word; never a global substitution | 430 occurrences across 77 files; a partial rename is worse than none, and the window is real |
| `NULL`-distinct-in-`UNIQUE` lets two installation views share a slug | partial unique indexes (§3.2) | unverified on `node:sqlite` (§11.3) |
| Someone reads `project_key IS NULL` instead of `scope` | written rule plus a grep test (§3.1) | a convention with a test is still a convention |
| Per-project `metrics` views multiply an expensive recompute | measure before promising (§11.2) | unmeasured today |
| Config keys drift from what renderers honour | tier-3 closed key set, refused at write time (§5.2) | the registry and the renderer can still disagree; only a test catches it |
| An operator creates 40 views and cannot find any of them | `ord`, and a default view per scope | no answer for search or grouping of views |

---

## 10. What this spec does NOT solve

Stated plainly, because several of these are things a reader will reasonably expect here.

1. **Permissions on views.** `membership.scope_key` (`identity-schema.mjs:61`) is the seam and
   is always `'*'` today. A project view is precisely the thing you would eventually scope a
   token to — and the operator's rejected option (views-span-any-set) was rejected *for*
   permissions reasons, so the expectation is fair. **There is no answer here.**
2. **`start_date` / `due_date` — inputs or derived outputs.** The other kernel question. It
   appears as `dateSource` (§8.2) and is left open on purpose.
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
3. **Partial unique indexes on both engines.** Asserted from documentation; unverified on
   `node:sqlite`. A conformance test on both engines gates the DDL (§3.2).
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
> **Consequences.** 430 occurrences of "board" across 77 `.mjs` files and 47 doc files are
> re-read per meaning; the one correct meaning survives untouched, which is why the rename is
> per-meaning and never a global substitution. `blaze board` survives as an alias.
> `blaze.config.json`'s `views: {...}` keeps working through v3 and is retired via
> `REMOVED_KEYS` afterwards.

## Appendix B — the ADR-0014 amendment, language only

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
