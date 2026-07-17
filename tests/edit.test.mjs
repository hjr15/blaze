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

test("applyEdit hard-rejects an off-taxonomy label", () => {
  const { root, projects } = fixture();
  writeFileSync(join(projects, "OBA", "project.json"), JSON.stringify({ components: [], labels: ["area:cms"] }));
  const r = applyEdit(projects, "OBA-1", { labels: "area:cms, bogus" }, { today: "2026-07-15" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /bogus/.test(e)));
  rmSync(root, { recursive: true, force: true });
});

test("applyEdit throws on malformed project.json instead of silently skipping taxonomy", () => {
  const { root, projects } = fixture();
  writeFileSync(join(projects, "OBA", "project.json"), "{ not valid json");
  assert.throws(
    () => applyEdit(projects, "OBA-1", { labels: "bogus" }, { today: "2026-07-15" }),
    /cannot parse/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("applyEdit accepts a registered sprint id", () => {
  const { root, projects } = fixture();
  writeFileSync(join(root, "sprints.json"), JSON.stringify({
    active: "S1", sprints: [{ id: "S1", name: "Mid-July", start: "2026-07-13", end: "2026-07-26" }],
  }));
  const r = applyEdit(projects, "OBA-1", { sprint: "S1" }, {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.match(readFileSync(r.file, "utf8"), /sprint: S1/);
  rmSync(root, { recursive: true, force: true });
});

test("applyEdit rejects an unregistered sprint id, no write", () => {
  const { root, projects } = fixture();
  const before = readFileSync(join(projects, "OBA", "defined", "OBA-1.md"), "utf8");
  const r = applyEdit(projects, "OBA-1", { sprint: "S9" }, {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /sprint 'S9'/.test(e)));
  assert.equal(readFileSync(join(projects, "OBA", "defined", "OBA-1.md"), "utf8"), before);
  rmSync(root, { recursive: true, force: true });
});

test("applyEdit rejects start after due, no write on the failing patch", () => {
  const { root, projects } = fixture();
  const r1 = applyEdit(projects, "OBA-1", { start: "2026-07-25" }, {});
  assert.equal(r1.ok, true, JSON.stringify(r1.errors));
  const before = readFileSync(join(projects, "OBA", "defined", "OBA-1.md"), "utf8");
  const r2 = applyEdit(projects, "OBA-1", { due: "2026-07-20" }, {});
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => /start.*after.*due/i.test(e)));
  assert.equal(readFileSync(join(projects, "OBA", "defined", "OBA-1.md"), "utf8"), before);
  rmSync(root, { recursive: true, force: true });
});

test("applyEdit skips taxonomy (no crash) for a ticket with no project field", () => {
  // fixture() always stamps `project: OBA`, so build a project-less ticket directly
  // (mirrors edit-runner-batch.test.mjs's project-less OBA-1 fixture).
  const root = mkdtempSync(join(tmpdir(), "blaze-edit-noproj-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\npriority: medium\nestimate: 30\ncreated: 2026-06-01\nupdated: 2026-06-01\n---\nbody\n");
  writeFileSync(join(projects, "OBA", "project.json"), "{ not valid json"); // must never be consulted
  const r = applyEdit(projects, "OBA-1", { labels: "anything" }, { today: "2026-07-15" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  rmSync(root, { recursive: true, force: true });
});
