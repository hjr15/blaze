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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { fsReadStorage, memReadStorage } from "../../scripts/model/read-storage.mjs";

function seedFs() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-readseam-"));
  const put = (status, name, body) => {
    mkdirSync(join(dir, "BLZ", status), { recursive: true });
    writeFileSync(join(dir, "BLZ", status, name), body);
  };
  const t = (id, extra = "", links = []) =>
    `---\nid: ${id}\ntitle: ${id} title\ntype: task\nproject: BLZ\nparent: ${extra}\n` +
    `links:\n${links.map((l) => `  - { type: ${l.type}, target: ${l.target} }`).join("\n") || "  []"}\n` +
    `---\n\nbody of ${id}\n`;
  put("defined", "BLZ-1-a.md", t("BLZ-1"));
  put("defined", "BLZ-2-b.md", t("BLZ-2", "BLZ-1", [{ type: "Blocks", target: "BLZ-1" }]));
  put("done", "BLZ-3-c.md", t("BLZ-3", "BLZ-1", [{ type: "Blocks", target: "BLZ-1" }]));
  // a Relates link to the same target must NOT be mistaken for a blocker
  put("defined", "BLZ-4-d.md", t("BLZ-4", "", [{ type: "Relates", target: "BLZ-1" }]));
  return dir;
}

