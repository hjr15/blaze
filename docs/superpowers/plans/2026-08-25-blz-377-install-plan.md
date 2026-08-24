# BLZ-377 — installing `blaze_config`, then `viewDdl`: the decisions

Working notes for the implementing session. Measured against `c0eec71`.

## What already exists, measured

- `viewDdl` and `VIEW_TYPES` are **already written** in `view-schema.mjs`, and both SQLite
  traps are already handled there: FK targets unqualified in SQLite / qualified in Postgres,
  and `CREATE INDEX` qualifying the index name in SQLite and the table in Postgres.
- Executed against a real ATTACHed SQLite file and a real Postgres: `configDdl` + `viewDdl`
  produce **16 tables** in `blaze_config` on both drivers, both partial indexes, `main` /
  `public` untouched. Every constraint enforces — both FKs, the scope/owner CHECK, and the
  partial unique that stops two installation views sharing a slug — while the valid insert
  is allowed, so the refusals are not vacuous.
- `sqliteAttachConfig(path)` exists and has **no caller outside its own test**, which only
  ever passes `:memory:`. **No test anywhere attaches a real on-disk file.**
- There is no `attachConfig` — only `sqliteAttachConfig`. The ticket names both.
- Precedent for a second SQLite file beside the shadow: `identityDbPath` =
  `<dataRoot>/.blaze/identity.db` (`identity-db.mjs:27`).

## Decisions

**D1 — Schema version 4, not 3.** BLZ-377's AC says "probably wants version 3". Version 3
shipped under BLZ-390 (`STRICT` on the seven SQLITE_DDL tables and `blaze_meta`). Adding
tables to a shipped version retroactively is the silent schema change the version exists to
prevent. `DB_SCHEMA_VERSION` and `MIN_DB_SCHEMA_VERSION` both move to 4, the precedent
versions 2 and 3 each set. No upgrade path: the shadow is derived, and
`blaze db init --force` rebuilds it.

**D2 — The config namespace lives at `<dataRoot>/.blaze/config.db`**, beside `blaze.db`,
following the `identity.db` precedent. Derived from the main database's path so one rule
serves both openers: `configDbPathFor(main)` returns `:memory:` for `:memory:`, else
`config.db` in the main database's directory.

**D3 — The openers ATTACH; `createDbSchema*` does not.** Only the openers know the path, and
the attach is needed on every open, not only on create — so putting it in create would either
double-attach or leave reads unable to see `view`. `createDbSchema*` instead **refuses with a
named error** when the namespace is absent, rather than silently attaching `:memory:` and
putting a real installation's config in memory where it would vanish. Refuse rather than
guess is the house rule this module already states.

**D4 — A synchronous seed twin.** `seedConfigInTransaction` is `async`, so with node:sqlite's
synchronous driver every `await` defers to a microtask and `createDbSchemaSync` would return
**before the seed had run**. `seedConfigSync` applies the same statements in the same
transaction synchronously. The circular `workflow.reopen_to` FK is deferred, so the seed is
only consistent at COMMIT and the transaction is load-bearing, not tidiness.

**D5 — `view_type` seeds from `VIEW_TYPES`** via a `viewTypeSeedSql(name)` beside the DDL that
declares the table, so the registry stays the one source.

## Known limitation, recorded rather than papered over

The version stamp lives in `blaze_meta`, in the **main** database. If `config.db` is deleted
while `blaze.db` survives, the attach silently creates an empty file and `blaze_config.view`
fails with "no such table" instead of a named refusal. Re-running the config DDL on every open
would mask it — and that is precisely the BLZ-297 anti-pattern this module exists to end, so it
is not the fix. Rebuilding with `blaze db init --force` is the honest instruction.
