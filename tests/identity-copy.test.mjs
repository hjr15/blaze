// tests/identity-copy.test.mjs — BLZ-706, `blaze db migrate --identity-from` (spec §3, review I5/M8).
//
// The six identity tables are copied VERBATIM from a board's identity.db into Postgres, inside
// the migrate transaction, and verified row for row before it commits. Hashes, verifiers and
// live sessions travel unchanged, so no credential is reissued: the old bearer token and the old
// browser session authenticate against Postgres afterwards. Every Postgres test gets its OWN
// scratch database (tests/helpers/pg-scratch.mjs). Run with --test-concurrency=1.
//
// CREDENTIALS NEVER REACH OUTPUT (global constraint A3): the plaintexts the fixture returns are
// used only to authenticate. No assertion message here interpolates one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchRegistry } from "./helpers/scratch.mjs";
import { IDENTITY_TABLES, readIdentityRows, verifyIdentity, canonicalIdentityRow }
  from "../scripts/model/identity-copy.mjs";
import { migrateDb } from "../scripts/model/db-migrate.mjs";
import { createDbSchema } from "../scripts/model/db-schema-version.mjs";
import { openIdentityDb, identityDbPath } from "../scripts/model/identity-db.mjs";
import { identityStore } from "../scripts/model/identity-store.mjs";
import { pgExec } from "../scripts/model/write-port-resolve.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { dbBoard } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient, makeV5 } from "./helpers/pg-scratch.mjs";

const scratch = scratchRegistry();

const capture = () => {
  const out = [], errs = [];
  const io = { log: (s) => out.push(String(s)), err: (s) => errs.push(String(s)), env: {} };
  return { io, out: () => out.join("\n"), err: () => errs.join("\n") };
};
const pgIo = (url) => ({
  resolveDbConfig: () => ({ driver: "postgres", connection: url }),
  openPostgresClient: (c) => pgClient(c),
});

async function withClient(url, fn) {
  const c = await pgClient(url);
  try { return await fn(c); } finally { await c.end(); }
}
const meta = (c, key) => c.query("SELECT value FROM blaze_meta WHERE key = $1", [key])
  .then((r) => r.rows[0]?.value ?? null);
const count = (c, t) => c.query(`SELECT count(*) AS n FROM ${t}`).then((r) => Number(r.rows[0].n));

/**
 * A roster with something in every table: an admin with a password, a token and two sessions
 * (one live, one expired); a member with two tokens, one revoked; a viewer.
 */
async function seedIdentityDb(dir) {
  const opened = openIdentityDb(dir, { create: true });
  try {
    const { store } = opened;
    const admin = await store.createUser({ email: "admin@example.com", role: "admin" });
    await store.setPassword({ email: "admin@example.com", password: "correct horse battery" });
    const { token: adminToken } = await store.issueToken({ userId: admin.id, name: "ci", scopes: ["read", "write"] });
    const member = await store.createUser({ email: "member@example.com", role: "member" });
    const { token: memberLive } = await store.issueToken({ userId: member.id, name: "live", scopes: ["read"] });
    const revoked = await store.issueToken({ userId: member.id, name: "old", scopes: ["read"] });
    await store.revokeToken(revoked.id);
    await store.createUser({ email: "viewer@example.com", role: "viewer" });
    const { token: sessionToken } = await store.createSession({ userId: admin.id, role: "admin" });
    const { token: expiredSession } = await store.createSession({ userId: admin.id, role: "admin", ttlMs: -1000 });
    return { path: opened.path, adminToken, memberLive, revokedToken: revoked.token, sessionToken, expiredSession };
  } finally { opened.db.close(); }
}
const seededDir = () => scratch(mkdtempSync(join(tmpdir(), "blz706-roster-")));

/** Every table of the SQLite source, canonicalised and keyed — read independently of the module. */
async function sqliteSide(path) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const out = {};
    for (const t of IDENTITY_TABLES) {
      out[t.name] = db.prepare(`SELECT * FROM ${t.name}`).all()
        .map((r) => canonicalIdentityRow({ ...r }, t.ts))
        .sort((a, b) => JSON.stringify(t.pk.map((k) => a[k])).localeCompare(JSON.stringify(t.pk.map((k) => b[k]))));
    }
    return out;
  } finally { db.close(); }
}
async function pgSide(c) {
  const out = {};
  for (const t of IDENTITY_TABLES) {
    out[t.name] = (await c.query(`SELECT * FROM ${t.name}`)).rows
      .map((r) => canonicalIdentityRow(r, t.ts))
      .sort((a, b) => JSON.stringify(t.pk.map((k) => a[k])).localeCompare(JSON.stringify(t.pk.map((k) => b[k]))));
  }
  return out;
}

