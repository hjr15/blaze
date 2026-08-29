// scripts/model/transitions.mjs — status-move history derived from git rename
// history. Directory renames ARE status transitions: a ticket moving from
// projects/<KEY>/<status-a>/ to projects/<KEY>/<status-b>/ is a `git mv`,
// so `git log --diff-filter=R` already carries the full move history with
// zero new data capture. (Metrics-view Task 1.)
//
// No import from views/ or serve.mjs — this module is a pure data source.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readRegularFileSync, writeRegularFileSync } from "./regular-file.mjs";
import { join } from "node:path";

const NUL = "\0";
// projects/<KEY>/<status>/<KEY>-<n>-*.md (slug is optional: <KEY>-<n>.md also matches)
//
// The id group is `[A-Za-z][A-Za-z0-9]*-\d+` and NOT `[^/]+-\d+` (BLZ-233). The permissive
// form was greedy and could not stop at the id, so any slug ending in a digit was swallowed
// whole — `INF-783-…-tier-0.md` parsed to the id `INF-783-…-tier-0`, which is not a ticket,
// and the transition attached to nothing. It fails silently: the cache stays well-formed and
// only the metrics that join on id go quietly short. A key cannot contain `-`, so forbidding
// it in the group is what makes the match stop in the right place.
const PATH_RE = /^projects\/([^/]+)\/([^/]+)\/([A-Za-z][A-Za-z0-9]*-\d+)(?:-[^/]*)?\.md$/;

function statusAndId(path) {
  const m = PATH_RE.exec(path);
  if (!m) return null;
  return { status: m[2], id: m[3] };
}

// --- pure parser --------------------------------------------------------------
export function parseTransitions(gitLogText) {
  const out = [];
  if (!gitLogText) return out;
  let sha = null;
  let ts = null;
  for (const line of gitLogText.split("\n")) {
    if (!line) continue;
    if (line[0] === NUL) {
      const parts = line.split(NUL);
      // parts: ["", sha, ts]
      sha = parts[1] ?? null;
      ts = parts[2] ?? null;
      continue;
    }
    if (!line.startsWith("R")) continue; // only rename records
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const [, fromPath, toPath] = fields;
    const from = statusAndId(fromPath);
    const to = statusAndId(toPath);
    if (!from || !to) continue;
    if (from.status === to.status) continue; // pure slug rename, not a status move
    out.push({ id: to.id, from: from.status, to: to.status, ts });
  }
  return out;
}

// --- git shell-out -------------------------------------------------------------
function sh(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch { return null; }
}

export function buildTransitions({ root }) {
  const head = sh(root, ["rev-parse", "HEAD"]);
  if (head === null) return { head: null, transitions: [] };
  const log = sh(root, ["log", "--diff-filter=R", "--name-status", "--format=%x00%H%x00%cI"]);
  if (log === null) return { head: null, transitions: [] };
  return { head: head.trim(), transitions: parseTransitions(log) };
}

// --- cache read/write ----------------------------------------------------------
export function loadTransitions({ root }) {
  const cachePath = join(root, ".blaze", "transitions.json");
  // BLZ-493: the ONLY one of the ten sites allowed to fall through in silence, and the
  // reason is written here rather than left implied. Every other site's fallback is a claim
  // about the board — no sprints, no cutover, an empty taxonomy — made by a run that never
  // looked. This one's fallback is `buildTransitions`, which LOOKS, at git, and returns the
  // true answer; the cache is a pure optimisation over `git log`. ADR-0030's rule is about a
  // run that could not look reporting what a looking run reports, and this run looks. So it
  // must not BLOCK, and it owes no report. ADR-0031.
  let cached = null;
  try { cached = JSON.parse(readRegularFileSync(cachePath)); } catch { cached = null; }

  const head = sh(root, ["rev-parse", "HEAD"]);
  if (head === null) return { head: null, transitions: [] };
  const currentHead = head.trim();

  if (cached && cached.head === currentHead) return cached;

  const built = buildTransitions({ root });
  try {
    mkdirSync(join(root, ".blaze"), { recursive: true });
    // BLZ-493: guarding only the read moves the hang three lines down. `writeFileSync` on a
    // FIFO with no reader blocks exactly as the read does (measured at 1b00f3a), and a
    // try/catch around a blocking call catches nothing. `writeRegularFileSync` opens
    // non-blocking, so this best-effort write fails fast into the catch below instead.
    writeRegularFileSync(cachePath, JSON.stringify(built));
  } catch { /* cache is best-effort */ }
  return built;
}
