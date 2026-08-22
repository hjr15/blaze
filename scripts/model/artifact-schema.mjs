// scripts/model/artifact-schema.mjs — the base entity behind a requirement or an
// architecture decision. NOT a ticket: tickets link TO these.
//
// Table-level constraints come after every column: SQLite requires it, Postgres
// tolerates it (sqlite-schema.mjs:18). btrim() is Postgres-only, so emptiness uses
// the portable length(trim(x)) form.
import { dialect } from "./sql-dialect.mjs";
export const ARTIFACT_KINDS = ["requirement", "architecture"];


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

export function revisionDdl(name) {
  const d = dialect(name);
  return `
CREATE TABLE IF NOT EXISTS artifact_revision (
  id          ${d.txt} NOT NULL,
  artifact_id ${d.txt} NOT NULL REFERENCES artifact (id) ON DELETE CASCADE,
  at          ${d.ts} NOT NULL,
  actor       ${d.txt} NOT NULL DEFAULT 'unknown',
  snapshot    ${d.txt} NOT NULL,
  PRIMARY KEY (id)
)${d.tbl};
CREATE INDEX IF NOT EXISTS artifact_revision_artifact_idx ON artifact_revision (artifact_id, at);
`;
}