test("BLZ-706: IDENTITY_TABLES names the six tables in FK order with their keys and timestamps", () => {
  assert.deepEqual(IDENTITY_TABLES, [
    { name: "app_user", pk: ["id"], ts: ["created_at"] },
    { name: "user_identity", pk: ["provider", "subject"], ts: ["created_at"] },
    { name: "membership", pk: ["user_id", "scope_key"], ts: ["created_at"] },
    { name: "api_token", pk: ["id"], ts: ["created_at", "last_used_at", "expires_at", "revoked_at"] },
    { name: "local_password", pk: ["user_id"], ts: ["created_at", "updated_at"] },
    { name: "user_session", pk: ["id"], ts: ["created_at", "last_used_at", "expires_at", "revoked_at"] },
  ]);
});

test("BLZ-706: canonicalIdentityRow normalises timestamps to UTC ms and sorts keys", () => {
  const a = canonicalIdentityRow({ b: 1, created_at: "2026-10-22T01:02:03.456Z" }, ["created_at"]);
  const b = canonicalIdentityRow({ created_at: new Date("2026-10-22T01:02:03.456Z"), b: 1 }, ["created_at"]);
  assert.deepStrictEqual(a, b);
  assert.deepEqual(Object.keys(a), ["b", "created_at"]);
  assert.equal(a.created_at, Date.parse("2026-10-22T01:02:03.456Z"));
  for (const empty of [null, undefined, ""]) {
    assert.equal(canonicalIdentityRow({ revoked_at: empty }, ["revoked_at"]).revoked_at, null);
  }
  assert.throws(() => canonicalIdentityRow({ created_at: "not a date" }, ["created_at"]), (e) => {
    assert.match(e.message, /unreadable timestamp in created_at/);
    assert.doesNotMatch(e.message, /not a date/, "the value itself is never named");
    return true;
  });
});

test("BLZ-706: readIdentityRows refuses a missing file by path", async () => {
  await assert.rejects(readIdentityRows("/nonexistent/identity.db"),
    /^Error: blaze: no identity database at \/nonexistent\/identity\.db$/);
});

test("BLZ-706: a pre-BLZ-566 roster reads its missing tables as absent", async () => {
  const dir = seededDir();
  const { path } = await seedIdentityDb(dir);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec("DROP TABLE user_session; DROP TABLE local_password;");
  db.close();
  const rows = await readIdentityRows(path);
  assert.deepEqual(rows.local_password, { rows: [], absent: true });
  assert.deepEqual(rows.user_session, { rows: [], absent: true });
  assert.equal(rows.app_user.absent, false);
  assert.equal(rows.app_user.rows.length, 3);
});

test("BLZ-706: every table copies with zero row diffs", PG_SKIP, async () => {
  const db = await scratchPgDb("idc_copy");
  try {
    const { path } = await seedIdentityDb(seededDir());
    await makeV5(db.url);
    const got = await withClient(db.url, async (c) =>
      migrateDb(pgExec(c), { identityRows: await readIdentityRows(path) }));
    const { DatabaseSync } = await import("node:sqlite");
    const src = new DatabaseSync(path, { readOnly: true });
    const want = Object.fromEntries(IDENTITY_TABLES.map((t) =>
      [t.name, Number(src.prepare(`SELECT count(*) AS n FROM ${t.name}`).get().n)]));
    src.close();
    assert.deepEqual(got.identity, want);
    for (const t of IDENTITY_TABLES) assert.ok(want[t.name] >= 1, `${t.name} holds no row in the fixture`);
    const left = await sqliteSide(path);
    const right = await withClient(db.url, (c) => pgSide(c));
    for (const t of IDENTITY_TABLES) assert.deepStrictEqual(right[t.name], left[t.name], `${t.name} differs`);
  } finally { await db.drop(); }
});

