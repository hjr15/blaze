// tests/reconcile-unfinished-pass.test.mjs — BLZ-404, round-3 adversarial review.
//
// Round 2 shipped `dirtyTicketPaths`: when a pass found nothing new to decide, it probed
// `git status --porcelain`, turned the output into a path list, and re-attempted the
// commit for whatever it found. Round 3's adversarial review reproduced five ways that
// recovery attempt went wrong — it swept a human's unrelated uncommitted work and another
// project's files into the reconcile commit (the exact opposite of its own comment's
// promise, and a BLZ-394 blast-radius violation), it reintroduced the porcelain path
// parser BLZ-347 deliberately deleted (one spaced or non-ASCII filename wedged `--apply`
// permanently), it half-committed staged renames leaving a duplicate ticket id in HEAD,
// and `commitOutcome === "none"` was not actually proof of a clean board.
//
// Round 2's actual defect was never "reconcile fails to finish an unfinished pass" — it
// was two false statements: the CLI printing "already in sync — nothing to do." over a
// dirty board, exit 0; and the supervisor reporting the condition once and then going
// silent while it persisted. THIS fix closes exactly those two, with no new write path:
// reconcile() asks a BOOLEAN whether the board's own ticket tree carries anything
// uncommitted (`hasUncommittedTicketChanges` in reconcile.mjs — parses no paths, joins no
// paths, passes nothing to `git add`) and REPORTS it. It does not attempt to recover it.
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
 *  tests/reconcile-commit-routing.test.mjs's `movableBoard`, which this finding is a
 *  direct sequel to. */
function movableBoard(tmp) {
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
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "OBA", projects: ["OBA"] }));
  writeFileSync(join(projects, "OBA", "project.json"), JSON.stringify({ key: "OBA", codeRepos: [repo] }));
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\n---\n\nbody\n");

  gitInit(root);
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed board"]);
  return { root, repo };
}

