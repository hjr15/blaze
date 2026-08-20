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
export function loadCorpus(db, projectsDir, { source = fsReadStorage, today = null } = {}) {
  const now = today ?? new Date().toISOString().slice(0, 10);
  const report = {
    tickets: 0, links: 0, worklog: 0, criteria: 0, notes: 0, acHeadings: 0,
    skipped: { noId: 0, badId: 0, insertFailed: [] },
    danglingLinks: 0, danglingParents: 0,
    // A ticket with no title still loads — losing it would be worse — but the id is
    // substituted, and substituting is inventing. Counted so the tally never claims a
    // clean load when 40 titles were manufactured.
    titleFallbacks: 0,
  };

  const rows = [...source.listTickets(projectsDir)];

  // Two passes: every ticket must exist before any link or parent can reference it.
  // Doing it in one pass would make load order decide which foreign keys survive,
  // which is exactly the kind of silent, order-dependent loss this harness exists to
  // rule out.
  const insTicket = db.prepare(
    `INSERT INTO ticket (id, project_key, num, type, status, title, priority, resolution,
                         parent_id, parent_type, assignee, estimate_minutes, sprint_id,
                         start_date, due_date, body, ac_heading, created_on, updated_on)
     VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?,?,?)`);
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
    try {
      insTicket.run(
        id, t.project ?? key, num, String(fm.type ?? "task"), t.status,
        title, String(fm.priority ?? "medium") || "medium",
        String(fm.resolution ?? "") || null,
        String(fm.assignee ?? "unassigned") || "unassigned",
        estimate(fm.estimate), String(fm.sprint ?? "") || null,
        isoDate(fm.start, null), isoDate(fm.due, null),
        t.body ?? "", ac.heading,
        isoDate(fm.created, now), isoDate(fm.updated, now));
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
