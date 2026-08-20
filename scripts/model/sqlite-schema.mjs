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

-- The audit trail (design D7 / section 4.6). This is the designated replacement for
-- \`git log --follow\`, and the brief is explicit that it has to exist BEFORE files
-- freeze or it dies silently: once the filesystem stops being the store, any history
-- not captured here is simply gone.
--
-- It is worth being honest about what it replaces. The existing trail is
-- .blaze/transitions.json, rebuilt by \`blaze reindex\` from git rename history, and it
-- covers 383 of 2,534 tickets — about 15%, because history is squash-merged. So this
-- is not a like-for-like migration of a complete log; it replaces a mostly-empty one
-- with a complete one going forward, and the coverage figure belongs on the metrics
-- view rather than buried.
--
-- One table, not two. A separate transitions table would duplicate every status move;
-- a partial index gives metrics the narrow path it needs while leaving one place to
-- ask "what happened to this ticket".
CREATE TABLE IF NOT EXISTS ticket_event (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,   -- V8: the SQLite identity clause
  ticket_id TEXT NOT NULL REFERENCES ticket (id) ON DELETE RESTRICT,
  kind      TEXT NOT NULL,
  at        TEXT NOT NULL,                       -- ISO-8601 UTC; sorts chronologically
  actor     TEXT NOT NULL DEFAULT 'unknown',
  source    TEXT NOT NULL,
  request_id  TEXT,
  from_status TEXT,
  to_status   TEXT,
  field     TEXT,
  old_value TEXT,
  new_value TEXT,
  detail    TEXT,

  CONSTRAINT event_kind_known CHECK (kind IN (
    'create','transition','edit','resolve','link-add','link-remove',
    'worklog','ac-toggle','ac-edit','sprint-assign','delete','restore','import')),
  CONSTRAINT event_source_known CHECK (source IN ('cli','api','loop','migration','git-backfill')),
  -- a transition event without both statuses is not a transition
  CONSTRAINT event_transition_shape CHECK (
    (kind = 'transition') = (from_status IS NOT NULL AND to_status IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS event_ticket_at_idx  ON ticket_event (ticket_id, at);
CREATE INDEX IF NOT EXISTS event_at_idx         ON ticket_event (at);
CREATE INDEX IF NOT EXISTS event_transition_idx ON ticket_event (at, ticket_id)
  WHERE kind = 'transition';

-- Append-only, enforced by the database rather than by convention. The design calls
-- this the single most important property of the v3 trail: no write path can skip it.
-- SQLite trigger bodies are SQL-only and use RAISE(ABORT, …) — the Postgres form is a
-- PL/pgSQL function plus trigger, which is V13's genuine per-dialect cost.
CREATE TRIGGER IF NOT EXISTS ticket_event_no_update
  BEFORE UPDATE ON ticket_event
BEGIN
  SELECT RAISE(ABORT, 'ticket_event is append-only: UPDATE is refused');
END;

CREATE TRIGGER IF NOT EXISTS ticket_event_no_delete
  BEFORE DELETE ON ticket_event
BEGIN
  SELECT RAISE(ABORT, 'ticket_event is append-only: DELETE is refused');
END;

-- What metrics.mjs consumes today, unchanged in shape: { id, from, to, ts }.
CREATE VIEW IF NOT EXISTS ticket_transition AS
  SELECT ticket_id AS id, from_status AS "from", to_status AS "to", at AS ts, actor, source
    FROM ticket_event WHERE kind = 'transition';
`;

/** Applied per connection: SQLite does not enforce foreign keys without it (V3). */
export const SQLITE_PRAGMAS = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
`;
