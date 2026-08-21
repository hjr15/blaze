// tests/model/identity.test.mjs — blaze-pm BLZ-303, implementing ADR-0013.
//
// THE INVARIANT UNDER TEST: a token is a delegation, never an escalation. It carries a
// subset of its owner's access AT THE MOMENT IT IS USED — never a superset, and never a
// frozen copy.
//
// The failure this prevents is entirely ordinary: someone with write access issues a
// token, later moves to read-only, and the token keeps writing because its scopes were
// copied at issue time rather than derived at use time. Every test that pairs a fixed
// `tokenScopes` with a changed `role` is checking exactly that.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { effectiveScopes, authorise, checkRequestedScopes, tokenUsable, verify,
         generateToken, hashToken, tokenMatches, actorFor,
         TOKEN_PREFIX } from "../../scripts/model/identity.mjs";
import { identityDdl, ROLE_SCOPES, ROLES, SCOPES } from "../../scripts/model/identity-schema.mjs";

const NOW = "2026-08-21T12:00:00.000Z";

describe("a token is a delegation, never an escalation", () => {
  test("THE INVARIANT: the same token narrows when its owner's role narrows", () => {
    const tokenScopes = ["read", "write"];
    assert.deepEqual(effectiveScopes({ role: "member", tokenScopes }), ["read", "write"]);
    // Nothing about the token changed. The owner did.
    assert.deepEqual(effectiveScopes({ role: "viewer", tokenScopes }), ["read"],
      "a demoted owner must immediately narrow every token they ever issued");
  });

  test("a token can never exceed its owner, even if the stored row says otherwise", () => {
    // The row is forged: it claims admin. The intersection makes that unreachable.
    assert.deepEqual(effectiveScopes({ role: "viewer", tokenScopes: ["read", "write", "admin"] }),
      ["read"]);
  });

  test("a token asking for less than its owner has gets only what it asked for", () => {
    assert.deepEqual(effectiveScopes({ role: "admin", tokenScopes: ["read"] }), ["read"],
      "the intersection narrows in both directions");
  });

  test("an unknown role grants nothing", () => {
    assert.deepEqual(effectiveScopes({ role: "wizard", tokenScopes: ["read"] }), []);
  });

  test("scopes come back in a stable order regardless of how they were asked for", () => {
    assert.deepEqual(effectiveScopes({ role: "admin", tokenScopes: ["admin", "read", "write"] }),
      effectiveScopes({ role: "admin", tokenScopes: ["write", "admin", "read"] }));
  });

  test("a comma string is accepted as well as an array — the DB stores a string", () => {
    assert.deepEqual(effectiveScopes({ role: "member", tokenScopes: "read, write" }),
      ["read", "write"]);
  });
});

