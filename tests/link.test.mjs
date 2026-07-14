// tests/link.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLink } from "../scripts/link.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "blaze-link-"));
  const dir = join(root, "projects", "OBA", "defined");
  mkdirSync(dir, { recursive: true });
  const tk = (id) => `---\nid: ${id}\ntype: task\nproject: OBA\ntitle: ${id}\npriority: medium\nestimate: 30\n---\n\nbody\n`;
  writeFileSync(join(dir, "OBA-1.md"), tk("OBA-1"));
  writeFileSync(join(dir, "OBA-2.md"), tk("OBA-2"));
  return { root, projects: join(root, "projects") };
}

test("applyLink adds a validated typed link", () => {
  const { root, projects } = fixture();
  const r = applyLink(projects, "OBA-1", { type: "Blocks", target: "OBA-2" }, { today: "2026-07-15" });
  assert.equal(r.ok, true);
  assert.match(readFileSync(r.file, "utf8"), /links:\n\s*- \{ type: Blocks, target: OBA-2 \}/);
  rmSync(root, { recursive: true, force: true });
});

test("applyLink rejects an unknown link type", () => {
  const { root, projects } = fixture();
  const r = applyLink(projects, "OBA-1", { type: "Bogus", target: "OBA-2" }, {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown link type/i.test(e)));
  rmSync(root, { recursive: true, force: true });
});

test("applyLink rejects a target that does not resolve", () => {
  const { root, projects } = fixture();
  const r = applyLink(projects, "OBA-1", { type: "Blocks", target: "OBA-999" }, {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /OBA-999/.test(e)));
  rmSync(root, { recursive: true, force: true });
});

test("applyLink is idempotent", () => {
  const { root, projects } = fixture();
  applyLink(projects, "OBA-1", { type: "Blocks", target: "OBA-2" }, { today: "2026-07-15" });
  const r = applyLink(projects, "OBA-1", { type: "Blocks", target: "OBA-2" }, { today: "2026-07-15" });
  assert.equal(r.ok, true);
  const links = (readFileSync(r.file, "utf8").match(/type: Blocks, target: OBA-2/g) || []).length;
  assert.equal(links, 1);
  rmSync(root, { recursive: true, force: true });
});

test("applyLink rejects a source id that does not resolve", () => {
  const { root, projects } = fixture();
  const r = applyLink(projects, "OBA-404", { type: "Blocks", target: "OBA-2" }, {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not found/.test(e)));
  rmSync(root, { recursive: true, force: true });
});

test("applyLink --rm removes an entry", () => {
  const { root, projects } = fixture();
  applyLink(projects, "OBA-1", { type: "Blocks", target: "OBA-2" }, { today: "2026-07-15" });
  const r = applyLink(projects, "OBA-1", { type: "Blocks", target: "OBA-2", remove: true }, { today: "2026-07-15" });
  assert.equal(r.ok, true);
  assert.doesNotMatch(readFileSync(r.file, "utf8"), /type: Blocks, target: OBA-2/);
  rmSync(root, { recursive: true, force: true });
});
