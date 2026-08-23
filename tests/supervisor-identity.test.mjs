// tests/supervisor-identity.test.mjs — BLZ-359: the OTHER HTTP server.
//
// BLZ-348 wired `gate()` and `checkBindSafety` into `serve.mjs` — the board server you
// get from `blaze board`. `blaze start` (and bare `blaze`, the DEFAULT command) boots
// `supervisor.mjs` instead, which is a SECOND, separate HTTP server, and it imported
// neither. Measured against a board WITH identities configured, before this change:
//
//     GET  /api/hash              -> 200   (a `read` route in ROUTE_SCOPES, ungated here)
//     GET  /view/board            -> 200
//     POST /control/groomer/stop  -> 204   no token, no CSRF
//     POST /control/revert        -> 204   no token, no CSRF -> execFileSync("git","revert")
//
// Every test in this file fails on a `supervisor.mjs` that does not import the gate.
//
// The exposure is loopback-only (supervisor.mjs has always hardcoded 127.0.0.1) and
// pre-existing, so this is not a remote hole. It still matters: `/control/groomer/run`
// is the agent-dispatch endpoint, `/control/revert` shells out to `git revert`, and any
// local process — including an agent Blaze itself spawned — could call both.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, truncateSync,
         appendFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../scripts/config.mjs";
import { createApp } from "../scripts/supervisor.mjs";
import { CSRF } from "../scripts/views/page.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { openIdentityDb, identityDbPath } from "../scripts/model/identity-db.mjs";

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

/** A real git board: a flat `backlog/` the groomer can act on, plus a `projects/` tree
 *  so `/`, `/view/board` and `/api/hash` have genuine ticket content to protect. */
function board() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-sup-id-"));
  mkdirSync(join(dir, "backlog"), { recursive: true });
  mkdirSync(join(dir, "projects", "TASK", "defined"), { recursive: true });
  const stub = join(dir, "stub-agent.sh");
  writeFileSync(stub, '#!/usr/bin/env bash\nsed -i -E "s/^labels: \\[\\]/labels: [backend]/" "$BLAZE_GROOM_TARGET"\n');
  chmodSync(stub, 0o755);
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({
    key: "TASK", agentCommand: `bash ${stub}`, loops: { groomer: { columns: ["backlog"] } },
  }));
  writeFileSync(join(dir, "backlog", "TASK-001-x.md"),
    "---\nid: TASK-001\ntitle: x\ntype: feature\npriority: medium\nlabels: []\n---\nbody\n");
  writeFileSync(join(dir, "projects", "TASK", "defined", "TASK-002-secret.md"),
    ["---", "id: TASK-002", "title: SECRETTICKET", "type: task", "project: TASK",
     "priority: medium", "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01",
     "---", "", "## Acceptance Criteria", "", "- [ ] one", ""].join("\n"));
  for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                   ["add", "-A"], ["commit", "-q", "-m", "seed"]]) git(dir, ...a);
  // A second, revertable commit. Reverting the seed would empty the worktree.
  appendFileSync(join(dir, "backlog", "TASK-001-x.md"), "more body\n");
  git(dir, "commit", "-q", "-am", "second");
  return dir;
}

const revertableSha = (dir) => git(dir, "rev-parse", "HEAD").trim();
const reverted = (dir) => /Revert "second"/.test(git(dir, "log", "--oneline"));
const groomed = (dir) => /chore\(groom\): TASK-001/.test(git(dir, "log", "--oneline"));

