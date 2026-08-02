// scripts/model/ids.mjs — per-project sequential ID allocation by filesystem
// scan. Zero stored state: the highest <KEY>-N on disk (closed tickets stay in
// terminal dirs, so the high-water mark survives) + 1. (Phase-3 design §1.2.)
import { readdirSync, statSync, openSync, closeSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { commonDirFor } from "./git-common.mjs";
import { maxClaim, claimedNumbers, ensureCutover } from "./claims.mjs";

function* walkFiles(dir) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    let s;
    try { s = statSync(p); } catch { continue; }
    // BLZ-136: never descend into `.ids/` (or any dot-dir) — it holds the
    // allocation ledger, whose filenames would otherwise be read as ticket ids.
    if (s.isDirectory()) {
      if (e.startsWith(".")) continue;
      yield* walkFiles(p);
    } else yield p;
  }
}

export function maxId(projectsDir, key) {
  const re = new RegExp("(?:^|[/\\\\])" + key + "-(\\d+)\\b", "i");
  let max = 0;
  for (const f of walkFiles(join(projectsDir, key))) {
    if (!f.endsWith(".md")) continue;
    const m = re.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export function nextId(projectsDir, key) {
  return `${key}-${maxId(projectsDir, key) + 1}`;
}

// --- allocation (BLZ-136 / ADR-0005) -----------------------------------------

function reservationDir(dataRoot, key) {
  return join(commonDirFor(dataRoot), "blaze", "ids", key);
}

function maxReserved(dir) {
  let max = 0;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const e of entries) if (/^\d+$/.test(e)) max = Math.max(max, Number(e));
  return max;
}

// Reserve an id atomically across every worktree of this clone.
//
// `O_EXCL` is the entire concurrency primitive: the first writer to create
// <common>/blaze/ids/<KEY>/<N> owns N; a loser gets EEXIST, bumps and retries.
// No lockfile, no daemon, and crucially no committed counter file — ADR-0013
// killed that one because every concurrent allocation conflicted on it.
//
// The floor is the max of every layer that can know about an id: what's on disk,
// what's been claimed (including tombstones for tickets since deleted), what
// this clone has already reserved, and what the remote has published. Each is
// tree or local state, never git history — which is why squash-merge and
// branch-delete cannot walk the number backwards.
export function allocateId(projectsDir, key, { dataRoot, remoteMax = 0 } = {}) {
  const resDir = reservationDir(dataRoot, key);
  mkdirSync(resDir, { recursive: true });
  const onDisk = maxId(projectsDir, key);
  // Recorded once, on first allocation: everything at or below this predates the
  // claim ledger and is exempt from the ticket-without-claim invariant.
  ensureCutover(projectsDir, key, onDisk);

  let n = Math.max(onDisk, maxClaim(projectsDir, key), maxReserved(resDir), Number(remoteMax) || 0) + 1;
  const claimed = claimedNumbers(projectsDir, key);
  for (;;) {
    if (claimed.has(n)) { n++; continue; }
    try {
      closeSync(openSync(join(resDir, String(n)), "wx"));
      return { id: `${key}-${n}`, n };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      n++;
    }
  }
}
