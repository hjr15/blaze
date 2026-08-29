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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { appendEntry, ledgerPath, outstandingFiles } from "../scripts/pending-ledger.mjs";

const REPO = join(import.meta.dirname, "..");
const HARNESS_ID = "test-harness-uuid";

/** A temp board carrying its own copy of scripts/, so the copied runner resolves its
 *  script-relative root to the fixture and never to this worktree. */
function board(prefix = "blaze-commitstatus-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
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

  // T4 pins: design 2's specific UNDER-fire. Reproduced in phase 1 against real git.
  test("T4: `projects/` as a symlink does not silence the report", () => {
    const root = board();
    try {
      const rel = "real/projects/ZZZ/defined/ZZZ-5.md";
      mkdirSync(join(root, "real", "projects", "ZZZ", "defined"), { recursive: true });
      trackedTicket(root, rel);
      rmSync(join(root, "projects"), { recursive: true, force: true });
      symlinkSync("real/projects", join(root, "projects"));
      writeFileSync(join(root, rel), "one\nDIRTY BEHIND A SYMLINK\n");

      // The probe BLZ-404 round 3/4 used, proving the fixture really is the failing case:
      const porcelain = gitIn(root, "status", "--porcelain", "--", "projects/").trim();
      assert.equal(porcelain, "",
        "fixture check: `git status --porcelain -- projects/` really does go blind through the symlink");

      const r = outstandingFiles(root, [rel]);
      assert.deepEqual(r.outstanding, [rel],
        "the ledger records the real path, so the symlink is never on the probe's path at all");
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
