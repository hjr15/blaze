// scripts/migrate/load-corpus.mjs — load the filesystem board into a database (BLZ-280,
// BLZ-678).
//
// A MIGRATION HARNESS, not a shipped feature. Its job is to move the corpus once and
// to prove, by counting, that nothing was lost doing it. ADR-0006 declined a git
// mirror precisely so this stays one-directional and disposable.
//
// It reports rather than asserts. A loader that throws on the first odd ticket in a
// 2,500-ticket corpus tells you about one problem; one that loads what it can and
// hands back a tally tells you about all of them, which is what you need before
// cutover. Nothing is silently dropped — every skip is counted and named.
//
// BLZ-678: ONE ROW BUILDER, TWO EXECUTORS. `corpusRows` turns the corpus into rows and is
// pure; `loadCorpus` (sync, node:sqlite — `blaze db init`'s shadow) and `loadCorpusAsync`
// (an `exec`, either dialect — `blaze db load` on Postgres) only insert what it built. Two
// loaders that each normalised a ticket would drift, and the drift would be invisible until
// the oracle ran — so the normalising lives in exactly one place.
import { parseAcBlocks } from "../model/ac-blocks.mjs";
import { storableEstimate } from "../model/time.mjs";
import { extraFields } from "../model/write-port.mjs";
import { fsReadStorage } from "../model/read-storage.mjs";
import { counterUpsertSql } from "../model/seed-counter.mjs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Frontmatter dates are authored by hand; a bad one must not abort the load. */
function isoDate(v, fallback) {
  const s = String(v ?? "").trim();
  return ISO_DATE.test(s) ? s : fallback;
}

/** estimate is text in frontmatter and an integer here; 242 tickets have none. */
// `storableEstimate` is time.mjs's one rule, shared with write-port.mjs. These two disagreed
// three ways about `estimate: 7` until it existed.
const estimate = storableEstimate;

const nzs = (v) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};
const asList = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean)
  : typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
/** First occurrence wins. The tables' primary keys refuse a repeat, so a repeat is not a row,
 *  and a tally that counted it would disagree with the table it describes (BLZ-679's gate). */
const unique = (xs) => [...new Set(xs)];

/** The `ticket` columns both executors insert, in order. `parent_id`/`parent_type` are set by
 *  pass two, once every ticket exists. */
export const TICKET_COLUMNS = [
  "id", "project_key", "num", "type", "status", "title", "priority", "resolution",
  "assignee", "estimate_minutes", "sprint_id", "start_date", "due_date",
  "constraint_start_no_earlier_than", "deadline", "body", "ac_heading", "created_on", "updated_on",
  "branch", "pr", "ref", "category", "verification", "derived", "likelihood", "impact", "extra_json",
];

/** The tally's starting shape — one definition, so the two executors cannot report differently. */
function emptyReport() {
  return {
    tickets: 0, links: 0, worklog: 0, criteria: 0, notes: 0, acHeadings: 0,
    labels: 0, components: 0,
    skipped: { worklogDropped: [], noId: 0, badId: 0, insertFailed: [] },
    danglingLinks: 0, danglingParents: 0,
    // A ticket with no title still loads — losing it would be worse — but the id is
    // substituted, and substituting is inventing. Counted so the tally never claims a
    // clean load when 40 titles were manufactured.
    titleFallbacks: 0,
    // A field the source simply did not carry, given the schema's documented default.
    // Applying a default is correct — the read path does it too — but it is still a
    // value the source did not state, so it is counted rather than assumed away.
    defaultsApplied: { priority: 0, assignee: 0 },
  };
}

/**
 * The pure half: every well-formed ticket as the rows it becomes. Reads `source` once and
 * touches no database.
 *
 * @param source       a SYNC read driver (`listTickets(projectsDir)`), the filesystem by default
 * @returns { tickets, maxNum, report } — `report` carries the build-time counts (noId, badId,
 *          titleFallbacks, defaultsApplied); the executor adds what only inserting can know.
 */
