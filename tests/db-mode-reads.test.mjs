// tests/db-mode-reads.test.mjs — BLZ-670.
//
// THE SPLIT BRAIN, END TO END. Under BLAZE_WRITE_PORT=db every write went to the database and
// every read came from the files. The real runners run as subprocesses, so nothing between
// them can be mocked away. Each test is `todo` until the task that fixes it removes the marker.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runDb } from "../scripts/db-runner.mjs";
import { dbBoard, runner, QUIET } from "./helpers/db-board.mjs";

async function initialised() {
  const roots = dbBoard();
  assert.equal(0, await runDb(["init"], { ...QUIET, roots }));
  return roots;
}
const ok = (r) => assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);

describe("BLAZE_WRITE_PORT=db: every read comes from the database", () => {
  test("a second move sees the first", { todo: "BLZ-670 Task 6" }, async () => {
    const roots = await initialised();
    ok(runner("move-runner.mjs", ["ENG-1", "in-progress"], roots));
    ok(runner("move-runner.mjs", ["ENG-1", "in-review"], roots));
    assert.ok(existsSync(join(roots.projectsDir, "ENG", "defined", "ENG-1-a.md")),
      "the file never moves: the database is the store");
  });

  test("reindex writes the database's statuses", { todo: "BLZ-670 Task 8" }, async () => {
    const roots = await initialised();
    ok(runner("move-runner.mjs", ["ENG-1", "in-progress"], roots));
    ok(runner("reindex.mjs", [], roots));
    const idx = JSON.parse(readFileSync(join(roots.dataRoot, ".blaze", "index.json"), "utf8"));
    assert.equal(idx.tickets.find((t) => t.id === "ENG-1").status, "in-progress");
  });

  test("audit, rollup, export and schedule see a ticket that exists only in the db", { todo: "BLZ-670 Task 8" }, async () => {
    const roots = await initialised();
    ok(runner("new-runner.mjs", ["--project", "ENG", "--type", "task", "--estimate", "15", "Only in the db"], roots));
    const audit = runner("audit-runner.mjs", ["--json"], roots);
    assert.match(audit.stdout, /ENG-2/, "audit");
    const roll = runner("rollup-runner.mjs", ["ENG-2"], roots);
    ok(roll); assert.match(roll.stdout, /ENG-2/, "rollup");
    const exp = runner("export-runner.mjs", ["--format", "csv"], roots);
    ok(exp); assert.match(exp.stdout, /Only in the db/, "export");
    const sch = runner("schedule-runner.mjs", ["migrate-dates"], roots);
    ok(sch); assert.match(sch.stdout, /\b2 tickets\b/, "schedule sees both tickets");
  });

  test("schedule migrate-dates --write refuses in db mode", { todo: "BLZ-670 Task 8" }, async () => {
    const roots = await initialised();
    const r = runner("schedule-runner.mjs", ["migrate-dates", "--write"], roots);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BLAZE_WRITE_PORT=db/);
  });
});
