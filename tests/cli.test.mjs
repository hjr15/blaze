// tests/cli.test.mjs — BLZ-119: cli.mjs must handle --help/-h AT DISPATCH,
// before any runner spawns. This is what stops an unrecognised flag falling
// through to a real mutation (the original bug), and guarantees a future
// subcommand can't ship without help by omission.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEntry, ledgerPath } from "../scripts/pending-ledger.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(REPO, "scripts", "cli.mjs");

test("blaze --help prints the full usage listing (all subcommands) and exits 0", () => {
  const r = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: blaze/);
  for (const name of ["reconcile", "sprint", "commit", "migrate", "rollup"]) {
    assert.match(r.stdout, new RegExp(`\\b${name}\\b`));
  }
});

test("blaze -h prints the full usage listing and exits 0", () => {
  const r = spawnSync(process.execPath, [cli, "-h"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: blaze/);
});

test("blaze commit --help prints subcommand help, exits 0, and never spawns the runner", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cli-help-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "seed"), "seed");
  execFileSync("git", ["-C", root, "add", "seed"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-1.md"), "x");
  appendEntry(root, { id: "OBA-1", op: "new", message: "OBA-1: x", files: ["projects/OBA/backlog/OBA-1.md"], ts: "t" });
  const queue = ledgerPath(root);
  const beforeBytes = readFileSync(queue);
  const beforeHead = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") };
  delete env.BLAZE_SESSION;
  const r = spawnSync(process.execPath, [cli, "commit", "--help"], { cwd: root, env, encoding: "utf8" });

  assert.equal(r.status, 0);
  assert.match(r.stdout, /commit/i);
  assert.deepEqual(readFileSync(queue), beforeBytes, "runner must never have run — queue byte-identical");
  assert.equal(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), beforeHead, "HEAD must not move");
  rmSync(root, { recursive: true, force: true });
});

test("blaze new -h prints subcommand help and exits 0 without creating a ticket", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cli-help-new-"));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"], commitMode: "batch" }));
  mkdirSync(join(root, "projects", "OBA"), { recursive: true });
  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") };
  const r = spawnSync(process.execPath, [cli, "new", "-h"], { env, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /new/i);
  assert.ok(!existsSync(join(root, "projects", "OBA", "defined")), "no ticket dir must have been created");
  rmSync(root, { recursive: true, force: true });
});

test("blaze sprint --help prints subcommand help, exits 0, and never spawns the runner", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cli-help-sprint-"));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"], commitMode: "batch" }));
  mkdirSync(join(root, "projects", "OBA"), { recursive: true });
  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") };
  const r = spawnSync(process.execPath, [cli, "sprint", "--help"], { env, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /sprint/i);
  assert.ok(!existsSync(join(root, "sprints.json")), "runner must never have run — no sprints.json written");
  rmSync(root, { recursive: true, force: true });
});

test("blaze bogus-command --help falls back to the full usage and exits non-zero", () => {
  const r = spawnSync(process.execPath, [cli, "bogus-command", "--help"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /usage: blaze/);
});

test("blaze <unknown> still prints usage and exits non-zero (unchanged behaviour)", () => {
  const r = spawnSync(process.execPath, [cli, "bogus-command"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /usage: blaze/);
});

// Shared table-parsing helper: evaluates SUBCOMMANDS as a plain object
// literal (strings/booleans only, no imports) straight out of cli.mjs's
// source — never executes cli.mjs itself.
function parseSubcommands(src) {
  const m = src.match(/const SUBCOMMANDS = (\{[\s\S]*?\n\});/);
  assert.ok(m, "SUBCOMMANDS table not found in cli.mjs");
  return new Function(`return ${m[1]}`)();
}

// No-arg dispatch still wires to supervisor.mjs (unchanged): asserted
// against the dispatch TABLE, not a source regex on the ternary expression
// that resolves the key — a regex on `cmd === undefined ? "start" : cmd`
// breaks on a harmless refactor of that line's wording, and would still pass
// even if SUBCOMMANDS.start.file pointed at the wrong script (the regex only
// checks the key resolves to "start", never what "start" actually runs).
// Asserted at the source level rather than by executing it — supervisor.mjs
// starts a real server/loop and must never be spawned from a test.
test("blaze with no args still dispatches to supervisor.mjs (source-level guard)", () => {
  const src = readFileSync(cli, "utf8");
  const SUBCOMMANDS = parseSubcommands(src);
  assert.equal(SUBCOMMANDS.start.file, "supervisor.mjs");
});

// BLZ-121: SUBCOMMANDS is the single dispatch table (the switch was collapsed
// into it) — every entry must declare mutates:boolean so BLAZE_READONLY has a
// complete, source-verifiable classification to gate on.
test("every SUBCOMMANDS entry declares mutates: boolean", () => {
  const src = readFileSync(cli, "utf8");
  const SUBCOMMANDS = parseSubcommands(src);
  for (const [name, entry] of Object.entries(SUBCOMMANDS)) {
    assert.equal(typeof entry.mutates, "boolean", `${name}: mutates must be a boolean`);
  }
});

// Finding 3 (code-review, LOW): SUBCOMMANDS[cmd] resolves inherited
// Object.prototype keys ("constructor", "toString", "__proto__", ...) as a
// truthy `sub`, so the `if (!sub)` usage-fallback path never fires for them.
// Not exploitable (join(here, undefined) throws before spawnSync — no runner
// ever spawns), but it's the same class BLZ-119 exists to close: an
// unrecognised command must print usage and exit non-zero, cleanly — not a
// raw TypeError stack trace, and not a bogus "usage: blaze __proto__" with
// exit 0.
test("blaze constructor (an inherited Object.prototype key) prints usage and exits non-zero", () => {
  const r = spawnSync(process.execPath, [cli, "constructor"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /usage: blaze/);
  assert.doesNotMatch(r.stderr, /TypeError/);
});

test("blaze __proto__ --help (an inherited Object.prototype key) prints usage and exits non-zero", () => {
  const r = spawnSync(process.execPath, [cli, "__proto__", "--help"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /usage: blaze/);
});
