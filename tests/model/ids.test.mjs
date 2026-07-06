// tests/model/ids.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxId, nextId } from "../../scripts/model/ids.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "blaze-ids-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "done"), { recursive: true });
  mkdirSync(join(projects, "OBA", "in-progress"), { recursive: true });
  mkdirSync(join(projects, "INF", "defined"), { recursive: true });
  writeFileSync(join(projects, "OBA", "done", "OBA-3-x.md"), "---\nid: OBA-3\n---\n");
  writeFileSync(join(projects, "OBA", "in-progress", "OBA-7-y.md"), "---\nid: OBA-7\n---\n");
  return { root, projects };
}

test("maxId finds the highest number across a project's status dirs", () => {
  const { root, projects } = fixture();
  assert.equal(maxId(projects, "OBA"), 7);
  assert.equal(maxId(projects, "INF"), 0);          // empty project
  rmSync(root, { recursive: true, force: true });
});

test("nextId increments per project and is namespaced", () => {
  const { root, projects } = fixture();
  assert.equal(nextId(projects, "OBA"), "OBA-8");
  assert.equal(nextId(projects, "INF"), "INF-1");
  rmSync(root, { recursive: true, force: true });
});

test("maxId does not bleed across project keys", () => {
  const { root, projects } = fixture();
  // OBA's numbers must not influence INF.
  assert.equal(nextId(projects, "INF"), "INF-1");
  rmSync(root, { recursive: true, force: true });
});
