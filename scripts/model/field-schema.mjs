// scripts/model/field-schema.mjs — user-defined custom field definitions (ADR-0018).
//
// Table-level constraints come after every column: SQLite STRICT requires it,
// Postgres tolerates it (artifact-schema.mjs).
//
// Two defects already hit this plan's schema code and must not repeat here:
//  1. A nullable column inside a composite PRIMARY KEY is uninsertable under STRICT
//     SQLite and in Postgres. field_definition keys on the surrogate `id` alone —
//     nothing nullable is ever part of a PRIMARY KEY here.
//  2. `boolean NOT NULL DEFAULT 0` is rejected by Postgres — an untyped integer
//     literal does not implicitly cast to boolean. is_filterable and is_required use
//     the `false_` dialect token (coverage.mjs / hierarchy-schema.mjs pattern),
//     never a literal `0`.
function dialect(name) {
  if (name === "postgres") return { txt: "text", int: "integer", bool: "boolean", false_: "false", tbl: "" };
  if (name === "sqlite")   return { txt: "TEXT", int: "INTEGER", bool: "INTEGER", false_: "0", tbl: " STRICT" };
  throw new Error(`unknown dialect ${JSON.stringify(name)}`);
}
export const DATA_TYPES = ["text", "number", "date", "boolean", "enum"];

export function fieldDdl(name) {
  const d = dialect(name);
  const types = DATA_TYPES.map((t) => `'${t}'`).join(", ");
  return `
CREATE TABLE IF NOT EXISTS field_definition (
  id              ${d.txt} NOT NULL,
  project_key     ${d.txt} NOT NULL,
  key             ${d.txt} NOT NULL,
  label           ${d.txt} NOT NULL,
  data_type       ${d.txt} NOT NULL,
  applies_to_kind ${d.txt} NOT NULL,
  is_filterable   ${d.bool} NOT NULL DEFAULT ${d.false_},
  is_required     ${d.bool} NOT NULL DEFAULT ${d.false_},
  enum_values     ${d.txt},
  min_value       ${d.txt},
  max_value       ${d.txt},
  PRIMARY KEY (id),
  UNIQUE (project_key, key, applies_to_kind),
  CHECK (data_type IN (${types})),
  CHECK (data_type <> 'enum' OR enum_values IS NOT NULL)
)${d.tbl};
`;
}
