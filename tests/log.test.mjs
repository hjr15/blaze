import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLog } from "../scripts/log.mjs";

function fixture(worklogBlock = "") {
  const root = mkdtempSync(join(tmpdir(), "blaze-log-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "in-progress"), { recursive: true });
  writeFileSync(join(projects, "OBA", "in-progress", "OBA-1-x.md"),
    `---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 60\n${worklogBlock}created: 2026-06-01\nupdated: 2026-06-01\n---\n## Context\nbody\n`);
  return { root, projects };
}

test("applyLog appends the first worklog entry and sets updated", () => {
  const { root, projects } = fixture();
  const r = applyLog(projects, "OBA-1", 30, { today: "2026-06-29" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.minutes, 30);
  assert.equal(r.total_worklog_minutes, 30);
  const txt = readFileSync(r.file, "utf8");
  assert.match(txt, /worklog:/);
  assert.match(txt, /minutes: 30/);
  assert.match(txt, /date: 2026-06-29/);
  assert.match(txt, /updated: 2026-06-29/);
  rmSync(root, { recursive: true, force: true });
});

test("applyLog accumulates onto an existing worklog", () => {
  const { root, projects } = fixture("worklog:\n  - { date: 2026-06-01, minutes: 60 }\n");
  const r = applyLog(projects, "OBA-1", 15, { today: "2026-06-29" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.total_worklog_minutes, 75);
  rmSync(root, { recursive: true, force: true });
});

test("applyLog rounds minutes to 1m", () => {
  const { root, projects } = fixture();
  const r = applyLog(projects, "OBA-1", 30.4, { today: "2026-06-29" });
  assert.equal(r.minutes, 30);
  rmSync(root, { recursive: true, force: true });
});

test("applyLog rejects non-positive minutes and does not write", () => {
  const { root, projects } = fixture();
  const before = readFileSync(join(projects, "OBA", "in-progress", "OBA-1-x.md"), "utf8");
  const r = applyLog(projects, "OBA-1", 0, { today: "2026-06-29" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /positive/.test(e)));
  const after = readFileSync(join(projects, "OBA", "in-progress", "OBA-1-x.md"), "utf8");
  assert.equal(before, after);                  // unchanged
  rmSync(root, { recursive: true, force: true });
});

test("applyLog round-trips a --note and honours an explicit --date", () => {
  const { root, projects } = fixture();
  const r = applyLog(projects, "OBA-1", 20, { date: "2026-06-15", note: "pairing", today: "2026-06-29" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const txt = readFileSync(r.file, "utf8");
  assert.match(txt, /date: 2026-06-15/);
  assert.match(txt, /note: pairing/);
  rmSync(root, { recursive: true, force: true });
});

test("applyLog reports a clear error for an unknown id", () => {
  const { root, projects } = fixture();
  const r = applyLog(projects, "OBA-999", 10, { today: "2026-06-29" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not found/.test(e)));
  rmSync(root, { recursive: true, force: true });
});
