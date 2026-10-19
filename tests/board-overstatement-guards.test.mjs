// tests/board-overstatement-guards.test.mjs — BLZ-426 + BLZ-422 + BLZ-427.
//
// The cross-product oracle (tests/board-overstatement-oracle.test.mjs) proves these
// three surfaces agree with the filesystem and `git log` over 160 generated cells.
// This file is the mutation-verification companion: one NAMED test per defect, so
// re-introducing the defect turns a test red whose name says what broke, rather than
// a cell coordinate. Each is proven by reverting its production hunk on a committed
// tree and watching exactly the named test below fail (recorded in the PR body).
//
// BLZ-442 corrected that claim, which was not true of every guard here. The test named
// for reconcile's ledger ids never invoked `reconcile` — it called `commitOrQueue` with a
// hand-written `ids` array — so deleting the `ids:` hunk from reconcile.mjs left this
// whole file 14/14 GREEN and only the oracle noticed, at a cell coordinate. That test is
// now two: one that says plainly it pins `commitOrQueue`'s ledger SHAPE and reverts
// nothing in reconcile, and one that drives the real `reconcile()` and reads the ledger
// file it actually wrote. Where a guard pins a seam rather than a production hunk, it
// says so in its own name.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { reconcileSummary, SUMMARY_FN_BEGIN, SUMMARY_FN_END } from "../scripts/views/reconcile-summary.mjs";
import { writeOutcome, WRITE_OUTCOME_FN_BEGIN, WRITE_OUTCOME_FN_END } from "../scripts/views/write-outcome.mjs";
import { pageHtml } from "../scripts/views/page.mjs";
import { commitFile } from "../scripts/serve-commit.mjs";
import { commitOrQueue, commitSuffix } from "../scripts/commit-or-queue.mjs";
import { appliedLine } from "../scripts/reconcile-apply-report.mjs";

/** Every scratch directory this file mints, removed once the file is done with them
 *  (BLZ-491). `tinyBoard()` had no teardown at all — four call sites, four
 *  `/tmp/blz-guards-board-*` directories per run, 356 of them on the machine where this was
 *  written — and `gitRepo()`'s callers each clean up in their own `finally`, which is one
 *  forgotten `finally` away from the same leak. Registering here means the teardown belongs
 *  to the helper rather than to every caller of it.
 *
 *  The litter was harmless on its own. What it cost is that `/tmp` noise could not be told
 *  from a real leak, and BLZ-485's mutation runner now asserts ZERO leftover
 *  `/tmp/blz-mutate-*` as the evidence its teardown works. `tests/tmp-scratch-attribution.test.mjs`
 *  runs this suite under a redirected `TMPDIR` and asserts the directory is empty after it,
 *  so removing this hook turns that test red by name. */
const SCRATCH = [];
after(() => { for (const dir of SCRATCH) rmSync(dir, { recursive: true, force: true }); });
const scratch = (dir) => { SCRATCH.push(dir); return dir; };

function gitRepo() {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz-guards-")));
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "t.md"), "one\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}
const head = (root) => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function tinyBoard() {
  const dir = scratch(mkdtempSync(join(tmpdir(), "blz-guards-board-")));
  mkdirSync(join(dir, "T", "defined"), { recursive: true });
  writeFileSync(join(dir, "T", "defined", "T-1.md"),
    "---\nid: T-1\ntitle: one\ntype: task\nproject: T\nestimate: 5\n---\nbody\n");
  return dir;
}

