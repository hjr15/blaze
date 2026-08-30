// tests/commit-status.test.mjs — BLZ-499, the surface ADR-0032 calls for.
//
// BLZ-432 asked whether `reconcile` should detect a ticket tree left uncommitted by an
// EARLIER pass. Four rounds of BLZ-404 tried and were refuted; round 5 deleted the
// detector and recorded, without evidence, that telling the three board states apart
// "needs the pending ledger, not `git status`".
//
// The phase-1 measurement (docs/superpowers/plans/2026-08-29-blz-432-design.md, pinned to
// blaze-pm 70197405c278bc404ff92d0743e58c06406def62) supplied the evidence and inverted the
// question. The condition BLZ-432 names measured at ZERO — the board's tree was clean, and
// no traceable write had ever survived more than 5.65h. What measured at 185 was a
// different condition: undrained pending-ledger ops in 8 of 14 session queues, aged 2-5
// days, whose files had all been filed by 61 HAND-WRITTEN commits. The `blaze commit` flush
// path had filed exactly 0 of them.
//
// So the oracle is the LEDGER, not the tree, and the owner is `blaze commit`, not
// reconcile. `scripts/reconcile.mjs` is not touched by this change at all.
//
// What every test here is defending, and why the shape matters:
//
//   * The probe is `git diff --quiet HEAD -- <path recorded in the ledger>` (plus a
//     tracked/exists check for a `new` op's untracked file). Paths go IN after `--`; only
//     an EXIT CODE comes out. Nothing parses a path out of git's output, so BLZ-347's
//     deliberately-deleted porcelain path parser is not reintroduced (T3).
//   * Nothing walks `projects/`, so a symlinked `projects/` cannot silence it — the exact
//     case BLZ-404 round 3/4's detector was written to catch and UNDER-fired on (T4).
//   * It is read-only. It commits nothing and clears nothing, so BLZ-394's blast-radius
//     rule is not engaged: the set of files a flush stages is unchanged (T5, T6).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, symlinkSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { appendEntry, ledgerPath, outstandingFiles } from "../scripts/pending-ledger.mjs";

const REPO = join(import.meta.dirname, "..");
const HARNESS_ID = "test-harness-uuid";

/** A temp board carrying its own copy of scripts/, so the copied runner resolves its
 *  script-relative root to the fixture and never to this worktree.
 *
 *  BLZ-491: the prefix is a LITERAL at the `mkdtempSync` call, not a parameter. It used to
 *  be `board(prefix = "blaze-commitstatus-")`, which reads identically at every one of the
 *  15 call sites but is invisible to `tests/tmp-scratch-attribution.test.mjs` — that scan
 *  is static, so a variable prefix drops this suite out of the attribution buckets and a
 *  leaked /tmp directory could no longer be traced back here. The parameter was never once
 *  overridden, so inlining it loses nothing. */
