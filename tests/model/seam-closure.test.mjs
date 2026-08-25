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

test("no module outside the write seam writes or renames a ticket file", () => {
  // BLZ-267 wired six verbs and deliberately left reconcile, whose write is
  // interleaved inside a per-ticket loop. BLZ-276 finished it. This is the guard that
  // keeps the seventh writer from reappearing.
  const ALLOWED = new Set([
    "model/storage.mjs",                    // the write seam itself
    "model/ids.mjs", "model/claims.mjs",    // the allocator, deleted at Phase 2
    "model/transitions.mjs", "model/sprints.mjs",  // caches and registries
    "reindex.mjs",                          // derived, gitignored caches
    "pending-ledger.mjs", "commit-lock.mjs", "serve-commit.mjs",
    "migrate/jira-import.mjs", "migrate-runner.mjs", "migrate/jira-client.mjs",
    "loops/groomer.mjs", "config.mjs",
    // BLZ-285. `blaze init` writes blaze.config.json, project.json and .gitignore —
    // config, never a ticket — and it runs BEFORE a board exists, so there is no
    // storage driver to route through. Listed for the same reason config.mjs is.
    "init-runner.mjs",
    // BLZ-358. The first-run setup token is a CREDENTIAL, not a ticket: one file under
    // .blaze/, written at mode 0600 and deleted the moment setup completes. Routing it
    // through the storage driver would be wrong on its own terms — the driver exists to
    // put TICKETS where the board keeps tickets, and this must land on local disk at a
    // known path even when the board's storage is Postgres, because the operator reads
    // it with `cat` before any identity exists.
    "model/setup-token.mjs",
  ]);
  const offenders = [];
  for (const file of mjsFiles(SCRIPTS)) {
    const rel = relative(SCRIPTS, file).split("\\").join("/");
    if (ALLOWED.has(rel) || rel.startsWith("ci/")) continue;
    const src = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
    if (/\bwriteFileSync\s*\(|\brenameSync\s*\(/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    "ADR-0006: ticket writes go through the storage driver, not node:fs");
});
