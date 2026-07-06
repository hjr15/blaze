import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readEntries } from "../scripts/pending-ledger.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// A temp board: real scripts/ (copied so relative imports resolve), a git repo,
// blaze.config.json, and one in-progress ticket to log against.
function board(commitMode) {
  const root = mkdtempSync(join(tmpdir(), "blaze-runner-"));
  cpSync(join(REPO, "scripts"), join(root, "scripts"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"], commitMode }));
  const dir = join(root, "projects", "OBA", "in-progress");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "OBA-1.md"),
    "---\nid: OBA-1\ntype: task\nstatus: in-progress\nestimate: 60\n---\n\nbody\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}
const head = (root) => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

test("batch mode: blaze log queues, no commit", () => {
  const root = board("batch");
  const before = head(root);
  execFileSync(process.execPath, [join(root, "scripts", "log-runner.mjs"), "OBA-1", "30"], { cwd: root });
  assert.equal(head(root), before, "HEAD must not move in batch mode");
  const entries = readEntries(root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].op, "log");
  assert.match(entries[0].message, /^OBA-1: log 30m$/);
  rmSync(root, { recursive: true, force: true });
});

test("per-op mode: blaze log commits", () => {
  const root = board("per-op");
  const before = head(root);
  execFileSync(process.execPath, [join(root, "scripts", "log-runner.mjs"), "OBA-1", "30"], { cwd: root });
  assert.notEqual(head(root), before, "HEAD must advance in per-op mode");
  const subject = execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  assert.equal(subject, "OBA-1: log 30m");
  rmSync(root, { recursive: true, force: true });
});

test("batch mode: blaze move queues a two-file entry, no commit", () => {
  const root = board("batch");
  const before = head(root);
  execFileSync(process.execPath, [join(root, "scripts", "move-runner.mjs"), "OBA-1", "in-review"], { cwd: root });
  assert.equal(head(root), before, "HEAD must not move in batch mode");
  const entries = readEntries(root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].op, "move");
  assert.equal(entries[0].files.length, 2);
  assert.ok(entries[0].files.some((f) => f.includes("in-progress")), "ledger must include the source path");
  assert.ok(entries[0].files.some((f) => f.includes("in-review")), "ledger must include the destination path");
  rmSync(root, { recursive: true, force: true });
});

test("per-op mode: blaze move commits and relocates the file", () => {
  const root = board("per-op");
  const before = head(root);
  execFileSync(process.execPath, [join(root, "scripts", "move-runner.mjs"), "OBA-1", "in-review"], { cwd: root });
  assert.notEqual(head(root), before, "HEAD must advance in per-op mode");
  assert.ok(existsSync(join(root, "projects", "OBA", "in-review", "OBA-1.md")), "ticket file must be relocated to in-review/");
  assert.ok(!existsSync(join(root, "projects", "OBA", "in-progress", "OBA-1.md")), "ticket file must no longer be in in-progress/");
  rmSync(root, { recursive: true, force: true });
});