export function corpusRows(source, projectsDir, { today = null } = {}) {
  const now = today ?? new Date().toISOString().slice(0, 10);
  const report = emptyReport();
  const tickets = [];
  // BLZ-667: the highest number the corpus holds, per id prefix — what project_counter is
  // seeded from. Taken from every well-formed id, INCLUDING a row the database then refuses:
  // that ticket still exists on disk, so its number is still taken.
  const maxNum = new Map();

  for (const t of [...source.listTickets(projectsDir)]) {
    const fm = t.frontmatter ?? {};
    const id = String(fm.id ?? "").trim();
    if (!id) { report.skipped.noId++; continue; }
    const [key, numRaw] = id.split("-");
    const num = Number(numRaw);
    if (!key || !Number.isFinite(num) || num <= 0) { report.skipped.badId++; continue; }
    if (Number.isInteger(num) && num > (maxNum.get(key) ?? 0)) maxNum.set(key, num);

    const ac = parseAcBlocks(t.body);
    const title = String(fm.title ?? "").trim() || id;
    if (title === id && String(fm.title ?? "").trim() === "") report.titleFallbacks++;
    const priority = String(fm.priority ?? "").trim() || "medium";
    if (!String(fm.priority ?? "").trim()) report.defaultsApplied.priority++;
    const assignee = String(fm.assignee ?? "").trim() || "unassigned";
    if (!String(fm.assignee ?? "").trim()) report.defaultsApplied.assignee++;

    // Worklog: Math.round because `minutes` is INTEGER and STRICT refuses a REAL. COUNTED,
    // never silently skipped — `Math.round(0.4)` is 0, and this file's header promises every
    // skip is named (BLZ-393).
    const worklog = [], worklogDropped = [];
    for (const w of Array.isArray(fm.worklog) ? fm.worklog : []) {
      const m = Math.round(Number(w?.minutes));
      if (!Number.isFinite(m) || m <= 0) { worklogDropped.push({ id, minutes: w?.minutes ?? null }); continue; }
      worklog.push({ date: isoDate(w.date, now), minutes: m, note: w.note ?? null });
    }

    tickets.push({
      id, project: t.project ?? key, type: String(fm.type ?? "task"),
      values: [
        id, t.project ?? key, num, String(fm.type ?? "task"), t.status,
        title, priority,
        String(fm.resolution ?? "") || null,
        assignee,
        estimate(fm.estimate), String(fm.sprint ?? "") || null,
        isoDate(fm.start, null), isoDate(fm.due, null),
        // BLZ-391: ADR-0022's two constraint columns arrived with PR #110 and this loader
        // predates them, so a migrated ticket lost its `not_before`/`deadline` outright.
        isoDate(fm.not_before, null), isoDate(fm.deadline, null),
        t.body ?? "", ac.heading,
        isoDate(fm.created, now), isoDate(fm.updated, now),
        nzs(fm.branch), nzs(fm.pr), nzs(fm.ref), nzs(fm.category),
        nzs(fm.verification), nzs(fm.derived), nzs(fm.likelihood), nzs(fm.impact),
        JSON.stringify(extraFields(fm)),
      ],
      acHeading: ac.heading,
      // BLZ-295. Without these the migration silently dropped every one of them: 926 of
      // 2,561 tickets (36.2%) carry at least one, and extra_json is what keeps the
      // round-trip promise for keys nobody has thought of yet.
      labels: unique(asList(fm.labels)),
      components: unique(asList(fm.components)),
      ac: ac.blocks,
      worklog, worklogDropped,
      parent: String(fm.parent ?? "").trim(),
      links: (Array.isArray(fm.links) ? fm.links : [])
        .filter((l) => l?.type && l?.target)
        .map((l) => ({ type: String(l.type), target: String(l.target) })),
    });
  }
  return { tickets, maxNum, report };
}

/**
 * Pass two, pure: parents and links between the tickets that ACTUALLY LOADED. Doing it in one
 * pass would make load order decide which foreign keys survive — exactly the silent,
 * order-dependent loss this harness exists to rule out. A link to a ticket that did not load is
 * counted and dropped, never forged; a repeated link is one row.
 *
 * @param typeById  Map<id, type> of the tickets the executor inserted
 */
export function relationRows(tickets, typeById) {
  const parents = [], links = [];
  let danglingParents = 0, danglingLinks = 0;
  const seen = new Set();
  for (const t of tickets) {
    if (!typeById.has(t.id)) continue;
    if (t.parent) {
      if (typeById.has(t.parent)) parents.push({ id: t.id, parent: t.parent, parentType: typeById.get(t.parent) });
      else danglingParents++;   // counted, never invented
    }
    for (const l of t.links) {
      if (!typeById.has(l.target)) { danglingLinks++; continue; }
      const k = `${t.id}\u0000${l.type}\u0000${l.target}`;
      if (seen.has(k)) continue;
      seen.add(k);
      links.push({ src: t.id, type: l.type, target: l.target });
    }
  }
  return { parents, links, danglingParents, danglingLinks };
}

