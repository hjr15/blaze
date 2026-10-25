// tests/fs-write-guard.test.mjs — BLZ-708 (G-engine).
// A board whose blaze.config.json names database.driver "postgres" refuses a file write while
// BLAZE_WRITE_PORT is unset: the write would land in this checkout and never reach the database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scratchRegistry } from "./helpers/scratch.mjs";
import { fsWriteRefusal } from "../scripts/model/fs-write-guard.mjs";
import { startServer, CSRF } from "../scripts/serve.mjs";

const scratch = scratchRegistry();
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const SENTENCE = /BLAZE_WRITE_PORT is unset/;
const FIVE = ["BLAZE_WRITE_PORT", "BLAZE_READONLY", "BLAZE_REMOTE_URL", "BLAZE_TOKEN", "BLAZE_TOKEN_FILE"];

function pgDriverBoard() {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz708-board-")));
  const projectsDir = join(dataRoot, "projects");
  mkdirSync(join(projectsDir, "ENG", "defined"), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"),
    JSON.stringify({ projects: ["ENG"], schemaVersion: 2, database: { driver: "postgres" } }));
  writeFileSync(join(projectsDir, "ENG", "project.json"),
    JSON.stringify({ key: "ENG", components: [], labels: [] }));
  writeFileSync(join(projectsDir, "ENG", "defined", "ENG-1-a.md"),
    ["---", "id: ENG-1", "title: A task", "type: task", "project: ENG",
     "priority: medium", "assignee: unassigned", "estimate: 30",
     "created: 2026-01-01", "updated: 2026-01-01", "links:", "---", "",
     "## Acceptance Criteria", "", "- [ ] one", ""].join("\n"));
  // An fs-mode `blaze new` refuses outside a git work tree (it reserves ids through git).
  const git = (...a) => spawnSync("git", ["-C", dataRoot, "-c", "user.email=t@t.t", "-c", "user.name=t", ...a],
    { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  assert.equal(git("commit", "-q", "-m", "seed").status, 0, "seed commit failed");
  return { dataRoot, projectsDir };
}

function envFor(projectsDir, env = {}) {
  const e = { ...process.env, BLAZE_PROJECTS_DIR: projectsDir };
  for (const k of FIVE) delete e[k];
  return { ...e, ...env };
}
function run(board, args, env = {}) {
  return spawnSync(process.execPath, [join(SCRIPTS, "cli.mjs"), ...args],
    { encoding: "utf8", timeout: 30000, env: envFor(board.projectsDir, env) });
}
function runner(board, name, args, env = {}) {
  return spawnSync(process.execPath, [join(SCRIPTS, name), ...args],
    { encoding: "utf8", timeout: 30000, env: envFor(board.projectsDir, env) });
}
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      if (n === ".git") continue;
      const p = join(d, n);
      const s = statSync(p);
      if (s.isDirectory()) walk(p); else out.push(`${p}:${s.size}`);
    }
  };
  walk(dir);
  return out;
}

test("BLZ-708: fsWriteRefusal — only the implicit default is refused", () => {
  const pg = { database: { driver: "postgres" } };
  const r = fsWriteRefusal({ env: {}, config: pg, what: "run blaze move" });
  assert.equal(typeof r, "string");
  assert.equal(r, "blaze: refusing to run blaze move — this board's blaze.config.json names "
    + 'database.driver "postgres", but BLAZE_WRITE_PORT is unset, so the write would land in this '
    + "checkout's files and never reach the database the board serves. Write to the live board in "
    + "remote mode (BLAZE_REMOTE_URL and BLAZE_TOKEN), or set BLAZE_WRITE_PORT=db. During a "
    + "migration, BLAZE_WRITE_PORT=fs states that a file write is deliberate.");
  for (const v of ["fs", "dual", "db"]) {
    assert.equal(fsWriteRefusal({ env: { BLAZE_WRITE_PORT: v }, config: pg, what: "x" }), null, v);
  }
  assert.equal(fsWriteRefusal({ env: {}, config: { database: { driver: "sqlite" } }, what: "x" }), null);
  assert.equal(fsWriteRefusal({ env: {}, config: { projects: ["ENG"] }, what: "x" }), null);
});

