// tests/new.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyNew } from "../scripts/new.mjs";

function root() { return mkdtempSync(join(tmpdir(), "blaze-new-")); }

test("applyNew creates a validated task in the initial status dir with a namespaced id", () => {
  const r = root(); const projects = join(r, "projects");
  const res = applyNew(projects, { project: "OBA", type: "task", title: "Wire gateway timeout",
    priority: "high", labels: ["infra"], today: "2026-06-29", extra: { estimate: 30 } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(res.id, "OBA-1");
  assert.equal(res.status, "defined");
  assert.ok(existsSync(res.file));
  const txt = readFileSync(res.file, "utf8");
  assert.match(txt, /id: OBA-1/);
  assert.match(txt, /type: task/);
  assert.match(txt, /estimate: 30/);
  assert.match(txt, /## Acceptance Criteria/);
  rmSync(r, { recursive: true, force: true });
});

test("applyNew increments the id on the second create", () => {
  const r = root(); const projects = join(r, "projects");
  applyNew(projects, { project: "OBA", type: "task", title: "first", today: "2026-06-29", extra: { estimate: 5 } });
  const res = applyNew(projects, { project: "OBA", type: "task", title: "second", today: "2026-06-29", extra: { estimate: 5 } });
  assert.equal(res.id, "OBA-2");
  rmSync(r, { recursive: true, force: true });
});

test("applyNew rejects an unknown type and a leaf with no estimate", () => {
  const r = root(); const projects = join(r, "projects");
  assert.equal(applyNew(projects, { project: "OBA", type: "nope", title: "x", today: "2026-06-29" }).ok, false);
  const noEst = applyNew(projects, { project: "OBA", type: "task", title: "x", today: "2026-06-29" });
  assert.equal(noEst.ok, false);
  assert.ok(noEst.errors.some((e) => /estimate/.test(e)));
  rmSync(r, { recursive: true, force: true });
});

test("applyNew places a goal in its own initial status", () => {
  const r = root(); const projects = join(r, "projects");
  const res = applyNew(projects, { project: "OBA", type: "goal", title: "Ship v1", today: "2026-06-29" });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(res.status, "defined");
  assert.ok(readdirSync(join(projects, "OBA", "defined")).length === 1);
  rmSync(r, { recursive: true, force: true });
});

test("applyNew rounds the estimate to 5m at create", () => {
  const r = root(); const projects = join(r, "projects");
  const res = applyNew(projects, { project: "OBA", type: "task", title: "round me",
    today: "2026-06-29", extra: { estimate: 33 } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const txt = readFileSync(res.file, "utf8");
  assert.match(txt, /estimate: 35/);
  rmSync(r, { recursive: true, force: true });
});

test("applyNew: a positive sub-5m estimate is bumped to 5, not dropped", () => {
  const r = root(); const projects = join(r, "projects");
  const res = applyNew(projects, { project: "OBA", type: "task", title: "tiny",
    today: "2026-06-29", extra: { estimate: 2 } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.match(readFileSync(res.file, "utf8"), /estimate: 5/);
  rmSync(r, { recursive: true, force: true });
});

test("applyNew sets components from extra.components and round-trips", () => {
  const r = root();
  const projects = join(r, "projects");
  const res = applyNew(projects, {
    project: "OBA", type: "task", title: "comp task", today: "2026-07-15",
    extra: { components: ["auth", "gateway"], estimate: 30 },
  });
  assert.equal(res.ok, true);
  const txt = readFileSync(res.file, "utf8");
  assert.match(txt, /components: \[auth, gateway\]/);
  rmSync(r, { recursive: true, force: true });
});
