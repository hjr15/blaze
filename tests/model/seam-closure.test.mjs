// tests/model/seam-closure.test.mjs — BLZ-275, ADR-0009.
//
// A structural guard, not a behavioural one. ADR-0009 says every read goes through
// the driver; nothing in the suite enforced that, so the next person to need "just
// one quick walk" would reintroduce a bypass with a green suite — which is exactly
// how contentHash survived four earlier slices unnoticed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(fileURLToPath(new URL("../../scripts", import.meta.url)));

// The seam itself, and the one module that owns the filesystem walk.
const SEAM = new Set(["model/index.mjs", "model/read-storage.mjs"]);

function* mjsFiles(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { yield* mjsFiles(p); continue; }
    if (e.endsWith(".mjs")) yield p;
  }
}

test("no module outside the seam calls walkTickets", () => {
  const offenders = [];
  for (const file of mjsFiles(SCRIPTS)) {
    const rel = relative(SCRIPTS, file).split("\\").join("/");
    if (SEAM.has(rel)) continue;
    const src = readFileSync(file, "utf8");
    // a call, not a mention in prose — comments legitimately name it
    if (/\bwalkTickets\s*\(/.test(src.replace(/\/\/.*$/gm, ""))) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    "ADR-0009: reads go through the driver. Add a named operation to read-storage.mjs " +
    "instead of walking the corpus directly.");
});

test("no module outside the seam stats or lists the projects tree directly", () => {
  // contentHash did exactly this for four slices without anyone noticing, at 35.4 ms
  // per poll per open tab. This is the guard that would have caught it.
  const ALLOWED = new Set([
    "model/index.mjs", "model/read-storage.mjs",
    "model/storage.mjs",        // the WRITE seam owns file creation
    "model/ids.mjs", "model/claims.mjs",  // the allocator, deleted at Phase 2
    "model/transitions.mjs",    // git rename history, not the ticket store
    "model/sprints.mjs", "config.mjs",    // registries, not tickets
    "migrate/jira-import.mjs",  // a migration path, not a live verb
    "loops/groomer.mjs",        // hashes file text against git porcelain
    "pending-ledger.mjs", "commit-lock.mjs", "reindex.mjs", "supervisor.mjs",
  ]);
  const offenders = [];
  for (const file of mjsFiles(SCRIPTS)) {
    const rel = relative(SCRIPTS, file).split("\\").join("/");
    if (ALLOWED.has(rel) || rel.startsWith("ci/")) continue;
    const src = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
    if (/\breaddirSync\s*\(|\bstatSync\s*\(/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    "a bespoke directory walk outside the seam is how contentHash hid for four slices");
});
