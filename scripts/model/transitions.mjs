// scripts/model/transitions.mjs — status-move history derived from git rename
// history. Directory renames ARE status transitions: a ticket moving from
// projects/<KEY>/<status-a>/ to projects/<KEY>/<status-b>/ is a `git mv`,
// so `git log --diff-filter=R` already carries the full move history with
// zero new data capture. (Metrics-view Task 1.)
//
// No import from views/ or serve.mjs — this module is a pure data source.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const NUL = "\0";
// projects/<KEY>/<status>/<KEY>-<n>-*.md (slug is optional: <KEY>-<n>.md also matches)
const PATH_RE = /^projects\/([^/]+)\/([^/]+)\/([^/]+-\d+)(?:-[^/]*)?\.md$/;

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
  let cached = null;
  try { cached = JSON.parse(readFileSync(cachePath, "utf8")); } catch { cached = null; }

  const head = sh(root, ["rev-parse", "HEAD"]);
  if (head === null) return { head: null, transitions: [] };
  const currentHead = head.trim();

  if (cached && cached.head === currentHead) return cached;

  const built = buildTransitions({ root });
  try {
    mkdirSync(join(root, ".blaze"), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(built));
  } catch { /* cache is best-effort */ }
  return built;
}
