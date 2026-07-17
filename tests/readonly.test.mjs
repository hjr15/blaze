// tests/readonly.test.mjs — BLZ-121: BLAZE_READONLY=1 makes a mutating `blaze`
// subcommand refuse to run, gated at cli.mjs dispatch (the one choke point
// every verb goes through) rather than at commitOrQueue (too late — move.mjs
// and friends write/rename the ticket file before ever reaching a commit
// decision). Each test proves a POSITIVE invariant (byte-identical tree/queue,
// unmoved HEAD), not just "exited non-zero".
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEntry, ledgerPath } from "../scripts/pending-ledger.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(REPO, "scripts", "cli.mjs");

// A throwaway git-backed board: blaze.config.json (batch commit mode, so a
// real move/new/log/etc. only queues — it never needs `gh`/a remote), one
// ticket, and a git history so `blaze commit` and HEAD-unmoved assertions
// are meaningful.
function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-readonly-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "OBA", projects: ["OBA"], commitMode: "batch" }));
  mkdirSync(join(root, "projects", "OBA", "in-progress"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "in-progress", "OBA-1.md"),
    "---\nid: OBA-1\ntype: task\nproject: OBA\ntitle: OBA-1\npriority: medium\nestimate: 30\n---\n\nbody\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

// Recursive snapshot of every file under projects/: relative path -> content
// bytes. Catches a relocation (BLZ-121's core worry) as well as an in-place edit.
function snapshotTree(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else out.set(relative(root, p), readFileSync(p));
    }
  };
  const projects = join(root, "projects");
  if (existsSync(projects)) walk(projects);
  return out;
}

const headOf = (root) => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const run = (root, args, extraEnv = {}) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, ...extraEnv }, encoding: "utf8" });

// Shared assertion body for every mutating verb below: seed unrelated queued
// WIP (so "queue byte-identical" is a real check), snapshot tree/queue/HEAD,
// run the command under BLAZE_READONLY, then assert the refusal and that
// every invariant held.
function assertRefusedAndUntouched(root, args, cmdName) {
  appendEntry(root, { id: "OBA-9", op: "new", message: "OBA-9: unrelated wip", files: ["projects/OBA/in-progress/OBA-9.md"], ts: "t" });
  const queue = ledgerPath(root);
  const beforeQueue = readFileSync(queue);
  const beforeTree = snapshotTree(root);
  const beforeHead = headOf(root);

  const r = run(root, args, { BLAZE_READONLY: "1" });

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /read-only mode \(BLAZE_READONLY=1\)/);
  assert.match(r.stderr, new RegExp(cmdName));
  assert.deepEqual(snapshotTree(root), beforeTree, "ticket tree must be byte-identical");
  assert.deepEqual(readFileSync(queue), beforeQueue, "queue file must be byte-identical");
  assert.equal(headOf(root), beforeHead, "HEAD must not move");
}

test("BLAZE_READONLY=1 blaze move: exits non-zero, tree/queue/HEAD all unchanged", () => {
  const root = board();
  assertRefusedAndUntouched(root, ["move", "OBA-1", "in-review"], "move");
  rmSync(root, { recursive: true, force: true });
});

test("BLAZE_READONLY=1 blaze new: exits non-zero, no ticket created, tree/queue/HEAD unchanged", () => {
  const root = board();
  assertRefusedAndUntouched(root, ["new", "--project", "OBA", "--type", "task", "a new ticket"], "new");
  rmSync(root, { recursive: true, force: true });
});

test("BLAZE_READONLY=1 blaze edit: exits non-zero, ticket/queue/HEAD unchanged", () => {
  const root = board();
  assertRefusedAndUntouched(root, ["edit", "OBA-1", "priority", "high"], "edit");
  rmSync(root, { recursive: true, force: true });
});

test("BLAZE_READONLY=1 blaze log: exits non-zero, ticket/queue/HEAD unchanged", () => {
  const root = board();
  assertRefusedAndUntouched(root, ["log", "OBA-1", "30"], "log");
  rmSync(root, { recursive: true, force: true });
});

test("BLAZE_READONLY=1 blaze resolve: exits non-zero, ticket/queue/HEAD unchanged", () => {
  const root = board();
  assertRefusedAndUntouched(root, ["resolve", "OBA-1", "wont-do"], "resolve");
  rmSync(root, { recursive: true, force: true });
});

test("BLAZE_READONLY=1 blaze commit: exits non-zero, queue/HEAD unchanged (nothing flushed)", () => {
  const root = board();
  // A real, flushable queued op — proves refusal, not "empty queue no-op".
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-2.md"), "x");
  appendEntry(root, { id: "OBA-2", op: "new", message: "OBA-2: x", files: ["projects/OBA/backlog/OBA-2.md"], ts: "t" });
  assertRefusedAndUntouched(root, ["commit"], "commit");
  rmSync(root, { recursive: true, force: true });
});

test("BLAZE_READONLY=1 blaze reindex: exits non-zero, no .blaze/index.json written, tree/queue/HEAD unchanged", () => {
  const root = board();
  assertRefusedAndUntouched(root, ["reindex"], "reindex");
  assert.ok(!existsSync(join(root, ".blaze", "index.json")), "no derived index must have been written");
  rmSync(root, { recursive: true, force: true });
});

