// tests/reconcile-unfinished-pass.test.mjs — BLZ-404, round-5 adversarial review.
//
// Round 2 shipped `dirtyTicketPaths`: a recovery WRITE that reused `git status
// --porcelain` output to finish a previous pass's uncommitted commit. Round 3 deleted
// that write and replaced it with `hasUncommittedTicketChanges` / `dirtyTicketTree`: a
// BOOLEAN detect-and-report. Round 4's adversarial review refuted the boolean too — it
// conflates three distinct board states and asserts the wrong one:
//   1. a previous pass genuinely failed to commit (the only state it was meant to catch);
//   2. a `commitMode: "batch"` board that queued a change BY DESIGN — healthy, but the
//      very next run falsely blamed "a previous pass wrote ticket files and failed to
//      commit them" and exited 1;
//   3. a human's own untracked file under `projects/<KEY>/` (a draft, a swapfile) —
//      healthy, but it wedges `blaze reconcile` at exit 1 permanently, and the remedy it
//      prints (`blaze commit`) is a no-op.
// It also UNDER-fired on the case it was written to close: with `projects/` a symlink,
// `git status --porcelain` through the symlinked path exits 0 printing nothing, so the
// detector reports a clean board over a genuinely dirty one, forever.
//
// There is no version of this that works from the tree alone: telling "a previous pass
// of MINE failed to commit" apart from "this tree is dirty for a reason I neither caused
// nor can see" needs the pending ledger, not `git status`. That is a real feature with its
// own ticket and its own design — it is not built here. `hasUncommittedTicketChanges`,
// `dirtyTicketTree`, and every branch that read them are DELETED. What remains is the
// actual defect underneath all four rounds: the CLI's "already in sync — nothing to do."
// asserted more than reconcile knows. Reconcile knows one thing — whether THIS pass found
// any code-bound change to make — and says exactly that now, nothing about the state of
// the git tree.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { acquireLock, releaseLock } from "../scripts/commit-lock.mjs";

const RECONCILE_BIN = join(import.meta.dirname, "..", "scripts", "reconcile.mjs");

function gitInit(dir) {
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
}

function headCount(dir) {
  try {
    return Number(execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim());
  } catch {
    return 0;
  }
}

function headSha(dir) {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function porcelain(root, ...pathspec) {
  return execFileSync("git", ["-C", root, "status", "--porcelain", "--", ...pathspec], { encoding: "utf8" }).trim();
}

/** A board with ONE ticket that a real `<KEY>-<n>:` commit on the code repo's default
 *  branch drives from `defined` straight to `done` — copied from
 *  tests/reconcile-commit-routing.test.mjs's `movableBoard`. */
function movableBoard(tmp, cfgExtra = {}) {
  const repo = join(tmp, "code");
  mkdirSync(repo, { recursive: true });
  gitInit(repo);
  writeFileSync(join(repo, "README.md"), "x\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "OBA-1: shipped work"]);

  const root = join(tmp, "board");
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "OBA", projects: ["OBA"], ...cfgExtra }));
  writeFileSync(join(projects, "OBA", "project.json"), JSON.stringify({ key: "OBA", codeRepos: [repo] }));
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\n---\n\nbody\n");

  gitInit(root);
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed board"]);
  return { root, repo };
}

