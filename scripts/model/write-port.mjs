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
import { roundEstimate } from "./time.mjs";
import { serializeTicket } from "./ticket.mjs";
import { fsReadStorage } from "./read-storage.mjs";

/** A corrupt extra_json must not take the whole read down — report empty, never throw. */
function safeJson(text) {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** Stable stringify: object keys sorted, array order preserved. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${k}:${canonical(v[k])}`).join(",")}}`;
  }
  return v === null || v === undefined ? "" : String(v);
}

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
    if (Array.isArray(v) && v.length === 0) continue;   // [] and absent are one absence
    // Arrays and objects — worklog, components, labels — are compared by CANONICAL
    // value, not by reference. `!==` on two arrays is always true, so without this
    // every array field reported a divergence on every write; and a plain
    // JSON.stringify would report one whenever the two sides happened to emit an
    // entry's keys in a different order, which a file and a database routinely do.
    norm[k] = typeof v === "object" ? canonical(v) : (typeof v === "number" ? String(v) : v);
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
export function fsWritePort(projectsDir, storage = fsStorage, readStorage = fsReadStorage) {
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
    // `blaze new` refuses to overwrite. On a filesystem that question is "is there a
    // file at this path"; in a database it is "is there a row with this id". Same
    // guard, different question — which is exactly why it belongs to the adapter and
    // not to the verb.
    exists({ project, status, frontmatter }) {
      return storage.exists(
        ticketPath(projectsDir, project, status, frontmatter.id, frontmatter.title));
    },
    // getTicket returns { found, duplicates? } — an envelope, not the record. Reading
    // it as the record made every dual-write comparison see "primary absent" and report
    // a divergence on every field, which looks exactly like a broken database adapter.
    //
    // The read driver defaults rather than being required from a context: verbs call
    // `write(target)` with no second argument, and demanding one here would have made
    // dual-write unusable from exactly the place it matters most.
    read(id, ctx) {
      return (ctx?.readStorage ?? readStorage).getTicket(projectsDir, id)?.found ?? null;
    },
    close() {},
  };
}

const ENC = (v, pg) => (typeof v === "boolean" ? (pg ? v : (v ? 1 : 0)) : v);

/**
 * Frontmatter keys with a real column, and therefore NOT part of extra_json.
 *
 * One list, used by both the write and the read side. Two lists would drift, and the
 * drift is invisible: a key in neither list is dropped, a key in both is stored twice
 * and the second write wins.
 */
export const COLUMN_FIELDS = new Set([
  "id", "project", "type", "title", "priority", "resolution", "parent", "assignee",
  "estimate", "sprint", "start", "due", "created", "updated",
  // BLZ-391/BLZ-393: ADR-0022's two constraint fields. Missing here, they landed in a dedicated
  // COLUMN *and* in extra_json — and this file's own comment above says what that costs: "a key
  // in both is stored twice and the second write wins", which made the two readers disagree.
  "not_before", "deadline",
  "links", "labels", "components", "worklog",
  "branch", "pr", "ref", "category", "verification", "derived", "likelihood", "impact",
]);

