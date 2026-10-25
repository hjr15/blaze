// tests/identity-pg.test.mjs — BLZ-706 part 2 (absorbs BLZ-701): identity at runtime over Postgres.
//
// On a db-mode Postgres board at schema v6, every server resolves its identity from the database
// BEFORE it binds (the standalone serve.mjs entry and `blaze start`), the post-setup adoption
// reloads from the same database, and `blaze user add` / `passwd` write there — creating no
// `.blaze/` and no `.gitignore` line. A server started on such a board WITHOUT a resolved identity
// refuses (review I4): it never falls back to the SQLite roster, and never to an open board.
//
// The discriminator in the spawned tests is a 0-BYTE `.blaze/identity.db`: SQLite's loader reads
// it as `broken` and refuses to start, so a server that came up and authenticates read Postgres.
//
// CREDENTIALS NEVER REACH OUTPUT (A3). Tokens and passwords are used only to authenticate; no
// assertion message interpolates one. Every scratch board comes from dbBoard(), which owns its
// cleanup. Run with --test-concurrency=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dbBoard } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient, makeV5, pgEnvFor } from "./helpers/pg-scratch.mjs";
import { loadConfig } from "../scripts/config.mjs";
import { startServer, CSRF } from "../scripts/serve.mjs";
import { createApp } from "../scripts/supervisor.mjs";
import { addUser, setUserPassword } from "../scripts/model/user-admin.mjs";
import { identityDbPath, openIdentityDb, resolveIdentity } from "../scripts/model/identity-db.mjs";
import { loadIdentityPg, poolExec } from "../scripts/model/identity-pg.mjs";
import { identityStore } from "../scripts/model/identity-store.mjs";
import { createDbSchema } from "../scripts/model/db-schema-version.mjs";
import { pgExec } from "../scripts/model/write-port-resolve.mjs";
import { readSetupToken } from "../scripts/model/setup-token.mjs";
import { openPostgresPool } from "../scripts/init-pg.mjs";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const SCRUB = ["BLAZE_WRITE_PORT", "BLAZE_READONLY", "BLAZE_REMOTE_URL", "BLAZE_TOKEN", "BLAZE_TOKEN_FILE"];

async function withClient(url, fn) {
  const c = await pgClient(url);
  try { return await fn(c); } finally { await c.end(); }
}
const userCount = (url) => withClient(url, async (c) =>
  Number((await c.query("SELECT count(*) AS n FROM app_user")).rows[0].n));

