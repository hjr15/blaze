// tests/serve-csrf-bearer.test.mjs — BLZ-684 (spec §5.4, ADR-0013's addendum).
//
// The CSRF header is forgery protection for a request a BROWSER was made to send. A bearer-only
// JSON request with no cross-site fetch metadata cannot be one, so it skips the header — that is
// what lets a CLI on another machine write over HTTP. Everything else keeps it, and this file
// pins every side of that line on a real server: cookie alone, cookie + bearer, no credential, a
// read-only token, a loopback board with no users, a text/plain body, a cross-site
// `sec-fetch-site`, and ADR-0034's reverse proxy that injects the bearer token for a browser.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, CSRF } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { loadIdentity } from "../scripts/model/identity-db.mjs";
import { csrfRequired, isJsonContentType, SESSION_COOKIE } from "../scripts/model/serve-auth.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const PASSWORD = "correct horse battery staple";
const TICKET = join("projects", "OBA", "defined", "OBA-1.md");

/** A git-backed board (fs mode commits per op) holding OBA-1. */
function board() {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz684-csrf-")));
  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"]]) {
    execFileSync("git", ["-C", root, ...a]);
  }
  mkdirSync(join(root, "projects", "OBA", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"] }));
  writeFileSync(join(root, TICKET),
    ["---", "id: OBA-1", "title: t", "type: task", "project: OBA", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

async function boot(root) {
  const server = startServer({ port: 0, root, projectsDir: join(root, "projects") });
  await new Promise((res) => server.once("listening", res));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** A board with an admin who has a password (for a session cookie) and a bearer token. */
async function configured() {
  const root = board();
  const { token } = await addUser(root, { email: "op@example.com", role: "admin" });
  const id = loadIdentity(root);
  await id.store.setPassword({ email: "op@example.com", password: PASSWORD });
  id.close();
  const { server, base } = await boot(root);
  const signin = await fetch(`${base}/signin`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", "x-blaze-csrf": CSRF },
    body: JSON.stringify({ email: "op@example.com", password: PASSWORD }),
  });
  assert.equal(signin.status, 200);
  const cookie = signin.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)).split(";")[0];
  return { root, server, base, bearer: token.token, cookie };
}

/** POST /api/edit setting OBA-1's priority, with exactly the headers given. */
const edit = (base, headers, priority = "high") => fetch(`${base}/api/edit`, {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ id: "OBA-1", patch: { priority } }),
});
const priorityOf = (root) => /priority: (\w+)/.exec(readFileSync(join(root, TICKET), "utf8"))[1];

describe("csrfRequired — the rule, as a function", () => {
  const store = {};
  const json = { "content-type": "application/json" };
  const bearer = { authorization: "Bearer blz_x", ...json };
  test("a bearer-only JSON request with no cross-site metadata, on a board with users, is exempt", () => {
    assert.equal(csrfRequired({ headers: bearer, store }), false);
    assert.equal(csrfRequired({ headers: { ...bearer, "content-type": "application/json; charset=utf-8" }, store }), false);
    for (const site of ["same-origin", "none", "SAME-ORIGIN"]) {
      assert.equal(csrfRequired({ headers: { ...bearer, "sec-fetch-site": site }, store }), false, site);
    }
  });
  test("a session cookie — alone or beside a bearer token — is not", () => {
    assert.equal(csrfRequired({ headers: { cookie: `${SESSION_COOKIE}=blz_sess.x`, ...json }, store }), true);
    assert.equal(csrfRequired({ headers: { ...bearer, cookie: `${SESSION_COOKIE}=blz_sess.x` }, store }), true);
  });
  test("a body a cross-site page can send without a preflight is not, bearer or not", () => {
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x",
                      "", "application/jsonx", "text/json"]) {
      assert.equal(csrfRequired({ headers: { ...bearer, "content-type": ct }, store }), true, JSON.stringify(ct));
    }
  });
  test("a browser reporting a cross-site or same-site initiator is not, whatever a proxy added", () => {
    for (const site of ["cross-site", "same-site"]) {
      assert.equal(csrfRequired({ headers: { ...bearer, "sec-fetch-site": site }, store }), true, site);
    }
  });
  test("BLZ-691: a comma-joined sec-fetch-site that names cross-site anywhere is not exempt", () => {
    for (const site of ["same-origin, cross-site", "none, cross-site", "same-origin,same-origin"]) {
      assert.equal(csrfRequired({ headers: { ...bearer, "sec-fetch-site": site }, store }), true, site);
    }
  });
  test("no credential, a session pasted as a bearer, or a board with no users: required", () => {
    assert.equal(csrfRequired({ headers: json, store }), true);
    assert.equal(csrfRequired({ headers: { ...json, authorization: "Bearer blz_sess.x" }, store }), true);
    assert.equal(csrfRequired({ headers: bearer, store: null }), true);
  });
  test("an unrelated cookie does not make a bearer request a cookie request", () => {
    assert.equal(csrfRequired({ headers: { ...bearer, cookie: "theme=dark" }, store }), false);
  });
  test("isJsonContentType reads the media type only, case-insensitively", () => {
    assert.equal(isJsonContentType({ "content-type": "Application/JSON ; charset=utf-8" }), true);
    assert.equal(isJsonContentType({}), false);
  });
});

