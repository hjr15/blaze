// tests/reconcile-unfinished-pass.test.mjs — BLZ-404, round-2 adversarial review,
// blocking findings 1 and 3.
//
// Round 1 fixed reconcile()'s commit to route through the shared lock/commitMode instead
// of shelling straight to `git add`/`git commit`. Round 2's reviewer reproduced the
// recovery path THAT FIX ITSELF CREATES: `commit && !dryRun && touched.length` gates the
// commit block on `touched` — the tickets THIS PASS decided to write — and `touched` is
// empty whenever the board is already at its target status ON DISK. After a locked or
// failed commit, the files a PREVIOUS pass wrote are exactly that: on disk, at the target
// status, uncommitted. The very next run therefore finds nothing new to decide, commits
// nothing, and (before this fix) told the CLI's own "already in sync — nothing to do." —
// exit 0 — over a dirty tree. The supervisor twin is worse: the error fires exactly once
// (the pass that first hit the lock) and then goes silent forever, because from the next
// tick `touched` is empty and the commit block never runs again at all.
//
// BLOCKING 1's fix: reconcile() itself must finish an unfinished pass — when `touched` is
// empty, probe `git status --porcelain -- <projectsDir>` (scoped to the board's own
// ticket tree, never `git add -A`) and, if it finds leftover uncommitted ticket changes,
// attempt the commit for THEM. `commitOutcome` then correctly reads "none" only when there
// is truly nothing outstanding, in apply mode exactly as in dry-run mode — which is what
// lets the CLI stop saying "already in sync" over a dirty board (the second half of the
// fix, in scripts/reconcile.mjs's CLI section) and what makes the supervisor's existing
// per-tick (undeduped) "commit did not land" publish fire on every tick the condition
// persists, not just the first.
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

function porcelain(root) {
  return execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim();
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

describe("BLZ-404 round 2 (blocking 1): reconcile finishes an unfinished pass instead of lying that it is in sync", () => {
  test("CLI: after a locked commit, the very next --apply run recovers it — not 'already in sync' over a dirty tree", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r2-cli-"));
    try {
      const { root } = movableBoard(tmp);
      const before = headCount(root);

      const lock = acquireLock(root);
      assert.equal(lock.ok, true, "test setup: must actually acquire the lock");
      const run1 = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      releaseLock(root);

      assert.notEqual(run1.status, 0, "run 1 must fail — the lock is held");
      assert.match(run1.stderr, /FAILED TO COMMIT/);
      assert.notEqual(porcelain(root), "", "test setup: run 1 must leave the board dirty (moved on disk, not committed)");
      assert.equal(headCount(root), before, "run 1 must not have committed anything");

      // The CLI's OWN remediation text from run 1: "Re-run once the lock clears". This is
      // that re-run.
      const run2 = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      assert.equal(run2.status, 0, `run 2 must succeed once the lock is clear: ${run2.stderr}`);
      assert.doesNotMatch(run2.stdout, /already in sync/,
        "run 2 must not claim the board is in sync — it is dirty and run 2 is the one pass that can still fix it");
      assert.equal(headCount(root), before + 1, "run 2 must land the commit run 1 could not");
      assert.equal(porcelain(root), "", "the board must be fully committed after run 2 recovers it");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("reconcile() library: touched.length === 0 does not stop a leftover uncommitted write from being committed", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r2-lib-"));
    try {
      const { reconcile } = await import("../scripts/reconcile.mjs");
      const { root } = movableBoard(tmp);
      const before = headCount(root);

      const lock = acquireLock(root);
      const first = await reconcile({ fetch: false, commit: true, dryRun: false, root });
      releaseLock(root);
      assert.equal(first.commitOutcome, "locked");
      assert.notEqual(porcelain(root), "");

      // Second pass: the ticket is ALREADY at its target status on disk (OBA-1 already
      // moved to done/ by the first pass's write-then-commit ordering), so `decide()` finds
      // nothing new — `changes` and `touched` are both empty for THIS pass. That must not
      // stop reconcile from finishing the commit the first pass left behind.
      const second = await reconcile({ fetch: false, commit: true, dryRun: false, root });
      assert.equal(second.changes.length, 0, "test setup: the second pass must find nothing NEW to decide");
      assert.equal(second.commitOutcome, "committed",
        "a leftover uncommitted write must still be committed even when this pass's own `changes` is empty");
      assert.equal(second.committed, true);
      assert.equal(headCount(root), before + 1);
      assert.equal(porcelain(root), "", "the board must be fully committed after the recovering pass");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("supervisor twin: a later tick still reports the dirty board while the lock is continuously held — it does not go silent after the first", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r2-sup-"));
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
      try {
        await app.runReconcile(); // tick 1: applies the move, the commit hits the held lock
        await app.runReconcile(); // tick 2: nothing NEW to decide, board still dirty
        await app.runReconcile(); // tick 3: same

        const commitFailures = events.filter((e) =>
          (e.type === "error" || e.type === "warning") && /commit did not land/i.test(e.message || ""));
        assert.ok(commitFailures.length >= 3,
          "every tick while the lock is held and the board stays dirty must re-report it — " +
          `got ${commitFailures.length} report(s) across 3 ticks: ${JSON.stringify(events)}`);
      } finally {
        releaseLock(root);
      }

      // Once the lock clears, the NEXT tick must actually finish the job.
      await app.runReconcile();
      assert.equal(porcelain(root), "", "once the lock clears, a later tick must commit the leftover write and leave the tree clean");
    } finally {
      if (app) app.server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a failing pre-commit hook (no lock involved) gets its own, accurate remediation text", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r2-hook-"));
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
