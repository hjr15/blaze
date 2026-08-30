// tests/model/serve-auth-session.test.mjs — BLZ-566. The gate learns a second credential.
//
// `bearerFrom` read the Authorization header and nothing else, which is the whole defect:
// a browser cannot set that header, so a board with users was reachable from curl and
// from nothing a human uses. The gate now also reads a session cookie — and the tests
// that matter here are the ones pinning what did NOT change: the bearer path, and the
// 404 an unclassified /api/* route still gets.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { bearerFrom, sessionFrom, cookieFrom, gate, SESSION_COOKIE }
  from "../../scripts/model/serve-auth.mjs";
import { SESSION_PREFIX } from "../../scripts/model/identity.mjs";

const SESSION = `${SESSION_PREFIX}aaaabbbbccccdddd`;
const BEARER = "blz_aaaabbbbccccdddd";

/** A store that records which door a credential came through. */
function spyStore() {
  const seen = [];
  return {
    seen,
    async authenticate({ presented, operation }) {
      seen.push(["bearer", presented, operation]);
      return presented === BEARER
        ? { ok: true, status: 200, error: null, principal: { via: "bearer" } }
        : { ok: false, status: 401, error: "unknown token", principal: null };
    },
    async authenticateSession({ presented, operation }) {
      seen.push(["session", presented, operation]);
      return presented === SESSION
        ? { ok: true, status: 200, error: null, principal: { via: "session" } }
        : { ok: false, status: 401, error: "unknown session", principal: null };
    },
  };
}

describe("cookieFrom reads exactly the cookie it was asked for", () => {
  test("it finds the value among others", () => {
    assert.equal(cookieFrom({ cookie: `a=1; ${SESSION_COOKIE}=${SESSION}; z=9` }, SESSION_COOKIE),
      SESSION);
  });
  test("a cookie whose name merely ENDS with the one asked for is not it", () => {
    assert.equal(cookieFrom({ cookie: `xx${SESSION_COOKIE}=${SESSION}` }, SESSION_COOKIE), "");
  });
  test("no Cookie header, an empty one, and a malformed one are all absent", () => {
    for (const headers of [{}, { cookie: "" }, { cookie: "=" }, { cookie: ";;;" },
                           { cookie: `${SESSION_COOKIE}` }]) {
      assert.equal(cookieFrom(headers, SESSION_COOKIE), "");
    }
  });
  test("a value carrying its own '=' survives intact", () => {
    assert.equal(cookieFrom({ cookie: "k=a=b=c" }, "k"), "a=b=c");
  });
});

describe("the two credential spaces stay disjoint at the transport, not only at the store", () => {
  test("a session value in the Authorization header is NOT a bearer token", () => {
    assert.equal(bearerFrom({ authorization: `Bearer ${SESSION}` }), "");
  });
  test("an API token still is one — unchanged", () => {
    assert.equal(bearerFrom({ authorization: `Bearer ${BEARER}` }), BEARER);
  });
  test("an API token in the session cookie is NOT a session", () => {
    assert.equal(sessionFrom({ cookie: `${SESSION_COOKIE}=${BEARER}` }), "");
  });
  test("a session value in the session cookie is one", () => {
    assert.equal(sessionFrom({ cookie: `${SESSION_COOKIE}=${SESSION}` }), SESSION);
  });
});

describe("gate() prefers the explicit credential and falls back to the ambient one", () => {
  test("a session cookie authenticates a page route", async () => {
    const store = spyStore();
    const r = await gate({ method: "GET", pathname: "/", operation: "read",
                           headers: { cookie: `${SESSION_COOKIE}=${SESSION}` }, store });
    assert.equal(r.ok, true);
    assert.deepEqual(r.principal, { via: "session" });
  });

  test("a bearer token still authenticates exactly as it did", async () => {
    const store = spyStore();
    const r = await gate({ method: "GET", pathname: "/api/sync",
                           headers: { authorization: `Bearer ${BEARER}` }, store });
    assert.equal(r.ok, true);
    assert.deepEqual(store.seen, [["bearer", BEARER, "read"]],
      "the session table must not be consulted for a bearer request");
  });

  test("when BOTH are presented the bearer wins — explicit beats ambient", async () => {
    const store = spyStore();
    const r = await gate({ method: "GET", pathname: "/api/sync", store,
      headers: { authorization: `Bearer ${BEARER}`, cookie: `${SESSION_COOKIE}=${SESSION}` } });
    assert.equal(r.principal.via, "bearer");
  });

  test("a BAD bearer is not rescued by a good cookie beside it", async () => {
    const store = spyStore();
    const r = await gate({ method: "GET", pathname: "/api/sync", store,
      headers: { authorization: "Bearer blz_wrong", cookie: `${SESSION_COOKIE}=${SESSION}` } });
    assert.equal(r.ok, false,
      "a presented credential is the credential being judged — falling through to the "
      + "cookie would let a revoked token be silently upgraded by a stale session");
  });

  test("no credential at all is still 'no credentials supplied'", async () => {
    const store = spyStore();
    const r = await gate({ method: "GET", pathname: "/api/sync", headers: {}, store });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });
});

describe("FAIL CLOSED: a session is not a skeleton key", () => {
  test("an unclassified /api/* route is STILL 404 with a valid session", async () => {
    const store = spyStore();
    const r = await gate({ method: "GET", pathname: "/api/not-a-route", store,
                           headers: { cookie: `${SESSION_COOKIE}=${SESSION}` } });
    assert.equal(r.status, 404);
    assert.deepEqual(store.seen, [], "an unknown route is refused before any credential is read");
  });

  test("x-blaze-csrf is not a credential and never becomes one", async () => {
    const store = spyStore();
    const r = await gate({ method: "GET", pathname: "/api/sync", store,
                           headers: { "x-blaze-csrf": "any value at all" } });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });

  test("no identity configured is still the loopback case, unchanged", async () => {
    const r = await gate({ method: "GET", pathname: "/api/sync", headers: {}, store: null });
    assert.equal(r.ok, true);
    assert.equal(r.principal, null);
  });
});
