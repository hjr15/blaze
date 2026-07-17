// tests/edit-runner-batch.test.mjs — BLZ-96: `blaze edit` currently bypasses
// commitMode entirely (edit-runner.mjs calls commitFile directly). Mirrors
// runner-batch.test.mjs's board() fixture and assertions for the other verbs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readEntries } from "../scripts/pending-ledger.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function board(commitMode) {
  const root = mkdtempSync(join(tmpdir(), "blaze-editrunner-"));
  cpSync(join(REPO, "scripts"), join(root, "scripts"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"], commitMode }));
  const dir = join(root, "projects", "OBA", "in-progress");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nstatus: in-progress\nestimate: 60\npriority: medium\n---\n\nbody\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}
const head = (root) => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

test("batch mode: blaze edit queues, no commit", () => {
  const root = board("batch");
  const before = head(root);
  const env = { ...process.env };
  delete env.BLAZE_SESSION;
  execFileSync(process.execPath, [join(root, "scripts", "edit-runner.mjs"), "OBA-1", "priority", "high"], { cwd: root, env });
  assert.equal(head(root), before, "HEAD must not move in batch mode");
  // Unset BLAZE_SESSION auto-derives a queue from ppid — execFileSync has no
  // intermediate shell, so the child's ppid IS this test process's pid.
  const entries = readEntries(root, `auto-${process.pid}`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].op, "edit");
  assert.match(entries[0].message, /^OBA-1: edit priority$/);
  rmSync(root, { recursive: true, force: true });
});

test("per-op mode: blaze edit commits", () => {
  const root = board("per-op");
  const before = head(root);
  execFileSync(process.execPath, [join(root, "scripts", "edit-runner.mjs"), "OBA-1", "priority", "high"], { cwd: root });
  assert.notEqual(head(root), before, "HEAD must advance in per-op mode");
  const subject = execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  assert.equal(subject, "OBA-1: edit priority");
  rmSync(root, { recursive: true, force: true });
});
