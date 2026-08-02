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

test("back-compat: engine tree is dataRoot only when it actually holds projects/", () => {
  const empty = mkdtempSync(join(tmpdir(), "blaze-roots-"));
  const singleTree = join(empty, "single-tree-engine");
  mkdirSync(join(singleTree, "projects"), { recursive: true });
  const r = resolveRoots({ env: {}, cwd: empty, engineRoot: singleTree });
  assert.equal(r.dataRoot, singleTree);
  assert.equal(r.projectsDir, join(singleTree, "projects"));
  rmSync(empty, { recursive: true, force: true });
});

test("result is frozen", () => {
  const data = mkdtempSync(join(tmpdir(), "blaze-roots-"));
  mkdirSync(join(data, "projects"));
  const r = resolveRoots({ env: {}, cwd: data });
  assert.throws(() => { r.dataRoot = "/x"; }, TypeError);
  rmSync(data, { recursive: true, force: true });
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

// BLZ-133. The node_modules substring test was the ONLY thing standing between an
// unscaffolded cwd and the engine checkout — and a symlinked install defeats it:
// `fileURLToPath(import.meta.url)` yields the REAL path, so a global install
// symlinked to a dev checkout reports an engineRoot under the user's own tree,
// which contains no "/node_modules/" and sailed straight through to the fallback.
// That is how two tickets got committed onto the live engine repo's main on
// 2026-08-02. The guard is now positive — fall back only to a tree that really is
// a board — so how the engine was installed stops mattering.
test("BLZ-133: symlinked install (realpath outside node_modules) must NOT fall through to the engine tree", () => {
  const empty = mkdtempSync(join(tmpdir(), "blaze-roots-"));
  // Exactly what a symlinked global install realpaths to: a plain dev checkout
  // with no projects/ of its own, and no node_modules anywhere in the path.
  const symlinkedEngine = join(empty, "Code", "blaze");
  mkdirSync(join(symlinkedEngine, "scripts"), { recursive: true });
  assert.ok(!symlinkedEngine.includes("/node_modules/"), "fixture must defeat the old substring guard");
  assert.throws(
    () => resolveRoots({ env: {}, cwd: empty, engineRoot: symlinkedEngine }),
    /blaze: no data dir found — set BLAZE_PROJECTS_DIR or run from a directory containing projects\//
  );
  rmSync(empty, { recursive: true, force: true });
});

test("BLZ-133: an unscaffolded cwd throws rather than resolving anywhere writable", () => {
  const empty = mkdtempSync(join(tmpdir(), "blaze-roots-"));
  const devEngine = join(empty, "vendored-engine");
  mkdirSync(devEngine, { recursive: true });
  assert.throws(
    () => resolveRoots({ env: {}, cwd: empty, engineRoot: devEngine }),
    /no data dir found/
  );
  rmSync(empty, { recursive: true, force: true });
});
