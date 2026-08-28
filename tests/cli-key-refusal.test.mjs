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
const script = (rel) => fileURLToPath(new URL(`../scripts/${rel}`, import.meta.url));

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
      // BLZ-408's other half: making the message honest for the ticket-frontmatter callers
      // must not cost the one caller that really does hold a --project argument its accuracy.
      assert.match(r.stderr, /a --project argument/,
        `this invocation DID pass --project; the refusal must still say so:\n${r.stderr}`);
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
      // BLZ-408: and it must send the operator to the FILE that is wrong. Before this the
      // refusal read "a --project argument" — a flag this invocation does not carry — so the
      // one message the operator gets named the wrong thing to fix.
      assert.match(r.stderr, /ticket ENG-1's 'project' field/,
        `the refusal must name the ticket's own field:\n${r.stderr}`);
      assert.doesNotMatch(r.stderr, /--project/,
        `no --project argument was passed; the refusal must not claim one:\n${r.stderr}`);
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

// --- BLZ-419: the eight per-runner key-refusal guards nothing pinned ----------------------
//
// BLZ-402 added a local `catch (e) { if (e instanceof InvalidProjectKeyError) ... }` to
// ELEVEN runner files. Three of them were pinned by the describe above — `new-runner`
// (`--project 'A('`), `move-runner` (a direct invocation on a bad board key), and
// `edit-runner` (a corrupt ticket's `project:` field). The other eight had no test at all,
// on any board, which is how a guard becomes decoration.
//
// EVERY ONE OF THE EIGHT IS REACHABLE, and reachability was checked before the tests were
// written rather than assumed — each was driven to its refusal by hand on a board with
// `key: "eng"` before a line of this block existed. They are all the same shape: the
// runner's own top-level `loadConfig({ root: dataRoot })`, which `cli.mjs`'s preflight
// covers for the normal `blaze <verb>` path and which a DIRECT `node <runner>.mjs`
// bypasses entirely. That is exactly the invocation these guards exist for, so that is the
// invocation each test uses.
//
// ONE GUARD IN THOSE ELEVEN FILES IS NOT REACHABLE, and it is not covered here rather than
// covered badly: `scripts/move-runner.mjs`'s catch around `applyMove` (the second guard in
// that file). `move.mjs`'s only `loadProject` call sits inside its own
// `try { ... } catch { requireWorklog = false; }`, so `applyMove` cannot raise an
// `InvalidProjectKeyError` at all. Verified on `df13824` with the exact input that fires
// `edit-runner`'s equivalent guard — a healthy board, one ticket whose frontmatter reads
// `project: A(` — and `node move-runner.mjs ENG-1 defined` completed successfully
// (`ENG-1: backlog → defined`), never entering the catch. No mutation can kill that guard,
// so nothing below claims it is pinned. That file's own comment already says the wrap is
// defence-in-depth kept for symmetry with `edit-runner.mjs`; this note records that the
// symmetry is all it is.
describe("BLZ-419: every REACHABLE per-runner key-refusal guard is pinned by a test", () => {
  // `blaze audit` is deliberately absent: it is preflight-EXEMPT and must keep reporting
  // rather than refusing, which tests/audit-config-unloadable.test.mjs pins instead.
  const CASES = [
    ["log-runner.mjs", ["ENG-1", "30"]],
    ["link-runner.mjs", ["ENG-1", "Blocks", "ENG-2"]],
    ["resolve-runner.mjs", ["ENG-1", "done"]],
    ["sprint-runner.mjs", ["list"]],
    ["migrate-runner.mjs", ["--dry-run"]],
    ["db-runner.mjs", ["init"]],
    ["loops/groomer.mjs", []],
    ["reconcile.mjs", []],
  ];
  for (const [rel, args] of CASES) {
    test(`direct node ${rel} on a board with key 'eng' refuses cleanly, naming the key`, () => {
      const root = board({ key: "eng" });
      try {
        const r = spawnSync(process.execPath, [script(rel), ...args], {
          env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") },
          encoding: "utf8", timeout: 30000,
        });
        assert.notEqual(r.signal, "SIGTERM", `${rel}: timed out instead of refusing`);
        assertCleanRefusal(r, `direct node ${rel}`);
        assert.match(r.stderr, /"eng"/, `${rel}: the offending key must be named:\n${r.stderr}`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test("control: each of the same eight runners is unaffected on a HEALTHY board — the guard "
    + "refuses a bad key, it does not refuse everything", () => {
    // Without this, every test above would still pass if a runner had simply been made to
    // exit 1 with a `blaze: ` line unconditionally. What is asserted is only the ABSENCE of
    // the key refusal: these runners legitimately exit non-zero for their own reasons
    // (`blaze link` on a missing ENG-2, `blaze resolve` on a non-terminal ticket), and this
    // block is not the place to pin those.
    //
    // BLAZE_AGENT_COMMAND is pinned to `true` for the same reason the refusal tests do not
    // need it: on a HEALTHY board `loops/groomer.mjs` gets past the guard and runs a real
    // grooming pass, which spawns the configured agent (`claude -p` by default). Measured:
    // 40s and still running. The guard under test fires long before that, so the agent is
    // replaced with a no-op rather than the pass being skipped.
    for (const [rel, args] of CASES) {
      const root = board({ key: "ENG" });
      try {
        const r = spawnSync(process.execPath, [script(rel), ...args], {
          env: {
            ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects"),
            BLAZE_COMMIT_MODE: "batch", BLAZE_AGENT_COMMAND: "true",
          },
          encoding: "utf8", timeout: 30000,
        });
        assert.doesNotMatch(`${r.stdout}${r.stderr}`, /is not a valid project key/,
          `${rel} refused a VALID board key:\nstdout:${r.stdout}\nstderr:${r.stderr}`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
});
