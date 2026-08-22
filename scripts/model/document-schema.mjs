// scripts/model/document-schema.mjs — documents as ordered containers of USAGES.
//
// DOORS Next's separation of base artifact from module usage. One requirement can
// appear in the safety case, the subsystem spec and the customer submission without
// three copies that drift. Ordering and indent depth belong to the USAGE, so the same
// requirement is top-level in one document and nested in another.
export const DOCUMENT_KINDS = ["requirements", "architecture"];

function dialect(name) {
  if (name === "postgres") return { ts: "timestamptz", txt: "text", int: "integer", tbl: "" };
  if (name === "sqlite")   return { ts: "TEXT", txt: "TEXT", int: "INTEGER", tbl: " STRICT" };
  throw new Error(`unknown dialect ${JSON.stringify(name)}`);
}

export function documentDdl(name) {
  const d = dialect(name);
  const kinds = DOCUMENT_KINDS.map((k) => `'${k}'`).join(", ");
  return `
CREATE TABLE IF NOT EXISTS document (
  id          ${d.txt} NOT NULL,
  project_key ${d.txt} NOT NULL,
  title       ${d.txt} NOT NULL,
  kind        ${d.txt} NOT NULL,
  status      ${d.txt} NOT NULL,
  created_at  ${d.ts} NOT NULL,
  updated_at  ${d.ts} NOT NULL,
  PRIMARY KEY (id),
  CHECK (kind IN (${kinds})),
  CHECK (length(trim(title)) > 0)
)${d.tbl};

-- ON DELETE CASCADE on document_id only. artifact_id is RESTRICT: deleting a
-- requirement that is still used somewhere must fail loudly rather than silently
-- empty a document.
CREATE TABLE IF NOT EXISTS artifact_usage (
  document_id ${d.txt} NOT NULL REFERENCES document (id) ON DELETE CASCADE,
  artifact_id ${d.txt} NOT NULL REFERENCES artifact (id) ON DELETE RESTRICT,
  ord         ${d.int} NOT NULL,
  depth       ${d.int} NOT NULL DEFAULT 0,
  PRIMARY KEY (document_id, artifact_id),
  UNIQUE (document_id, ord),
  CHECK (ord > 0),
  CHECK (depth >= 0)
)${d.tbl};

CREATE INDEX IF NOT EXISTS artifact_usage_artifact_idx ON artifact_usage (artifact_id);
`;
}
