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

/** The body of `blaze commit --status`.
 *
 *  BLZ-499 / ADR-0032. It lives here, next to `summarizeEntries`, for the reason BLZ-427
 *  moved that function here: `commit-runner.mjs` is a script with top-level side effects
 *  (it resolves roots, parses argv and exits), so nothing in it can be imported and no test
 *  can reach its text. This is pure and importable, so the wording is drivable directly.
 *
 *  `queues` is `[{ session, entries, files: { outstanding, settled, absent } }]`, and
 *  `mySession` is the queue name the CALLER's own session id resolves to (null when it has
 *  none, which is the shared fallback).
 *
 *  BLZ-498 AC1 asks that "a queue's age and owner are visible without reading the ledger by
 *  hand". Two clauses do that, and neither is decoration:
 *    - `(yours)` — of the eight orphaned queues on the live board, exactly one is the
 *      caller's; without the marker an operator has to derive `auto-$CLAUDE_CODE_SESSION_ID`
 *      themselves to know which line `blaze commit` would act on and which needs `--all`.
 *    - `N.N d old` — measured from the NEWEST op, i.e. when the queue was last touched, so
 *      it answers "is this session still going" rather than "when did it start". The
 *      previous output gave only an ISO `oldest` stamp, leaving the age to be subtracted by
 *      hand; that is a large part of why 185 ops sat unexamined across five nightly runs.
 *
 *  WHAT THIS DELIBERATELY DOES NOT SAY. The ledger answers exactly one of the three board
 *  states BLZ-404 round 4 conflated: a write blaze queued BY DESIGN. It cannot distinguish
 *  a genuinely failed prior commit from a human's own in-flight file, because neither
 *  leaves anything in the ledger — on a `per-op` board there is no ledger at all, and on a
 *  `batch` board a failed flush KEEPS a queue byte-identical to a healthy one. Round 4's
 *  detector claimed to separate three states and separated none; this one names its own
 *  blind spot in its own output instead, which is what ADR-0030 and BLZ-433 ask for. */
export function renderQueueStatus(queues, mySession = undefined) {
  const L = ["blaze commit --status: read-only — nothing was committed, queued or cleared."];
  const ops = queues.reduce((n, q) => n + q.entries.length, 0);
  // BLZ-518 / ADR-0030. A queue carrying `error` was NOT read, so it is not evidence of
  // zero ops. Without this, a board whose only queue is malformed printed "Nothing queued —
  // 0 op(s) on 0 queue(s)": a run that could not look, saying exactly what a run that
  // looked and found nothing says.
  const unreadable = queues.filter((q) => q.error);
  if (ops === 0 && unreadable.length === 0) {
    L.push("", "  Nothing queued — 0 op(s) on 0 queue(s).");
  } else {
    const readable = queues.length - unreadable.length;
    L.push("", `  ${readable} readable queue(s) holding ${ops} op(s).`, "");
    for (const q of queues) {
      const name = q.session === null ? "(shared fallback queue — no session identity)" : q.session;
      if (q.error) {
        // Named, with its reason, and with NO buckets — an unreadable queue must not be
        // rendered in the same shape as one that was read and found clean.
        L.push(`  ${name}${mySession !== undefined && q.session === mySession ? "  (yours)" : ""}  —  could not be read: ${q.error}`);
        L.push("      state UNKNOWN — this queue is not counted in the totals below");
        L.push("");
        continue;
      }
      // `undefined` means the caller did not say who it is, so nothing is claimed either
      // way; `null` is a real answer (no session identity => the shared fallback IS yours).
      const own = mySession !== undefined && q.session === mySession ? "  (yours)" : "";
      const stamps = q.entries.map((e) => e.ts).filter(Boolean).sort();
      const newest = stamps.length ? Date.parse(stamps[stamps.length - 1]) : NaN;
      const age = Number.isNaN(newest) ? "" : `, ${((Date.now() - newest) / 86400000).toFixed(1)} d old`;
      const when = stamps.length ? `  oldest ${stamps[0]}${age}` : "";
      L.push(`  ${name}${own}  —  ${q.entries.length} op(s), ${summarizeEntries(q.entries)}${when}`);
      const { outstanding, settled, absent } = q.files;
      L.push(`      outstanding: ${outstanding.length} file(s) still differ from HEAD`);
      L.push(`      orphaned:    ${settled.length} file(s) already match HEAD — filed by something else`);
      if (absent.length) L.push(`      superseded:  ${absent.length} file(s) relocated again within a batch`);
      L.push("");
    }
    const tot = (k) => queues.reduce((n, q) => n + (q.error ? 0 : q.files[k].length), 0);
    L.push(`  ${tot("outstanding")} file(s) outstanding, ${tot("settled")} orphaned, across ${readable} readable queue(s).`);
    if (unreadable.length) {
      L.push(`  ${unreadable.length} queue(s) could not be read — the totals above DO NOT cover them.`);
    }
    L.push("  Flush your own queue with `blaze commit`, or every queue with `blaze commit --all`.");
  }
  L.push("",
    "  This reports ONLY what blaze recorded that it queued. It does not report a failed",
    "  prior commit, and it does not report your own in-flight edit under projects/ —",
    "  neither leaves a ledger entry, so neither is visible here. Use `git status` for those.");
  return L.join("\n");
}
