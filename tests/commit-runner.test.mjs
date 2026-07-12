import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { appendEntry, readEntries } from "../scripts/pending-ledger.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// A temp board with a real copy of scripts/, so the copied commit-runner.mjs
// resolves its script-relative ROOT to this temp repo (not the worktree).
function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-commitrun-"));
  cpSync(join(REPO, "scripts"), join(root, "scripts"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "seed"), "seed");
  execFileSync("git", ["-C", root, "add", "seed"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}
// Invoke the temp repo's OWN copy of the runner. cwdSub (a relative subdir)
// proves ROOT is script-relative, not cwd-based.
function runCommit(root, cwdSub, { session, args = [] } = {}) {
  const runner = join(root, "scripts", "commit-runner.mjs");
  const cwd = cwdSub ? join(root, cwdSub) : root;
  const env = { ...process.env, ...(session ? { BLAZE_SESSION: session } : {}) };
  if (!session) delete env.BLAZE_SESSION;
  const r = spawnSync(process.execPath, [runner, ...args], { cwd, env, encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}
const headOf = (root) => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

test("empty ledger is a friendly no-op", () => {
  const root = gitRepo();
  const before = headOf(root);
  const out = runCommit(root).stdout;
  assert.match(out, /nothing to flush/);
  assert.equal(headOf(root), before);
  rmSync(root, { recursive: true, force: true });
});

test("drains the ledger into one commit and truncates it — even when invoked from a subdirectory", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-1.md"), "one");
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-2.md"), "two");
  writeFileSync(join(root, "untracked-other"), "should NOT be committed");
  appendEntry(root, { id: "OBA-1", op: "new", message: "OBA-1: create task", files: ["projects/OBA/backlog/OBA-1.md"], ts: "t" });
  appendEntry(root, { id: "OBA-2", op: "new", message: "OBA-2: create task", files: ["projects/OBA/backlog/OBA-2.md"], ts: "t" });

  // Invoke from a subdirectory to prove ROOT is script-relative, not cwd-based.
  runCommit(root, "projects/OBA");

  const subject = execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  const body = execFileSync("git", ["-C", root, "log", "-1", "--format=%b"], { encoding: "utf8" });
  assert.match(subject, /^blaze: \d{4}-\d{2}-\d{2} board update \(2 new\)$/);
  assert.match(body, /- OBA-1: create task/);
  assert.match(body, /- OBA-2: create task/);
  const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  assert.match(status, /\?\? untracked-other/);
  assert.deepEqual(readEntries(root), []);
  rmSync(root, { recursive: true, force: true });
});

test("drops a stale intermediate path from a ticket moved twice in one batch", () => {
  const root = gitRepo();

  // Ticket starts out committed at defined/.
  mkdirSync(join(root, "projects", "INF", "defined"), { recursive: true });
  writeFileSync(join(root, "projects", "INF", "defined", "X.md"), "x v1");
  execFileSync("git", ["-C", root, "add", "projects/INF/defined/X.md"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed ticket"]);
  const beforeCount = Number(
    execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(),
  );

  // Move 1: defined -> in-progress (on-disk relocation, matching what applyMove does).
  mkdirSync(join(root, "projects", "INF", "in-progress"), { recursive: true });
  writeFileSync(join(root, "projects", "INF", "in-progress", "X.md"), "x v2");
  rmSync(join(root, "projects", "INF", "defined", "X.md"));
  appendEntry(root, {
    id: "INF-1",
    op: "move",
    message: "INF-1: defined → in-progress",
    files: ["projects/INF/defined/X.md", "projects/INF/in-progress/X.md"],
    ts: "t",
  });

  // Move 2: in-progress -> in-review, within the SAME batch. in-progress/X.md
  // (created by move 1, relocated again by move 2) is now neither on disk nor in HEAD.
  mkdirSync(join(root, "projects", "INF", "in-review"), { recursive: true });
  writeFileSync(join(root, "projects", "INF", "in-review", "X.md"), "x v3");
  rmSync(join(root, "projects", "INF", "in-progress", "X.md"));
  appendEntry(root, {
    id: "INF-1",
    op: "move",
    message: "INF-1: in-progress → in-review",
    files: ["projects/INF/in-progress/X.md", "projects/INF/in-review/X.md"],
    ts: "t",
  });

  writeFileSync(join(root, "untracked-other"), "should NOT be committed");

  const out = runCommit(root).stdout;
  assert.match(out, /blaze commit: flushed 2 op/);

  const afterCount = Number(
    execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(),
  );
  assert.equal(afterCount, beforeCount + 1, "exactly one new commit");

  const changed = execFileSync("git", ["-C", root, "show", "--name-status", "--format=", "HEAD"], {
    encoding: "utf8",
  });
  assert.match(changed, /^D\s+projects\/INF\/defined\/X\.md$/m);
  assert.match(changed, /^A\s+projects\/INF\/in-review\/X\.md$/m);
  assert.doesNotMatch(changed, /in-progress\/X\.md/);

  const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  assert.match(status, /\?\? untracked-other/);
  assert.deepEqual(readEntries(root), []);
  rmSync(root, { recursive: true, force: true });
});

test("REPRO OBA-484: default flush does NOT bundle a foreign session's queued ops", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-1.md"), "mine");
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-2.md"), "foreign wip");
  appendEntry(root, { id: "OBA-1", op: "new", message: "OBA-1: mine", files: ["projects/OBA/backlog/OBA-1.md"], ts: "t", session: "me" }, "me");
  appendEntry(root, { id: "OBA-2", op: "new", message: "OBA-2: foreign", files: ["projects/OBA/backlog/OBA-2.md"], ts: "t", session: "sister" }, "sister");

  runCommit(root, null, { session: "me" });

  const body = execFileSync("git", ["-C", root, "log", "-1", "--format=%b"], { encoding: "utf8" });
  assert.match(body, /OBA-1: mine \[me\]/);
  assert.doesNotMatch(body, /OBA-2/);
  const shown = execFileSync("git", ["-C", root, "show", "--stat", "--format=", "HEAD"], { encoding: "utf8" });
  assert.doesNotMatch(shown, /OBA-2\.md/);
  assert.equal(readEntries(root, "sister").length, 1); // sister's WIP still queued
  assert.deepEqual(readEntries(root, "me"), []);       // mine drained
  rmSync(root, { recursive: true, force: true });
});

test("unset session drains only the shared fallback queue", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-3.md"), "legacy");
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-4.md"), "sessioned");
  appendEntry(root, { id: "OBA-3", op: "new", message: "OBA-3: legacy", files: ["projects/OBA/backlog/OBA-3.md"], ts: "t" });
  appendEntry(root, { id: "OBA-4", op: "new", message: "OBA-4: sessioned", files: ["projects/OBA/backlog/OBA-4.md"], ts: "t", session: "s1" }, "s1");
  runCommit(root);
  const body = execFileSync("git", ["-C", root, "log", "-1", "--format=%b"], { encoding: "utf8" });
  assert.match(body, /OBA-3: legacy/);
  assert.doesNotMatch(body, /OBA-4/);
  assert.equal(readEntries(root, "s1").length, 1);
  rmSync(root, { recursive: true, force: true });
});

test("--all sweeps every queue + fallback into one commit with session-tagged body", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  for (const n of ["OBA-5", "OBA-6", "OBA-7"]) writeFileSync(join(root, "projects", "OBA", "backlog", `${n}.md`), n);
  appendEntry(root, { id: "OBA-5", op: "new", message: "OBA-5: a", files: ["projects/OBA/backlog/OBA-5.md"], ts: "t", session: "a" }, "a");
  appendEntry(root, { id: "OBA-6", op: "new", message: "OBA-6: b", files: ["projects/OBA/backlog/OBA-6.md"], ts: "t", session: "b" }, "b");
  appendEntry(root, { id: "OBA-7", op: "new", message: "OBA-7: legacy", files: ["projects/OBA/backlog/OBA-7.md"], ts: "t" });
  runCommit(root, null, { args: ["--all"] });
  const subject = execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  const body = execFileSync("git", ["-C", root, "log", "-1", "--format=%b"], { encoding: "utf8" });
  assert.match(subject, /\(3 new\)$/);
  assert.match(body, /OBA-5: a \[a\]/);
  assert.match(body, /OBA-6: b \[b\]/);
  assert.match(body, /- OBA-7: legacy(?!.*\[)/m);
  assert.deepEqual(readEntries(root, "a"), []);
  assert.deepEqual(readEntries(root, "b"), []);
  assert.deepEqual(readEntries(root), []);
  rmSync(root, { recursive: true, force: true });
});
