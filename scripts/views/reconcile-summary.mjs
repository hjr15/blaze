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
  // STRICTLY `ok === true`. `reconcilePreview` sets `ok` on every path it takes, so
  // anything else is either one of its two refusals (an unknown --project key, or
  // --project given no key at all — both carry `changes: []`, which is byte-identical
  // to a genuinely clean board) or a response this consumer does not understand at
  // all (a 500's `{errors:[…]}`, a proxy's error page). Neither is an in-sync board,
  // and neither may be rendered as one.
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
  if (other) parts.push(other + " other update(s)");
  if (!moved && !other) parts.push("no code-bound changes");
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
