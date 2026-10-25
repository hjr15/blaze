// tests/db-migrate.test.mjs — BLZ-705, schema v6 and `blaze db migrate` (spec D1(b)).
//
// `migrateDb` brings a Postgres database forward, in ONE transaction, and marks it
// authoritative. These tests pin the transition (v5 → v6), the no-op re-run, the rollback on a
// failed step, the named refusals (newer, unstamped, empty), serialisation of two concurrent
// migrates, and the `load --replace` refusal on an authoritative database. Every test gets its
// OWN scratch database (tests/helpers/pg-scratch.mjs). Run with --test-concurrency=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrateDb } from "../scripts/model/db-migrate.mjs";
import { createDbSchema } from "../scripts/model/db-schema-version.mjs";
import { identityDdl } from "../scripts/model/identity-schema.mjs";
import { pgExec } from "../scripts/model/write-port-resolve.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { dbBoard } from "./helpers/db-board.mjs";
import { openIdentityDb } from "../scripts/model/identity-db.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PG_SKIP, scratchPgDb, pgClient, makeV5 } from "./helpers/pg-scratch.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const V6_TABLES = ["app_user", "user_identity", "membership", "api_token", "local_password",
                   "user_session", "sprint", "sprint_registry"];

const capture = () => {
  const out = [], errs = [];
  const io = { log: (s) => out.push(String(s)), err: (s) => errs.push(String(s)), env: {} };
  return { io, out: () => out.join("\n"), err: () => errs.join("\n") };
};
const pgIo = (url) => ({
  resolveDbConfig: () => ({ driver: "postgres", connection: url }),
  openPostgresClient: (c) => pgClient(c),
});

/** Run `fn(client)` on a fresh connection to `url`, always closing it. */
async function withClient(url, fn) {
  const c = await pgClient(url);
  try { return await fn(c); } finally { await c.end(); }
}
const meta = (c, key) => c.query("SELECT value FROM blaze_meta WHERE key = $1", [key])
  .then((r) => r.rows[0]?.value ?? null);
const regclass = (c, t) => c.query("SELECT to_regclass($1) AS r", [t]).then((r) => r.rows[0].r);

test("BLZ-705: a v5 database migrates to v6 in one transaction", PG_SKIP, async () => {
  const db = await scratchPgDb("mig_v5");
  try {
    await makeV5(db.url);
    const got = await withClient(db.url, (c) => migrateDb(pgExec(c)));
    assert.deepEqual({ from: got.from, to: got.to, steps: got.steps, authoritative: got.authoritative },
      { from: 5, to: 6, steps: [5], authoritative: "written" });
    await withClient(db.url, async (c) => {
      assert.equal(await meta(c, "schema_version"), "6");
      assert.equal(await meta(c, "authoritative"), "true");
      for (const t of V6_TABLES) assert.notEqual(await regclass(c, t), null, `${t} was not created`);
    });
  } finally { await db.drop(); }
});

test("BLZ-705: a second run is a no-op", PG_SKIP, async () => {
  const db = await scratchPgDb("mig_twice");
  try {
    await makeV5(db.url);
    await withClient(db.url, (c) => migrateDb(pgExec(c)));
    const again = await withClient(db.url, (c) => migrateDb(pgExec(c)));
    assert.deepEqual({ from: again.from, to: again.to, steps: again.steps, authoritative: again.authoritative },
      { from: 6, to: 6, steps: [], authoritative: "already" });
  } finally { await db.drop(); }
});

test("BLZ-705: a failure mid-step leaves v5 intact", PG_SKIP, async () => {
  const db = await scratchPgDb("mig_fail");
  try {
    await makeV5(db.url);
    const migrations = new Map([[5, async (e) => { await e.run(identityDdl("postgres")); throw new Error("injected"); }]]);
    await withClient(db.url, (c) => assert.rejects(migrateDb(pgExec(c), { migrations }), /injected/));
    await withClient(db.url, async (c) => {
      assert.equal(await meta(c, "schema_version"), "5");
      assert.equal(await regclass(c, "app_user"), null, "the DDL the failed step ran was rolled back");
      assert.equal(await meta(c, "authoritative"), null);
    });
  } finally { await db.drop(); }
});

