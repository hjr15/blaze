// tests/matrices-check-observed.test.mjs — BLZ-714 (Plan B Task 4, R1): `matrices --check`
// with no directory to compare against exits 2 ("could not run"), never 1 (drift) and never 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, symlinkSync, mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "scripts", "cli.mjs");
const FIXTURE = join(HERE, "fixtures", "matrices-board");

function copy() {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz714-matrices-")));
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}
function matrices(root, args) {
  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") };
  for (const k of ["BLAZE_WRITE_PORT", "BLAZE_READONLY", "BLAZE_REMOTE_URL", "BLAZE_TOKEN", "BLAZE_TOKEN_FILE"]) delete env[k];
  return spawnSync(process.execPath, [CLI, "matrices", ...args], { encoding: "utf8", env });
}

test("BLZ-714: --check without the directory exits 2, never 1", () => {
  const root = copy();
  const missing = join(root, "no-such-dir");
  const r = matrices(root, ["--check", "--out", missing]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--check has nothing to compare against/);
  assert.match(r.stderr, /does not exist; render with --out <dir> instead/);
  assert.equal(existsSync(missing), false, "--check creates nothing");
});

test("BLZ-714: --check against a path that is a file, not a directory, exits 2", () => {
  const root = copy();
  const file = join(root, "afile");
  writeFileSync(file, "x");
  assert.equal(matrices(root, ["--check", "--out", file]).status, 2);
});

test("BLZ-714: --check against a rendered directory still passes", () => {
  const root = copy();
  const d = join(root, "d");
  assert.equal(matrices(root, ["--out", d]).status, 0);
  const r = matrices(root, ["--check", "--out", d]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /in sync/);
});

test("BLZ-714: --check against a changed file is still drift, exit 1", () => {
  const root = copy();
  const d = join(root, "d");
  matrices(root, ["--out", d]);
  const f = join(d, readdirSync(d)[0]);
  writeFileSync(f, readFileSync(f, "utf8") + "drift\n");
  const r = matrices(root, ["--check", "--out", d]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /MATRIX DRIFT/);
});

test("BLZ-714: --check with a stat error other than ENOENT (a symlink loop) exits 2, not a stack trace", () => {
  const root = copy();
  const loop = join(root, "loop");
  symlinkSync("loop", loop);
  const r = matrices(root, ["--check", "--out", loop]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--check has nothing to compare against/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
});

test("BLZ-714: project resolution comes first: --check --project TYPO --out missing exits 1", () => {
  const root = copy();
  const r = matrices(root, ["--check", "--project", "TYPO", "--out", join(root, "no-such-dir")]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /is not a project on this board/);
});
