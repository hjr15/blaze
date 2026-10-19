// tests/reindex-unclaimed-id.test.mjs — BLZ-687 (BLZ-254 PR D, spec §3 and §5.5).
//
// `missingClaimErrors` (BLZ-136) made `blaze reindex` refuse an id above a project's `.cutover`
// that had no `.ids/` claim. Spec §5.5 deletes it: under D1 an fs board is single-machine, so
// there is no second writer whose claim could be missing, and in db mode the check was already
// skipped. A duplicate id still refuses — that is `buildIndex`'s own error, not the claim check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const reindex = join(REPO, "scripts", "reindex.mjs");

function board(tickets) {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz687-reindex-")));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "PROJ", projects: ["PROJ"] }));
  mkdirSync(join(root, "projects", "PROJ", "defined"), { recursive: true });
  mkdirSync(join(root, "projects", "PROJ", ".ids"), { recursive: true });
  writeFileSync(join(root, "projects", "PROJ", ".ids", ".cutover"), "5\n");   // the ledger has allocated
  for (const [file, id] of tickets) {
    writeFileSync(join(root, "projects", "PROJ", "defined", file),
      `---\nid: ${id}\ntitle: t\ntype: task\nproject: PROJ\nestimate: 30\n---\n\nbody\n`);
  }
  return root;
}
const run = (root) => {
  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") };
  delete env.BLAZE_WRITE_PORT; delete env.BLAZE_READONLY;
  return spawnSync(process.execPath, [reindex], { cwd: root, env, encoding: "utf8" });
};

test("an id above the cutover with no claim no longer blocks reindex", () => {
  const root = board([["PROJ-6-x.md", "PROJ-6"]]);
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /no claim|unclaimed/);
  assert.ok(existsSync(join(root, ".blaze", "index.json")), "the index is written");
});

test("a duplicate id still blocks reindex", () => {
  const root = board([["PROJ-1-a.md", "PROJ-1"], ["PROJ-1-b.md", "PROJ-1"]]);
  const r = run(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /duplicate ticket id/);
  assert.equal(existsSync(join(root, ".blaze", "index.json")), false);
});
