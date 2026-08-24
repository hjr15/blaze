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



  -- ADR-0022: constraints are INPUTS, dates are DERIVED. start_date/due_date keep
  -- their names — no rename, so every reader keeps working — and what changes is who
  -- is allowed to write them. is_critical is a PLAIN column, never STORED/generated:
  -- ADR-0018 measured a 2,002 ms rewrite on Postgres and it is impossible on SQLite.
  constraint_start_no_earlier_than TEXT,
  deadline         TEXT,
  float_minutes    INTEGER,
  is_critical      INTEGER NOT NULL DEFAULT 0 CHECK (is_critical IN (0,1)),
  schedule_run_id  TEXT,
  -- BLZ-295. Eight fields the live corpus carries that had no column, found by the
  -- dual-write soak: 926 of 2,561 tickets (36.2%) held at least one, and every one of
  -- them would have been dropped at cutover.
  --
  --   branch/pr           reconcile's link to git       544 / 534 tickets
  --   ref                 REQ-nnn / ADR-nnnn designator        301
  --   category/verification/derived   requirement metadata     175 / 175 / 176
  --   likelihood/impact   risk fields, DECLARED REQUIRED for   80 / 80
  --                       type=risk and until now enforced by nothing
  branch       TEXT,
  pr           TEXT,
  ref          TEXT,
  category     TEXT,
  verification TEXT,
  derived      TEXT,
  likelihood   TEXT,
  impact       TEXT,

  -- The round-trip promise. Blaze has always preserved frontmatter keys it does not
  -- recognise; a fixed column set cannot, and silently dropping an unrecognised key on
  -- write is the exact failure the soak exists to prevent. Unknown keys live here so
  -- adding a field never requires a migration to avoid losing data.
  extra_json   TEXT NOT NULL DEFAULT '{}',

  body       TEXT NOT NULL DEFAULT '',
  created_on TEXT NOT NULL,
  updated_on TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at TEXT,
  ac_heading TEXT,   -- verbatim, so the section round-trips and the spelling survives

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
-- ADR-0022 §2.4: two of the five new columns are indexed, which is what makes them
-- filterable within ADR-0018's 200-per-INSTALL budget (not per table).
CREATE INDEX IF NOT EXISTS ticket_critical_idx ON ticket (is_critical);
CREATE INDEX IF NOT EXISTS ticket_deadline_idx ON ticket (deadline);

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

-- Acceptance criteria as ORDERED BLOCKS (design D6), not checkbox-only. 518 of 1972
-- AC sections hold prose, plain bullets or wrapped continuations; refusing them would
-- reject a quarter of the corpus. 'kind' is the discriminator and a note can never be
-- checked. See model/ac-blocks.mjs for the parser and the two measured findings that
-- shape it.
CREATE TABLE IF NOT EXISTS acceptance_criterion (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  ord       INTEGER NOT NULL CHECK (ord >= 0),
  kind      TEXT NOT NULL,
  text      TEXT NOT NULL,
  checked   INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0,1)),

  CONSTRAINT ac_kind_known CHECK (kind IN ('criterion','note')),
  CONSTRAINT ac_ord_unique UNIQUE (ticket_id, ord),
  -- a note is not checkable; the design makes this a constraint rather than a
  -- convention because the toggle path is where the old ordinal bug lived
  CONSTRAINT ac_note_not_checked CHECK (kind = 'criterion' OR checked = 0)
);
CREATE INDEX IF NOT EXISTS ac_ticket_idx ON acceptance_criterion (ticket_id, ord);

-- Worklog entries. Kept as rows rather than a JSON blob on the ticket (design D4:
-- no JSONB, multi-valued fields are join tables) so time roll-up is a SUM.
-- BLZ-294. Found by the dual-write soak against the live board: an edit that set
-- labels wrote to the file and NOTHING to the database, so every label and component on
-- 2,500 tickets would have been lost at cutover — silently, because a ticket with no
-- labels is a valid ticket.
--
-- No FK to resolved_label/resolved_component yet: those live in the projection, which
-- the base data schema must not depend on (the conformance suite builds this DDL
-- alone). The FK lands with the projection at Phase 2 cutover.
CREATE TABLE IF NOT EXISTS ticket_label (
  ticket_id   TEXT NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  project_key TEXT NOT NULL,
  label       TEXT NOT NULL,
  -- Authored order, preserved. The file keeps the order someone wrote; a plain
  -- ORDER BY name would re-emit 2,500 tickets with their taxonomy reshuffled at
  -- cutover — not data loss, but a diff on every ticket for no reason.
  ord         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ticket_id, label)
);

CREATE TABLE IF NOT EXISTS ticket_component (
  ticket_id   TEXT NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  project_key TEXT NOT NULL,
  component   TEXT NOT NULL,
  -- Authored order, preserved. The file keeps the order someone wrote; a plain
  -- ORDER BY name would re-emit 2,500 tickets with their taxonomy reshuffled at
  -- cutover — not data loss, but a diff on every ticket for no reason.
  ord         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ticket_id, component)
);

CREATE TABLE IF NOT EXISTS worklog_entry (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  on_date   TEXT NOT NULL,
  minutes   INTEGER NOT NULL CHECK (minutes > 0),
  note      TEXT
);
CREATE INDEX IF NOT EXISTS worklog_ticket_idx ON worklog_entry (ticket_id);

-- The heading is preserved verbatim so the section round-trips byte-exactly. 245
-- tickets use a heading a case-sensitive matcher never finds, so this column also
-- records WHICH spelling a ticket used rather than normalising it away.
-- (SQLite has no ADD COLUMN IF NOT EXISTS; the column is declared on ticket.)

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