describe("BLZ-426: the dashboard never renders a refusal as an in-sync board", () => {
  test("a refused preview is never rendered as an in-sync board", () => {
    for (const body of [
      { ok: false, error: "unknown project key: NOPE", changes: [] },
      { ok: false, error: "--project needs at least one key", changes: [] },
    ]) {
      const text = reconcileSummary(body);
      assert.match(text, /REFUSED/, `a refusal must say so, got ${JSON.stringify(text)}`);
      assert.doesNotMatch(text, /no code-bound changes/,
        "a refused run and a clean board must not read the same");
      assert.match(text, /NOT checked/,
        "the sentence must say the board was never checked, not merely that something failed");
      assert.ok(text.includes(body.error), "the refusal must name its own reason");
    }
  });

  test("a body that does not say ok: true is treated as a refusal, not as a clean board", () => {
    // A 500's `{errors:[…]}`, a proxy error page parsed as JSON, an older server:
    // none of these is evidence that the board is in sync.
    for (const body of [{}, { errors: ["panel render failed"] }, { changes: [] }, null, { ok: "yes" }]) {
      assert.match(reconcileSummary(body), /REFUSED/,
        `a response without ok:true must not render as clean: ${JSON.stringify(body)}`);
    }
  });

  test("the served page runs the tested function itself, not a hand-kept duplicate", () => {
    const html = pageHtml({ project: "all", projectsDir: tinyBoard(), now: 1751932800000, transitions: [] });
    assert.ok(html.includes(String(reconcileSummary)),
      "the served page must contain reconcile-summary.mjs's own source verbatim — an inlined " +
      "copy can drift from the API, which is exactly how BLZ-405's fix failed to reach this consumer");
    const i = html.indexOf(SUMMARY_FN_BEGIN);
    const j = html.indexOf(SUMMARY_FN_END);
    assert.ok(i !== -1 && j > i, "the injected definition must be delimited so it can be recovered");
    // Exactly one definition: two would be a duplicate by construction.
    assert.equal(html.split(SUMMARY_FN_BEGIN).length - 1, 1);
    assert.equal(html.match(/function reconcileSummary\(/g).length, 1,
      "the page defines reconcileSummary more than once");
    // And the browser's copy behaves identically to the module's.
    // eslint-disable-next-line no-new-func -- compiling the page's own text is the point
    const fn = new Function(`${html.slice(i + SUMMARY_FN_BEGIN.length, j)}; return reconcileSummary;`)();
    const body = { ok: false, error: "unknown project key: NOPE", changes: [] };
    assert.equal(fn(body), reconcileSummary(body));
  });

  test("the served page's reconcile button CALLS the injected function, not a lookalike of its own", () => {
    // BLZ-443. The test above proves the injected source is PRESENT, delimited, defined
    // exactly once, and behaviourally identical to the module. None of that says the
    // button handler USES it. Measured: with the injection left intact and the handler
    // rewritten to call an inline duplicate under a different name, this file and the
    // 160-cell oracle both stayed green (55/55) — only the self-regenerating
    // page-golden.html snapshot noticed, and its own failure message tells the reader to
    // delete and regenerate it.
    const html = pageHtml({ project: "all", projectsDir: tinyBoard(), now: 1751932800000, transitions: [] });
    const end = html.indexOf(SUMMARY_FN_END);
    assert.ok(end !== -1, "the injected definition is not delimited, so the handler cannot be located after it");
    // Everything the page runs OUTSIDE the injected definition. A call found here is the
    // page's own wiring, not part of the function's source.
    const wiring = html.slice(end + SUMMARY_FN_END.length);

    const handler = /getElementById\("reconcileBtn"\)[\s\S]{0,600}?\n\s*\}\);/.exec(wiring);
    assert.ok(handler,
      "the served page has no #reconcileBtn click handler after the injected definition");
    assert.match(handler[0], /toast\(\s*reconcileSummary\(/,
      "the reconcile button's handler must pass the preview response through the INJECTED " +
      "reconcileSummary — a handler that summarises the response itself, under any name, is " +
      "the hand-kept duplicate the injection exists to prevent, and it can render a refusal " +
      "as an in-sync board (BLZ-426) while the injected copy sits unused beside it. Handler " +
      `source was:\n${handler[0]}`);
    assert.equal((wiring.match(/reconcileSummary\(/g) || []).length, 1,
      "reconcileSummary must be called exactly once outside its own definition — the button " +
      "handler, and nowhere else");
  });

  test("a non-moving update is not counted as a code-bound move", () => {
    // BLZ-401's distinction, at this consumer: `changes` also carries entries where a
    // resolution was backfilled or a record filled with `from === to`.
    const text = reconcileSummary({
      ok: true,
      changes: [
        { id: "T-1", moved: true, cleared: false },
        { id: "T-2", moved: false, cleared: false },
        { id: "T-3", moved: false, cleared: true },
      ],
    });
    assert.match(text, /\b1 code-bound move\(s\)/, `got ${JSON.stringify(text)}`);
    assert.match(text, /\b2 other update\(s\)/, `got ${JSON.stringify(text)}`);
    assert.match(text, /\b1 would have their branch\/pr CLEARED/);
    assert.doesNotMatch(text, /3 code-bound move/,
      "counting every change entry as a move overstates how many tickets change status");
  });
});

describe("BLZ-422: a no-op is never reported as a commit", () => {
  test("commitFile's empty-diff no-op is not reported as a commit", () => {
    const root = gitRepo();
    try {
      const f = join(root, "t.md");
      const before = head(root);
      writeFileSync(f, "one\n"); // byte-identical: the idempotent re-write
      const c = commitFile(root, f, "T-1: edit");
      assert.equal(head(root), before, "fixture check: git really had nothing to commit");
      assert.equal(c.ok, true, "a benign no-op must stay benign — an idempotent re-write is not an error");
      assert.equal(c.committed, false,
        "commitFile reported a commit that is not in `git log` — BLZ-422's own defect");
      assert.equal(c.noop, true, "the no-op must be nameable, not merely inferable");

      writeFileSync(f, "two\n");
      const c2 = commitFile(root, f, "T-1: edit");
      assert.notEqual(head(root), before, "fixture check: a real commit really happened");
      assert.equal(c2.committed, true, "a real commit must say so");
      assert.notDeepEqual(c, c2, "a no-op and a real commit must not return the same shape");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("BLZ-254: an applied reconcile names its store and never claims a commit", () => {
    const fs = appliedLine({ mode: "fs", movedCount: 3, nonMovedCount: 1 });
    assert.match(fs, /^reconcile: 3 ticket\(s\) moved, 1 ticket\(s\) updated without a status change in the board's files/);
    assert.match(fs, /makes no git commit/);
    assert.doesNotMatch(fs, /\bcommitted\b|queued|HEAD/, "the board never commits — no line may say it did");
    const db = appliedLine({ mode: "db", movedCount: 2, nonMovedCount: 0 });
    assert.equal(db, "reconcile: 2 ticket(s) moved in the database.");
    assert.equal(appliedLine({ mode: "dual", movedCount: 1, nonMovedCount: 0 }),
      appliedLine({ mode: "fs", movedCount: 1, nonMovedCount: 0 }), "dual writes the files, so it reads as fs");
  });

  test("each per-ticket verb says so when no commit was created", () => {
    assert.equal(commitSuffix({ ok: true, committed: true }), "");
    assert.equal(commitSuffix({ ok: true, committed: false, queued: true }), " (queued for blaze commit)");
    assert.match(commitSuffix({ ok: true, committed: false, noop: true }), /no commit created/i);
    assert.notEqual(commitSuffix({ ok: true, committed: false, noop: true }),
      commitSuffix({ ok: true, committed: true }),
      "an idempotent re-write and a real commit must not print the same line");
  });
});

// BLZ-254: BLZ-427's describe (`blaze commit`'s subject counts tickets and names every op) is
// deleted — it pinned OP_LABEL, summarizeEntries and the pending-ledger entries of commitOrQueue
// and reconcile, all of which are deleted with `blaze commit` (spec §5.5).

describe("BLZ-450: an in-sync claim never sits beside a degraded check", () => {
  // Reproduced BEFORE it was changed, because the ticket was flagged UNPROVEN and
  // PRE-EXISTING. Both halves were checked and both held: at the function, and end to
  // end through the real `reconcilePreview` on a board with one `defined` ticket and a
  // `gh` that exits 1 — which returns `{ok:true, changes:[], forgeErrors:[1]}` and
  // composed exactly "no code-bound changes · 1 forge problem(s)". The end-to-end half
  // is the oracle's own `forge-error-clean` shape (added by this ticket); this file
  // holds the named unit guard.
  test("a zero-change preview with an unreadable forge does not claim the board is in sync", () => {
    const text = reconcileSummary({ ok: true, changes: [], findings: [], forgeErrors: [{ repo: "r", error: "gh: 1" }] });
    assert.match(text, /forge problem\(s\)/, `the degraded check must still be named, got ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, /^no code-bound changes/,
      "an unreadable forge means candidates were never examined, so 'no code-bound changes' " +
      "asserts an in-sync board the run is not entitled to claim — BLZ-450's own defect. " +
      `Got ${JSON.stringify(text)}`);
    assert.match(text, /says nothing about whether the board is in sync/,
      `the clause must be QUALIFIED, not merely reworded, got ${JSON.stringify(text)}`);
  });

  test("a zero-change preview with a READABLE forge still says the board is in sync", () => {
    // The other direction, or the guard above is satisfied by a summary that never
    // claims an in-sync board at all — which would be a different overstatement.
    const text = reconcileSummary({ ok: true, changes: [], findings: [], forgeErrors: [] });
    assert.equal(text, "no code-bound changes",
      "a clean board whose forge WAS readable must still say so plainly");
  });

  test("a degraded forge with real changes still reports them — only the in-sync claim is withheld", () => {
    const text = reconcileSummary({
      ok: true,
      changes: [{ id: "T-1", moved: true }, { id: "T-2", moved: false }],
      forgeErrors: [{ repo: "r", error: "gh: 1" }],
    });
    assert.match(text, /1 code-bound move\(s\)/, `got ${JSON.stringify(text)}`);
    assert.match(text, /1 other update\(s\)/, `got ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, /says nothing about whether the board is in sync/,
      "a count of what WAS found is not an in-sync claim, and must not be qualified as one");
  });
});

describe("BLZ-447: one quantity, two vocabularies, split on the preview/write-record line", () => {
  // The rule, decided rather than converged, and written down in both files it governs
  // (scripts/views/reconcile-summary.mjs and scripts/reconcile-apply-report.mjs):
  // PREVIEW surfaces say "other update(s)"; WRITE-RECORD surfaces say "N ticket(s)
  // updated without a status change". Measured: 4 sites, 2 vocabularies, and no site is
  // on the wrong side.
  //
  // This file pins the TWO sites in the files it can reach. reconcile.mjs's other ones —
  // the dry-run tail (DRYRUN_TAIL_RE) and the applied line (APPLIED_LINE_RE) — belong to a
  // different owner and are pinned by name in tests/reconcile-change-report-oracle.test.mjs
  // ("other update(s)" and "updated without a status change" respectively), against
  // filesystem ground truth. Full convergence to ONE vocabulary would
  // require editing reconcile.mjs, so the ticket's second option was taken deliberately.
  test("the preview surface says 'other update(s)'", () => {
    const text = reconcileSummary({ ok: true, changes: [{ id: "T-1", moved: false }] });
    assert.match(text, /\b1 other update\(s\)/, `got ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, /updated without a status change/,
      "a preview must not borrow the write record's wording");
  });

  test("the write-record surface says 'N ticket(s) updated without a status change'", () => {
    // BLZ-254: one applied line per store now (scripts/reconcile-apply-report.mjs), so the
    // loop is over the stores rather than BLZ-481's five commit outcomes.
    for (const mode of ["fs", "db"]) {
      const line = appliedLine({ mode, movedCount: 2, nonMovedCount: 3 });
      assert.match(line, /\b3 ticket\(s\) updated without a status change/,
        `${mode}: got ${JSON.stringify(line)}`);
      assert.doesNotMatch(line, /other update\(s\)/,
        `${mode}: a durable write record must not use the preview's shorthand — read alone, ` +
        "with no move count beside it, 'other' names nothing");
    }
  });

  // BLZ-254: BLZ-481's locked/failed test is deleted — no locked or failed arm exists now.

  test("neither surface states the quantity at all when it is zero", () => {
    assert.doesNotMatch(reconcileSummary({ ok: true, changes: [{ id: "T-1", moved: true }] }),
      /other update\(s\)/);
    assert.doesNotMatch(appliedLine({ mode: "fs", movedCount: 2, nonMovedCount: 0 }),
      /updated without a status change/);
  });
});

describe("BLZ-449: the dashboard surfaces the git outcome of a write", () => {
  test("an idempotent re-write is not reported as a commit", () => {
    const note = writeOutcome({ ok: true, committed: false, queued: false });
    assert.match(note, /no commit created/i,
      `a POST whose commit was an empty-diff no-op must say so, got ${JSON.stringify(note)}`);
    assert.match(note, /git log/,
      "and must say plainly that nothing was added to git log");
  });

  test("a queued write is named as queued, not as an idempotent no-op", () => {
    // `committed: false` is true of BOTH, and testing it first would report a real
    // pending write as "the file already matched HEAD".
    const note = writeOutcome({ ok: true, committed: false, queued: true });
    assert.match(note, /queued for blaze commit/, `got ${JSON.stringify(note)}`);
    assert.doesNotMatch(note, /already matched HEAD/,
      "a deferred commit is not an absent one");
  });

  // BLZ-670 (final review): under BLAZE_WRITE_PORT=db `stageFor("db")` answers
  // {committed:false, queued:false} for EVERY write — there is no file to commit — so the
  // committed===false arm told the operator "the file already matched HEAD" on every click.
  // A db write is the database's ordinary case, like a real commit: it says nothing.
  test("a database-mode write is not reported as an idempotent no-op", () => {
    const note = writeOutcome({ ok: true, committed: false, queued: false, db: true });
    assert.doesNotMatch(note, /already matched HEAD/, `got ${JSON.stringify(note)}`);
    assert.doesNotMatch(note, /no commit created/, `got ${JSON.stringify(note)}`);
    assert.equal(note, "");
  });

  test("a real commit says nothing — one op, one commit is the board's ordinary case", () => {
    assert.equal(writeOutcome({ ok: true, committed: true, queued: false }), "");
    assert.equal(writeOutcome({ ok: false, errors: ["nope"] }), "");
    assert.equal(writeOutcome(null), "");
  });

  test("the dashboard's words for a git outcome are the CLI's words", () => {
    // The binding BLZ-447 is about, applied to BLZ-449's own sentence: the two doors
    // onto the same fact must not grow two vocabularies. `commitSuffix` is what every
    // per-ticket CLI verb appends; each of its phrases must appear verbatim in the
    // dashboard's sentence for the same outcome.
    for (const [c, body] of [
      [{ ok: true, committed: false, queued: true }, { ok: true, committed: false, queued: true }],
      [{ ok: true, committed: false, noop: true }, { ok: true, committed: false, queued: false }],
    ]) {
      const cli = commitSuffix(c).trim();
      assert.notEqual(cli, "", "fixture check: this outcome must have a CLI suffix at all");
      assert.ok(writeOutcome(body).includes(cli),
        `the dashboard says ${JSON.stringify(writeOutcome(body))} where the CLI says ` +
        `${JSON.stringify(cli)} — two doors onto one fact must not word it differently`);
    }
  });

  test("the served page runs THIS definition, and calls it exactly once", () => {
    // The same two proofs BLZ-426 established for reconcileSummary: the page carries this
    // module's own source text, and the one call site is the page's own wiring. Without
    // the call site the fields are back to having no consumer, which is the whole ticket.
    const html = pageHtml({ project: "all", projectsDir: tinyBoard(), now: 1751932800000, transitions: [] });
    assert.ok(html.includes(String(writeOutcome)),
      "the served page does not contain write-outcome.mjs's own source — the dashboard is " +
      "running a DUPLICATE, or nothing at all");
    const begin = html.indexOf(WRITE_OUTCOME_FN_BEGIN);
    const end = html.indexOf(WRITE_OUTCOME_FN_END);
    assert.ok(begin !== -1 && end > begin, "the injected definition is not delimited");
    const wiring = html.slice(0, begin) + html.slice(end + WRITE_OUTCOME_FN_END.length);
    assert.equal((wiring.match(/writeOutcome\(/g) || []).length, 1,
      "writeOutcome must be called exactly once outside its own definition — blazePost, and " +
      "nowhere else");
    assert.match(html.slice(end), /const note = writeOutcome\(j\);\s*\n\s*if \(note\) toast\(note\);/,
      "blazePost must pass the 200 body through the INJECTED writeOutcome and toast the " +
      "result — a success path that discards the body is exactly BLZ-449's defect");
  });

  test("the extracted browser copy behaves like the module's", () => {
    // Evaluated from the page's own text, not from the import — a stale injected copy
    // fails here rather than passing quietly.
    const html = pageHtml({ project: "all", projectsDir: tinyBoard(), now: 1751932800000, transitions: [] });
    const i = html.indexOf(WRITE_OUTCOME_FN_BEGIN);
    const j = html.indexOf(WRITE_OUTCOME_FN_END);
    // eslint-disable-next-line no-new-func -- compiling the page's own text is the point
    const fn = new Function(`${html.slice(i + WRITE_OUTCOME_FN_BEGIN.length, j)}; return writeOutcome;`)();
    for (const body of [
      { ok: true, committed: false, queued: false },
      { ok: true, committed: false, queued: true },
      { ok: true, committed: true, queued: false },
      { ok: false, errors: ["nope"] },
    ]) {
      assert.equal(fn(body), writeOutcome(body),
        `the page's copy disagrees with the module for ${JSON.stringify(body)}`);
    }
  });
});