test("BLZ-706: after the copy, the old bearer token and the old session authenticate", PG_SKIP, async () => {
  const db = await scratchPgDb("idc_auth");
  try {
    const seed = await seedIdentityDb(seededDir());
    await makeV5(db.url);
    await withClient(db.url, async (c) =>
      migrateDb(pgExec(c), { identityRows: await readIdentityRows(seed.path) }));
    await withClient(db.url, async (c) => {
      const store = identityStore(pgExec(c), { dialect: "postgres" });
      assert.equal((await store.authenticate({ presented: seed.adminToken, operation: "write" })).ok, true,
        "the admin's bearer token");
      assert.equal((await store.authenticateSession({ presented: seed.sessionToken, operation: "read" })).ok, true,
        "the admin's live session");
      assert.equal((await store.authenticate({ presented: seed.revokedToken, operation: "read" })).ok, false,
        "the revoked token");
      assert.equal((await store.authenticateSession({ presented: seed.expiredSession, operation: "read" })).ok, false,
        "the expired session");
    });
  } finally { await db.drop(); }
});

test("BLZ-706: a one-byte hash change aborts the whole migration", PG_SKIP, async () => {
  const db = await scratchPgDb("idc_disc");
  try {
    const { path } = await seedIdentityDb(seededDir());
    await makeV5(db.url);
    const source = await readIdentityRows(path);
    const hashes = source.api_token.rows.map((r) => r.token_hash);
    await withClient(db.url, (c) => assert.rejects(
      migrateDb(pgExec(c), {
        identityRows: source,
        beforeVerify: (e) => e.run("UPDATE api_token SET token_hash = overlay(token_hash placing 'x' from 1 for 1) "
          + "WHERE revoked_at IS NULL"),
      }),
      (e) => {
        assert.match(e.message, /api_token row .* differs in token_hash/);
        assert.ok(!hashes.some((h) => e.message.includes(h)), "the message names no hash value");
        assert.ok(!hashes.some((h) => e.message.includes(`x${h.slice(1)}`)), "nor the altered one");
        return true;
      }));
    await withClient(db.url, async (c) => {
      assert.equal(await meta(c, "schema_version"), "5");
      assert.equal((await c.query("SELECT to_regclass('app_user') AS r")).rows[0].r, null);
    });
  } finally { await db.drop(); }
});

test("BLZ-706: the copy refuses tables that already hold users", PG_SKIP, async () => {
  const db = await scratchPgDb("idc_full");
  try {
    const { path } = await seedIdentityDb(seededDir());
    await withClient(db.url, async (c) => {
      await createDbSchema(pgExec(c), { dialect: "postgres" });
      await c.query(`INSERT INTO app_user (id, email, display_name, created_at)
                     VALUES ('u1', 'a@example.com', 'A', now())`);
      await assert.rejects(migrateDb(pgExec(c), { identityRows: await readIdentityRows(path) }),
        /already holds 1 row/);
      assert.equal(await count(c, "app_user"), 1);
    });
  } finally { await db.drop(); }
});

test("BLZ-706: a missing source is refused before anything connects", async () => {
  const c = capture();
  const code = await runDb(["migrate", "--identity-from", "/nonexistent/identity.db"], {
    ...c.io, roots: dbBoard(),
    resolveDbConfig: () => ({ driver: "postgres", connection: "postgres://u@127.0.0.1:1/x" }),
    openPostgresClient: () => { throw new Error("must not connect"); },
  });
  assert.equal(code, 1);
  assert.match(c.err(), /no identity database at/);
  assert.match(c.err(), /Nothing was migrated/);
  assert.doesNotMatch(c.err(), /must not connect/);
  assert.doesNotMatch(c.err(), /blaze: no identity/, "one 'blaze: ' prefix is stripped (M6)");
});

/** A db board whose own `.blaze/identity.db` holds one user. */
async function boardWithRoster() {
  const roots = dbBoard();
  const opened = openIdentityDb(roots.dataRoot, { create: true });
  try { await opened.store.createUser({ email: "only@example.com", role: "admin" }); }
  finally { opened.db.close(); }
  return roots;
}