async function boot(dir, opts = {}) {
  const cfg = loadConfig({ root: dir, env: {} });
  const app = createApp(cfg, { root: dir, ...opts });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

/** Control POSTs carry the CSRF header so an auth assertion is never satisfied by the
 *  CSRF refusal instead — the two are proven apart in their own describe below. */
const ctl = (base, path, { token = null, csrf = true, body = null } = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      ...(csrf ? { "x-blaze-csrf": CSRF } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` } });

describe("BLZ-359: /control/* requires a write-scoped principal once identities exist", () => {
  test("POST /control/revert with no token is refused AND does not run git revert", async () => {
    const dir = board();
    const sha = revertableSha(dir);
    await addUser(dir, { email: "a@b.c", role: "admin" });
    const { app, base } = await boot(dir);
    try {
      const r = await ctl(base, "/control/revert", { body: { sha } });
      assert.equal(r.status, 401, "an unauthenticated revert must be refused");
      assert.equal(reverted(dir), false, "git revert must not have run");
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("POST /control/revert with a READ-only token is 403, and still does not revert", async () => {
    const dir = board();
    const sha = revertableSha(dir);
    const { token } = await addUser(dir, { email: "v@b.c", role: "viewer" });
    const { app, base } = await boot(dir);
    try {
      const r = await ctl(base, "/control/revert", { token: token.token, body: { sha } });
      assert.equal(r.status, 403);
      assert.match((await r.json()).errors[0], /does not carry the 'write' scope/);
      assert.equal(reverted(dir), false);
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("POST /control/revert with a WRITE-scoped token still reverts — the gate is not a wall",
    async () => {
      const dir = board();
      const sha = revertableSha(dir);
      const { token } = await addUser(dir, { email: "m@b.c", role: "member" });
      const { app, base } = await boot(dir);
      try {
        const r = await ctl(base, "/control/revert", { token: token.token, body: { sha } });
        assert.equal(r.status, 204);
        assert.equal(reverted(dir), true, "an authorised revert must still happen");
      } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
    });

  test("POST /control/groomer/run — the agent-dispatch endpoint — refuses without a token",
    async () => {
      const dir = board();
      await addUser(dir, { email: "a@b.c", role: "admin" });
      const { app, base } = await boot(dir);
      try {
        assert.equal((await ctl(base, "/control/groomer/run")).status, 401);
        assert.equal(groomed(dir), false, "no agent may be dispatched by an anonymous caller");
      } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
    });

  test("POST /control/groomer/run with a write-scoped token still dispatches the agent", async () => {
    const dir = board();
    const { token } = await addUser(dir, { email: "m@b.c", role: "member" });
    const { app, base } = await boot(dir);
    try {
      assert.equal((await ctl(base, "/control/groomer/run", { token: token.token })).status, 204);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(groomed(dir), true, "an authorised groom must still run");
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("EVERY /control/* route needs `write` — a read-only token is refused on all seven", async () => {
    // Mutation cover. Without this, downgrading any single row of SUPERVISOR_SCOPES from
    // "write" to "read" survives every other test in this file: a no-token call still
    // 401s and a member's call still succeeds, so only a VIEWER distinguishes the two.
    const dir = board();
    const sha = revertableSha(dir);
    const { token } = await addUser(dir, { email: "v@b.c", role: "viewer" });
    const { app, base } = await boot(dir);
    try {
      for (const path of ["/control/reconcile/start", "/control/reconcile/stop",
                          "/control/reconcile/run", "/control/groomer/start",
                          "/control/groomer/stop", "/control/groomer/run",
                          "/control/revert"]) {
        const r = await ctl(base, path, { token: token.token, body: { sha } });
        assert.equal(r.status, 403, `${path} must refuse a read-only token`);
        assert.match((await r.json()).errors[0], /does not carry the 'write' scope/);
      }
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(groomed(dir), false, "no groom may have run");
      assert.equal(reverted(dir), false, "no revert may have run");
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("POST /control/groomer/stop and /control/reconcile/start are refused too", async () => {
    const dir = board();
    await addUser(dir, { email: "a@b.c", role: "admin" });
    const { app, base } = await boot(dir);
    try {
      assert.equal((await ctl(base, "/control/groomer/stop")).status, 401);
      assert.equal((await ctl(base, "/control/reconcile/start")).status, 401);
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("BLZ-359: the supervisor's reads are gated exactly as the board server's are", () => {
  test("GET /api/hash is 401 without a token and 200 with one", async () => {
    const dir = board();
    const { token } = await addUser(dir, { email: "v@b.c", role: "viewer" });
    const { app, base } = await boot(dir);
    try {
      assert.equal((await fetch(`${base}/api/hash`)).status, 401);
      assert.equal((await fetch(`${base}/api/hash`, bearer(token.token))).status, 200);
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("GET /api/sync is 401 without a token and 200 with one", async () => {
    const dir = board();
    const { token } = await addUser(dir, { email: "v@b.c", role: "viewer" });
    const { app, base } = await boot(dir);
    try {
      assert.equal((await fetch(`${base}/api/sync`)).status, 401);
      assert.equal((await fetch(`${base}/api/sync`, bearer(token.token))).status, 200);
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("GET / hands no ticket content to an anonymous caller, and still renders for a viewer",
    async () => {
      const dir = board();
      const { token } = await addUser(dir, { email: "v@b.c", role: "viewer" });
      const { app, base } = await boot(dir);
      try {
        const anon = await fetch(`${base}/`);
        assert.equal(anon.status, 401);
        const body = await anon.text();
        assert.doesNotMatch(body, /SECRETTICKET/, "no ticket content without a credential");
        assert.doesNotMatch(body, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
          "and no harvestable CSRF uuid either");
        assert.match(body, /Authorization: Bearer/, "the refusal must say how to authenticate");

        const authed = await fetch(`${base}/`, bearer(token.token));
        assert.equal(authed.status, 200);
        assert.match(await authed.text(), /SECRETTICKET/);
      } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
    });

  test("GET /view/<name> is 401 without a token and 200 with one", async () => {
    const dir = board();
    const { token } = await addUser(dir, { email: "v@b.c", role: "viewer" });
    const { app, base } = await boot(dir);
    try {
      assert.equal((await fetch(`${base}/view/board`)).status, 401);
      assert.equal((await fetch(`${base}/view/board`, bearer(token.token))).status, 200);
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("POST /events does not slip past the gate as an unclassified route", async () => {
    // Every other handler in supervisor.mjs pins its method; /events did not, and the
    // scope table only classifies GET. An unpinned handler beneath a method-keyed gate
    // is an ungated route — so this asserts the stream is never opened for a method the
    // table does not cover, on a board that HAS users.
    const dir = board();
    await addUser(dir, { email: "v@b.c", role: "viewer" });
    const { app, base } = await boot(dir);
    const cancel = new AbortController();
    try {
      const r = await fetch(`${base}/events`, { method: "POST", signal: cancel.signal });
      assert.notEqual(r.status, 200, "a POST must not open the activity stream");
      assert.doesNotMatch(String(r.headers.get("content-type")), /event-stream/);
    } finally {
      cancel.abort();
      app.server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GET /events — the activity feed — is 401 without a token", async () => {
    const dir = board();
    await addUser(dir, { email: "v@b.c", role: "viewer" });
    const { app, base } = await boot(dir);
    // Aborted in the finally: if the feed is NOT refused this is a live SSE stream whose
    // heartbeat interval keeps the event loop alive forever, and the test run hangs
    // instead of failing. A test that hangs on the bug it is guarding is not a guard.
    const cancel = new AbortController();
    try {
      const r = await fetch(`${base}/events`, { signal: cancel.signal });
      assert.equal(r.status, 401);
      assert.doesNotMatch(String(r.headers.get("content-type")), /event-stream/,
        "a refused feed must not have been opened as a stream");
    } finally {
      cancel.abort();
      app.server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("BLZ-359: a board with NO identities is untouched — the gate must not become a wall", () => {
  // The assertion has to vary with the thing under test. Everything refused above is
  // served here, on a board whose only difference is that nobody has run `blaze user add`.
  const openBoardServesEverything = async (dir) => {
    const sha = revertableSha(dir);
    const { app, base } = await boot(dir);
    try {
      assert.equal((await fetch(`${base}/api/hash`)).status, 200);
      assert.equal((await fetch(`${base}/api/sync`)).status, 200);
      assert.equal((await fetch(`${base}/view/board`)).status, 200);
      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /SECRETTICKET/);
      assert.equal((await ctl(base, "/control/groomer/stop")).status, 204);
      assert.equal((await ctl(base, "/control/revert", { body: { sha } })).status, 204);
      assert.equal(reverted(dir), true, "the historic loopback behaviour is unchanged");
    } finally { app.server.close(); }
  };

  test("ABSENT — no .blaze/identity.db at all", async () => {
    const dir = board();
    assert.equal(existsSync(identityDbPath(dir)), false);
    try { await openBoardServesEverything(dir); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("EMPTY — the identity schema exists but nobody is in it", async () => {
    const dir = board();
    openIdentityDb(dir, { create: true }).db.close();
    assert.equal(existsSync(identityDbPath(dir)), true, "the file must really exist");
    try { await openBoardServesEverything(dir); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("BLZ-359: a BROKEN roster refuses — it must never fall through to unauthenticated", () => {
  // BLZ-348 shipped exactly this bug in serve.mjs and fixed it: a corrupt identity.db
  // read as "no identities configured" and silently removed authentication. The
  // supervisor must not reintroduce it by reading only `hasIdentity`.
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
    test(`the supervisor refuses to boot with ${label}`, async () => {
      const dir = board();
      await addUser(dir, { email: "a@b.c", role: "admin" });
      breakIt(identityDbPath(dir));

      let app = null;
      try {
        ({ app } = await boot(dir));
        const anon = await fetch(`http://127.0.0.1:${app.server.address().port}/api/hash`);
        assert.fail(`the supervisor served a request with a broken roster (no-token=${anon.status})`);
      } catch (e) {
        if (app) { app.server.close(); throw e; }
        assert.match(e.message, /identity database/i);
        assert.doesNotMatch(e.message, /no users configured/,
          "a corrupt roster must not be diagnosed as an empty one");
        assert.match(e.message, new RegExp(identityDbPath(dir).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

describe("BLZ-359: a gate that CANNOT decide is a refusal, not a pass", () => {
  // Ported from tests/identity-resilience.test.mjs §2, which covers serve.mjs's identical
  // branch. It was the one survivor of the security review's independent mutation set:
  //
  //     -  return json(503, { errors: ["authentication is temporarily unavailable"] });
  //     +  decision = { ok: true, status: 200, error: null, principal: null };
  //
  // left all 35 supervisor tests green, and the exploit then worked — truncate a running
  // board's identity.db, present any bogus token with a valid CSRF header, and
  // /control/revert returned 204 with the revert commit landing. An untested fail-closed
  // branch is a fail-OPEN branch waiting for an edit.
  //
  // The store is injected, so this needs no read-only mount and no lock: it isolates the
  // one thing under test — what the handler does when the gate throws.
  const explodingIdentity = () => ({
    state: "healthy", hasIdentity: true, error: null, close() {},
    store: { authenticate: async () => { throw new Error("database is locked"); } },
  });

  test("a read whose gate throws is 503, and the server survives to answer again", async () => {
    const dir = board();
    const { app, base } = await boot(dir, { identity: explodingIdentity() });
    try {
      const r = await fetch(`${base}/api/hash`, { headers: { authorization: "Bearer blz_whatever" } });
      assert.equal(r.status, 503);
      assert.match((await r.json()).errors[0], /unavailable/i);
      // The point of not rethrowing: a second request still gets an answer rather than
      // the process having exited for every connected session.
      const again = await fetch(`${base}/api/hash`, { headers: { authorization: "Bearer blz_whatever" } });
      assert.equal(again.status, 503, "the server must still be listening");
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("it FAILS CLOSED — /control/revert with a thrown gate does not reach git", async () => {
    const dir = board();
    const sha = revertableSha(dir);
    const { app, base } = await boot(dir, { identity: explodingIdentity() });
    try {
      const r = await ctl(base, "/control/revert",
        { token: "blz_whatever", body: { sha } });
      assert.equal(r.status, 503);
      assert.equal(reverted(dir), false,
        "a request the gate could not decide must not reach the shell-out");
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("...and /control/groomer/run with a thrown gate dispatches no agent", async () => {
    const dir = board();
    const { app, base } = await boot(dir, { identity: explodingIdentity() });
    try {
      const r = await ctl(base, "/control/groomer/run", { token: "blz_whatever" });
      assert.equal(r.status, 503);
      await new Promise((res) => setTimeout(res, 100));
      assert.equal(groomed(dir), false);
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("board CONTENT with a thrown gate is refused too, and leaks no ticket", async () => {
    const dir = board();
    const { app, base } = await boot(dir, { identity: explodingIdentity() });
    try {
      const r = await fetch(`${base}/`, { headers: { authorization: "Bearer blz_whatever" } });
      assert.equal(r.status, 503);
      assert.doesNotMatch(await r.text(), /SECRETTICKET/);
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("BLZ-359: `sha` reaches git as a commit, never as an option", () => {
  // Security review W4. `sha` came off the wire into an argv with no `--` ahead of it, so
  // a value starting with `-` was parsed by git as an option. No shell, so never RCE —
  // but the endpoint's job is to run git, and this is an attacker choosing its behaviour.
  const nasty = {
    "a long option": "--strategy-option=theirs",
    "a short option": "-n",
    "an option after a valid-looking prefix": "-mHEAD",
    "a refspec, not a sha": "HEAD",
    "a path": "../../etc/passwd",
    "empty": "",
  };

  for (const [label, sha] of Object.entries(nasty)) {
    test(`${label} is refused before git is invoked`, async () => {
      const dir = board();
      const before = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
      const { app, base } = await boot(dir);           // no identities: the OPEN board
      try {
        const r = await ctl(base, "/control/revert", { body: { sha } });
        assert.equal(r.status, 400, `${JSON.stringify(sha)} must not reach git`);
        assert.match((await r.json()).errors[0], /not a commit sha/);
        assert.equal(execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }),
          before, "HEAD must not have moved");
      } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  }

  test("a real sha still reverts — the validation is not a blanket refusal", async () => {
    const dir = board();
    const sha = revertableSha(dir);
    const { app, base } = await boot(dir);
    try {
      assert.equal((await ctl(base, "/control/revert", { body: { sha } })).status, 204);
      assert.equal(reverted(dir), true);
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("an abbreviated sha still reverts", async () => {
    const dir = board();
    const sha = revertableSha(dir).slice(0, 8);
    const { app, base } = await boot(dir);
    try {
      assert.equal((await ctl(base, "/control/revert", { body: { sha } })).status, 204);
      assert.equal(reverted(dir), true);
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("BLZ-359: an unclassified route under the gate fails closed", () => {
  test("an unknown /control/* verb is 404 — not 204, and not the last route's scope", async () => {
    const dir = board();
    const { token } = await addUser(dir, { email: "a@b.c", role: "admin" });
    const { app, base } = await boot(dir);
    try {
      const r = await ctl(base, "/control/groomer/frobnicate", { token: token.token });
      assert.equal(r.status, 404);
      assert.match((await r.json()).errors[0], /unknown endpoint/);
      // A control route reached with the wrong METHOD is unclassified too.
      assert.equal((await fetch(`${base}/control/revert`, bearer(token.token))).status, 404);
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("an /api/* route this server does not implement is 404, never a pass-through", async () => {
    const dir = board();
    const { token } = await addUser(dir, { email: "a@b.c", role: "admin" });
    const { app, base } = await boot(dir);
    try {
      const r = await fetch(`${base}/api/not-a-route`, bearer(token.token));
      assert.equal(r.status, 404);
      assert.match((await r.json()).errors[0], /unknown endpoint/);
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("BLZ-359: the CSRF header is defence-in-depth here too, and is NOT authentication", () => {
  // On a loopback board with no identities the gate asks for nothing — which is the
  // historic behaviour and stays. The vector that leaves open is a page in the
  // operator's own browser POSTing cross-origin to http://localhost:<port>/control/revert:
  // a form post or a no-header fetch is a "simple request", so it is sent without a
  // preflight and the side effect happens. The CSRF token blocks that and the token gate
  // cannot, because there is no token to ask for. It is forgery protection, never a
  // credential — an attacker who can read `window.__csrf` has already read the board.
  test("a control POST without the CSRF header is refused on a board with NO identities", async () => {
    const dir = board();
    const sha = revertableSha(dir);
    const { app, base } = await boot(dir);
    try {
      const r = await ctl(base, "/control/revert", { csrf: false, body: { sha } });
      assert.equal(r.status, 403);
      assert.match((await r.json()).errors[0], /csrf/i);
      assert.equal(reverted(dir), false, "the forged revert must not have run");
      // ...and the same request WITH the header succeeds, so the check discriminates.
      assert.equal((await ctl(base, "/control/revert", { body: { sha } })).status, 204);
      assert.equal(reverted(dir), true);
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("a VALID token without the CSRF header is still refused — the two are not the same check",
    async () => {
      const dir = board();
      const { token } = await addUser(dir, { email: "m@b.c", role: "member" });
      const { app, base } = await boot(dir);
      try {
        const r = await ctl(base, "/control/groomer/stop", { token: token.token, csrf: false });
        assert.equal(r.status, 403);
        assert.match((await r.json()).errors[0], /csrf/i);
      } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
    });

  test("the CSRF header alone is NOT a credential: it never satisfies the gate", async () => {
    const dir = board();
    await addUser(dir, { email: "a@b.c", role: "admin" });
    const { app, base } = await boot(dir);
    try {
      // Everything a browser flow has, and no token: still 401.
      assert.equal((await ctl(base, "/control/groomer/stop", { csrf: true })).status, 401);
    } finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
