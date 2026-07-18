// scripts/commit-or-queue.mjs — single decision point for board-mutating CLI
// verbs: in `batch` mode queue the op onto the pending ledger; otherwise commit
// scoped to exactly the touched files (never `git add -A`).
import { relative } from "node:path";
import { commitFile } from "./serve-commit.mjs";
import { appendEntry, sessionId } from "./pending-ledger.mjs";
import { assertWritable } from "./readonly.mjs";

export function commitOrQueue({ root, mode, op, id, message, files, lockOpts = {} }) {
  // BLZ-121 defence-in-depth: cli.mjs is the primary gate (refuses to spawn
  // the runner at all); this catches a caller that reaches this function by
  // some other path (a direct `node scripts/*-runner.mjs`, serve.mjs's
  // in-process `/api/*` handlers). Not a sandbox — see readonly.mjs.
  assertWritable(`commit/queue op: ${op}`);
  const unique = [...new Set(files)];
  if (mode === "batch") {
    const session = sessionId();
    appendEntry(root, {
      id,
      op,
      message,
      files: unique.map((f) => relative(root, f)),
      ts: new Date().toISOString(),
      ...(session ? { session } : {}),
    }, session);
    return { ok: true, queued: true };
  }
  const [first, ...rest] = unique;
  return commitFile(root, first, message, rest, lockOpts);
}
