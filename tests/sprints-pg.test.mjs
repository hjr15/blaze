// tests/sprints-pg.test.mjs — BLZ-707: the sprint registry in Postgres at schema v6.
//
// On a db-mode Postgres board stamped v6 the registry lives in `sprint` + `sprint_registry`:
// every reader answers `sprintRegistry(dataRoot)` from there, the gantt and `--sprint` validate
// against it, `blaze sprint` writes there, and `blaze db migrate --sprints-from` imports a
// `sprints.json` once, verified before the commit. Below v6, or off db mode, nothing changes:
// `sprints.json` serves exactly as before.
//
// Pure tests run always; the Postgres ones are PG_SKIP and each gets its OWN scratch database.
// No assertion here prints child output (A3): spawned stdout/stderr is tested with
// `assert.ok(re.test(...), "msg")`. Run with --test-concurrency=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchRegistry } from "./helpers/scratch.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient, makeV5, pgEnvFor } from "./helpers/pg-scratch.mjs";
import { parseSprintRegistry, writeSprintRegistry, readSprintRegistry, openSprintSource }
  from "../scripts/model/sprint-store.mjs";
import { normaliseRegistry, stampedRegistry } from "../scripts/model/sprints.mjs";
import { migrateDb } from "../scripts/model/db-migrate.mjs";
import { createDbSchema } from "../scripts/model/db-schema-version.mjs";
import { pgExec } from "../scripts/model/write-port-resolve.mjs";
import { canonicalStrict, dbWritePort } from "../scripts/model/write-port.mjs";
import { postgresReader } from "../scripts/model/pg-storage.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { applyNew } from "../scripts/new.mjs";
import { applyEdit } from "../scripts/edit.mjs";
import { startServer } from "../scripts/serve.mjs";
import { createApp } from "../scripts/supervisor.mjs";
import { loadConfig } from "../scripts/config.mjs";
import { resolveIdentity } from "../scripts/model/identity-db.mjs";

const scratch = scratchRegistry();
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const SCRUB = ["BLAZE_WRITE_PORT", "BLAZE_READONLY", "BLAZE_REMOTE_URL", "BLAZE_TOKEN", "BLAZE_TOKEN_FILE"];

const REG = {
  active: "S2", registryVersion: 1, activeByProject: { BLZ: "S2" },
  sprints: [
    { id: "S1", name: "One", start: "2026-07-13", end: "2026-07-26", goal: "x" },
    { id: "S2", name: "Two", start: "2026-07-27", end: "2026-08-09" },
  ],
};
const same = (a, b, msg) => assert.ok(canonicalStrict(a) === canonicalStrict(b), msg);

const capture = () => {
  const out = [], errs = [];
  const io = { log: (s) => out.push(String(s)), err: (s) => errs.push(String(s)), env: {} };
  return { io, out: () => out.join("\n"), err: () => errs.join("\n") };
};
const pgIo = (url) => ({
  resolveDbConfig: () => ({ driver: "postgres", connection: url }),
  openPostgresClient: (c) => pgClient(c),
});
const noPg = {
  resolveDbConfig: () => ({ driver: "postgres", connection: "postgres://u@127.0.0.1:1/x" }),
  openPostgresClient: () => { throw new Error("must not connect"); },
};
async function withClient(url, fn) {
  const c = await pgClient(url);
  try { return await fn(c); } finally { await c.end(); }
}
const stamp = (url) => withClient(url, async (c) =>
  (await c.query("SELECT value FROM blaze_meta WHERE key = 'schema_version'")).rows[0]?.value ?? null);
const readBack = (url) => withClient(url, (c) => readSprintRegistry(pgExec(c)));
async function writeReg(url, reg) {
  await withClient(url, async (c) => {
    await c.query("BEGIN");
    await writeSprintRegistry(pgExec(c), reg);
    await c.query("COMMIT");
  });
}
function childEnv(extra) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  return { ...env, KUBECONFIG: "/dev/null", ...extra };
}
const run = (script, args, env) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args],
  { encoding: "utf8", env });