test("BLZ-705: newer, unstamped and empty databases are refused by name", PG_SKIP, async () => {
  const newer = await scratchPgDb("mig_newer");
  const unstamped = await scratchPgDb("mig_unst");
  const empty = await scratchPgDb("mig_empty");
  try {
    await withClient(newer.url, async (c) => {
      await createDbSchema(pgExec(c), { dialect: "postgres" });
      await c.query("UPDATE blaze_meta SET value = '99' WHERE key = 'schema_version'");
      await assert.rejects(migrateDb(pgExec(c)), /newer/);
    });
    await withClient(unstamped.url, async (c) => {
      await createDbSchema(pgExec(c), { dialect: "postgres" });
      await c.query("DELETE FROM blaze_meta WHERE key = 'schema_version'");
      await assert.rejects(migrateDb(pgExec(c)), /no Blaze schema stamp/);
    });
    await withClient(empty.url, async (c) => {
      await assert.rejects(migrateDb(pgExec(c)), (e) => {
        assert.match(e.message, /blaze db init/);
        assert.doesNotMatch(e.message, /does not exist/, "the raw relation error must not surface");
        return true;
      });
    });
  } finally { await newer.drop(); await unstamped.drop(); await empty.drop(); }
});

test("BLZ-705: two concurrent migrates serialise — one migrates, the other sees v6", PG_SKIP, async () => {
  const db = await scratchPgDb("mig_conc");
  try {
    await makeV5(db.url);
    const a = await pgClient(db.url);
    const b = await pgClient(db.url);
    let results;
    try { results = await Promise.all([migrateDb(pgExec(a)), migrateDb(pgExec(b))]); }
    finally { await a.end(); await b.end(); }
    const steps = results.map((r) => JSON.stringify(r.steps)).sort();
    assert.deepEqual(steps, ["[5]", "[]"]);
    await withClient(db.url, async (c) => assert.equal(await meta(c, "schema_version"), "6"));
  } finally { await db.drop(); }
});

test("BLZ-705: a fresh v6 create holds the v6 tables and is not authoritative", PG_SKIP, async () => {
  const db = await scratchPgDb("mig_fresh");
  try {
    await withClient(db.url, async (c) => {
      await createDbSchema(pgExec(c), { dialect: "postgres" });
      for (const t of V6_TABLES) assert.notEqual(await regclass(c, t), null, `${t} was not created`);
      assert.equal(await meta(c, "authoritative"), null);
    });
  } finally { await db.drop(); }
});

test("BLZ-705: blaze db migrate prints the transition and exits 0", PG_SKIP, async () => {
  const db = await scratchPgDb("mig_cmd");
  try {
    await makeV5(db.url);
    const c = capture();
    assert.equal(await runDb(["migrate"], { ...c.io, roots: dbBoard(), ...pgIo(db.url) }), 0, c.err());
    assert.ok(c.out().includes("schema         v5 → v6"), c.out());
    assert.ok(c.out().includes("migrate: DONE"), c.out());
  } finally { await db.drop(); }
});

test("BLZ-705: blaze db migrate refuses the SQLite shadow", async () => {
  const c = capture();
  assert.equal(await runDb(["migrate"], { ...c.io, roots: dbBoard() }), 1);
  assert.match(c.err(), /blaze db init --force/);
});

