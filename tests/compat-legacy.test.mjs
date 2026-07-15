// tests/compat-legacy.test.mjs — BLZ-100: backward-compat contract test.
//
// Pins a durable guarantee: an old-shape board (pre-metadata-gate — tickets
// carrying only id/title/type/project/priority/estimate, no components/labels/
// links) must still load, index, and dry-run reconcile cleanly on the CURRENT
// engine. If a future change makes any of those fields load-bearing for
// indexing/reconcile, this test fails loudly instead of silently breaking
// every board authored before that change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex } from "../scripts/model/index.mjs";
import { reconcile } from "../scripts/reconcile.mjs";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "legacy-board");

test("a legacy-format board loads + indexes on the current engine (no regression)", () => {
  const idx = buildIndex(join(FIXTURE, "projects"));
  assert.ok(idx.count() >= 2, "all legacy tickets indexed");
  assert.ok(idx.get("OBA-1"), "legacy ticket OBA-1 resolves");
  // old-shape tickets have no links; the linter must not choke on absent links:
  assert.deepEqual(idx.warnings ?? [], [], "no malformed-link warnings on a clean legacy board");
  // hierarchy still resolves on a legacy board (justifies the epic+child in the fixture):
  const child = idx.get("OBA-2"); // OBA-2 is the child; its parent is the legacy epic OBA-1
  assert.ok(child && child.parent, "a legacy child ticket keeps its parent link in the index");
  assert.equal(child.parent, "OBA-1");
});

test("a legacy-format board dry-run reconciles without throwing", () => {
  // Copy the fixture to a throwaway temp dir — reconcile() must never mutate
  // the committed fixture in place.
  const root = mkdtempSync(join(tmpdir(), "blaze-compat-legacy-"));
  cpSync(FIXTURE, root, { recursive: true });

  try {
    const r = reconcile({ root, dryRun: true });
    assert.equal(r.ok, true, "reconcile does not throw / reports ok on a legacy board");
    // No codeRepos configured on the fixture → no git signal for any ticket,
    // so every ticket is skipped and there is nothing to change.
    assert.deepEqual(r.changes, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
