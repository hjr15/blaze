import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadConfig, loadProject, ambientSchemaOverride } from "../scripts/config.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function withConfig(json) {
  const dir = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  if (json !== null) writeFileSync(join(dir, "blaze.config.json"), JSON.stringify(json));
  return dir;
}

test("applies defaults when no config file exists", () => {
  const dir = withConfig(null);
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.key, "TASK");
  assert.equal(cfg.boardTitle, "Blaze");
  assert.equal(cfg.codeRepo, null);
  assert.equal(cfg.codeRepoPath, null);
  assert.deepEqual(cfg.terminal, ["done", "canceled", "duplicate"]);
  rmSync(dir, { recursive: true, force: true });
});

test("file overrides defaults; loops deep-merge", () => {
  const dir = withConfig({ key: "PROJ", loops: { groomer: { intervalSec: 99 } } });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.key, "PROJ");
  assert.equal(cfg.loops.groomer.intervalSec, 99);
  assert.equal(cfg.loops.groomer.enabled, true); // default preserved
  assert.equal(cfg.loops.reconcile.intervalSec, 60); // default branch intact
  rmSync(dir, { recursive: true, force: true });
});

test("env overrides win over file", () => {
  const dir = withConfig({ key: "PROJ", port: 4321 });
  const cfg = loadConfig({ root: dir, env: { BLAZE_KEY: "OPS", BLAZE_PORT: "8080", BLAZE_CODE_REPO: "../app" } });
  assert.equal(cfg.key, "OPS");
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.codeRepo, "../app");
  assert.ok(cfg.codeRepoPath.endsWith("/app"));
  rmSync(dir, { recursive: true, force: true });
});

test("idFromRef extracts the key id case-insensitively", () => {
  const dir = withConfig({ key: "DEV" });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.idFromRef("jordan/DEV-12-foo"), "DEV-12");
  assert.equal(cfg.idFromRef("epic/dev-9-bar"), "DEV-9");
  assert.equal(cfg.idFromRef("main"), null);
  rmSync(dir, { recursive: true, force: true });
});

test("fileRegex matches ticket files only", () => {
  const dir = withConfig({ key: "TASK" });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.ok(cfg.fileRegex.test("TASK-1-fix-thing.md"));
  assert.ok(!cfg.fileRegex.test("README.md"));
  assert.ok(!cfg.fileRegex.test("TASK-.md"));
  rmSync(dir, { recursive: true, force: true });
});

test("throws a clear error on malformed JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  writeFileSync(join(dir, "blaze.config.json"), "{ not json");
  assert.throws(() => loadConfig({ root: dir, env: {} }), /cannot parse/);
  rmSync(dir, { recursive: true, force: true });
});

test("commitMode defaults to per-op", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  const cfg = loadConfig({ root, env: {} });
  assert.equal(cfg.commitMode, "per-op");
  rmSync(root, { recursive: true, force: true });
});

test("commitMode is read from blaze.config.json", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ commitMode: "batch" }));
  const cfg = loadConfig({ root, env: {} });
  assert.equal(cfg.commitMode, "batch");
  rmSync(root, { recursive: true, force: true });
});

test("BLAZE_COMMIT_MODE env overrides the file", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ commitMode: "batch" }));
  const cfg = loadConfig({ root, env: { BLAZE_COMMIT_MODE: "per-op" } });
  assert.equal(cfg.commitMode, "per-op");
  rmSync(root, { recursive: true, force: true });
});

test("--get CLI reads the resolved data root's config, not the engine tree's own", () => {
  const data = mkdtempSync(join(tmpdir(), "blaze-get-"));
  const projectsDir = join(data, "projects");
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(join(data, "blaze.config.json"), JSON.stringify({ boardTitle: "Distinctive Board Title" }));
  const out = execFileSync(process.execPath, [join(REPO, "scripts", "config.mjs"), "--get", "boardTitle"], {
    cwd: REPO,
    env: { ...process.env, BLAZE_PROJECTS_DIR: projectsDir },
    encoding: "utf8",
  });
  assert.equal(out.trim(), "Distinctive Board Title");
  rmSync(data, { recursive: true, force: true });
});

test("loadConfig exposes schema:null when no schema block is present", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-schemacfg-"));
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({ key: "X" }));
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.schema, null);
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig passes through a schema override block", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-schemacfg-"));
  const schema = { types: { feature: { level: 0, workflow: "delivery", parentTypes: ["epic"], required: ["title"] } } };
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({ key: "X", schema }));
  const cfg = loadConfig({ root: dir, env: {} });
  assert.deepEqual(cfg.schema, schema);
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig normalizes a non-object schema to null", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-schemacfg-"));
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({ key: "X", schema: "nope" }));
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.schema, null);
  rmSync(dir, { recursive: true, force: true });
});

