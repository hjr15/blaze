// tests/board-overstatement-guards.test.mjs — BLZ-426 + BLZ-422 + BLZ-427.
//
// The cross-product oracle (tests/board-overstatement-oracle.test.mjs) proves these
// three surfaces agree with the filesystem and `git log` over 160 generated cells.
// This file is the mutation-verification companion: one NAMED test per defect, so
// re-introducing the defect turns a test red whose name says what broke, rather than
// a cell coordinate. Each was proven by reverting its production hunk on a committed
// tree and watching exactly the named test below fail (recorded in the PR body).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { reconcileSummary, SUMMARY_FN_BEGIN, SUMMARY_FN_END } from "../scripts/views/reconcile-summary.mjs";
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

  test("reconcile's ledger entry really carries every ticket the pass wrote", () => {
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
});
