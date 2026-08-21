// tests/verbs-dual-write.test.mjs — BLZ-294.
//
// The verbs now write through the port (BLZ-293). This asserts the thing that makes
// the eventual cutover safe: run REAL verbs — not the port directly — against a board
// with a database shadow attached, and the two must agree on every operation.
//
// Running the verbs rather than the port matters. The port was already proven in
// isolation; what was not proven is that the verbs hand it a complete and correct
// ticket. A verb that quietly drops `worklog`, or passes the pre-edit frontmatter,
// produces a filesystem write that is right and a database write that is wrong — and
// only a comparison made through the verb can see it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_DDL, SQLITE_PRAGMAS } from "../scripts/model/sqlite-schema.mjs";
import { fsWritePort, dbWritePort, dualWritePort } from "../scripts/model/write-port.mjs";
import { applyEdit, applyToggleAc } from "../scripts/edit.mjs";
import { applyMove } from "../scripts/move.mjs";
import { applyLog } from "../scripts/log.mjs";
import { applyLink } from "../scripts/link.mjs";
import { applyResolve } from "../scripts/resolve.mjs";

const TICKETS = [
  { id: "OBA-1", num: 1, status: "defined", type: "task", title: "First task" },
  { id: "OBA-2", num: 2, status: "defined", type: "task", title: "Second task" },
  { id: "OBA-3", num: 3, status: "in-progress", type: "task", title: "Third task" },
];

function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-soak-"));
  const projects = join(root, "projects");
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"] }));
  for (const t of TICKETS) {
    const dir = join(projects, "OBA", t.status);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${t.id}.md`),
      ["---", `id: ${t.id}`, `title: ${t.title}`, `type: ${t.type}`, "project: OBA",
       "priority: medium", "resolution: ", "parent: ", "assignee: unassigned",
       "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "links:",
       "---", "", "## Acceptance Criteria", "", "- [ ] one", "- [ ] two", ""].join("\n"));
  }
  mkdirSync(join(projects, "OBA", "in-review"), { recursive: true });
  mkdirSync(join(projects, "OBA", "done"), { recursive: true });
  writeFileSync(join(projects, "OBA", "project.json"),
    JSON.stringify({ key: "OBA", name: "OBA", components: [], labels: [] }));

  // Seed the shadow with the same corpus the filesystem holds.
  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_PRAGMAS); db.exec(SQLITE_DDL);
  const exec = {
    run(sql, p) { return /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) ? db.exec(sql) : db.prepare(sql).run(...p); },
    all(sql, p) { return db.prepare(sql).all(...p); },
  };
  for (const t of TICKETS) {
    db.prepare(`INSERT INTO ticket (id,project_key,num,type,status,title,priority,assignee,
                                    estimate_minutes,body,created_on,updated_on)
                VALUES (?,'OBA',?,?,?,?,'medium','unassigned',30,?,'2026-01-01','2026-01-01')`)
      .run(t.id, t.num, t.type, t.status, t.title,
           "\n## Acceptance Criteria\n\n- [ ] one\n- [ ] two\n");
  }
  const port = dualWritePort(fsWritePort(projects), dbWritePort(exec), { strict: true });
  return { root, projects, port, db };
}

describe("the verbs write through the port, and fs and the database agree", () => {
  test("applyEdit — a field change lands identically on both sides", async () => {
    const { projects, port } = board();
    const r = await applyEdit(projects, "OBA-1", { priority: "high" },
                              { today: "2026-08-21", writePort: port });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(port.divergences, []);
  });

  test("applyLog — a worklog entry does not diverge", async () => {
    const { projects, port } = board();
    const r = await applyLog(projects, "OBA-1", 30, { today: "2026-08-21", writePort: port });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(port.divergences, []);
  });

  test("applyLink — links agree as a set, whatever order each side returns them in", async () => {
    const { projects, port } = board();
    const r = await applyLink(projects, "OBA-1", { type: "Blocks", target: "OBA-2" },
                              { today: "2026-08-21", writePort: port });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(port.divergences, []);
  });

  test("applyMove — a status change agrees, though only one side has a path", async () => {
    const { projects, port } = board();
    const r = await applyMove(projects, "OBA-1", "in-progress",
                              { today: "2026-08-21", writePort: port });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(port.divergences, []);
    assert.match(r.file, /in-progress/, "the filesystem side still relocates");
  });

  test("applyResolve — a resolution agrees", async () => {
    const { projects, port } = board();
    const r = await applyResolve(projects, "OBA-3", "wont-do",
                                 { today: "2026-08-21", writePort: port });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(port.divergences, []);
  });

  test("applyToggleAc — a body-only edit agrees", async () => {
    const { projects, port } = board();
    const r = await applyToggleAc(projects, "OBA-1", { index: 0, checked: true },
                                  { today: "2026-08-21", writePort: port });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(port.divergences, []);
  });

  test("a SEQUENCE of verbs on one ticket stays in agreement throughout", async () => {
    // The single-operation tests each start from a clean board. This one does not:
    // divergence that only appears after a ticket has been edited, moved and logged
    // against is exactly what a one-shot check cannot see.
    const { projects, port } = board();
    const opts = { today: "2026-08-21", writePort: port };
    assert.equal((await applyEdit(projects, "OBA-1", { priority: "high" }, opts)).ok, true);
    assert.equal((await applyLog(projects, "OBA-1", 45, opts)).ok, true);
    assert.equal((await applyLink(projects, "OBA-1", { type: "Relates", target: "OBA-2" }, opts)).ok, true);
    assert.equal((await applyMove(projects, "OBA-1", "in-progress", opts)).ok, true);
    assert.equal((await applyMove(projects, "OBA-1", "in-review", opts)).ok, true);
    assert.equal((await applyToggleAc(projects, "OBA-1", { index: 1, checked: true }, opts)).ok, true);
    assert.deepEqual(port.divergences, [], "no divergence anywhere in the sequence");
  });

  test("the soak CATCHES a verb that hands the port stale frontmatter", async () => {
    // Proof the sequence above is not vacuous. A shadow that persists the ticket
    // WITHOUT the verb's change is precisely the bug class this exists to detect:
    // the filesystem write is right, the database write is wrong, and only a
    // comparison through the verb sees it.
    const { projects } = board();
    const { db } = board();
    const exec = {
      run(sql, p) { return /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) ? db.exec(sql) : db.prepare(sql).run(...p); },
      all(sql, p) { return db.prepare(sql).all(...p); },
    };
    const shadow = dbWritePort(exec);
    const stale = { ...shadow,
      write: (t) => shadow.write({ ...t, frontmatter: { ...t.frontmatter, priority: "medium" } }) };
    const port = dualWritePort(fsWritePort(projects), stale);
    await applyEdit(projects, "OBA-1", { priority: "high" }, { today: "2026-08-21", writePort: port });
    assert.equal(port.divergences.length, 1, "a dropped edit must be reported");
    assert.deepEqual(port.divergences[0].fields,
      [{ field: "frontmatter.priority", primary: "high", shadow: "medium" }]);
  });
});
