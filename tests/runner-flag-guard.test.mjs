// tests/runner-flag-guard.test.mjs — BLZ-119: an unrecognised flag was
// previously silently swallowed by several mutating runners (the runner
// inspected only the one flag it cared about, with no rejection loop), so an
// agent probing the CLI for its interface could trigger a real write. Each
// test here proves an unknown flag now exits non-zero and mutates nothing,
// while every flag the runner already supports keeps working.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runnerPath = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));

// A throwaway DATA dir: blaze.config.json (batch mode → no git needed) +
// projects/OBA/<status>/OBA-n.md. Mirrors link-runner.test.mjs's fixture.
function dataRepo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-flagguard-"));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "OBA", projects: ["OBA"], commitMode: "batch" }));
  const dir = join(root, "projects", "OBA", "in-progress");
  mkdirSync(dir, { recursive: true });
  const tk = (id) => `---\nid: ${id}\ntype: task\nproject: OBA\ntitle: ${id}\npriority: medium\nestimate: 30\n---\n\nbody\n`;
  writeFileSync(join(dir, "OBA-1.md"), tk("OBA-1"));
  writeFileSync(join(dir, "OBA-2.md"), tk("OBA-2"));
  return root;
}
const run = (name, root, args, extraEnv = {}) => spawnSync(process.execPath, [runnerPath(name), ...args],
  { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects"), ...extraEnv }, encoding: "utf8" });

// --- reconcile.mjs ------------------------------------------------------------
test("blaze reconcile rejects an unknown flag and does not touch the ticket", () => {
  const root = dataRepo();
  const before = readFileSync(join(root, "projects", "OBA", "in-progress", "OBA-1.md"));
  const r = run("reconcile.mjs", root, ["--bogus"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag: --bogus/);
  assert.deepEqual(readFileSync(join(root, "projects", "OBA", "in-progress", "OBA-1.md")), before);
  rmSync(root, { recursive: true, force: true });
});

test("blaze reconcile still honours --apply/--fetch/--quiet (no unknown-flag regression)", () => {
  const root = dataRepo();
  const r = run("reconcile.mjs", root, ["--quiet"]);
  assert.equal(r.status, 0, r.stderr);
  rmSync(root, { recursive: true, force: true });
});

// --- reindex.mjs ---------------------------------------------------------------
test("blaze reindex rejects an unknown flag and writes no index", () => {
  const root = dataRepo();
  const r = spawnSync(process.execPath, [runnerPath("reindex.mjs"), "--bogus"],
    { env: { ...process.env, BLAZE_DB_DIR: join(root, ".blaze") }, cwd: root, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag: --bogus/);
  assert.ok(!existsSync(join(root, ".blaze", "index.json")));
  rmSync(root, { recursive: true, force: true });
});

test("blaze reindex still accepts a positional projectsDir override (no unknown-flag regression)", () => {
  const root = dataRepo();
  const r = spawnSync(process.execPath, [runnerPath("reindex.mjs"), join(root, "projects")],
    { env: { ...process.env, BLAZE_DB_DIR: join(root, ".blaze") }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /indexed 2 tickets/);
  rmSync(root, { recursive: true, force: true });
});

// --- move-runner.mjs -----------------------------------------------------------
test("blaze move rejects an unknown flag and does not relocate the ticket", () => {
  const root = dataRepo();
  const r = run("move-runner.mjs", root, ["OBA-1", "in-review", "--bogus"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag: --bogus/);
  assert.ok(existsSync(join(root, "projects", "OBA", "in-progress", "OBA-1.md")), "ticket must not have moved");
  assert.ok(!existsSync(join(root, "projects", "OBA", "in-review")), "no in-review/ dir must have been created");
  rmSync(root, { recursive: true, force: true });
});

test("blaze move still relocates on a valid call (no unknown-flag regression)", () => {
  const root = dataRepo();
  const r = run("move-runner.mjs", root, ["OBA-1", "in-review"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(root, "projects", "OBA", "in-review", "OBA-1.md")));
  rmSync(root, { recursive: true, force: true });
});

// --- edit-runner.mjs -------------------------------------------------------
// edit-runner's 3rd+ args are a genuinely freeform VALUE (e.g. a title or
// note text), so only the id/field selector positions are flag-guarded — a
// value that happens to start with "--" must still work (regression below).
test("blaze edit rejects a flag-like id and does not edit any ticket", () => {
  const root = dataRepo();
  const before = readFileSync(join(root, "projects", "OBA", "in-progress", "OBA-1.md"));
  const r = run("edit-runner.mjs", root, ["--bogus", "priority", "high"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag: --bogus/);
  assert.deepEqual(readFileSync(join(root, "projects", "OBA", "in-progress", "OBA-1.md")), before);
  rmSync(root, { recursive: true, force: true });
});

test("blaze edit still edits on a valid call, including a value starting with -- (no regression)", () => {
  const root = dataRepo();
  const r = run("edit-runner.mjs", root, ["OBA-1", "title", "--not-a-flag"]);
  assert.equal(r.status, 0, r.stderr);
  const txt = readFileSync(join(root, "projects", "OBA", "in-progress", "OBA-1.md"), "utf8");
  assert.match(txt, /title: --not-a-flag/);
  rmSync(root, { recursive: true, force: true });
});

// --- link-runner.mjs -------------------------------------------------------
test("blaze link rejects an unknown flag and does not add a link", () => {
  const root = dataRepo();
  const before = readFileSync(join(root, "projects", "OBA", "in-progress", "OBA-1.md"));
  const r = run("link-runner.mjs", root, ["--bogus", "OBA-1", "Blocks", "OBA-2"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag: --bogus/);
  assert.deepEqual(readFileSync(join(root, "projects", "OBA", "in-progress", "OBA-1.md")), before);
  rmSync(root, { recursive: true, force: true });
});

test("blaze link still supports --rm (no unknown-flag regression)", () => {
  const root = dataRepo();
  const add = run("link-runner.mjs", root, ["OBA-1", "Blocks", "OBA-2"]);
  assert.equal(add.status, 0, add.stderr);
  const rm = run("link-runner.mjs", root, ["--rm", "OBA-1", "Blocks", "OBA-2"]);
  assert.equal(rm.status, 0, rm.stderr);
  const txt = readFileSync(join(root, "projects", "OBA", "in-progress", "OBA-1.md"), "utf8");
  assert.doesNotMatch(txt, /type: Blocks, target: OBA-2/);
  rmSync(root, { recursive: true, force: true });
});

// --- resolve-runner.mjs -----------------------------------------------------
test("blaze resolve rejects an unknown flag and does not set a resolution", () => {
  const root = dataRepo();
  const before = readFileSync(join(root, "projects", "OBA", "in-progress", "OBA-1.md"));
  const r = run("resolve-runner.mjs", root, ["OBA-1", "wont-do", "--bogus"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag: --bogus/);
  assert.deepEqual(readFileSync(join(root, "projects", "OBA", "in-progress", "OBA-1.md")), before);
  rmSync(root, { recursive: true, force: true });
});

test("blaze resolve still sets a resolution on a valid call (no unknown-flag regression)", () => {
  const root = dataRepo();
  const r = run("resolve-runner.mjs", root, ["OBA-1", "wont-do"]);
  assert.equal(r.status, 0, r.stderr);
  const txt = readFileSync(join(root, "projects", "OBA", "in-progress", "OBA-1.md"), "utf8");
  assert.match(txt, /resolution: wont-do/);
  rmSync(root, { recursive: true, force: true });
});

// --- migrate-runner.mjs ------------------------------------------------------
test("blaze migrate rejects an unknown flag and writes no migration output", () => {
  const root = dataRepo();
  const r = run("migrate-runner.mjs", root, ["--bogus"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag: --bogus/);
  assert.ok(!existsSync(join(root, "migration")), "no migration/ dir must have been written");
  rmSync(root, { recursive: true, force: true });
});

test("blaze migrate still honours --project/--merge (dry-run, no unknown-flag regression)", () => {
  const root = dataRepo();
  mkdirSync(join(root, ".migration-cache"), { recursive: true });
  writeFileSync(join(root, ".migration-cache", "OBA.json"), JSON.stringify([]));
  const r = run("migrate-runner.mjs", root, ["--project", "OBA", "--merge"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(root, "migration", "MIGRATION-AUDIT.md")));
  rmSync(root, { recursive: true, force: true });
});

// --- sprint-runner.mjs -------------------------------------------------------
// `new` already guards its flags (verified in source); `list` and `active`
// did not.
test("blaze sprint active rejects an unknown flag and does not change sprints.json", () => {
  const root = dataRepo();
  const r = run("sprint-runner.mjs", root, ["active", "S1", "--bogus"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag: --bogus/);
  assert.ok(!existsSync(join(root, "sprints.json")), "sprints.json must not have been written");
  rmSync(root, { recursive: true, force: true });
});

test("blaze sprint new/active still work end to end (no unknown-flag regression)", () => {
  const root = dataRepo();
  const created = run("sprint-runner.mjs", root, ["new", "Sprint One", "--start", "2026-01-01", "--end", "2026-01-14"]);
  assert.equal(created.status, 0, created.stderr);
  const id = created.stdout.match(/created (\S+)/)[1];
  const activated = run("sprint-runner.mjs", root, ["active", id]);
  assert.equal(activated.status, 0, activated.stderr);
  assert.match(activated.stdout, new RegExp(`active sprint: ${id}`));
  rmSync(root, { recursive: true, force: true });
});

test("blaze sprint list rejects an unknown flag", () => {
  const root = dataRepo();
  const r = run("sprint-runner.mjs", root, ["list", "--bogus"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag: --bogus/);
  rmSync(root, { recursive: true, force: true });
});

test("blaze sprint list still works with no args (no unknown-flag regression)", () => {
  const root = dataRepo();
  const r = run("sprint-runner.mjs", root, ["list"]);
  assert.equal(r.status, 0, r.stderr);
  rmSync(root, { recursive: true, force: true });
});

// --- rollup-runner.mjs (read-only; guarded for consistency, not required) ---
test("blaze rollup rejects an unknown flag", () => {
  const root = dataRepo();
  const r = run("rollup-runner.mjs", root, ["--bogus"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag: --bogus/);
  rmSync(root, { recursive: true, force: true });
});

test("blaze rollup still prints a summary with no args (no unknown-flag regression)", () => {
  const root = dataRepo();
  const r = run("rollup-runner.mjs", root, []);
  assert.equal(r.status, 0, r.stderr);
  rmSync(root, { recursive: true, force: true });
});
