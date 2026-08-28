// scripts/views/reconcile-summary.mjs — the ONE definition of the sentence the
// dashboard's "reconcile" button shows after reading `/api/reconcile-preview`.
//
// BLZ-426: this composition used to live INLINE inside page.mjs's client-side
// `<script>`, which is itself inside a template literal — unreachable from any
// test, and it silently disagreed with the API. `reconcilePreview()` has
// returned `{ok:false, error, changes:[]}` on a refusal since BLZ-405, and the
// inlined consumer read `j.changes`, `c.cleared`, `j.findings` and
// `j.forgeErrors` but never `j.ok` or `j.error` — so a refused run fell to the
// `moves ? … : "no code-bound changes"` branch and toasted "no code-bound
// changes": an in-sync board that is not in sync, it just never ran. That is
// the exact sentence BLZ-405 fixed at the API and never carried to the consumer.
//
// It lives here, alone, so that:
//   1. it is callable as a pure function from a test, and
//   2. the served page provably uses THIS function — page.mjs injects
//      `String(reconcileSummary)` verbatim between the two marker comments
//      below rather than keeping a hand-copied duplicate that can drift.
// A test asserts the served HTML CONTAINS this function's exact source and then
// evaluates the copy it extracted from that HTML, so a re-inlined duplicate
// fails rather than passing quietly.
//
// CONSTRAINTS, because this source is injected into a browser `<script>` that
// lives inside a template literal in page.mjs:
//   - no backticks and no `${`;
//   - no imports, no closure over module scope — `String(fn)` carries the body
//     and nothing else, so anything it references must be a parameter or a
//     local;
//   - nothing that can contain the literal text `</script>`.
export function reconcileSummary(j) {
  var body = j || {};
  // STRICTLY `ok === true`, and the reason is NOT only a contract one.
  //
  // BLZ-446 — the reachability of this branch, stated plainly, because BLZ-426 was
  // documented as a CONTRACT-ONLY fix and that understated it:
  //
  //   UNREACHABLE through the route. `reconcilePreview`'s own two refusals (an
  //   unknown --project key, and --project given no key at all) both require
  //   `projects !== null`, and serve.mjs's `/api/reconcile-preview` never passes
  //   one. Those two bodies are reachable only through `reconcile` the CLI. For
  //   them this really is a contract gap, tested as one.
  //
  //   REACHABLE through the route, today, with no code change at all. This
  //   consumer `fetch`es one URL and parses whatever comes back, and the route
  //   can answer with a body that is not `{ok:true}` on paths that have nothing
  //   to do with `projects`:
  //     - 401 `{errors:[…]}` from `gate()` — no credential, or an expired,
  //       revoked or unknown bearer token, on any board with users configured;
  //     - 503 `{errors:["authentication is temporarily unavailable"]}` when the
  //       gate itself throws (a locked or unreadable identity.db);
  //     - 503 `{errors:[…]}` before first-run setup completes;
  //     - 500 `{errors:[…]}`, or a reverse proxy's own error page.
  //   Under the pre-BLZ-426 inline code every one of those left `j.changes`
  //   undefined, so `moves` was 0 and the toast read "no code-bound changes" —
  //   an in-sync board reported on an AUTH FAILURE. That was a live production
  //   bug, not a contract gap, and it is what this branch stops.
  //
  // So: anything that is not `ok === true` is either a refusal or a response
  // this consumer does not understand. Neither is an in-sync board, and neither
  // may be rendered as one.
  if (body.ok !== true) {
    var why = body.error
      || (body.errors && body.errors.length ? body.errors.join("; ") : "")
      || "the server did not say why";
    return "reconcile REFUSED: " + why
      + " — the board was NOT checked, so this says nothing about whether it is in sync";
  }
  var changes = body.changes || [];
  // BLZ-401's distinction, carried to this consumer: `changes` also carries entries
  // where a resolution was backfilled or a delivery record cleared/filled with
  // `from === to`. Counting all of them as "code-bound move(s)" overstates how many
  // tickets would actually change status — the same overstatement BLZ-401 removed
  // from reconcile's own CLI tail line.
  var moved = 0;
  var other = 0;
  var cleared = 0;
  for (var i = 0; i < changes.length; i += 1) {
    var c = changes[i] || {};
    if (c.moved) moved += 1; else other += 1;
    if (c.cleared) cleared += 1;
  }
  var findings = (body.findings || []).length;
  var forge = (body.forgeErrors || []).length;
  var parts = [];
  if (moved) parts.push(moved + " code-bound move(s) — apply via 'blaze reconcile --apply'");
  // BLZ-447: "other update(s)" here, "N ticket(s) updated without a status change"
  // in reconcile-commit-report.mjs, for the same quantity. The split is DELIBERATE
  // and it is the preview/write-record line, not an accident: the two PREVIEW
  // surfaces (this toast, and reconcile.mjs's `(dry-run: N move(s), M other
  // update(s); …)` tail) both say "other update(s)"; the two WRITE-RECORD surfaces
  // (`applySummary`'s post-apply line, and the commit subject reconcile.mjs writes)
  // both say "N ticket(s) updated without a status change". A preview is a short
  // parenthetical about what WOULD happen and is read next to its own move count; a
  // write record is a durable sentence about what DID happen, read later and alone,
  // where "other" names nothing. The ruling is ADR-0027 (BLZ-482).
  //
  // All four sites are pinned, so the rule cannot lapse on one side without a named
  // failure — but BLZ-477 corrects WHICH test pins which, because this sentence named
  // the wrong constants. This toast and `applySummary` are pinned by
  // tests/board-overstatement-guards.test.mjs. reconcile.mjs's dry-run tail is pinned by
  // tests/reconcile-change-report-oracle.test.mjs's DRYRUN_TAIL_RE, and its commit
  // subject by that file's COMMIT_SUBJECT_MOVED_RE / COMMIT_SUBJECT_NONMOVED_RE.
  // COMMITTED_LINE_RE and QUEUED_LINE_RE pin NEITHER reconcile.mjs site: both match
  // `res.stdout`, which is `applySummary`'s line driven through the CLI.
  if (other) parts.push(other + " other update(s)");
  if (!moved && !other) {
    // BLZ-450: "no code-bound changes" is an IN-SYNC CLAIM, and it used to sit
    // beside "N forge problem(s)" in the same sentence — asserting the board is in
    // sync in the same breath as saying the check was degraded. Reproduced end to
    // end before it was changed: one `defined` ticket, a `gh` that exits 1, and the
    // real `reconcilePreview` returns `{ok:true, changes:[], forgeErrors:[1]}`,
    // which composed exactly "no code-bound changes · 1 forge problem(s)".
    // PRE-EXISTING — the pre-BLZ-426 inline code composed it identically, so
    // BLZ-426 did not introduce it. An unreadable forge means candidates were never
    // examined, so "nothing to do" is not a thing this run is entitled to say; it
    // may only report what it could decide.
    parts.push(forge
      ? "no code-bound change was DECIDABLE, but the forge could not be read — this says "
        + "nothing about whether the board is in sync"
      : "no code-bound changes");
  }
  if (cleared) parts.push(cleared + " would have their branch/pr CLEARED");
  if (findings) parts.push(findings + " need attention");
  if (forge) parts.push(forge + " forge problem(s)");
  return parts.join(" · ");
}

// The markers page.mjs wraps the injected source in, so a test can recover
// exactly the definition the browser runs. Exported (rather than duplicated in
// the test) so the page, the extractor and the assertion cannot drift apart.
export const SUMMARY_FN_BEGIN = "/* BLAZE_RECONCILE_SUMMARY_BEGIN */";
export const SUMMARY_FN_END = "/* BLAZE_RECONCILE_SUMMARY_END */";
