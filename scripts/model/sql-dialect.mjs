// scripts/model/sql-dialect.mjs — the one table of per-engine SQL tokens (BLZ-331).
//
// Ten schema modules each defined a private `dialect(name)` returning some subset of the
// same tokens. That is not a tidiness problem, and the extraction is not a refactor for
// its own sake — two defect classes on this branch were caused by retyping it:
//
//   `boolean NOT NULL DEFAULT 0` shipped THREE separate times. Postgres rejects it (an
//   untyped integer literal does not implicitly cast to boolean) where SQLite tolerates
//   it, so it passes every SQLite test and fails only against a real Postgres. `true_`
//   and `false_` exist so the literal is never typed by hand.
//
//   ` STRICT` was retyped in each module, and OMITTING it fails SILENTLY: without STRICT
//   a SQLite REAL column accepts the string 'oops' (ADR-0018's benchmark measured this).
//   A missing token is a missing guard nobody sees.
//
// A single table makes both unrepresentable. Every consumer takes the same object, so a
// token cannot be right in one module and wrong in the next.
//
// `config-schema.mjs` is deliberately NOT a consumer. Its dialect carries regex-vs-GLOB
// checks, a circular-FK strategy that differs structurally between the engines, a
// namespace and an FK-qualification function — engine DIFFERENCES, not shared tokens.
// Folding those in would make this table a dumping ground and couple every schema module
// to config's peculiarities.
const TOKENS = {
  postgres: {
    ts: "timestamptz",
    txt: "text",
    int: "integer",
    bool: "boolean",
    true_: "true",
    false_: "false",
    // Postgres has no STRICT and needs no table-level suffix.
    tbl: "",
    // §3.4's JSON tail. `jsonb` is the storage form the spec names.
    json: "jsonb",
    // Cast for readability, NOT because it is load-bearing — stated honestly because a
    // mutation removing the cast broke nothing. Unlike `boolean DEFAULT 0`, Postgres does
    // resolve an unknown literal to the column's own type here, so `DEFAULT '{}'` would
    // work too. The DEFAULT itself is the guard, and it has a test.
    jsonEmpty: "'{}'::jsonb",
    // §3.4: JSON "still takes CHECK constraints" — the benchmark refuted the assumption
    // that a JSON column means app-level validation only. This is that constraint.
    jsonIsObject: (col) => `jsonb_typeof(${col}) = 'object'`,
  },
  sqlite: {
    ts: "TEXT",
    txt: "TEXT",
    int: "INTEGER",
    // SQLite has no boolean type: 0/1 in an INTEGER column.
    bool: "INTEGER",
    true_: "1",
    false_: "0",
    // Table-level constraints must come after every column under STRICT, and STRICT is
    // what makes a typed column actually reject a wrong-typed value.
    tbl: " STRICT",
    // SQLite has no JSON type; JSON1 operates over TEXT. STRICT permits TEXT, and the
    // CHECK below is what actually enforces the shape.
    json: "TEXT",
    jsonEmpty: "'{}'",
    // json_valid FIRST: json_type() on a non-JSON string returns NULL, and a NULL CHECK
    // result is treated as SATISFIED in SQLite — so checking the type alone lets any
    // garbage string through.
    jsonIsObject: (col) => `json_valid(${col}) AND json_type(${col}) = 'object'`,
  },
};

/**
 * @param name  'postgres' | 'sqlite'
 * @returns a FRESH token map. Throws on anything else — fail closed, because silently
 *   treating an unknown engine as SQLite generates DDL that will not run.
 *
 * Fresh, not the shared TOKENS entry: the ten private helpers this replaced each built a
 * new object literal per call, so nothing could leak between modules. Handing out the one
 * shared object would let a stray assignment anywhere change every other module's
 * generated DDL — and its own test caught exactly that, poisoning ` STRICT` for every
 * schema checked after it.
 */
export function dialect(name) {
  const t = TOKENS[name];
  if (!t) throw new Error(`unknown dialect ${JSON.stringify(name)} — expected 'sqlite' or 'postgres'`);
  return { ...t };
}