/** A dbBoard whose ENG-1 is tagged S2 and dated inside it; optionally a sprints.json beside it. */
function sprintBoard({ postgres = false, sprintsJson = null } = {}) {
  const roots = dbBoard();
  const ticket = join(roots.projectsDir, "ENG", "defined", "ENG-1-a.md");
  writeFileSync(ticket, readFileSync(ticket, "utf8")
    .replace("estimate: 30\n", "estimate: 30\nsprint: S2\nstart: 2026-07-28\ndue: 2026-08-05\n"));
  if (postgres) {
    const cfgPath = join(roots.dataRoot, "blaze.config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, database: { driver: "postgres" } }));
  }
  if (sprintsJson) writeFileSync(join(roots.dataRoot, "sprints.json"), JSON.stringify(sprintsJson, null, 2));
  return roots;
}
/** A v6 Postgres board: schema created, ENG-1 loaded, REG in the sprint tables, no sprints.json. */
async function v6Board(url) {
  const roots = sprintBoard({ postgres: true });
  assert.equal(await runDb(["init"], { ...QUIET, roots, ...pgIo(url) }), 0, "db init failed");
  assert.equal(await runDb(["load"], { ...QUIET, roots, ...pgIo(url) }), 0, "db load failed");
  await writeReg(url, REG);
  assert.ok(!existsSync(join(roots.dataRoot, "sprints.json")), "the fixture has no sprints.json");
  return roots;
}

// ── pure ───────────────────────────────────────────────────────────────────────────────────

test("BLZ-707: parseSprintRegistry refuses what the tables cannot hold, by name", () => {
  const s = (sprints, top = {}) => JSON.stringify({ active: null, ...top, sprints });
  const cases = [
    ["{not json", /blaze: src: .*not JSON/],
    ["[1]", /blaze: src: .*not an object/],
    ['{"sprints": 3}', /blaze: src: sprints is not an array/],
    [s([7]), /blaze: src: sprints\[0\] is not an object/],
    [s([{ name: "a" }]), /blaze: src: sprints\[0\] has no id/],
    [s([{ id: "", name: "a" }]), /blaze: src: sprints\[0\] has no id/],
    [s([{ id: "S1", name: "a" }, { id: "S1", name: "b" }]), /blaze: src: sprints\[1\] \(S1\) duplicates/],
    [s([{ id: "S1", name: 4 }]), /blaze: src: sprints\[0\] \(S1\) name is not a string/],
    [s([{ id: "S1", name: "a", start: "2026-02-30" }]), /blaze: src: sprints\[0\] \(S1\) start .*YYYY-MM-DD/],
    [s([{ id: "S1", name: "a", end: null }]), /blaze: src: sprints\[0\] \(S1\) end .*YYYY-MM-DD/],
    [s([], { registryVersion: 0 }), /blaze: src: registryVersion is not an integer/],
    [s([], { registryVersion: "1" }), /blaze: src: registryVersion is not an integer/],
    [s([], { active: 5 }), /blaze: src: active is neither a sprint id nor null/],
  ];
  for (const [text, re] of cases) assert.throws(() => parseSprintRegistry(text, "src"), re, text);
  same(parseSprintRegistry(JSON.stringify(REG), "src"), normaliseRegistry(REG), "a valid registry normalises");
  same(parseSprintRegistry('{"sprints": []}', "src"), { active: null, sprints: [] }, "active defaults to null");
});

test("BLZ-707: stampedRegistry stamps 1 and never downgrades", () => {
  assert.equal(stampedRegistry({ sprints: [] }).registryVersion, 1);
  assert.equal(stampedRegistry({ sprints: [], registryVersion: 3 }).registryVersion, 3);
  assert.equal(stampedRegistry({ sprints: [], registryVersion: 0 }).registryVersion, 1);
});

test("BLZ-707: a malformed sprints.json is refused before anything connects", async () => {
  const roots = dbBoard();
  const file = join(scratch(mkdtempSync(join(tmpdir(), "blz707-bad-"))), "sprints.json");
  writeFileSync(file, '{"sprints": 3}');
  const c = capture();
  assert.equal(await runDb(["migrate", "--sprints-from", file], { ...c.io, roots, ...noPg }), 1);
  assert.ok(/sprints is not an array/.test(c.err()), "the rule is named");
  assert.ok(/Nothing was migrated/.test(c.err()), "nothing was migrated");
  assert.ok(!/must not connect/.test(c.err()), "nothing connected");
  assert.ok(!/blaze: blaze: |migrate: blaze: /.test(c.err()), "one 'blaze: ' prefix is stripped (M6)");
});

test("BLZ-707: a missing --sprints-from file is refused before anything connects", async () => {
  const c = capture();
  assert.equal(await runDb(["migrate", "--sprints-from=/nonexistent/sprints.json"],
    { ...c.io, roots: dbBoard(), ...noPg }), 1);
  assert.ok(/no sprint registry at \/nonexistent\/sprints\.json/.test(c.err()), "the path is named");
  assert.ok(/Nothing was migrated/.test(c.err()), "nothing was migrated");
});

test("BLZ-707 (I5): --sprints-from with --no-sprints-import is refused", async () => {
  const roots = sprintBoard({ sprintsJson: REG });
  const c = capture();
  assert.equal(await runDb(["migrate", "--sprints-from", join(roots.dataRoot, "sprints.json"),
                            "--no-sprints-import"], { ...c.io, roots, ...noPg }), 1);
  assert.ok(/--sprints-from and --no-sprints-import contradict/.test(c.err()), "refused as contradictory");
});

test("BLZ-707: --no-sprints-import is refused off migrate", async () => {
  const c = capture();
  assert.equal(await runDb(["load", "--no-sprints-import"], { ...c.io, roots: dbBoard(), ...noPg }), 1);
  assert.ok(/--no-sprints-import applies to 'blaze db migrate' only/.test(c.err()), "off-verb refusal");
});

test("BLZ-707: blaze sprint on an fs board is byte-identical", () => {
  const roots = dbBoard();
  const r = run("sprint-runner.mjs", ["new", "A", "--start", "2026-07-13", "--end", "2026-07-26"],
    childEnv({ BLAZE_PROJECTS_DIR: roots.projectsDir }));
  assert.equal(r.status, 0, "sprint new exited non-zero");
  assert.ok(r.stdout === "created S1\n", "stdout is exactly 'created S1'");
  const file = JSON.parse(readFileSync(join(roots.dataRoot, "sprints.json"), "utf8"));
  assert.equal(file.registryVersion, 1);
  assert.equal(file.active, "S1");
});

test("BLZ-707: openSprintSource is the file off db mode", async () => {
  const roots = dbBoard();
  const src = await openSprintSource({ dataRoot: roots.dataRoot, env: {} });
  try {
    assert.equal(src.kind, "file");
    assert.equal(src.where, join(roots.dataRoot, "sprints.json"));
    same(await src.load(), { active: null, sprints: [] }, "no file reads as no sprints");
  } finally { await src.close(); }
});

// ── Postgres ───────────────────────────────────────────────────────────────────────────────

test("BLZ-707: a registry with unknown keys at both levels round-trips through Postgres", PG_SKIP, async () => {
  const db = await scratchPgDb("spr_rt");
  try {
    await withClient(db.url, (c) => createDbSchema(pgExec(c), { dialect: "postgres" }));
    await writeReg(db.url, REG);
    same(await readBack(db.url), REG, "the registry read back differs from the one written");
    await writeReg(db.url, { active: null, sprints: [{ id: "S7", name: "Seven" }] });
    same(await readBack(db.url), { active: null, sprints: [{ id: "S7", name: "Seven" }] },
      "a rewrite replaces the registry; absent dates and version stay absent");
  } finally { await db.drop(); }
});

test("BLZ-707: writeSprintRegistry re-validates, writing nothing for an invalid registry", PG_SKIP, async () => {
  const db = await scratchPgDb("spr_wv");
  try {
    await withClient(db.url, async (c) => {
      await createDbSchema(pgExec(c), { dialect: "postgres" });
      await assert.rejects(writeSprintRegistry(pgExec(c), { active: null, sprints: [{ id: "S1", name: 3 }] }),
        /name is not a string/);
      assert.equal(Number((await c.query("SELECT count(*) AS n FROM sprint_registry")).rows[0].n), 0);
    });
  } finally { await db.drop(); }
});

test("BLZ-707: an empty database reads as no sprints", PG_SKIP, async () => {
  const db = await scratchPgDb("spr_empty");
  try {
    await withClient(db.url, (c) => createDbSchema(pgExec(c), { dialect: "postgres" }));
    same(await readBack(db.url), { active: null, sprints: [] }, "an empty database is no sprints");
  } finally { await db.drop(); }
});

test("BLZ-707: migrate --sprints-from imports and verifies; a tampered row aborts", PG_SKIP, async () => {
  const a = await scratchPgDb("spr_mig");
  const b = await scratchPgDb("spr_tamper");
  try {
    await makeV5(a.url);
    const r = await withClient(a.url, (c) => migrateDb(pgExec(c), { sprintRegistry: REG }));
    same(r.sprints, { count: 2, active: "S2" }, "migrate reports the sprints it copied");
    same(await readBack(a.url), REG, "the imported registry differs from the source");

    await makeV5(b.url);
    await assert.rejects(withClient(b.url, (c) => migrateDb(pgExec(c), {
      sprintRegistry: REG,
      beforeVerify: (e) => e.run("UPDATE sprint SET name = 'tampered' WHERE id = 'S1'"),
    })), /sprint verify: .*S1/);
    assert.equal(await stamp(b.url), "5", "the tampered migrate rolled back");
  } finally { await a.drop(); await b.drop(); }
});

test("BLZ-707: the sprint copy refuses tables that already hold a registry", PG_SKIP, async () => {
  const db = await scratchPgDb("spr_full");
  try {
    await withClient(db.url, (c) => createDbSchema(pgExec(c), { dialect: "postgres" }));
    await writeReg(db.url, { active: null, sprints: [] });
    await assert.rejects(withClient(db.url, (c) => migrateDb(pgExec(c), { sprintRegistry: REG })),
      /sprint copy refused: the sprint tables already hold a registry/);
    same(await readBack(db.url), { active: null, sprints: [] }, "nothing was copied");
  } finally { await db.drop(); }
});

test("BLZ-707 (I5): migrate refuses while sprints.json exists and nothing says what to do with it",
     PG_SKIP, async () => {
  const db = await scratchPgDb("spr_i5");
  try {
    const roots = sprintBoard({ sprintsJson: { active: "S1", sprints: [REG.sprints[0]] } });
    await makeV5(db.url);
    const c = capture();
    assert.equal(await runDb(["migrate"], { ...c.io, roots, ...pgIo(db.url) }), 1);
    assert.ok(/would not copy them/.test(c.err()), "the stranded file is explained");
    assert.ok(/--sprints-from/.test(c.err()), "--sprints-from is named");
    assert.ok(/--no-sprints-import/.test(c.err()), "--no-sprints-import is named");
    assert.ok(c.err().includes(join(roots.dataRoot, "sprints.json")), "the file is named");
    assert.ok(/Nothing was migrated/.test(c.err()), "nothing was migrated");
    assert.equal(await stamp(db.url), "5");
  } finally { await db.drop(); }
});

test("BLZ-707 (I5): --no-sprints-import proceeds and imports nothing", PG_SKIP, async () => {
  const db = await scratchPgDb("spr_noimp");
  try {
    const roots = sprintBoard({ sprintsJson: REG });
    await makeV5(db.url);
    const c = capture();
    assert.equal(await runDb(["migrate", "--no-sprints-import"], { ...c.io, roots, ...pgIo(db.url) }), 0,
      "migrate --no-sprints-import exited non-zero");
    assert.equal(await stamp(db.url), "6");
    same(await readBack(db.url), { active: null, sprints: [] }, "nothing was imported");
  } finally { await db.drop(); }
});

test("BLZ-707: migrate --sprints-from=<path> prints the verified line; a re-run names it already imported",
     PG_SKIP, async () => {
  const db = await scratchPgDb("spr_cli");
  try {
    const roots = sprintBoard({ sprintsJson: REG });
    const file = join(roots.dataRoot, "sprints.json");
    await makeV5(db.url);
    const first = capture();
    assert.equal(await runDb(["migrate", `--sprints-from=${file}`], { ...first.io, roots, ...pgIo(db.url) }), 0,
      "migrate --sprints-from exited non-zero");
    assert.ok(/^ {2}sprints {8}2 sprint\(s\), active S2 {2}\(verified\)$/m.test(first.out()), "the sprints line");
    same(await readBack(db.url), REG, "the imported registry differs from the file");

    const again = capture();
    assert.equal(await runDb(["migrate"], { ...again.io, roots, ...pgIo(db.url) }), 1);
    assert.ok(/already holds 2 sprint\(s\)/.test(again.err()), "the held count is named");
    assert.ok(/already imported/.test(again.err()), "named as already imported");
    assert.ok(/--no-sprints-import/.test(again.err()), "the way through is named");
    assert.ok(!/would not copy them/.test(again.err()), "the stranded-file warning is false here");

    const ok = capture();
    assert.equal(await runDb(["migrate", "--no-sprints-import"], { ...ok.io, roots, ...pgIo(db.url) }), 0);
    assert.ok(/already current/.test(ok.out()), "the re-run is a no-op");
  } finally { await db.drop(); }
});

test("BLZ-707: a v5 database: sprints stay on the file", PG_SKIP, async () => {
  const db = await scratchPgDb("spr_v5");
  try {
    await makeV5(db.url);
    const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz707-v5-")));
    writeFileSync(join(dataRoot, "sprints.json"), JSON.stringify({ active: "S1", sprints: [REG.sprints[0]] }));
    await withClient(db.url, async (c) => {
      const reg = await postgresReader(c).sprintRegistry(dataRoot);
      assert.deepEqual(reg.sprints.map((s) => s.id), ["S1"]);
    });
    const env = { BLAZE_WRITE_PORT: "db" };
    const src = await openSprintSource({ dataRoot, env, resolveDbConfig: pgIo(db.url).resolveDbConfig,
                                         openPgClient: pgClient });
    try { assert.equal(src.kind, "file"); } finally { await src.close(); }
  } finally { await db.drop(); }
});

test("BLZ-707 (M5): blaze reindex on a v6 db board does not warn about registered sprints", PG_SKIP, async () => {
  const db = await scratchPgDb("spr_reidx");
  try {
    const roots = await v6Board(db.url);
    const r = run("reindex.mjs", [], childEnv({ BLAZE_PROJECTS_DIR: roots.projectsDir, BLAZE_WRITE_PORT: "db",
                                                ...pgEnvFor(db.url) }));
    assert.equal(r.status, 0, "reindex exited non-zero");
    assert.ok(!/not in registry/.test(r.stderr), "reindex warned about a sprint the database registers");
  } finally { await db.drop(); }
});

/** The gantt, as a fragment and as a full page, names the database's sprint S2 ("Two"). */
async function assertGanttFromDb(port, who) {
  const res = await fetch(`http://127.0.0.1:${port}/view/gantt?sprint=S2`);
  const body = await res.text();
  assert.equal(res.status, 200, `${who}: GET /view/gantt was not 200`);
  const html = JSON.parse(body).html;
  assert.ok(html.includes("ENG-1"), `${who}: the gantt does not show ENG-1`);
  assert.ok(html.includes("Two"), `${who}: the gantt does not name the database's sprint`);
  const page = await fetch(`http://127.0.0.1:${port}/?view=gantt&sprint=S2`);
  const doc = await page.text();
  assert.equal(page.status, 200, `${who}: GET / was not 200`);
  assert.ok(doc.includes("Two"), `${who}: the full page's gantt does not name the database's sprint`);
}

test("BLZ-707: at v6 the gantt renders the database's sprints", PG_SKIP, async () => {
  const db = await scratchPgDb("spr_gantt");
  const keys = { BLAZE_WRITE_PORT: "db", ...pgEnvFor(db.url) };
  const before = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
  let identity, server, app;
  try {
    const roots = await v6Board(db.url);
    Object.assign(process.env, keys);
    identity = await resolveIdentity({ dataRoot: roots.dataRoot });
    server = startServer({ root: roots.dataRoot, projectsDir: roots.projectsDir, port: 0, identity });
    await new Promise((res) => server.once("listening", res));
    await assertGanttFromDb(server.address().port, "serve");
    // `blaze start` renders the same board through its own routes.
    app = createApp(loadConfig({ root: roots.dataRoot }), { root: roots.dataRoot, identity });
    await new Promise((res) => app.server.listen(0, "127.0.0.1", res));
    await assertGanttFromDb(app.server.address().port, "supervisor");
  } finally {
    if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    if (app) { app.server.closeAllConnections(); await new Promise((r) => app.server.close(r)); }
    await identity?.close?.();
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await db.drop();
  }
});

test("BLZ-707: --sprint validates against the database registry at v6", PG_SKIP, async () => {
  const db = await scratchPgDb("spr_new");
  try {
    const roots = await v6Board(db.url);
    await withClient(db.url, async (c) => {
      const deps = { readStorage: postgresReader(c), writePort: dbWritePort(pgExec(c), { dialect: "postgres" }) };
      const ok = await applyNew(roots.projectsDir, { project: "ENG", type: "task", title: "t",
                                                    extra: { estimate: 30, sprint: "S2" }, ...deps });
      assert.equal(ok.ok, true, "a registered sprint was refused");
      const bad = await applyNew(roots.projectsDir, { project: "ENG", type: "task", title: "t",
                                                     extra: { estimate: 30, sprint: "S9" }, ...deps });
      assert.equal(bad.ok, false);
      assert.ok(bad.errors.some((e) => /sprint 'S9' is not in the sprint registry/.test(e)), "source-neutral wording");
      const edited = await applyEdit(roots.projectsDir, "ENG-1", { sprint: "S1" }, deps);
      assert.equal(edited.ok, true, "edit refused a registered sprint");
      const refused = await applyEdit(roots.projectsDir, "ENG-1", { sprint: "S9" }, deps);
      assert.equal(refused.ok, false);
      assert.ok(refused.errors.some((e) => /sprint 'S9' is not in the sprint registry/.test(e)), "edit validates too");
    });
  } finally { await db.drop(); }
});

test("BLZ-707: blaze sprint new and active write the database at v6, and write no sprints.json", PG_SKIP, async () => {
  const db = await scratchPgDb("spr_cli2");
  try {
    const roots = await v6Board(db.url);
    const env = childEnv({ BLAZE_PROJECTS_DIR: roots.projectsDir, BLAZE_WRITE_PORT: "db", ...pgEnvFor(db.url) });
    const made = run("sprint-runner.mjs", ["new", "Three", "--start", "2026-08-10", "--end", "2026-08-23"], env);
    assert.equal(made.status, 0, "sprint new exited non-zero");
    assert.ok(/^created S3 \(database: /.test(made.stdout), "sprint new names the database");
    const act = run("sprint-runner.mjs", ["active", "S3"], env);
    assert.equal(act.status, 0, "sprint active exited non-zero");
    assert.ok(/^active sprint: S3 \(database: /.test(act.stdout), "sprint active names the database");
    const listed = run("sprint-runner.mjs", ["list"], env);
    assert.equal(listed.status, 0, "sprint list exited non-zero");
    assert.ok(/S3 · Three · 2026-08-10\.\.2026-08-23 \(active\)/.test(listed.stdout), "list reads the database");
    const reg = await readBack(db.url);
    assert.equal(reg.active, "S3");
    assert.deepEqual(reg.sprints.map((s) => s.id), ["S1", "S2", "S3"]);
    assert.equal(reg.registryVersion, 1);
    assert.equal(reg.activeByProject?.BLZ, "S2", "an unknown key survived the save");
    assert.ok(!existsSync(join(roots.dataRoot, "sprints.json")), "a sprints.json was written");
  } finally { await db.drop(); }
});
