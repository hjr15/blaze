import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { commitOrQueue } from "../scripts/commit-or-queue.mjs";
import { readEntries } from "../scripts/pending-ledger.mjs";

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-coq-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "seed"), "seed");
  execFileSync("git", ["-C", root, "add", "seed"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

test("batch mode appends to the ledger and makes no commit", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  const f = join(root, "projects", "OBA", "backlog", "OBA-1.md");
  writeFileSync(f, "one");
  const before = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  const r = commitOrQueue({ root, mode: "batch", op: "new", id: "OBA-1", message: "OBA-1: create task", files: [f] });

  assert.deepEqual(r, { ok: true, queued: true });
  const after = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(before, after, "HEAD must not move in batch mode");
  const entries = readEntries(root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, "OBA-1: create task");
  assert.deepEqual(entries[0].files, ["projects/OBA/backlog/OBA-1.md"]); // root-relative
  rmSync(root, { recursive: true, force: true });
});

test("per-op mode commits only the given files", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  const f = join(root, "projects", "OBA", "backlog", "OBA-1.md");
  writeFileSync(f, "one");
  writeFileSync(join(root, "untracked-other"), "should NOT be committed");

  const r = commitOrQueue({ root, mode: "per-op", op: "new", id: "OBA-1", message: "OBA-1: create task", files: [f] });

  assert.equal(r.ok, true);
  const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  assert.match(status, /\?\? untracked-other/); // not swept in
  assert.doesNotMatch(status, /OBA-1\.md/);      // committed
  rmSync(root, { recursive: true, force: true });
});
