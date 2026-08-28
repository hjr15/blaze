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
import { test, describe } from "node:test";
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
import { commitOutcomeFrom, applySummary, COMMIT_OUTCOMES } from "../scripts/reconcile-commit-report.mjs";
import { OP_LABEL, entryIds, summarizeEntries } from "../scripts/commit-summary.mjs";
import { readEntries, sessionId } from "../scripts/pending-ledger.mjs";

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "blz-guards-"));
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
  const dir = mkdtempSync(join(tmpdir(), "blz-guards-board-"));
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

  test("reconcile's commit outcome distinguishes no-op from committed", () => {
    assert.equal(commitOutcomeFrom({ ok: true, committed: true, status: 0 }).outcome, "committed");
    assert.equal(commitOutcomeFrom({ ok: true, committed: false, noop: true, status: 0 }).outcome, "no-op");
    assert.equal(commitOutcomeFrom({ ok: true, committed: false, queued: true }).outcome, "queued");
    assert.equal(commitOutcomeFrom({ ok: false, committed: false, locked: true, status: -1 }).outcome, "locked");
    assert.equal(commitOutcomeFrom({ ok: false, committed: false, status: 1 }).outcome, "failed");
    assert.ok(COMMIT_OUTCOMES.includes("no-op"));
  });

  test("the no-op's rendered line does not claim a commit", () => {
    const line = applySummary({ outcome: "no-op", error: null, movedCount: 3, nonMovedCount: 1 });
    assert.doesNotMatch(line.text, /^reconcile: committed/);
    assert.match(line.text, /NO COMMIT CREATED/);
    assert.match(line.text, /git log/, "the line must say plainly that nothing was added to git log");
    assert.equal(line.exit, 0, "a benign no-op must not fail the run");
    // Every outcome that is not "committed" must be unable to produce the committed line.
    for (const outcome of COMMIT_OUTCOMES.filter((o) => o !== "committed")) {
      const l = applySummary({ outcome, error: "x", movedCount: 1, nonMovedCount: 0 });
      if (l) assert.doesNotMatch(l.text, /^reconcile: committed/, `${outcome} claimed a commit`);
    }
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

describe("BLZ-427: `blaze commit`'s subject counts tickets and names every op", () => {
  test("there is a label for every op that can be queued", () => {
    // The production call sites, enumerated: every `op:` any caller passes to
    // commitOrQueue. commit-or-queue.mjs refuses anything not in OP_LABEL, so this
    // list and that guard together make a raw op name unprintable.
    for (const op of ["new", "move", "edit", "log", "resolve", "link", "ac", "sprint", "reconcile"]) {
      assert.ok(Object.hasOwn(OP_LABEL, op), `no subject-line word for the "${op}" op`);
      assert.notEqual(OP_LABEL[op], undefined);
    }
    assert.equal(OP_LABEL.reconcile, "reconciled",
      "a reconcile op printed its raw name — the defect BLZ-427 records");
  });

  test("commitOrQueue refuses an op it has no word for", () => {
    const root = gitRepo();
    try {
      assert.throws(
        () => commitOrQueue({ root, mode: "batch", op: "teleport", id: "T-1", message: "m", files: [join(root, "t.md")] }),
        /unknown board op "teleport"/,
        "an unlabelled op must be refused where it is queued, not papered over in the summary");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("one reconcile op covering N tickets is counted as N, not 1", () => {
    const entries = [
      { op: "reconcile", id: "reconcile:ZZZ", ids: ["Z-1", "Z-2", "Z-3", "Z-4"] },
      { op: "move", id: "Z-9" },
    ];
    assert.deepEqual(entryIds(entries[0]), ["Z-1", "Z-2", "Z-3", "Z-4"]);
    assert.deepEqual(entryIds(entries[1]), ["Z-9"]);
    const s = summarizeEntries(entries);
    assert.match(s, /\b4 reconciled\b/, `one op covering four tickets must read "4 reconciled", got ${s}`);
    assert.doesNotMatch(s, /\b1 reconcile\b/, "the op count understates the pass");
    assert.match(s, /\b1 moved\b/);
  });

  test("the count is tickets, not ops: two edits to one ticket are one ticket", () => {
    assert.equal(summarizeEntries([{ op: "edit", id: "Z-1" }, { op: "edit", id: "Z-1" }]), "1 edited");
    assert.equal(summarizeEntries([{ op: "edit", id: "Z-1" }, { op: "edit", id: "Z-2" }]), "2 edited");
  });

  test("an entry queued by a pre-BLZ-427 engine (no `ids`) still drains and counts as one", () => {
    assert.equal(summarizeEntries([{ op: "reconcile", id: "reconcile:ZZZ" }]), "1 reconciled");
    // …and an op no longer in the table (a ledger written by a future/older engine)
    // falls back to its raw name rather than throwing: the queue must still flush.
    assert.equal(summarizeEntries([{ op: "teleport", id: "Z-1" }]), "1 teleport");
  });

  // BLZ-442: RENAMED to say what it actually pins. It calls `commitOrQueue` with a
  // hand-written `ids` array, so it pins the LEDGER'S SHAPE — dedup, and no `ids` field on
  // a one-ticket op — and nothing at all about whether reconcile passes that array. It
  // has no production hunk in reconcile.mjs to revert; the test below does.
  test("commitOrQueue's ledger entry dedupes its ids, and a one-ticket op grows none", () => {
    const root = gitRepo();
    const prev = process.env.BLAZE_SESSION;
    process.env.BLAZE_SESSION = "guards";
    try {
      commitOrQueue({
        root, mode: "batch", op: "reconcile", id: "reconcile:ZZZ",
        ids: ["Z-1", "Z-2", "Z-2", "Z-3"], message: "chore(board): reconcile", files: [join(root, "t.md")],
      });
      const [e] = readEntries(root, sessionId(process.env));
      assert.deepEqual(e.ids, ["Z-1", "Z-2", "Z-3"], "duplicate ids must not inflate the count");
      assert.equal(summarizeEntries([e]), "3 reconciled");
      // Per-ticket verbs leave the ledger shape untouched.
      commitOrQueue({ root, mode: "batch", op: "move", id: "Z-9", message: "m", files: [join(root, "t.md")] });
      const entries = readEntries(root, sessionId(process.env));
      assert.equal(Object.hasOwn(entries[1], "ids"), false,
        "a one-ticket op must not grow an `ids` field it does not need");
    } finally {
      if (prev === undefined) delete process.env.BLAZE_SESSION; else process.env.BLAZE_SESSION = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // BLZ-442: the test the name above used to promise. It drives the REAL `reconcile()`
  // over a real board on a `commitMode: "batch"` config, then reads the ledger FILE
  // reconcile itself wrote and compares its `ids` to the tickets that really changed on
  // disk. Ground truth is the filesystem, never `r.changes`. Measured: with the `ids:`
  // hunk deleted from reconcile.mjs, the old test — and this whole file — stayed green.
  test("reconcile's ledger entry really carries every ticket the pass wrote", async () => {
    const { reconcile } = await import("../scripts/reconcile.mjs");
    const root = mkdtempSync(join(tmpdir(), "blz442-reconcile-ledger-"));
    const codeRepo = mkdtempSync(join(tmpdir(), "blz442-code-"));
    const prev = process.env.BLAZE_SESSION;
    process.env.BLAZE_SESSION = "guards442";
    try {
      for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t.t"],
                       ["config", "user.name", "t"]]) {
        execFileSync("git", ["-C", codeRepo, ...a]);
      }
      writeFileSync(join(codeRepo, "README.md"), "x\n");
      execFileSync("git", ["-C", codeRepo, "add", "-A"]);
      execFileSync("git", ["-C", codeRepo, "commit", "-q", "-m", "seed"]);
      // BLZ-131's shipped-commit signal: three tickets that genuinely move defined -> done.
      const moving = ["ZZZ-1", "ZZZ-2", "ZZZ-3"];
      for (const id of moving) {
        execFileSync("git", ["-C", codeRepo, "commit", "-q", "--allow-empty", "-m", `${id}: shipped work`]);
      }

      const projects = join(root, "projects");
      mkdirSync(join(projects, "ZZZ", "defined"), { recursive: true });
      writeFileSync(join(root, "blaze.config.json"),
        JSON.stringify({ key: "ZZZ", projects: ["ZZZ"], commitMode: "batch" }));
      writeFileSync(join(projects, "ZZZ", "project.json"),
        JSON.stringify({ key: "ZZZ", codeRepos: [codeRepo] }));
      // A fourth ticket with no signal at all: it must NOT appear on the ledger, or the
      // assertion below would pass for a reconcile that simply listed the whole board.
      for (const id of [...moving, "ZZZ-4"]) {
        writeFileSync(join(projects, "ZZZ", "defined", `${id}-t.md`),
          `---\nid: ${id}\ntitle: t\ntype: task\nproject: ZZZ\nestimate: 30\n---\n\nbody\n`);
      }
      for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t.t"],
                       ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "seed board"]]) {
        execFileSync("git", ["-C", root, ...a]);
      }

      const at = (id) => ["defined", "done", "in-progress", "in-review"]
        .find((st) => existsSync(join(projects, "ZZZ", st, `${id}-t.md`)));
      const before = Object.fromEntries([...moving, "ZZZ-4"].map((id) => [id, at(id)]));

      await reconcile({ fetch: false, commit: true, dryRun: false, root });

      // (1) the filesystem: which tickets really changed status.
      const reallyMoved = [...moving, "ZZZ-4"].filter((id) => at(id) !== before[id]).sort();
      assert.deepEqual(reallyMoved, moving,
        `the fixture must move exactly ${moving.join(", ")} and leave ZZZ-4 alone, it moved ` +
        `${JSON.stringify(reallyMoved)}`);

      // (2) the ledger FILE reconcile wrote, read off disk.
      const entries = readEntries(root, sessionId(process.env));
      const reconcileOps = entries.filter((e) => e.op === "reconcile");
      assert.equal(reconcileOps.length, 1,
        `reconcile must queue exactly one op on a batch board, it queued ${reconcileOps.length}`);
      assert.deepEqual([...(reconcileOps[0].ids || [])].sort(), reallyMoved,
        "reconcile's queued ledger entry must name every ticket the pass really wrote — " +
        "without the `ids:` hunk the entry carries none and `blaze commit` counts the whole " +
        "pass as one ticket, which is exactly BLZ-427's defect");
      assert.equal(summarizeEntries(reconcileOps), `${reallyMoved.length} reconciled`,
        "the flush subject must count the tickets the filesystem says really moved");
    } finally {
      if (prev === undefined) delete process.env.BLAZE_SESSION; else process.env.BLAZE_SESSION = prev;
      rmSync(root, { recursive: true, force: true });
      rmSync(codeRepo, { recursive: true, force: true });
    }
  });
});

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
  // (scripts/views/reconcile-summary.mjs and scripts/reconcile-commit-report.mjs):
  // PREVIEW surfaces say "other update(s)"; WRITE-RECORD surfaces say "N ticket(s)
  // updated without a status change". Measured: 4 sites, 2 vocabularies, and no site is
  // on the wrong side.
  //
  // This file pins the TWO sites in the files it can reach. reconcile.mjs's other two —
  // the dry-run tail and the commit subject — belong to a different owner and are pinned
  // by name in tests/reconcile-change-report-oracle.test.mjs, by DRYRUN_TAIL_RE
  // ("other update(s)"), COMMITTED_LINE_RE and QUEUED_LINE_RE ("updated without a status
  // change"), against filesystem ground truth. Full convergence to ONE vocabulary would
  // require editing reconcile.mjs, so the ticket's second option was taken deliberately.
  test("the preview surface says 'other update(s)'", () => {
    const text = reconcileSummary({ ok: true, changes: [{ id: "T-1", moved: false }] });
    assert.match(text, /\b1 other update\(s\)/, `got ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, /updated without a status change/,
      "a preview must not borrow the write record's wording");
  });

  test("the write-record surface says 'N ticket(s) updated without a status change'", () => {
    for (const outcome of ["committed", "queued", "no-op"]) {
      const line = applySummary({ outcome, error: null, movedCount: 2, nonMovedCount: 3 });
      assert.match(line.text, /\b3 ticket\(s\) updated without a status change/,
        `${outcome}: got ${JSON.stringify(line.text)}`);
      assert.doesNotMatch(line.text, /other update\(s\)/,
        `${outcome}: a durable write record must not use the preview's shorthand — read alone, ` +
        "with no move count beside it, 'other' names nothing");
    }
  });

  test("neither surface states the quantity at all when it is zero", () => {
    assert.doesNotMatch(reconcileSummary({ ok: true, changes: [{ id: "T-1", moved: true }] }),
      /other update\(s\)/);
    assert.doesNotMatch(applySummary({ outcome: "committed", error: null, movedCount: 2, nonMovedCount: 0 }).text,
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