/** A dbBoard whose config names Postgres, over a database created at v6. */
async function pgBoard(url) {
  const roots = dbBoard();
  const cfgPath = join(roots.dataRoot, "blaze.config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, database: { driver: "postgres" } }));
  await withClient(url, (c) => createDbSchema(pgExec(c), { dialect: "postgres" }));
  return roots;
}
const deps = (url) => ({
  env: { BLAZE_WRITE_PORT: "db" },
  resolveDbConfig: () => ({ driver: "postgres", connection: url }),
  openPgClient: pgClient,
});
const poolFor = (url) => async (_c) => new ((await import("pg")).default.Pool)({ connectionString: url });

const postSetup = (base, body) =>
  fetch(`${base}/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-blaze-csrf": CSRF },
    body: JSON.stringify(body),
  });

/** An admin and its token, written through the Postgres store directly. */
async function seedPgAdmin(url) {
  return withClient(url, async (c) => {
    const store = identityStore(pgExec(c), { dialect: "postgres" });
    const user = await store.createUser({ email: "admin@example.com", role: "admin" });
    const { token } = await store.issueToken({ userId: user.id, name: "t", scopes: ["read", "write"] });
    return token;
  });
}
/** The 0-byte roster SQLite's loader reads as `broken`. */
function zeroByteRoster(dataRoot) {
  mkdirSync(join(dataRoot, ".blaze"), { recursive: true });
  writeFileSync(identityDbPath(dataRoot), "");
}

function childEnv(extra) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  return { ...env, ...extra };
}
/** Spawn a server script and resolve with its port once `pattern` appears on stdout. */
function spawnServer(script, env, pattern) {
  const child = spawn(process.execPath, [join(SCRIPTS, script)], { env });
  let out = "", err = "";
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      out += d;
      const m = out.match(pattern);
      if (m) resolve(Number(m[1]));
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => reject(new Error(`${script} exited ${code} before listening: ${err.slice(0, 400)}`)));
  });
  return { child, ready };
}
const hash = (port, token) => fetch(`http://127.0.0.1:${port}/api/hash`,
  token ? { headers: { authorization: `Bearer ${token}` } } : {}).then((r) => r.status);

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test("BLZ-706: loadIdentityPg reports absent, broken, empty and healthy — and broken is not absent", PG_SKIP, async () => {
  const db = await scratchPgDb("idpg_states");
  try {
    await withClient(db.url, async (c) => {
      const absent = await loadIdentityPg(pgExec(c));
      assert.equal(absent.state, "absent");
      assert.equal(absent.hasIdentity, false);
      assert.equal(absent.store, null);

      const broken = await loadIdentityPg({
        run: async () => { throw new Error("boom"); },
        all: async () => { throw new Error("boom"); },
      });
      assert.equal(broken.state, "broken");
      assert.equal(broken.hasIdentity, false);
      assert.equal(broken.store, null);
      assert.match(broken.error, /cannot be read/);
      assert.match(broken.error, /boom/);
      assert.notEqual(broken.state, absent.state);

      await createDbSchema(pgExec(c), { dialect: "postgres" });
      const empty = await loadIdentityPg(pgExec(c));
      assert.equal(empty.state, "empty");
      assert.equal(empty.hasIdentity, false);

      await identityStore(pgExec(c), { dialect: "postgres" }).createUser({ email: "a@b.c", role: "admin" });
      const healthy = await loadIdentityPg(pgExec(c));
      assert.equal(healthy.state, "healthy");
      assert.equal(healthy.hasIdentity, true);
      assert.ok(healthy.store, "a healthy load carries a store");
      assert.equal(typeof healthy.close, "function");
    });
  } finally { await db.drop(); }
});

test("BLZ-706: poolExec is the pgExec shape over pool.query", async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push([sql, params]); return { rows: [{ n: 1 }] }; } };
  const exec = poolExec(pool);
  assert.deepEqual(await exec.all("SELECT 1", [1]), [{ n: 1 }]);
  await exec.run("UPDATE x", []);
  assert.deepEqual(calls, [["SELECT 1", [1]], ["UPDATE x", []]]);
});

test("BLZ-706: openPostgresPool builds a 4-connection pool from parsed parts and logs, not throws, a pool error", async () => {
  let made;
  class Pool {
    constructor(cfg) { made = cfg; this.handlers = {}; }
    on(ev, fn) { this.handlers[ev] = fn; return this; }
  }
  const pool = await openPostgresPool({ host: "h", port: 5, database: "d", user: "u", password: "pw" }, { Pool });
  assert.equal(made.max, 4);
  assert.equal(made.host, "h");
  assert.equal(made.database, "d");
  assert.equal("connectionString" in made, false, "never a composed URL");
  assert.equal(typeof pool.handlers.error, "function", "an idle-client error must not end the process");
  const saved = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try { pool.handlers.error(new Error("terminating connection")); } finally { console.error = saved; }
  assert.deepEqual(lines, ["blaze: identity connection pool: terminating connection"]);
});

