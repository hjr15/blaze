// tests/model/index.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, walkTickets } from "../../scripts/model/index.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "blaze-idx-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "in-progress"), { recursive: true });
  mkdirSync(join(projects, "INF", "done"), { recursive: true });
  writeFileSync(join(projects, "OBA", "in-progress", "OBA-1.md"),
`---
id: OBA-1
title: Gateway timeout
type: task
project: OBA
estimate: 90
worklog:
  - { date: 2026-06-28, minutes: 60 }
  - { date: 2026-06-29, minutes: 30 }
links:
  - { type: Blocks, target: OBA-2 }
---
body
`);
  writeFileSync(join(projects, "INF", "done", "INF-1.md"),
`---
id: INF-1
title: Pin image
type: task
project: INF
resolution: done
---
body
`);
  return { root, projects };
}

test("walkTickets yields tickets with their directory status", () => {
  const { root, projects } = fixture();
  const ids = [...walkTickets(projects)].map((t) => `${t.frontmatter.id}:${t.status}`).sort();
  assert.deepEqual(ids, ["INF-1:done", "OBA-1:in-progress"]);
  rmSync(root, { recursive: true, force: true });
});

test("buildIndex populates rows with summed worklog and links", () => {
  const { root, projects } = fixture();
  const idx = buildIndex(projects);
  const row = idx.get("OBA-1");
  assert.equal(row.project, "OBA");
  assert.equal(row.status, "in-progress");
  assert.equal(row.estimate, 90);
  assert.equal(row.worklog_minutes, 90);                 // 60 + 30
  assert.deepEqual(idx.linksFrom("OBA-1"), [{ src: "OBA-1", type: "Blocks", target: "OBA-2" }]);
  assert.equal(idx.count(), 2);
  assert.deepEqual(idx.countByProject(), { INF: 1, OBA: 1 });
  assert.deepEqual(idx.byProject("INF").map((r) => r.id), ["INF-1"]);
  rmSync(root, { recursive: true, force: true });
});