// Read-only mode must stay usable for the exact job it exists for — board
// inventory/inspection — so the read-only subcommands and --help must be
// unaffected, not just "still deny everything".
test("BLAZE_READONLY=1 blaze rollup still works (exit 0)", () => {
  const root = board();
  const r = run(root, ["rollup"], { BLAZE_READONLY: "1" });
  assert.equal(r.status, 0, r.stderr);
  rmSync(root, { recursive: true, force: true });
});

test("BLAZE_READONLY=1 blaze move --help still works (exit 0, runner never spawns)", () => {
  const root = board();
  const beforeTree = snapshotTree(root);
  const r = run(root, ["move", "--help"], { BLAZE_READONLY: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /move/i);
  assert.deepEqual(snapshotTree(root), beforeTree);
  rmSync(root, { recursive: true, force: true });
});

test("BLAZE_READONLY=1 blaze --help still works (exit 0)", () => {
  const root = board();
  const r = run(root, ["--help"], { BLAZE_READONLY: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usage: blaze/);
  rmSync(root, { recursive: true, force: true });
});

// --- Defence in depth: a caller that bypasses cli.mjs entirely ---------------
// cli.mjs's gate only protects the CLI surface. Direct invocation of a runner
// (or serve.mjs's in-process API handlers) reaches commitOrQueue/appendEntry
// directly — those need their own guard too.
test("BLAZE_READONLY=1 node scripts/move-runner.mjs <id> <status> (bypassing cli.mjs) also refuses and mutates nothing", () => {
  const root = board();
  appendEntry(root, { id: "OBA-9", op: "new", message: "OBA-9: unrelated wip", files: ["projects/OBA/in-progress/OBA-9.md"], ts: "t" });
  const queue = ledgerPath(root);
  const beforeQueue = readFileSync(queue);
  const beforeTree = snapshotTree(root);
  const beforeHead = headOf(root);

  const runner = join(REPO, "scripts", "move-runner.mjs");
  const r = spawnSync(process.execPath, [runner, "OBA-1", "in-review"],
    { cwd: root, env: { ...process.env, BLAZE_READONLY: "1" }, encoding: "utf8" });

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /read-only mode \(BLAZE_READONLY=1\)/);
  assert.deepEqual(snapshotTree(root), beforeTree, "ticket tree must be byte-identical");
  assert.deepEqual(readFileSync(queue), beforeQueue, "queue file must be byte-identical");
  assert.equal(headOf(root), beforeHead, "HEAD must not move");
  rmSync(root, { recursive: true, force: true });
});

// Additional finding (adversarial verifier, HIGH): commit-runner.mjs never
// imports commitOrQueue/appendEntry — it talks to git directly and only pulls
// the READ helpers from pending-ledger.mjs (readForDrain/clearLedger/
// listQueues/sessionId) — so the defence-in-depth other runners get for free
// via commitOrQueue never applied here. `commit` is the one verb this whole
// epic exists to make safe by default, so a direct bypass that still commits
// under BLAZE_READONLY is the worst possible hole to leave open.
test("BLAZE_READONLY=1 node scripts/commit-runner.mjs (bypassing cli.mjs) also refuses and commits nothing", () => {
  const root = board();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-2.md"), "x");
  const session = "t1";
  appendEntry(root, { id: "OBA-2", op: "new", message: "OBA-2: x", files: ["projects/OBA/backlog/OBA-2.md"], ts: "t", session }, session);
  const queue = ledgerPath(root, session);
  const beforeQueue = readFileSync(queue);
  const beforeTree = snapshotTree(root);
  const beforeHead = headOf(root);
  const beforeStatus = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });

  const runner = join(REPO, "scripts", "commit-runner.mjs");
  const r = spawnSync(process.execPath, [runner],
    { cwd: root, env: { ...process.env, BLAZE_SESSION: session, BLAZE_READONLY: "1" }, encoding: "utf8" });

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /read-only mode \(BLAZE_READONLY=1\)/);
  assert.doesNotMatch(r.stdout || "", /flushed/);
  assert.deepEqual(snapshotTree(root), beforeTree, "ticket tree must be byte-identical");
  assert.deepEqual(readFileSync(queue), beforeQueue, "queue file must be byte-identical");
  assert.equal(headOf(root), beforeHead, "HEAD must not move");
  assert.equal(
    execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }),
    beforeStatus,
    "working tree status must be unchanged",
  );
  rmSync(root, { recursive: true, force: true });
});

