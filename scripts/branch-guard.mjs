// scripts/branch-guard.mjs — INF-673: refuse to flush board ops onto a branch
// that isn't the caller's.
//
// The blaze-pm checkout is SHARED between concurrent sessions. `blaze commit`
// historically committed to whatever branch the checkout happened to be on,
// silently and with exit 0. Three times in production (CRP-51 and INF-663 on
// 2026-07-30, INF-748 on 2026-08-02) a parallel lane left its own feature
// branch checked out and an unrelated session's board updates landed on that
// lane's unmerged work. Each recovery was the same worktree cherry-pick.
//
// Hard refuse, not warn-and-proceed: the recovery being identical all three
// times is precisely the evidence that a warning would not have been read.
import { spawnSync } from "node:child_process";

const g = (root, ...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });

// null on detached HEAD (or a repo with no commits) — a detached checkout is a
// deliberate act and not the failure mode this guard exists for, so it is left
// to the caller rather than becoming a new way to wedge board ops.
export function currentBranch(root) {
  const r = g(root, "rev-parse", "--abbrev-ref", "HEAD");
  if (r.status !== 0) return null;
  const b = (r.stdout || "").trim();
  return b === "" || b === "HEAD" ? null : b;
}

// Read the default branch from the repo rather than hardcoding "main".
//
// origin/HEAD is authoritative when set. Otherwise fall back to whichever
// conventional name exists, checking LOCAL branches before remote ones: for a
// working checkout, "the branch you ought to be on" lives in the local
// namespace. Preferring the remote here would call a `master`-based checkout
// that merely has an `origin/main` ref "foreign" and refuse every commit on it
// — a false positive, and the guard is worthless the moment it cries wolf.
export function defaultBranch(root) {
  const sym = g(root, "symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD");
  if (sym.status === 0) {
    const name = (sym.stdout || "").trim().replace(/^origin\//, "");
    if (name !== "") return name;
  }
  for (const ns of ["refs/heads", "refs/remotes/origin"]) {
    for (const cand of ["main", "master"]) {
      if (g(root, "rev-parse", "--verify", "-q", `${ns}/${cand}`).status === 0) return cand;
    }
  }
  return null;
}

/**
 * Decide whether `entries` may be committed on the current branch.
 *
 * Provenance rule: an op records the branch it was queued on (see
 * commit-or-queue.mjs). Committing on a non-default branch is legitimate only
 * when EVERY op in the batch was queued on that same branch — i.e. the session
 * made the branch its own before doing board work on it. The three production
 * incidents all fail this: the ops were queued on main and the branch changed
 * underneath them.
 *
 * Entries with no recorded branch (queued by a pre-INF-673 engine) are treated
 * as unknown provenance and therefore refused on a non-default branch. That is
 * the safe direction and it self-clears as soon as the queue turns over.
 */
export function checkBranch(root, entries, { override = false } = {}) {
  if (override) return { ok: true };
  const current = currentBranch(root);
  if (current === null) return { ok: true }; // detached HEAD — not our business
  const def = defaultBranch(root);
  if (def === null || current === def) return { ok: true };

  const queuedOn = [...new Set(entries.map((e) => e.branch ?? null))];
  if (queuedOn.length === 1 && queuedOn[0] === current) return { ok: true };

  const ids = [...new Set(entries.map((e) => e.id).filter(Boolean))];
  const where = queuedOn
    .map((b) => (b === null ? "an earlier engine version (branch not recorded)" : `'${b}'`))
    .join(", ");

  // Name the tickets, not just the count. The damage is cross-LANE: in the
  // INF-748 incident the stranded ops belonged to three tickets in three
  // different lanes, none of them the branch's own.
  const message = [
    `blaze commit: REFUSING — the checkout is on '${current}', which is not the default branch ('${def}'),`,
    `and these ops were not queued on it (queued on: ${where}).`,
    ``,
    `  ${entries.length} op(s) across ${ids.length} ticket(s): ${ids.join(", ")}`,
    ``,
    `Committing here would strand that work on '${current}' — a branch that probably`,
    `belongs to a different lane, and is unmerged. This has happened three times`,
    `(CRP-51, INF-663, INF-748); every recovery was the same worktree cherry-pick.`,
    ``,
    `Nothing has been committed and the queue is intact. Re-run from a checkout on '${def}':`,
    `  git worktree add ../blaze-pm-worktrees/board-${def} ${def}`,
    `  cd ../blaze-pm-worktrees/board-${def} && blaze commit`,
    ``,
    `If '${current}' really is yours and you meant to commit here: blaze commit --branch-ok`,
  ].join("\n");

  return { ok: false, message };
}
