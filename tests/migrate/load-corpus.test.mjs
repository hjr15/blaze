// tests/migrate/load-corpus.test.mjs — BLZ-280.
//
// The loader is a migration harness: it moves the corpus once and proves by counting
// that nothing was lost. These tests pin the counting, because a loader you cannot
// audit is worse than no loader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteRead } from "../../scripts/model/sqlite-storage.mjs";
import { loadCorpus } from "../../scripts/migrate/load-corpus.mjs";
import { fsReadStorage } from "../../scripts/model/read-storage.mjs";

function board(tickets) {
  const dir = mkdtempSync(join(tmpdir(), "blaze-load-"));
  for (const t of tickets) {
    mkdirSync(join(dir, t.project, t.status), { recursive: true });
    writeFileSync(join(dir, t.project, t.status, `${t.id}-x.md`), t.text);
  }
  return dir;
}
const doc = (fm, body = "body") =>
  ["---", ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), "---", "", body, ""].join("\n");

test("a clean corpus loads every ticket with nothing skipped", () => {
  const dir = board([
    { project: "BLZ", status: "defined", id: "BLZ-1",
      text: doc({ id: "BLZ-1", title: "One", type: "task", project: "BLZ", parent: "" }) },
    { project: "BLZ", status: "done", id: "BLZ-2",
      text: doc({ id: "BLZ-2", title: "Two", type: "task", project: "BLZ", parent: "BLZ-1" }) },
  ]);
  const s = openSqliteRead(":memory:", { create: true });
  const r = loadCorpus(s.db, dir);
  assert.equal(r.tickets, 2);
  assert.deepEqual(r.skipped, { noId: 0, badId: 0, insertFailed: [] });
  assert.equal(s.getTicket(null, "BLZ-2").found.frontmatter.parent, "BLZ-1",
    "the parent resolves — pass two runs after every ticket exists");
});

test("both drivers then answer the named operations identically", () => {
  const dir = board([
    { project: "BLZ", status: "defined", id: "BLZ-1",
      text: doc({ id: "BLZ-1", title: "One", type: "task", project: "BLZ", parent: "" }) },
    { project: "BLZ", status: "defined", id: "BLZ-2",
      text: doc({ id: "BLZ-2", title: "Two", type: "task", project: "BLZ", parent: "BLZ-1" }) },
  ]);
  const s = openSqliteRead(":memory:", { create: true });
  loadCorpus(s.db, dir);
  assert.deepEqual(
    s.listChildren(null, "BLZ-1").map((t) => t.frontmatter.id),
    fsReadStorage.listChildren(dir, "BLZ-1").map((t) => t.frontmatter.id));
  assert.equal(s.getTicket(null, "BLZ-1").found.frontmatter.title,
               fsReadStorage.getTicket(dir, "BLZ-1").found.frontmatter.title);
});

test("a dangling parent is COUNTED, never invented", () => {
  const dir = board([{ project: "BLZ", status: "defined", id: "BLZ-1",
    text: doc({ id: "BLZ-1", title: "One", type: "task", project: "BLZ", parent: "BLZ-999" }) }]);
  const s = openSqliteRead(":memory:", { create: true });
  const r = loadCorpus(s.db, dir);
  assert.equal(r.tickets, 1);
  assert.equal(r.danglingParents, 1);
  assert.equal(s.getTicket(null, "BLZ-1").found.frontmatter.parent, "",
    "the ticket loads with NO parent rather than a fabricated one");
});

test("a dangling link is counted and dropped, not forged", () => {
  const dir = board([{ project: "BLZ", status: "defined", id: "BLZ-1",
    text: ["---", "id: BLZ-1", "title: One", "type: task", "project: BLZ", "parent: ",
           "links:", "  - { type: Blocks, target: BLZ-999 }", "---", "", "b", ""].join("\n") }]);
  const s = openSqliteRead(":memory:", { create: true });
  const r = loadCorpus(s.db, dir);
  assert.equal(r.danglingLinks, 1);
  assert.equal(r.links, 0);
});