// --help is a read: it must still work under BLAZE_READONLY even for the
// runner invoked directly (bypassing cli.mjs's own --help interception).
test("BLAZE_READONLY=1 node scripts/commit-runner.mjs --help still works (exit 0, prints usage)", () => {
  const root = board();
  const runner = join(REPO, "scripts", "commit-runner.mjs");
  const r = spawnSync(process.execPath, [runner, "--help"],
    { cwd: root, env: { ...process.env, BLAZE_READONLY: "1" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usage/i);
  rmSync(root, { recursive: true, force: true });
});

// Code-review finding: only move-runner.mjs (and serve.mjs's POST handler)
// hoisted assertWritable() ABOVE the apply*() write. edit/log/new/resolve/
// link/sprint all call apply*() (which writes the file via node:fs) BEFORE
// commitOrQueue's guard ever fires — so under BLAZE_READONLY the write lands
// on disk and only the commit/queue step throws, leaving a dirty working
// tree plus an uncaught stack trace. Each test below proves the runner:
//  1. exits non-zero with a CLEAN `blaze: ...` message (no raw stack trace),
//  2. leaves the ticket tree byte-identical (nothing written),
//  3. leaves `git status --porcelain` empty (no dirty file left behind),
//  4. leaves HEAD unmoved.
function assertDirectInvocationRefusedAndUntouched(root, runnerFile, args) {
  const beforeTree = snapshotTree(root);
  const beforeHead = headOf(root);
  const beforeStatus = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });

  const runner = join(REPO, "scripts", runnerFile);
  const r = spawnSync(process.execPath, [runner, ...args],
    { cwd: root, env: { ...process.env, BLAZE_READONLY: "1" }, encoding: "utf8" });

  assert.notEqual(r.status, 0, `expected non-zero exit; stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /blaze: read-only mode \(BLAZE_READONLY=1\)/, `expected a clean blaze: message, got: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /at commitOrQueue|at Object\.<anonymous>|node:internal/, `expected no raw stack trace, got: ${r.stderr}`);
  assert.deepEqual(snapshotTree(root), beforeTree, "ticket tree must be byte-identical — nothing written");
  assert.equal(
    execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }),
    beforeStatus,
    "working tree status must be unchanged — no dirty file left behind",
  );
  assert.equal(headOf(root), beforeHead, "HEAD must not move");
}

test("BLAZE_READONLY=1 node scripts/edit-runner.mjs (bypassing cli.mjs) refuses BEFORE writing the ticket file", () => {
  const root = board();
  assertDirectInvocationRefusedAndUntouched(root, "edit-runner.mjs", ["OBA-1", "priority", "high"]);
  rmSync(root, { recursive: true, force: true });
});

test("BLAZE_READONLY=1 node scripts/log-runner.mjs (bypassing cli.mjs) refuses BEFORE writing the ticket file", () => {
  const root = board();
  assertDirectInvocationRefusedAndUntouched(root, "log-runner.mjs", ["OBA-1", "30"]);
  rmSync(root, { recursive: true, force: true });
});

test("BLAZE_READONLY=1 node scripts/new-runner.mjs (bypassing cli.mjs) refuses BEFORE creating a ticket file", () => {
  const root = board();
  assertDirectInvocationRefusedAndUntouched(root, "new-runner.mjs", ["--project", "OBA", "--type", "task", "--estimate", "30", "a new ticket"]);
  rmSync(root, { recursive: true, force: true });
});

test("BLAZE_READONLY=1 node scripts/resolve-runner.mjs (bypassing cli.mjs) refuses BEFORE writing the ticket file", () => {
  const root = board();
  assertDirectInvocationRefusedAndUntouched(root, "resolve-runner.mjs", ["OBA-1", "wont-do"]);
  rmSync(root, { recursive: true, force: true });
});

test("BLAZE_READONLY=1 node scripts/link-runner.mjs (bypassing cli.mjs) refuses BEFORE writing the ticket file", () => {
  const root = board();
  mkdirSync(join(root, "projects", "OBA", "in-progress"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "in-progress", "OBA-2.md"),
    "---\nid: OBA-2\ntype: task\nproject: OBA\ntitle: OBA-2\npriority: medium\nestimate: 30\n---\n\nbody\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed OBA-2"]);
  assertDirectInvocationRefusedAndUntouched(root, "link-runner.mjs", ["OBA-1", "Relates", "OBA-2"]);
  rmSync(root, { recursive: true, force: true });
});

test("BLAZE_READONLY=1 node scripts/sprint-runner.mjs new (bypassing cli.mjs) refuses BEFORE writing sprints.json", () => {
  const root = board();
  assertDirectInvocationRefusedAndUntouched(root, "sprint-runner.mjs", ["new", "Sprint 1", "--start", "2026-01-01", "--end", "2026-01-14"]);
  assert.ok(!existsSync(join(root, "sprints.json")), "sprints.json must not have been written");
  rmSync(root, { recursive: true, force: true });
});

// LOW/related: reindex.mjs has no readonly guard at all — it only writes
// derived, gitignored caches (doesn't dirty the tracked tree), but it's the
// one mutates:true verb with zero defence-in-depth for a direct invocation.
test("BLAZE_READONLY=1 node scripts/reindex.mjs (bypassing cli.mjs) refuses and writes no cache", () => {
  const root = board();
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "reindex.mjs")],
    { cwd: root, env: { ...process.env, BLAZE_READONLY: "1" }, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /blaze: read-only mode \(BLAZE_READONLY=1\)/);
  assert.ok(!existsSync(join(root, ".blaze", "index.json")), "no derived index must have been written");
  rmSync(root, { recursive: true, force: true });
});
