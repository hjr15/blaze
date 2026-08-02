// tests/index-duplicate-id.test.mjs — BLZ-134.
//
// makeIndex built its id map with `new Map(rows.map(r => [r.id, r]))`, so two
// tickets sharing an id silently collapsed to whichever the walk saw last. That
// is not hypothetical: a real board in production accumulated four such
// collisions, each a pair of unrelated tickets that had been issued the same id
// by concurrent sessions. In two of the pairs the SHADOWED copy was the
// non-terminal one, so the index was hiding open work behind a closed ticket —
// and reindex reported nothing at all.
//
// The fixture below reproduces that exact shape: same id, different titles,
// different status dirs, one terminal and one not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../scripts/model/index.mjs";

function ticket(dir, name, { id, title, status }) {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, name);
  writeFileSync(f, `---\nid: ${id}\ntitle: ${title}\ntype: task\nproject: PROJ\npriority: medium\nresolution: ${status === "done" ? "done" : ""}\n---\nbody\n`);
  return f;
}

function collidingBoard() {
  const root = mkdtempSync(join(tmpdir(), "blaze-dupid-"));
  const projects = join(root, "projects");
  const a = ticket(join(projects, "PROJ", "done"), "PROJ-41-first-claimant.md",
    { id: "PROJ-41", title: "First claimant of the id", status: "done" });
  const b = ticket(join(projects, "PROJ", "defined"), "PROJ-41-second-claimant.md",
    { id: "PROJ-41", title: "Second, unrelated claimant of the same id", status: "defined" });
  return { root, projects, a, b };
}

test("BLZ-134: a duplicate id is reported as an ERROR naming BOTH files", () => {
  const { root, projects, a, b } = collidingBoard();
  const idx = buildIndex(projects);
  assert.ok(Array.isArray(idx.errors), "index exposes an errors array");
  assert.equal(idx.errors.length, 1, `expected exactly one duplicate-id error, got ${JSON.stringify(idx.errors)}`);
  const msg = idx.errors[0];
  assert.match(msg, /PROJ-41/);
  // Both colliding paths must appear — naming only one leaves the operator
  // hunting for the other, which is the whole failure mode being fixed.
  assert.ok(msg.includes(a), `error must name the first file:\n${msg}`);
  assert.ok(msg.includes(b), `error must name the second file:\n${msg}`);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-134: duplicate ids are errors, NOT warnings (warnings must stay clean)", () => {
  const { root, projects } = collidingBoard();
  const idx = buildIndex(projects);
  assert.deepEqual(idx.warnings, [], "a duplicate id must not be downgraded into the warnings channel");
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-134: a clean board reports no duplicate-id errors", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-dupid-clean-"));
  const projects = join(root, "projects");
  ticket(join(projects, "PROJ", "done"), "PROJ-41-a.md", { id: "PROJ-41", title: "A", status: "done" });
  ticket(join(projects, "PROJ", "defined"), "PROJ-41-b.md", { id: "PROJ-42", title: "B", status: "defined" });
  const idx = buildIndex(projects);
  assert.deepEqual(idx.errors, [], "clean board must not produce duplicate-id errors");
  assert.equal(idx.count(), 2);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-134: three files sharing one id name all three", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-dupid3-"));
  const projects = join(root, "projects");
  ticket(join(projects, "PROJ", "done"), "PROJ-70-a.md", { id: "PROJ-70", title: "A", status: "done" });
  ticket(join(projects, "PROJ", "defined"), "PROJ-70-b.md", { id: "PROJ-70", title: "B", status: "defined" });
  ticket(join(projects, "PROJ", "in-progress"), "PROJ-70-c.md", { id: "PROJ-70", title: "C", status: "in-progress" });
  const idx = buildIndex(projects);
  assert.equal(idx.errors.length, 1);
  assert.match(idx.errors[0], /PROJ-70-a\.md/);
  assert.match(idx.errors[0], /PROJ-70-b\.md/);
  assert.match(idx.errors[0], /PROJ-70-c\.md/);
  rmSync(root, { recursive: true, force: true });
});

// The detector is only worth anything if it actually stops the pipeline.
test("BLZ-134: `blaze reindex` exits non-zero, names both paths, and writes NO index", async () => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { root, projects, a, b } = collidingBoard();

  let status = 0, stderr = "";
  try {
    execFileSync("node", [join(REPO, "scripts", "reindex.mjs"), projects],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    status = e.status; stderr = String(e.stderr);
  }
  assert.notEqual(status, 0, "reindex must exit non-zero on a colliding board");
  assert.match(stderr, /duplicate id PROJ-41/);
  assert.ok(stderr.includes(a) && stderr.includes(b), `stderr must name both files:\n${stderr}`);
  assert.match(stderr, /refusing to write a corrupt index/);
  assert.equal(existsSync(join(root, ".blaze", "index.json")), false,
    "no index may be written when the board has colliding ids");
  rmSync(root, { recursive: true, force: true });
});

// The hatch must be genuinely opt-in: still loud, but not board-wedging.
test("BLZ-134: --allow-duplicate-ids rebuilds anyway but still reports every collision", async () => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { root, projects } = collidingBoard();

  const res = execFileSync("node",
    [join(REPO, "scripts", "reindex.mjs"), projects, "--allow-duplicate-ids"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(res, /indexed \d+ tickets/);
  assert.equal(existsSync(join(root, ".blaze", "index.json")), true, "hatch must write the index");
  rmSync(root, { recursive: true, force: true });
});
