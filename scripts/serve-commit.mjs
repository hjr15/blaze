// scripts/serve-commit.mjs — commit exactly one file, locally, never push.
// The board's only git surface. Deliberately NOT `git add -A` (that would sweep
// unrelated working-tree changes on the real 765-ticket tree).
import { spawnSync } from "node:child_process";

export function commitFile(root, file, message, extraFiles = []) {
  const filesToAdd = [file, ...extraFiles];
  const add = spawnSync("git", ["-C", root, "add", ...filesToAdd], { stdio: "ignore" });
  if (add.status !== 0) return { ok: false, status: add.status };
  const commit = spawnSync("git", ["-C", root, "commit", "-m", message, "--", ...filesToAdd], { stdio: "ignore" });
  // status 1 with nothing to commit is a benign no-op (idempotent re-write).
  if (commit.status !== 0) {
    const clean = spawnSync("git", ["-C", root, "diff", "--cached", "--quiet"], { stdio: "ignore" });
    if (clean.status === 0) return { ok: true, status: 0 };
    return { ok: false, status: commit.status };
  }
  return { ok: true, status: 0 };
}
