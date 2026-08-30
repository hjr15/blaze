// tests/model/session-store.test.mjs — BLZ-566. Browser sessions, in identity.db.
//
// A SESSION IS AN api_token'S SIBLING, NOT ITS COUSIN. It is stored hashed, it is scoped,
// it expires, and — the part that matters — it is verified by the SAME `verify()` that
// ADR-0013 §1's invariant lives in. That is not a tidiness choice: re-implementing the
// role intersection for a second credential type is exactly how a second credential type
// ends up outliving its owner's demotion.
//
// So every test below that asserts an intersection property is asserting it of shared
// code. The one that would catch a re-implementation is
// "demoting the owner narrows a LIVE session on the very next request".
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIdentityDb, identityDbPath } from "../../scripts/model/identity-db.mjs";
import { identityStore } from "../../scripts/model/identity-store.mjs";
import { SESSION_PREFIX, TOKEN_PREFIX } from "../../scripts/model/identity.mjs";

const roots = [];
function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-sessionstore-"));
  roots.push(root);
  return root;
}
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const PASSWORD = "correct horse battery staple";

async function seed({ role = "admin" } = {}) {
  const root = board();
  const opened = openIdentityDb(root, { create: true });
  const user = await opened.store.createUser({ email: "Op@Example.com", role });
  await opened.store.setPassword({ email: "op@example.com", password: PASSWORD });
  return { root, opened, store: opened.store, user };
}

describe("a password reaches the database only as a verifier", () => {
  test("the password string is nowhere in identity.db", async () => {
    const { root, opened } = await seed();
    opened.db.close();
    const bytes = readFileSync(identityDbPath(root));
    assert.equal(bytes.includes(Buffer.from(PASSWORD)), false,
      "identity.db must never hold a password in the clear");
    assert.equal(bytes.includes(Buffer.from("scrypt$")), true,
      "…it holds the scrypt verifier instead");
  });

  test("setPassword refuses a password the policy refuses, and stores nothing", async () => {
    const { store } = await seed();
    await assert.rejects(() => store.setPassword({ email: "op@example.com", password: "short" }),
      /at least 12 characters/);
  });

  test("setPassword on an unknown email is refused rather than silently ignored", async () => {
    const { store } = await seed();
    await assert.rejects(() => store.setPassword({ email: "nobody@example.com", password: PASSWORD }),
      /no such user/);
  });

  test("a password is set case-insensitively on the folded address", async () => {
    const { store } = await seed();
    // The user was created as Op@Example.com; identity-store folds on the way in.
    await store.setPassword({ email: "OP@EXAMPLE.COM", password: "another good passphrase" });
    assert.equal((await store.signIn({ email: "op@example.com", password: "another good passphrase" })).ok, true);
  });
});

describe("sign-in is a real credential check", () => {
  test("the right password mints a session; the wrong one mints nothing", async () => {
    const { store } = await seed();
    const good = await store.signIn({ email: "op@example.com", password: PASSWORD });
    assert.equal(good.ok, true);
    assert.match(good.token, /^blz_sess\./);
    const bad = await store.signIn({ email: "op@example.com", password: `${PASSWORD}!` });
    assert.equal(bad.ok, false);
    assert.equal(bad.token, undefined, "a refused sign-in hands back no credential at all");
  });

  test("an unknown account and a wrong password are refused identically", async () => {
    const { store } = await seed();
    const unknown = await store.signIn({ email: "nobody@example.com", password: PASSWORD });
    const wrong = await store.signIn({ email: "op@example.com", password: "not the password" });
    assert.deepEqual(unknown, wrong,
      "the two refusals must be indistinguishable — otherwise sign-in enumerates accounts");
  });

  test("an account with NO password set cannot be signed into", async () => {
    const { root, opened } = await seed();
    await opened.store.createUser({ email: "silent@example.com", role: "member" });
    const r = await opened.store.signIn({ email: "silent@example.com", password: PASSWORD });
    assert.equal(r.ok, false);
    assert.ok(root);
  });

  test("a suspended account is refused, with the same body as a wrong password", async () => {
    const { opened, store, user } = await seed();
    await opened.exec.run("UPDATE app_user SET status = 'suspended' WHERE id = ?", [user.id]);
    const suspended = await store.signIn({ email: "op@example.com", password: PASSWORD });
    const wrong = await store.signIn({ email: "op@example.com", password: "not the password" });
    assert.equal(suspended.ok, false);
    assert.deepEqual(suspended, wrong);
  });

  test("an account with no membership is refused, with the same body", async () => {
    const { opened, store, user } = await seed();
    await opened.exec.run("DELETE FROM membership WHERE user_id = ?", [user.id]);
    const noRole = await store.signIn({ email: "op@example.com", password: PASSWORD });
    const wrong = await store.signIn({ email: "op@example.com", password: "not the password" });
    assert.equal(noRole.ok, false);
    assert.deepEqual(noRole, wrong);
  });
});

