// scripts/model/schema-marker.mjs — BLZ-396.
//
// The key under which `loadConfig`/`loadProject` record that they DROPPED a wrong-shaped
// `schema` block. It is a SYMBOL on purpose, and it lives alone in a leaf module for two
// reasons:
//
// 1. `audit-runner.mjs` hands `auditCorpus` the raw `JSON.parse(project.json)` — it never
//    calls `loadProject` — so a STRING key would arrive straight from operator-written JSON
//    and let a board invent a malformation that does not exist. `blaze audit` reported "the
//    whole block was IGNORED" on a project.json with no schema block at all, and the load
//    path disagreed with audit on the same board. `JSON.parse` cannot produce a symbol key.
// 2. `config.mjs` and `model/schema-config.mjs` are in an import CYCLE
//    (config → schema-config → schema → config), so a shared binding declared in either of
//    them can be in its temporal dead zone when the other's body runs. This module imports
//    nothing, so it is fully initialised before either.
//
// It is set BEFORE `Object.freeze`, so the freeze preserves it. `cli.mjs` passes `config`
// and `project` by REFERENCE into its command context rather than copying them, so nothing
// has to survive a copy on the production path — and object spread would carry it anyway,
// since spread copies enumerable own symbol keys. What it does NOT survive is
// `JSON.stringify`, which drops symbol keys; no production path serialises a config, and
// `audit-runner.mjs` deliberately reads the RAW parse, where the wrong-shaped `schema` is
// still visible directly and needs no marker.
export const SCHEMA_BLOCK_DROPPED = Symbol("blaze.schemaBlockDropped");
