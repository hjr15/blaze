// scripts/migrate/jira-client.mjs — the migration I/O boundary. The raw Jira
// pull is performed by the jira-export-migrator AGENT (a node script has no
// access to mcp__atlassian__* tools); the agent writes raw issues here. This
// module only reads/writes the .migration-cache/ files. Pure-fs, zero-dep.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(parsed) ? parsed : (parsed.issues ?? []);
}
