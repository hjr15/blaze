// scripts/migrate/import-transitions.mjs — the historical audit trail (BLZ-281).
//
// The brief is unusually emphatic here, and it is right to be:
//
//   "Import verbatim. Never re-run `git log`. Never synthesise unobserved
//    transitions. Surface the coverage figure on the metrics view."
//
// The reason is that .blaze/transitions.json is NOT a complete history and cannot be
// made into one. It is rebuilt by `blaze reindex` from `git log --diff-filter=R`
// rename detection, and the board's history is squash-merged — so it covers 385 of
// 2,547 tickets, about 15%. Every ticket move that happened inside a squashed commit
// is simply not observable any more.
//
// That makes two things forbidden rather than merely inadvisable:
//
//   - Re-deriving from git at import time. It would produce a DIFFERENT partial set
//     depending on when it ran and how the clone was fetched, so the trail would stop
//     being reproducible.
//   - Filling gaps. A ticket sitting in done/ with no recorded transition did move
//     there, and inventing a plausible timestamp would put fiction into a table whose
//     entire value is that it is evidence.
//
// So: import what was observed, mark it as backfill, and report the coverage honestly.
const ISO = /^\d{4}-\d{2}-\d{2}T/;

/**
 * @param db       an open SQLite handle with the schema applied
 * @param cache    the parsed .blaze/transitions.json
 * @returns a report including the coverage figure the metrics view must surface
 */
export function importTransitions(db, cache, { knownIds = null } = {}) {
  const rows = Array.isArray(cache?.transitions) ? cache.transitions : [];
  const report = {
    read: rows.length, imported: 0,
    skipped: { unknownTicket: 0, malformed: 0 },
    ticketsCovered: 0, totalTickets: 0, coveragePct: 0,
  };

  const ins = db.prepare(
    `INSERT INTO ticket_event (ticket_id, kind, at, actor, source, from_status, to_status)
     VALUES (?, 'transition', ?, 'unknown', 'git-backfill', ?, ?)`);

  const ids = knownIds ??
    new Set(db.prepare("SELECT id FROM ticket").all().map((r) => r.id));
  report.totalTickets = ids.size;

  const covered = new Set();
  db.exec("BEGIN");
  for (const t of rows) {
    // `from` may legitimately be absent — a ticket's first appearance has no prior
    // status — but the event shape CHECK requires both, so those cannot be imported
    // as transitions. Counted, not silently dropped.
    if (!t?.id || !t?.to || !t?.from || !ISO.test(String(t.ts ?? ""))) {
      report.skipped.malformed++; continue;
    }
    if (!ids.has(t.id)) { report.skipped.unknownTicket++; continue; }
    // Timestamps are carried through EXACTLY as recorded — not normalised, not
    // re-zoned. They are evidence, and evidence that has been tidied is weaker.
    ins.run(t.id, String(t.ts), String(t.from), String(t.to));
    report.imported++;
    covered.add(t.id);
  }
  db.exec("COMMIT");

  report.ticketsCovered = covered.size;
  report.coveragePct = report.totalTickets
    ? Number(((covered.size / report.totalTickets) * 100).toFixed(1)) : 0;
  return report;
}
