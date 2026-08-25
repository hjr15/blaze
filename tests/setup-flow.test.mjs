// tests/setup-flow.test.mjs — BLZ-358: first-run setup over HTTP.
//
// BLZ-348 wired ADR-0013's bind check into serve.mjs, and the consequence was that the
// shipped image refuses to start: the Dockerfile sets HOST=0.0.0.0 and checkBindSafety
// refuses a non-loopback bind with no identities. Refusing is right GIVEN NO
// ALTERNATIVE. The alternative is to serve a setup flow, and it has to be reachable
// over HTTP, because a container with no TTY cannot be prompted — scripts/init.mjs's
// terminal wizard cannot reach `docker run -p 4321:4321`.
//
// The protection is a one-time token written to <board>/.blaze/setup-token at 0600.
// Its PATH is logged; its VALUE never is, anywhere, ever.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, CSRF } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { loadIdentity } from "../scripts/model/identity-db.mjs";
import {
  setupTokenPath, issueSetupToken, readSetupToken, clearSetupToken, setupTokenMatches,
} from "../scripts/model/setup-token.mjs";

function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-setup-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    ["---", "id: OBA-1", "title: t", "type: task", "project: OBA", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return { root, projects };
}

async function boot(opts) {
  const server = startServer({ port: 0, ...opts });
  await new Promise((res) => server.once("listening", res));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const postSetup = (base, body) =>
  fetch(`${base}/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-blaze-csrf": CSRF },
    body: JSON.stringify(body),
  });

// =============================================================================
// The token file itself
// =============================================================================

describe("BLZ-358: the setup token is a file, at 0600, under the board", () => {
  test("it lands at <board>/.blaze/setup-token", () => {
    const { root } = board();
    try {
      const { path } = issueSetupToken(root);
      assert.equal(path, join(root, ".blaze", "setup-token"));
      assert.equal(path, setupTokenPath(root));
      assert.ok(existsSync(path));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the file is 0600 and its directory 0700 — nobody else on the box reads it", () => {
    const { root } = board();
    try {
      const { path } = issueSetupToken(root);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(join(root, ".blaze")).mode & 0o777, 0o700);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("an abandoned setup is REGENERATED, never reused", () => {
    const { root } = board();
    try {
      const first = issueSetupToken(root).token;
      const second = issueSetupToken(root).token;
      assert.notEqual(first, second, "a second start must not re-serve the first token");
      assert.equal(readSetupToken(root), second, "the file must carry the live token, not the stale one");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("clearing is idempotent, so a completed setup cannot fail on a second call", () => {
    const { root } = board();
    try {
      issueSetupToken(root);
      clearSetupToken(root);
      assert.equal(existsSync(setupTokenPath(root)), false);
      clearSetupToken(root);
      assert.equal(readSetupToken(root), null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("comparison rejects a wrong token, a prefix, and an absent one", () => {
    assert.equal(setupTokenMatches("blz_setup_aaa", "blz_setup_aaa"), true);
    assert.equal(setupTokenMatches("blz_setup_aaa", "blz_setup_aab"), false);
    assert.equal(setupTokenMatches("blz_setup_aa", "blz_setup_aaa"), false, "a prefix is not a match");
    assert.equal(setupTokenMatches("", "blz_setup_aaa"), false);
    assert.equal(setupTokenMatches("blz_setup_aaa", null), false);
    assert.equal(setupTokenMatches(null, null), false, "absent-vs-absent is not an authentication");
  });
});

// =============================================================================
// Entering setup mode instead of refusing
// =============================================================================

describe("BLZ-358: a non-loopback bind with no identities SERVES SETUP instead of exiting", () => {
  test("the server starts, where it used to throw", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      assert.equal(server.address().address, "0.0.0.0");
      const r = await fetch(`${base}/setup`);
      assert.equal(r.status, 200, "the setup page must be reachable — this is the whole ticket");
      assert.match(await r.text(), /setup/i);
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("the token file is written on entering setup mode", async () => {
    const { root, projects } = board();
    const { server } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      assert.ok(existsSync(setupTokenPath(root)), "setup mode must issue a token to gate itself");
      assert.equal(statSync(setupTokenPath(root)).mode & 0o777, 0o600);
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("NOTHING ELSE is served while setup is pending — not the board, not the API", async () => {
    // The security property BLZ-348 bought must survive this ticket. Serving the board
    // unauthenticated on 0.0.0.0 is exactly what the refusal existed to prevent, so
    // setup mode must not become a way to reach it.
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      for (const path of ["/", "/api/live", "/api/hash", "/view/board"]) {
        const r = await fetch(`${base}${path}`);
        assert.equal(r.status, 503, `${path} must not be served before setup completes`);
        const body = await r.text();
        assert.doesNotMatch(body, /OBA-1/, `${path} leaked board content before setup`);
      }
      const w = await fetch(`${base}/api/move`, {
        method: "POST", headers: { "content-type": "application/json", "x-blaze-csrf": CSRF },
        body: JSON.stringify({ id: "OBA-1", to: "in-progress" }),
      });
      assert.equal(w.status, 503, "a mutating route must not be open during setup");
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("loopback with no identities is UNCHANGED — no setup mode, no token file", async () => {
    // Backwards compatibility. This is the path Blaze has always had, the refusal never
    // applied to it, and this ticket must not quietly change it.
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "127.0.0.1" });
    try {
      const r = await fetch(`${base}/`);
      assert.equal(r.status, 200, "a loopback board still serves without a credential");
      assert.match(await r.text(), /OBA-1/);
      assert.equal(existsSync(setupTokenPath(root)), false,
        "a loopback board is not in setup mode and must not have a token written");
      assert.equal((await fetch(`${base}/setup`)).status, 404,
        "there is no setup route where there is no refusal to replace");
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("a BROKEN identity database still throws — it is not 'no identity'", async () => {
    // BLZ-348 put the broken check BEFORE the bind check precisely so a damaged roster is
    // diagnosed as damaged. Reading it as "no users" would let a corrupt board hand out a
    // fresh admin account to whoever reached the port first.
    const { root, projects } = board();
    try {
      mkdirSync(join(root, ".blaze"), { recursive: true });
      writeFileSync(join(root, ".blaze", "identity.db"), "this is not a database");
      assert.throws(() => startServer({ port: 0, root, projectsDir: projects, host: "0.0.0.0" }));
      assert.equal(existsSync(setupTokenPath(root)), false,
        "a broken roster must not issue a setup token");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// =============================================================================
// Completing setup
// =============================================================================

describe("BLZ-358: completing setup creates the first admin through the ordinary path", () => {
  test("the right token creates an admin and returns its API token exactly once", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      const token = readSetupToken(root);
      const r = await postSetup(base, { token, email: "ryan@example.com", displayName: "Ryan" });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.match(body.token, /^blz_/, "the new admin's API token is returned, once");
      assert.equal(body.user.email, "ryan@example.com");
      assert.equal(body.user.role, "admin");

      // ADR-0013: shown once, stored hashed. The plaintext must not be in the database.
      const db = readFileSync(join(root, ".blaze", "identity.db"));
      assert.equal(db.includes(Buffer.from(body.token)), false,
        "the API token must never be persisted in plaintext");
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("the admin is created by addUser — the same path as `blaze user add`", async () => {
    // ADR-0013 section 5: "the first admin is a user, not an exception". A bootstrap
    // branch would be a second way to make a user, and the one that skips the rules.
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      await postSetup(base, { token: readSetupToken(root), email: "a@b.c" });
      const id = loadIdentity(root);
      try {
        assert.equal(id.state, "healthy");
        assert.equal(id.hasIdentity, true);
      } finally { id.close(); }
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("the token file is REMOVED once setup completes", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      await postSetup(base, { token: readSetupToken(root), email: "a@b.c" });
      assert.equal(existsSync(setupTokenPath(root)), false,
        "a live credential must not outlive the thing it authorises");
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("a WRONG token creates nothing and says nothing useful", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      const r = await postSetup(base, { token: "blz_setup_wrong", email: "evil@example.com" });
      assert.equal(r.status, 401);
      const id = loadIdentity(root);
      try { assert.equal(id.hasIdentity, false, "a failed setup must not create a user"); }
      finally { id.close(); }
      assert.ok(existsSync(setupTokenPath(root)), "a failed attempt must not consume the token");
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("a MISSING token is refused too", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      assert.equal((await postSetup(base, { email: "a@b.c" })).status, 401);
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("a bad email is rejected without consuming the token", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      const r = await postSetup(base, { token: readSetupToken(root), email: "  " });
      assert.equal(r.status, 400);
      assert.ok(existsSync(setupTokenPath(root)), "a recoverable mistake must leave setup usable");
      const ok = await postSetup(base, { token: readSetupToken(root), email: "a@b.c" });
      assert.equal(ok.status, 200, "and the operator can then complete it");
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

// =============================================================================
// The route becomes unreachable — permanently, not merely hidden
// =============================================================================

describe("BLZ-358: setup is unreachable once an identity exists", () => {
  test("on a board that already has a user, /setup 404s and no token is written", async () => {
    const { root, projects } = board();
    await addUser(root, { email: "existing@example.com", role: "admin" });
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      assert.equal((await fetch(`${base}/setup`)).status, 404);
      assert.equal((await postSetup(base, { token: "x", email: "e@f.g" })).status, 404);
      assert.equal(existsSync(setupTokenPath(root)), false,
        "a board with an identity must never have a setup token created at all");
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("the SAME server 404s /setup immediately after setup completes", async () => {
    // Not merely hidden: the running process must close the door behind itself, or the
    // window stays open until someone restarts the container.
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      await postSetup(base, { token: readSetupToken(root), email: "a@b.c" });
      assert.equal((await fetch(`${base}/setup`)).status, 404);
      assert.equal((await postSetup(base, { token: "anything", email: "z@z.z" })).status, 404);
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("after setup the board is AUTHENTICATED, not open", async () => {
    // The failure this guards: setup completes, the process still holds store=null from
    // startup, and the board it now serves on 0.0.0.0 needs no credential — which is the
    // exact hole the refusal existed to close, re-opened by the fix for it.
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      const r = await postSetup(base, { token: readSetupToken(root), email: "a@b.c" });
      const { token } = await r.json();
      assert.equal((await fetch(`${base}/api/live`)).status, 401,
        "no credential must be refused the moment an identity exists");
      const authed = await fetch(`${base}/api/live`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(authed.status, 200, "and the token just issued must work");
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

// =============================================================================
// The value is never disclosed
// =============================================================================

describe("BLZ-358: the path is surfaced, the value never is", () => {
  test("the setup page does not contain the token", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      const token = readSetupToken(root);
      const html = await (await fetch(`${base}/setup`)).text();
      assert.equal(html.includes(token), false,
        "a page that prints the token defeats the file it is read from");
      assert.match(html, /\.blaze\/setup-token/, "it must tell the operator WHERE to look");
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("a refusal does not echo the token back", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      const token = readSetupToken(root);
      const body = await (await postSetup(base, { token: "blz_setup_wrong", email: "a@b.c" })).text();
      assert.equal(body.includes(token), false, "an error message must not leak the real token");
      assert.equal(body.includes("blz_setup_wrong"), false, "nor reflect what was presented");
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
