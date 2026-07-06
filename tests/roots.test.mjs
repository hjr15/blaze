import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRoots, ROOT } from "../scripts/config.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

test("BLAZE_PROJECTS_DIR wins: dataRoot is its parent, projectsDir is the env value", () => {
  const data = mkdtempSync(join(tmpdir(), "blaze-roots-"));
  const pd = join(data, "projects");
  mkdirSync(pd);
  const r = resolveRoots({ env: { BLAZE_PROJECTS_DIR: pd }, cwd: "/somewhere/else" });
  assert.equal(r.projectsDir, pd);
  assert.equal(r.dataRoot, data);
  assert.equal(r.engineRoot, ROOT);
  rmSync(data, { recursive: true, force: true });
});

test("BLAZE_PROJECTS_DIR may point at a dir not named projects", () => {
  const data = mkdtempSync(join(tmpdir(), "blaze-roots-"));
  const pd = join(data, "tickets");
  mkdirSync(pd);
  const r = resolveRoots({ env: { BLAZE_PROJECTS_DIR: pd }, cwd: data });
  assert.equal(r.projectsDir, pd);
  assert.equal(r.dataRoot, data);
  rmSync(data, { recursive: true, force: true });
});

test("relative BLAZE_PROJECTS_DIR resolves against cwd", () => {
  const data = mkdtempSync(join(tmpdir(), "blaze-roots-"));
  mkdirSync(join(data, "projects"));
  const r = resolveRoots({ env: { BLAZE_PROJECTS_DIR: "projects" }, cwd: data });
  assert.equal(r.projectsDir, join(data, "projects"));
  assert.equal(r.dataRoot, data);
  rmSync(data, { recursive: true, force: true });
});

test("cwd with a projects/ dir becomes dataRoot when env is unset", () => {
  const data = mkdtempSync(join(tmpdir(), "blaze-roots-"));
  mkdirSync(join(data, "projects"));
  const r = resolveRoots({ env: {}, cwd: data });
  assert.equal(r.dataRoot, data);
  assert.equal(r.projectsDir, join(data, "projects"));
  assert.equal(r.engineRoot, ROOT);
  rmSync(data, { recursive: true, force: true });
});

test("back-compat: no env, no ./projects in cwd → engine tree is dataRoot", () => {
  const empty = mkdtempSync(join(tmpdir(), "blaze-roots-"));
  const r = resolveRoots({ env: {}, cwd: empty });
  assert.equal(r.dataRoot, ROOT);
  assert.equal(r.projectsDir, join(ROOT, "projects"));
  rmSync(empty, { recursive: true, force: true });
});

test("result is frozen", () => {
  const r = resolveRoots({ env: {}, cwd: tmpdir() });
  assert.throws(() => { r.dataRoot = "/x"; }, TypeError);
});

test("rung 3 throws instead of falling back when the engine tree lives under node_modules", () => {
  const empty = mkdtempSync(join(tmpdir(), "blaze-roots-"));
  const vendoredEngine = join(empty, "node_modules", "@hjr15", "blaze");
  assert.throws(
    () => resolveRoots({ env: {}, cwd: empty, engineRoot: vendoredEngine }),
    /blaze: no data dir found — set BLAZE_PROJECTS_DIR or run from a directory containing projects\//
  );
  rmSync(empty, { recursive: true, force: true });
});

test("rung 3 still falls back to the engine tree when engineRoot is not under node_modules (back-compat)", () => {
  const empty = mkdtempSync(join(tmpdir(), "blaze-roots-"));
  const devEngine = join(empty, "vendored-engine");
  const r = resolveRoots({ env: {}, cwd: empty, engineRoot: devEngine });
  assert.equal(r.dataRoot, devEngine);
  assert.equal(r.projectsDir, join(devEngine, "projects"));
  rmSync(empty, { recursive: true, force: true });
});
