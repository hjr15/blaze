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
