// scripts/model/artifact-schema.mjs — the base entity behind a requirement or an
// architecture decision. NOT a ticket: tickets link TO these.
//
// Table-level constraints come after every column: SQLite requires it, Postgres
// tolerates it (sqlite-schema.mjs:18). btrim() is Postgres-only, so emptiness uses
// the portable length(trim(x)) form.
export const ARTIFACT_KINDS = ["requirement", "architecture"];

function dialect(name) {
  if (name === "postgres") return { ts: "timestamptz", txt: "text", tbl: "" };
  if (name === "sqlite")   return { ts: "TEXT", txt: "TEXT", tbl: " STRICT" };
  throw new Error(`unknown dialect ${JSON.stringify(name)}`);
}

export function artifactDdl(name) {
  const d = dialect(name);
  const kinds = ARTIFACT_KINDS.map((k) => `'${k}'`).join(", ");
  return `
CREATE TABLE IF NOT EXISTS artifact (
  id          ${d.txt} NOT NULL,
  project_key ${d.txt} NOT NULL,
  kind        ${d.txt} NOT NULL,
  ref         ${d.txt} NOT NULL,
  title       ${d.txt} NOT NULL,
  statement   ${d.txt},
  body        ${d.txt},
  status      ${d.txt} NOT NULL,
  created_at  ${d.ts} NOT NULL,
  updated_at  ${d.ts} NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (project_key, ref),
  CHECK (kind IN (${kinds})),
  CHECK (length(trim(title)) > 0)
)${d.tbl};

CREATE INDEX IF NOT EXISTS artifact_project_kind_idx ON artifact (project_key, kind, status);
CREATE INDEX IF NOT EXISTS artifact_ref_idx ON artifact (project_key, ref);
`;
}
