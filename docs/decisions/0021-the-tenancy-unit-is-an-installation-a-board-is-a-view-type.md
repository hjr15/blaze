# ADR-0021 — The tenancy unit is an installation; a board is a view type

- **Status:** accepted
- **Date:** 2026-08-23
- **Ticket:** BLZ-354 (design spec `docs/superpowers/specs/2026-08-23-project-owned-views-design.md`; transcribed to the corpus under BLZ-366)
- **Amends:** ADR-0014's *language* only — see "What this does NOT reverse".

## Context

`board` names three different things at once:

1. the **tenancy unit** — ADR-0014:14, *"One installation is one board"*;
2. the **kanban view type** — `VIEW_NAMES[0]`, `scripts/views/board.mjs`;
3. a **workflow-derived column grouping**, of which one installation already has several
   (`scripts/model/boards.mjs`, `deriveBoards()`, rendered as board pills at
   `scripts/views/page.mjs:156`).

The operator's model — *a project owns N named views* — cannot be written in a vocabulary where
the installation is already called a board and already owns several of them. Meaning (3) is what
makes "a project owns N boards" unwritable, and it is why this ADR retires the word rather than
redefining it.

**ADR-0014's "one installation is one board" was already not literally true in the render layer on
the day it was written.** `deriveBoards()` returns **4** for the live board — `delivery`,
`requirement`, `architecture`, `risk`. *(That count is not in BLZ-354's spec, which says only "N
boards per installation"; it comes from BLZ-362 and was re-measured on 2026-08-24 for this
transcription.)*

## Decision

The tenancy unit is an **installation**. `board` names **only** the kanban view type.
Workflow-derived groupings become **column sets**. A **view** is a row owned either by the
installation or by exactly one project, discriminated by an explicit `scope` tag rather than by a
nullable owner.

`installation` was chosen over `workspace` (already taken twice in adjacent work), `instance`
(collides with *view instance*), `tenant` (the word ADR-0014 exists to rule out) and `site`
(implies a deployment URL, ADR-0012's territory). It wins because **it is already the word the ADR
corpus uses in prose** — ADR-0012's title and ADR-0014's own decision sentence both use it. The
rename promotes a word already in informal use into the structural slot `board` wrongly occupies,
so it is a deletion rather than an addition.

## What this does NOT reverse

**ADR-0014's ruling is unchanged and is restated here as unchanged:** database-per-tenant;
row-level shared schema permanently ruled out; no table may assume rows from more than one
installation coexist.

The `view` table carries no tenant, board or installation discriminator, and **`scope` is not
one.** The test that distinguishes them is decisive: a discriminator takes one value per
installation and grows without bound; `scope` takes exactly two values, forever, and names a
*level of ownership within* one installation. A view owned by a project is the same kind of row as
a ticket owned by a project — projects already coexist in one installation's database
(`blaze_config.project`).

The falsification test ADR-0014 asks for: does this design still make sense at N = 1
installation? **Yes — it is only written for N = 1.** Nothing here would gain meaning from a
second installation's rows being present, and nothing would need a predicate added.

## Consequences

**430 occurrences of "board" across 77 `.mjs` files under `scripts/`, plus 49 doc files, are
re-read per meaning.** Most are prose or meaning (2), which is correct and must survive — which is
why **the rename is per-meaning and never a global substitution.** A single
`sed s/board/installation/g` would corrupt the one meaning that is right, and would do so
silently.

Per-meaning, what moves:

| Today | Means | Becomes |
|---|---|---|
| "one installation is one board" (ADR-0014:14) | tenancy unit | installation |
| `blaze_config.board` table | installation config singleton | `blaze_config.installation` |
| `cfg.boardTitle` | display name | `installationTitle`; `boardTitle` retired via `REMOVED_KEYS` |
| `blaze board` | serve the web UI | `blaze serve`, with `board` kept as a permanent alias |
| `deriveBoards()` / board pills | workflow-derived column groupings | `deriveColumnSets()` / `column_set` |
| `boardModel()` | the read model behind board, list, map **and** metrics | `itemModel()` — it was never board-specific |
| `views.board`, `VIEW_NAMES[0]`, `views/board.mjs` | the kanban renderer | **unchanged** |

`blaze board` survives as an alias, so nothing an operator types today breaks.
`blaze.config.json`'s `views: {...}` keeps working through the whole of v3 and is retired
afterwards via `REMOVED_KEYS` in `scripts/model/schema-version.mjs` — the mechanism BLZ-298 built
for exactly this, which produces a hard, named error carrying its own fix rather than a silent
drop.

## What would reverse this

Nothing short of the operator reversing the *"a project owns N named views"* decision itself. The
rename is downstream of that model; if views went back to being installation-only booleans, the
three-way collision would stop mattering and `board` could keep all three meanings.

## Correction this ADR carries forward

ADR-0014:12's singleton list is factually wrong and BLZ-362 tracks fixing it: it names
`board_config`, a table that **has never existed**; omits `blaze_config.config_version`, which
does; and counts `migration_mode` twice as "the two write-rules tables" when it is one table
declared once per dialect. Four distinct singleton tables exist —
`blaze_config.board`, `blaze_config.config_version`, `projection_meta` and `migration_mode`.
