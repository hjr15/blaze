// scripts/model/projection-schema.mjs — the resolved_* projection (BLZ-287).
//
// Design D2. `blaze_config` holds the SPARSE, authored config, scoped `'*'` or per
// project. `resolved_*` holds the DENSE, per-project, scope-resolved result that ticket
// rows actually point at. Every foreign key in the system then reads
// data → data, never data → config.
//
// That is not a tidiness preference. SQLite cannot enforce a foreign key across
// ATTACHed files at all — it silently does nothing — so a cross-namespace FK would be
// enforced in Postgres and quietly absent in SQLite, which is the worst possible
// outcome: the same board rejects a write on the cluster and accepts it on a laptop.
//
// NAMESPACE. These tables are created alongside `ticket`, in whatever namespace the
// data tables live in, precisely so the FKs stay intra-schema. The `blaze_data`
// qualification lands when the data tables themselves move, at the Phase 2 cutover.
//
// resolved_status is keyed by (project, TYPE, status) rather than by workflow. That is
// deliberate denormalisation: it removes a join from the board render, which is the
// hottest predicate in the system, and it is what makes `ticket → status` expressible
// as a two-column FK against the ticket's own (project_key, type) at all.


import { dialect } from "./sql-dialect.mjs";
export function projectionDdl(name) {
  const d = dialect(name);
  return `
CREATE TABLE IF NOT EXISTS projection_meta (
  id             integer PRIMARY KEY CHECK (id = 1),
  config_version bigint  NOT NULL,
  refreshed_at   ${d.ts} NOT NULL
);

CREATE TABLE IF NOT EXISTS resolved_project (
  project_key text PRIMARY KEY,
  name        text NOT NULL,
  label_mode      text NOT NULL,
  component_mode  text NOT NULL,
  require_labels                  ${d.bool} NOT NULL,
  require_components              ${d.bool} NOT NULL,
  require_worklog_before_terminal ${d.bool} NOT NULL
);

CREATE TABLE IF NOT EXISTS resolved_type (
  project_key text NOT NULL,
  type        text NOT NULL,
  level       integer NOT NULL,
  workflow    text NOT NULL,
  ord         integer NOT NULL,
  PRIMARY KEY (project_key, type),
  FOREIGN KEY (project_key) REFERENCES resolved_project (project_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resolved_type_parent (
  project_key text NOT NULL,
  child_type  text NOT NULL,
  parent_type text NOT NULL,
  PRIMARY KEY (project_key, child_type, parent_type),
  FOREIGN KEY (project_key, child_type) REFERENCES resolved_type (project_key, type) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resolved_required_field (
  project_key text NOT NULL,
  type        text NOT NULL,
  field       text NOT NULL,
  PRIMARY KEY (project_key, type, field),
  FOREIGN KEY (project_key, type) REFERENCES resolved_type (project_key, type) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resolved_status (
  project_key text NOT NULL,
  type        text NOT NULL,
  status      text NOT NULL,
  ord         integer NOT NULL,
  is_terminal ${d.bool} NOT NULL,
  resolution_on_terminal text,
  PRIMARY KEY (project_key, type, status),
  FOREIGN KEY (project_key, type) REFERENCES resolved_type (project_key, type) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resolved_transition (
  project_key text NOT NULL,
  type        text NOT NULL,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  is_reopen   ${d.bool} NOT NULL DEFAULT ${d.false_},
  PRIMARY KEY (project_key, type, from_status, to_status),
  CHECK (from_status <> to_status),
  FOREIGN KEY (project_key, type, from_status) REFERENCES resolved_status (project_key, type, status) ON DELETE CASCADE,
  FOREIGN KEY (project_key, type, to_status)   REFERENCES resolved_status (project_key, type, status) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resolved_label (
  project_key text NOT NULL,
  name        text NOT NULL,
  PRIMARY KEY (project_key, name),
  FOREIGN KEY (project_key) REFERENCES resolved_project (project_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resolved_component (
  project_key text NOT NULL,
  name        text NOT NULL,
  PRIMARY KEY (project_key, name),
  FOREIGN KEY (project_key) REFERENCES resolved_project (project_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resolved_priority (
  name text PRIMARY KEY,
  ord  integer NOT NULL
);

CREATE TABLE IF NOT EXISTS resolved_resolution (
  name       text PRIMARY KEY,
  is_success ${d.bool} NOT NULL
);

CREATE TABLE IF NOT EXISTS resolved_link_type (
  name        text PRIMARY KEY,
  is_directed ${d.bool} NOT NULL,
  is_trace    ${d.bool} NOT NULL
);

CREATE INDEX IF NOT EXISTS resolved_status_board_idx ON resolved_status (project_key, type, ord);
`.trim() + "\n";
}

/** Every table the projection owns, in dependency order — safe to rebuild in this order. */
export const PROJECTION_TABLES = [
  "resolved_project", "resolved_type", "resolved_type_parent", "resolved_required_field",
  "resolved_status", "resolved_transition", "resolved_label", "resolved_component",
  "resolved_priority", "resolved_resolution", "resolved_link_type",
];