test("BLZ-708: every mutating verb refuses on a postgres-driver board when BLAZE_WRITE_PORT is unset", async (t) => {
  const board = pgDriverBoard();
  const help = run(board, ["--help"]).stdout;
  const names = [...help.matchAll(/^\s{2}([a-z][a-z-]*)\s{2,}/gm)].map((m) => m[1]);
  const READ_ONLY = ["board", "audit", "export", "rollup"];
  const verbs = names.filter((n) => !READ_ONLY.includes(n) && n !== "db" && n !== "init");
  for (const must of ["new", "move", "edit", "link", "resolve", "log", "sprint", "user", "reindex", "import", "matrices"]) {
    assert.ok(verbs.includes(must), `derived verb list lacks ${must}: ${names.join(",")}`);
  }
  for (const name of verbs) {
    await t.test(name, () => {
      const before = snapshot(board.dataRoot);
      const r = run(board, [name]);
      assert.equal(r.status, 1, `${name}: status ${r.status}`);
      assert.ok(SENTENCE.test(r.stderr), `${name}: stderr lacks the guard sentence`);
      assert.deepEqual(snapshot(board.dataRoot), before);
    });
  }
});

test("BLZ-708: an explicit fs is allowed and writes the file", () => {
  const board = pgDriverBoard();
  const r = run(board, ["new", "--project", "ENG", "--type", "task", "t", "--estimate", "30"],
    { BLAZE_WRITE_PORT: "fs" });
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(join(board.projectsDir, "ENG", "defined"));
  assert.ok(files.some((f) => /^ENG-2-/.test(f)), `no ENG-2 file: ${files.join(",")}`);
});

test("BLZ-708: dual, db and remote mode never meet the guard", () => {
  const board = pgDriverBoard();
  const cases = [
    [["move", "ENG-1", "in-progress"], { BLAZE_WRITE_PORT: "dual" }],
    [["move", "ENG-1", "in-progress"], { BLAZE_WRITE_PORT: "db" }],
    [["new", "--project", "ENG", "--type", "task", "t", "--estimate", "30"],
      { BLAZE_REMOTE_URL: "http://127.0.0.1:9", BLAZE_TOKEN: "blz_x" }],
  ];
  for (const [args, env] of cases) {
    const r = run(board, args, env);
    assert.ok(!SENTENCE.test(r.stderr), `${JSON.stringify(Object.keys(env))}: hit the guard`);
  }
});

test("BLZ-708: blaze db is exempt", () => {
  const board = pgDriverBoard();
  const r = run(board, ["db", "status"]);
  assert.ok(!SENTENCE.test(r.stderr), "db status hit the guard");
});

test("BLZ-708: direct runners refuse too", async (t) => {
  await t.test("move-runner", () => {
    const board = pgDriverBoard();
    const r = runner(board, "move-runner.mjs", ["ENG-1", "in-progress"]);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(SENTENCE.test(r.stderr), "move-runner: no guard sentence");
    assert.ok(existsSync(join(board.projectsDir, "ENG", "defined", "ENG-1-a.md")), "file moved");
  });
  await t.test("sprint-runner new", () => {
    const board = pgDriverBoard();
    const r = runner(board, "sprint-runner.mjs", ["new", "S", "--start", "2026-07-13", "--end", "2026-07-26"]);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(SENTENCE.test(r.stderr), "sprint new: no guard sentence");
    assert.ok(!existsSync(join(board.dataRoot, "sprints.json")), "sprints.json written");
  });
  await t.test("sprint-runner active", () => {
    const board = pgDriverBoard();
    const r = runner(board, "sprint-runner.mjs", ["active", "SPR-1"]);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(SENTENCE.test(r.stderr), "sprint active: no guard sentence");
    assert.ok(!existsSync(join(board.dataRoot, "sprints.json")), "sprints.json written");
  });
  await t.test("sprint-runner list is a read", () => {
    const board = pgDriverBoard();
    const r = runner(board, "sprint-runner.mjs", ["list"]);
    assert.ok(!SENTENCE.test(r.stderr), "list hit the guard");
  });
  await t.test("user-runner", () => {
    const board = pgDriverBoard();
    const r = runner(board, "user-runner.mjs", ["add", "--email", "a@b.c"]);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(SENTENCE.test(r.stderr), "user-runner: no guard sentence");
    assert.ok(!existsSync(join(board.dataRoot, ".blaze", "identity.db")), "identity.db created");
  });
  await t.test("schedule-runner migrate-dates --write", () => {
    const board = pgDriverBoard();
    const r = runner(board, "schedule-runner.mjs", ["migrate-dates", "--write"]);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(SENTENCE.test(r.stderr), "schedule --write: no guard sentence");
  });
  await t.test("schedule-runner migrate-dates dry run is a read", () => {
    const board = pgDriverBoard();
    const r = runner(board, "schedule-runner.mjs", ["migrate-dates"]);
    assert.ok(!SENTENCE.test(r.stderr), "dry run hit the guard");
  });
  await t.test("migrate-runner --live", () => {
    const board = pgDriverBoard();
    const before = snapshot(board.projectsDir);
    const r = runner(board, "migrate-runner.mjs", ["--live", "--project", "ENG"]);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(SENTENCE.test(r.stderr), "migrate --live: no guard sentence");
    assert.deepEqual(snapshot(board.projectsDir), before);
  });
});

