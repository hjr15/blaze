// scripts/serve-commit.mjs — commit exactly one file, locally, never push.
// The board's only per-op git surface. Deliberately NOT `git add -A` (that
// would sweep unrelated working-tree changes on the real 765-ticket tree).
// Serialized against concurrent flushes via the advisory commit lock.
import { spawnSync } from "node:child_process";
import { acquireLock, releaseLock } from "./commit-lock.mjs";

export function commitFile(root, file, message, extraFiles = [], lockOpts = {}) {
  const lock = acquireLock(root, lockOpts);
  if (!lock.ok) return { ok: false, locked: true, status: -1 };
  try {
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
  } finally {
    releaseLock(root);
  }
}
