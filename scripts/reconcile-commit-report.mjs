// scripts/reconcile-commit-report.mjs — how a `commitOrQueue` result becomes
// reconcile's `commitOutcome`, and how that outcome becomes the one line a person
// reads after `reconcile --apply`.
//
// BLZ-422: both halves used to be inline in reconcile.mjs — the classifier inside
// the `if (commit && !dryRun && touched.length)` block, the wording inside the CLI
// tail. Neither could be driven directly, so the classifier's `else if (c.ok)`
// branch (which maps BOTH a real commit and `commitFile`'s benign empty-diff no-op
// to "committed") had no test that could tell the two apart. They live here so the
// mapping and the sentence are callable, and reconcile.mjs uses THESE — there is no
// second copy.
//
// The outcomes, and what each one asserts about `git log`:
//   "none"      — nothing was decided, so no commit was attempted.
//   "committed" — a new commit exists. This is the ONLY outcome that claims one.
//   "no-op"     — git had nothing to commit: the staged tree already matched HEAD.
//                 Benign (an idempotent re-write must not become an error), but it
//                 is NOT a commit and must never be reported as one.
//   "queued"    — deferred to the pending ledger (commitMode: "batch").
//   "locked"    — the advisory commit lock is held by another writer.
//   "failed"    — `git commit` itself refused.

export const COMMIT_OUTCOMES = ["none", "committed", "no-op", "queued", "locked", "failed"];

/** Classifies a `commitOrQueue` / `commitFile` result. Returns
 *  `{ outcome, error }`; `error` is null on every non-error outcome. */
export function commitOutcomeFrom(c) {
  if (c.queued) return { outcome: "queued", error: null };
  // BLZ-422: `ok` alone was the whole test here, and `commitFile` returns `ok: true`
  // for BOTH a real commit and its benign empty-diff no-op — so a pass that put
  // nothing in `git log` reported "committed". `committed` is now the field that
  // answers "is there a new commit"; `ok` only answers "did this go wrong".
  if (c.ok && c.committed) return { outcome: "committed", error: null };
  if (c.ok) return { outcome: "no-op", error: null };
  if (c.locked) {
    return { outcome: "locked", error: "the advisory commit lock is held by another writer" };
  }
  return { outcome: "failed", error: `git commit failed (exit status ${c.status})` };
}

/** The single line the CLI prints for an `--apply` run, as
 *  `{ stream: "out" | "err", text, exit }`. `exit` is the process exit code the
 *  outcome demands (0 = keep going), so the wording and the exit code cannot drift
 *  apart the way they did before BLZ-404. Returns null for outcomes that print
 *  nothing ("none": no commit was attempted, so there is nothing to report). */
