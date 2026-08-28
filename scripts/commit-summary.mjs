// scripts/commit-summary.mjs — the subject line `blaze commit` writes:
// "blaze: <date> board update (2 new, 3 logged, 1 moved)".
//
// BLZ-427: this composition used to be inline in commit-runner.mjs, which is a
// script with top-level side effects (it resolves roots, parses argv and exits),
// so nothing could import it and no test could reach the summary at all. It lives
// here so the label table and the counting rule are both callable.

// Every op that can reach the pending ledger, with the word the subject uses for
// it. The table used to hold only new/log/move/resolve; every other op fell
// through to `LABEL[op] || op` and printed its raw name — "1 reconcile",
// "2 edit", "1 ac". commit-or-queue.mjs now REFUSES to queue an op that is not in
// this table, so the subject can never print a word nobody chose.
export const OP_LABEL = {
  new: "new",
  log: "logged",
  move: "moved",
  resolve: "resolved",
  edit: "edited",
  link: "linked",
  ac: "ac-toggled",
  sprint: "sprint updated",
  reconcile: "reconciled",
};

/** The ticket ids ONE ledger entry covers.
 *
 *  BLZ-427: for move/log/new/resolve/edit/link/ac one op is one ticket, so an op
 *  count and a ticket count coincided and the subject happened to be true.
 *  `reconcile` breaks that identity — one queued reconcile op covers every ticket
 *  the pass wrote — so `commitOrQueue` records the full list on the entry and this
 *  reads it. An entry with no `ids` (every per-ticket verb, and any entry queued by
 *  a pre-BLZ-427 engine that is still sitting on a ledger) covers exactly its own
 *  `id`. */
export function entryIds(e) {
  if (Array.isArray(e.ids) && e.ids.length) return e.ids;
  return e.id == null ? [] : [e.id];
}

/** "2 new, 3 logged, 12 reconciled" — one clause per op, in first-seen order,
 *  counting DISTINCT TICKETS rather than ops. Two edits to one ticket are one
 *  ticket edited; the full per-op detail is still in the commit body, which lists
 *  every entry's message. An op with no label falls back to its raw name rather
 *  than throwing: `commitOrQueue` refuses those at queue time, and a ledger written
 *  by an older engine must still drain. */
export function summarizeEntries(entries) {
  const byOp = new Map();
  for (const e of entries) {
    if (!byOp.has(e.op)) byOp.set(e.op, new Set());
    for (const id of entryIds(e)) byOp.get(e.op).add(id);
  }
  return [...byOp]
    .map(([op, ids]) => `${ids.size} ${OP_LABEL[op] || op}`)
    .join(", ");
}
