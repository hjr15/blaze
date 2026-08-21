// tests/model/serve-auth.test.mjs — the HTTP gate (blaze-pm BLZ-304), per ADR-0013.
//
// The decision worth arguing with, and therefore worth testing hardest:
//
//   with NO identity configured, loopback serves without auth (as Blaze always has),
//   and any other bind address REFUSES TO START.
//
// Today's actual security boundary IS the bind address (`HOST || 127.0.0.1`), and
// existing single-operator boards depend on it. Demanding a token from them would break
// every one for no security gain. But the container sets HOST=0.0.0.0, which is exactly
// where the loopback assumption silently stops holding — so that case fails loudly at
// startup instead.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { isLoopback, checkBindSafety, scopeFor, bearerFrom, gate,
         ROUTE_SCOPES } from "../../scripts/model/serve-auth.mjs";
import { identityDdl } from "../../scripts/model/identity-schema.mjs";
import { identityStore } from "../../scripts/model/identity-store.mjs";

function store() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(identityDdl("sqlite"));
  const exec = {
    run(s, p = []) { return p.length ? db.prepare(s).run(...p) : db.exec(s); },
    all(s, p = []) { return db.prepare(s).all(...p); },
  };
  return identityStore(exec);
}

describe("isLoopback", () => {
  test("recognises loopback in both families, and the v6-mapped form", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "::ffff:127.0.0.1"]) {
      assert.equal(isLoopback(h), true, h);
    }
  });

  test("everything reachable by something else is not loopback", () => {
    for (const h of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.1", "example.com", "", null]) {
      assert.equal(isLoopback(h), false, JSON.stringify(h));
    }
  });
});

describe("a server may not start unauthenticated on a reachable address", () => {
  test("loopback with no identity is allowed — this is what Blaze has always done", () => {
    // Breaking every existing single-operator board would buy no security: nothing
    // outside the machine can reach them.
    assert.equal(checkBindSafety({ host: "127.0.0.1", hasIdentity: false }).ok, true);
  });

  test("0.0.0.0 with no identity REFUSES, and names both ways out", () => {
    // The container sets HOST=0.0.0.0. This is the case that turns a silent exposure
    // into a startup error.
    const r = checkBindSafety({ host: "0.0.0.0", hasIdentity: false });
    assert.equal(r.ok, false);
    assert.match(r.error, /refusing to serve on 0\.0\.0\.0 with no users configured/);
    assert.match(r.error, /HOST=127\.0\.0\.1 blaze board/);
    assert.match(r.error, /blaze user add/);
  });

  test("any identity at all unlocks any address", () => {
    assert.equal(checkBindSafety({ host: "0.0.0.0", hasIdentity: true }).ok, true);
    assert.equal(checkBindSafety({ host: "192.168.1.10", hasIdentity: true }).ok, true);
  });
});

describe("routes are classified, and an unclassified one is denied", () => {
  test("every known route has a scope, and only read/write/admin are used", () => {
    for (const [route, scope] of Object.entries(ROUTE_SCOPES)) {
      assert.ok(["read", "write", "admin"].includes(scope), `${route} -> ${scope}`);
    }
  });

  test("every mutating route costs write, and no GET does", () => {
    for (const [route, scope] of Object.entries(ROUTE_SCOPES)) {
      if (route.startsWith("POST ")) assert.equal(scope, "write", route);
      if (route.startsWith("GET ")) assert.equal(scope, "read", route);
    }
  });

  test("an unknown route is denied rather than inheriting anything", async () => {
    // A route added without a classification must not pass through. Fail closed.
    assert.equal(scopeFor("POST", "/api/newthing"), null);
    const r = await gate({ method: "POST", pathname: "/api/newthing", headers: {}, store: null });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
  });

  test("method matters — a GET on a write route is not the same route", () => {
    assert.equal(scopeFor("POST", "/api/edit"), "write");
    assert.equal(scopeFor("GET", "/api/edit"), null);
  });
});

