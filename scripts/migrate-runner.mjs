// scripts/migrate-runner.mjs — CLI entry for `blaze migrate`. Dry-run (default)
// runs the audit pipeline over .migration-cache/ and writes migration/MIGRATION-
// AUDIT.md + migration/disposition-ledger.json. The MCP pull that populates the
// cache is performed by the jira-export-migrator agent, not this script.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runDryRun, runLive } from "./migrate/jira-import.mjs";
import { resolveRoots, loadConfig } from "./config.mjs";

const { dataRoot, projectsDir } = resolveRoots();
const CACHE = join(dataRoot, ".migration-cache");
const MIGRATION = join(dataRoot, "migration");

const argv = process.argv.slice(2);
const mode = argv.includes("--live") ? "live" : "dry-run";
const projIdx = argv.indexOf("--project");
if (projIdx !== -1 && argv[projIdx + 1] === undefined) {
  console.error("usage: blaze migrate [--dry-run|--live] [--project KEY] [--merge]");
  process.exit(1);
}
// No explicit --project: fall back to blaze.config.json's configured projects
// list rather than a hardcoded guess.
const configuredKeys = loadConfig({ root: dataRoot }).projects;
const keys = projIdx !== -1 ? [argv[projIdx + 1]] : configuredKeys;
if (keys.length === 0) {
  console.error("usage: blaze migrate [--dry-run|--live] --project KEY [--merge] (no projects configured in blaze.config.json)");
  process.exit(1);
}
const enableMerges = argv.includes("--merge");

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
  spawnSync("git", ["-C", dataRoot, "add", "-A"], { stdio: "ignore" });
  spawnSync("git", ["-C", dataRoot, "commit", "-m", `migrate: import ${keys.join("+")} from Jira (${res.written.length} tickets)`], { stdio: "inherit" });
  console.log(`live: wrote ${res.written.length} tickets · dropped ${res.dropped} · merged ${res.merged}`);
}
