// scripts/model/link-schema.mjs — the typed link meta-model.
//
// Endpoints are DECLARED, and anything undeclared is refused (ADR-0015). Jama's
// default is the opposite — "if you don't define a rule for a particular item type,
// that item type can have a relationship with anything" — which is maximum
// permissiveness in a governance tool (CS-012).
//
// source_kinds/target_kinds are stored as comma-separated text rather than an array
// type, because Postgres has arrays and SQLite does not, and the read path must be
// identical in both.
export const DEFAULT_LINK_TYPES = [
  { name: "Implements", inverse_name: "Implemented by", source_kinds: ["feature"],
    target_kinds: ["requirement"], min_card: 0, max_card: null },
  { name: "Addresses",  inverse_name: "Addressed by",   source_kinds: ["architecture"],
    target_kinds: ["requirement"], min_card: 0, max_card: null },
  { name: "Verifies",   inverse_name: "Verified by",    source_kinds: ["story", "feature"],
    target_kinds: ["requirement"], min_card: 0, max_card: null },
  { name: "Supersedes", inverse_name: "Superseded by",  source_kinds: ["architecture"],
    target_kinds: ["architecture"], min_card: 0, max_card: 1 },
  { name: "Derives",    inverse_name: "Derived from",   source_kinds: ["requirement"],
    target_kinds: ["requirement"], min_card: 0, max_card: null },
];

function dialect(name) {
  if (name === "postgres") return { ts: "timestamptz", txt: "text", int: "integer", tbl: "" };
  if (name === "sqlite")   return { ts: "TEXT", txt: "TEXT", int: "INTEGER", tbl: " STRICT" };
  throw new Error(`unknown dialect ${JSON.stringify(name)}`);
}

export function linkDdl(name) {
  const d = dialect(name);
  return `
CREATE TABLE IF NOT EXISTS link_type (
  id           ${d.txt} NOT NULL,
  project_key  ${d.txt} NOT NULL,
  name         ${d.txt} NOT NULL,
  inverse_name ${d.txt} NOT NULL,
  source_kinds ${d.txt} NOT NULL,
  target_kinds ${d.txt} NOT NULL,
  min_card     ${d.int} NOT NULL DEFAULT 0,
  max_card     ${d.int},
  PRIMARY KEY (id),
  UNIQUE (project_key, name),
  CHECK (length(trim(source_kinds)) > 0),
  CHECK (length(trim(target_kinds)) > 0),
  CHECK (min_card >= 0),
  CHECK (max_card IS NULL OR max_card >= min_card)
)${d.tbl};

CREATE TABLE IF NOT EXISTS link (
  id           ${d.txt} NOT NULL,
  link_type_id ${d.txt} NOT NULL REFERENCES link_type (id) ON DELETE RESTRICT,
  source_id    ${d.txt} NOT NULL,
  target_id    ${d.txt} NOT NULL,
  created_at   ${d.ts} NOT NULL,
  created_by   ${d.txt} NOT NULL DEFAULT 'unknown',
  -- BLZ-330: staleness.mjs has always read l.reviewed_at and this column did not exist,
  -- so it was always NULL and EVERY link whose source had any revision reported stale.
  -- An indicator that is on for everything is off. Nullable on purpose: a link nobody
  -- has re-reviewed since the source changed is exactly the case section 5 wants
  -- surfaced, so "never reviewed" must be representable rather than defaulted away.
  reviewed_at  ${d.ts},
  PRIMARY KEY (id),
  UNIQUE (link_type_id, source_id, target_id),
  CHECK (source_id <> target_id)
)${d.tbl};

CREATE INDEX IF NOT EXISTS link_source_idx ON link (source_id, link_type_id);
CREATE INDEX IF NOT EXISTS link_target_idx ON link (target_id, link_type_id);
`;
}
