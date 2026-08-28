// scripts/serve-commit.mjs — commit exactly one file, locally, never push.
// The board's only per-op git surface. Deliberately NOT `git add -A` (that
// would sweep unrelated working-tree changes on the real 765-ticket tree).
// Serialized against concurrent flushes via the advisory commit lock.
import { spawnSync } from "node:child_process";
import { acquireLock, releaseLock } from "./commit-lock.mjs";

export function commitFile(root, file, message, extraFiles = [], lockOpts = {}) {
  const lock = acquireLock(root, lockOpts);
  if (!lock.ok) return { ok: false, committed: false, locked: true, status: -1 };
  try {
    const filesToAdd = [file, ...extraFiles];
    const add = spawnSync("git", ["-C", root, "add", ...filesToAdd], { stdio: "ignore" });
    if (add.status !== 0) return { ok: false, committed: false, status: add.status };
    const commit = spawnSync("git", ["-C", root, "commit", "-m", message, "--", ...filesToAdd], { stdio: "ignore" });
    // status 1 with nothing to commit is a benign no-op (idempotent re-write).
    //
    // BLZ-422: benign, and NOT the same thing as a commit. This used to return
    // `{ ok: true, status: 0 }` — byte-identical to the real-commit return below —
    // so no caller could tell "a commit exists" from "the staged tree already matched
    // HEAD, nothing entered `git log`". reconcile then reported
    // `commitOutcome: "committed"` for it, a false delivery record one layer under
    // BLZ-403's. It stays `ok: true` (an idempotent re-write must not become an
    // error); what it no longer does is claim a commit. `committed` is the field
    // every caller must read — `ok` answers "did this go wrong", `committed` answers
    // "is there a new commit". Reachable on any byte-identical re-write: `blaze edit`
    // setting a field to its current value, `blaze resolve` re-stating a resolution,
    // `blaze link` re-adding an existing link, `POST /api/ac` re-checking a box.
    if (commit.status !== 0) {
      const clean = spawnSync("git", ["-C", root, "diff", "--cached", "--quiet"], { stdio: "ignore" });
      if (clean.status === 0) return { ok: true, committed: false, noop: true, status: 0 };
      return { ok: false, committed: false, status: commit.status };
    }
    return { ok: true, committed: true, status: 0 };
  } finally {
    releaseLock(root);
  }
}
