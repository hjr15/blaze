// tests/serve-identity.test.mjs — BLZ-348: identity, finally wired in.
//
// ADR-0013 was implemented in full (identity.mjs, identity-schema.mjs,
// identity-store.mjs, serve-auth.mjs) and imported by NOTHING. `serve.mjs` called
// neither `checkBindSafety` nor `gate()`, so the bind-address boundary and the
// fail-closed route classification were both dead code, and BLZ-323 spent its effort
// adding routes to a table no request ever consulted.
//
// These tests are the reachability proof. Each one fails on a `serve.mjs` that does
// not import the gate.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { startServer, CSRF } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { openIdentityDb, identityDbPath, loadIdentity } from "../scripts/model/identity-db.mjs";

function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-identity-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  mkdirSync(join(projects, "OBA", "in-progress"), { recursive: true });
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    ["---", "id: OBA-1", "title: t", "type: task", "project: OBA", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01",
     "---", "", "## Acceptance Criteria", "", "- [ ] one", ""].join("\n"));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return { root, projects };
}

async function boot(opts) {
  const server = startServer({ port: 0, ...opts });
  await new Promise((res) => server.once("listening", res));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-blaze-csrf": CSRF, ...headers },
    body: JSON.stringify(body),
  });

describe("the bind-address boundary is enforced at startup, not merely written down", () => {
  // BLZ-358 REPLACED THE REFUSAL, and these two tests move with it. What must NOT
  // change is the property the refusal bought: a userless board on a non-loopback
  // interface still serves nobody its contents. It now serves a setup flow instead of
  // exiting, and nothing else at all — which is a strictly better answer to the same
  // question, and a strictly worse one if the "nothing else" half ever lapses.
  test("a non-loopback bind with no identities serves SETUP, and nothing else", async () => {
    const { root, projects } = board();
    const server = startServer({ port: 0, root, projectsDir: projects, host: "0.0.0.0" });
    await new Promise((res) => server.once("listening", res));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await fetch(`${base}/setup`)).status, 200);
      for (const path of ["/", "/api/live", "/api/hash"]) {
        const r = await fetch(`${base}${path}`);
        assert.equal(r.status, 503, `${path} must not be served before setup completes`);
        assert.doesNotMatch(await r.text(), /OBA-1/, `${path} leaked board content`);
      }
    } finally { server.close(); }
  });

  test("`blaze user add` still exists — setup is a second door, not a replacement", () => {
    // ADR-0013 section 5: the first admin is a user, not an exception. The HTTP flow
    // calls the same `addUser`, so the CLI path must still be there for an operator
    // with shell access.
    const cli = readFileSync(new URL("../scripts/cli.mjs", import.meta.url), "utf8");
    assert.match(cli, /^\s*user: \{/m, "cli.mjs must dispatch a `user` subcommand");
    const admin = readFileSync(new URL("../scripts/model/user-admin.mjs", import.meta.url), "utf8");
    assert.match(admin, /export async function addUser/, "and both doors must go through it");
  });

  test("BACKWARDS COMPATIBILITY: loopback with no identities serves exactly as it always has",
    async () => {
      const { root, projects } = board();
      const { server, base } = await boot({ root, projectsDir: projects });
      try {
        assert.equal(server.address().address, "127.0.0.1");

        // Reads are open.
        const live = await fetch(`${base}/api/live`);
        assert.equal(live.status, 200);

        // Writes are open, with only the CSRF header, exactly as before.
        const r = await post(base, "/api/edit", { id: "OBA-1", patch: { priority: "high" } });
        const body = await r.json();
        assert.equal(r.status, 200, JSON.stringify(body));
        assert.equal(body.ok, true);
      } finally { server.close(); }
    });

  test("a non-loopback bind is allowed once an identity exists", async () => {
    const { root, projects } = board();
    await addUser(root, { email: "ops@example.com", role: "admin" });
    const { server } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try { assert.equal(server.address().address, "0.0.0.0"); }
    finally { server.close(); }
  });
});

