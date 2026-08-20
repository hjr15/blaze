// scripts/model/sqlite-schema.mjs — the v3 ticket schema, SQLite dialect (BLZ-277).
//
// A deliberately narrow first cut: the columns the READ contract in read-storage.mjs
// actually needs, so a SQLite driver can satisfy the same named operations as the
// filesystem one. Events, the config projection, worklog and acceptance-criterion
// tables follow in their own slices — putting them here before anything reads them
// would be schema written against a document rather than against a consumer.
//
// Every construct here was probed against real node:sqlite by
// scripts/v3_sqlite_dialect_probe.mjs. Three things the v3 design document specifies
// are NOT used, because they fail at CREATE TABLE time on SQLite:
//
//   ~  and  !~   Postgres regex operators   -> GLOB
//   btrim()      Postgres-only              -> length(trim(x)) > 0
//
// and a FOURTH, found while writing this file: SQLite requires every table-level
// CONSTRAINT to come after every column definition. Postgres allows them interleaved,
// and the design's section 4.3 interleaves them — so that DDL cannot be created on
// SQLite as written, independently of the regex and btrim problems.
//
// and the register's V22 is wrong in our favour: FILTER (WHERE …) works from SQLite
// 3.30, only LATERAL is absent.
export const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS ticket (
  id          TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  num         INTEGER NOT NULL CHECK (num > 0),

  type     TEXT NOT NULL,
  status   TEXT NOT NULL,
  -- design says CHECK (btrim(title) <> ''). btrim is Postgres-only; this is the
  -- portable form, probe-verified on both.
  title    TEXT NOT NULL CHECK (length(trim(title)) > 0),
  priority TEXT NOT NULL DEFAULT 'medium',
  resolution TEXT,

  parent_id   TEXT,
  parent_type TEXT,

  assignee         TEXT NOT NULL DEFAULT 'unassigned',
  estimate_minutes INTEGER CHECK (estimate_minutes IS NULL
                                  OR (estimate_minutes > 0 AND estimate_minutes % 5 = 0)),
  sprint_id  TEXT,
  start_date TEXT,
  due_date   TEXT,

  body       TEXT NOT NULL DEFAULT '',
  created_on TEXT NOT NULL,
  updated_on TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at TEXT,

  -- EVERY table-level constraint sits after EVERY column. SQLite requires this;
  -- Postgres does not care. The v3 design's section 4.3 interleaves them, so that
  -- DDL cannot be created on SQLite as written — see the dialect probe.
  CONSTRAINT ticket_id_is_key_and_num CHECK (id = project_key || '-' || CAST(num AS TEXT)),
  CONSTRAINT ticket_num_unique UNIQUE (project_key, num),
  CONSTRAINT ticket_parent_pair_present CHECK ((parent_id IS NULL) = (parent_type IS NULL)),
  CONSTRAINT ticket_not_own_parent CHECK (parent_id IS DISTINCT FROM id),
  -- Project keys are uppercase alphanumerics. The design writes this as
  -- CHECK (key ~ '^[A-Z][A-Z0-9]*$'); SQLite has no regex, so GLOB.
  CONSTRAINT ticket_project_key_shape CHECK (
    project_key GLOB '[A-Z]*' AND project_key NOT GLOB '*[^A-Z0-9]*')
);

CREATE INDEX IF NOT EXISTS ticket_parent_idx ON ticket (parent_id);
CREATE INDEX IF NOT EXISTS ticket_board_idx  ON ticket (project_key, status, type);

CREATE TABLE IF NOT EXISTS ticket_link (
  src_id    TEXT NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  link_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  PRIMARY KEY (src_id, link_type, target_id)
);

-- blockersOf() is "inbound links by type", so the index is on the TARGET. The design
-- calls this out: the reverse direction would otherwise seq-scan.
CREATE INDEX IF NOT EXISTS link_target_idx ON ticket_link (target_id, link_type);
`;

/** Applied per connection: SQLite does not enforce foreign keys without it (V3). */
export const SQLITE_PRAGMAS = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
`;
