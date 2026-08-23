// tests/reindex.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../scripts/reindex.mjs", import.meta.url));

test("reindex runner builds .blaze/index.json and prints a count", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-reidx-"));
  mkdirSync(join(root, "projects", "OBA", "todo"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "todo", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\n---\nbody\n");
  const r = spawnSync(process.execPath, [runner, join(root, "projects")],
    { encoding: "utf8", env: { ...process.env, BLAZE_DB_DIR: join(root, ".blaze") } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /indexed 1 ticket/);
  const out = join(root, ".blaze", "index.json");
  assert.ok(existsSync(out));
  assert.equal(JSON.parse(readFileSync(out, "utf8")).tickets[0].id, "OBA-1");
  rmSync(root, { recursive: true, force: true });
});

test("reindex prints link warnings for a malformed link key", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-reindex-"));
  const dir = join(root, "projects", "OBA", "defined");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "OBA-1.md"),
    "---\nid: OBA-1\ntype: task\nproject: OBA\ntitle: t\npriority: medium\n" +
    "links:\n  - { type: Blocks, to: OBA-2 }\n---\n\nbody\n");
  const r = spawnSync(process.execPath, [runner, join(root, "projects")],
    { env: { ...process.env, BLAZE_DB_DIR: join(root, ".blaze") }, encoding: "utf8" });
  assert.match((r.stdout || "") + (r.stderr || ""), /target:/);
  rmSync(root, { recursive: true, force: true });
});

test("reindex fails loud on a board stamped newer than the engine", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-reidx-ver-"));
  mkdirSync(join(root, "projects", "OBA", "todo"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "todo", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\n---\nbody\n");
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "OBA", projects: ["OBA"], schemaVersion: 99 }));
  // cwd = the stamped board root, so resolveRoots picks it as dataRoot:
  const r = spawnSync(process.execPath, [runner],
    { cwd: root, encoding: "utf8", env: { ...process.env, BLAZE_DB_DIR: join(root, ".blaze") } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /blaze reindex failed: blaze: board schemaVersion 99/);
  assert.match(r.stderr, /docs\/schema-versioning\.md/);
  assert.ok(!existsSync(join(root, ".blaze", "index.json")), "no index written for an incompatible board");
  rmSync(root, { recursive: true, force: true });
});

test("reindex works normally on a board stamped with the current schema version", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-reidx-ver-ok-"));
  mkdirSync(join(root, "projects", "OBA", "todo"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "todo", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\n---\nbody\n");
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "OBA", projects: ["OBA"], schemaVersion: 1 }));
  const r = spawnSync(process.execPath, [runner],
    { cwd: root, encoding: "utf8", env: { ...process.env, BLAZE_DB_DIR: join(root, ".blaze") } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /indexed 1 ticket/);
  rmSync(root, { recursive: true, force: true });
});

// BLZ-107: `blaze reindex <dir>` retargets the board being indexed, so the
// schemaVersion guard must follow the target. Guarding the CWD-resolved data
// root instead validates one board's stamp while indexing a different one —
// the exact silent-wrongness the guard exists to prevent, through a door the
// guard wasn't standing at.
function twoBoards() {
  const good = mkdtempSync(join(tmpdir(), "blaze-reidx-good-"));
  mkdirSync(join(good, "projects", "GOO", "todo"), { recursive: true });
  writeFileSync(join(good, "projects", "GOO", "todo", "GOO-1.md"),
    "---\nid: GOO-1\ntitle: t\ntype: task\nproject: GOO\n---\nbody\n");
  writeFileSync(join(good, "blaze.config.json"),
    JSON.stringify({ key: "GOO", projects: ["GOO"], schemaVersion: 1 }));
  const bad = mkdtempSync(join(tmpdir(), "blaze-reidx-bad-"));
  mkdirSync(join(bad, "projects", "BAD", "todo"), { recursive: true });
  writeFileSync(join(bad, "projects", "BAD", "todo", "BAD-1.md"),
    "---\nid: BAD-1\ntitle: t\ntype: task\nproject: BAD\n---\nbody\n");
  writeFileSync(join(bad, "blaze.config.json"),
    JSON.stringify({ key: "BAD", projects: ["BAD"], schemaVersion: 99 }));
  return { good, bad };
}

// The env the two-board tests run under: no ambient BLAZE_PROJECTS_DIR to
// out-rank the argv target, and no BLAZE_DB_DIR pin — the dbDir must be
// derived from whichever data root the run resolves, so a misdirected write
// lands somewhere the assertions can see it.
const cleanEnv = { ...process.env, BLAZE_PROJECTS_DIR: "", BLAZE_DB_DIR: "" };

test("reindex <dir> validates the TARGET board's schemaVersion, not the cwd board's", () => {
  const { good, bad } = twoBoards();
  const r = spawnSync(process.execPath, [runner, join(bad, "projects")],
    { cwd: good, encoding: "utf8", env: cleanEnv });
  assert.equal(r.status, 1, `expected failure, got stdout: ${r.stdout}`);
  assert.match(r.stderr, /blaze reindex failed: blaze: board schemaVersion 99/);
  assert.ok(!existsSync(join(bad, ".blaze", "index.json")),
    "no index written for the incompatible target board");
  assert.ok(!existsSync(join(good, ".blaze", "index.json")),
    "the target board's tickets must not be indexed into the cwd board either");
  rmSync(good, { recursive: true, force: true });
  rmSync(bad, { recursive: true, force: true });
});

test("reindex <dir> indexes a compatible target board from an unrelated cwd", () => {
  const { good, bad } = twoBoards();
  // Re-stamp the second board as compatible: the guard must follow the target
  // in BOTH directions — a good target still indexes from a foreign cwd.
  writeFileSync(join(bad, "blaze.config.json"),
    JSON.stringify({ key: "BAD", projects: ["BAD"], schemaVersion: 1 }));
  const r = spawnSync(process.execPath, [runner, join(bad, "projects")],
    { cwd: good, encoding: "utf8", env: cleanEnv });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /indexed 1 ticket/);
  const out = join(bad, ".blaze", "index.json");
  assert.ok(existsSync(out), "index must land under the target board's data root");
  assert.equal(JSON.parse(readFileSync(out, "utf8")).tickets[0].id, "BAD-1");
  rmSync(good, { recursive: true, force: true });
  rmSync(bad, { recursive: true, force: true });
});

test("reindex <dir> still works when the target board has no config at all", () => {
  const { good, bad } = twoBoards();
  rmSync(join(bad, "blaze.config.json"));
  const r = spawnSync(process.execPath, [runner, join(bad, "projects")],
    { cwd: good, encoding: "utf8", env: cleanEnv });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /indexed 1 ticket/);
  rmSync(good, { recursive: true, force: true });
  rmSync(bad, { recursive: true, force: true });
});
