// tests/model/read-seam.test.mjs — the query-shaped read seam (BLZ-270, ADR-0009).
//
// ADR-0009 makes the driver answer NAMED questions instead of yielding the whole
// corpus. These tests pin the contract for both drivers at once, because the
// design's parity rule is per-operation: one named operation, one parity test.
//
// The behaviour under the tightest constraint is `getTicket`. BLZ-122 requires it to
// refuse rather than guess when an id resolves to two files, and index.mjs documents
// why an early return is "precisely the bug". A query-shaped seam must not quietly
// turn that into a first-hit lookup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fsReadStorage, memReadStorage } from "../../scripts/model/read-storage.mjs";

function seedFs() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-readseam-"));
  const put = (status, name, body) => {
    mkdirSync(join(dir, "BLZ", status), { recursive: true });
    writeFileSync(join(dir, "BLZ", status, name), body);
  };
  const t = (id, extra = "") =>
    `---\nid: ${id}\ntitle: ${id} title\ntype: task\nproject: BLZ\nparent: ${extra}\n---\n\nbody of ${id}\n`;
  put("defined", "BLZ-1-a.md", t("BLZ-1"));
  put("defined", "BLZ-2-b.md", t("BLZ-2", "BLZ-1"));
  put("done", "BLZ-3-c.md", t("BLZ-3", "BLZ-1"));
  return dir;
}

// The in-memory driver is seeded with the same logical corpus, so both drivers are
// held to the same assertions rather than to two hand-written expectations.
function seedMem() {
  const rec = (id, status, parent) => ({
    frontmatter: { id, title: `${id} title`, type: "task", project: "BLZ", parent },
    body: `body of ${id}`, status, file: id,
  });
  return memReadStorage([
    rec("BLZ-1", "defined", ""),
    rec("BLZ-2", "defined", "BLZ-1"),
    rec("BLZ-3", "done", "BLZ-1"),
  ]);
}

const DRIVERS = [
  ["fsReadStorage", () => ({ s: fsReadStorage, root: seedFs() })],
  ["memReadStorage", () => ({ s: seedMem(), root: null })],
];

for (const [name, make] of DRIVERS) {
  test(`${name}: getTicket resolves a ticket by id`, () => {
    const { s, root } = make();
    const r = s.getTicket(root, "BLZ-2");
    assert.equal(r.found?.frontmatter.id, "BLZ-2");
    assert.equal(r.found.status, "defined");
    assert.equal(r.duplicates, undefined);
  });

  test(`${name}: getTicket finds a ticket in any status directory`, () => {
    const { s, root } = make();
    assert.equal(s.getTicket(root, "BLZ-3").found?.status, "done");
  });

  test(`${name}: getTicket returns found:null for an unknown id, and does not throw`, () => {
    const { s, root } = make();
    assert.deepEqual(s.getTicket(root, "BLZ-999"), { found: null });
  });

  test(`${name}: getTicket carries the body, so a caller need not re-read`, () => {
    const { s, root } = make();
    assert.match(s.getTicket(root, "BLZ-1").found.body, /body of BLZ-1/);
  });

  test(`${name}: listChildren answers the drill without materialising the corpus`, () => {
    const { s, root } = make();
    const kids = s.listChildren(root, "BLZ-1").map((t) => t.frontmatter.id).sort();
    assert.deepEqual(kids, ["BLZ-2", "BLZ-3"]);
    assert.deepEqual(s.listChildren(root, "BLZ-2"), []);
  });

  test(`${name}: listTickets still yields everything, for the index and audit`, () => {
    const { s, root } = make();
    const ids = [...s.listTickets(root)].map((t) => t.frontmatter.id).sort();
    assert.deepEqual(ids, ["BLZ-1", "BLZ-2", "BLZ-3"]);
  });
}

