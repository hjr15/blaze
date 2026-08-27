// scripts/migrate-runner.mjs — CLI entry for `blaze migrate`. Dry-run (default)
// runs the audit pipeline over .migration-cache/ and writes migration/MIGRATION-
// AUDIT.md + migration/disposition-ledger.json. The MCP pull that populates the
// cache is performed by the jira-export-migrator agent, not this script.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runDryRun, runLive } from "./migrate/jira-import.mjs";
import { resolveRoots, loadConfig, InvalidProjectKeyError } from "./config.mjs";

const { dataRoot, projectsDir } = resolveRoots();
const CACHE = join(dataRoot, ".migration-cache");
const MIGRATION = join(dataRoot, "migration");

const argv = process.argv.slice(2);
let mode = "dry-run", enableMerges = false, projectSeen = false, project;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case "--live": mode = "live"; break;
    case "--dry-run": mode = "dry-run"; break;
    case "--merge": enableMerges = true; break;
    case "--project": projectSeen = true; project = argv[++i]; break;
    default:
      console.error(`unknown flag: ${a}`);
      process.exit(1);
  }
}
if (projectSeen && project === undefined) {
  console.error("usage: blaze migrate [--dry-run|--live] [--project KEY] [--merge]");
  process.exit(1);
}
// No explicit --project: fall back to blaze.config.json's configured projects
// list rather than a hardcoded guess.
//
// BLZ-402 review finding 3: `loadConfig` throws `blaze: …` on a malformed project key
// too, since BLZ-402 — `cli.mjs`'s preflight already catches this for the normal
// `blaze migrate` path, but a direct `node migrate-runner.mjs` bypasses it entirely.
let configuredKeys;
try { configuredKeys = loadConfig({ root: dataRoot }).projects; }
catch (e) {
  if (e instanceof InvalidProjectKeyError) { console.error(e.message); process.exit(1); }
  throw e;
}
const keys = projectSeen ? [project] : configuredKeys;
if (keys.length === 0) {
  console.error("usage: blaze migrate [--dry-run|--live] --project KEY [--merge] (no projects configured in blaze.config.json)");
  process.exit(1);
}

if (mode === "dry-run") {
  const { auditMd, ledger, stats } = runDryRun({ cacheDir: CACHE, keys, detectMerges: enableMerges });
  mkdirSync(MIGRATION, { recursive: true });
  ledger.generated = new Date().toISOString().slice(0, 10);
  writeFileSync(join(MIGRATION, "MIGRATION-AUDIT.md"), auditMd);
  writeFileSync(join(MIGRATION, "disposition-ledger.json"), JSON.stringify(ledger, null, 2) + "\n");
  console.log(`dry-run: source ${stats.source} · kept ${stats.kept} · dropped ${stats.dropped} · merged ${stats.merged}`);
  console.log(`wrote migration/MIGRATION-AUDIT.md + migration/disposition-ledger.json — review + edit, then: blaze migrate --live`);
} else {
  const ledgerPath = join(MIGRATION, "disposition-ledger.json");
  if (!existsSync(ledgerPath)) {
    console.error(`refusing --live: ${ledgerPath} not found. Run a --dry-run, review + edit the ledger first.`);
    process.exit(1);
  }
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const res = runLive({ cacheDir: CACHE, projectsDir, keys, ledger });
  // BLZ-139: stage the projects tree ONLY, never the whole data root. A bare
  // `add -A` sweeps every unrelated change in the working tree into the migration
  // commit — including a sister session's in-flight edits, which on a shared board
  // checkout is how another agent's half-finished work gets committed under this
  // commit's message. `-A` is kept (scoped) because runLive's removeExisting()
  // deletes superseded ticket files, and those deletions must be staged too.
  spawnSync("git", ["-C", dataRoot, "add", "-A", "--", projectsDir], { stdio: "ignore" });
  spawnSync("git", ["-C", dataRoot, "commit", "-m", `migrate: import ${keys.join("+")} from Jira (${res.written.length} tickets)`, "--", projectsDir], { stdio: "inherit" });
  console.log(`live: wrote ${res.written.length} tickets · dropped ${res.dropped} · merged ${res.merged}`);
}
