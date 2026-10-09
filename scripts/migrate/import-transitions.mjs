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
//
// BLZ-680: `blaze db load` imports through these SAME rules (`importTransitionsExec` below, over
// an async `exec` on Postgres or the SQLite shadow's). It reads git's rename log once, at the
// load (`buildTransitions`, spec §5.7) — the one moment the trail is frozen into the database,
// after which git's log stops growing — so the "never re-run git log" rule above governs every
// LATER import, and the trail is reproducible as of the commit the load ran at.
const ISO = /^\d{4}-\d{2}-\d{2}T/;

/** The rule, once: which recorded transitions become events, and the report about the rest.
 *  @returns { rows: [ticket_id, at, from, to][], report } */
function transitionRows(cache, ids) {
  const rows = Array.isArray(cache?.transitions) ? cache.transitions : [];
  const report = {
    read: rows.length, imported: 0,
    skipped: { unknownTicket: 0, malformed: 0 },
    ticketsCovered: 0, totalTickets: ids.size, coveragePct: 0,
  };
  const out = [];
  const covered = new Set();
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
    out.push([t.id, String(t.ts), String(t.from), String(t.to)]);
    covered.add(t.id);
  }
  report.imported = out.length;
  report.ticketsCovered = covered.size;
  report.coveragePct = report.totalTickets
    ? Number(((covered.size / report.totalTickets) * 100).toFixed(1)) : 0;
  return { rows: out, report };
}

/**
 * @param db       an open SQLite handle with the schema applied
 * @param cache    the parsed .blaze/transitions.json
 * @returns a report including the coverage figure the metrics view must surface
 */
export function importTransitions(db, cache, { knownIds = null } = {}) {
  const ins = db.prepare(
    `INSERT INTO ticket_event (ticket_id, kind, at, actor, source, from_status, to_status)
     VALUES (?, 'transition', ?, 'unknown', 'git-backfill', ?, ?)`);
  const ids = knownIds ??
    new Set(db.prepare("SELECT id FROM ticket").all().map((r) => r.id));
  const { rows, report } = transitionRows(cache, ids);
  db.exec("BEGIN");
  for (const r of rows) ins.run(...r);
  db.exec("COMMIT");
  return report;
}

/**
 * BLZ-680: the same import through an `exec` ({run, all}, awaited) in either dialect, INSIDE
 * the caller's transaction — `blaze db load` commits it with the tickets, or not at all.
 * @param knownIds  the ids that loaded (the event's foreign key needs the ticket)
 */
export async function importTransitionsExec(exec, cache, { knownIds, dialect = "postgres" }) {
  if (dialect !== "sqlite" && dialect !== "postgres") {
    throw new Error(`unknown dialect ${JSON.stringify(dialect)} — expected 'sqlite' or 'postgres'`);
  }
  const ph = (i) => (dialect === "postgres" ? `$${i + 1}` : "?");
  const { rows, report } = transitionRows(cache, knownIds);
  for (const r of rows) {
    await exec.run(
      `INSERT INTO ticket_event (ticket_id, kind, at, actor, source, from_status, to_status)
       VALUES (${ph(0)}, 'transition', ${ph(1)}, 'unknown', 'git-backfill', ${ph(2)}, ${ph(3)})`, r);
  }
  return report;
}