// The in-memory driver is seeded with the same logical corpus, so both drivers are
// held to the same assertions rather than to two hand-written expectations.
function seedMem() {
  const rec = (id, status, parent, links = []) => ({
    frontmatter: { id, title: `${id} title`, type: "task", project: "BLZ", parent, links },
    body: `body of ${id}`, project: "BLZ", status, file: id,
  });
  return memReadStorage([
    rec("BLZ-1", "defined", ""),
    rec("BLZ-2", "defined", "BLZ-1", [{ type: "Blocks", target: "BLZ-1" }]),
    rec("BLZ-3", "done", "BLZ-1", [{ type: "Blocks", target: "BLZ-1" }]),
    rec("BLZ-4", "defined", "", [{ type: "Relates", target: "BLZ-1" }]),
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

  test(`${name}: records carry project and status FIRST-CLASS, not recoverable from file`, () => {
    // BLZ-271: move/reconcile used to recover both by path arithmetic on `file`,
    // which silently produced a bogus destination for any non-path handle. Both
    // drivers must supply them directly or the contract diverges.
    const { s, root } = make();
    const r = s.getTicket(root, "BLZ-3").found;
    assert.equal(r.project, "BLZ", "project must be on the record itself");
    assert.equal(r.status, "done", "status must be on the record itself");
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
    assert.deepEqual(s.listChildren(root, "BLZ-4"), []);
    assert.deepEqual(s.listChildren(root, "BLZ-2"), []);
  });

  test(`${name}: blockersOf returns only inbound Blocks links`, () => {
    const { s, root } = make();
    const ids = s.blockersOf(root, "BLZ-1").map((t) => t.frontmatter.id).sort();
    assert.deepEqual(ids, ["BLZ-2", "BLZ-3"], "BLZ-4 Relates, and must not count as a blocker");
  });

  test(`${name}: blockersOf carries status, so the caller can judge terminal-ness`, () => {
    const { s, root } = make();
    const byId = Object.fromEntries(s.blockersOf(root, "BLZ-1").map((t) => [t.frontmatter.id, t.status]));
    assert.deepEqual(byId, { "BLZ-2": "defined", "BLZ-3": "done" });
  });

  test(`${name}: blockersOf never returns the ticket itself`, () => {
    const { s, root } = make();
    assert.equal(s.blockersOf(root, "BLZ-1").some((t) => t.frontmatter.id === "BLZ-1"), false);
  });

  test(`${name}: blockersOf is empty for an id nothing blocks`, () => {
    const { s, root } = make();
    assert.deepEqual(s.blockersOf(root, "BLZ-3"), []);
    assert.deepEqual(s.blockersOf(root, "BLZ-999"), []);
  });

  test(`${name}: listTickets still yields everything, for the index and audit`, () => {
    const { s, root } = make();
    const ids = [...s.listTickets(root)].map((t) => t.frontmatter.id).sort();
    assert.deepEqual(ids, ["BLZ-1", "BLZ-2", "BLZ-3", "BLZ-4"]);
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

// --- BLZ-271: an opaque handle must fail loudly, not relocate silently ----------
import { ticketPath } from "../../scripts/model/storage.mjs";

test("BLZ-271: a non-fs handle now throws instead of producing a bogus destination", () => {
  // Before this fix, move.mjs computed join(dirname(dirname("BLZ-9")), "done") +
  // basename("BLZ-9") = "done/BLZ-9", wrote there, and returned ok:true.
  assert.throws(() => ticketPath.relocate("/p", "BLZ", "done", "BLZ-9"),
    /not a ticket path under/);
  // and the old arithmetic, shown for contrast, produced exactly that bogus path:
  const bogus = join(dirname(dirname("BLZ-9")), "done", "BLZ-9");
  assert.equal(bogus, join("done", "BLZ-9"), "the silent-corruption path this replaces");
});

test("BLZ-271: a real move still lands in the right directory with its filename intact", () => {
  const { projectsDir } = (() => {
    const root = mkdtempSync(join(tmpdir(), "blaze-reloc-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    writeFileSync(join(root, "blaze.config.json"),
      JSON.stringify({ projects: [{ key: "BLZ", name: "Blaze" }] }));
    const projects = join(root, "projects");
    mkdirSync(join(projects, "BLZ", "defined"), { recursive: true });
    // a filename whose slug deliberately does NOT match the title, as 60 live ones do
    writeFileSync(join(projects, "BLZ", "defined", "BLZ-1-stale-slug.md"),
      `---\nid: BLZ-1\ntitle: A Completely Different Title Now\ntype: task\nproject: BLZ\n` +
      `parent: \nassignee: unassigned\nestimate: 30\nworklog: []\nlinks: []\n` +
      `created: 2026-08-20\nupdated: 2026-08-20\n---\n\nbody\n`);
    return { projectsDir: projects };
  })();
  const r = applyMove(projectsDir, "BLZ-1", "in-progress", { today: "2026-08-20" });
  assert.equal(r.ok, true, r.errors?.join("; "));
  assert.match(r.file, /BLZ[/\\]in-progress[/\\]BLZ-1-stale-slug\.md$/,
    "the stale filename is preserved — recomputing it would rename 60 live tickets");
});

// --- changeToken: the fourth read entry point ----------------------------------
// contentHash (views/data.mjs) hashed path:size:mtimeMs across every directory to
// drive the board's 3-second auto-reload poll. It was the only read path that never
// went through walkTickets, and a database has no mtime to hash. Measured at 35.4 ms
// per poll per open tab.
//
// This is the one place the review panel's REJECTED "opaque staleness token" idea is
// correct: the poll genuinely wants "has anything changed?", not the tickets.
import { rmSync, utimesSync } from "node:fs";

for (const [name, make] of DRIVERS) {
  test(`${name}: changeToken is stable when nothing changes`, () => {
    const { s, root } = make();
    assert.equal(s.changeToken(root), s.changeToken(root));
  });

  test(`${name}: changeToken is opaque — a string the caller must not parse`, () => {
    const { s, root } = make();
    assert.equal(typeof s.changeToken(root), "string");
  });
}

test("fsReadStorage: changeToken changes when a ticket's content changes", () => {
  const dir = seedFs();
  const before = fsReadStorage.changeToken(dir);
  const f = join(dir, "BLZ", "defined", "BLZ-1-a.md");
  writeFileSync(f, readFileSync(f, "utf8") + "\nappended\n");
  assert.notEqual(fsReadStorage.changeToken(dir), before);
});

test("fsReadStorage: changeToken changes when a ticket is added", () => {
  const dir = seedFs();
  const before = fsReadStorage.changeToken(dir);
  writeFileSync(join(dir, "BLZ", "defined", "BLZ-9-new.md"),
    `---\nid: BLZ-9\ntitle: new\ntype: task\nproject: BLZ\nparent: \n---\n\nb\n`);
  assert.notEqual(fsReadStorage.changeToken(dir), before);
});

test("fsReadStorage: changeToken changes when a ticket is removed", () => {
  const dir = seedFs();
  const before = fsReadStorage.changeToken(dir);
  rmSync(join(dir, "BLZ", "defined", "BLZ-2-b.md"));
  assert.notEqual(fsReadStorage.changeToken(dir), before);
});

test("fsReadStorage: changeToken is project-scoped — another project's edit must not invalidate it", () => {
  const dir = seedFs();
  mkdirSync(join(dir, "OBA", "defined"), { recursive: true });
  writeFileSync(join(dir, "OBA", "defined", "OBA-1-x.md"),
    `---\nid: OBA-1\ntitle: x\ntype: task\nproject: OBA\nparent: \n---\n\nb\n`);
  const blzBefore = fsReadStorage.changeToken(dir, { project: "BLZ" });
  const allBefore = fsReadStorage.changeToken(dir);

  writeFileSync(join(dir, "OBA", "defined", "OBA-1-x.md"),
    `---\nid: OBA-1\ntitle: CHANGED\ntype: task\nproject: OBA\nparent: \n---\n\nb\n`);

  assert.equal(fsReadStorage.changeToken(dir, { project: "BLZ" }), blzBefore,
    "a BLZ-scoped poll must not fire on an OBA edit — that is why the scope exists");
  assert.notEqual(fsReadStorage.changeToken(dir), allBefore,
    "the unscoped token must still see it");
});

test("fsReadStorage: changeToken has a known blind spot — same size, same mtime", () => {
  // Documented rather than fixed: the fs token hashes path:size:mtimeMs, so an edit
  // that preserves BOTH is invisible. This is the PRE-EXISTING behaviour of
  // contentHash and is preserved deliberately — changing the hash would change what
  // the poll fires on, which is a different decision from moving it behind the seam.
  // A database driver has no such blind spot.
  const dir = seedFs();
  const f = join(dir, "BLZ", "defined", "BLZ-1-a.md");
  const original = readFileSync(f, "utf8");
  const edited = original.replace("body of BLZ-1", "body of BLZ-X"); // identical length
  assert.equal(edited.length, original.length, "the fixture must be a same-length edit");
  const pinned = new Date(1000000);

  utimesSync(f, pinned, pinned);
  const before = fsReadStorage.changeToken(dir);

  writeFileSync(f, edited);
  utimesSync(f, pinned, pinned);            // restore the mtime the write just bumped
  const after = fsReadStorage.changeToken(dir);

  assert.equal(readFileSync(f, "utf8"), edited, "the file really did change on disk");
  assert.equal(after, before, "same size + same mtime => the token cannot see the edit");
});