describe("BLZ-404 round 5: the cross-pass dirty-tree detector is deleted — reconcile reports only what THIS pass found", () => {
  test("after a locked commit, the run THAT FAILED still exits non-zero and prints its accurate remediation", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r5-locked-"));
    try {
      const { root } = movableBoard(tmp);
      const before = headCount(root);

      const lock = acquireLock(root);
      assert.equal(lock.ok, true, "test setup: must actually acquire the lock");
      const run1 = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      releaseLock(root);

      assert.notEqual(run1.status, 0, "the run that failed must exit non-zero");
      assert.match(run1.stderr, /FAILED TO COMMIT/, "the run that failed must print its accurate remediation");
      assert.equal(headCount(root), before, "run 1 must not have committed anything");
      assert.notEqual(porcelain(root), "", "test setup: run 1 must leave the board dirty (moved on disk, not committed)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the very next run after that failure is honest about what IT did — it does not claim to recover anything, but it also no longer wrongly errors", () => {
    // This is round 4's stated, deliberate gap, pinned rather than hidden: reconcile does
    // not detect a ticket tree an EARLIER pass left uncommitted — that needs the pending
    // ledger, not `git status`, and is out of scope here (see the PR body). What IS in
    // scope is that this pass must not lie about ITSELF: it decided nothing new, so it
    // must not claim to have recovered anything, and (round 4's actual bug) it must not
    // invent a false accusation ("a previous pass wrote ticket files and failed to commit
    // them") on a board this pass cannot actually distinguish from a batch queue or a
    // human's own uncommitted edit.
    const tmp = mkdtempSync(join(tmpdir(), "blz404r5-honest-"));
    try {
      const { root } = movableBoard(tmp);
      const lock = acquireLock(root);
      const run1 = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      releaseLock(root);
      assert.notEqual(run1.status, 0);
      const dirtyAfterRun1 = porcelain(root);
      assert.notEqual(dirtyAfterRun1, "", "test setup: run 1 must leave the board dirty");
      const headAfterRun1 = headSha(root);

      const run2 = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      assert.equal(run2.status, 0,
        "run 2 decided nothing new of its own — it must not error over a condition it cannot " +
        "attribute to itself (round 4's false accusation)");
      assert.doesNotMatch((run2.stdout + run2.stderr), /recovered/i,
        "reconcile must not claim to have recovered anything — it makes no such attempt");
      assert.doesNotMatch((run2.stdout + run2.stderr), /previous pass wrote ticket files/i,
        "reconcile must not accuse a previous pass of anything — it cannot tell that apart " +
        "from a batch-queued or human-authored dirty tree");
      assert.equal(headSha(root), headAfterRun1, "run 2 must not move HEAD at all");
      assert.equal(porcelain(root), dirtyAfterRun1,
        "run 2 must leave the tree exactly as it found it — untouched, still dirty (the " +
        "documented gap: nothing here detects or clears it)");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("commitMode: 'batch' board: --apply twice — the second run exits 0 and does not blame a failed commit", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r5-batch-"));
    try {
      const { root } = movableBoard(tmp, { commitMode: "batch" });

      const run1 = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      assert.equal(run1.status, 0, `test setup: a queued move must exit 0, got: ${run1.stderr}`);
      assert.match(run1.stdout, /queued \(commitMode: batch\)/);
      assert.notEqual(porcelain(root), "",
        "test setup: a queued (uncommitted) move must leave the tree dirty by design");

      // Round 4's reproduction: the deleted detector saw this same, healthy, by-design
      // dirty tree on the very next run and falsely blamed a failed commit — exit 1,
      // regressing from run 1's own exit 0.
      const run2 = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      assert.equal(run2.status, 0,
        `a commitMode: batch board's second run must exit 0, not blame a failed commit — ` +
        `got status ${run2.status}, stderr: ${run2.stderr}`);
      assert.doesNotMatch((run2.stdout + run2.stderr), /failed to commit/i,
        "a batch-queued board is healthy — nothing here failed to commit");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an untracked non-ticket file under projects/<KEY>/: --apply exits 0, the file is neither committed nor complained about", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r5-notes-"));
    try {
      const { root } = movableBoard(tmp);

      // Bring the board to a genuinely in-sync, fully-committed state first.
      const seed = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      assert.equal(seed.status, 0, `test setup: the seeding pass must succeed: ${seed.stderr}`);
      assert.equal(porcelain(root), "", "test setup: the board must be fully in sync before the probe");

      // A human's own draft file, untracked and unrelated to any ticket.
      writeFileSync(join(root, "projects", "OBA", "NOTES.md"), "draft thoughts, not a ticket\n");
      const before = headSha(root);
      const beforeCount = headCount(root);

      const res = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });

      assert.equal(res.status, 0,
        `a human's own untracked file must not wedge reconcile — got status ${res.status}, ` +
        `stderr: ${res.stderr}`);
      assert.doesNotMatch((res.stdout + res.stderr), /NOTES\.md/,
        "reconcile must not single out or complain about a file it never wrote and cannot " +
        "explain");
      assert.doesNotMatch((res.stdout + res.stderr), /uncommitted changes this pass did not make/i,
        "reconcile must not accuse anything of leaving this file behind");
      assert.equal(headSha(root), before, "HEAD must not move — the untracked file must never be committed");
      assert.equal(headCount(root), beforeCount);
      const status = porcelain(root, join(root, "projects"));
      assert.match(status, /\?\? .*NOTES\.md/, "the file must still be untracked, exactly as the human left it");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the in-sync line says only what reconcile knows — that THIS pass found no code-bound change — nothing about the tree", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r5-wording-"));
    try {
      const { root } = movableBoard(tmp);
      const seed = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      assert.equal(seed.status, 0, `test setup: the seeding pass must succeed: ${seed.stderr}`);

      const res = spawnSync(process.execPath, [RECONCILE_BIN], { cwd: root, encoding: "utf8" });
      assert.equal(res.status, 0);
      // Pinned so a future edit cannot quietly restore an over-claim: the line must not
      // assert anything is "in sync" (a claim about the WHOLE board's git tree, which
      // reconcile cannot see) — it may only claim it found nothing to move.
      assert.doesNotMatch(res.stdout, /in sync/i,
        "reconcile must not claim the board is 'in sync' — it only knows whether THIS pass " +
        "found a code-bound change to make");
      assert.match(res.stdout, /reconcile: no code-bound change found — nothing to do\./,
        `expected the exact honest wording, got: ${JSON.stringify(res.stdout)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a failing pre-commit hook (no lock involved) gets its own, accurate remediation text", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r5-hook-"));
    try {
      const { root } = movableBoard(tmp);
      const hook = join(root, ".git", "hooks", "pre-commit");
      writeFileSync(hook, "#!/bin/sh\nexit 1\n");
      execFileSync("chmod", ["+x", hook]);
      const res = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /FAILED TO COMMIT/);
      assert.doesNotMatch(res.stderr, /lock clears/i,
        "a pre-commit hook failure carries no lock at all — telling the operator to wait for one to clear is false advice");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("BLZ-404 round 2 (blocking 3): the supervisor feed reports 'queued', not just applied/locked/failed", () => {
  test("commitMode: 'batch' — runReconcile publishes an event naming the queue / blaze commit", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r2-batch-"));
    const prevSession = process.env.BLAZE_SESSION;
    let app;
    try {
      const { root } = movableBoard(tmp);
      writeFileSync(join(root, "blaze.config.json"),
        JSON.stringify({ key: "OBA", projects: ["OBA"], commitMode: "batch" }));
      process.env.BLAZE_SESSION = "blz404r2-batch-test";

      const { loadConfig } = await import("../scripts/config.mjs");
      const { createApp } = await import("../scripts/supervisor.mjs");
      app = createApp(loadConfig({ root }), { root });
      const events = [];
      app.bus.subscribe((e) => events.push(e));
      await app.runReconcile();

      const queueEvents = events.filter((e) => /queue|blaze commit/i.test(e.message || e.state || ""));
      assert.ok(queueEvents.length > 0,
        "the feed must say what the CLI says on a batch board — that the change is queued and " +
        `\`blaze commit\` flushes it — got: ${JSON.stringify(events)}`);
    } finally {
      if (prevSession === undefined) delete process.env.BLAZE_SESSION; else process.env.BLAZE_SESSION = prevSession;
      if (app) app.server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// BLZ-406: `project-mismatch` deliberately NARROWS the invariant this describe block
// pins. It is raised from the FULL ticket walk — before the `--project` scope guard,
// unconditionally, on every run mode (see reconcile.mjs) — precisely so a ticket no
// single-project run can ever reconcile is still reported, not silently dropped. That
// means an out-of-scope ticket CAN legitimately be named on a scoped run: through its
// own project-mismatch finding, and nowhere else. `stripProjectMismatchLines` carves
// those lines out before checking for a scope leak anywhere else in the report, so the
// blanket "never mention it" claim below is checked in the one place it still holds.
function stripProjectMismatchLines(output) {
  return output.split("\n")
    .filter((l) => !(l.includes("NEEDS ATTENTION") && l.includes("no single-project run")))
    .join("\n");
}

describe("BLZ-404 round 3/4/5 (finding 4): --project blast radius covers the REPORT, not just the write", () => {
  test("an in-sync OBA plus a dirty ORC ticket — --project OBA --apply leaves projects/ORC untouched, uncommitted, and unreported", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r5-blast-"));
    try {
      const { root } = movableBoard(tmp);

      // Bring OBA to a genuinely in-sync, fully-committed state first.
      const seed = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      assert.equal(seed.status, 0, `test setup: the seeding pass must succeed: ${seed.stderr}`);
      assert.equal(porcelain(root), "", "test setup: OBA must be fully in sync before ORC is added");

      // Add a second project, ORC, with no code-repo signal, so it never has a move of
      // its own to propose.
      writeFileSync(join(root, "blaze.config.json"),
        JSON.stringify({ key: "OBA", projects: ["OBA", "ORC"] }));
      mkdirSync(join(root, "projects", "ORC", "defined"), { recursive: true });
      writeFileSync(join(root, "projects", "ORC", "project.json"), JSON.stringify({ key: "ORC", codeRepos: [] }));
      writeFileSync(join(root, "projects", "ORC", "defined", "ORC-1.md"),
        "---\nid: ORC-1\ntitle: t\ntype: task\nproject: ORC\nestimate: 30\n---\n\nbody\n");
      execFileSync("git", ["-C", root, "add", "-A"]);
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "add ORC"]);

      // Leave ORC-1 dirty (uncommitted) on disk — a stand-in for a previous pass's
      // unfinished write, or simply a human editing it.
      writeFileSync(join(root, "projects", "ORC", "defined", "ORC-1.md"),
        "---\nid: ORC-1\ntitle: t2\ntype: task\nproject: ORC\nestimate: 30\n---\n\nedited\n");
      const orcDirtyBefore = porcelain(root, join(root, "projects", "ORC"));
      assert.notEqual(orcDirtyBefore, "", "test setup: ORC-1 must be genuinely dirty");
      const before = headSha(root);

      const res = spawnSync(process.execPath, [RECONCILE_BIN, "--project", "OBA", "--apply"],
        { cwd: root, encoding: "utf8" });

      // The WRITE half (kills an unscoped commit that touches ORC's file).
      assert.equal(headSha(root), before, "no commit scoped to OBA may touch or land ORC's file");
      assert.equal(porcelain(root, join(root, "projects", "ORC")), orcDirtyBefore,
        "projects/ORC must be left byte-for-byte as dirty as it started — --project OBA must never see it");

      // The REPORT half (finding 4): a run scoped to OBA must never NAME ORC either, on
      // stdout or stderr, even though it changed nothing there — OUTSIDE of its own
      // project-mismatch finding (BLZ-406), which is deliberately unscoped and is not
      // this scenario: ORC-1's frontmatter names project: ORC, matching its directory,
      // so no mismatch is ever raised for it here and the blanket check below holds
      // without needing to strip anything. `scannedProjects`/`missingRepos`/`forgeErrors`
      // and every OTHER kind of finding are still built from `sig`, which is populated
      // only from `keys` (the `--project` filter); `project-mismatch` alone is not, and
      // the second test below pins that it is the ONLY channel through which a scoped
      // run may name an out-of-scope ticket. The assertion here was previously entirely
      // absent (`void res;`), so a future regression that adds an unscoped report (not
      // just an unscoped write) would have gone undetected. This closes that gap; see the
      // PR body for why deleting the cross-pass detector removes no coverage here (it was
      // already scoped by `keys`, same as everything else).
      assert.doesNotMatch(stripProjectMismatchLines(res.stdout + res.stderr), /ORC/,
        "a run scoped to --project OBA must not mention ORC anywhere in its report, outside " +
        "its own project-mismatch finding");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a misfiled ORC-1 (dir ORC, frontmatter project: OBA) — --project OBA --apply names it ONLY via its project-mismatch finding, never elsewhere", () => {
    // BLZ-406's second, previously-missing case: the ticket the invariant above CANNOT
    // stay silent about. Unlike the sibling test's ORC-1 (frontmatter matches directory,
    // so no finding fires and out-of-scope silence is the whole story), this one IS
    // project-mismatched — the exact condition BLZ-406 exists to surface even on a
    // single-project run — so the assertion here is the mirror: the finding line MUST
    // name ORC-1, and nothing else in the report may.
    const tmp = mkdtempSync(join(tmpdir(), "blz406-mismatch-scoped-"));
    try {
      const { root } = movableBoard(tmp);

      // Bring OBA to a genuinely in-sync, fully-committed state first.
      const seed = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      assert.equal(seed.status, 0, `test setup: the seeding pass must succeed: ${seed.stderr}`);
      assert.equal(porcelain(root), "", "test setup: OBA must be fully in sync before ORC is added");

      writeFileSync(join(root, "blaze.config.json"),
        JSON.stringify({ key: "OBA", projects: ["OBA", "ORC"] }));
      mkdirSync(join(root, "projects", "ORC", "defined"), { recursive: true });
      writeFileSync(join(root, "projects", "ORC", "project.json"), JSON.stringify({ key: "ORC", codeRepos: [] }));
      // Directory ORC, frontmatter claims OBA — a project-mismatch, not merely a ticket
      // out of --project OBA's scope.
      writeFileSync(join(root, "projects", "ORC", "defined", "ORC-1.md"),
        "---\nid: ORC-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\n---\n\nbody\n");
      execFileSync("git", ["-C", root, "add", "-A"]);
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "add misfiled ORC-1"]);
      const before = headSha(root);

      const res = spawnSync(process.execPath, [RECONCILE_BIN, "--project", "OBA", "--apply"],
        { cwd: root, encoding: "utf8" });

      assert.equal(res.status, 0, `--project OBA --apply must still succeed: ${res.stderr}`);
      assert.equal(headSha(root), before, "no commit scoped to OBA may touch or land ORC-1's file");

      const mismatchLine = res.stderr.split("\n")
        .find((l) => l.includes("NEEDS ATTENTION") && l.includes("ORC-1"));
      assert.ok(mismatchLine,
        `--project OBA must still report ORC-1's project-mismatch — stderr:\n${res.stderr}`);
      assert.match(mismatchLine, /no single-project run/,
        "the finding must say no single-project run reconciles it");

      assert.doesNotMatch(stripProjectMismatchLines(res.stdout + res.stderr), /ORC/,
        "outside its own project-mismatch finding, --project OBA must not name ORC-1 or " +
        "projects/ORC anywhere in its report");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
