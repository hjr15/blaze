// tests/export-runner.test.mjs — BLZ-627: `blaze export --format csv` CLI
// wiring. The decisions live in scripts/model/export-rows.mjs (tested in
// tests/model/export-rows.test.mjs); this pins the SUBCOMMANDS entry, the
// argument handling, and that the verb is genuinely read-only end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(REPO, "scripts", "cli.mjs");

// Cleanup via t.after(), not as the test's own trailing statement — see
// tests/model/export-rows.test.mjs's comment (BLZ-603).
function board(t) {
  const root = mkdtempSync(join(tmpdir(), "blaze-export-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "projects", "BLZ", "defined"), { recursive: true });
  writeFileSync(join(root, "projects", "BLZ", "defined", "BLZ-1.md"),
    "---\nid: BLZ-1\ntitle: t\ntype: task\nproject: BLZ\nestimate: 30\n---\n\nbody\n");
  return root;
}

function run(root, args) {
  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") };
  delete env.BLAZE_SESSION;
  return spawnSync(process.execPath, [cli, "export", ...args], { cwd: root, env, encoding: "utf8" });
}

test("blaze --help lists the export subcommand", () => {
  const r = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\bexport\b/);
});

test("blaze export --format csv prints the canonical header and the ticket row, exit 0", (t) => {
  const root = board(t);
  const r = run(root, ["--format", "csv"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^schema_version,id,project,type,status,title,description,/);
  assert.match(lines[1], /^1,BLZ-1,BLZ,task,defined,t,/);
});

test("blaze export with no --format is refused, exit non-zero, nothing on stdout", (t) => {
  const root = board(t);
  const r = run(root, []);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /--format/);
});

test("blaze export --format json (unsupported) is refused, exit non-zero", (t) => {
  const root = board(t);
  const r = run(root, ["--format", "json"]);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
});

test("blaze export is read-only: BLAZE_READONLY=1 does not block it (mutates: false)", (t) => {
  const root = board(t);
  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects"), BLAZE_READONLY: "1" };
  delete env.BLAZE_SESSION;
  const r = spawnSync(process.execPath, [cli, "export", "--format", "csv"], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^schema_version,/);
});

test("blaze export refuses the whole export and names the ticket + key when a ticket carries an unknown frontmatter key", (t) => {
  const root = board(t);
  writeFileSync(join(root, "projects", "BLZ", "defined", "BLZ-2.md"),
    "---\nid: BLZ-2\ntitle: t2\ntype: task\nproject: BLZ\nestimate: 5\nsurprise_key: x\n---\n\nbody\n");
  const r = run(root, ["--format", "csv"]);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /BLZ-2/);
  assert.match(r.stderr, /surprise_key/);
});

test("blaze export --help prints subcommand help and exits 0 without spawning the runner", () => {
  const r = spawnSync(process.execPath, [cli, "export", "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /export/i);
});
