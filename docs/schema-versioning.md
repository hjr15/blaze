# Config-schema versioning

The engine (`@hjr15/blaze-board`) and a board's data repo (`blaze.config.json`
+ `projects/`) ship and evolve independently. An optional top-level
**`schemaVersion`** integer in `blaze.config.json` records which schema
contract the board was written against, so an engine whose schema semantics
have moved on fails **loud** instead of silently misreading ticket history:

```json
{ "key": "ENG", "projects": ["ENG"], "schemaVersion": 1 }
```

## The compat window

The engine declares two constants in `scripts/model/schema-version.mjs`
(also re-exported from `scripts/model/schema-config.mjs`):

| Constant | Value | Meaning |
|---|---|---|
| `SCHEMA_VERSION` | `2` | the contract this engine writes/speaks |
| `MIN_SCHEMA_VERSION` | `1` | the oldest contract this engine still reads |

A board loads iff `MIN_SCHEMA_VERSION <= schemaVersion <= SCHEMA_VERSION`:

| Board's `schemaVersion` | Outcome |
|---|---|
| absent (or `null`) | resolved to `1` — the pre-versioning baseline — and then put through this same window, exactly as an explicit `1` is: it loads while `MIN_SCHEMA_VERSION` is `1`, and fails loud once `MIN_SCHEMA_VERSION` is raised past it |
| in `[MIN, CURRENT]` | loads |
| `> SCHEMA_VERSION` | fails loud — the board was written by a newer engine |
| `< MIN_SCHEMA_VERSION` | fails loud — the board predates this engine's window |
| not a positive integer | fails loud — invalid stamp |

An absent stamp is **not** a bypass. It is a value — v1 — and it is checked like
any other, so no board can outlive the compat window merely by carrying no
stamp. That matters because most existing boards (the live `blaze-pm` board
included) predate the stamp and carry none: today, at `MIN_SCHEMA_VERSION` `1`,
they all load; on the day `MIN_SCHEMA_VERSION` is raised, they all fail loud
together, and the release that raises it carries their migration path.

The guard fires in `loadConfig` — covering every command that loads config,
including `blaze move`/`edit`/`link`/`log`/`resolve`/`new`, where the check
runs before those commands touch a ticket file, not after — and separately in
`blaze reindex` and `blaze rollup`, both of which resolve roots without
loading config through the usual path but are schema-sensitive: `reindex`
re-validates every ticket against the schema, and `rollup` builds the index
(pulling in the type registry) to compute its roll-up totals. `blaze commit`
is the one command that is genuinely schema-agnostic — it commits an explicit
list of already-written files and never consults the schema — and stays
uncovered by design.

`reindex` accepts an explicit `projects/`-dir argument (`blaze reindex <dir>`)
to retarget which board's tickets get indexed. That argument re-resolves the
data root too — `<dir>/..`, where that board's own `blaze.config.json` sits —
so the guard validates the stamp of the board actually being indexed, from any
cwd, and the rebuilt `.blaze/` cache lands under that same board (BLZ-107). A
board stamped outside the compat window fails loud whether it is reached
through the cwd, `BLAZE_PROJECTS_DIR`, or an explicit `<dir>`.

Two things do **not** follow the `<dir>` argument, by design: `BLAZE_DB_DIR`,
which is an explicit override of the cache location and wins if set; and
`blaze rollup`, which has no dir argument at all and always guards the
ambient data root.

## If the guard stopped you

- **"newer than this engine supports"** — the board was created or last
  written by a newer engine. Upgrade this install
  (`npm i -g @hjr15/blaze-board@latest`) and re-run.
- **"older than this engine supports"** — the board predates the oldest
  contract this engine reads. The release that raised `MIN_SCHEMA_VERSION`
  documents its migration path in its release notes. (For the CONFIG schema
  `MIN` is `1`, so this cannot occur there. For the DATABASE schema it can and
  does — see below.)
- **"no schemaVersion stamp"** — the board carries no stamp at all, which
  means v1, and v1 is below this engine's `MIN_SCHEMA_VERSION`. There is no
  wrong value to correct: follow the migration path in the release notes of the
  version that raised `MIN_SCHEMA_VERSION`, then add the key the message names
  (`"schemaVersion": <SCHEMA_VERSION>`) to `blaze.config.json`. (Today `MIN` is
  `1`, so this cannot occur.)
- **"invalid schemaVersion"** — the stamp is not a positive integer.
  Hand-edit `blaze.config.json` to a valid version, or remove the key
  entirely — absent means v1.

## Policy

- `SCHEMA_VERSION` bumps only for a **breaking** schema-contract change
  (renamed status, changed required-field rule, reshaped hierarchy).
  Additive, backwards-compatible schema features never bump it.
- BLZ-109's `sprint`/`start`/`due` fields are the first additive change
  post-ADR-0002 and deliberately do not bump `SCHEMA_VERSION` — see
  [ADR-0004](decisions/0004-sprints-are-additive-not-a-schema-bump.md).
- **Version 2 shipped with its migration path, and that path is the error
  message.** BLZ-298 removed three config keys (`provider`, `terminal`,
  `codeRepo`) that nothing read — a breaking contract change, so it bumped
  `SCHEMA_VERSION` to 2. The migration for a board carrying one of them is to
  delete it, and `REMOVED_KEYS` in `scripts/model/schema-version.mjs` names each
  key with the reason and prints it on refusal. There is still no *migrator
  program*; the rule remains that the PR shipping a breaking change ships the
  path, whatever shape that path takes. (`blaze migrate` is unrelated — it is
  the external-tracker importer.)
- Decision record:
  [ADR-0002](decisions/0002-config-schema-versioning.md).

## The DATABASE schema is a different number

Everything above is `blaze.config.json`'s `schemaVersion`, guarded by
`checkSchemaVersion`. The **database** carries its own stamp in `blaze_meta`,
guarded by `judgeDbSchema`, and the two move independently — a config bump is
not an engine-schema bump. `DB_SCHEMA_VERSION` and `MIN_DB_SCHEMA_VERSION` both
live in `scripts/model/db-schema-version.mjs`.

**Both are 2 as of BLZ-370.** Version 2 installs the v4 `link`/`link_type` and
`hierarchy`/`hierarchy_membership` tables and five new `ticket` columns, none of
which a version-1 database has.

- **"database schema version N is newer than this engine supports"** — the
  shadow was written by a newer engine. Upgrade this install.
- **"database schema version 1 is older than this engine supports"** — **this
  one does occur**, for every shadow created before BLZ-370. There is no
  migration and none is needed: the shadow is **derived**, not authoritative.
  The filesystem is the source of truth, so rebuild it:

      blaze db init --force

  That drops the old shadow and reloads the board into a version-2 one. No board
  data lives only in the shadow, which is why raising the floor is safe and why
  a migration path would be machinery for nothing.
- **"this database holds tables but no Blaze schema stamp"** — it predates
  database-schema versioning entirely, or is not a Blaze database. Same remedy,
  and the same reason it is safe.
