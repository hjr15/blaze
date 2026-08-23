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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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
  test("a non-loopback bind with no identities configured REFUSES to start", () => {
    const { root, projects } = board();
    assert.throws(
      () => startServer({ port: 0, root, projectsDir: projects, host: "0.0.0.0" }),
      /refusing to serve on 0\.0\.0\.0 with no users configured/);
  });

  test("the refusal names `blaze user add`, and that command exists", () => {
    const { root, projects } = board();
    let message = "";
    try { startServer({ port: 0, root, projectsDir: projects, host: "0.0.0.0" }); }
    catch (e) { message = e.message; }
    assert.match(message, /blaze user add --email \S+ --role admin/);
    // The command the message names must be a real subcommand, or the error is a lie.
    const cli = readFileSync(new URL("../scripts/cli.mjs", import.meta.url), "utf8");
    assert.match(cli, /^\s*user: \{/m, "cli.mjs must dispatch a `user` subcommand");
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

  test("...and a non-loopback bind is still refused with one", () => {
    const { root, projects } = board();
    emptyIdentityDb(root);
    assert.throws(() => startServer({ port: 0, root, projectsDir: projects, host: "0.0.0.0" }),
      /refusing to serve on 0\.0\.0\.0 with no users configured/);
  });

  // Two different failure shapes, and they take two different guards. A file that opens
  // but carries no identity schema throws on the QUERY; something that cannot be opened
  // at all throws on the OPEN. Both must read as "no identities" rather than take a
  // loopback board down — refusing to serve because of a stray file in .blaze/ would be
  // a worse failure than the one this ticket fixes.
  test("a stray non-database file at that path is treated as absent, not as fatal", async () => {
    const { root, projects } = board();
    mkdirSync(join(root, ".blaze"), { recursive: true });
    writeFileSync(identityDbPath(root), "this is not a sqlite database");
    assert.equal(loadIdentity(root).hasIdentity, false);
    const { server, base } = await boot({ root, projectsDir: projects });
    try { assert.equal((await fetch(`${base}/api/live`)).status, 200); }
    finally { server.close(); }
  });

  test("something that cannot be opened at all is also absent, not fatal", async () => {
    const { root, projects } = board();
    mkdirSync(identityDbPath(root), { recursive: true });   // a DIRECTORY where the db goes
    assert.equal(loadIdentity(root).hasIdentity, false);
    const { server, base } = await boot({ root, projectsDir: projects });
    try { assert.equal((await fetch(`${base}/api/live`)).status, 200); }
    finally { server.close(); }
  });
});

describe("every /api/* request goes through gate(), and an unknown route fails closed", () => {
  test("an unclassified /api route 404s rather than falling through to a handler", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects });
    try {
      const r = await fetch(`${base}/api/definitely-not-a-route`);
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { errors: ["unknown endpoint"] });

      // And the POST side, which previously reached the CSRF check and the write body.
      const p = await post(base, "/api/definitely-not-a-route", { id: "OBA-1" });
      assert.equal(p.status, 404);
      assert.deepEqual(await p.json(), { errors: ["unknown endpoint"] });
    } finally { server.close(); }
  });

  test("a GET on a write-only route is unclassified, so it 404s too", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects });
    try {
      const r = await fetch(`${base}/api/edit`);
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { errors: ["unknown endpoint"] });
    } finally { server.close(); }
  });

  test("non-/api paths are untouched by the gate", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects });
    try {
      assert.equal((await fetch(`${base}/`)).status, 200);
      assert.equal((await fetch(`${base}/nope`)).status, 404);
    } finally { server.close(); }
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
