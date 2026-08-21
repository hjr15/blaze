// scripts/model/write-port.mjs — the v3 write port, and the reversible half of the
// cutover (BLZ-293).
//
// WHAT THIS IS NOT. It is not a database driver behind `storage.mjs`'s
// exists/read/write/move. That seam is path-keyed blob I/O, and its own header says
// the v3 port shares ZERO methods with it. Implementing a SQLite driver against
// `write(file, text)` would build the wrong contract and then have to be unbuilt.
//
// WHAT IT IS. A LOGICAL port: verbs describe the ticket they want persisted — id,
// project, status, frontmatter, body — and the adapter decides where that lives. The
// filesystem adapter derives a path via `ticketPath`; the database adapter has no path
// at all. Removing path-keying from the caller is the same correction BLZ-271 made,
// applied one level up.
//
// WHY A FLAG, AND WHY IT DEFAULTS TO FILESYSTEM. Cutting the live board over to a
// database is not reversible by editing code — it is reversible by restoring a backup.
// So the cutover is split: this lands the seam, the database adapter, and a dual-write
// mode that PROVES the two agree on every operation, while the default stays exactly
// where it is. Flipping the default then becomes a one-line decision backed by
// evidence, taken deliberately in Phase 2 (BLZ-254), rather than a leap.
import { ticketPath, fsStorage } from "./storage.mjs";
import { serializeTicket } from "./ticket.mjs";

/** The value-level identity of a ticket. Paths and byte order are deliberately absent. */
export function ticketValue(rec) {
  if (!rec) return null;
  const fm = { ...(rec.frontmatter ?? {}) };
  // `links` is compared as a set of pairs: the database returns them ordered by
  // (type, target) and a file preserves authored order. Order is not a value.
  const links = (fm.links ?? []).map((l) => `${l.type}:${l.target}`).sort();
  delete fm.links;
  // Empty string and absent are the same absence. A file writes `parent:` with nothing
  // after it; a database stores NULL. Treating those as different would report a
  // divergence on every ticket without a parent.
  const norm = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v === "" || v === null || v === undefined) continue;
    norm[k] = typeof v === "number" ? String(v) : v;
  }
  return {
    id: rec.frontmatter?.id ?? null,
    project: rec.project ?? null,
    status: rec.status ?? null,
    body: String(rec.body ?? "").trim(),
    frontmatter: norm,
    links,
  };
}

/** Filesystem adapter — today's behaviour, byte for byte. */
export function fsWritePort(projectsDir, storage = fsStorage) {
  return {
    name: "fs",
    write({ project, status, frontmatter, body, currentFile }) {
      const text = serializeTicket({ frontmatter, body });
      // An existing ticket keeps its filename: `blaze edit` has never renamed one, and
      // recomputing the slug from a changed title would rename 60 tickets on this board.
      const file = currentFile
        ?? ticketPath(projectsDir, project, status, frontmatter.id, frontmatter.title);
      storage.write(file, text);
      return { file };
    },
    move({ project, status, frontmatter, body, currentFile }) {
      const text = serializeTicket({ frontmatter, body });
      const { file } = ticketPath.relocate(projectsDir, project, status, currentFile);
      storage.move(currentFile, file, text);
      return { file, fromFile: currentFile };
    },
    // getTicket returns { found, duplicates? } — an envelope, not the record. Reading
    // it as the record made every dual-write comparison see "primary absent" and report
    // a divergence on every field, which looks exactly like a broken database adapter.
    read(id, { readStorage }) {
      return readStorage.getTicket(projectsDir, id)?.found ?? null;
    },
    close() {},
  };
}

const ENC = (v, pg) => (typeof v === "boolean" ? (pg ? v : (v ? 1 : 0)) : v);

/**
 * Database adapter. `exec` is the same {run, all} shape the projection uses, so it
 * works against SQLite synchronously and Postgres asynchronously without a second
 * implementation — ADR-0010's async port doing the job it was chosen for.
 */