test("a ticket with no id is skipped and counted rather than crashing the load", () => {
  const dir = board([
    { project: "BLZ", status: "defined", id: "BLZ-1",
      text: doc({ id: "BLZ-1", title: "One", type: "task", project: "BLZ", parent: "" }) },
    { project: "BLZ", status: "defined", id: "BLZ-2", text: doc({ title: "No id", type: "task" }) },
  ]);
  const s = openSqliteRead(":memory:", { create: true });
  const r = loadCorpus(s.db, dir);
  assert.equal(r.tickets, 1);
  assert.equal(r.skipped.noId, 1, "one problem must not hide the other 2,500 tickets");
});

test("a missing title falls back to the id and is COUNTED — substituting is inventing", () => {
  // The DDL refuses a blank title, so the loader must supply something or lose the
  // ticket. Losing it would be worse. But substituting the id IS fabricating data, so
  // the tally reports it rather than claiming a clean load.
  const dir = board([{ project: "BLZ", status: "defined", id: "BLZ-1",
    text: doc({ id: "BLZ-1", title: "", type: "task", project: "BLZ", parent: "" }) }]);
  const s = openSqliteRead(":memory:", { create: true });
  const r = loadCorpus(s.db, dir);
  assert.equal(r.tickets, 1, "the ticket is not lost");
  assert.equal(r.titleFallbacks, 1, "and the substitution is visible in the tally");
  assert.equal(s.getTicket(null, "BLZ-1").found.frontmatter.title, "BLZ-1");
});

test("a row the DATABASE refuses is named, so the tally can be trusted", () => {
  const dir = board([{ project: "BLZ", status: "defined", id: "bad-1",
    text: doc({ id: "bad-1", title: "Lowercase key", type: "task", project: "bad", parent: "" }) }]);
  const s = openSqliteRead(":memory:", { create: true });
  const r = loadCorpus(s.db, dir);
  assert.equal(r.tickets, 0);
  assert.equal(r.skipped.insertFailed.length, 1);
  assert.equal(r.skipped.insertFailed[0].id, "bad-1");
  assert.match(r.skipped.insertFailed[0].reason, /CHECK|constraint/i);
});

test("acceptance criteria load as ordered blocks, notes included", () => {
  const dir = board([{ project: "BLZ", status: "defined", id: "BLZ-1",
    text: ["---", "id: BLZ-1", "title: One", "type: task", "project: BLZ", "parent: ", "---", "",
           "## Acceptance criteria", "prose first", "- [x] done", "- [ ] todo", ""].join("\n") }]);
  const s = openSqliteRead(":memory:", { create: true });
  const r = loadCorpus(s.db, dir);
  assert.equal(r.criteria, 2);
  assert.equal(r.notes, 1);
  const rows = s.db.prepare("SELECT ord,kind,checked FROM acceptance_criterion ORDER BY ord")
    .all().map((r) => ({ ord: r.ord, kind: r.kind, checked: r.checked }));
  assert.deepEqual(rows, [
    { ord: 0, kind: "note", checked: 0 },
    { ord: 1, kind: "criterion", checked: 1 },
    { ord: 2, kind: "criterion", checked: 0 },
  ]);
  assert.equal(s.db.prepare("SELECT ac_heading h FROM ticket").get().h, "## Acceptance criteria",
    "the lower-case spelling is preserved verbatim, not normalised away");
});

test("an unparseable estimate becomes NULL rather than rejecting the ticket", () => {
  // 242 live tickets have no estimate, and NOT NULL would mean fabricating 212
  // historical values into every burn-down.
  const dir = board([{ project: "BLZ", status: "defined", id: "BLZ-1",
    text: doc({ id: "BLZ-1", title: "One", type: "task", project: "BLZ", parent: "", estimate: "" }) }]);
  const s = openSqliteRead(":memory:", { create: true });
  assert.equal(loadCorpus(s.db, dir).tickets, 1);
  assert.equal(s.db.prepare("SELECT estimate_minutes e FROM ticket").get().e, null);
});

test("a malformed date falls back rather than aborting the load", () => {
  const dir = board([{ project: "BLZ", status: "defined", id: "BLZ-1",
    text: doc({ id: "BLZ-1", title: "One", type: "task", project: "BLZ", parent: "",
                created: "not-a-date", updated: "2026-13-45" }) }]);
  const s = openSqliteRead(":memory:", { create: true });
  assert.equal(loadCorpus(s.db, dir, { today: "2026-08-20" }).tickets, 1);
  assert.equal(s.db.prepare("SELECT created_on c FROM ticket").get().c, "2026-08-20");
});