test("BLZ-708: the board server's write API refuses", async () => {
  const board = pgDriverBoard();
  const before = process.env.BLAZE_WRITE_PORT;
  delete process.env.BLAZE_WRITE_PORT;
  const server = startServer({ root: board.dataRoot, projectsDir: board.projectsDir, port: 0 });
  await new Promise((res) => server.once("listening", res));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/api/move`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-blaze-csrf": CSRF },
      body: JSON.stringify({ id: "ENG-1", to: "in-progress" }),
    });
    const body = await r.json().catch(() => ({}));
    assert.equal(r.status, 503, JSON.stringify(body));
    assert.ok(String(body.errors?.[0]).includes("BLAZE_WRITE_PORT is unset"), "errors[0] lacks the sentence");
    assert.ok(existsSync(join(board.projectsDir, "ENG", "defined", "ENG-1-a.md")), "file moved");
    const h = await fetch(`${base}/api/hash`);
    assert.equal(h.status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    if (before === undefined) delete process.env.BLAZE_WRITE_PORT; else process.env.BLAZE_WRITE_PORT = before;
  }
});

// --- fix round 1 (review I1, I2, M2) ----------------------------------------------------

/** pgDriverBoard plus a stub groom agent that leaves a marker OUTSIDE the board when it runs. */
function groomBoard() {
  const board = pgDriverBoard();
  const mark = join(scratch(mkdtempSync(join(tmpdir(), "blz708-mark-"))), "ran");
  const stub = join(board.dataRoot, "stub-agent.sh");
  writeFileSync(stub, `#!/usr/bin/env bash\ntouch ${JSON.stringify(mark)}\n`);
  const cfgPath = join(board.dataRoot, "blaze.config.json");
  writeFileSync(cfgPath, JSON.stringify({ projects: ["ENG"], schemaVersion: 2,
    database: { driver: "postgres" }, agentCommand: `bash ${stub}`,
    loops: { groomer: { columns: ["defined"] } } }));
  return { ...board, mark };
}

test("BLZ-708: a direct reconcile --apply refuses; a dry run does not", () => {
  const board = pgDriverBoard();
  const r = runner(board, "reconcile.mjs", ["--apply"]);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(SENTENCE.test(r.stderr), "reconcile --apply: no guard sentence");
  const d = runner(board, "reconcile.mjs", []);
  assert.ok(!SENTENCE.test(d.stderr), "reconcile dry run hit the guard");
});

test("BLZ-708: a direct groomer refuses before the agent runs", () => {
  const board = groomBoard();
  const r = runner(board, join("loops", "groomer.mjs"), []);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(SENTENCE.test(r.stderr), "groomer: no guard sentence");
  assert.ok(!existsSync(board.mark), "the groom agent ran");
});

test("BLZ-708: the supervisor's fs groomer and applying reconcile refuse as error events", async () => {
  const { createApp } = await import("../scripts/supervisor.mjs");
  const { loadConfig } = await import("../scripts/config.mjs");
  const board = groomBoard();
  const saved = { ...process.env };
  for (const k of FIVE) delete process.env[k];
  process.env.BLAZE_PROJECTS_DIR = board.projectsDir;
  try {
    const app = createApp(loadConfig({ root: board.dataRoot, env: {} }), { root: board.dataRoot, projectsDir: board.projectsDir });
    const events = [];
    app.bus.subscribe((e) => events.push(e));
    await app.runGroomer();
    assert.ok(events.some((e) => e.type === "error" && e.loop === "groomer" && SENTENCE.test(e.message)),
      "no groomer error event naming the guard");
    assert.ok(!existsSync(board.mark), "the groom agent ran");
    const before = snapshot(board.projectsDir);
    await app.runReconcile();
    assert.ok(events.some((e) => e.loop === "reconcile" && SENTENCE.test(JSON.stringify(e))),
      `no reconcile event naming the guard: ${JSON.stringify(events)}`);
    assert.deepEqual(snapshot(board.projectsDir), before);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("BLZ-708: blaze init is exempt (it creates a board, it does not write the ambient one)", () => {
  const board = pgDriverBoard();
  const r = run(board, ["init"]);
  assert.ok(!SENTENCE.test(r.stderr), "init hit the guard");
  assert.ok(/blaze init: cannot proceed/.test(r.stderr), "init did not reach its own argument check");
});
