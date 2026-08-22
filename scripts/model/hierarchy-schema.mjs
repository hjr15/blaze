// scripts/model/hierarchy-schema.mjs — multiple named hierarchies over the same items.
//
// Replaces a single parent_id, which forecloses the core Structure use case: a
// delivery hierarchy, a safety hierarchy and a contractual-deliverable hierarchy
// coexisting over one set of items.
function dialect(name) {
  if (name === "postgres") return { txt: "text", int: "integer", bool: "boolean", false_: "false", tbl: "" };
  if (name === "sqlite")   return { txt: "TEXT", int: "INTEGER", bool: "INTEGER", false_: "0", tbl: " STRICT" };
  throw new Error(`unknown dialect ${JSON.stringify(name)}`);
}

export function hierarchyDdl(name) {
  const d = dialect(name);
  return `
CREATE TABLE IF NOT EXISTS hierarchy (
  id          ${d.txt} NOT NULL,
  project_key ${d.txt} NOT NULL,
  name        ${d.txt} NOT NULL,
  is_default  ${d.bool} NOT NULL DEFAULT ${d.false_},
  PRIMARY KEY (id),
  UNIQUE (project_key, name)
)${d.tbl};

-- parent_id is nullable (a root has none), and a STRICT SQLite table — like
-- Postgres, per the SQL standard — cannot hold NULL in a PRIMARY KEY column.
-- So parent_id cannot be part of the primary key; a surrogate id is the key,
-- and UNIQUE enforces "no duplicate edge" without touching NULL-ability.
CREATE TABLE IF NOT EXISTS hierarchy_membership (
  id           ${d.txt} NOT NULL,
  hierarchy_id ${d.txt} NOT NULL REFERENCES hierarchy (id) ON DELETE CASCADE,
  item_id      ${d.txt} NOT NULL,
  parent_id    ${d.txt},
  ord          ${d.int} NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE (hierarchy_id, item_id, parent_id),
  CHECK (item_id <> parent_id)
)${d.tbl};

CREATE INDEX IF NOT EXISTS hierarchy_membership_parent_idx
  ON hierarchy_membership (hierarchy_id, parent_id);

-- NULLs compare distinct under UNIQUE in both engines, so the UNIQUE above does NOT
-- prevent the same item being registered as a root twice. This partial index does.
-- Both SQLite and Postgres support partial indexes.
CREATE UNIQUE INDEX IF NOT EXISTS hierarchy_membership_root_idx
  ON hierarchy_membership (hierarchy_id, item_id) WHERE parent_id IS NULL;
`;
}