describe("BLZ-404 round 3: reconcile detects a dirty ticket tree left by a previous pass — it does not recover it", () => {
  test("CLI: after a locked commit, the very next --apply run does NOT recover it — it reports the dirty tree, exits non-zero, and touches nothing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r3-cli-"));
    try {
      const { root } = movableBoard(tmp);
      const before = headCount(root);

      const lock = acquireLock(root);
      assert.equal(lock.ok, true, "test setup: must actually acquire the lock");
      const run1 = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      releaseLock(root);

      assert.notEqual(run1.status, 0, "run 1 must fail — the lock is held");
      assert.match(run1.stderr, /FAILED TO COMMIT/);
      const dirtyAfterRun1 = porcelain(root);
      assert.notEqual(dirtyAfterRun1, "", "test setup: run 1 must leave the board dirty (moved on disk, not committed)");
      assert.equal(headCount(root), before, "run 1 must not have committed anything");
      const headAfterRun1 = headSha(root);

      // The lock is now clear, so a RECOVERY attempt (round 2's design) would succeed here.
      // Round 3 deleted that attempt: this run must report the dirty tree, not fix it.
      const run2 = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      assert.notEqual(run2.status, 0, "run 2 must not exit 0 — the board is genuinely dirty and nothing committed it");
      assert.doesNotMatch(run2.stdout, /already in sync/,
        "run 2 must not claim the board is in sync — it is dirty");
      assert.doesNotMatch((run2.stdout + run2.stderr), /recovered/i,
        "reconcile must not claim to have recovered anything — it no longer attempts to");
      assert.equal(headCount(root), before, "run 2 must not have created any commit");
      assert.equal(headSha(root), headAfterRun1, "run 2 must not move HEAD at all");
      assert.equal(porcelain(root), dirtyAfterRun1, "run 2 must leave the tree EXACTLY as it found it");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("reconcile() library: touched.length === 0 does not trigger a recovery commit — dirtyTicketTree reports it instead", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r3-lib-"));
    try {
      const { reconcile } = await import("../scripts/reconcile.mjs");
      const { root } = movableBoard(tmp);
      const before = headCount(root);

      const lock = acquireLock(root);
      const first = await reconcile({ fetch: false, commit: true, dryRun: false, root });
      releaseLock(root);
      assert.equal(first.commitOutcome, "locked");
      assert.notEqual(porcelain(root), "");
      const headAfterFirst = headSha(root);

      // Second pass: the ticket is ALREADY at its target status on disk (OBA-1 already
      // moved to done/ by the first pass's write-then-commit ordering), so `decide()` finds
      // nothing new — `changes` and `touched` are both empty for THIS pass. The board is
      // still dirty from the first pass; this pass must REPORT that, not fix it.
      const second = await reconcile({ fetch: false, commit: true, dryRun: false, root });
      assert.equal(second.changes.length, 0, "test setup: the second pass must find nothing NEW to decide");
      assert.equal(second.commitOutcome, "none",
        "the second pass must not attempt any commit — it made no decision of its own");
      assert.equal(second.committed, false);
      assert.equal(second.dirtyTicketTree, true,
        "the second pass must report that the board's ticket tree carries uncommitted changes it did not make");
      assert.equal(headCount(root), before, "no new commit must land");
      assert.equal(headSha(root), headAfterFirst, "HEAD must not move at all on the reporting pass");
      assert.notEqual(porcelain(root), "", "the board must remain exactly as dirty as the first pass left it");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("dry-run also reports a dirty tree left by an earlier failed apply — never 'already in sync'", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r3-dryrun-"));
    try {
      const { root } = movableBoard(tmp);
      const lock = acquireLock(root);
      const run1 = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      releaseLock(root);
      assert.notEqual(run1.status, 0);
      assert.notEqual(porcelain(root), "", "test setup: the board must be dirty going into the dry run");

      const dryRun = spawnSync(process.execPath, [RECONCILE_BIN], { cwd: root, encoding: "utf8" });
      assert.doesNotMatch(dryRun.stdout, /already in sync/,
        "a dry run over a board a previous apply left dirty must not claim it is in sync");
      assert.notEqual(dryRun.status, 0, "a dry run reporting a dirty board must not exit 0");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("supervisor: a board left dirty by an earlier pass's failed commit keeps being reported every tick — reconcile never re-attempts the commit for it", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r3-sup-"));
    let app;
    try {
      const { root } = movableBoard(tmp);
      const { loadConfig } = await import("../scripts/config.mjs");
      const { createApp } = await import("../scripts/supervisor.mjs");
      app = createApp(loadConfig({ root }), { root });
      const events = [];
      app.bus.subscribe((e) => events.push(e));

      const lock = acquireLock(root);
      assert.equal(lock.ok, true);
      await app.runReconcile(); // tick 1: applies the move, the commit hits the held lock
      releaseLock(root);

      const dirtyAfterTick1 = porcelain(root);
      assert.notEqual(dirtyAfterTick1, "", "test setup: tick 1 must leave the board dirty");
      const headAfterTick1 = headSha(root);

      await app.runReconcile(); // tick 2: nothing NEW to decide, board still dirty
      await app.runReconcile(); // tick 3: same — lock is clear, but reconcile must not touch it

      assert.equal(headSha(root), headAfterTick1,
        "reconcile must never auto-commit a previous pass's leftover write, lock clear or not");
      assert.equal(porcelain(root), dirtyAfterTick1, "the tree must be exactly as tick 1 left it");

      const dirtyReports = events.filter((e) =>
        (e.type === "error" || e.type === "warning") &&
        /does not auto-recover/i.test(e.message || ""));
      assert.ok(dirtyReports.length >= 2,
        "ticks 2 and 3 must each re-report the persisting dirty board (undeduped) — " +
        `got ${dirtyReports.length} report(s): ${JSON.stringify(events)}`);
    } finally {
      if (app) app.server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a failing pre-commit hook (no lock involved) gets its own, accurate remediation text", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r3-hook-"));
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

describe("BLZ-404 round 3: the dirty-tree detector never sweeps a human's unrelated work or another project's files", () => {
  test("an untracked NON-ticket file under the board's own project is never swept into a reconcile commit", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r3-sweep-"));
    try {
      const { root } = movableBoard(tmp);

      // Bring the board to a genuinely in-sync, fully-committed state first.
      const seed = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      assert.equal(seed.status, 0, `test setup: the seeding pass must succeed: ${seed.stderr}`);
      assert.equal(porcelain(root), "", "test setup: the board must be fully in sync before the sweep probe");

      // Now a human has a draft file sitting under the ticket tree, untracked and
      // unrelated to any ticket.
      writeFileSync(join(root, "projects", "OBA", "NOTES.md"), "draft thoughts, not a ticket\n");
      const before = headSha(root);
      const beforeCount = headCount(root);

      const res = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });

      assert.notEqual(res.status, 0, "an untracked file under the ticket tree must be reported, not silently ignored as 'in sync'");
      assert.equal(headSha(root), before, "HEAD must not move — the untracked file must never be committed");
      assert.equal(headCount(root), beforeCount);
      const status = porcelain(root, join(root, "projects"));
      assert.match(status, /\?\? .*NOTES\.md/, "the file must still be untracked, exactly as the human left it");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--project blast radius: an in-sync OBA plus a dirty ORC ticket — --project OBA --apply leaves projects/ORC untouched and uncommitted", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r3-blast-"));
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
      void res;

      assert.equal(headSha(root), before, "no commit scoped to OBA may touch or land ORC's file");
      assert.equal(porcelain(root, join(root, "projects", "ORC")), orcDirtyBefore,
        "projects/ORC must be left byte-for-byte as dirty as it started — --project OBA must never see it");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