describe("a session is scoped, expiring, and never larger than its owner", () => {
  test("a session authenticates the operations its owner's role allows", async () => {
    const { store } = await seed({ role: "member" });
    const { token } = await store.signIn({ email: "op@example.com", password: PASSWORD });
    assert.equal((await store.authenticateSession({ presented: token, operation: "read" })).ok, true);
    assert.equal((await store.authenticateSession({ presented: token, operation: "write" })).ok, true);
    const admin = await store.authenticateSession({ presented: token, operation: "admin" });
    assert.equal(admin.ok, false, "a member's session must not carry admin");
    assert.equal(admin.status, 403);
  });

  test("demoting the owner narrows a LIVE session on the very next request", async () => {
    const { store, user } = await seed({ role: "admin" });
    const { token } = await store.signIn({ email: "op@example.com", password: PASSWORD });
    assert.equal((await store.authenticateSession({ presented: token, operation: "admin" })).ok, true);
    await store.setRole({ userId: user.id, role: "viewer" });
    // No session bookkeeping happened. The scopes are re-derived from the CURRENT role.
    assert.equal((await store.authenticateSession({ presented: token, operation: "admin" })).ok, false);
    assert.equal((await store.authenticateSession({ presented: token, operation: "write" })).ok, false);
    assert.equal((await store.authenticateSession({ presented: token, operation: "read" })).ok, true);
  });

  test("an expired session is refused", async () => {
    const { store } = await seed();
    const { token } = await store.signIn({ email: "op@example.com", password: PASSWORD, ttlMs: -1000 });
    const r = await store.authenticateSession({ presented: token, operation: "read" });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });

  test("a session ALWAYS carries an expiry — there is no unexpiring session", async () => {
    const { store, opened } = await seed();
    await store.signIn({ email: "op@example.com", password: PASSWORD });
    const rows = await opened.exec.all("SELECT expires_at FROM user_session", []);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].expires_at, "expires_at is NOT NULL in the schema and set by createSession");
  });

  test("the DATABASE refuses a session row with no expiry, not merely the code path",
    async () => {
      const { opened, user } = await seed();
      // `createSession` always computes one, so the NOT NULL is belt to that braces —
      // and a guard nothing exercises is a guard that gets dropped in the next edit.
      // This is the only caller that can reach it, so it is written by hand.
      assert.throws(() => opened.exec.run(
        `INSERT INTO user_session (id, user_id, token_hash, scopes, created_at, expires_at)
         VALUES ('s1', ?, 'h', 'read', '2026-01-01T00:00:00.000Z', NULL)`, [user.id]),
        /NOT NULL/, "there is no unexpiring session, and the schema is where that is said");
    });

  test("a revoked session stops authenticating", async () => {
    const { store } = await seed();
    const { token, id } = await store.signIn({ email: "op@example.com", password: PASSWORD });
    assert.equal((await store.authenticateSession({ presented: token, operation: "read" })).ok, true);
    await store.revokeSession(id);
    assert.equal((await store.authenticateSession({ presented: token, operation: "read" })).ok, false);
  });

  test("the session value is stored only as a hash", async () => {
    const { root, store, opened } = await seed();
    const { token } = await store.signIn({ email: "op@example.com", password: PASSWORD });
    opened.db.close();
    const bytes = readFileSync(identityDbPath(root));
    assert.equal(bytes.includes(Buffer.from(token)), false,
      "a database dump must not yield a working session");
  });
});