/**
 * The sync executor: node:sqlite, its own transaction. `blaze db init`'s shadow loader.
 *
 * @param db      an open SQLite handle with the schema applied
 * @param source  a read driver (defaults to the filesystem)
 * @returns a tally: what loaded, what was skipped, and why
 */
export function loadCorpus(db, projectsDir, { source = fsReadStorage, today = null } = {}) {
  const { tickets, maxNum, report } = corpusRows(source, projectsDir, { today });
  const insTicket = db.prepare(
    `INSERT INTO ticket (${TICKET_COLUMNS.join(", ")}) VALUES (${TICKET_COLUMNS.map(() => "?").join(",")})`);
  const insLabel = db.prepare(
    "INSERT OR IGNORE INTO ticket_label (ticket_id, project_key, label, ord) VALUES (?,?,?,?)");
  const insComponent = db.prepare(
    "INSERT OR IGNORE INTO ticket_component (ticket_id, project_key, component, ord) VALUES (?,?,?,?)");
  const setParent = db.prepare("UPDATE ticket SET parent_id = ?, parent_type = ? WHERE id = ?");
  const insLink = db.prepare("INSERT OR IGNORE INTO ticket_link VALUES (?,?,?)");
  const insWork = db.prepare("INSERT INTO worklog_entry (ticket_id,on_date,minutes,note) VALUES (?,?,?,?)");
  const insAc = db.prepare("INSERT INTO acceptance_criterion (ticket_id,ord,kind,text,checked) VALUES (?,?,?,?,?)");

  const typeById = new Map();
  db.exec("BEGIN");
  for (const t of tickets) {
    try {
      insTicket.run(...t.values);
      t.labels.forEach((l, ord) => insLabel.run(t.id, t.project, l, ord));
      t.components.forEach((c, ord) => insComponent.run(t.id, t.project, c, ord));
    } catch (e) {
      // Named, not swallowed: the tally is only trustworthy if a refusal is visible.
      report.skipped.insertFailed.push({ id: t.id, reason: String(e.message).slice(0, 120) });
      continue;
    }
    report.tickets++;
    report.labels += t.labels.length;
    report.components += t.components.length;
    typeById.set(t.id, t.type);
    if (t.acHeading) report.acHeadings++;
    for (const [i, b] of t.ac.entries()) {
      insAc.run(t.id, i, b.kind, b.text, b.kind === "criterion" && b.checked ? 1 : 0);
      b.kind === "criterion" ? report.criteria++ : report.notes++;
    }
    report.skipped.worklogDropped.push(...t.worklogDropped);
    for (const w of t.worklog) {
      // The try/catch because a single bad worklog row once killed the entire load with an
      // uncaught throw and left the BEGIN uncommitted. Now it is a counted skip like any other.
      try {
        insWork.run(t.id, w.date, w.minutes, w.note);
        report.worklog++;
      } catch (e) {
        report.skipped.insertFailed.push({ id: t.id, reason: `worklog: ${String(e.message).slice(0, 100)}` });
      }
    }
  }

  const rel = relationRows(tickets, typeById);
  for (const p of rel.parents) setParent.run(p.parent, p.parentType, p.id);
  for (const l of rel.links) insLink.run(l.src, l.type, l.target);
  report.links = rel.links.length;
  report.danglingParents = rel.danglingParents;
  report.danglingLinks = rel.danglingLinks;

  // BLZ-667: seed the db-mode allocator, so its first number follows the corpus's last
  // rather than colliding with it. The MAX, not the count — numbering has gaps. And never
  // lower an existing counter: a number already issued must not be issued twice.
  // BLZ-668: the upsert is spelled once, in seed-counter.mjs, for both dialects.
  const seed = db.prepare(counterUpsertSql("sqlite"));
  for (const [key, n] of maxNum) seed.run(key, n);
  db.exec("COMMIT");
  return report;
}

/**
 * The async executor (BLZ-678): the same rows through an `exec` ({run, all}, awaited), with
 * either dialect's placeholders. `blaze db load` runs it on Postgres.
 *
 * It does NOT open or close a transaction — the CALLER owns the one transaction the whole load
 * runs in (spec §5.2), so the refusal check, a `--replace` truncate, this load and the counter
 * seed commit or roll back together. Each ticket runs under its own SAVEPOINT: on Postgres a
 * failed statement aborts the whole transaction, and the savepoint is what lets one refused row
 * be counted and skipped — the same "load what it can, tally the rest" promise the sync
 * executor keeps.
 *
 * `acceptance_criterion` and `ac_heading` are left EMPTY (spec §5.2). They are a derived index:
 * nothing in db mode reads them — the reader returns `body` verbatim, criteria included — and
 * `dbWritePort` does not maintain them, so filling them here would plant rows that the first
 * db-mode edit leaves stale. SQLite-shadow-only.
 *
 * @returns the tally, same shape as `loadCorpus`'s, plus `typeById` for callers that link to
 *          the loaded set (the transition import)
 */