describe("an identity FILE is not an identity — only a user is", () => {
  // Caught by mutation testing: flipping `if (n === 0)` to a condition that never fires
  // left every test green, because nothing ever produced a database with the identity
  // schema and no users in it. That mutant is not equivalent — it is the difference
  // between "this board has nobody, stay on loopback" and "this board is protected",
  // and getting it wrong BOTH locks a loopback operator out of their own board and lets
  // a userless board bind 0.0.0.0. An empty table is the state a future `user remove`
  // reaches, so it needs a test of its own rather than an argument.
  const emptyIdentityDb = (root) => { openIdentityDb(root, { create: true }).db.close(); };

  test("a database with the schema and no users still counts as no identities", async () => {
    const { root, projects } = board();
    emptyIdentityDb(root);
    assert.equal(existsSync(identityDbPath(root)), true, "the file must really exist");
    assert.equal(loadIdentity(root).hasIdentity, false);

    // Loopback keeps serving unauthenticated: an empty table must not lock the operator
    // out of a board nobody can log in to.
    const { server, base } = await boot({ root, projectsDir: projects });
    try { assert.equal((await fetch(`${base}/api/live`)).status, 200); }
    finally { server.close(); }
  });

  test("...and a non-loopback bind serves setup with one, not the board", async () => {
    // An empty table is `hasIdentity: false` exactly as an absent file is, so it reaches
    // the setup flow on the same terms — it must not fall through to serving the board.
    const { root, projects } = board();
    emptyIdentityDb(root);
    const server = startServer({ port: 0, root, projectsDir: projects, host: "0.0.0.0" });
    await new Promise((res) => server.once("listening", res));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await fetch(`${base}/setup`)).status, 200);
      assert.equal((await fetch(`${base}/`)).status, 503);
    } finally { server.close(); }
  });

});