export function dbWritePort(exec, { dialect = "sqlite" } = {}) {
  if (dialect !== "sqlite" && dialect !== "postgres") {
    throw new Error(`unknown dialect ${JSON.stringify(dialect)} — expected 'sqlite' or 'postgres'`);
  }
  const pg = dialect === "postgres";
  const ph = (i) => (pg ? `$${i + 1}` : "?");

  const num = (id) => {
    const n = Number(String(id).split("-").pop());
    if (!Number.isInteger(n) || n <= 0) throw new Error(`cannot derive num from id ${JSON.stringify(id)}`);
    return n;
  };
  const est = (v) => {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const nz = (v) => (v === "" || v === undefined ? null : v);

  async function persist({ project, status, frontmatter: fm, body }) {
    const id = fm.id;
    const cols = ["id", "project_key", "num", "type", "status", "title", "priority", "resolution",
                  "parent_id", "parent_type", "assignee", "estimate_minutes", "sprint_id",
                  "start_date", "due_date", "body", "created_on", "updated_on"];
    const vals = [id, project, num(id), fm.type, status, fm.title, fm.priority || "medium",
                  nz(fm.resolution), nz(fm.parent), nz(fm.parentType), fm.assignee || "unassigned",
                  est(fm.estimate), nz(fm.sprint), nz(fm.start), nz(fm.due), body ?? "",
                  fm.created, fm.updated];
    // `excluded.<col>` rather than a second set of placeholders. SQLite's `?` is
    // POSITIONAL, so repeating the columns in the SET clause would silently consume
    // parameters past the end of the list — which is how this first went in, and it
    // surfaced as "NOT NULL constraint failed: ticket.project_key" rather than as
    // anything resembling the actual mistake.
    const set = cols.slice(1).map((c) => `${c} = excluded.${c}`).join(", ");
    await exec.run(
      `INSERT INTO ticket (${cols.join(", ")}) VALUES (${cols.map((_, i) => ph(i)).join(", ")})
       ON CONFLICT (id) DO UPDATE SET ${set}`, vals);

    await exec.run(`DELETE FROM ticket_link WHERE src_id = ${ph(0)}`, [id]);
    for (const l of fm.links ?? []) {
      if (!l?.type || !l?.target) continue;
      await exec.run(
        `INSERT INTO ticket_link (src_id, link_type, target_id) VALUES (${ph(0)}, ${ph(1)}, ${ph(2)})`,
        [id, l.type, l.target]);
    }
    return { file: id };   // an opaque handle, never a path — BLZ-271
  }

  return {
    name: "db",
    async write(t) { return persist(t); },
    async move(t) { const r = await persist(t); return { ...r, fromFile: t.currentFile }; },
    async read(id) {
      // `::text` on every date column in Postgres — see the note in pg-storage.mjs.
      // `pg` decodes a `date` into a JS Date at LOCAL midnight, moving 2026-01-01 to
      // "2025-12-31T13:00:00.000Z" when read from Sydney. Dual-write caught this;
      // 32 conformance assertions had not, because none of them compared a date.
      const d = (c) => (pg ? `${c}::text AS ${c}` : c);
      const rows = await exec.all(
        `SELECT id, project_key, num, type, status, title, priority, resolution, parent_id,
                parent_type, assignee, estimate_minutes, sprint_id,
                ${d("start_date")}, ${d("due_date")}, body,
                ${d("created_on")}, ${d("updated_on")}
           FROM ticket WHERE id = ${ph(0)} AND deleted_at IS NULL`, [id]);
      if (!rows?.length) return null;
      const r = rows[0];
      const links = (await exec.all(
        `SELECT link_type, target_id FROM ticket_link WHERE src_id = ${ph(0)}
          ORDER BY link_type, target_id`, [id])) ?? [];
      return {
        frontmatter: {
          id: r.id, project: r.project_key, type: r.type, title: r.title,
          priority: r.priority, resolution: r.resolution ?? "",
          parent: r.parent_id ?? "", assignee: r.assignee,
          estimate: r.estimate_minutes ?? "", sprint: r.sprint_id ?? "",
          start: r.start_date ?? "", due: r.due_date ?? "",
          created: r.created_on, updated: r.updated_on,
          links: links.map((l) => ({ type: l.link_type, target: l.target_id })),
        },
        body: r.body ?? "", project: r.project_key, status: r.status, file: r.id,
      };
    },
    close() {},
  };
}

/**
 * Dual-write: the primary decides the outcome, the shadow is written and then COMPARED.
 *
 * The comparison is on VALUES, not bytes — `serializeTicket` normalises frontmatter to
 * FIELD_ORDER while on-disk files preserve authored order, so 137 of 2,534 tickets
 * already fail byte-identity today with zero value mismatches (BLZ-281). A byte
 * comparison here would report a divergence on 5.4% of the corpus for a reason that has
 * nothing to do with the database, and a check that cries wolf gets switched off.
 *
 * A divergence does NOT fail the verb by default. The primary is still the filesystem;
 * refusing a legitimate write because a shadow disagreed would make the safety net the
 * outage. `onDivergence` receives every one, and `strict: true` turns it into a throw
 * for tests and for the pre-cutover soak.
 */
export function dualWritePort(primary, shadow, { onDivergence, strict = false } = {}) {
  const divergences = [];
  const record = (op, id, detail) => {
    const d = { op, id, ...detail };
    divergences.push(d);
    onDivergence?.(d);
    if (strict) {
      throw new Error(
        `dual-write divergence on ${op} ${id}: ${JSON.stringify(detail, null, 2)}`);
    }
  };

  async function both(op, t, ctx) {
    const result = await primary[op](t, ctx);
    let shadowFailed = null;
    try {
      await shadow[op](t, ctx);
    } catch (e) {
      // A shadow that throws must never take the primary down with it.
      shadowFailed = e;
      record(op, t.frontmatter?.id, { shadowError: String(e?.message ?? e) });
    }
    if (!shadowFailed) {
      const id = t.frontmatter?.id;
      const a = ticketValue(await primary.read(id, ctx));
      const b = ticketValue(await shadow.read(id, ctx));
      const diff = valueDiff(a, b);
      if (diff.length) record(op, id, { fields: diff });
    }
    return result;
  }

  return {
    name: `dual(${primary.name}->${shadow.name})`,
    divergences,
    write(t, ctx) { return both("write", t, ctx); },
    move(t, ctx) { return both("move", t, ctx); },
    read(id, ctx) { return primary.read(id, ctx); },
    close() { primary.close?.(); shadow.close?.(); },
  };
}

/** Field-level difference between two ticket values. Empty means they agree. */
export function valueDiff(a, b) {
  const out = [];
  if (!a || !b) return [{ field: "<record>", primary: a ? "present" : "absent",
                          shadow: b ? "present" : "absent" }];
  for (const k of ["id", "project", "status", "body"]) {
    if (a[k] !== b[k]) out.push({ field: k, primary: a[k], shadow: b[k] });
  }
  if (a.links.join("|") !== b.links.join("|")) {
    out.push({ field: "links", primary: a.links, shadow: b.links });
  }
  const keys = new Set([...Object.keys(a.frontmatter), ...Object.keys(b.frontmatter)]);
  for (const k of keys) {
    if (a.frontmatter[k] !== b.frontmatter[k]) {
      out.push({ field: `frontmatter.${k}`, primary: a.frontmatter[k], shadow: b.frontmatter[k] });
    }
  }
  return out;
}

/**
 * Which port a verb should use. THE DEFAULT IS THE FILESYSTEM and changing that is a
 * Phase 2 decision, not a configuration accident — so an unrecognised value is an
 * error rather than a silent fallback in either direction.
 */
export const WRITE_PORT_ENV = "BLAZE_WRITE_PORT";

export function selectWritePort({ projectsDir, storage, db, dialect, env = process.env } = {}) {
  const choice = (env[WRITE_PORT_ENV] ?? "fs").trim();
  if (choice === "fs") return fsWritePort(projectsDir, storage);
  if (choice === "dual") {
    if (!db) throw new Error(`${WRITE_PORT_ENV}=dual needs a database — none was provided`);
    return dualWritePort(fsWritePort(projectsDir, storage), dbWritePort(db, { dialect }));
  }
  if (choice === "db") {
    if (!db) throw new Error(`${WRITE_PORT_ENV}=db needs a database — none was provided`);
    return dbWritePort(db, { dialect });
  }
  throw new Error(
    `${WRITE_PORT_ENV}=${JSON.stringify(choice)} is not a write port — expected 'fs', 'dual' or 'db'. `
    + `Leaving it unset uses 'fs', which is the filesystem behaviour Blaze has always had.`);
}