test("views config merges over all-on defaults and cannot disable board", () => {
  const dir = withConfig({ views: { map: false, board: false } });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.deepEqual(cfg.views, { board: true, list: true, live: true, metrics: true, map: false });
  // board: false in the file is overridden — the shell always needs its default view
  rmSync(dir, { recursive: true, force: true });
});

test("views defaults to all-on when no config file exists", () => {
  const dir = withConfig(null);
  const cfg = loadConfig({ root: dir, env: {} });
  assert.deepEqual(cfg.views, { board: true, list: true, live: true, metrics: true, map: true });
  rmSync(dir, { recursive: true, force: true });
});

test("loadProject exposes a per-project schema override (schema:null by default)", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-projschema-"));
  const projectsDir = join(root, "projects");
  mkdirSync(join(projectsDir, "ENG"), { recursive: true });
  let proj = loadProject("ENG", { root, projectsDir });
  assert.equal(proj.schema, null);
  const schema = { workflows: { kanban: { statuses: ["todo", "doing", "done"], terminal: ["done"], transitions: [["todo", "doing"], ["doing", "done"]], reopenTo: "todo", resolutionOnTerminal: { done: "done" } } } };
  writeFileSync(join(projectsDir, "ENG", "project.json"), JSON.stringify({ schema }));
  proj = loadProject("ENG", { root, projectsDir });
  assert.deepEqual(proj.schema, schema);
  rmSync(root, { recursive: true, force: true });
});

test("ambientSchemaOverride reads the top-level override from the data root", () => {
  const data = mkdtempSync(join(tmpdir(), "blaze-ambient-"));
  const projectsDir = join(data, "projects");
  mkdirSync(projectsDir, { recursive: true });
  const schema = { types: { feature: { level: 0, workflow: "delivery", parentTypes: ["epic"], required: ["title"] } } };
  writeFileSync(join(data, "blaze.config.json"), JSON.stringify({ key: "X", schema }));
  const got = ambientSchemaOverride({ env: { BLAZE_PROJECTS_DIR: projectsDir }, cwd: data });
  assert.deepEqual(got, schema);
  rmSync(data, { recursive: true, force: true });
});

test("ambientSchemaOverride returns null (never throws) when root resolution fails", () => {
  const throwing = () => { throw new Error("no data dir"); };
  assert.equal(ambientSchemaOverride({ resolveRoots: throwing }), null);
});

test("ambientSchemaOverride returns null when the data root has no schema block", () => {
  const data = mkdtempSync(join(tmpdir(), "blaze-ambient-none-"));
  const projectsDir = join(data, "projects");
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(join(data, "blaze.config.json"), JSON.stringify({ key: "X" }));
  const got = ambientSchemaOverride({ env: { BLAZE_PROJECTS_DIR: projectsDir }, cwd: data });
  assert.equal(got, null);
  rmSync(data, { recursive: true, force: true });
});

test("loadConfig throws blaze:-prefixed on a board stamped newer than the engine", () => {
  const dir = withConfig({ key: "X", schemaVersion: 99 });
  assert.throws(
    () => loadConfig({ root: dir, env: {} }),
    (e) =>
      e.message.startsWith("blaze: ") &&
      /board schemaVersion 99/.test(e.message) &&    // names the board's version
      /1\.\.1/.test(e.message) &&                    // names the engine's supported range
      /docs\/schema-versioning\.md/.test(e.message), // points at the docs, not a command
  );
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig throws on an invalid schemaVersion stamp", () => {
  const dir = withConfig({ key: "X", schemaVersion: "one" });
  // Quoted: the rendered value must read as a JSON string, not a bare word
  // (see the "1"-vs-1 regression test in tests/model/schema-config.test.mjs).
  assert.throws(() => loadConfig({ root: dir, env: {} }), /^Error: blaze: invalid schemaVersion "one"/);
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig accepts a board stamped with the current schema version", () => {
  const dir = withConfig({ key: "X", schemaVersion: 1 });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.key, "X");
  assert.equal(cfg.schemaVersion, 1); // stamp passes through onto the frozen cfg
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig accepts an un-versioned (legacy) config unchanged", () => {
  // Mirrors the compat-legacy fixture's exact shape — absent stamp = v1.
  const dir = withConfig({ key: "OBA", projects: ["OBA"], commitMode: "batch" });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.key, "OBA");
  assert.equal(cfg.schemaVersion, undefined);
  rmSync(dir, { recursive: true, force: true });
});
