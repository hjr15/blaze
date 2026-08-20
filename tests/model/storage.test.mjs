// tests/model/storage.test.mjs — the storage seam (BLZ-267, Blaze v3 Phase 1).
//
// The seam sits immediately downstream of serializeTicket(): every mutating verb
// hands finished text to a driver instead of calling node:fs itself. These tests
// pin the contract BEFORE any verb is rewired, so the fs driver and a future
// SQLite driver are held to the same shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { slugify, ticketPath, fsStorage, memStorage } from "../../scripts/model/storage.mjs";

const root = () => mkdtempSync(join(tmpdir(), "blaze-storage-"));

test("slugify matches the shape the corpus already uses", () => {
  assert.equal(slugify("Top-level schema.types override ignored"), "top-level-schema-types-override-ignored");
  assert.equal(slugify("  Leading and trailing  "), "leading-and-trailing");
  assert.equal(slugify("Ünïcødé & symbols!!"), "n-c-d-symbols");
  assert.equal(slugify(""), "");
  assert.equal(slugify(123), "123", "non-string input is coerced, not thrown on");
});

test("ticketPath is the single authority for where a ticket lives", () => {
  assert.equal(
    ticketPath("/data/projects", "BLZ", "defined", "BLZ-9", "A Title"),
    join("/data/projects", "BLZ", "defined", "BLZ-9-a-title.md"),
  );
});

test("ticketPath separates the directory from the file so a move can reuse it", () => {
  const { dir, file } = ticketPath.parts("/data/projects", "OBA", "done", "OBA-1", "X");
  assert.equal(dir, join("/data/projects", "OBA", "done"));
  assert.equal(file, join(dir, "OBA-1-x.md"));
});

// --- driver contract: both drivers must satisfy it identically ----------------
for (const [name, make] of [
  ["fsStorage", () => ({ s: fsStorage, base: root() })],
  ["memStorage", () => ({ s: memStorage(), base: "/virtual" })],
]) {
  test(`${name}: write then read round-trips exactly`, () => {
    const { s, base } = make();
    const f = join(base, "a", "BLZ-1-x.md");
    s.write(f, "hello\nworld\n");
    assert.equal(s.read(f), "hello\nworld\n");
    assert.equal(s.exists(f), true);
  });

  test(`${name}: exists is false before a write`, () => {
    const { s, base } = make();
    assert.equal(s.exists(join(base, "nope.md")), false);
  });

  test(`${name}: write creates missing parent directories`, () => {
    const { s, base } = make();
    const f = join(base, "deep", "nested", "BLZ-2-y.md");
    s.write(f, "body");
    assert.equal(s.read(f), "body");
  });

  test(`${name}: move relocates content and leaves nothing behind`, () => {
    const { s, base } = make();
    const from = join(base, "defined", "BLZ-3-z.md");
    const to = join(base, "done", "BLZ-3-z.md");
    s.write(from, "v1");
    s.move(from, to, "v2");
    assert.equal(s.exists(from), false, "source must not survive a move");
    assert.equal(s.read(to), "v2", "move writes the NEW text, not the old");
  });

  test(`${name}: move to the same path is a plain in-place write`, () => {
    const { s, base } = make();
    const f = join(base, "defined", "BLZ-4-w.md");
    s.write(f, "v1");
    s.move(f, f, "v2");
    assert.equal(s.exists(f), true);
    assert.equal(s.read(f), "v2");
  });

  test(`${name}: reading a missing file throws rather than returning undefined`, () => {
    const { s, base } = make();
    assert.throws(() => s.read(join(base, "absent.md")));
  });
}

test("memStorage instances are isolated from each other", () => {
  const a = memStorage(), b = memStorage();
  a.write("/x.md", "a");
  assert.equal(a.exists("/x.md"), true);
  assert.equal(b.exists("/x.md"), false, "a second instance must not see the first's writes");
});

test("memStorage never touches the real filesystem", () => {
  const base = root();
  const s = memStorage();
  const f = join(base, "ghost.md");
  s.write(f, "not on disk");
  assert.equal(s.read(f), "not on disk");
  assert.equal(existsSync(f), false, "the in-memory driver must leave no trace on disk");
});