describe("on a real server", () => {
  test("bearer alone, no CSRF header → 200, and the write happened", async () => {
    const { root, server, base, bearer } = await configured();
    try {
      const r = await edit(base, { authorization: `Bearer ${bearer}` });
      assert.equal(r.status, 200, await r.text());
      assert.equal(priorityOf(root), "high");
    } finally { server.close(); }
  });

  test("a session cookie alone, no CSRF header → 403 and nothing written; WITH it → 200", async () => {
    const { root, server, base, cookie } = await configured();
    try {
      const r = await edit(base, { cookie });
      assert.equal(r.status, 403);
      assert.match((await r.json()).errors[0], /csrf/i);
      assert.equal(priorityOf(root), "medium");
      assert.equal((await edit(base, { cookie, "x-blaze-csrf": CSRF })).status, 200, "the check discriminates");
      assert.equal(priorityOf(root), "high");
    } finally { server.close(); }
  });

  test("cookie + bearer, no CSRF header → 403: a request carrying the cookie is a cookie request", async () => {
    const { root, server, base, bearer, cookie } = await configured();
    try {
      const r = await edit(base, { cookie, authorization: `Bearer ${bearer}` });
      assert.equal(r.status, 403);
      assert.match((await r.json()).errors[0], /csrf/i);
      assert.equal(priorityOf(root), "medium");
    } finally { server.close(); }
  });

  test("no credential → 401, with or without the CSRF header — the header is never a credential", async () => {
    const { root, server, base } = await configured();
    try {
      assert.equal((await edit(base, {})).status, 401);
      assert.equal((await edit(base, { "x-blaze-csrf": CSRF })).status, 401);
      assert.equal((await edit(base, { authorization: "Bearer blz_not-a-token" })).status, 401);
      assert.equal(priorityOf(root), "medium");
    } finally { server.close(); }
  });

  test("a read-scope token → 403 on a write, CSRF header or not", async () => {
    const root = board();
    const { token } = await addUser(root, { email: "v@example.com", role: "viewer" });
    const { server, base } = await boot(root);
    try {
      for (const headers of [{}, { "x-blaze-csrf": CSRF }]) {
        const r = await edit(base, { authorization: `Bearer ${token.token}`, ...headers });
        assert.equal(r.status, 403);
        assert.match((await r.json()).errors[0], /does not carry the 'write' scope/);
      }
      assert.equal(priorityOf(root), "medium");
    } finally { server.close(); }
  });

  test("bearer + a text/plain body, no CSRF header → 403: the simple request CSRF uses", async () => {
    const { root, server, base, bearer } = await configured();
    try {
      const r = await edit(base, { authorization: `Bearer ${bearer}`, "content-type": "text/plain" });
      assert.equal(r.status, 403);
      assert.match((await r.json()).errors[0], /csrf/i);
      assert.equal(priorityOf(root), "medium");
    } finally { server.close(); }
  });

  test("bearer + JSON + `sec-fetch-site: cross-site` → 403; same JSON with no fetch metadata → 200", async () => {
    const { root, server, base, bearer } = await configured();
    try {
      const r = await edit(base, { authorization: `Bearer ${bearer}`, "sec-fetch-site": "cross-site" });
      assert.equal(r.status, 403);
      assert.equal(priorityOf(root), "medium");
      assert.equal((await edit(base, { authorization: `Bearer ${bearer}` })).status, 200);
      assert.equal(priorityOf(root), "high");
    } finally { server.close(); }
  });

  test("ADR-0034's proxy that injects the bearer for a browser: a cross-site form post is still 403", async () => {
    // The shape adversarial review round 1 reproduced: a reverse proxy authenticates the
    // browser by its own means and adds `Authorization: Bearer`, then forwards what a hostile
    // page made the browser send — a `<form enctype="text/plain">` POST, which needs no
    // preflight. Without the content-type and fetch-metadata conditions this landed (200).
    const { root, server, base, bearer } = await configured();
    const target = new URL(base);
    const proxy = createServer((req, res) => {
      const up = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method,
                               headers: { ...req.headers, authorization: `Bearer ${bearer}` } },
        (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      req.pipe(up);
    });
    await new Promise((res) => proxy.listen(0, "127.0.0.1", res));
    try {
      const r = await fetch(`http://127.0.0.1:${proxy.address().port}/api/edit`, {
        method: "POST",
        headers: { "content-type": "text/plain", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        body: JSON.stringify({ id: "OBA-1", patch: { priority: "lowest" } }),
      });
      assert.equal(r.status, 403);
      assert.match((await r.json()).errors[0], /csrf/i);
      assert.equal(priorityOf(root), "medium", "nothing was written");
    } finally { proxy.close(); server.close(); }
  });

  test("a loopback board with NO users still requires the header, bearer or not", async () => {
    const root = board();
    const { server, base } = await boot(root);
    try {
      const r = await edit(base, { authorization: "Bearer blz_anything" });
      assert.equal(r.status, 403);
      assert.match((await r.json()).errors[0], /csrf/i);
      assert.equal(priorityOf(root), "medium");
    } finally { server.close(); }
  });
});