describe("issuing a token", () => {
  test("a viewer cannot mint a write token, and is told why", () => {
    const r = checkRequestedScopes({ role: "viewer", requested: ["write"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /a viewer cannot issue a token with scope\(s\): write/);
    assert.match(r.error, /delegation of your own access, never an escalation/);
  });

  test("refusal at issue AND intersection at use — both, not either", () => {
    // The intersection makes an over-broad token harmless; the refusal means nobody is
    // handed a token that silently does less than the API said it would.
    assert.equal(checkRequestedScopes({ role: "member", requested: ["admin"] }).ok, false);
    assert.deepEqual(effectiveScopes({ role: "member", tokenScopes: ["admin"] }), []);
  });

  test("an unknown scope is named rather than silently dropped", () => {
    const r = checkRequestedScopes({ role: "admin", requested: ["read", "teleport"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown scope\(s\): teleport/);
    assert.match(r.error, new RegExp(SCOPES.join(", ")));
  });

  test("a token must ask for something", () => {
    assert.match(checkRequestedScopes({ role: "admin", requested: [] }).error,
      /must request at least one scope/);
  });

  test("an admin may issue every scope it holds", () => {
    const r = checkRequestedScopes({ role: "admin", requested: ["read", "write", "admin"] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.scopes, ["read", "write", "admin"]);
  });

  test("every role's scopes are declared in ONE place", () => {
    // Nothing outside identity-schema.mjs may hard-code what a role can do.
    for (const role of ROLES) {
      assert.ok(Array.isArray(ROLE_SCOPES[role]), `${role} has no declared scopes`);
      for (const s of ROLE_SCOPES[role]) assert.ok(SCOPES.includes(s), `${role}: unknown scope ${s}`);
    }
  });
});

describe("tokens are secrets, and are treated like secrets", () => {
  test("a generated token is prefixed, and long enough to be unguessable", () => {
    const t = generateToken();
    assert.ok(t.startsWith(TOKEN_PREFIX));
    assert.ok(t.length - TOKEN_PREFIX.length >= 40, `too short: ${t.length}`);
    assert.notEqual(generateToken(), generateToken());
  });

  test("the hash is not the token — a database dump yields no credential", () => {
    const t = generateToken();
    const h = hashToken(t);
    assert.notEqual(h, t);
    assert.doesNotMatch(h, new RegExp(TOKEN_PREFIX));
    assert.equal(h.length, 64, "sha-256 hex");
  });

  test("comparison accepts the right token and rejects a wrong one", () => {
    const t = generateToken();
    assert.equal(tokenMatches(t, hashToken(t)), true);
    assert.equal(tokenMatches(generateToken(), hashToken(t)), false);
  });

  test("a malformed stored hash is rejected rather than throwing", () => {
    // timingSafeEqual throws on a length mismatch; a corrupt row must not take the
    // request down, it must fail the comparison.
    for (const bad of ["", "zz", null, undefined, "not-hex"]) {
      assert.equal(tokenMatches(generateToken(), bad), false, JSON.stringify(bad));
    }
  });
});

describe("authorise fails CLOSED", () => {
  test("an unknown operation is denied, not allowed", () => {
    // A new endpoint nobody remembered to classify must fail closed. A default-allow
    // would mean every future route ships unauthorised until someone notices.
    const r = authorise({ scopes: ["read", "write", "admin"], operation: "frobnicate" });
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown operation "frobnicate" — denied/);
  });

  test("each operation needs its own scope", () => {
    assert.equal(authorise({ scopes: ["read"], operation: "read" }).ok, true);
    assert.equal(authorise({ scopes: ["read"], operation: "write" }).ok, false);
    assert.equal(authorise({ scopes: ["read", "write"], operation: "admin" }).ok, false);
  });
});

describe("tokenUsable", () => {
  test("revoked, expired and absent are each their own message", () => {
    assert.match(tokenUsable(null).error, /no such token/);
    assert.match(tokenUsable({ revoked_at: NOW }).error, /has been revoked/);
    assert.match(tokenUsable({ expires_at: "2020-01-01T00:00:00.000Z" }, { now: NOW }).error,
      /has expired/);
  });

  test("an expiry in the future is fine, and no expiry means no expiry", () => {
    assert.equal(tokenUsable({ expires_at: "2099-01-01T00:00:00.000Z" }, { now: NOW }).ok, true);
    assert.equal(tokenUsable({}, { now: NOW }).ok, true);
  });
});

describe("verify — the whole decision", () => {
  const user = { id: "u1", email: "a@example.com", status: "active" };
  const token = { id: "t1", name: "laptop", scopes: "read,write" };
  const ok = { token, user, membership: { role: "member" } };
  const lookup = (found) => () => found;

  test("a good token yields a principal naming the user and the token", () => {
    const r = verify({ presented: generateToken(), lookup: lookup(ok), operation: "write", now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.principal.userId, "u1");
    assert.equal(r.principal.tokenName, "laptop");
    assert.deepEqual(r.principal.scopes, ["read", "write"]);
  });

  test("no credentials is 401, and says so plainly", () => {
    const r = verify({ presented: "", lookup: lookup(ok), operation: "read" });
    assert.equal(r.status, 401);
    assert.match(r.error, /no credentials supplied/);
  });

  test("something that is not a Blaze token names the shape expected", () => {
    // An operator pasting a password or a CSRF token here should be told what was
    // expected, not just refused.
    const r = verify({ presented: "hunter2", lookup: lookup(ok), operation: "read" });
    assert.equal(r.status, 401);
    assert.match(r.error, /expected one beginning blz_/);
  });

  test("a suspended account is 403, not 401 — the credential was fine", () => {
    const r = verify({ presented: generateToken(), operation: "read", now: NOW,
                       lookup: lookup({ ...ok, user: { ...user, status: "suspended" } }) });
    assert.equal(r.status, 403);
    assert.match(r.error, /not active/);
  });

  test("a user with no membership is refused", () => {
    const r = verify({ presented: generateToken(), operation: "read", now: NOW,
                       lookup: lookup({ token, user, membership: null }) });
    assert.equal(r.status, 403);
    assert.match(r.error, /has no access/);
  });

  test("THE INVARIANT, end to end: demotion revokes the token's write silently and at once", () => {
    const t = generateToken();
    const asMember = verify({ presented: t, lookup: lookup(ok), operation: "write", now: NOW });
    assert.equal(asMember.ok, true, "a member may write");

    // The token row is untouched. Only the membership changed.
    const demoted = { ...ok, membership: { role: "viewer" } };
    const asViewer = verify({ presented: t, lookup: lookup(demoted), operation: "write", now: NOW });
    assert.equal(asViewer.ok, false);
    assert.equal(asViewer.status, 403);
    assert.equal(verify({ presented: t, lookup: lookup(demoted), operation: "read", now: NOW }).ok,
      true, "...but reading still works, because the token still asked for read");
  });

  test("a token whose scopes no longer overlap its owner's access says exactly that", () => {
    const writeOnly = { ...ok, token: { ...token, scopes: "write" },
                        membership: { role: "viewer" } };
    const r = verify({ presented: generateToken(), lookup: lookup(writeOnly),
                       operation: "read", now: NOW });
    assert.equal(r.status, 403);
    assert.match(r.error, /no longer overlap its owner's access/);
  });

  test("the lookup is BY HASH — the database never sees the plaintext", () => {
    const t = generateToken();
    let sawArgument = null;
    verify({ presented: t, operation: "read", now: NOW,
             lookup: (h) => { sawArgument = h; return ok; } });
    assert.equal(sawArgument, hashToken(t));
    assert.notEqual(sawArgument, t);
  });
});

describe("the event log finally records WHO", () => {
  test("actorFor names the human and the credential", () => {
    // ticket_event.actor has existed since the schema landed and has never been set.
    assert.equal(actorFor({ email: "a@example.com", tokenName: "laptop" }),
      "a@example.com (laptop)");
  });

  test("no principal is still 'unknown', matching the column's default", () => {
    assert.equal(actorFor(null), "unknown");
  });
});

describe("the schema", () => {
  test("both dialects build, and an unknown one is refused", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON;");
    db.exec(identityDdl("sqlite"));
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(tables, ["api_token", "app_user", "membership", "user_identity"]);
    assert.throws(() => identityDdl("mysql"), /unknown dialect "mysql"/);
  });

  test("ONE user may hold MANY identities — the provider hook", () => {
    // Putting the provider on `app_user` would force a rewrite the first time a firm
    // arrives with an identity provider. This is the test that keeps that from happening.
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON;");
    db.exec(identityDdl("sqlite"));
    db.prepare("INSERT INTO app_user (id,email,display_name,created_at) VALUES (?,?,?,?)")
      .run("u1", "a@example.com", "A", NOW);
    for (const [provider, subject] of [["local", "a@example.com"], ["google", "1234"],
                                       ["okta", "abcd"]]) {
      db.prepare("INSERT INTO user_identity (provider,subject,user_id,created_at) VALUES (?,?,?,?)")
        .run(provider, subject, "u1", NOW);
    }
    assert.equal(db.prepare("SELECT count(*) n FROM user_identity WHERE user_id='u1'").get().n, 3);
  });

  test("a role outside the three is refused by the database, not just by code", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON;");
    db.exec(identityDdl("sqlite"));
    db.prepare("INSERT INTO app_user (id,email,display_name,created_at) VALUES (?,?,?,?)")
      .run("u1", "a@example.com", "A", NOW);
    assert.throws(() => db.prepare(
      "INSERT INTO membership (user_id,scope_key,role,created_at) VALUES ('u1','*','wizard',?)")
      .run(NOW), /CHECK constraint failed/);
  });

  test("the same token hash cannot be stored twice", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON;");
    db.exec(identityDdl("sqlite"));
    db.prepare("INSERT INTO app_user (id,email,display_name,created_at) VALUES (?,?,?,?)")
      .run("u1", "a@example.com", "A", NOW);
    const ins = db.prepare(
      "INSERT INTO api_token (id,user_id,name,token_hash,scopes,created_at) VALUES (?,?,?,?,?,?)");
    ins.run("t1", "u1", "one", "deadbeef", "read", NOW);
    assert.throws(() => ins.run("t2", "u1", "two", "deadbeef", "read", NOW), /UNIQUE/);
  });
});
