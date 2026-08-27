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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

  test("blaze start (supervisor.mjs, LONG-RUNNING) refuses at the preflight and never binds a port", () => {
    // supervisor.mjs's own CLI block calls `loadConfig` unwrapped, with NO local catch of
    // its own (unlike new/move/edit/... which this ticket also patched directly) — so this
    // is the one case in this file where the FIX BEING TESTED IS SPECIFICALLY cli.mjs's
    // central preflight catch, not a redundant per-runner one. Without it, `cli.mjs` would
    // silently swallow the throw (old behaviour) and still spawn supervisor.mjs, which
    // would then crash raw AFTER already trying to bind a port — worse than the other
    // cases here, not merely a stack trace. spawnSync completing at all (rather than
    // hanging until the timeout) is itself part of the proof: a supervisor that actually
    // started serving would never exit on its own.
    const root = board({ key: "eng" });
    try {
      const r = spawnSync(process.execPath, [CLI, "start"],
        { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8", timeout: 5000 });
      assert.notEqual(r.signal, "SIGTERM", "spawnSync's own timeout fired — the server never exited on its own");
      assertCleanRefusal(r, "blaze start on a board with key 'eng'");
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

  test("a badly-named DIRECTORY on disk (not in cfg.projects) is silently skipped, not refused", () => {
    // BLZ-402 round-2 review finding 1. An earlier revision of this file asserted the
    // OPPOSITE of what is asserted here: it re-threw `InvalidProjectKeyError` out of
    // cli.mjs's preflight per-project loop whenever a disk-listed directory (the fallback
    // that fires whenever `blaze.config.json` carries no `projects` array — see
    // `fsReadStorage.listProjects`) had a name `assertValidKey` rejects, and this test used
    // `A(` — a name so obviously not a project key that the resulting refusal looked like
    // the correct, intended behaviour. It hid the actual blast radius: the per-project loop
    // runs on EVERY board with no configured `projects` array, and `assertValidKey` rejects
    // any name that isn't `^[A-Z][A-Z0-9]*$` — so an entirely ordinary, common directory
    // name (`archive`, `notes`, `_templates`, `old-eng`, `docs`, `v2`, ...) bricked every
    // non-exempt verb on such a board, while `blaze audit` kept calling it clean. The
    // dedicated regression test below uses `archive` for exactly that reason. The swallow
    // this test now pins (`catch { projects[k] = null }`) was born deliberately with BLZ-56
    // (`6ce5c3a`, #125): a directory whose name is not a project key is not a project, and
    // schema-validating it is not this preflight's job.
    const root = mkdtempSync(join(tmpdir(), "blz402-cli-refusal-disk-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", root, "config", "user.name", "t"]);
    mkdirSync(join(root, "projects", "A(", "backlog"), { recursive: true });
    writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "ENG" }));
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
    try {
      const r = spawnSync(process.execPath, [CLI, "rollup"],
        { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });
      assert.equal(r.status, 0,
        `a badly-named disk directory must not brick the verb:\nstdout:${r.stdout}\nstderr:${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("BLZ-402 round-2 finding 1: an ORDINARY non-project directory under projects/ "
    + "(e.g. 'archive/') does not brick blaze rollup, and audit agrees the board is clean", () => {
    // The reproduction from the round-2 review: board { key: "ENG" } with no `projects`
    // array (so the per-project loop's key list comes from the disk listing), one real
    // ticket under projects/ENG, and a second, completely ordinary directory
    // `projects/archive/` that is not, and was never meant to be, a project. Before this
    // fix `blaze rollup ENG-1` exited 1 on this board even though `blaze audit` reported
    // `ok=true` on the very same board — "a check that disagrees with audit on the same
    // board is worse than no check at all" (cli.mjs's own outer-catch comment).
    const root = mkdtempSync(join(tmpdir(), "blz402-cli-refusal-archive-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", root, "config", "user.name", "t"]);
    mkdirSync(join(root, "projects", "ENG", "backlog"), { recursive: true });
    mkdirSync(join(root, "projects", "archive"), { recursive: true });
    writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "ENG" }));
    writeFileSync(join(root, "projects", "ENG", "backlog", "ENG-1-x.md"),
      ["---", "id: ENG-1", 'title: "x"', "type: task", "project: ENG", "status: backlog",
       "estimate: 30", "---", ""].join("\n"));
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
    try {
      const rollup = spawnSync(process.execPath, [CLI, "rollup", "ENG-1"],
        { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });
      assert.equal(rollup.status, 0,
        `blaze rollup ENG-1 with an ordinary 'archive/' directory present:\nstdout:${rollup.stdout}\nstderr:${rollup.stderr}`);
      const audit = spawnSync(process.execPath, [CLI, "audit"],
        { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });
      assert.match(audit.stdout, /ok=true/,
        `audit must agree the board is clean:\n${audit.stdout}\n${audit.stderr}`);
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

  test("a CORRUPT ticket file (project: 'A(' in frontmatter, hand-edited outside blaze) refuses"
    + " cleanly on an otherwise-healthy board", () => {
    // `edit.mjs`'s `applyEdit` -> `loadProject(fm.project, ...)` is unwrapped (unlike
    // move.mjs's equivalent call, which already falls back to a default on ANY failure) —
    // this is the actually-reproduced crash site for a per-TICKET bad key, as opposed to a
    // per-BOARD one. `cli.mjs`'s preflight cannot see this: it only validates the board's
    // configured project set, never a ticket's own frontmatter.
    const root = board(); // healthy board — ENG is a real, validly-keyed project
    try {
      const file = join(root, "projects", "ENG", "backlog", "ENG-1-x.md");
      writeFileSync(file, readFileSync(file, "utf8").replace("project: ENG", "project: A("));
      const r = spawnSync(process.execPath, [CLI, "edit", "ENG-1", "title", "new title"],
        { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });
      assertCleanRefusal(r, "blaze edit on a ticket with a corrupt project field");
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
