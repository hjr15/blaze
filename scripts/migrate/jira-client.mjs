// scripts/migrate/jira-client.mjs — the migration I/O boundary. The raw Jira
// pull is performed by the jira-export-migrator AGENT (a node script has no
// access to mcp__atlassian__* tools); the agent writes raw issues here. This
// module only reads/writes the .migration-cache/ files. Pure-fs, zero-dep.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
// BLZ-512 / ADR-0031. `existsSync` is not a guard. The cache IS the migration's corpus,
// so there is no honest degraded value for it — the read refuses rather than returning
// the empty issue list that would import nothing and report success.
import { readRegularFileSync } from "../model/regular-file.mjs";
import { join } from "node:path";

export function cacheFile(cacheDir, key) {
  return join(cacheDir, `${key}.json`);
}

export function writeRawCache(cacheDir, key, rawIssues) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile(cacheDir, key), JSON.stringify({ key, issues: rawIssues }, null, 2));
}

export function readRawCache(cacheDir, key) {
  const file = cacheFile(cacheDir, key);
  if (!existsSync(file)) {
    throw new Error(
      `migration cache missing: ${file}\n` +
      `Populate it with the jira-export-migrator agent (paginated MCP pull) before running blaze migrate.`);
  }
  const parsed = JSON.parse(readRegularFileSync(file, "utf8"));
  return Array.isArray(parsed) ? parsed : (parsed.issues ?? []);
}
