import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { commitFile } from "../scripts/serve-commit.mjs";

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-commit-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "seed"), "seed");
  execFileSync("git", ["-C", root, "add", "seed"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

test("commitFile stages and commits only the given file", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "OBA-1.md"), "one");
  writeFileSync(join(root, "untracked-other"), "should NOT be committed");
  const r = commitFile(root, join(root, "projects", "OBA", "OBA-1.md"), "OBA-1: edit");
  assert.equal(r.ok, true);
  // The other untracked file is still untracked (was not swept in).
  const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  assert.match(status, /\?\? untracked-other/);
  assert.doesNotMatch(status, /OBA-1\.md/); // committed, so not in status
  rmSync(root, { recursive: true, force: true });
});
