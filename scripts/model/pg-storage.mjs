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
import { checkDbSchema, createDbSchema } from "./db-schema-version.mjs";
import { readActivityFeed } from "./read-storage.mjs";
import { safeJson } from "./safe-json.mjs";

// BLZ-391 — kept identical to sqlite-storage.mjs's `toRecord` on purpose. A projection fixed in
// one driver and not the other IS the divergence driver-conformance.test.mjs exists to catch.
/** BLZ-679: `extra_json` — the frontmatter keys with no column — read back, as dbWritePort's own
 *  `read` already did. Without it every db-mode read DROPPED them, and the next write through
 *  the port (any `blaze edit`) persisted `{}` over them: measured, a `custom_key` loaded into the
 *  shadow was gone after one `blaze edit … priority high`. A corrupt value reads as empty —
 *  `safeJson`, the write port's own parser, shared so the three cannot drift. */
function toRecord(row, links, labels, components, worklog) {
  const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : (d ?? ""));
  return {
    frontmatter: {
      // Unknown keys first: `extraFields` never stores a key that has a column, so nothing
      // below can be shadowed, and the column values stay authoritative regardless.
      ...safeJson(row.extra_json),
      id: row.id, project: row.project_key, type: row.type, title: row.title,
      priority: row.priority, resolution: row.resolution ?? "",
      parent: row.parent_id ?? "", assignee: row.assignee,
      estimate: row.estimate_minutes ?? "", sprint: row.sprint_id ?? "",
      labels: labels ?? [], components: components ?? [],
      likelihood: row.likelihood ?? "", impact: row.impact ?? "",
      branch: row.branch ?? "", pr: row.pr ?? "",
      ref: row.ref ?? "", category: row.category ?? "",
      verification: row.verification ?? "", derived: row.derived ?? "",
      start: iso(row.start_date), due: iso(row.due_date),
      not_before: iso(row.constraint_start_no_earlier_than), deadline: iso(row.deadline),
      created: iso(row.created_on), updated: iso(row.updated_on),
      worklog: worklog ?? [],
      links: links ?? [],
    },
    body: row.body ?? "",
    project: row.project_key,
    status: row.status,
    file: row.id,   // an opaque handle, never a path — see BLZ-271
  };
}

// DATE COLUMNS ARE CAST TO text, and that is not cosmetic. `pg` decodes a Postgres
// `date` into a JS Date at LOCAL midnight, so 2026-01-01 read from Sydney serialises as
// "2025-12-31T13:00:00.000Z" — the ticket's created date moves a day backwards, and the
// direction depends on the reader's timezone. Blaze stores dates as plain YYYY-MM-DD
// strings with no time and no zone, so decoding them as instants is simply wrong.
// Casting in SQL keeps the fix local and explicit; a global pg type parser would reach
// into every other consumer of the `pg` module in the process.
const COLS = `id, project_key, num, type, status, title, priority, resolution,
              parent_id, parent_type, assignee, estimate_minutes, sprint_id,
              likelihood, impact, branch, pr, ref, category, verification, derived,
              start_date::text AS start_date, due_date::text AS due_date,
              constraint_start_no_earlier_than::text AS constraint_start_no_earlier_than,
              deadline::text AS deadline, body,
              created_on::text AS created_on, updated_on::text AS updated_on, version, extra_json`;
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

/** Run the rest of setup with `client` already connected, closing it if setup THROWS.
 *
 *  BLZ-534, one frame deeper than the conformance suite's `seedPg`. `openPostgresRead`
 *  connects and then runs `checkDbSchema` and, on an empty database, `createDbSchema`. Both
 *  of the explicit REFUSALS in there called `client.end()`; a throw did not, and either of
 *  those calls can throw for ordinary reasons — a connection dropped mid-query, a
 *  permissions error, DDL that collides. That left a live referenced TCP handle behind, and
 *  a Node process holding one of those cannot exit. That is BLZ-534's hang.
 *
 *  Exported because the guarantee is testable here and not testable through
 *  `openPostgresRead`, which needs a real server before it can reach the window at all. */
export async function closeOnSetupFailure(client, setup) {
  try {
    return await setup();
  } catch (error) {
    // Closing must not replace the reason we are closing.
    try { await client.end(); } catch { /* the connection is already gone */ }
    throw error;
  }
}

/**
 * @param opts.create  create the schema when the database is EMPTY. Default false.
 *
 * BLZ-297: this used to run PG_DDL unconditionally. Every statement is
 * `CREATE TABLE IF NOT EXISTS`, so a database written by an older engine connected
 * cleanly with its columns silently missing. It now checks and refuses.
 */
export async function openPostgresRead(connection, { create = false } = {}) {
  const pg = await loadPg();
  const client = new pg.Client(connection);
  await client.connect();

  const exec = {
    run: (sql, params = []) => client.query(sql, params.length ? params : undefined),
    all: async (sql, params = []) => (await client.query(sql, params.length ? params : undefined)).rows,
  };
  // BLZ-534: FROM HERE THE SOCKET IS LIVE, SO EVERY EXIT FROM SETUP MUST CLOSE IT.
  await closeOnSetupFailure(client, async () => {
    const state = await checkDbSchema(exec, { dialect: "postgres" });
    if (!state.ok) throw new Error(`blaze: ${state.error}`);
    if (state.state === "empty") {
      if (!create) {
        throw new Error(
          "blaze: this database has no Blaze schema. Create one explicitly rather than "
          + "having a read open silently write DDL — pass { create: true }, or run "
          + "'blaze db init'.");
      }
      await createDbSchema(exec, { dialect: "postgres" });
    }
  });

  return postgresReader(client);
}