test("BLZ-706: resolveIdentity reads Postgres at v6 and SQLite below it", PG_SKIP, async () => {
  const v6 = await scratchPgDb("idpg_v6");
  const v5 = await scratchPgDb("idpg_v5");
  try {
    const { dataRoot } = await pgBoard(v6.url);
    await seedPgAdmin(v6.url);
    const at6 = await resolveIdentity({ dataRoot, env: { BLAZE_WRITE_PORT: "db" },
      resolveDbConfig: () => ({ driver: "postgres", connection: v6.url }), openPgPool: poolFor(v6.url) });
    try {
      assert.equal(at6.source, "postgres");
      assert.equal(at6.state, "healthy");
      assert.equal((await at6.reload()).state, "healthy");
    } finally { await at6.close(); }

    await makeV5(v5.url);
    const below = dbBoard();
    const opened = openIdentityDb(below.dataRoot, { create: true });
    try { await opened.store.createUser({ email: "a@b.c", role: "admin" }); } finally { opened.db.close(); }
    const at5 = await resolveIdentity({ dataRoot: below.dataRoot, env: { BLAZE_WRITE_PORT: "db" },
      resolveDbConfig: () => ({ driver: "postgres", connection: v5.url }), openPgPool: poolFor(v5.url) });
    try {
      assert.equal(at5.source, "sqlite");
      assert.equal(at5.state, "healthy");
    } finally { at5.close(); }

    let opened6 = false;
    const unset = await resolveIdentity({ dataRoot, env: {},
      resolveDbConfig: () => ({ driver: "postgres", connection: v6.url }),
      openPgPool: async () => { opened6 = true; throw new Error("must not open"); } });
    assert.equal(unset.source, "sqlite");
    assert.equal(opened6, false, "fs mode opens no database");
  } finally { await v6.drop(); await v5.drop(); }
});

test("BLZ-706: resolveIdentity refuses a Postgres database with no Blaze schema, closing its pool", PG_SKIP, async () => {
  const db = await scratchPgDb("idpg_noschema");
  try {
    const { dataRoot } = dbBoard();
    let ended = false;
    const open = async (c) => {
      const pool = await poolFor(db.url)(c);
      const end = pool.end.bind(pool);
      pool.end = () => { ended = true; return end(); };
      return pool;
    };
    await assert.rejects(resolveIdentity({ dataRoot, env: { BLAZE_WRITE_PORT: "db" },
      resolveDbConfig: () => ({ driver: "postgres", connection: db.url }), openPgPool: open }),
      /blaze: the Postgres database has no Blaze schema — run 'blaze db init'/);
    assert.equal(ended, true, "the pool is closed on refusal");
  } finally { await db.drop(); }
});

test("BLZ-706: a v5 database: identity stays on SQLite", PG_SKIP, async () => {
  const db = await scratchPgDb("idpg_v5add");
  try {
    await makeV5(db.url);
    const { dataRoot } = dbBoard();
    const r = await addUser(dataRoot, { email: "a@b.c", role: "admin" }, deps(db.url));
    assert.equal(r.source, "sqlite");
    assert.ok(existsSync(identityDbPath(dataRoot)), "the v5 board's roster is identity.db");
  } finally { await db.drop(); }
});

