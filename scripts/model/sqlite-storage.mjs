// scripts/model/sqlite-storage.mjs — a SQLite read driver (BLZ-277, ADR-0009).
//
// The point of the whole read-seam exercise, made concrete: this satisfies exactly
// the named operations in read-storage.mjs, so every consumer already routed through
// the seam works against a database with no further change.
//
// Where the filesystem driver walks 2,534 files, this asks an index. Measured on the
// live corpus: resolving one ticket by id is 22.7 ms walking versus 0.039 ms indexed.
//
// Records are shaped like the filesystem driver's — { frontmatter, body, project,
// status, file } — because that is the contract the consumers were written against.
// `file` is a driver-owned opaque handle here, never a path: BLZ-271 removed the last
// caller that did path arithmetic on it, and ticketPath.relocate() now REFUSES an
// unrecognised handle rather than guessing, so a bogus destination fails loudly.
import { DatabaseSync } from "node:sqlite";
import { SQLITE_PRAGMAS } from "./sqlite-schema.mjs";
import { judgeDbSchema, readSchemaFactsSync, createDbSchemaSync } from "./db-schema-version.mjs";

/** Rebuild the record shape the seam's consumers expect from a ticket row. */
function toRecord(row, links) {
  const frontmatter = {
    id: row.id, project: row.project_key, type: row.type, title: row.title,
    priority: row.priority, resolution: row.resolution ?? "",
    parent: row.parent_id ?? "", assignee: row.assignee,
    estimate: row.estimate_minutes ?? "", sprint: row.sprint_id ?? "",
    start: row.start_date ?? "", due: row.due_date ?? "",
    created: row.created_on, updated: row.updated_on,
    links: links ?? [],
  };
  return {
    frontmatter, body: row.body ?? "",
    project: row.project_key, status: row.status,
    // Opaque handle, deliberately not a path. See BLZ-271.
    file: row.id,
  };
}

/**
 * @param path   database file, or ":memory:"
 * @param opts.create  create the schema when the database is EMPTY. Default false.
 *
 * BLZ-297: this used to exec the DDL unconditionally, and every statement is
 * `CREATE TABLE IF NOT EXISTS` — so a database written by an older engine opened
 * cleanly with its columns silently missing. Opening now CHECKS, and refuses anything
 * this engine cannot read. Creation is opt-in and only ever applies to an empty
 * database; `createDbSchema` refuses the rest.
 */
export function openSqliteRead(path = ":memory:", { create = false } = {}) {
  const db = new DatabaseSync(path);
  db.exec(SQLITE_PRAGMAS);

  const exec = {
    run(sql, params = []) { return params.length ? db.prepare(sql).run(...params) : db.exec(sql); },
    all(sql, params = []) { return db.prepare(sql).all(...params); },
  };
  // The JUDGEMENT is pure and shared with the Postgres driver; only the fetch differs.
  // An async guard cannot serve a sync driver at all — `.then` always defers to a
  // microtask — so the split is structural, not stylistic.
  const state = judgeDbSchema(readSchemaFactsSync(exec));
  if (!state.ok) { db.close(); throw new Error(`blaze: ${state.error}`); }
  if (state.state === "empty") {
    if (!create) {
      db.close();
      throw new Error(
        "blaze: this database has no Blaze schema. Create one explicitly rather than "
        + "having a read open silently write DDL — pass { create: true }, or run "
        + "'blaze db init'.");
    }
    createDbSchemaSync(exec);
  }

  const linksFor = db.prepare(
    "SELECT link_type, target_id FROM ticket_link WHERE src_id = ? ORDER BY link_type, target_id");
  const hydrate = (row) => row && toRecord(row,
    linksFor.all(row.id).map((l) => ({ type: l.link_type, target: l.target_id })));

  const COLS = `id, project_key, num, type, status, title, priority, resolution,
                parent_id, parent_type, assignee, estimate_minutes, sprint_id,
                start_date, due_date, body, created_on, updated_on, version`;
  const ALIVE = "deleted_at IS NULL";

  const byId       = db.prepare(`SELECT ${COLS} FROM ticket WHERE id = ? AND ${ALIVE}`);
  const byParent   = db.prepare(`SELECT ${COLS} FROM ticket WHERE parent_id = ? AND ${ALIVE} ORDER BY id`);
  const allRows    = db.prepare(`SELECT ${COLS} FROM ticket WHERE ${ALIVE} ORDER BY id`);
  const projects   = db.prepare(`SELECT DISTINCT project_key k FROM ticket WHERE ${ALIVE} ORDER BY k`);
  const blockers   = db.prepare(
    `SELECT t.id, t.project_key, t.num, t.type, t.status, t.title, t.priority, t.resolution,
            t.parent_id, t.parent_type, t.assignee, t.estimate_minutes, t.sprint_id,
            t.start_date, t.due_date, t.body, t.created_on, t.updated_on, t.version
       FROM ticket_link l JOIN ticket t ON t.id = l.src_id
      WHERE l.target_id = ? AND l.link_type = 'Blocks' AND t.id <> ? AND t.${ALIVE}
      ORDER BY t.id`);
  const eventsFor = db.prepare(
    `SELECT id, ticket_id, kind, at, actor, source, request_id,
            from_status, to_status, field, old_value, new_value, detail
       FROM ticket_event WHERE ticket_id = ? ORDER BY at, id`);
  const appendEv = db.prepare(
    `INSERT INTO ticket_event
       (ticket_id, kind, at, actor, source, request_id, from_status, to_status,
        field, old_value, new_value, detail)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const dataVersion = db.prepare("PRAGMA data_version");
  const rowStamp = db.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(version),0) v, COALESCE(MAX(updated_on),'') u
       FROM ticket WHERE ${ALIVE} AND (? IS NULL OR project_key = ?)`);

  return {
    name: "sqlite",
    db,   // exposed for the loader and for tests; consumers never touch it

    getTicket(_root, id) {
      // id is the PRIMARY KEY, so the filesystem's duplicate case is structurally
      // unreachable — not merely absent. The contract still returns the same shape.
      const found = hydrate(byId.get(id));
      return { found: found ?? null };
    },

    listChildren(_root, parentId) {
      return byParent.all(parentId).map(hydrate);
    },

    blockersOf(_root, id) {
      return blockers.all(id, id).map(hydrate);
    },

    listTickets(_root) {
      return allRows.all().map(hydrate)[Symbol.iterator]();
    },

    listProjects(_root) {
      return projects.all().map((r) => r.k);
    },

    // `PRAGMA data_version` only changes when ANOTHER connection commits, so it
    // cannot see this connection's own writes. Combining it with a cheap aggregate
    // over the rows covers both, and the aggregate is what makes the token
    // project-scopable — which the poll requires.
    // The audit trail. Ordered by (at, id) rather than id alone: a migration can
    // import events whose real timestamps predate rows already inserted, and the
    // history a reader wants is chronological, not insertion order.
    listEvents(_root, id) {
      return eventsFor.all(id);
    },

    appendEvent(_root, e) {
      appendEv.run(
        e.ticket_id, e.kind, e.at ?? new Date().toISOString(),
        e.actor ?? "unknown", e.source ?? "cli", e.request_id ?? null,
        e.from_status ?? null, e.to_status ?? null,
        e.field ?? null, e.old_value ?? null, e.new_value ?? null,
        e.detail ?? null);
    },

    changeToken(_root, { project = null } = {}) {
      const dv = dataVersion.get();
      const s = rowStamp.get(project, project);
      return `${Object.values(dv)[0]}:${s.n}:${s.v}:${s.u}`;
    },
  };
}
