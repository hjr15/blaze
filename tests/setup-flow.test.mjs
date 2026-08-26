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
import { connect } from "node:net";
import { execFileSync, spawnSync } from "node:child_process";
import { startServer, CSRF } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { loadIdentity } from "../scripts/model/identity-db.mjs";
import {
  setupTokenPath, issueSetupToken, readSetupToken, clearSetupToken, setupTokenMatches,
  ensureSetupTokenIgnored,
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

// =============================================================================
// Round 2 — what an adversarial review broke
// =============================================================================

describe("BLZ-358: one unauthenticated request must not be able to kill the board", () => {
  test("a token that cannot be stringified is refused, not fatal", () => {
    // `String(presented ?? "")` throws on an object with a poisoned toString, and the
    // setup branch was the ONE place in serve.mjs without a try — the file states the
    // rule against itself three times. A pre-auth 401-able request took the process down
    // for every connected session.
    for (const poison of [{ toString: null }, { valueOf: 1, toString: 1 }, Object.create(null)]) {
      assert.doesNotThrow(() => setupTokenMatches(poison, "blz_setup_aaa"));
      assert.equal(setupTokenMatches(poison, "blz_setup_aaa"), false);
    }
  });

  test("a non-string token is never a match, whatever it is", () => {
    for (const v of [null, undefined, 0, 1, true, false, [], {}, ["blz_setup_aaa"]]) {
      assert.equal(setupTokenMatches(v, "blz_setup_aaa"), false);
    }
  });

  test("a prefix and a superstring are both refused", () => {
    assert.equal(setupTokenMatches("blz_setup_aa", "blz_setup_aaa"), false);
    assert.equal(setupTokenMatches("blz_setup_aaajunk", "blz_setup_aaa"), false);
  });

  test("end-to-end: the poisoned token gets a refusal and the server survives", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      const r = await fetch(`${base}/setup`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: { toString: null }, email: "a@b.c" }),
      });
      assert.ok(r.status === 400 || r.status === 401, `expected a refusal, got ${r.status}`);
      // The proof is the NEXT request: a dead process cannot answer it.
      assert.equal((await fetch(`${base}/setup`)).status, 200, "the server must still be alive");
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("a request line that is not a parseable URL is refused, not fatal", async () => {
    // `new URL("//", "http://localhost")` throws. The line predates this ticket, but on
    // origin/main a board in this configuration refused to start at all — serving setup
    // is what makes it reachable pre-auth on a public interface, so it is this ticket's
    // problem now.
    const { root, projects } = board();
    const { server } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    const port = server.address().port;
    const raw = (line) => new Promise((res) => {
      const sock = connect(port, "127.0.0.1", () => sock.write(`GET ${line} HTTP/1.1\r\nHost: x\r\n\r\n`));
      let buf = ""; sock.on("data", (d) => { buf += d; });
      sock.on("close", () => res(buf)); sock.on("error", () => res(buf));
      setTimeout(() => sock.destroy(), 2000);
    });
    try {
      await raw("//");
      const alive = await fetch(`http://127.0.0.1:${port}/setup`);
      assert.equal(alive.status, 200, "a malformed request line must not take the server down");
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

describe("BLZ-358: the token value reaches no output channel at all", () => {
  test("nothing written to stdout at startup contains it", async () => {
    // The design rejects Jira's printed token BECAUSE `docker logs` ships it off-box, so
    // "the value is never logged" is the headline invariant — and nothing tested the
    // channel it is about. A mutant that logged the value survived the whole suite.
    const { root, projects } = board();
    const real = console.log;
    let out = "";
    console.log = (...a) => { out += a.join(" ") + "\n"; };
    let server;
    try {
      server = startServer({ port: 0, root, projectsDir: projects, host: "0.0.0.0" });
      await new Promise((res) => server.once("listening", res));
    } finally { console.log = real; }
    try {
      const token = readSetupToken(root);
      assert.ok(token && token.length > 20);
      assert.equal(out.includes(token), false, "the token value must never be logged");
      assert.match(out, /\.blaze\/setup-token/, "but the path must be");
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("the 503 that every other route gets does not carry it", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      const token = readSetupToken(root);
      for (const path of ["/", "/api/live", "/view/board"]) {
        assert.equal((await (await fetch(`${base}${path}`)).text()).includes(token), false,
          `${path}'s 503 body leaked the token`);
      }
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

describe("BLZ-358: the token file is git-ignored even by a narrow .gitignore", () => {
  test("a .gitignore naming only identity.db still hides the setup token", async () => {
    // `ensureIdentityIgnored` asks git whether `.blaze/identity.db` is ignored. A board
    // whose rule is exactly that path answers yes, so `.blaze/` was never added and
    // `.blaze/setup-token` — a LIVE credential — was committable. The comment claiming
    // "the rule that hides one hides the other" was simply false.
    const { root } = board();
    try {
      writeFileSync(join(root, ".gitignore"), ".blaze/identity.db\n");
      execFileSync("git", ["-C", root, "add", "-A"]);
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "narrow ignore"]);
      // THROUGH THE REAL SERVER, not by calling the helper. A mutation sweep found that
      // deleting the call from startServer killed no test, because this fixture invoked
      // the helper itself — the guard was proven and its WIRING was not.
      const projects = join(root, "projects");
      const server = startServer({ port: 0, root, projectsDir: projects, host: "0.0.0.0" });
      await new Promise((res) => server.once("listening", res));
      server.close();
      assert.ok(existsSync(setupTokenPath(root)), "the fixture must really have a token");
      const r = spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-q", ".blaze/setup-token"]);
      assert.equal(r.status, 0, "the setup token must be ignored, not merely assumed to be");
      execFileSync("git", ["-C", root, "add", "-A"]);
      const staged = execFileSync("git", ["-C", root, "diff", "--cached", "--name-only"], { encoding: "utf8" });
      assert.doesNotMatch(staged, /setup-token/, "and `git add -A` must not stage a live credential");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("BLZ-358: only one setup can be in flight", () => {
  test("ten concurrent correct-token requests create exactly one admin", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      const token = readSetupToken(root);
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
        postSetup(base, { token, email: `a${i}@b.c` }).then((r) => r.status)));
      assert.equal(results.filter((s) => s === 200).length, 1,
        `exactly one request may succeed, got ${JSON.stringify(results)}`);
      const id = loadIdentity(root);
      try { assert.equal(id.state, "healthy"); } finally { id.close(); }
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  // THE IN-FLIGHT GUARD WAS UNOBSERVABLE. Deleting the 409 check AND the flag that sets
  // it changed no test in the suite, and lcov showed the 409 branch with zero hits. The
  // reason is that `addUser` on the SQLite store never yields, so ten concurrent correct-
  // token requests are serialised by the event loop: one wins with 200 and the other nine
  // are 404ed by `gate()` AFTER `setupPending` flipped — refused by the very accident the
  // guard exists so as not to rely on. A store that yields reaches the guard, so it is
  // real; it simply could not be seen. `addUser` is injected here to make it yield.
  test("only ONE concurrent setup wins when addUser yields — the rest get 409", async () => {
    const { root, projects } = board();
    let calls = 0;
    const yieldingAddUser = async (r, opts) => {
      calls += 1;
      await new Promise((res) => setTimeout(res, 40));   // a real await point
      return addUser(r, opts);
    };
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0",
                                          addUser: yieldingAddUser });
    try {
      const token = readSetupToken(root);
      const results = await Promise.all(Array.from({ length: 10 }, () =>
        postSetup(base, { token, email: "a@b.c" }).then((r) => r.status)));
      const tally = results.reduce((m, x) => ({ ...m, [x]: (m[x] || 0) + 1 }), {});
      assert.equal(tally[200], 1, `exactly one setup may succeed, got ${JSON.stringify(tally)}`);
      assert.equal(tally[409], 9,
        `the other nine must be refused BY THE GUARD, not by a race we got lucky on — got ${JSON.stringify(tally)}`);
      assert.equal(calls, 1, "addUser must be reached exactly once");
      const ident = loadIdentity(root);
      try {
        assert.equal(ident.state, "healthy");
        assert.equal((await ident.store.listUsers()).length, 1,
          "exactly one admin may be created, however many requests raced");
      } finally { ident.close(); }
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  // AND THE LATCH MUST CLEAR ON FAILURE. Dropping `setupInFlight = false` from the
  // addUser catch also changed no test: the one that claims to cover it sends
  // `email: { bad: 1 }`, which the email type guard rejects one line EARLIER, so it
  // never reaches the flag at all. Without the reset, a single failed creation latches
  // the flag forever and setup can never be completed — on a board with no identity,
  // that is a permanently unusable install needing a restart.
  test("a FAILED creation clears the latch — setup stays completable, not bricked", async () => {
    const { root, projects } = board();
    let n = 0;
    const failsOnce = async (r, opts) => {
      n += 1;
      if (n === 1) throw new Error("store unavailable");
      return addUser(r, opts);
    };
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0",
                                          addUser: failsOnce });
    try {
      const token = readSetupToken(root);
      assert.equal((await postSetup(base, { token, email: "a@b.c" })).status, 400,
        "a failed creation is a 400");
      const retry = await postSetup(base, { token, email: "a@b.c" });
      assert.equal(retry.status, 200,
        "the latch must have cleared — a 409 here means setup is bricked for good");
      assert.equal(n, 2, "the retry must actually reach addUser");
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("a rejected email leaves setup completable", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0" });
    try {
      assert.equal((await postSetup(base, { token: readSetupToken(root), email: { bad: 1 } })).status, 400);
      assert.equal((await postSetup(base, { token: readSetupToken(root), email: "a@b.c" })).status, 200,
        "an in-flight flag must not latch on a rejected attempt");
    } finally { server.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
