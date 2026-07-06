// tests/migrate/dry-run.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRawCache } from "../../scripts/migrate/jira-client.mjs";
import { runDryRun, loadNormalized } from "../../scripts/migrate/jira-import.mjs";

function seedCache() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-dry-"));
  writeRawCache(dir, "OBA", [
    { key: "OBA-1", fields: { summary: "Goal", issuetype: { name: "Goal" }, project: { key: "OBA" },
      status: { name: "In Progress" } } },
    { key: "OBA-2", fields: { summary: "Epic A", issuetype: { name: "Epic" }, project: { key: "OBA" },
      status: { name: "In Progress" }, parent: { key: "OBA-1" } } },
    { key: "OBA-3", fields: { summary: "Dead task", issuetype: { name: "Task" }, project: { key: "OBA" },
      status: { name: "Done" }, resolution: { name: "Won't Do" } } },
  ]);
  return dir;
}

test("loadNormalized reads + normalizes the cache", () => {
  const dir = seedCache();
  const norms = loadNormalized(dir, ["OBA"]);
  assert.equal(norms.length, 3);
  assert.equal(norms[0].type, "Goal");
  rmSync(dir, { recursive: true, force: true });
});

test("runDryRun produces an audit + ledger and drops the Won't Do", () => {
  const dir = seedCache();
  const { auditMd, ledger, stats } = runDryRun({ cacheDir: dir, keys: ["OBA"] });
  assert.equal(stats.source, 3);
  assert.equal(stats.dropped, 1);
  assert.equal(ledger.items.find((i) => i.id === "OBA-3").disposition, "drop");
  assert.match(auditMd, /# Migration Audit/);
  rmSync(dir, { recursive: true, force: true });
});
