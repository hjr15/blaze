// tests/db-mode-reads.test.mjs — BLZ-670.
//
// THE SPLIT BRAIN, END TO END. Under BLAZE_WRITE_PORT=db every write went to the database and
// every read came from the files. The real runners run as subprocesses, so nothing between
// them can be mocked away. Each test is `todo` until the task that fixes it removes the marker.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runDb } from "../scripts/db-runner.mjs";
import { dbBoard, runner, QUIET } from "./helpers/db-board.mjs";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { writeCsv } from "../scripts/model/csv.mjs";
import { RECEIPT_DIR } from "../scripts/model/import-apply.mjs";

async function initialised() {
  const roots = dbBoard();
  assert.equal(0, await runDb(["init"], { ...QUIET, roots }));
  return roots;
}
const ok = (r) => assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);

describe("BLAZE_WRITE_PORT=db: every read comes from the database", () => {
  test("a second move sees the first", async () => {
    const roots = await initialised();
    ok(runner("move-runner.mjs", ["ENG-1", "in-progress"], roots));
    ok(runner("move-runner.mjs", ["ENG-1", "in-review"], roots));
    assert.ok(existsSync(join(roots.projectsDir, "ENG", "defined", "ENG-1-a.md")),
      "the file never moves: the database is the store");
  });

  // stageFor's POSITIVE half: in db mode the tickets are rows, but the import's own record
  // files (the receipt) are real files and must still be committed.
  test("import --apply writes through the db, commits its receipt, and a move can read the row", async () => {
    const roots = dbBoard();
    const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a],
      { cwd: roots.dataRoot, encoding: "utf8" });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    assert.equal(0, await runDb(["init"], { ...QUIET, roots }));
    const csv = join(roots.dataRoot, "in.csv");
    // `created` and `updated` are filled: a blank `created` is a separate bind bug (BLZ-672).
    const row = { schema_version: "1", id: "ENG-2", project: "ENG", type: "task", status: "defined",
      title: "Imported", description: "body", estimate: "30",
      created: "2026-01-02", updated: "2026-01-02" };
    writeFileSync(csv, writeCsv([COLUMN_NAMES.slice(), COLUMN_NAMES.map((n) => row[n] ?? "")]));
    const imp = runner("import-runner.mjs", ["--apply", csv], roots,
      { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
    ok(imp);
    const committed = git("log", "-1", "--name-only", "--format=");
    assert.match(committed, new RegExp(`^${RECEIPT_DIR}/\\S+\\.jsonl$`, "m"),
      `the receipt is committed:\n${committed}`);
    ok(runner("move-runner.mjs", ["ENG-2", "in-progress"], roots));
  });

  test("reindex writes the database's statuses", async () => {
    const roots = await initialised();
    ok(runner("move-runner.mjs", ["ENG-1", "in-progress"], roots));
    ok(runner("reindex.mjs", [], roots));
    const idx = JSON.parse(readFileSync(join(roots.dataRoot, ".blaze", "index.json"), "utf8"));
    assert.equal(idx.tickets.find((t) => t.id === "ENG-1").status, "in-progress");
  });

  test("audit, rollup, export and schedule see a ticket that exists only in the db", async () => {
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

  test("schedule migrate-dates --write refuses in db mode", async () => {
    const roots = await initialised();
    const r = runner("schedule-runner.mjs", ["migrate-dates", "--write"], roots);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BLAZE_WRITE_PORT=db/);
  });
});
