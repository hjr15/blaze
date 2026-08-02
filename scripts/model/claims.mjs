// scripts/model/claims.mjs — the committed allocation ledger (BLZ-136 / ADR-0005).
//
// One file per issued id, at a SLUG-FREE path. That is the whole trick: a
// ticket's filename carries a slug, so two machines issuing the same id write
// DIFFERENT paths (PROJ-700-alpha.md, PROJ-700-beta.md) and git merges them
// cleanly — the collision is invisible by construction. A claim's path is
// derived from the id alone, so the same id means the same path, and git raises
// an add/add conflict instead.
//
// Two machines issuing DIFFERENT ids write different paths and never interact,
// which is precisely how this differs from the committed counter file ADR-0013
// killed: the conflict surface is per-id, not global.
//
// Claims are append-only TOMBSTONES: never deleted — not on renumber, not on
// ticket deletion, not on a move to a terminal status. A claim asserts "this id
// was issued", which never stops being true. Deleting one lets a retired id be
// re-issued and re-arms the bug this exists to close.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function claimDir(projectsDir, key) {
  return join(projectsDir, key, ".ids");
}

export function claimPath(projectsDir, key, n) {
  return join(claimDir(projectsDir, key), String(n));
}

// Content carries the slug because git auto-merges byte-identical adds: two
// machines writing the SAME bytes to the same path would merge cleanly and the
// collision would stay silent. The slug is what makes the blobs differ.
export function writeClaim(projectsDir, key, n, slug, { provisional = false } = {}) {
  mkdirSync(claimDir(projectsDir, key), { recursive: true });
  const p = claimPath(projectsDir, key, n);
  writeFileSync(p, `${key}-${n} ${slug}${provisional ? " provisional" : ""}\n`);
  return p;
}

export function claimedNumbers(projectsDir, key) {
  const out = new Set();
  let entries = [];
  try { entries = readdirSync(claimDir(projectsDir, key)); } catch { return out; }
  // `^\d+$` also excludes the .cutover marker below.
  for (const e of entries) if (/^\d+$/.test(e)) out.add(Number(e));
  return out;
}

export function maxClaim(projectsDir, key) {
  let max = 0;
  for (const n of claimedNumbers(projectsDir, key)) max = Math.max(max, n);
  return max;
}

// --- cutover -----------------------------------------------------------------
// Tickets that predate the ledger cannot have claims, and ADR-0005 promises no
// backfill. So the ticket-without-claim invariant applies only to ids issued
// AFTER claims existed. The boundary is recorded once, on the first allocation
// for a key, and never moved — raising it later would silently forgive real
// missing claims.

export function cutoverPath(projectsDir, key) {
  return join(claimDir(projectsDir, key), ".cutover");
}

export function readCutover(projectsDir, key) {
  try { return Number(readFileSync(cutoverPath(projectsDir, key), "utf8").trim()) || 0; }
  catch { return 0; }
}

export function ensureCutover(projectsDir, key, currentMax) {
  const p = cutoverPath(projectsDir, key);
  if (existsSync(p)) return readCutover(projectsDir, key);
  mkdirSync(claimDir(projectsDir, key), { recursive: true });
  writeFileSync(p, `${currentMax}\n`);
  return currentMax;
}

// --- remote claims (ADR-0005 layer 2b) ---------------------------------------
// Reading the remote's claim set is what makes the allocator AVOID most
// cross-machine collisions rather than merely detect them: an id another machine
// has already published is visible before the next one is issued. Tree read
// only — no working tree touched, no merge.
//
// Returns 0 on ANY failure (offline, no remote, no such branch). The caller
// marks the resulting claim provisional. It must never crash ticket creation:
// refusing to create tickets without a network is a worse regression than a
// collision caught loudly at merge.
export function remoteMaxClaim(dataRoot, key, { remote = "origin", branch = "main" } = {}) {
  const fetched = spawnSync("git", ["-C", dataRoot, "fetch", "--quiet", remote, branch], { encoding: "utf8" });
  if (fetched.status !== 0) return 0;
  const ls = spawnSync(
    "git",
    ["-C", dataRoot, "ls-tree", "--name-only", "FETCH_HEAD", "--", `projects/${key}/.ids/`],
    { encoding: "utf8" },
  );
  if (ls.status !== 0) return 0;
  let max = 0;
  for (const line of ls.stdout.split("\n")) {
    const m = /\/(\d+)$/.exec(line.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}