test("BLZ-705: load --replace refuses an authoritative database and erases nothing", PG_SKIP, async () => {
  const db = await scratchPgDb("mig_load");
  try {
    const roots = dbBoard();
    await withClient(db.url, (c) => createDbSchema(pgExec(c), { dialect: "postgres" }));
    assert.equal(await runDb(["load"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    await withClient(db.url, (c) => migrateDb(pgExec(c)));
    const c = capture();
    assert.equal(await runDb(["load", "--replace"], { ...c.io, roots, ...pgIo(db.url) }), 1);
    assert.match(c.err(), /is authoritative/);
    assert.match(c.err(), /pg_restore/);
    await withClient(db.url, async (k) =>
      assert.equal(Number((await k.query("SELECT count(*) AS n FROM ticket")).rows[0].n), 1));
  } finally { await db.drop(); }
});

test("BLZ-705: load --replace on a NON-authoritative database still works, and leaves identity and sprint tables untouched",
     PG_SKIP, async () => {
  const db = await scratchPgDb("mig_nonauth");
  try {
    const roots = dbBoard();
    await withClient(db.url, async (c) => {
      await createDbSchema(pgExec(c), { dialect: "postgres" });
      await c.query(`INSERT INTO app_user (id, email, display_name, created_at)
                     VALUES ('u1', 'a@example.com', 'A', now())`);
      await c.query("INSERT INTO sprint (id, name, ord) VALUES ('S1', 'One', 0)");
    });
    const c1 = capture();
    assert.equal(await runDb(["load"], { ...c1.io, roots, ...pgIo(db.url) }), 0, c1.err());
    const c2 = capture();
    assert.equal(await runDb(["load", "--replace"], { ...c2.io, roots, ...pgIo(db.url) }), 0, c2.err());
    await withClient(db.url, async (c) => {
      const n = async (t) => Number((await c.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
      assert.equal(await n("app_user"), 1, "load --replace reached app_user");
      assert.equal(await n("sprint"), 1, "load --replace reached sprint");
    });
  } finally { await db.drop(); }
});

// ── BLZ-705: Task 1 review minors ──────────────────────────────────────────────────────────

test("BLZ-705: migrateDb opens its transaction READ COMMITTED, whatever the server default", async () => {
  const sql = [];
  const exec = { run: async (s) => { sql.push(s); }, all: async () => { throw new Error("stop here"); } };
  await assert.rejects(migrateDb(exec));
  assert.equal(sql[0], "BEGIN ISOLATION LEVEL READ COMMITTED");
});

test("BLZ-705: a non-'true' authoritative row is set true, and reported as written", PG_SKIP, async () => {
  const db = await scratchPgDb("mig_authfalse");
  try {
    await withClient(db.url, async (c) => {
      await createDbSchema(pgExec(c), { dialect: "postgres" });
      await c.query("INSERT INTO blaze_meta (key, value) VALUES ('authoritative', 'false')");
      assert.equal((await migrateDb(pgExec(c))).authoritative, "written");
      assert.equal(await meta(c, "authoritative"), "true");
      assert.equal((await migrateDb(pgExec(c))).authoritative, "already");
    });
  } finally { await db.drop(); }
});

test("BLZ-705: load --replace re-checks the authoritative flag inside its transaction", PG_SKIP, async () => {
  const db = await scratchPgDb("mig_toctou");
  try {
    const roots = dbBoard();
    await withClient(db.url, (c) => createDbSchema(pgExec(c), { dialect: "postgres" }));
    assert.equal(await runDb(["load"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    const { buildTransitions } = await import("../scripts/model/transitions.mjs");
    // Between the early check and BEGIN, another session marks the database authoritative.
    // The git walk is the injectable step in that window, and it is synchronous, so the flip
    // runs in a child process that has committed before the walk returns.
    const flip = () => {
      const r = spawnSync(process.execPath, ["--input-type=module", "-e",
        "import pg from 'pg'; const c = new pg.Client(process.env.U); await c.connect();"
        + " await c.query(\"INSERT INTO blaze_meta (key, value) VALUES ('authoritative', 'true')\"); await c.end();"],
        { cwd: REPO, env: { ...process.env, U: db.url }, encoding: "utf8" });
      assert.equal(r.status, 0, "the flip did not commit");
    };
    const c = capture();
    const code = await runDb(["load", "--replace"], { ...c.io, roots, ...pgIo(db.url),
      buildTransitions: (o) => { flip(); return buildTransitions(o); } });
    assert.equal(code, 1, "load --replace truncated a database that became authoritative");
    assert.match(c.err(), /is authoritative/);
    await withClient(db.url, async (k) =>
      assert.equal(Number((await k.query("SELECT count(*) AS n FROM ticket")).rows[0].n), 1));
  } finally { await db.drop(); }
});

test("BLZ-705: --identity-from=path is the same flag, and a path is required", async () => {
  const noPg = { resolveDbConfig: () => ({ driver: "postgres", connection: "postgres://u@127.0.0.1:1/x" }),
                 openPostgresClient: () => { throw new Error("must not connect"); } };
  const a = capture();
  assert.equal(await runDb(["migrate", "--identity-from=/nonexistent/identity.db"], { ...a.io, roots: dbBoard(), ...noPg }), 1);
  assert.match(a.err(), /no identity database at \/nonexistent\/identity\.db/);
  for (const argv of [["migrate", "--identity-from"], ["migrate", "--identity-from="],
                      ["migrate", "--sprints-from", "--no-identity-import"], ["migrate", "--sprints-from="]]) {
    const b = capture();
    assert.equal(await runDb(argv, { ...b.io, roots: dbBoard(), ...noPg }), 1, argv.join(" "));
    assert.match(b.err(), /--(identity|sprints)-from needs a path/, argv.join(" "));
  }
});

test("BLZ-705: --identity-from and --sprints-from are refused on any verb but migrate", async () => {
  for (const argv of [["load", "--identity-from", "x"], ["verify", "--sprints-from=x"],
                      ["seed-counter", "--identity-from=x"]]) {
    const c = capture();
    assert.equal(await runDb(argv, { ...c.io, roots: dbBoard() }), 1, argv.join(" "));
    assert.match(c.err(), /applies to 'blaze db migrate' only/, argv.join(" "));
  }
});

// ── E1 final review M8: the schema is judged before the stranded-file refusals ──────────────

/** A db board with BOTH stranded files: a populated identity.db and a sprints.json. */
async function strandedBoard() {
  const roots = dbBoard();
  const opened = openIdentityDb(roots.dataRoot, { create: true });
  try { await opened.store.createUser({ email: "only@example.com", role: "admin" }); }
  finally { opened.db.close(); }
  writeFileSync(join(roots.dataRoot, "sprints.json"), JSON.stringify({ active: null, sprints: [] }));
  return roots;
}

test("BLZ-705 (final M8): a newer, too-old or empty database is refused before the stranded-file refusals",
     PG_SKIP, async () => {
  const newer = await scratchPgDb("mig_m8_newer");
  const old = await scratchPgDb("mig_m8_old");
  const empty = await scratchPgDb("mig_m8_empty");
  try {
    const roots = await strandedBoard();
    await withClient(newer.url, async (c) => {
      await createDbSchema(pgExec(c), { dialect: "postgres" });
      await c.query("UPDATE blaze_meta SET value = '99' WHERE key = 'schema_version'");
    });
    await makeV5(old.url);
    await withClient(old.url, (c) => c.query("UPDATE blaze_meta SET value = '4' WHERE key = 'schema_version'"));
    for (const [db, want] of [[newer, /newer than this engine/], [old, /no migration path from version 4/],
                              [empty, /holds no Blaze schema/]]) {
      const c = capture();
      assert.equal(await runDb(["migrate"], { ...c.io, roots, ...pgIo(db.url) }), 1);
      assert.ok(want.test(c.err()), `${want}: the schema refusal is not first`);
      assert.ok(!/would not copy them|already imported|--identity-from|--sprints-from/.test(c.err()),
        `${want}: a stranded-file refusal was printed for a database migrate cannot take`);
      assert.ok(/Nothing was migrated/.test(c.err()), `${want}: nothing-migrated is not stated`);
    }
    await withClient(newer.url, async (c) => assert.equal(await meta(c, "schema_version"), "99"));
    await withClient(old.url, async (c) => assert.equal(await meta(c, "schema_version"), "4"));
  } finally { await newer.drop(); await old.drop(); await empty.drop(); }
});