export function applySummary({ outcome, error, movedCount, nonMovedCount }) {
  // BLZ-447: this says "N ticket(s) updated without a status change"; the dashboard
  // toast (scripts/views/reconcile-summary.mjs) says "N other update(s)" for the same
  // quantity. Two surfaces, one quantity, two vocabularies — and the difference is
  // DELIBERATE, along the preview/write-record line rather than at random.
  //
  //   PREVIEW surfaces say "other update(s)":
  //     - the dashboard toast (reconcile-summary.mjs)
  //     - reconcile.mjs's dry-run tail, "(dry-run: N move(s), M other update(s); rerun
  //       with --apply …)"
  //   WRITE-RECORD surfaces say "N ticket(s) updated without a status change":
  //     - this line, printed after an --apply pass
  //     - the commit subject reconcile.mjs writes
  //
  // A preview is a short parenthetical read immediately beside its own move count,
  // where "other" is unambiguous and brevity is the point. A write record is a durable
  // sentence — in `git log`, or on a terminal scrolled back to hours later — read
  // alone, with no move count beside it to make "other" mean anything. Measured: 4
  // sites, 2 vocabularies, and the split is exactly this one; no site is on the wrong
  // side of it. The ruling is ADR-0029 (BLZ-482) — it used to live only here and in a
  // guard, which is not where a rule that governs four sites in three files belongs.
  //
  // BLZ-477 CORRECTS THE ATTRIBUTION BELOW, which named the wrong constants. Every site
  // IS pinned, so the rule could not lapse; what was wrong was which test pins which:
  //
  //   this line (applySummary)          tests/board-overstatement-guards.test.mjs
  //   reconcile-summary.mjs's toast     tests/board-overstatement-guards.test.mjs
  //   reconcile.mjs's dry-run tail      reconcile-change-report-oracle's DRYRUN_TAIL_RE
  //   reconcile.mjs's commit subject    reconcile-change-report-oracle's
  //                                     COMMIT_SUBJECT_MOVED_RE / _NONMOVED_RE
  //
  // COMMITTED_LINE_RE and QUEUED_LINE_RE were credited with pinning reconcile.mjs's two
  // sites. They do not: both match `res.stdout`, which is THIS function's line — the
  // oracle drives it through the CLI, so it is a second, independent pin on
  // `applySummary`, not a pin on reconcile.mjs. The commit subject was pinned by an
  // inline unnamed regex until BLZ-477 gave it the two named constants above.
  const suffix = nonMovedCount
    ? `, ${nonMovedCount} ticket(s) updated without a status change`
    : "";
  if (outcome === "queued") {
    return { stream: "out", exit: 0,
      text: "reconcile: queued (commitMode: batch) — run `blaze commit` to flush " +
        `${movedCount} ticket(s) moved${suffix}.` };
  }
  if (outcome === "committed") {
    return { stream: "out", exit: 0, text: `reconcile: committed ${movedCount} ticket(s) moved${suffix}.` };
  }
  if (outcome === "no-op") {
    // BLZ-422: benign, and said out loud rather than dressed up as a commit. Not an
    // error and not an exit code: an idempotent re-write is a correct outcome. What
    // it must not do is leave the operator believing a commit exists.
    return { stream: "out", exit: 0,
      text: `reconcile: NO COMMIT CREATED — the ${movedCount} ticket(s) moved${suffix} already ` +
        "matched HEAD, so git had nothing to commit. Nothing was added to `git log`." };
  }
  // BLZ-481: the two quantities, on THESE arms too. Every other arm states
  // `${movedCount} ticket(s) moved${suffix}`; these two named neither, so the one outcome
  // where a person has to go and look at the tree by hand was the one that did not tell
  // them how much of it to look at. "Ticket file(s) were already written to disk" with no
  // number is the same understatement `changes.length` used to make one line lower. Same
  // vocabulary as the other three arms, deliberately: these are WRITE-RECORD surfaces
  // (ADR-0029), so the non-moving quantity is spelled out rather than called "other".
  const written = `${movedCount} ticket(s) moved${suffix}`;
  if (outcome === "locked") {
    return { stream: "err", exit: 1,
      text: `reconcile: FAILED TO COMMIT — ${error}. ${written} — already ` +
        "written to disk and now UNCOMMITTED (a dirty tree), not merely un-applied. " +
        "Re-run once the lock clears, or commit the tree manually." };
  }
  if (outcome === "failed") {
    // BLZ-404 round 2 (blocking 1, item 3): this branch used to share the lock's own
    // wording ("re-run once the lock clears"), which is FALSE for a failing pre-commit
    // hook or a detached HEAD — outcomes that reach "failed", never "locked", and carry
    // no lock at all. Each outcome gets advice that is true for it.
    return { stream: "err", exit: 1,
      text: `reconcile: FAILED TO COMMIT — ${error}. ${written} — already ` +
        "written to disk and now UNCOMMITTED (a dirty tree), not merely un-applied. " +
        "No lock is involved in this failure — check for a failing pre-commit hook, a detached " +
        "HEAD, or another reason `git commit` itself refuses, fix it, then commit the tree " +
        "manually or re-run." };
  }
  return null;
}