/** Everything else — preserved verbatim so the round-trip promise survives. */
export function extraFields(fm) {
  const out = {};
  for (const [k, v] of Object.entries(fm ?? {})) {
    if (COLUMN_FIELDS.has(k)) continue;
    if (v === "" || v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

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
    // Through `roundEstimate`, which is time.mjs's SINGLE definition of the 5-minute policy —
    // not a second rounding rule here. Two reasons it has to round at all:
    //
    //   the column is INTEGER, and under STRICT (BLZ-390) a hand-edited `estimate: 10.5` is
    //     refused outright rather than silently stored as REAL, which is what used to happen;
    //   the column also CHECKs `% 5 = 0`, so rounding merely to an INTEGER is not enough —
    //     Math.round(10.5) is 11 and would fail the CHECK instead.
    //
    // SQLite's `%` casts to integer first, which is why 10.5 passed that CHECK before.
    return Number.isFinite(n) && n > 0 ? roundEstimate(n) : null;
  };
  const nz = (v) => (v === "" || v === undefined ? null : v);

  const asList = (v) => (Array.isArray(v) ? v
    : typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

  /**
   * ADR-0013 §6, wired by BLZ-348: every event records WHO.
   *
   * `ticket_event.actor` has existed since the first schema with a default of 'unknown'
   * and both drivers already read and write it — nothing had ever set it, because
   * nothing appended an event on the live write path either. The actor arrives as the
   * port's CONTEXT rather than as part of the ticket: it belongs to the event, not to
   * the row.
   *
   * The kind is derived from what the database already held, so the caller does not have
   * to describe its own operation and cannot describe it wrongly: no prior row is a
   * `create`, a changed status is a `transition` (the only kind whose shape the schema
   * constrains, and both statuses are supplied), anything else is an `edit`.
   */
  async function recordEvent({ id, prior, status, ctx }) {
    const transition = prior !== null && prior !== status;
    const kind = prior === null ? "create" : transition ? "transition" : "edit";
    await exec.run(
      `INSERT INTO ticket_event (ticket_id, kind, at, actor, source, from_status, to_status)
       VALUES (${ph(0)}, ${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)})`,
      [id, kind, new Date().toISOString(), ctx?.actor ?? "unknown", ctx?.source ?? "cli",
       transition ? prior : null, transition ? status : null]);
  }

  async function persist({ project, status, frontmatter: fm, body }, ctx) {
    const id = fm.id;
    // Read BEFORE the upsert: afterwards there is no way to tell a create from an edit,
    // and no way to recover the status a transition came from.
    const priorRows = await exec.all(`SELECT status FROM ticket WHERE id = ${ph(0)}`, [id]);
    const prior = priorRows?.length ? priorRows[0].status : null;

    // parent_type is DERIVED, never taken from frontmatter — frontmatter has no such
    // field. The soak surfaced this on the live board: writing parent_id with a NULL
    // parent_type failed `ticket_parent_pair_present` on every parented ticket, which
    // is 2,000-odd of them. Resolved the same way the corpus loader resolves it: look
    // up the parent's own type. A parent that is not in the database cannot be stored
    // without violating the CHECK, so the pair is dropped and the dual-write
    // comparison REPORTS the difference rather than this hiding it.
    let parentId = nz(fm.parent), parentType = null;
    if (parentId) {
      const rows = await exec.all(`SELECT type FROM ticket WHERE id = ${ph(0)}`, [parentId]);
      if (rows?.length) parentType = rows[0].type;
      else parentId = null;
    }
    const extra = extraFields(fm);
    const cols = ["id", "project_key", "num", "type", "status", "title", "priority", "resolution",
                  "parent_id", "parent_type", "assignee", "estimate_minutes", "sprint_id",
                  "start_date", "due_date",
                  // BLZ-391: the dual-write port never persisted these two, so a ticket written
                  // through it read back with empty not_before/deadline — the same defect
                  // BLZ-391 fixed in load-corpus.mjs, on the other write path.
                  "constraint_start_no_earlier_than", "deadline",
                  "body", "created_on", "updated_on",
                  "branch", "pr", "ref", "category", "verification", "derived",
                  "likelihood", "impact", "extra_json"];
    const vals = [id, project, num(id), fm.type, status, fm.title, fm.priority || "medium",
                  nz(fm.resolution), parentId, parentType, fm.assignee || "unassigned",
                  est(fm.estimate), nz(fm.sprint), nz(fm.start), nz(fm.due),
                  nz(fm.not_before), nz(fm.deadline), body ?? "",
                  fm.created, fm.updated,
                  nz(fm.branch), nz(fm.pr) == null ? null : String(fm.pr), nz(fm.ref),
                  nz(fm.category), nz(fm.verification), nz(fm.derived),
                  nz(fm.likelihood), nz(fm.impact),
                  JSON.stringify(extra)];
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

    // Labels and components. Also found missing by the soak — an edit that set them
    // wrote to the file and nothing here, so 2,500 tickets' taxonomy would have gone
    // at cutover. Replace-in-full, so a re-write does not accumulate duplicates.
    for (const [table, col, val] of [["ticket_label", "label", fm.labels],
                                     ["ticket_component", "component", fm.components]]) {
      await exec.run(`DELETE FROM ${table} WHERE ticket_id = ${ph(0)}`, [id]);
      let ord = 0;
      for (const v of asList(val)) {
        await exec.run(
          `INSERT INTO ${table} (ticket_id, project_key, ${col}, ord)
           VALUES (${ph(0)}, ${ph(1)}, ${ph(2)}, ${ph(3)})`,
          [id, project, v, ord++]);
      }
    }

    // Worklog. The dual-write soak found this missing: `blaze log` wrote an entry to
    // the file and NOTHING to the database, so every logged minute would have been
    // lost at cutover — silently, because a ticket with no worklog is a perfectly
    // valid ticket. Replace-in-full rather than append, so a re-write of the same
    // ticket does not duplicate history.
    await exec.run(`DELETE FROM worklog_entry WHERE ticket_id = ${ph(0)}`, [id]);
    for (const w of fm.worklog ?? []) {
      // Rounded for the same reason as `est` above: `minutes` is INTEGER and STRICT refuses a
      // REAL. `roundWorklog` already does this on the CLI path.
      const mins = Math.round(Number(w?.minutes));
      if (!Number.isFinite(mins) || mins <= 0) continue;
      await exec.run(
        `INSERT INTO worklog_entry (ticket_id, on_date, minutes, note)
         VALUES (${ph(0)}, ${ph(1)}, ${ph(2)}, ${ph(3)})`,
        [id, w.date ?? fm.updated, mins, w.note ?? null]);
    }
    await recordEvent({ id, prior, status, ctx });
    return { file: id };   // an opaque handle, never a path — BLZ-271
  }

  return {
    name: "db",
    async exists({ frontmatter }) {
      const rows = await exec.all(`SELECT 1 AS hit FROM ticket WHERE id = ${ph(0)}`, [frontmatter.id]);
      return Boolean(rows?.length);
    },
    async write(t, ctx) { return persist(t, ctx); },
    async move(t, ctx) { const r = await persist(t, ctx); return { ...r, fromFile: t.currentFile }; },
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
                ${d("created_on")}, ${d("updated_on")},
                branch, pr, ref, category, verification, derived, likelihood, impact,
                extra_json
           FROM ticket WHERE id = ${ph(0)} AND deleted_at IS NULL`, [id]);
      if (!rows?.length) return null;
      const r = rows[0];
      const links = (await exec.all(
        `SELECT link_type, target_id FROM ticket_link WHERE src_id = ${ph(0)}
          ORDER BY link_type, target_id`, [id])) ?? [];
      const labels = (await exec.all(
        `SELECT label FROM ticket_label WHERE ticket_id = ${ph(0)} ORDER BY ord`, [id])) ?? [];
      const comps = (await exec.all(
        `SELECT component FROM ticket_component WHERE ticket_id = ${ph(0)} ORDER BY ord`, [id])) ?? [];
      const work = (await exec.all(
        `SELECT ${pg ? "on_date::text AS on_date" : "on_date"}, minutes, note
           FROM worklog_entry WHERE ticket_id = ${ph(0)} ORDER BY id`, [id])) ?? [];
      return {
        frontmatter: {
          id: r.id, project: r.project_key, type: r.type, title: r.title,
          priority: r.priority, resolution: r.resolution ?? "",
          parent: r.parent_id ?? "", assignee: r.assignee,
          estimate: r.estimate_minutes ?? "", sprint: r.sprint_id ?? "",
          start: r.start_date ?? "", due: r.due_date ?? "",
          created: r.created_on, updated: r.updated_on,
          ...(r.branch       == null ? {} : { branch: r.branch }),
          ...(r.pr           == null ? {} : { pr: r.pr }),
          ...(r.ref          == null ? {} : { ref: r.ref }),
          ...(r.category     == null ? {} : { category: r.category }),
          ...(r.verification == null ? {} : { verification: r.verification }),
          ...(r.derived      == null ? {} : { derived: r.derived }),
          ...(r.likelihood   == null ? {} : { likelihood: r.likelihood }),
          ...(r.impact       == null ? {} : { impact: r.impact }),
          // Unknown keys, restored verbatim. Spread BEFORE nothing else can shadow a
          // real column: extraFields() already guarantees no overlap.
          ...safeJson(r.extra_json),
          links: links.map((l) => ({ type: l.link_type, target: l.target_id })),
          ...(labels.length ? { labels: labels.map((r) => r.label) } : {}),
          ...(comps.length ? { components: comps.map((r) => r.component) } : {}),
          ...(work.length ? { worklog: work.map((w) => ({
            date: w.on_date, minutes: w.minutes,
            ...(w.note == null ? {} : { note: w.note }) })) } : {}),
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
    // The primary decides existence, as it decides every outcome. A shadow that
    // disagreed here would change what the verb DOES, not merely what it reports.
    exists(t, ctx) { return primary.exists(t, ctx); },
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
