// tests/reconcile-commit-routing.test.mjs — BLZ-404, review finding 1 + 2.
//
// Every other board git writer in the engine funnels through
// `commitOrQueue` -> `commitFile` -> `acquireLock` (scripts/commit-or-queue.mjs,
// scripts/serve-commit.mjs, scripts/commit-runner.mjs). `reconcile()`'s own commit block
// used to shell straight to `git add`/`git commit`, answering to neither: it committed
// THROUGH a held advisory lock, and on a `commitMode: "batch"` board it committed ticket
// moves out from under a pending `blaze commit` batch instead of queueing them. Before
// this ticket that was dormant (the loop was a permanent dry run); this ticket makes the
// loop fire on a 60s timer with `enabled: true`, so the dormant path is now live.
//
// These tests pin: (1) a held lock stops the commit without stopping the run, (2)
// `commitMode: "batch"` queues instead of committing, (3) the ordinary per-op path still
// really commits, and (4) a failing commit is reported as a failure, never flattened into
// a clean `committed`/`applied` run — both at the `reconcile()` library level and at the
// supervisor's published-event level, which is "the operator's whole account of the run"
// per the code's own comment.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { reconcile } from "../scripts/reconcile.mjs";
import { acquireLock, releaseLock } from "../scripts/commit-lock.mjs";
import { readEntries, sessionId } from "../scripts/pending-ledger.mjs";

function gitInit(dir) {
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
}

function headCount(dir) {
  try {
    return Number(execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim());
  } catch {
    return 0; // no commits yet
  }
}

/** A board with ONE ticket that a real `<KEY>-<n>:` commit on the code repo's default
 *  branch drives from `defined` straight to `done` (the BLZ-131 shipped-commit signal) —
 *  a genuine, reproducible move with no PR/branch fixture required. */
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

