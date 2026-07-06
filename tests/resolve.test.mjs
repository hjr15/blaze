// tests/resolve.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyResolve } from "../scripts/resolve.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "blaze-res-"));
  const dir = join(root, "projects", "OBA", "done");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nresolution: done\nupdated: 2026-06-01\n---\nbody\n");
  return { root, projects: join(root, "projects") };
}

test("applyResolve overrides resolution in place without moving the file", () => {
  const { root, projects } = fixture();
  const r = applyResolve(projects, "OBA-1", "wont-do", { today: "2026-06-29" });
  assert.equal(r.ok, true);
  const txt = readFileSync(join(projects, "OBA", "done", "OBA-1.md"), "utf8");
  assert.match(txt, /resolution: wont-do/);
  assert.match(txt, /updated: 2026-06-29/);
  rmSync(root, { recursive: true, force: true });
});

test("applyResolve rejects an invalid resolution value", () => {
  const { root, projects } = fixture();
  const r = applyResolve(projects, "OBA-1", "banana", { today: "2026-06-29" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /invalid resolution/.test(e)));
  rmSync(root, { recursive: true, force: true });
});

test("applyResolve reports a missing ticket", () => {
  const { root, projects } = fixture();
  const r = applyResolve(projects, "OBA-404", "done", { today: "2026-06-29" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not found/.test(e)));
  rmSync(root, { recursive: true, force: true });
});
