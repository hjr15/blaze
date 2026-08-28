// scripts/views/write-outcome.mjs — the ONE definition of what the dashboard says
// after a write, about GIT rather than about the file.
//
// BLZ-449. BLZ-422 gave `commitFile` a `committed` field so a caller can tell a real
// commit from its benign empty-diff no-op, and serve.mjs's POST 200 body has carried
// `{committed, queued}` ever since. Nothing read it: `blazePost` in page.mjs did
// `if (res.ok) { swapView(); return true; }` and dropped the body on the floor. So
// re-checking an already-checked AC box — an idempotent re-write, ordinary dashboard
// traffic — returned `committed: false` and the page said nothing at all, on a board
// whose model is "one op, one commit". That is structurally the same "the fix never
// reached the consumer" shape BLZ-426 exists to prevent: a distinction made at the
// API and never carried to the person reading the screen.
//
// The CLI verbs already say this, through `commitSuffix` in scripts/commit-or-queue.mjs,
// whose own comment names `POST /api/ac` as one of the idempotent cases. This is that
// sentence for the other door, and it uses commitSuffix's WORDS — the two are bound by
// a test (tests/board-overstatement-guards.test.mjs) that asserts each phrase here is a
// substring of the CLI's, so the two doors cannot drift into two vocabularies for one
// fact. Changing one without the other fails by name.
//
// The alternative BLZ-449 allowed was deleting `committed`/`queued` from the response.
// Measured before choosing: the fields have 1 producer (serve.mjs's `gitOutcome`) and,
// before this change, 0 consumers anywhere in the tree. Deleting them would have taken
// the distinction back out of the API that six CLI call sites already render, so the
// consumer was added instead.
//
// CONSTRAINTS — identical to reconcile-summary.mjs's, and for the same reason: this
// source is injected verbatim into a browser `<script>` inside page.mjs's template
// literal. No `${`, no imports, no closure over module scope, nothing that can contain
// the literal text `</script>`.
export function writeOutcome(j) {
  var body = j || {};
  // Only a 200 reaches here; a non-ok body is already toasted as an error by the
  // caller. `ok !== true` is still checked rather than assumed, for the same reason
  // reconcileSummary checks it (BLZ-446): a body this consumer does not understand
  // must produce no sentence at all rather than a confident one.
  if (body.ok !== true) return "";
  // ORDER MATTERS. A queued write is `committed: false` too, and it is not a no-op —
  // the commit is deferred to `blaze commit`, not absent because there was nothing to
  // commit. Testing `committed` first would report a real pending write as an
  // idempotent one.
  if (body.queued === true) return "saved (queued for blaze commit) — nothing is in git log yet";
  if (body.committed === false) {
    return "saved (no commit created — the file already matched HEAD) — nothing was added to git log";
  }
  // A real commit needs no sentence: the board's model is one op, one commit, and
  // saying so on every click is noise the operator learns to ignore.
  return "";
}

// The markers page.mjs wraps the injected source in, so a test can recover exactly the
// definition the browser runs — the same construction reconcile-summary.mjs uses.
export const WRITE_OUTCOME_FN_BEGIN = "/* BLAZE_WRITE_OUTCOME_BEGIN */";
export const WRITE_OUTCOME_FN_END = "/* BLAZE_WRITE_OUTCOME_END */";