function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-commitstatus-"));
  cpSync(join(REPO, "scripts"), join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "projects", "ZZZ", "defined"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "seed"), "seed");
  execFileSync("git", ["-C", root, "add", "seed"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

const gitIn = (root, ...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
const headCount = (root) => Number(gitIn(root, "rev-list", "--count", "HEAD").trim());

/** Commit a ticket file so it is TRACKED, then optionally dirty it. */
function trackedTicket(root, rel, body = "one\n") {
  writeFileSync(join(root, rel), body);
  execFileSync("git", ["-C", root, "add", "--", rel]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", `add ${rel}`]);
}

/** A batch-mode board whose `projects/` is a SYMLINK, the fixture BLZ-404 round 3/4 died
 *  on and the one review round 1 used to refute this verb's first implementation. */
function symlinkBoard() {
  const root = mkdtempSync(join(tmpdir(), "blaze-symlinkboard-"));
  cpSync(join(REPO, "scripts"), join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "real", "projects", "ZZZ", "defined"), { recursive: true });
  symlinkSync("real/projects", join(root, "projects"));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify(
    { projects: ["ZZZ"], boardTitle: "t", codeRepos: [], commitMode: "batch" }, null, 2));
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "seed"), "seed");
  execFileSync("git", ["-C", root, "add", "seed"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

/** Queue a real `blaze new` through the REAL runner, and return the ticket path exactly as
 *  the verb recorded it in the ledger. Driving the verb rather than hand-writing the ledger
 *  is the whole point: the recorded spelling IS the thing under test. */
function newTicket(root, session, title = "a ticket") {
  const r = spawnSync(process.execPath,
    [join(root, "scripts", "new-runner.mjs"), "--project", "ZZZ", "--type", "task", "--estimate", "30", title],
    { cwd: root, encoding: "utf8", env: { ...process.env, BLAZE_SESSION: session } });
  assert.equal(r.status, 0, `blaze new failed: ${r.stderr}`);
  const entries = readFileSync(ledgerPath(root, session), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const md = entries.at(-1).files.find((f) => f.endsWith(".md"));
  assert.ok(md, "the `new` op must record a ticket file");
  return md;
}

function runStatus(root, { session, harnessId = HARNESS_ID, env: extra = {}, args = ["--status"] } = {}) {
  const env = { ...process.env, ...extra };
  if (session) env.BLAZE_SESSION = session; else delete env.BLAZE_SESSION;
  if (harnessId === null) delete env.CLAUDE_CODE_SESSION_ID;
  else env.CLAUDE_CODE_SESSION_ID = harnessId;
  const r = spawnSync(process.execPath, [join(root, "scripts", "commit-runner.mjs"), ...args],
    { cwd: root, env, encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe("outstandingFiles — the ledger is the oracle, and only an exit code comes out of git", () => {
  // T1 pins: pending-ledger.mjs `outstandingFiles`, the status-1 => outstanding branch.
  test("T1: a queued write whose file still differs from HEAD is reported OUTSTANDING", () => {
    const root = board();
    try {
      const rel = "projects/ZZZ/defined/ZZZ-1.md";
      trackedTicket(root, rel);
      writeFileSync(join(root, rel), "one\nEDITED BY A VERB, NOT YET COMMITTED\n");
      const r = outstandingFiles(root, [rel]);
      assert.deepEqual(r.outstanding, [rel],
        "a tracked ledger-recorded file that differs from HEAD is the whole point of the verb");
      assert.deepEqual(r.settled, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // T2 pins: the status-0 => settled branch. THIS IS THE 185-ORPHAN CONDITION.
  test("T2: a queued write whose file already matches HEAD is reported ORPHANED, not outstanding", () => {
    const root = board();
    try {
      const rel = "projects/ZZZ/defined/ZZZ-2.md";
      trackedTicket(root, rel); // written AND committed — by a hand commit, as on the live board
      const r = outstandingFiles(root, [rel]);
      assert.deepEqual(r.settled, [rel],
        "185 ops on blaze-pm 70197405 were in exactly this state: filed by something else, ledger never cleared");
      assert.deepEqual(r.outstanding, [],
        "reporting an already-filed op as outstanding is the false alarm that made design 2 useless");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // T3 pins: BLZ-347's regression guard — the path is an ARGUMENT, never parsed out of output.
  test("T3: a recorded path with a space and a non-ASCII character is classified correctly", () => {
    const root = board();
    try {
      const dirty = "projects/ZZZ/defined/ZZZ-3 spaced ünicode.md";
      const clean = "projects/ZZZ/defined/ZZZ-4 also spaced é.md";
      trackedTicket(root, dirty);
      trackedTicket(root, clean);
      writeFileSync(join(root, dirty), "one\nDIRTY\n");
      const r = outstandingFiles(root, [dirty, clean]);
      assert.deepEqual(r.outstanding, [dirty],
        "a porcelain path parser mangles this name; passing it after `--` does not");
      assert.deepEqual(r.settled, [clean]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // T4. REBUILT after review round 1. The first version hand-wrote the ledger with the
  // REAL path and then asserted, in prose, a production property that was FALSE: on a
  // symlinked board the real verb records the THROUGH-SYMLINK path, git indexes the real
  // one, and every op came back `outstanding` forever — including the already-filed ones.
  // That test pinned its own fixture premise, not the product, in the most consequential
  // place in the change. It now queues through the ACTUAL verb and asserts both directions.
  test("T4: on a symlinked `projects/`, an already-filed op is ORPHANED, not falsely outstanding", () => {
    const root = symlinkBoard();
    try {
      const rel = newTicket(root, "sess");
      // The ledger records the through-symlink path; git will index the real one.
      assert.ok(rel.startsWith("projects/"), `the verb recorded ${rel}`);
      // File it by hand at its real path — the exact 185-orphan condition on the live board.
      execFileSync("git", ["-C", root, "add", "-A"]);
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "hand commit at the real path"]);
      assert.ok(gitIn(root, "ls-files").includes("real/projects/"),
        "fixture check: git really did index the ticket under its REAL path");

      // Design 2's probe, on this same fixture, to keep its UNDER-fire on the record:
      assert.equal(gitIn(root, "status", "--porcelain", "--", "projects/").trim(), "",
        "fixture check: `git status --porcelain -- projects/` goes blind through the symlink");

      const r = outstandingFiles(root, [rel]);
      assert.deepEqual(r.outstanding, [],
        "reporting a filed op as outstanding is the OVER-fire twin of design 2's under-fire");
      assert.deepEqual(r.settled, [rel]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("T4b: on a symlinked `projects/`, a genuinely unfiled op is still OUTSTANDING", () => {
    const root = symlinkBoard();
    try {
      const rel = newTicket(root, "sess"); // queued, never committed
      assert.deepEqual(outstandingFiles(root, [rel]).outstanding, [rel],
        "fixing the over-fire must not silence the case the verb exists for");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("T4c: the whole `--status` report is correct end-to-end on a symlinked board", () => {
    const root = symlinkBoard();
    try {
      newTicket(root, "sess");
      execFileSync("git", ["-C", root, "add", "-A"]);
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "hand commit"]);
      const out = runStatus(root, { session: "sess" }).stdout;
      assert.match(out, /outstanding: 0 file\(s\)/,
        `the verb still over-fires end-to-end:\n${out}`);
      assert.match(out, /orphaned: {4}2 file\(s\)/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Reachability: this branch is reachable and common — a `new` op's file is untracked
  // until the flush commits it. `git diff HEAD` alone CANNOT see it (it returns 0), which
  // is why the tracked/exists check exists rather than being decoration.
  test("T1b: an untracked file recorded by a `new` op is OUTSTANDING, not silently settled", () => {
    const root = board();
    try {
      const rel = "projects/ZZZ/defined/ZZZ-6.md";
      writeFileSync(join(root, rel), "created by `blaze new`, never committed\n");
      assert.equal(
        spawnSync("git", ["-C", root, "diff", "--quiet", "HEAD", "--", rel]).status, 0,
        "fixture check: `git diff HEAD` is BLIND to an untracked file — this is why the extra check exists");
      assert.deepEqual(outstandingFiles(root, [rel]).outstanding, [rel]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a move's old path that is already gone and untracked is neither outstanding nor settled", () => {
    const root = board();
    try {
      const gone = "projects/ZZZ/defined/ZZZ-7.md";
      const r = outstandingFiles(root, [gone]);
      assert.deepEqual(r.outstanding, []);
      assert.deepEqual(r.settled, []);
      assert.deepEqual(r.absent, [gone],
        "a path relocated and filed within an earlier batch must not be counted as work outstanding");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // T8 pins: ADR-0030's rule — a probe that could not look does not report what a probe
  // that looked reports. Reachable: `git` absent or unable to fork is an ordinary state.
  test("T8: a `git diff` that cannot answer FAILS rather than reporting a clean queue", () => {
    const root = board();
    try {
      const rel = "projects/ZZZ/defined/ZZZ-8.md";
      trackedTicket(root, rel);
      const bin = join(root, "fakebin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 129\n");
      chmodSync(join(bin, "git"), 0o755);
      assert.throws(
        () => outstandingFiles(root, [rel], { gitBin: join(bin, "git") }),
        /could not answer|git/i,
        "an unanswerable probe must not be read as `settled` — that is exactly ADR-0030's rule");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // T8b. ADDED after review round 1. T8's blanket-failing stub is intercepted by the FIRST
  // probe (`ls-files`), so it only ever exercised the tracked-check's throw — the diff
  // probe's throw was discriminated by NO test, and replacing it with a raw
  // `spawnSync(...).status === 1` left the suite fully green. A two-mode stub is what
  // separates them: `ls-files` answers 0/1 normally, `diff` cannot answer.
  test("T8b: a `git diff` that cannot answer FAILS even when `ls-files` answered fine", () => {
    const root = board();
    try {
      const rel = "projects/ZZZ/defined/ZZZ-9.md";
      trackedTicket(root, rel);
      const bin = join(root, "fakebin");
      mkdirSync(bin, { recursive: true });
      // Mode 1: ls-files delegates to the real git, so tracked/untracked is answered
      // honestly. Mode 2: diff exits 129, the shape of a git that could not look.
      writeFileSync(join(bin, "git"),
        '#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "diff" ]; then exit 129; fi\ndone\nexec ' +
        execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim() + ' "$@"\n');
      chmodSync(join(bin, "git"), 0o755);

      // Prove mode 1 really does answer, so a throw cannot be coming from the tracked check.
      assert.equal(spawnSync(join(bin, "git"),
        ["-C", root, "ls-files", "--error-unmatch", "--", rel], { stdio: "ignore" }).status, 0,
        "fixture check: the stub answers ls-files normally");
      assert.equal(spawnSync(join(bin, "git"),
        ["-C", root, "diff", "--quiet", "HEAD", "--", rel], { stdio: "ignore" }).status, 129,
        "fixture check: the stub cannot answer diff");

      assert.throws(
        () => outstandingFiles(root, [rel], { gitBin: join(bin, "git") }),
        /could not answer/,
        "the DIFF probe's ADR-0030 throw must be its own pinned guard, not a shadow of ls-files'");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("`blaze commit --status` — read-only, and pinned to be read-only", () => {
  /** Queue one op against `rel` on `session`'s queue. */
  function queue(root, session, rel, op = "move", id = "ZZZ-1") {
    appendEntry(root, { id, op, message: `${id}: queued`, files: [rel], ts: new Date().toISOString(), session }, session);
  }

  // T5 pins: BLZ-394's blast-radius guard — the early return sits BEFORE the lock,
  // the `git add` and the `git commit`, exactly where checkBranch sits, and for the
  // same reason: a read must leave nothing half-made.
  test("T5: --status creates no commit and clears no ledger", () => {
    const root = board();
    try {
      const rel = "projects/ZZZ/defined/ZZZ-1.md";
      trackedTicket(root, rel);
      writeFileSync(join(root, rel), "one\nDIRTY\n");
      queue(root, HARNESS_ID, rel);
      const path = ledgerPath(root, HARNESS_ID);
      const before = { head: headCount(root), ledger: readFileSync(path, "utf8") };

      const r = runStatus(root, { session: HARNESS_ID });
      assert.equal(r.status, 0, r.stderr);

      assert.equal(headCount(root), before.head, "--status must author no commit");
      assert.equal(readFileSync(path, "utf8"), before.ledger, "--status must not clear or rewrite the ledger");
      assert.equal(readFileSync(join(root, rel), "utf8"), "one\nDIRTY\n",
        "sanity: the working tree is untouched");
      assert.match(r.stdout, /read-only/i, "the verb must say plainly that it wrote nothing");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // T6 pins: cli.mjs's `mutates: false` for a read-only verb path (BLZ-121).
  test("T6: --status runs under BLAZE_READONLY=1", () => {
    const root = board();
    try {
      const rel = "projects/ZZZ/defined/ZZZ-1.md";
      trackedTicket(root, rel);
      queue(root, HARNESS_ID, rel);
      const r = spawnSync(process.execPath,
        [join(root, "scripts", "cli.mjs"), "commit", "--status"],
        { cwd: root, encoding: "utf8",
          env: { ...process.env, BLAZE_READONLY: "1", CLAUDE_CODE_SESSION_ID: HARNESS_ID, BLAZE_SESSION: "" } });
      assert.equal(r.status, 0,
        `a pure read must not be refused by the BLZ-121 gate: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /read-only|refus/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // T7 pins: the report covers EVERY queue, not just the caller's own. The 185 orphans on
  // blaze-pm 70197405 were spread across 8 sessions, none of them the caller's.
  test("T7: a queue belonging to another session is named, with its op count", () => {
    const root = board();
    try {
      const rel = "projects/ZZZ/defined/ZZZ-1.md";
      trackedTicket(root, rel);
      queue(root, "some-abandoned-session", rel);
      queue(root, "some-abandoned-session", rel, "log", "ZZZ-2");
      const r = runStatus(root, { session: "a-totally-different-session" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /some-abandoned-session/,
        "an abandoned queue nobody owns is precisely what this verb exists to surface");
      assert.match(r.stdout, /\b2\b/, "its op count must be named");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("--status distinguishes an outstanding queue from an orphaned one", () => {
    const root = board();
    try {
      const dirty = "projects/ZZZ/defined/ZZZ-1.md";
      const filed = "projects/ZZZ/defined/ZZZ-2.md";
      trackedTicket(root, dirty);
      trackedTicket(root, filed);
      writeFileSync(join(root, dirty), "one\nSTILL UNCOMMITTED\n");
      queue(root, "queue-with-work", dirty);
      queue(root, "queue-already-filed", filed, "log", "ZZZ-2");
      const r = runStatus(root, { session: HARNESS_ID });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /outstanding/i);
      assert.match(r.stdout, /orphan/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("--status on a board with no queues says so and exits 0", () => {
    const root = board();
    try {
      const r = runStatus(root, { session: HARNESS_ID });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /no pending|nothing queued|0 op/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("--status names the states it does NOT report, so it cannot be read as a clean-tree claim", () => {
    const root = board();
    try {
      const rel = "projects/ZZZ/defined/ZZZ-1.md";
      trackedTicket(root, rel);
      queue(root, HARNESS_ID, rel);
      const r = runStatus(root, { session: HARNESS_ID });
      // ADR-0030 / BLZ-433: a surface that reports one thing must not imply it reports all.
      assert.match(r.stdout, /does not|not report|in-flight|failed/i,
        "the verb must state its own blind spots — states (a) and (c) are undecidable from the ledger");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("--help names --status", () => {
    const root = board();
    try {
      const r = runStatus(root, { session: HARNESS_ID, args: ["--help"] });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /--status/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// T10. The doc and the verb must move together. Placed here rather than in
// commands-doc-quiet-pins.test.mjs (which the phase-2 plan named) because that file is
// scoped to reconcile's `--quiet` row and reads it as its input; this pins a different
// page section against a different verb, and hiding it there would bury it.
describe("the page and the verb do not drift (BLZ-499, BLZ-501)", () => {
  const page = readFileSync(join(REPO, "docs", "guide", "commands.md"), "utf8");

  test("T10: commands.md documents `--status`, and its usage line matches the verb's own --help", () => {
    const root = board();
    try {
      assert.match(page, /\|\s*`--status`\s*\|/,
        "every flag `blaze commit` accepts must have a row in its flag table");
      const usage = page.split("\n").find((l) => l.startsWith("blaze commit ["));
      assert.ok(usage, "commands.md must carry a `blaze commit [...]` usage line");
      const help = runStatus(root, { session: HARNESS_ID, args: ["--help"] }).stdout;
      for (const flag of ["--all", "--shared", "--branch-ok", "--status"]) {
        assert.ok(help.includes(flag), `the verb's --help must name ${flag}`);
        assert.ok(usage.includes(flag), `commands.md's usage line must name ${flag} — it drifted for --branch-ok already`);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("BLZ-501: docs/design.md does not quote a product string the CLI no longer emits", () => {
    // Whitespace-normalised on purpose. The first version of this fix left the dead string
    // in the file line-WRAPPED, and a naive /.../ match walked straight past it — the test
    // passed while the defect stood. The revert rule caught that; matching the collapsed
    // text is what makes this assertion mean anything.
    const design = readFileSync(join(REPO, "docs", "design.md"), "utf8").replace(/\s+/g, " ");
    assert.doesNotMatch(design, /standalone board — nothing to reconcile/,
      "the live string is `reconcile: no projects configured — nothing to reconcile.`; "
      + "quoting a dead one is exactly BLZ-433's class of defect");
  });
});

// ---------------------------------------------------------------------------------------
// BLZ-518 — a *status* verb that aborts is reporting nothing.
//
// Found by the adversarial review of BLZ-499's PR. Three inputs each took the WHOLE report
// down at `blaze` PR #158 head, verified again here at be4b110 before the fix:
//
//   | input                                        | result                                  |
//   |----------------------------------------------|-----------------------------------------|
//   | a ledger entry lacking `files`                | `ERR_INVALID_ARG_TYPE` out of `path.join`|
//   | a queue file that is a DIRECTORY              | raw `EISDIR` stack                       |
//   | ONE out-of-board or absolute recorded path    | the BLZ-394 refusal, thrown uncaught     |
//
// The third is the worst, and is why this is not cosmetic: a single malformed entry in one
// queue hides the state of ALL the others. On the live board that is eight queues' worth of
// information lost to one bad line — and BLZ-498's orphaned-queue condition is exactly the
// situation where an old malformed entry is most likely to be sitting.
//
// What is NOT being changed: the out-of-board path is still REFUSED, never reported on.
// BLZ-394's blast-radius rule is correct and the refusal survives; what stops is the
// refusal taking eight healthy queues with it. And per ADR-0030, a queue that could not be
// read is never rendered as a queue that was read and found clean — in the output OR in the
// exit code, which is why a degraded report exits 2 rather than 0.
describe("BLZ-518: --status degrades per queue instead of aborting the whole report", () => {
  const HEALTHY = "a-healthy-session";
  const BROKEN = "a-broken-session";

  /** A board with one healthy queue, so every test below can assert the healthy queue is
   *  STILL reported — which is the actual defect, not the crash. */
  function boardWithHealthyQueue() {
    const root = board();
    const rel = "projects/ZZZ/defined/ZZZ-1.md";
    trackedTicket(root, rel);
    writeFileSync(join(root, rel), "one\nDIRTY\n");
    appendEntry(root, { id: "ZZZ-1", op: "move", message: "ZZZ-1: queued", files: [rel], ts: new Date().toISOString(), session: HEALTHY }, HEALTHY);
    return root;
  }

  /** The rendered block for ONE queue. Blocks are blank-line separated, so this keeps every
   *  assertion below inside the queue it names — a `stdout`-wide regex like
   *  /broken[\s\S]*?outstanding:/ matches straight across into the NEXT queue's buckets and
   *  would pass while the defect stood. */
  const blockFor = (out, name) => {
    const b = out.split("\n\n").find((chunk) => chunk.includes(name));
    assert.ok(b, `no rendered block for queue ${name}`);
    return b;
  };

  const assertHealthyStillReported = (out) => {
    const healthy = blockFor(out, HEALTHY);
    assert.match(healthy, /outstanding: 1 file\(s\)/,
      "the healthy queue must still be reported WITH its buckets — that IS the ticket");
    assert.doesNotMatch(healthy, /could not be read/);
  };

  // Pins: commit-runner.mjs's per-entry `files` check inside the per-queue try/catch.
  test("BLZ-518a: a ledger entry with no `files` list degrades ONLY its own queue", () => {
    const root = boardWithHealthyQueue();
    try {
      writeFileSync(ledgerPath(root, BROKEN), JSON.stringify({ id: "ZZZ-9", op: "log", message: "ZZZ-9: no files key", ts: "t" }) + "\n");
      const r = runStatus(root, { session: HEALTHY });
      assert.doesNotMatch(r.stderr, /ERR_INVALID_ARG_TYPE|Cannot read|TypeError/,
        "a malformed ledger entry must not surface as a node type error");
      const broken = blockFor(r.stdout, BROKEN);
      assert.match(broken, /could not be read/, "the broken queue must be named AND marked unreadable");
      assert.match(broken, /`files` list/, "the reason must name the missing FIELD, not just say 'error'");
      assert.match(broken, /entry 1 \(id ZZZ-9, op log\)/, "and which entry, so the bad line can be found");
      assertHealthyStillReported(r.stdout);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Pins: the per-queue try/catch around readEntries — a different throw site from 518a's,
  // reverted separately below because one catch serving two shapes looks pinned when only
  // one is exercised.
  test("BLZ-518b: a queue file that is a DIRECTORY is reported as unreadable, not an EISDIR stack", () => {
    const root = boardWithHealthyQueue();
    try {
      mkdirSync(ledgerPath(root, BROKEN), { recursive: true });
      const r = runStatus(root, { session: HEALTHY });
      assert.doesNotMatch(r.stderr, /EISDIR/, "a directory where a queue should be must not surface as a raw errno stack");
      assert.match(blockFor(r.stdout, BROKEN), /could not be read: .*EISDIR/,
        "named, unreadable, and carrying the reason it could not be read");
      assertHealthyStillReported(r.stdout);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Pins: the per-queue try/catch around outstandingFiles — the BLZ-394 refusal is raised
  // from inside `ask()` in pending-ledger.mjs and must still be raised, just contained.
  test("BLZ-518c: an out-of-board recorded path is STILL refused (BLZ-394) but takes down only its own queue", () => {
    const root = boardWithHealthyQueue();
    try {
      writeFileSync(ledgerPath(root, BROKEN), JSON.stringify({ id: "ZZZ-9", op: "log", message: "ZZZ-9: outside", files: ["/etc/passwd"], ts: "t" }) + "\n");
      const r = runStatus(root, { session: HEALTHY });
      const broken = blockFor(r.stdout, BROKEN);
      assert.match(broken, /could not be read: .*refusing to report a queue as settled/,
        "the BLZ-394 refusal must still be the reason given");
      // THE REFUSAL SURVIVES: nothing outside the board is reported on. If this queue ever
      // starts showing outstanding/orphaned counts, BLZ-394's blast radius has been widened.
      assert.doesNotMatch(broken, /outstanding: \d/,
        "an out-of-board path must never be REPORTED ON — refusing is correct, the bug was the blast radius of the refusal");
      assert.match(r.stdout, /totals above DO NOT cover them/,
        "and the totals must disclaim it rather than silently omitting it");
      assertHealthyStillReported(r.stdout);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Pins: renderQueueStatus's unreadable-queue accounting, and the exit code. ADR-0030.
  test("BLZ-518d: when EVERY queue is unreadable the run does not report 'nothing queued', and exits 2", () => {
    const root = board();
    try {
      mkdirSync(ledgerPath(root, BROKEN), { recursive: true });
      const r = runStatus(root, { session: HEALTHY });
      assert.doesNotMatch(r.stdout, /Nothing queued/,
        "a run that could not look must not report what a run that looked and found nothing reports (ADR-0030)");
      assert.match(r.stdout, /1 queue\(s\) could not be read/);
      assert.equal(r.status, 2,
        "a caller scripting on the exit code must be able to tell an incomplete report from a clean board");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // The property BLZ-499 turns on, re-asserted on the DEGRADED path specifically: the
  // crashes were loud and wrote nothing, and the fix must not buy legibility with a write.
  test("BLZ-518e: a degraded report still commits nothing, clears nothing and takes no lock", () => {
    const root = boardWithHealthyQueue();
    try {
      writeFileSync(ledgerPath(root, BROKEN), JSON.stringify({ id: "ZZZ-9", op: "log", message: "ZZZ-9: outside", files: ["/etc/passwd"], ts: "t" }) + "\n");
      const before = { head: headCount(root), healthy: readFileSync(ledgerPath(root, HEALTHY), "utf8"), broken: readFileSync(ledgerPath(root, BROKEN), "utf8") };
      const r = runStatus(root, { session: HEALTHY });
      assert.equal(r.status, 2);
      assert.equal(headCount(root), before.head, "--status must author no commit, degraded or not");
      assert.equal(readFileSync(ledgerPath(root, HEALTHY), "utf8"), before.healthy);
      assert.equal(readFileSync(ledgerPath(root, BROKEN), "utf8"), before.broken, "a malformed queue must not be 'cleaned up' by a read");
      assert.equal(existsSync(join(root, ".blaze", "commit.lock")), false, "a read takes no lock");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