test("fsStorage reads a file written by something else — it is not a private store", () => {
  const base = root();
  const dir = join(base, "defined");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "BLZ-5-q.md"), "written by hand");
  assert.equal(fsStorage.read(join(dir, "BLZ-5-q.md")), "written by hand");
});

test("fsStorage.write lands real bytes at the real path", () => {
  const base = root();
  const f = join(base, "s", "BLZ-6-r.md");
  fsStorage.write(f, "on disk");
  assert.equal(readFileSync(f, "utf8"), "on disk");
});

// --- the seam is real, proven by execution -----------------------------------
// If any verb still reaches for node:fs behind the driver's back, these fail:
// the ticket lands on disk despite the verb being handed an in-memory driver.
import { execFileSync } from "node:child_process";
import { applyNew } from "../../scripts/new.mjs";
import { applyMove } from "../../scripts/move.mjs";
import { applyLog } from "../../scripts/log.mjs";

function board() {
  const d = mkdtempSync(join(tmpdir(), "blaze-seam-"));
  execFileSync("git", ["-C", d, "init", "-q"]);
  mkdirSync(join(d, "projects", "BLZ"), { recursive: true });
  writeFileSync(join(d, "blaze.config.json"), JSON.stringify({
    projects: [{ key: "BLZ", name: "Blaze" }], defaultLabels: ["backend"],
  }));
  return { root: d, projectsDir: join(d, "projects") };
}

test("applyNew with an injected driver writes NOTHING to the real filesystem", () => {
  const { projectsDir } = board();
  const s = memStorage();
  const r = applyNew(projectsDir, {
    project: "BLZ", type: "task", title: "Seam proof", today: "2026-08-20",
    extra: { estimate: 30 }, storage: s,
  });
  assert.equal(r.ok, true, `applyNew failed: ${r.errors?.join("; ")}`);
  assert.equal(existsSync(r.file), false, "the ticket must NOT be on disk — the driver was in-memory");
  assert.equal(s.exists(r.file), true, "the ticket must be in the injected driver");
  assert.match(s.read(r.file), /^id: BLZ-1$/m);
});

test("applyMove with an injected driver relocates in the driver, not on disk", () => {
  const { projectsDir } = board();
  // Seed through the fs driver so locateTicket (a READ path, still fs-backed) can find it.
  const created = applyNew(projectsDir, {
    project: "BLZ", type: "task", title: "Move proof", today: "2026-08-20", extra: { estimate: 30 },
  });
  assert.equal(created.ok, true, `seed failed: ${created.errors?.join("; ")}`);
  assert.equal(existsSync(created.file), true, "seeded via fsStorage, so it IS on disk");

  const s = memStorage();
  const r = applyMove(projectsDir, "BLZ-1", "in-progress", { today: "2026-08-20", storage: s });
  assert.equal(r.ok, true, `applyMove failed: ${r.errors?.join("; ")}`);
  assert.equal(existsSync(r.file), false, "the destination must NOT appear on disk");
  assert.equal(existsSync(created.file), true, "and the source must be untouched on disk");
  assert.equal(s.exists(r.file), true, "the move landed in the injected driver");
});

test("applyLog with an injected driver leaves the on-disk ticket unchanged", () => {
  const { projectsDir } = board();
  const created = applyNew(projectsDir, {
    project: "BLZ", type: "task", title: "Log proof", today: "2026-08-20", extra: { estimate: 30 },
  });
  assert.equal(created.ok, true);
  const before = readFileSync(created.file, "utf8");

  const s = memStorage();
  const r = applyLog(projectsDir, "BLZ-1", 45, { today: "2026-08-20", note: "seam", storage: s });
  assert.equal(r.ok, true, `applyLog failed: ${r.errors?.join("; ")}`);
  assert.equal(readFileSync(created.file, "utf8"), before, "on-disk ticket must be byte-identical");
  assert.match(s.read(created.file), /minutes: 45/, "the worklog landed in the injected driver");
});