export async function loadCorpusAsync(exec, projectsDir, { source = fsReadStorage, today = null,
                                                          dialect = "postgres" } = {}) {
  if (dialect !== "sqlite" && dialect !== "postgres") {
    throw new Error(`unknown dialect ${JSON.stringify(dialect)} — expected 'sqlite' or 'postgres'`);
  }
  const ph = (i) => (dialect === "postgres" ? `$${i + 1}` : "?");
  const list = (n) => Array.from({ length: n }, (_, i) => ph(i)).join(", ");
  const { tickets, report } = corpusRows(source, projectsDir, { today });
  const AC_HEADING = TICKET_COLUMNS.indexOf("ac_heading");

  const typeById = new Map();
  for (const t of tickets) {
    await exec.run("SAVEPOINT blaze_load_ticket", []);
    try {
      const values = [...t.values];
      values[AC_HEADING] = null;
      await exec.run(`INSERT INTO ticket (${TICKET_COLUMNS.join(", ")}) VALUES (${list(TICKET_COLUMNS.length)})`, values);
      for (const [table, col, vals] of [["ticket_label", "label", t.labels], ["ticket_component", "component", t.components]]) {
        for (const [ord, v] of vals.entries()) {
          await exec.run(`INSERT INTO ${table} (ticket_id, project_key, ${col}, ord) VALUES (${list(4)})`,
                         [t.id, t.project, v, ord]);
        }
      }
      for (const w of t.worklog) {
        await exec.run(`INSERT INTO worklog_entry (ticket_id, on_date, minutes, note) VALUES (${list(4)})`,
                       [t.id, w.date, w.minutes, w.note]);
      }
      await exec.run("RELEASE SAVEPOINT blaze_load_ticket", []);
    } catch (e) {
      await exec.run("ROLLBACK TO SAVEPOINT blaze_load_ticket", []);
      await exec.run("RELEASE SAVEPOINT blaze_load_ticket", []);
      // Named, not swallowed — and the WHOLE ticket goes, worklog included: a half-loaded
      // ticket is a value diff the oracle would have to explain.
      report.skipped.insertFailed.push({ id: t.id, reason: String(e.message).slice(0, 120) });
      continue;
    }
    report.tickets++;
    report.labels += t.labels.length;
    report.components += t.components.length;
    report.worklog += t.worklog.length;
    report.skipped.worklogDropped.push(...t.worklogDropped);
    typeById.set(t.id, t.type);
  }

  // Pass two, under the same per-statement savepoint: a parent or link the database refuses
  // (a ticket that names itself as its parent, say) is named with its ticket, like a refused
  // ticket, rather than aborting the transaction on the first one with no id attached.
  const attempt = async (id, what, sql, params) => {
    await exec.run("SAVEPOINT blaze_load_relation", []);
    try {
      await exec.run(sql, params);
      await exec.run("RELEASE SAVEPOINT blaze_load_relation", []);
      return true;
    } catch (e) {
      await exec.run("ROLLBACK TO SAVEPOINT blaze_load_relation", []);
      await exec.run("RELEASE SAVEPOINT blaze_load_relation", []);
      report.skipped.insertFailed.push({ id, reason: `${what}: ${String(e.message).slice(0, 110)}` });
      return false;
    }
  };
  const rel = relationRows(tickets, typeById);
  for (const p of rel.parents) {
    await attempt(p.id, "parent",
      `UPDATE ticket SET parent_id = ${ph(0)}, parent_type = ${ph(1)} WHERE id = ${ph(2)}`,
      [p.parent, p.parentType, p.id]);
  }
  let links = 0;
  for (const l of rel.links) {
    if (await attempt(l.src, "link",
      `INSERT INTO ticket_link (src_id, link_type, target_id) VALUES (${list(3)})`,
      [l.src, l.type, l.target])) links++;
  }
  report.links = links;
  report.danglingParents = rel.danglingParents;
  report.danglingLinks = rel.danglingLinks;
  return { ...report, typeById };
}
