// tests/move-requireworklog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMove } from "../scripts/move.mjs";

function fixture(requireWorklog, withWorklog) {
  const root = mkdtempSync(join(tmpdir(), "blaze-rwl-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "in-review"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"] }));
  mkdirSync(join(projects, "OBA"), { recursive: true });
  writeFileSync(join(projects, "OBA", "project.json"),
    JSON.stringify({ key: "OBA", name: "OBA", requireWorklogBeforeTerminal: requireWorklog }));
  const worklog = withWorklog ? "worklog:\n  - { date: 2026-06-29, minutes: 30 }\n" : "";
  writeFileSync(join(projects, "OBA", "in-review", "OBA-1.md"),
    `---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\n${worklog}created: 2026-06-01\nupdated: 2026-06-01\n---\nbody\n`);
  return { root, projects };
}

test("project requireWorklogBeforeTerminal blocks Done when no worklog", () => {
  const { root, projects } = fixture(true, false);
  const r = applyMove(projects, "OBA-1", "done", { today: "2026-06-29" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /worklog required/.test(e)));
  assert.ok(existsSync(join(projects, "OBA", "in-review", "OBA-1.md")));
  rmSync(root, { recursive: true, force: true });
});

test("with a worklog the same move is allowed", () => {
  const { root, projects } = fixture(true, true);
  const r = applyMove(projects, "OBA-1", "done", { today: "2026-06-29" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(existsSync(join(projects, "OBA", "done", "OBA-1.md")));
  rmSync(root, { recursive: true, force: true });
});

test("with the flag off, no worklog is required", () => {
  const { root, projects } = fixture(false, false);
  const r = applyMove(projects, "OBA-1", "done", { today: "2026-06-29" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  rmSync(root, { recursive: true, force: true });
});