describe("bearerFrom", () => {
  test("extracts the token, case-insensitively on the scheme", () => {
    assert.equal(bearerFrom({ authorization: "Bearer blz_abc" }), "blz_abc");
    assert.equal(bearerFrom({ authorization: "bearer blz_abc" }), "blz_abc");
  });

  test("a malformed header is ABSENT, never guessed at", () => {
    // Treating a bare value as a token would let a Basic header, or a pasted password,
    // be tried as a credential.
    for (const h of ["blz_abc", "Basic dXNlcjpwYXNz", "", undefined]) {
      assert.equal(bearerFrom({ authorization: h }), "", JSON.stringify(h));
    }
  });
});

describe("gate — with identity configured", () => {
  test("no credential is refused on a write", async () => {
    const s = store();
    await s.createUser({ email: "a@example.com", role: "member" });
    const r = await gate({ method: "POST", pathname: "/api/edit", headers: {}, store: s });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });

  test("a valid write token passes, and yields a principal to record", async () => {
    const s = store();
    const u = await s.createUser({ email: "a@example.com", role: "member" });
    const t = await s.issueToken({ userId: u.id, name: "laptop", scopes: ["read", "write"] });
    const r = await gate({ method: "POST", pathname: "/api/edit", store: s,
                           headers: { authorization: `Bearer ${t.token}` } });
    assert.equal(r.ok, true);
    assert.equal(r.principal.email, "a@example.com");
    assert.equal(r.principal.tokenName, "laptop");
  });

  test("a read-only token may read and may NOT write", async () => {
    const s = store();
    const u = await s.createUser({ email: "v@example.com", role: "viewer" });
    const t = await s.issueToken({ userId: u.id, name: "agent", scopes: ["read"] });
    const h = { authorization: `Bearer ${t.token}` };
    assert.equal((await gate({ method: "GET", pathname: "/api/live", headers: h, store: s })).ok, true);
    const w = await gate({ method: "POST", pathname: "/api/edit", headers: h, store: s });
    assert.equal(w.ok, false);
    assert.equal(w.status, 403);
  });

  test("THE INVARIANT over HTTP: demoting the owner disarms the token mid-flight", async () => {
    const s = store();
    const u = await s.createUser({ email: "a@example.com", role: "member" });
    const t = await s.issueToken({ userId: u.id, name: "laptop", scopes: ["read", "write"] });
    const h = { authorization: `Bearer ${t.token}` };
    assert.equal((await gate({ method: "POST", pathname: "/api/edit", headers: h, store: s })).ok,
      true, "a member may write");

    await s.setRole({ userId: u.id, role: "viewer" });   // the token row is untouched

    assert.equal((await gate({ method: "POST", pathname: "/api/edit", headers: h, store: s })).ok,
      false, "the same token must stop writing the instant its owner is demoted");
    assert.equal((await gate({ method: "GET", pathname: "/api/live", headers: h, store: s })).ok,
      true, "...but it still reads");
  });

  test("a revoked token stops working", async () => {
    const s = store();
    const u = await s.createUser({ email: "a@example.com", role: "member" });
    const t = await s.issueToken({ userId: u.id, name: "laptop", scopes: ["read", "write"] });
    await s.revokeToken(t.id);
    const r = await gate({ method: "POST", pathname: "/api/edit", store: s,
                           headers: { authorization: `Bearer ${t.token}` } });
    assert.equal(r.ok, false);
    assert.match(r.error, /revoked/);
  });

  test("a token from a different board does not work here", async () => {
    const a = store(), b = store();
    const u = await a.createUser({ email: "a@example.com", role: "admin" });
    const t = await a.issueToken({ userId: u.id, name: "x", scopes: ["read", "write"] });
    const r = await gate({ method: "POST", pathname: "/api/edit", store: b,
                           headers: { authorization: `Bearer ${t.token}` } });
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown token/);
  });
});

describe("gate — with no identity configured", () => {
  test("a known route is allowed with no principal, as before", async () => {
    // Startup has already vouched that this can only be a loopback bind.
    const r = await gate({ method: "POST", pathname: "/api/edit", headers: {}, store: null });
    assert.equal(r.ok, true);
    assert.equal(r.principal, null);
  });
});
