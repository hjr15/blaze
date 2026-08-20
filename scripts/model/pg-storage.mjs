// scripts/model/pg-storage.mjs — the Postgres read driver (BLZ-282, ADR-0010).
//
// ASYNC, and that is the point of ADR-0010 rather than an accident. `pg` has no
// synchronous API, so this driver cannot satisfy a sync contract however much anyone
// would prefer it to. The transitional filesystem seam stays sync and is deleted at
// cutover; the v3 port is async from its first commit.
//
// The conformance suite that proves both drivers agree awaits every call. `await` on
// a plain value is a no-op, so the SAME assertions run unchanged against the sync
// SQLite driver and this one — which is what makes "one conformance suite across both
// drivers" a real property rather than two suites that happen to look alike.
//
// `pg` is an optionalDependency loaded through a dynamic import (design C2), so the
// npx + SQLite path installs nothing.
import { PG_DDL } from "./pg-schema.mjs";

function toRecord(row, links) {
  const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ?? ""));
  return {
    frontmatter: {
      id: row.id, project: row.project_key, type: row.type, title: row.title,
      priority: row.priority, resolution: row.resolution ?? "",
      parent: row.parent_id ?? "", assignee: row.assignee,
      estimate: row.estimate_minutes ?? "", sprint: row.sprint_id ?? "",
      start: iso(row.start_date), due: iso(row.due_date),
      created: iso(row.created_on), updated: iso(row.updated_on),
      links: links ?? [],
    },
    body: row.body ?? "",
    project: row.project_key,
    status: row.status,
    file: row.id,   // an opaque handle, never a path — see BLZ-271
  };
}

const COLS = `id, project_key, num, type, status, title, priority, resolution,
              parent_id, parent_type, assignee, estimate_minutes, sprint_id,
              start_date, due_date, body, created_on, updated_on, version`;
const ALIVE = "deleted_at IS NULL";

// `pg` is an OPTIONAL peer dependency: it is deliberately not installed for the
// majority of users, who run Blaze on files or SQLite and would otherwise carry a
// database client they never load. That makes "pg is absent" an ordinary, expected
// state rather than a broken install — so it has to read as a setup instruction, not
// as an ERR_MODULE_NOT_FOUND stack trace from inside a dynamic import.
async function loadPg() {
  try {
    return (await import("pg")).default;
  } catch (cause) {
    if (cause?.code !== "ERR_MODULE_NOT_FOUND") throw cause;
    throw new Error(
      "The Postgres driver needs the 'pg' package, which Blaze does not install by "
      + "default. Install it alongside Blaze to use a Postgres board:\n\n"
      + "    npm install pg\n\n"
      + "No other driver requires it — the filesystem and SQLite drivers work without.",
      { cause });
  }
}

export async function openPostgresRead(connection) {
  const pg = await loadPg();
  const client = new pg.Client(connection);
  await client.connect();
  await client.query(PG_DDL);

  const linksFor = async (id) =>
    (await client.query(
      "SELECT link_type, target_id FROM ticket_link WHERE src_id = $1 ORDER BY link_type, target_id", [id]
    )).rows.map((l) => ({ type: l.link_type, target: l.target_id }));

  const hydrate = async (row) => (row ? toRecord(row, await linksFor(row.id)) : null);
  const hydrateAll = async (rows) => Promise.all(rows.map(hydrate));

  return {
    name: "postgres",
    client,
    async close() { await client.end(); },

    async getTicket(_root, id) {
      const { rows } = await client.query(
        `SELECT ${COLS} FROM ticket WHERE id = $1 AND ${ALIVE}`, [id]);
      return { found: await hydrate(rows[0]) };
    },

    async listChildren(_root, parentId) {
      const { rows } = await client.query(
        `SELECT ${COLS} FROM ticket WHERE parent_id = $1 AND ${ALIVE} ORDER BY id`, [parentId]);
      return hydrateAll(rows);
    },

    async blockersOf(_root, id) {
      const { rows } = await client.query(
        `SELECT ${COLS.split(",").map((c) => "t." + c.trim()).join(", ")}
           FROM ticket_link l JOIN ticket t ON t.id = l.src_id
          WHERE l.target_id = $1 AND l.link_type = 'Blocks' AND t.id <> $1 AND t.${ALIVE}
          ORDER BY t.id`, [id]);
      return hydrateAll(rows);
    },

    async listTickets(_root) {
      const { rows } = await client.query(`SELECT ${COLS} FROM ticket WHERE ${ALIVE} ORDER BY id`);
      return hydrateAll(rows);
    },

    async listProjects(_root) {
      const { rows } = await client.query(
        `SELECT DISTINCT project_key k FROM ticket WHERE ${ALIVE} ORDER BY k`);
      return rows.map((r) => r.k);
    },

    async listEvents(_root, id) {
      const { rows } = await client.query(
        `SELECT id, ticket_id, kind, at, actor, source, request_id,
                from_status, to_status, field, old_value, new_value, detail
           FROM ticket_event WHERE ticket_id = $1 ORDER BY at, id`, [id]);
      // bigint arrives as a string from pg; the fold compares ids with >, so coerce.
      return rows.map((r) => ({ ...r, id: Number(r.id) }));
    },

    async appendEvent(_root, e) {
      await client.query(
        `INSERT INTO ticket_event
           (ticket_id, kind, at, actor, source, request_id, from_status, to_status,
            field, old_value, new_value, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [e.ticket_id, e.kind, e.at ?? new Date().toISOString(), e.actor ?? "unknown",
         e.source ?? "cli", e.request_id ?? null, e.from_status ?? null, e.to_status ?? null,
         e.field ?? null, e.old_value ?? null, e.new_value ?? null, e.detail ?? null]);
    },

    // SQLite gets PRAGMA data_version for free; Postgres has no equivalent, so the
    // token is the aggregate alone. Both are opaque to the caller, which is exactly
    // why the operation was named rather than exposing a mechanism.
    async changeToken(_root, { project = null } = {}) {
      const { rows } = await client.query(
        `SELECT COUNT(*)::int n, COALESCE(SUM(version),0)::int v,
                COALESCE(MAX(updated_on)::text,'') u
           FROM ticket WHERE ${ALIVE} AND ($1::text IS NULL OR project_key = $1)`, [project]);
      const s = rows[0];
      return `${s.n}:${s.v}:${s.u}`;
    },
  };
}