describe("the two credential kinds do not stand in for one another", () => {
  test("the session prefix cannot be produced by the API token generator", () => {
    assert.ok(SESSION_PREFIX.startsWith(TOKEN_PREFIX),
      "a session is still a blaze credential, so secret-scanning still catches it");
    const tail = SESSION_PREFIX.slice(TOKEN_PREFIX.length);
    assert.match(tail, /[^A-Za-z0-9_-]/,
      "…and it contains a character base64url cannot emit, so no api_token can ever "
      + "collide with it by chance");
  });

  // WHAT THE PREFIX CHECKS ACTUALLY BUY, PINNED HONESTLY.
  //
  // The two tests below this comment ("an API token is not accepted as a session", "a
  // session is not accepted as an API token") PASS WITH THE PREFIX CHECKS REMOVED —
  // measured, not assumed. The credentials live in different tables, so a wrong-door
  // lookup finds nothing and `verify()` refuses it anyway. They are worth keeping as
  // outcome tests, and they are not what pins the guards.
  //
  // What the guards buy is that a wrongly-shaped credential NEVER REACHES THE DATABASE.
  // That is the same rule `authenticate` has applied since BLZ-303 — "an empty or
  // wrongly-shaped credential must not cost a database round trip, or an unauthenticated
  // flood becomes load" — and a browser sends its cookie on every single request to the
  // origin, so this is the door that flood would come through. These two assert it.
  test("a session presented as a bearer token costs no database round trip", async () => {
    const queries = [];
    const store = identityStore({ run: (q) => queries.push(q), all: (q) => { queries.push(q); return []; } },
      { dialect: "sqlite" });
    const r = await store.authenticate({ presented: `${SESSION_PREFIX}whatever`, operation: "read" });
    assert.equal(r.ok, false);
    assert.deepEqual(queries, [], "refused on shape alone, before any lookup");
  });

  test("an API token presented as a session costs no database round trip", async () => {
    const queries = [];
    const store = identityStore({ run: (q) => queries.push(q), all: (q) => { queries.push(q); return []; } },
      { dialect: "sqlite" });
    const r = await store.authenticateSession({ presented: `${TOKEN_PREFIX}whatever`, operation: "read" });
    assert.equal(r.ok, false);
    assert.deepEqual(queries, [], "refused on shape alone, before any lookup");
  });

  test("an API token is not accepted as a session", async () => {
    const { store, user } = await seed();
    const t = await store.issueToken({ userId: user.id, name: "api", scopes: ["read"] });
    const r = await store.authenticateSession({ presented: t.token, operation: "read" });
    assert.equal(r.ok, false, "an api_token presented as a session must not authenticate");
  });

  test("a session is not accepted as an API token", async () => {
    const { store } = await seed();
    const { token } = await store.signIn({ email: "op@example.com", password: PASSWORD });
    const r = await store.authenticate({ presented: token, operation: "read" });
    assert.equal(r.ok, false, "a session presented as a bearer token must not authenticate");
  });

  test("`blaze user tokens` never lists a session as an API token", async () => {
    const { store, user } = await seed();
    await store.issueToken({ userId: user.id, name: "api", scopes: ["read"] });
    await store.signIn({ email: "op@example.com", password: PASSWORD });
    const listed = await store.listTokens(user.id);
    assert.equal(listed.length, 1, "only the API token — the session is not one");
    assert.equal((await store.listSessions(user.id)).length, 1, "…and it is listed as a session");
  });
});
