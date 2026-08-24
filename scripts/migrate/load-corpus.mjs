// scripts/migrate/load-corpus.mjs — load the filesystem board into SQLite (BLZ-280).
//
// A MIGRATION HARNESS, not a shipped feature. Its job is to move the corpus once and
// to prove, by counting, that nothing was lost doing it. ADR-0006 declined a git
// mirror precisely so this stays one-directional and disposable.
//
// It reports rather than asserts. A loader that throws on the first odd ticket in a
// 2,500-ticket corpus tells you about one problem; one that loads what it can and
// hands back a tally tells you about all of them, which is what you need before
// cutover. Nothing is silently dropped — every skip is counted and named.
import { parseAcBlocks } from "../model/ac-blocks.mjs";
import { extraFields } from "../model/write-port.mjs";
import { fsReadStorage } from "../model/read-storage.mjs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Frontmatter dates are authored by hand; a bad one must not abort the load. */
function isoDate(v, fallback) {
  const s = String(v ?? "").trim();
  return ISO_DATE.test(s) ? s : fallback;
}

/** estimate is text in frontmatter and an integer here; 242 tickets have none. */
function estimate(v) {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) && n > 0 && n % 5 === 0 ? n : null;
}

/**
 * @param db      an open SQLite handle with the schema applied
 * @param source  a read driver (defaults to the filesystem)
 * @returns a tally: what loaded, what was skipped, and why
 */
const nzs = (v) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};
const asList = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean)
  : typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

export function loadCorpus(db, projectsDir, { source = fsReadStorage, today = null } = {}) {
  const now = today ?? new Date().toISOString().slice(0, 10);
  const report = {
    tickets: 0, links: 0, worklog: 0, criteria: 0, notes: 0, acHeadings: 0,
    labels: 0, components: 0,
    skipped: { noId: 0, badId: 0, insertFailed: [] },
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

  const rows = [...source.listTickets(projectsDir)];

  // Two passes: every ticket must exist before any link or parent can reference it.
  // Doing it in one pass would make load order decide which foreign keys survive,
  // which is exactly the kind of silent, order-dependent loss this harness exists to
  // rule out.
  const insTicket = db.prepare(
    `INSERT INTO ticket (id, project_key, num, type, status, title, priority, resolution,
                         parent_id, parent_type, assignee, estimate_minutes, sprint_id,
                         start_date, due_date, constraint_start_no_earlier_than, deadline,
                         body, ac_heading, created_on, updated_on,
                         branch, pr, ref, category, verification, derived,
                         likelihood, impact, extra_json)
     VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // BLZ-295. Without these the migration silently dropped every one of them: 926 of
  // 2,561 tickets (36.2%) carry at least one, and extra_json is what keeps the
  // round-trip promise for keys nobody has thought of yet.
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
  for (const t of rows) {
    const fm = t.frontmatter ?? {};
    const id = String(fm.id ?? "").trim();
    if (!id) { report.skipped.noId++; continue; }
    const [key, numRaw] = id.split("-");
    const num = Number(numRaw);
    if (!key || !Number.isFinite(num) || num <= 0) { report.skipped.badId++; continue; }

    const ac = parseAcBlocks(t.body);
    const title = String(fm.title ?? "").trim() || id;
    if (title === id && String(fm.title ?? "").trim() === "") report.titleFallbacks++;
    const priority = String(fm.priority ?? "").trim() || "medium";
    if (!String(fm.priority ?? "").trim()) report.defaultsApplied.priority++;
    const assignee = String(fm.assignee ?? "").trim() || "unassigned";
    if (!String(fm.assignee ?? "").trim()) report.defaultsApplied.assignee++;
    try {
      insTicket.run(
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
        JSON.stringify(extraFields(fm)));

      const project = t.project ?? key;
      let ord = 0;
      for (const l of asList(fm.labels)) { insLabel.run(id, project, l, ord++); report.labels++; }
      ord = 0;
      for (const c of asList(fm.components)) { insComponent.run(id, project, c, ord++); report.components++; }
    } catch (e) {
      // Named, not swallowed: the tally is only trustworthy if a refusal is visible.
      report.skipped.insertFailed.push({ id, reason: String(e.message).slice(0, 120) });
      continue;
    }
    report.tickets++;
    typeById.set(id, String(fm.type ?? "task"));
    if (ac.heading) report.acHeadings++;

    for (const [i, b] of ac.blocks.entries()) {
      insAc.run(id, i, b.kind, b.text, b.kind === "criterion" && b.checked ? 1 : 0);
      b.kind === "criterion" ? report.criteria++ : report.notes++;
    }
    for (const w of Array.isArray(fm.worklog) ? fm.worklog : []) {
      const m = Number(w?.minutes);
      if (!Number.isFinite(m) || m <= 0) continue;
      insWork.run(id, isoDate(w.date, now), m, w.note ?? null);
      report.worklog++;
    }
  }

  // Pass two: parents and links, now that every ticket exists.
  for (const t of rows) {
    const fm = t.frontmatter ?? {};
    const id = String(fm.id ?? "").trim();
    if (!id || !typeById.has(id)) continue;

    const parent = String(fm.parent ?? "").trim();
    if (parent) {
      if (typeById.has(parent)) setParent.run(parent, typeById.get(parent), id);
      else report.danglingParents++;   // counted, never invented
    }
    for (const l of Array.isArray(fm.links) ? fm.links : []) {
      if (!l?.type || !l?.target) continue;
      if (!typeById.has(String(l.target))) { report.danglingLinks++; continue; }
      insLink.run(id, String(l.type), String(l.target));
      report.links++;
    }
  }
  db.exec("COMMIT");
  return report;
}