test("BLZ-706 / BLZ-701: user add on a v6 Postgres board writes Postgres and creates no .blaze or .gitignore", PG_SKIP, async () => {
  const db = await scratchPgDb("idpg_add");
  try {
    const { dataRoot, projectsDir } = await pgBoard(db.url);
    const r = await addUser(dataRoot, { email: "a@b.c", role: "admin" }, deps(db.url));
    assert.equal(r.source, "postgres");
    assert.match(r.where, /\//, "where names host/database");
    assert.equal(await userCount(db.url), 1);
    assert.equal(existsSync(join(dataRoot, ".blaze")), false, "no .blaze/ created");
    assert.equal(existsSync(join(dataRoot, ".gitignore")), false, "no .gitignore created");

    // The runner, as an operator runs it, in a git work tree: names the database, writes no
    // .gitignore line and creates no .blaze/ (BLZ-701's EACCES was the .blaze/ mkdir).
    spawnSync("git", ["-C", dataRoot, "init", "-q"]);
    const run = spawnSync(process.execPath,
      [join(SCRIPTS, "user-runner.mjs"), "add", "--email", "b@b.c", "--role", "member"],
      { encoding: "utf8", env: childEnv({ BLAZE_PROJECTS_DIR: projectsDir, BLAZE_WRITE_PORT: "db",
                                          ...pgEnvFor(db.url) }) });
    assert.equal(run.status, 0, `user-runner exited ${run.status}`);
    assert.match(run.stdout, /^identities: Postgres \S+\/\S+$/m);
    assert.doesNotMatch(run.stdout, /identity\.db/);
    assert.equal(await userCount(db.url), 2);
    assert.equal(existsSync(join(dataRoot, ".blaze")), false, "the runner created no .blaze/");
    assert.equal(existsSync(join(dataRoot, ".gitignore")), false, "the runner wrote no .gitignore");
  } finally { await db.drop(); }
});

test("BLZ-706: user passwd sets the verifier in Postgres", PG_SKIP, async () => {
  const db = await scratchPgDb("idpg_passwd");
  try {
    const { dataRoot } = await pgBoard(db.url);
    await addUser(dataRoot, { email: "a@b.c", role: "admin" }, deps(db.url));
    const r = await setUserPassword(dataRoot, { email: "a@b.c", password: "correct horse battery" }, deps(db.url));
    assert.equal(r.source, "postgres");
    assert.equal(r.email, "a@b.c");
    const ok = await withClient(db.url, (c) => identityStore(pgExec(c), { dialect: "postgres" })
      .signIn({ email: "a@b.c", password: "correct horse battery" }));
    assert.equal(ok.ok, true, "the Postgres verifier signs in");
    assert.equal(existsSync(join(dataRoot, ".blaze")), false);
  } finally { await db.drop(); }
});

test("BLZ-706: the standalone serve.mjs entry reads Postgres before bind, not SQLite", PG_SKIP, async () => {
  const db = await scratchPgDb("idpg_serve");
  let child;
  try {
    const { dataRoot, projectsDir } = await pgBoard(db.url);
    const token = await seedPgAdmin(db.url);
    zeroByteRoster(dataRoot);
    const s = spawnServer("serve.mjs", childEnv({ BLAZE_PROJECTS_DIR: projectsDir, BLAZE_WRITE_PORT: "db",
      PORT: "0", HOST: "127.0.0.1", ...pgEnvFor(db.url) }), /board → http:\/\/localhost:(\d+)/);
    child = s.child;
    const port = await s.ready;
    assert.equal(await hash(port), 401, "no token is refused");
    assert.equal(await hash(port, token), 200, "the Postgres token authenticates");
    assert.equal(statSync(identityDbPath(dataRoot)).size, 0, "the SQLite roster was never opened");
  } finally { child?.kill(); await db.drop(); }
});

test("BLZ-706: post-setup adoption reloads from Postgres", PG_SKIP, async () => {
  const db = await scratchPgDb("idpg_adopt");
  let server, identity;
  try {
    const { dataRoot, projectsDir } = await pgBoard(db.url);
    zeroByteRoster(dataRoot);
    identity = await resolveIdentity({ dataRoot, env: { BLAZE_WRITE_PORT: "db" },
      resolveDbConfig: () => ({ driver: "postgres", connection: db.url }), openPgPool: poolFor(db.url) });
    assert.equal(identity.state, "empty");
    server = startServer({ root: dataRoot, projectsDir, port: 0, host: "0.0.0.0", identity,
      addUser: (r, o) => addUser(r, o, deps(db.url)) });
    await new Promise((res) => server.once("listening", res));
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await postSetup(base, { token: readSetupToken(dataRoot), email: "admin@example.com",
                                        password: "correct horse battery" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.passwordSet, true);
    const status = await fetch(`${base}/api/hash`, { headers: { authorization: `Bearer ${body.token}` } })
      .then((r) => r.status);
    assert.equal(status, 200, "the adopted Postgres roster authenticates the setup token");
    assert.equal(statSync(identityDbPath(dataRoot)).size, 0, "adoption never opened the SQLite roster");
  } finally {
    await new Promise((r) => (server ? server.close(r) : r()));
    await identity?.close?.();
    await db.drop();
  }
});

test("BLZ-706: two concurrent setup completions against Postgres create exactly one admin", PG_SKIP, async () => {
  const db = await scratchPgDb("idpg_race");
  let server, identity;
  try {
    const { dataRoot, projectsDir } = await pgBoard(db.url);
    identity = await resolveIdentity({ dataRoot, env: { BLAZE_WRITE_PORT: "db" },
      resolveDbConfig: () => ({ driver: "postgres", connection: db.url }), openPgPool: poolFor(db.url) });
    server = startServer({ root: dataRoot, projectsDir, port: 0, host: "0.0.0.0", identity,
      addUser: (r, o) => addUser(r, o, deps(db.url)) });
    await new Promise((res) => server.once("listening", res));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = readSetupToken(dataRoot);
    const statuses = (await Promise.all(["one@example.com", "two@example.com"].map((email) =>
      postSetup(base, { token, email, password: "correct horse battery" }).then((r) => r.status))))
      .sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(await userCount(db.url), 1, "exactly one admin");
  } finally {
    await new Promise((r) => (server ? server.close(r) : r()));
    await identity?.close?.();
    await db.drop();
  }
});

test("BLZ-706 (I4): startServer and createApp with no identity refuse a db-mode Postgres board", async () => {
  const { dataRoot, projectsDir } = dbBoard();
  const cfgPath = join(dataRoot, "blaze.config.json");
  writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")),
                                          database: { driver: "postgres" } }));
  const saved = process.env.BLAZE_WRITE_PORT;
  try {
    process.env.BLAZE_WRITE_PORT = "db";
    // A server that wrongly STARTS is closed before the assertion fails, so a regression here
    // reports as a failure instead of holding the test file open.
    assert.throws(() => {
      const leaked = startServer({ root: dataRoot, projectsDir, port: 0, host: "127.0.0.1" });
      leaked.close();
    }, /must be resolved before the server starts/);
    assert.throws(() => createApp(loadConfig({ root: dataRoot }), { root: dataRoot }),
      /must be resolved before the server starts/);

    delete process.env.BLAZE_WRITE_PORT;
    const server = startServer({ root: dataRoot, projectsDir, port: 0, host: "127.0.0.1" });
    await new Promise((res) => server.once("listening", res));
    await new Promise((r) => server.close(r));
    const app = createApp(loadConfig({ root: dataRoot }), { root: dataRoot });
    assert.ok(app.server, "an fs board still builds its app");
  } finally {
    if (saved === undefined) delete process.env.BLAZE_WRITE_PORT; else process.env.BLAZE_WRITE_PORT = saved;
  }
});

test("BLZ-706 (I4): blaze start on a v6 Postgres board authenticates from Postgres", PG_SKIP, async () => {
  const db = await scratchPgDb("idpg_start");
  let child;
  try {
    const { dataRoot, projectsDir } = await pgBoard(db.url);
    const token = await seedPgAdmin(db.url);
    zeroByteRoster(dataRoot);
    const port = await freePort();
    const s = spawnServer("supervisor.mjs", childEnv({ BLAZE_PROJECTS_DIR: projectsDir, BLAZE_WRITE_PORT: "db",
      PORT: String(port), ...pgEnvFor(db.url) }), /app → http:\/\/localhost:(\d+)/);
    child = s.child;
    assert.equal(await s.ready, port);
    assert.equal(await hash(port), 401, "no token is refused");
    assert.equal(await hash(port, token), 200, "the Postgres token authenticates");
    assert.equal(statSync(identityDbPath(dataRoot)).size, 0, "the SQLite roster was never opened");
  } finally { child?.kill(); await db.drop(); }
});
