// scripts/model/pg-schema.mjs — the same schema, Postgres dialect (BLZ-282).
//
// The design's section 2 promises the two drivers share one SQL string per operation.
// That is nearly true and the exceptions are worth naming precisely, because "nearly"
// is where dual-driver projects rot.
//
// What actually differs, measured rather than assumed:
//
//   identity      INTEGER PRIMARY KEY AUTOINCREMENT  vs  bigint GENERATED ALWAYS AS IDENTITY
//   shape checks  GLOB                               vs  ~ (regex)
//   trim          length(trim(x)) > 0                vs  btrim(x) <> ''
//   instants      TEXT ISO-8601                      vs  timestamptz
//   booleans      INTEGER 0/1                        vs  boolean
//   append-only   SQL trigger + RAISE(ABORT)         vs  PL/pgSQL function + trigger
//   placeholders  ?                                  vs  $1
//
// Seven divergences, four of which the design's register did not list. Everything
// else — the tables, the columns, the FKs, the indexes, the partial index, the view —
// is identical text.
export const PG_DDL = `
CREATE TABLE IF NOT EXISTS ticket (
  id          text PRIMARY KEY,
  project_key text NOT NULL,
  num         integer NOT NULL CHECK (num > 0),
  type     text NOT NULL,
  status   text NOT NULL,
  title    text NOT NULL CHECK (btrim(title) <> ''),
  priority text NOT NULL DEFAULT 'medium',
  resolution text,
  parent_id   text,
  parent_type text,
  assignee    text NOT NULL DEFAULT 'unassigned',
  estimate_minutes integer CHECK (estimate_minutes IS NULL
                                  OR (estimate_minutes > 0 AND estimate_minutes % 5 = 0)),
  sprint_id  text,
  start_date date,
  due_date   date,

  -- ADR-0022: constraints are INPUTS, dates are DERIVED. start_date/due_date keep their
  -- names — no rename, so every reader keeps working — and what changes is who may write
  -- them. The two new date columns take the date type to match their neighbours rather than
  -- text: this repo's own precedent is 32 conformance assertions that missed a Postgres date
  -- bug because not one compared a date value. is_critical is a PLAIN column, never a STORED
  -- generated one — ADR-0018 measured a 2,002 ms rewrite on Postgres for that.
  constraint_start_no_earlier_than date,
  deadline         date,
  float_minutes    integer,
  is_critical      boolean NOT NULL DEFAULT false,
  schedule_run_id  text,

  -- BLZ-295. Eight fields the live corpus carries that had no column, found by the
  -- dual-write soak: 926 of 2,561 tickets (36.2%) held at least one, and every one of
  -- them would have been dropped at cutover.
  --
  --   branch/pr           reconcile's link to git       544 / 534 tickets
  --   ref                 REQ-nnn / ADR-nnnn designator        301
  --   category/verification/derived   requirement metadata     175 / 175 / 176
  --   likelihood/impact   risk fields, DECLARED REQUIRED for   80 / 80
  --                       type=risk and until now enforced by nothing
  branch       text,
  pr           text,
  ref          text,
  category     text,
  verification text,
  derived      text,
  likelihood   text,
  impact       text,

  -- The round-trip promise. Blaze has always preserved frontmatter keys it does not
  -- recognise; a fixed column set cannot, and silently dropping an unrecognised key on
  -- write is the exact failure the soak exists to prevent. Unknown keys live here so
  -- adding a field never requires a migration to avoid losing data.
  extra_json   text NOT NULL DEFAULT '{}',

  body       text NOT NULL DEFAULT '',
  created_on date NOT NULL,
  updated_on date NOT NULL,
  version    integer NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  ac_heading text,
  CONSTRAINT ticket_id_is_key_and_num CHECK (id = project_key || '-' || CAST(num AS text)),
  CONSTRAINT ticket_num_unique UNIQUE (project_key, num),
  CONSTRAINT ticket_parent_pair_present CHECK ((parent_id IS NULL) = (parent_type IS NULL)),
  CONSTRAINT ticket_not_own_parent CHECK (parent_id IS DISTINCT FROM id),
  CONSTRAINT ticket_project_key_shape CHECK (project_key ~ '^[A-Z][A-Z0-9]*$')
);
CREATE INDEX IF NOT EXISTS ticket_parent_idx ON ticket (parent_id);
CREATE INDEX IF NOT EXISTS ticket_board_idx  ON ticket (project_key, status, type);
-- ADR-0022 §2.4: two of the five new columns are indexed, which is what makes them
-- filterable within ADR-0018's 200-per-INSTALL budget (not per table).
CREATE INDEX IF NOT EXISTS ticket_critical_idx ON ticket (is_critical);
CREATE INDEX IF NOT EXISTS ticket_deadline_idx ON ticket (deadline);

CREATE TABLE IF NOT EXISTS ticket_link (
  src_id    text NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  link_type text NOT NULL,
  target_id text NOT NULL,
  PRIMARY KEY (src_id, link_type, target_id)
);
CREATE INDEX IF NOT EXISTS link_target_idx ON ticket_link (target_id, link_type);

CREATE TABLE IF NOT EXISTS acceptance_criterion (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id text NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  ord       integer NOT NULL CHECK (ord >= 0),
  kind      text NOT NULL,
  text      text NOT NULL,
  checked   boolean NOT NULL DEFAULT false,
  CONSTRAINT ac_kind_known CHECK (kind IN ('criterion','note')),
  CONSTRAINT ac_ord_unique UNIQUE (ticket_id, ord),
  CONSTRAINT ac_note_not_checked CHECK (kind = 'criterion' OR checked = false)
);
CREATE INDEX IF NOT EXISTS ac_ticket_idx ON acceptance_criterion (ticket_id, ord);

-- BLZ-294. Found by the dual-write soak against the live board: an edit that set
-- labels wrote to the file and NOTHING to the database, so every label and component on
-- 2,500 tickets would have been lost at cutover — silently, because a ticket with no
-- labels is a valid ticket.
--
-- No FK to resolved_label/resolved_component yet: those live in the projection, which
-- the base data schema must not depend on (the conformance suite builds this DDL
-- alone). The FK lands with the projection at Phase 2 cutover.
CREATE TABLE IF NOT EXISTS ticket_label (
  ticket_id   text NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  project_key text NOT NULL,
  label       text NOT NULL,
  -- Authored order, preserved. The file keeps the order someone wrote; a plain
  -- ORDER BY name would re-emit 2,500 tickets with their taxonomy reshuffled at
  -- cutover — not data loss, but a diff on every ticket for no reason.
  ord         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ticket_id, label)
);

CREATE TABLE IF NOT EXISTS ticket_component (
  ticket_id   text NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  project_key text NOT NULL,
  component   text NOT NULL,
  -- Authored order, preserved. The file keeps the order someone wrote; a plain
  -- ORDER BY name would re-emit 2,500 tickets with their taxonomy reshuffled at
  -- cutover — not data loss, but a diff on every ticket for no reason.
  ord         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ticket_id, component)
);

CREATE TABLE IF NOT EXISTS worklog_entry (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id text NOT NULL REFERENCES ticket (id) ON DELETE CASCADE,
  on_date   date NOT NULL,
  minutes   integer NOT NULL CHECK (minutes > 0),
  note      text
);
CREATE INDEX IF NOT EXISTS worklog_ticket_idx ON worklog_entry (ticket_id);

CREATE TABLE IF NOT EXISTS ticket_event (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id text NOT NULL REFERENCES ticket (id) ON DELETE RESTRICT,
  kind      text NOT NULL,
  at        text NOT NULL,
  actor     text NOT NULL DEFAULT 'unknown',
  source    text NOT NULL,
  request_id  text,
  from_status text,
  to_status   text,
  field     text,
  old_value text,
  new_value text,
  detail    text,
  CONSTRAINT event_kind_known CHECK (kind IN (
    'create','transition','edit','resolve','link-add','link-remove',
    'worklog','ac-toggle','ac-edit','sprint-assign','delete','restore','import')),
  CONSTRAINT event_source_known CHECK (source IN ('cli','api','loop','migration','git-backfill')),
  CONSTRAINT event_transition_shape CHECK (
    (kind = 'transition') = (from_status IS NOT NULL AND to_status IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS event_ticket_at_idx  ON ticket_event (ticket_id, at);
CREATE INDEX IF NOT EXISTS event_at_idx         ON ticket_event (at);
CREATE INDEX IF NOT EXISTS event_transition_idx ON ticket_event (at, ticket_id)
  WHERE kind = 'transition';

-- V13's genuine per-dialect cost, and the whole of it: SQLite says
-- CREATE TRIGGER … BEGIN SELECT RAISE(ABORT, …); END, Postgres needs a function.
CREATE OR REPLACE FUNCTION ticket_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ticket_event is append-only: % is refused', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ticket_event_no_update ON ticket_event;
CREATE TRIGGER ticket_event_no_update BEFORE UPDATE ON ticket_event
  FOR EACH ROW EXECUTE FUNCTION ticket_event_append_only();
DROP TRIGGER IF EXISTS ticket_event_no_delete ON ticket_event;
CREATE TRIGGER ticket_event_no_delete BEFORE DELETE ON ticket_event
  FOR EACH ROW EXECUTE FUNCTION ticket_event_append_only();

CREATE OR REPLACE VIEW ticket_transition AS
  SELECT ticket_id AS id, from_status AS "from", to_status AS "to", at AS ts, actor, source
    FROM ticket_event WHERE kind = 'transition';
`;
