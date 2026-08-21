// tests/db-runner.test.mjs — `blaze db` (BLZ-299).
//
// The counts in `db status` must agree with the counts in `db init`. They did not: the
// `acceptance_criterion` table holds BOTH criteria and notes, and status counted the
// whole table while calling it "criteria". On the live board that overstated it by
// 2,339 — and it reads as the shadow INVENTING rows, which is exactly the false alarm
// a soak must never raise. It briefly convinced me the database was corrupting data.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDb } from "../scripts/db-runner.mjs";

function board() {
  const dataRoot = mkdtempSync(join(tmpdir(), "blaze-db-"));
  const projectsDir = join(dataRoot, "projects");
  mkdirSync(join(projectsDir, "ENG", "defined"), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"),
    JSON.stringify({ projects: ["ENG"], schemaVersion: 2 }));
  writeFileSync(join(projectsDir, "ENG", "project.json"),
    JSON.stringify({ key: "ENG", components: [], labels: [] }));
  // One ticket with TWO criteria and ONE note — the shape that exposed the bug.
  writeFileSync(join(projectsDir, "ENG", "defined", "ENG-1-a.md"),
    ["---", "id: ENG-1", "title: A task", "type: task", "project: ENG",
     "priority: medium", "assignee: unassigned", "estimate: 30",
     "created: 2026-01-01", "updated: 2026-01-01", "links:", "---", "",
     "## Acceptance Criteria", "", "- [x] one", "- [ ] two",
     "", "Some prose that is a note, not a criterion.", ""].join("\n"));
  return { dataRoot, projectsDir };
}

const capture = () => {
  const out = [];
  const io = { log: (s) => out.push(String(s)), err: (s) => out.push(String(s)) };
  return { io, out, text: () => out.join("\n") };
};

describe("blaze db", () => {
  test("init loads the board and reports criteria separately from notes", async () => {
    const roots = board();
    const c = capture();
    assert.equal(0, await runDb(["init"], { ...c.io, roots }));
    assert.match(c.text(), /tickets\s+1/);
    assert.match(c.text(), /criteria\s+2/, "two checkboxes, not three rows");
  });

  test("status agrees with init — criteria are criteria, notes are notes", async () => {
    const roots = board();
    await runDb(["init"], { ...capture().io, roots });
    const c = capture();
    assert.equal(0, await runDb(["status"], { ...c.io, roots }));
    // The bug: `criteria 3`, counting the note as a criterion.
    assert.match(c.text(), /criteria\s+2/);
    assert.match(c.text(), /AC notes\s+1/);
  });

  test("status on a clean soak does not claim the soak never ran", async () => {
    // An absent log is what a CLEAN soak looks like — it is written only on divergence.
    const roots = board();
    await runDb(["init"], { ...capture().io, roots });
    const c = capture();
    await runDb(["status"], { ...c.io, roots });
    assert.match(c.text(), /none recorded/);
    assert.doesNotMatch(c.text(), /no soak has (written|run)/);
  });

  test("init refuses to replace an existing shadow without --force", async () => {
    const roots = board();
    await runDb(["init"], { ...capture().io, roots });
    const c = capture();
    assert.equal(1, await runDb(["init"], { ...c.io, roots }));
    assert.match(c.text(), /already exists/);
    assert.match(c.text(), /discards whatever the current shadow/);
    assert.equal(0, await runDb(["init", "--force"], { ...capture().io, roots }));
  });

  test("status before init says what to run, rather than failing", async () => {
    const c = capture();
    assert.equal(0, await runDb(["status"], { ...c.io, roots: board() }));
    assert.match(c.text(), /blaze db init/);
  });

  test("an unknown subcommand is refused with the usage", async () => {
    const c = capture();
    assert.equal(1, await runDb(["frobnicate"], { ...c.io, roots: board() }));
    assert.match(c.text(), /unknown command "frobnicate"/);
    assert.match(c.text(), /usage: blaze db/);
  });
});