// --- BLZ-122: the constraint a query shape must not quietly relax ---------------
test("fsReadStorage: getTicket REFUSES when an id resolves to two files", () => {
  const dir = seedFs();
  // the same id in two status directories — the BLZ-122 shape
  mkdirSync(join(dir, "BLZ", "in-progress"), { recursive: true });
  writeFileSync(join(dir, "BLZ", "in-progress", "BLZ-1-a.md"),
    `---\nid: BLZ-1\ntitle: BLZ-1 title\ntype: task\nproject: BLZ\nparent: \n---\n\ndupe\n`);

  const r = fsReadStorage.getTicket(dir, "BLZ-1");
  assert.equal(r.found, null, "must refuse, never pick one");
  assert.equal(r.duplicates.length, 2, "must hand back BOTH paths");
  assert.deepEqual(r.duplicates, [...r.duplicates].sort(), "paths are sorted, so the message is stable");
});

test("fsReadStorage: getTicket scans the WHOLE corpus — an early return is the bug", () => {
  const dir = seedFs();
  // Duplicate lands in a directory the walk reaches AFTER the first hit. A
  // first-hit implementation returns BLZ-1 happily and never sees the ambiguity.
  mkdirSync(join(dir, "BLZ", "zz-last"), { recursive: true });
  writeFileSync(join(dir, "BLZ", "zz-last", "BLZ-1-dupe.md"),
    `---\nid: BLZ-1\ntitle: BLZ-1 title\ntype: task\nproject: BLZ\nparent: \n---\n\nlate dupe\n`);

  const r = fsReadStorage.getTicket(dir, "BLZ-1");
  assert.equal(r.found, null, "a late duplicate must still be detected");
  assert.equal(r.duplicates.length, 2);
});

test("memReadStorage: a driver where ids are unique cannot produce duplicates", () => {
  // On a database, id is the primary key — the ambiguity is structurally impossible,
  // not merely absent. The contract still has to expose the same shape.
  const s = seedMem();
  const r = s.getTicket(null, "BLZ-1");
  assert.equal(r.found?.frontmatter.id, "BLZ-1");
  assert.equal(r.duplicates, undefined);
});

// --- the guard that was never tested -------------------------------------------
// index.mjs calls locateTicket's refusal "the guard that stops a write landing on a
// guess". Before BLZ-270 it had NO test: `tests/index-duplicate-id.test.mjs` covers
// BLZ-134 (buildIndex REPORTING duplicates, the detector), and `ambiguousIdError`
// appeared in six source files and zero test files. A first-hit refactor would have
// silently reintroduced BLZ-122 — a bug that has actually occurred on this board.
import { applyMove } from "../../scripts/move.mjs";
import { applyLog } from "../../scripts/log.mjs";
import { applyResolve } from "../../scripts/resolve.mjs";
import { execFileSync } from "node:child_process";

function boardWithDuplicate() {
  const root = mkdtempSync(join(tmpdir(), "blaze-dupe-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ projects: [{ key: "BLZ", name: "Blaze" }] }));
  const projects = join(root, "projects");
  const t = (id) => `---\nid: ${id}\ntitle: ${id} title\ntype: task\nproject: BLZ\n` +
    `parent: \nassignee: unassigned\nestimate: 30\nworklog: []\nlinks: []\n` +
    `created: 2026-08-20\nupdated: 2026-08-20\n---\n\nbody\n`;
  for (const status of ["defined", "in-progress"]) {
    mkdirSync(join(projects, "BLZ", status), { recursive: true });
    writeFileSync(join(projects, "BLZ", status, "BLZ-1-a.md"), t("BLZ-1"));
  }
  return projects;
}

for (const [verb, run] of [
  ["applyMove", (p) => applyMove(p, "BLZ-1", "in-review", { today: "2026-08-20" })],
  ["applyLog", (p) => applyLog(p, "BLZ-1", 30, { today: "2026-08-20" })],
  ["applyResolve", (p) => applyResolve(p, "BLZ-1", "done", { today: "2026-08-20" })],
]) {
  test(`${verb} REFUSES a duplicated id rather than writing to a guess`, () => {
    const r = run(boardWithDuplicate());
    assert.equal(r.ok, false, `${verb} must refuse when an id resolves to two files`);
    const msg = r.errors.join("\n");
    assert.match(msg, /resolves to 2 files/);
    assert.match(msg, /refusing to guess/);
    assert.match(msg, /BLZ-1-a\.md/, "the refusal names the conflicting paths");
  });
}
