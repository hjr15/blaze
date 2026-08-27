// tests/cli-key-refusal.test.mjs — BLZ-402 review finding 3.
//
// The PR body claimed "a metacharacter key now yields a `blaze: …` refusal rather than a
// raw `SyntaxError`". Only the exception's CLASS had changed — `InvalidProjectKeyError`
// instead of `SyntaxError` — and it still reached the operator as an unhandled top-level
// throw: a raw Node stack trace and a "Node.js vNN.N.N" footer, for both `blaze new
// --project 'A(' ...` (an unconfigured --project value, reached inside `applyNew`) and a
// board whose OWN `key` field is malformed (reached at `cli.mjs`'s schema preflight, which
// calls `loadConfig` unwrapped, and again inside whichever runner it spawns).
//
// SUBPROCESS tests throughout, for the same reason every other BLZ-402-review test file is
// one: the property under test is "does the operator ever see a raw stack trace", and an
// in-process `assert.throws` on the exception object cannot see what happens when nothing
// catches it at the real top level.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const NEW_RUNNER = fileURLToPath(new URL("../scripts/new-runner.mjs", import.meta.url));
const MOVE_RUNNER = fileURLToPath(new URL("../scripts/move-runner.mjs", import.meta.url));

function board({ key = "ENG", projects = ["ENG"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "blz402-cli-refusal-"));
  // allocateId requires a git worktree to reserve ids safely.
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  mkdirSync(join(root, "projects", "ENG", "backlog"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key, projects }));
  writeFileSync(join(root, "projects", "ENG", "backlog", "ENG-1-x.md"),
    ["---", "id: ENG-1", 'title: "x"', "type: task", "project: ENG", "status: backlog",
     "estimate: 30", "---", ""].join("\n"));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

const NO_STACK = /\n\s*at /;
const NO_NODE_FOOTER = /Node\.js v/;

function assertCleanRefusal(r, label) {
  assert.equal(r.status, 1, `${label}: expected exit 1, got ${r.status}\nstdout:${r.stdout}\nstderr:${r.stderr}`);
  assert.match(r.stderr, /^blaze: /m, `${label}: stderr must carry a blaze: refusal\nstderr:${r.stderr}`);
  assert.doesNotMatch(r.stderr, NO_STACK, `${label}: a stack frame leaked to stderr\nstderr:${r.stderr}`);
  assert.doesNotMatch(r.stderr, NO_NODE_FOOTER, `${label}: the raw Node.js version footer leaked\nstderr:${r.stderr}`);
}

describe("BLZ-402 review finding 3: a project-key refusal never reaches the operator as a raw stack trace", () => {
  test("blaze new --project 'A(' ... (an unconfigured --project value)", () => {
    const root = board();
    try {
      const r = spawnSync(process.execPath,
        [CLI, "new", "--project", "A(", "--type", "task", "--estimate", "30", "x"],
        { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });
      assertCleanRefusal(r, "blaze new --project 'A('");
      assert.match(r.stderr, /"A\("/, "the offending key must be named");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a malformed BOARD key ('eng') refuses at cli.mjs's preflight before the runner ever spawns", () => {
    const root = board({ key: "eng" });
    try {
      const r = spawnSync(process.execPath,
        [CLI, "new", "--project", "ENG", "--type", "task", "--estimate", "30", "x"],
        { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });
      assertCleanRefusal(r, "blaze new on a board with key 'eng'");
      assert.match(r.stderr, /"eng"/, "the offending key must be named");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the same malformed board key refuses cleanly for a DIFFERENT non-exempt verb (blaze move)", () => {
    // Proves the fix is at the shared preflight, not special-cased to `new`.
    const root = board({ key: "eng" });
    try {
      const r = spawnSync(process.execPath, [CLI, "move", "ENG-1", "in-progress"],
        { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });
      assertCleanRefusal(r, "blaze move on a board with key 'eng'");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("blaze audit is EXEMPT from the preflight and must keep reporting, not refuse at dispatch", () => {
    // Control: audit's whole job is to REPORT this class of problem (BLZ-402 review
    // finding 1), so cli.mjs must not intercept it before it ever runs.
    const root = board({ key: "eng" });
    try {
      const r = spawnSync(process.execPath, [CLI, "audit"],
        { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });
      assert.match(r.stdout, /config-unloadable|ok=false/, `audit must still produce a report:\n${r.stdout}\n${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a healthy board is unaffected — blaze new still creates a ticket", () => {
    const root = board();
    try {
      const r = spawnSync(process.execPath,
        [CLI, "new", "--project", "ENG", "--type", "task", "--estimate", "30", "x"],
        { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects"), BLAZE_COMMIT_MODE: "batch" }, encoding: "utf8" });
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("direct invocation (bypassing cli.mjs) of new-runner.mjs on a bad --project also refuses cleanly", () => {
    const root = board();
    try {
      const r = spawnSync(process.execPath,
        [NEW_RUNNER, "--project", "A(", "--type", "task", "--estimate", "30", "x"],
        { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });
      assertCleanRefusal(r, "direct node new-runner.mjs --project 'A('");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("direct invocation (bypassing cli.mjs) of move-runner.mjs on a bad board key refuses cleanly", () => {
    const root = board({ key: "eng" });
    try {
      const r = spawnSync(process.execPath, [MOVE_RUNNER, "ENG-1", "in-progress"],
        { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });
      assertCleanRefusal(r, "direct node move-runner.mjs on a board with key 'eng'");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
