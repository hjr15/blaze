// scripts/commit-or-queue.mjs — single decision point for board-mutating CLI
// verbs: in `batch` mode queue the op onto the pending ledger; otherwise commit
// scoped to exactly the touched files (never `git add -A`).
import { relative } from "node:path";
import { commitFile } from "./serve-commit.mjs";
import { appendEntry, sessionId, queueRoot } from "./pending-ledger.mjs";
import { assertWritable } from "./readonly.mjs";
import { currentBranch } from "./branch-guard.mjs";
import { OP_LABEL } from "./commit-summary.mjs";

export function commitOrQueue({ root, mode, op, id, ids = null, message, files, lockOpts = {} }) {
  // BLZ-427: `blaze commit`'s subject line renders every queued op through
  // OP_LABEL, and an op with no entry there fell through to the raw op name ("1
  // reconcile"). Refusing at QUEUE time — the one place every op passes through —
  // means the subject can never print a word nobody chose, instead of the summary
  // quietly papering over it. A caller error, so it throws rather than returning a
  // shape callers would have to start checking.
  if (!Object.hasOwn(OP_LABEL, op)) {
    throw new Error(`blaze: unknown board op "${op}" — add it to OP_LABEL in scripts/commit-summary.mjs `
      + `so \`blaze commit\` has a word for it (known: ${Object.keys(OP_LABEL).join(", ")})`);
  }
  // BLZ-121 defence-in-depth: cli.mjs is the primary gate (refuses to spawn
  // the runner at all); this catches a caller that reaches this function by
  // some other path (a direct `node scripts/*-runner.mjs`, serve.mjs's
  // in-process `/api/*` handlers). Not a sandbox — see readonly.mjs.
  assertWritable(`commit/queue op: ${op}`);
  const unique = [...new Set(files)];
  if (mode === "batch") {
    const session = sessionId();
    // INF-673: record the branch this op was queued on. `blaze commit` later
    // refuses to flush onto a non-default branch that the ops were not queued
    // on — which is exactly the shape of the CRP-51/INF-663/INF-748 incidents,
    // where a parallel lane changed the shared checkout's branch in between.
    const branch = currentBranch(root);
    // BLZ-556: which WORKING TREE this op's files were written in, relative to the shared
    // queue store. One store now serves every worktree of the repo, so an op has to say
    // where its files are: they exist in the checkout that queued it and nowhere else, and
    // a flush elsewhere would stage nothing for them and then clear the queue.
    //
    // Recorded UNCONDITIONALLY, including the empty string that means "the main working
    // tree". Omitting it there — to keep the ledger shape unchanged for the ordinary case —
    // was a defect, not a saving: `currentBranch` returns null on a DETACHED HEAD, so a main
    // checkout mid-rebase, mid-bisect, on `checkout <sha>`, or in any detached review
    // worktree recorded neither field, and `belongsHere`'s last line ("neither field: a
    // pre-INF-673 op, treated as this tree's") then made "queued in the main tree" and "no
    // provenance at all" the same signal. Any other worktree would drain that op, stage
    // nothing for it, and delete the record — at the flush, on the default branch, where
    // `checkBranch` is not a backstop. `belongsHere` compares `"" === here.worktree`, so the
    // empty string is a real answer and carries its own meaning.
    //
    // Recorded RELATIVE so it still means something inside the flush CronJob's container,
    // where the board is mounted at a different absolute path.
    const worktree = relative(queueRoot(root), root);
    appendEntry(root, {
      id,
      op,
      message,
      // BLZ-427: the tickets this ONE op covers. For every per-ticket verb that is
      // exactly `[id]` and the field is omitted (the ledger's shape is unchanged for
      // them); reconcile passes the real list, because one reconcile op can cover a
      // dozen tickets and `blaze commit` counted it as one.
      ...(ids && ids.length ? { ids: [...new Set(ids)] } : {}),
      files: unique.map((f) => relative(root, f)),
      ts: new Date().toISOString(),
      ...(session ? { session } : {}),
      ...(branch ? { branch } : {}),
      worktree,
    }, session);
    return { ok: true, committed: false, queued: true };
  }
  const [first, ...rest] = unique;
  return commitFile(root, first, message, rest, lockOpts);
}

/** What a per-ticket verb appends to its own success line so the sentence is true
 *  about GIT, not just about the file.
 *
 *  BLZ-422: `(queued for blaze commit)` was the only non-committed outcome any
 *  runner named, because it was the only one they could see — `commitFile` returned
 *  the same `{ok:true,status:0}` for a real commit and for its benign empty-diff
 *  no-op. Every verb here is idempotent (`blaze edit` to the value already there,
 *  `blaze resolve` to the resolution already there, `blaze link` re-adding a link,
 *  `POST /api/ac` re-checking a box), so the no-op is ordinary traffic, and on a
 *  board whose model is "one op, one commit" a bare success line reads as a commit
 *  that does not exist. */
export function commitSuffix(c) {
  if (c.queued) return " (queued for blaze commit)";
  if (c.noop) return " (no commit created — the file already matched HEAD)";
  return "";
}
