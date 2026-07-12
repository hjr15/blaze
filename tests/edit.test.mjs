// tests/edit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdit } from "../scripts/edit.mjs";

function fixture(extraFm = "", body = "body") {
  const root = mkdtempSync(join(tmpdir(), "blaze-edit-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    `---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\npriority: medium\nestimate: 30\n${extraFm}created: 2026-06-01\nupdated: 2026-06-01\n---\n${body}\n`);
  return { root, projects };
}

test("applyEdit patches an allowed field and writes in place", () => {
  const { root, projects } = fixture();
  const r = applyEdit(projects, "OBA-1", { assignee: "ryan", priority: "high" }, { today: "2026-07-01" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const text = readFileSync(join(projects, "OBA", "defined", "OBA-1.md"), "utf8");
  assert.match(text, /assignee: ryan/);
  assert.match(text, /priority: high/);
  assert.match(text, /updated: 2026-07-01/);
  rmSync(root, { recursive: true, force: true });
});

test("applyEdit rounds estimate to 5m", () => {
  const { root, projects } = fixture();
  const r = applyEdit(projects, "OBA-1", { estimate: 47 }, {});
  assert.equal(r.ok, true);
  assert.match(readFileSync(r.file, "utf8"), /estimate: 45/);
  rmSync(root, { recursive: true, force: true });
});

test("applyEdit rejects an unknown patch field with no write", () => {
  const { root, projects } = fixture();
  const before = readFileSync(join(projects, "OBA", "defined", "OBA-1.md"), "utf8");
  const r = applyEdit(projects, "OBA-1", { status: "done" }, {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not editable|unknown field/.test(e)));
  assert.equal(readFileSync(join(projects, "OBA", "defined", "OBA-1.md"), "utf8"), before);
  rmSync(root, { recursive: true, force: true });
});

test("applyEdit rejects an invalid enum value with no write", () => {
  const { root, projects } = fixture();
  const before = readFileSync(join(projects, "OBA", "defined", "OBA-1.md"), "utf8");
  const r = applyEdit(projects, "OBA-1", { priority: "banana" }, {});
  assert.equal(r.ok, false);
  assert.equal(readFileSync(join(projects, "OBA", "defined", "OBA-1.md"), "utf8"), before);
  rmSync(root, { recursive: true, force: true });
});

test("applyEdit rejects a parent that violates the hierarchy, no write", () => {
  const { root, projects } = fixture();
  // A task's parent must be an epic; point it at another task → invalid.
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(projects, "OBA", "defined", "OBA-2.md"),
    "---\nid: OBA-2\ntitle: t2\ntype: task\nproject: OBA\nestimate: 30\n---\nb\n");
  const r = applyEdit(projects, "OBA-1", { parent: "OBA-2" }, {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /invalid parent/.test(e)));
  rmSync(root, { recursive: true, force: true });
});

test("applyEdit accepts a title change", () => {
  const { projects } = fixture();
  const r = applyEdit(projects, "OBA-1", { title: "renamed" }, {});
  assert.equal(r.ok, true);
});
