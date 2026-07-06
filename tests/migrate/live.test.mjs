// tests/migrate/live.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRawCache } from "../../scripts/migrate/jira-client.mjs";
import { runLive } from "../../scripts/migrate/jira-import.mjs";

function seed() {
  const root = mkdtempSync(join(tmpdir(), "blaze-live-"));
  const cacheDir = join(root, ".migration-cache");
  const projectsDir = join(root, "projects");
  writeRawCache(cacheDir, "OBA", [
    { key: "OBA-1", fields: { summary: "Goal", issuetype: { name: "Goal" }, project: { key: "OBA" }, status: { name: "In Progress" } } },
    { key: "OBA-2", fields: { summary: "Epic A", issuetype: { name: "Epic" }, project: { key: "OBA" }, status: { name: "In Progress" }, parent: { key: "OBA-1" } } },
    { key: "OBA-3", fields: { summary: "Dead", issuetype: { name: "Task" }, project: { key: "OBA" }, status: { name: "Done" }, resolution: { name: "Won't Do" } } },
  ]);
  const ledger = { items: [
    { id: "OBA-1", type: "goal", disposition: "keep", proposed_status: "in-progress", proposed_parent: null },
    { id: "OBA-2", type: "epic", disposition: "keep", proposed_status: "in-progress", proposed_parent: "OBA-1" },
    { id: "OBA-3", type: "task", disposition: "drop", proposed_status: null, proposed_parent: null },
  ] };
  return { root, cacheDir, projectsDir, ledger };
}

test("runLive writes kept tickets in the right status dir and skips drops", () => {
  const { root, cacheDir, projectsDir, ledger } = seed();
  const res = runLive({ cacheDir, projectsDir, keys: ["OBA"], ledger });
  assert.deepEqual(res.written.sort(), ["OBA-1", "OBA-2"]);
  assert.equal(res.dropped, 1);
  assert.ok(existsSync(join(projectsDir, "OBA", "in-progress", "OBA-2-epic-a.md")));
  assert.equal(existsSync(join(projectsDir, "OBA", "in-progress", "OBA-3-dead.md")), false);
  const epic = readFileSync(join(projectsDir, "OBA", "in-progress", "OBA-2-epic-a.md"), "utf8");
  assert.match(epic, /id: OBA-2/);
  assert.match(epic, /parent: OBA-1/);
  rmSync(root, { recursive: true, force: true });
});

test("runLive is idempotent — a re-run does not duplicate files", () => {
  const { root, cacheDir, projectsDir, ledger } = seed();
  runLive({ cacheDir, projectsDir, keys: ["OBA"], ledger });
  const res2 = runLive({ cacheDir, projectsDir, keys: ["OBA"], ledger });
  assert.deepEqual(res2.written.sort(), ["OBA-1", "OBA-2"]);
  // exactly one file for OBA-2 across all status dirs
  let count = 0;
  for (const st of readdirSync(join(projectsDir, "OBA"))) {
    const dir = join(projectsDir, "OBA", st);
    try { for (const f of readdirSync(dir)) if (f.startsWith("OBA-2-")) count++; } catch {}
  }
  assert.equal(count, 1);
  rmSync(root, { recursive: true, force: true });
});