/**
 * The Postgres reader itself, over an already-connected `client`. Synchronous
 * construction and no schema check — `openPostgresRead` already ran that (BLZ-297)
 * before handing the connected client here; a caller that constructs directly (the
 * batched-`listTickets` test, and later tasks) is expected to have checked first.
 *
 * BLZ-670: split out of `openPostgresRead` so a caller (a fake client in a test, or a
 * future pooled-connection path) can get a reader over a client it already holds,
 * without going through connect + schema-check again.
 */
export function postgresReader(client) {
  const linksFor = async (id) =>
    (await client.query(
      "SELECT link_type, target_id FROM ticket_link WHERE src_id = $1 ORDER BY link_type, target_id", [id]
    )).rows.map((l) => ({ type: l.link_type, target: l.target_id }));

  // Same child-table fetches as sqlite-storage.mjs, in the same order, for the same reason:
  // `ord` preserves what the operator wrote, and `worklog_entry` has no ord so it uses on_date.
  // BLZ-675: one query at a time. These were `Promise.all`s over ONE pg.Client — concurrent
  // `client.query()` calls on a single connection, which pg 8 queues but deprecates and pg 9 is
  // set to refuse. One connection runs one query at a time anyway, so awaiting each in turn
  // costs nothing; it only stops asking the client to queue.
  const childrenFor = async (id) => {
    const labels = await client.query("SELECT label FROM ticket_label WHERE ticket_id = $1 ORDER BY ord", [id]);
    const components = await client.query("SELECT component FROM ticket_component WHERE ticket_id = $1 ORDER BY ord", [id]);
    const worklog = await client.query("SELECT on_date::text AS on_date, minutes, note FROM worklog_entry WHERE ticket_id = $1 ORDER BY on_date, id", [id]);
    return [
      labels.rows.map((r) => r.label),
      components.rows.map((r) => r.component),
      worklog.rows.map((w) => ({
        date: w.on_date, minutes: w.minutes,
        // Same rule as sqlite-storage.mjs: omit `note` when NULL rather than inventing "".
        ...(w.note == null ? {} : { note: w.note }),
      })),
    ];
  };

  const hydrate = async (row) => {
    if (!row) return null;
    const links = await linksFor(row.id);
    const [labels, components, worklog] = await childrenFor(row.id);
    return toRecord(row, links, labels, components, worklog);
  };
  const hydrateAll = async (rows) => {
    const out = [];
    for (const row of rows) out.push(await hydrate(row));
    return out;
  };

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
      // Five queries for the whole corpus, not 1 + 4N. Ordered exactly as the per-id fetches
      // order them (links by type,target; labels/components by ord; worklog by on_date,id) —
      // driver-conformance.test.mjs pins the two paths against each other.
      const t = await client.query(`SELECT ${COLS} FROM ticket WHERE ${ALIVE} ORDER BY id`);
      const l = await client.query("SELECT src_id, link_type, target_id FROM ticket_link ORDER BY src_id, link_type, target_id");
      const lb = await client.query("SELECT ticket_id, label, ord FROM ticket_label ORDER BY ticket_id, ord");
      const cp = await client.query("SELECT ticket_id, component, ord FROM ticket_component ORDER BY ticket_id, ord");
      const wl = await client.query("SELECT ticket_id, on_date::text AS on_date, minutes, note FROM worklog_entry ORDER BY ticket_id, on_date, id");
      // Array.prototype.sort is stable, so rows without `ord` (links, worklog) keep SQL order.
      const group = (rows, key, map) => {
        const m = new Map();
        for (const r of [...rows].sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0))) {
          if (!m.has(r[key])) m.set(r[key], []);
          m.get(r[key]).push(map(r));
        }
        return m;
      };
      const links = group(l.rows, "src_id", (r) => ({ type: r.link_type, target: r.target_id }));
      const labels = group(lb.rows, "ticket_id", (r) => r.label);
      const comps = group(cp.rows, "ticket_id", (r) => r.component);
      const work = group(wl.rows, "ticket_id", (w) => ({ date: w.on_date, minutes: w.minutes,
        ...(w.note == null ? {} : { note: w.note }) }));
      return t.rows.map((row) => toRecord(row, links.get(row.id) ?? [], labels.get(row.id) ?? [],
        comps.get(row.id) ?? [], work.get(row.id) ?? []));
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

    // BLZ-680: the status-move history under BLAZE_WRITE_PORT=db, from the `ticket_transition`
    // view over `ticket_event` — the `{ id, from, to, ts }` shape metrics.mjs reads from git in
    // fs mode. `blaze db load` imports the git-era history into it, once.
    // Rows are ordered by the ts TEXT, which is not guaranteed chronological across mixed
    // offsets (`+10:00` vs `Z`): consumers sort by Date.parse(ts), as metrics.mjs does.
    async listTransitions(_root) {
      const { rows } = await client.query(`SELECT id, "from", "to", ts FROM ticket_transition ORDER BY ts, id`);
      return rows;
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

    // The feed is a hook-written LOCAL file on every board type (read-storage.mjs says why),
    // so the database driver answers it with the same filesystem read, not from a table.
    async activityFeed(dataRoot) { return readActivityFeed(dataRoot); },
    async unreadableTicketDirs(_root) { return []; },
  };
}
