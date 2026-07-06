import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../scripts/config.mjs";

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
