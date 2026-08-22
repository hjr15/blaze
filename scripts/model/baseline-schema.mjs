// scripts/model/baseline-schema.mjs — immutable named snapshots, at PROJECT scope.
//
// DOORS baselined per module, which forced baseline SETS to be invented to group them.
// The existence of the fix is evidence of the original mistake, so we baseline at
// project scope from the start.

import { dialect } from "./sql-dialect.mjs";
export function baselineDdl(name) {
  const d = dialect(name);
  return `
CREATE TABLE IF NOT EXISTS baseline (
  id          ${d.txt} NOT NULL,
  project_key ${d.txt} NOT NULL,
  name        ${d.txt} NOT NULL,
  created_at  ${d.ts} NOT NULL,
  created_by  ${d.txt} NOT NULL,
  note        ${d.txt},
  PRIMARY KEY (id),
  UNIQUE (project_key, name)
)${d.tbl};

-- RESTRICT on both: a baseline is a historical record, and deleting out from under
-- it would silently rewrite history.
CREATE TABLE IF NOT EXISTS baseline_member (
  baseline_id ${d.txt} NOT NULL REFERENCES baseline (id) ON DELETE CASCADE,
  artifact_id ${d.txt} NOT NULL REFERENCES artifact (id) ON DELETE RESTRICT,
  revision_id ${d.txt} NOT NULL REFERENCES artifact_revision (id) ON DELETE RESTRICT,
  PRIMARY KEY (baseline_id, artifact_id)
)${d.tbl};
`;
}