describe("BLZ-404 (review finding 1): reconcile's commit routes through commitOrQueue", () => {
  test("a held advisory commit lock stops reconcile's commit — it does not commit through it", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404-lock-"));
    try {
      const { root } = movableBoard(tmp);
      const before = headCount(root);
      const lock = acquireLock(root);
      assert.equal(lock.ok, true, "test setup: must actually acquire the lock");
      try {
        const r = await reconcile({ fetch: false, commit: true, dryRun: false, root });
        assert.equal(r.ok, true);
        assert.ok(r.changes.length >= 1, "the ticket really has a move to propose");
        assert.equal(r.committed, false, "must NOT commit while another writer holds the lock");
        assert.equal(r.commitOutcome, "locked");
        assert.equal(headCount(root), before, "the board's commit count must be unchanged — no commit landed through the held lock");
      } finally {
        releaseLock(root);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("commitMode: 'batch' queues the op to the pending ledger instead of committing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404-batch-"));
    const prevSession = process.env.BLAZE_SESSION;
    try {
      const { root } = movableBoard(tmp);
      writeFileSync(join(root, "blaze.config.json"),
        JSON.stringify({ key: "OBA", projects: ["OBA"], commitMode: "batch" }));
      process.env.BLAZE_SESSION = "blz404-test-session";
      const before = headCount(root);

      const r = await reconcile({ fetch: false, commit: true, dryRun: false, root });
      assert.equal(r.ok, true);
      assert.ok(r.changes.length >= 1);
      assert.equal(r.committed, false, "batch mode must not commit directly");
      assert.equal(r.commitOutcome, "queued");
      assert.equal(headCount(root), before, "batch mode must not create a commit at all");

      const entries = readEntries(root, sessionId());
      assert.equal(entries.length, 1, "exactly one op must be queued for this reconcile pass");
      assert.equal(entries[0].op, "reconcile");
      assert.ok(entries[0].id && !/^\s*$/.test(entries[0].id) && entries[0].id !== "null" && entries[0].id !== "undefined",
        `the queued op needs a legible id, got ${JSON.stringify(entries[0].id)}`);
      assert.ok(entries[0].files.some((f) => f.includes("OBA-1")),
        "the queued entry must record the touched ticket file");
    } finally {
      if (prevSession === undefined) delete process.env.BLAZE_SESSION; else process.env.BLAZE_SESSION = prevSession;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the ordinary per-op path still really commits (regression guard)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404-perop-"));
    try {
      const { root } = movableBoard(tmp);
      const before = headCount(root);
      const r = await reconcile({ fetch: false, commit: true, dryRun: false, root });
      assert.equal(r.ok, true);
      assert.equal(r.committed, true);
      assert.equal(r.commitOutcome, "committed");
      assert.equal(headCount(root), before + 1, "exactly one new commit must land");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("BLZ-404 (review finding 2): a failed commit is never reported as a clean applied run", () => {
  function installFailingPreCommitHook(root) {
    const hook = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
  }

  test("reconcile() itself: a failing pre-commit hook surfaces as commitOutcome 'failed', not a flattened 'committed: false'", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404-hookfail-lib-"));
    try {
      const { root } = movableBoard(tmp);
      installFailingPreCommitHook(root);
      const before = headCount(root);

      const r = await reconcile({ fetch: false, commit: true, dryRun: false, root });
      assert.equal(r.ok, true, "the reconcile PASS itself is not an engine error");
      assert.ok(r.changes.length >= 1);
      assert.equal(r.committed, false);
      assert.equal(r.commitOutcome, "failed", "a hook failure must be distinguishable from 'nothing to commit'");
      assert.ok(r.commitError, "the failure must carry a reason, not just a bare false");
      assert.equal(headCount(root), before, "the failed hook must leave no commit behind");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("supervisor: runReconcile publishes an error/warning event when files moved but the commit failed", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404-hookfail-app-"));
    let app;
    try {
      const { root } = movableBoard(tmp);
      installFailingPreCommitHook(root);

      const { loadConfig } = await import("../scripts/config.mjs");
      const { createApp } = await import("../scripts/supervisor.mjs");
      app = createApp(loadConfig({ root }), { root });
      const events = [];
      app.bus.subscribe((e) => events.push(e));
      await app.runReconcile();

      const reconcileEvents = events.filter((e) => e.type === "reconcile");
      assert.ok(reconcileEvents.some((e) => e.applied === true),
        "the files really did move, so the feed correctly says applied: true for them");

      // A tight pattern deliberately, not a bare /commit/i: the forge-error message this
      // fixture ALSO emits (no git remote configured) contains the unrelated phrase
      // "merged-commit signals are unaffected", which a loose /commit/i would match and
      // make this test pass for the wrong reason — a false positive this test itself must
      // not carry.
      const commitFailureEvents = events.filter((e) =>
        (e.type === "error" || e.type === "warning") && /commit did not land/i.test(e.message || ""));
      assert.ok(commitFailureEvents.length > 0,
        "applied: true must not be the ONLY thing the feed says about a run whose commit failed — " +
        `got events: ${JSON.stringify(events)}`);
    } finally {
      if (app) app.server.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("BLZ-404 (review finding 1): assertWritable is hoisted before the write port, not just the commit", () => {
  test("BLAZE_READONLY refuses before any ticket file is written — no dirty-tree-then-decline", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404-readonly-"));
    const prevReadonly = process.env.BLAZE_READONLY;
    try {
      const { root, repo } = movableBoard(tmp);
      const beforeText = execFileSync(
        "cat", [join(root, "projects", "OBA", "defined", "OBA-1.md")], { encoding: "utf8" });
      process.env.BLAZE_READONLY = "1";
      const r = await reconcile({ fetch: false, commit: true, dryRun: false, root });
      assert.equal(r.ok, false);
      assert.match(r.error, /read-only mode/i);
      assert.equal(r.committed, false);
      // The file must be BYTE-IDENTICAL, not merely "still present" — a refusal that
      // wrote the file and only then declined to commit is the exact "dirty-tree
      // failure, not a clean refusal" hazard this hoisted check exists to avoid.
      const afterText = execFileSync(
        "cat", [join(root, "projects", "OBA", "defined", "OBA-1.md")], { encoding: "utf8" });
      assert.equal(afterText, beforeText, "BLAZE_READONLY must refuse BEFORE the write port touches any file");
      void repo;
    } finally {
      if (prevReadonly === undefined) delete process.env.BLAZE_READONLY; else process.env.BLAZE_READONLY = prevReadonly;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("BLZ-404 (review finding 1): the CLI stays truthful about queued-vs-committed", () => {
  const runCli = (root, extraEnv = {}) => spawnSync(process.execPath,
    [join(import.meta.dirname, "..", "scripts", "reconcile.mjs"), "--apply"],
    { cwd: root, encoding: "utf8", env: { ...process.env, ...extraEnv } });

  test("commitMode: 'batch' — the CLI says QUEUED, exits 0, and does not claim a commit", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404-cli-batch-"));
    try {
      const { root } = movableBoard(tmp);
      writeFileSync(join(root, "blaze.config.json"),
        JSON.stringify({ key: "OBA", projects: ["OBA"], commitMode: "batch" }));
      const before = headCount(root);
      const res = runCli(root, { BLAZE_SESSION: "blz404-cli-batch-test" });
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /queued \(commitMode: batch\)/);
      assert.doesNotMatch(res.stdout, /reconcile: committed \d/);
      assert.equal(headCount(root), before, "batch mode must not create a commit at all");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a failing pre-commit hook — the CLI says FAILED TO COMMIT and exits non-zero, never a silent success", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404-cli-hookfail-"));
    try {
      const { root } = movableBoard(tmp);
      const hook = join(root, ".git", "hooks", "pre-commit");
      writeFileSync(hook, "#!/bin/sh\nexit 1\n");
      chmodSync(hook, 0o755);
      const before = headCount(root);
      const res = runCli(root);
      assert.notEqual(res.status, 0, "a failed commit must not exit 0 — that is the exact silence finding 2 exists to close");
      assert.match(res.stderr, /FAILED TO COMMIT/);
      assert.equal(headCount(root), before, "the failed hook must leave no commit behind");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the ordinary per-op path — the CLI says committed", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404-cli-committed-"));
    try {
      const { root } = movableBoard(tmp);
      const res = runCli(root);
      assert.equal(res.status, 0, res.stderr);
      // BLZ-401: the summary now names tickets that actually MOVED, not a bare "change"
      // count that folded in non-moving writes (a resolution backfill, a record clear).
      assert.match(res.stdout, /reconcile: committed \d+ ticket\(s\) moved\./);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