test("BLZ-706 (I5): migrate refuses while .blaze/identity.db exists and nothing says what to do with it",
     PG_SKIP, async () => {
  const db = await scratchPgDb("idc_i5");
  try {
    const roots = await boardWithRoster();
    await makeV5(db.url);
    const c = capture();
    assert.equal(await runDb(["migrate"], { ...c.io, roots, ...pgIo(db.url),
      openPostgresClient: () => { throw new Error("must not connect"); } }), 1);
    assert.match(c.err(), /would not copy them/);
    assert.match(c.err(), /--identity-from/);
    assert.ok(c.err().includes(identityDbPath(roots.dataRoot)), "the file is named");
    assert.match(c.err(), /Nothing was migrated/);
    await withClient(db.url, async (k) => assert.equal(await meta(k, "schema_version"), "5"));
  } finally { await db.drop(); }
});

test("BLZ-706 (I5): --no-identity-import proceeds and copies nothing", PG_SKIP, async () => {
  const db = await scratchPgDb("idc_noimp");
  try {
    const roots = await boardWithRoster();
    await makeV5(db.url);
    const c = capture();
    assert.equal(await runDb(["migrate", "--no-identity-import"], { ...c.io, roots, ...pgIo(db.url) }), 0, c.err());
    await withClient(db.url, async (k) => {
      assert.equal(await meta(k, "schema_version"), "6");
      assert.equal(await count(k, "app_user"), 0);
    });
  } finally { await db.drop(); }
});

test("BLZ-706 (I5): --identity-from with --no-identity-import is refused", async () => {
  const roots = await boardWithRoster();
  const c = capture();
  const code = await runDb(["migrate", "--identity-from", identityDbPath(roots.dataRoot), "--no-identity-import"], {
    ...c.io, roots,
    resolveDbConfig: () => ({ driver: "postgres", connection: "postgres://u@127.0.0.1:1/x" }),
    openPostgresClient: () => { throw new Error("must not connect"); },
  });
  assert.equal(code, 1);
  assert.match(c.err(), /contradict/);
});

test("BLZ-706 (M8): the verify pairs rows by key, not position", PG_SKIP, async () => {
  const db = await scratchPgDb("idc_m8");
  try {
    const { path } = await seedIdentityDb(seededDir());
    await makeV5(db.url);
    const source = await readIdentityRows(path);
    await withClient(db.url, (c) => migrateDb(pgExec(c), { identityRows: source }));
    const reversed = { ...source, user_identity: { ...source.user_identity, rows: [...source.user_identity.rows].reverse() } };
    await withClient(db.url, (c) => verifyIdentity(pgExec(c), reversed));
  } finally { await db.drop(); }
});

test("BLZ-706: the CLI prints per-table counts and never a credential", PG_SKIP, async () => {
  const db = await scratchPgDb("idc_cli");
  try {
    const seed = await seedIdentityDb(seededDir());
    await makeV5(db.url);
    const c = capture();
    assert.equal(await runDb(["migrate", "--identity-from", seed.path], { ...c.io, roots: dbBoard(), ...pgIo(db.url) }),
      0, "migrate --identity-from exited non-zero");
    assert.match(c.out(), /app_user 3 · user_identity 3 · membership 3 · api_token 3 · local_password 1 · user_session 2/);
    assert.match(c.out(), /\(row-for-row verified\)/);
    const all = `${c.out()}\n${c.err()}`;
    assert.ok(!new RegExp(`${seed.adminToken}|blz_`).test(all), "a credential reached the output");
  } finally { await db.drop(); }
});

test("BLZ-706: the CLI marks a table the source does not have", PG_SKIP, async () => {
  const db = await scratchPgDb("idc_absent");
  try {
    const { path } = await seedIdentityDb(seededDir());
    const { DatabaseSync } = await import("node:sqlite");
    const s = new DatabaseSync(path);
    s.exec("DROP TABLE user_session; DROP TABLE local_password;");
    s.close();
    await makeV5(db.url);
    const c = capture();
    assert.equal(await runDb(["migrate", "--identity-from", path], { ...c.io, roots: dbBoard(), ...pgIo(db.url) }), 0);
    assert.match(c.out(), /local_password 0 \(absent in source\) · user_session 0 \(absent in source\)/);
  } finally { await db.drop(); }
});