describe("a BROKEN identity database fails closed — it is not 'no identities'", () => {
  // THE REGRESSION THIS REPLACES. loadIdentity treated every startup breakage as
  // "no identities configured", so truncating a PROTECTED board's identity.db silently
  // removed its authentication:
  //
  //     [baseline healthy]                 no-token=401  valid-token=200
  //     [garbage over the file]            no-token=200  <-- AUTHENTICATION REMOVED
  //     [valid sqlite, no schema]          no-token=200  <-- AUTHENTICATION REMOVED
  //     [a DIRECTORY in its place]         no-token=200  <-- AUTHENTICATION REMOVED
  //     [truncated to 0 bytes]             no-token=200  <-- AUTHENTICATION REMOVED
  //
  // The earlier tests here asserted that as INTENDED, justified as tolerating "a stray
  // file in .blaze/". That justification only ever held for a board that never had
  // users — which is the only kind of board those tests built. "Stray file on an
  // unprotected board" and "the roster of a protected board just got truncated" are
  // indistinguishable on disk, so they cannot share an outcome. ABSENT is the
  // back-compat case; BROKEN is a refusal.
  //
  // On 0.0.0.0 the same corruption used to kill the container with a FALSE diagnosis
  // ("no users configured"), which is why the broken check runs before checkBindSafety.
  const damage = {
    "garbage over the file": (p) => writeFileSync(p, "this is not a sqlite database"),
    "a valid sqlite file with no identity schema": (p) => {
      rmSync(p);
      const d = new (createRequire(import.meta.url)("node:sqlite").DatabaseSync)(p);
      d.exec("CREATE TABLE unrelated (x)"); d.close();
    },
    "a DIRECTORY where the database goes": (p) => { rmSync(p); mkdirSync(p); },
    "truncated to 0 bytes": (p) => truncateSync(p, 0),
  };

  for (const [label, breakIt] of Object.entries(damage)) {
    test(`a protected board with ${label} refuses to serve`, async () => {
      const { root, projects } = board();
      const { token } = await addUser(root, { email: "a@b.c", role: "admin" });
      breakIt(identityDbPath(root));

      const loaded = loadIdentity(root);
      assert.equal(loaded.state, "broken", "a damaged roster is broken, never absent");
      assert.equal(loaded.hasIdentity, false);

      // The board must not come up at all — on loopback as much as anywhere else. An
      // open board is not an acceptable degraded mode for a board that had users.
      let server = null;
      try {
        server = startServer({ port: 0, root, projectsDir: projects });
        await new Promise((r) => server.once("listening", r));
        const anon = await fetch(`http://127.0.0.1:${server.address().port}/api/live`);
        assert.fail(`the board served a request with a broken roster (no-token=${anon.status})`);
      } catch (e) {
        if (server) { server.close(); throw e; }
        assert.match(e.message, /identity database/i);
        assert.doesNotMatch(e.message, /no users configured/,
          "a corrupt roster must not be diagnosed as an empty one");
        assert.match(e.message, new RegExp(identityDbPath(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          "the message must name the file the operator has to deal with");
      }
      // The token is still a real token; nothing about it caused this.
      assert.ok(token.token.startsWith("blz_"));
    });
  }

  test("on a non-loopback bind the diagnosis is the real one, not 'no users configured'", async () => {
    const { root, projects } = board();
    await addUser(root, { email: "a@b.c", role: "admin" });
    truncateSync(identityDbPath(root), 0);
    assert.throws(
      () => startServer({ port: 0, root, projectsDir: projects, host: "0.0.0.0" }),
      (e) => /identity database/i.test(e.message) && !/no users configured/.test(e.message));
  });

  test("ABSENT is still absent: no file at all is the untouched loopback path", async () => {
    const { root, projects } = board();
    const loaded = loadIdentity(root);
    assert.equal(loaded.state, "absent");
    assert.equal(loaded.hasIdentity, false);
    const { server, base } = await boot({ root, projectsDir: projects });
    try { assert.equal((await fetch(`${base}/api/live`)).status, 200); }
    finally { server.close(); }
  });

});
describe("board CONTENT is gated too — a viewer role that protects nothing is not a role", () => {
  // Found in security review of PR #96. `/` is rendered SERVER-SIDE and embeds every
  // ticket plus the CSRF token, so with identities configured an unauthenticated caller
  // could read the whole board while /api/live correctly 401'd beside it. The board was
  // already unusable in a browser at that point — the page rendered and then every XHR
  // 401'd — so gating `/` does not take away a working flow; it makes a broken one honest.
  test("GET / requires read once identities exist", async () => {
    const { root, projects } = board();
    const { token } = await addUser(root, { email: "r@example.com", role: "viewer" });
    const { server, base } = await boot({ root, projectsDir: projects });
    try {
      const anon = await fetch(`${base}/`);
      assert.equal(anon.status, 401);
      const body = await anon.text();
      assert.doesNotMatch(body, /OBA-1/, "an unauthenticated caller must not receive ticket content");
      assert.match(body, /Authorization: Bearer/, "the refusal must say how to authenticate");

      const authed = await fetch(`${base}/`, { headers: { authorization: `Bearer ${token.token}` } });
      assert.equal(authed.status, 200);
      assert.match(await authed.text(), /OBA-1/);
    } finally { server.close(); }
  });

  test("GET /view/<name> requires read once identities exist", async () => {
    const { root, projects } = board();
    const { token } = await addUser(root, { email: "v@example.com", role: "viewer" });
    const { server, base } = await boot({ root, projectsDir: projects });
    try {
      assert.equal((await fetch(`${base}/view/board`)).status, 401);
      assert.equal((await fetch(`${base}/view/board`,
        { headers: { authorization: `Bearer ${token.token}` } })).status, 200);
    } finally { server.close(); }
  });

  test("the CSRF token is no longer harvestable without a credential", async () => {
    // ADR-0013's reproduction step 1 was "anonymous GET / -> token harvested".
    const { root, projects } = board();
    await addUser(root, { email: "c@example.com", role: "admin" });
    const { server, base } = await boot({ root, projectsDir: projects });
    try {
      const body = await (await fetch(`${base}/`)).text();
      assert.doesNotMatch(body, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
        "no CSRF uuid may appear in an unauthenticated response");
    } finally { server.close(); }
  });

  test("an unknown page path is still a plain 404, not an auth decision", async () => {
    // The page router is not a fixed table. Turning every unknown path into a 401 would
    // change what the board has always returned for a typo, and leak whether a path exists.
    const { root, projects } = board();
    await addUser(root, { email: "n@example.com", role: "admin" });
    const { server, base } = await boot({ root, projectsDir: projects });
    try { assert.equal((await fetch(`${base}/nope`)).status, 404); }
    finally { server.close(); }
  });
});

describe("with identities configured, a token is required and its scope is enforced", () => {
  test("no credential is 401, a bad one is 401, and the admin's token is 200", async () => {
    const { root, projects } = board();
    const { token } = await addUser(root, { email: "admin@example.com", role: "admin" });
    const { server, base } = await boot({ root, projectsDir: projects });
    try {
      assert.equal((await fetch(`${base}/api/live`)).status, 401);
      assert.equal((await fetch(`${base}/api/live`,
        { headers: { authorization: "Bearer blz_nope" } })).status, 401);
      assert.equal((await fetch(`${base}/api/live`,
        { headers: { authorization: `Bearer ${token.token}` } })).status, 200);
    } finally { server.close(); }
  });

  test("a viewer may read and may NOT write", async () => {
    const { root, projects } = board();
    const { token } = await addUser(root, { email: "viewer@example.com", role: "viewer" });
    const auth = { authorization: `Bearer ${token.token}` };
    const { server, base } = await boot({ root, projectsDir: projects });
    try {
      assert.equal((await fetch(`${base}/api/live`, { headers: auth })).status, 200);
      const w = await post(base, "/api/edit", { id: "OBA-1", patch: { priority: "high" } }, auth);
      assert.equal(w.status, 403);
      assert.match((await w.json()).errors[0], /does not carry the 'write' scope/);
    } finally { server.close(); }
  });

  test("the CSRF header is retained as defence-in-depth: a valid token without it is still refused",
    async () => {
      const { root, projects } = board();
      const { token } = await addUser(root, { email: "m@example.com", role: "member" });
      const { server, base } = await boot({ root, projectsDir: projects });
      try {
        const r = await fetch(`${base}/api/edit`, {
          method: "POST",
          headers: { "content-type": "application/json",
                     authorization: `Bearer ${token.token}` },
          body: JSON.stringify({ id: "OBA-1", patch: { priority: "high" } }),
        });
        assert.equal(r.status, 403);
        assert.match((await r.json()).errors[0], /csrf/i);
      } finally { server.close(); }
    });
});
