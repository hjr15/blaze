// scripts/model/git-common.mjs — resolve the git common dir shared by every
// worktree of one clone (BLZ-136 / ADR-0005).
//
// This is the seam the ID reservation layer stands on: linked worktrees each
// have their own .git FILE but share a single common dir, so a reservation
// written there serialises allocation across all of them without ever being
// committed — and therefore without becoming a merge conflict surface, which is
// what killed the committed-counter mechanism in ADR-0013.
import { realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function git(dataRoot, ...args) {
  const r = spawnSync("git", ["-C", dataRoot, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Throws rather than degrading, deliberately. A silently-unshared reservation is
// worse than none at all: it looks like the layer is working while two sessions
// allocate into separate namespaces and collide on a single machine.
export function commonDirFor(dataRoot) {
  const notARepo = () =>
    new Error(`blaze: ${dataRoot} is not inside a git worktree — cannot reserve ticket ids safely`);

  const common = git(dataRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const top = git(dataRoot, "rev-parse", "--show-toplevel");
  if (!common || !top) throw notARepo();

  // `git -C <dir> rev-parse` succeeds for ANY enclosing repo, so a dataRoot that
  // merely sits *under* an unrelated repo resolves that repo's .git with exit 0.
  // BLAZE_PROJECTS_DIR makes dataRoot/CWD divergence a first-class case, so this
  // is reachable in normal use, not a contrived one.
  const real = realpathSync(dataRoot);
  const realTop = realpathSync(top);

  // A board's dataRoot is either the repo root itself, or a directory holding
  // projects/. Anything else is an accidental ancestor match.
  if (real !== realTop && !existsSync(join(real, "projects"))) {
    throw new Error(
      `blaze: ${dataRoot} is not a board root inside ${realTop} — refusing to reserve ticket ids there`,
    );
  }
  return common;
}
