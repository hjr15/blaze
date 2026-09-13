// tests/supervisor-signin.test.mjs — BLZ-566, the OTHER HTTP server, again.
//
// BLZ-359 already learned this lesson once: `blaze board` and `blaze start` are two
// separate servers, and a control wired into one of them is absent from the other. Both
// gate `/` and `/view/<name>` through the same `pageScopeFor`, so BOTH had the identical
// browser lockout — and `blaze start` is the DEFAULT command, so it is the one an
// operator is more likely to be looking at when they find they cannot get in.
//
// `handleSigninRoutes` is therefore mounted in both. These tests are what stops the fix
// existing in one server and not the other; each one fails on a `supervisor.mjs` that
// does not mount it.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../scripts/config.mjs";
import { createApp } from "../scripts/supervisor.mjs";
import { CSRF } from "../scripts/views/page.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { loadIdentity } from "../scripts/model/identity-db.mjs";
import { SESSION_COOKIE } from "../scripts/model/serve-auth.mjs";
import { FREE_ATTEMPTS } from "../scripts/model/rate-limit.mjs";

const PASSWORD = "correct horse battery staple";
const dirs = [];

function board() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-supervisor-signin-"));
  dirs.push(dir);
  mkdirSync(join(dir, "backlog"), { recursive: true });
  mkdirSync(join(dir, "projects", "TASK", "defined"), { recursive: true });
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({ key: "TASK" }));
  writeFileSync(join(dir, "projects", "TASK", "defined", "TASK-002-secret.md"),
    ["---", "id: TASK-002", "title: SECRETTICKET", "type: task", "project: TASK",
     "priority: medium", "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01",
     "---", "", "## Acceptance Criteria", "", "- [ ] one", ""].join("\n"));
  for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                   ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
    execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  }
  return dir;
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const VIEWER_PASSWORD = "viewer viewer viewer viewer";

async function app({ withUser = true, countSignIns = false, withViewer = false } = {}) {
  const root = board();
  if (withUser) {
    await addUser(root, { email: "op@example.com", role: "admin" });
    if (withViewer) await addUser(root, { email: "eve@example.com", role: "viewer" });
    const id = loadIdentity(root);
    await id.store.setPassword({ email: "op@example.com", password: PASSWORD });
    if (withViewer) await id.store.setPassword({ email: "eve@example.com", password: VIEWER_PASSWORD });
    id.close();
  }
  // BLZ-571. `counted.signIns` is how the concurrency test below observes the KDF itself
  // rather than the status codes in front of it. MEASURED ON THIS SERVER, not inferred
  // from the other one: supervisor.mjs mounts `handleSigninRoutes` verbatim, which is a
  // reason to expect the same behaviour and not a reason to skip looking.
  const counted = { signIns: 0 };
  let identity;
  if (countSignIns) {
    const real = loadIdentity(root);
    identity = { ...real, close: () => real.close(), store: new Proxy(real.store, {
      get(target, prop, recv) {
        if (prop !== "signIn") return Reflect.get(target, prop, recv);
        return async (...args) => { counted.signIns += 1; return target.signIn(...args); };
      },
    }) };
  }
  const a = createApp(loadConfig({ root }), identity ? { root, identity } : { root });
  await new Promise((res) => a.server.listen(0, "127.0.0.1", res));
  return { root, a, counted, base: `http://127.0.0.1:${a.server.address().port}` };
}

const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", "x-blaze-csrf": CSRF, ...headers },
    body: JSON.stringify(body) });

describe("`blaze start` has the same door as `blaze board`", () => {
  test("an unauthenticated browser is sent to /signin", async () => {
    const { a, base } = await app();
    try {
      const r = await fetch(`${base}/`, { redirect: "manual", headers: { accept: "text/html" } });
      assert.equal(r.status, 302);
      assert.equal(r.headers.get("location"), "/signin");
      assert.doesNotMatch(await r.text(), /SECRETTICKET/);
    } finally { a.server.close(); }
  });

  test("signing in there opens the board, the views and the control strip", async () => {
    const { a, base } = await app();
    try {
      const r = await post(base, "/signin", { email: "op@example.com", password: PASSWORD });
      assert.equal(r.status, 200);
      const cookie = r.headers.getSetCookie()
        .find((c) => c.startsWith(`${SESSION_COOKIE}=`)).split(";")[0];

      assert.equal((await fetch(`${base}/`, { headers: { cookie } })).status, 200);
      assert.equal((await fetch(`${base}/view/board`, { headers: { cookie } })).status, 200);
      assert.equal((await fetch(`${base}/api/hash`, { headers: { cookie } })).status, 200);
    } finally { a.server.close(); }
  });

  test("a cookie does NOT open /control/* without the CSRF header", async () => {
    const { a, base } = await app();
    try {
      const cookie = (await post(base, "/signin", { email: "op@example.com", password: PASSWORD }))
        .headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)).split(";")[0];
      const r = await fetch(`${base}/control/groomer/stop`, { method: "POST", headers: { cookie } });
      assert.equal(r.status, 403, "/control/revert shells out to `git revert` — the CSRF "
        + "check is the control that covers an ambient credential here");
    } finally { a.server.close(); }
  });

  test("an unclassified /control/* route is STILL 404 with a valid session", async () => {
    const { a, base } = await app();
    try {
      const cookie = (await post(base, "/signin", { email: "op@example.com", password: PASSWORD }))
        .headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)).split(";")[0];
      const r = await post(base, "/control/invented", {}, { cookie });
      assert.equal(r.status, 404);
    } finally { a.server.close(); }
  });

  test("with no users configured there is no /signin on this server either", async () => {
    const { a, base } = await app({ withUser: false });
    try {
      assert.equal((await fetch(`${base}/signin`)).status, 404);
    } finally { a.server.close(); }
  });

  test("BLZ-571: a burst of failures is throttled on THIS server too", async () => {
    // BLZ-359's lesson for the third time. The limiter is constructed per server, so a
    // limiter wired into serve.mjs alone would leave `blaze start` — the DEFAULT command
    // — with the unthrottled door this ticket exists to close, and every test in
    // signin-rate-limit.test.mjs would still pass.
    const { a, base } = await app();
    try {
      let throttled = null;
      for (let n = 0; n < FREE_ATTEMPTS + 3 && !throttled; n++) {
        const r = await post(base, "/signin", { email: "op@example.com", password: "nope nope nope" });
        if (r.status === 429) throttled = r;
      }
      assert.ok(throttled, `no attempt was throttled within ${FREE_ATTEMPTS + 3} tries`);
      assert.match(String(throttled.headers.get("retry-after")), /^\d+$/);
      // Backoff, not lockout: it says when to come back, and the door is still servable.
      assert.equal((await fetch(`${base}/signin`)).status, 200);
    } finally { a.server.close(); }
  });

  test("BLZ-571: CONCURRENT failures are throttled on THIS server too, not just sequential ones",
    async () => {
      // MEASURED, NOT INFERRED. The blocking finding against the first version of this
      // ticket was that the limit counted only attempts that waited their turn: 40
      // sequential attempts cost the KDF 5 invocations, while 200 concurrent ones cost it
      // 200 on this server (170 on `blaze board`) — and sustained, three bursts of 150
      // reached it 419 times in 67 seconds against an intended 8. The reviewer verified
      // serve.mjs only; this test is why "supervisor mounts the same handler, so it is
      // probably fine" is not an answer.
      const { a, base, counted } = await app({ countSignIns: true });
      try {
        const N = FREE_ATTEMPTS + 25;
        const codes = await Promise.all(Array.from({ length: N }, () =>
          post(base, "/signin", { email: "op@example.com", password: "nope nope nope" })
            .then((r) => r.status)));
        assert.equal(counted.signIns, FREE_ATTEMPTS,
          `${counted.signIns} of ${N} concurrent attempts reached the password verifier, `
          + `not ${FREE_ATTEMPTS} — the limit counts only attackers polite enough to wait `
          + "their turn, so scrypt is still the only friction for everyone else");
        assert.ok(codes.includes(429),
          "not one concurrent attempt was refused, so nothing was limited at all");
      } finally { a.server.close(); }
    });

  test("BLZ-571: a valid viewer cannot brute-force the admin from one address on THIS server either",
    async () => {
      // The refund-per-account fix on the OTHER server. supervisor.mjs shares the handler,
      // and the re-review measured 40 admin guesses here too, so it is measured here too.
      const { a, base, counted } = await app({ countSignIns: true, withViewer: true });
      try {
        let adminGuessesAtKdf = 0;
        for (let round = 0; round < 4; round++) {
          for (let g = 0; g <= FREE_ATTEMPTS; g++) {
            const before = counted.signIns;
            const r = await post(base, "/signin", { email: "op@example.com", password: "nope nope nope nope" });
            if (counted.signIns > before) adminGuessesAtKdf += 1;
            if (r.status === 429) break;
          }
          const v = await post(base, "/signin", { email: "eve@example.com", password: VIEWER_PASSWORD });
          assert.equal(v.status, 200, "the viewer's own password must still work");
        }
        assert.ok(adminGuessesAtKdf <= FREE_ATTEMPTS,
          `${adminGuessesAtKdf} admin guesses reached the KDF despite viewer sign-ins between rounds`);
      } finally { a.server.close(); }
    });

  test("a wrong password is refused identically here too", async () => {
    const { a, base } = await app();
    try {
      const wrong = await post(base, "/signin", { email: "op@example.com", password: "nope nope nope" });
      const unknown = await post(base, "/signin", { email: "ghost@example.com", password: PASSWORD });
      assert.equal(wrong.status, 401);
      assert.deepEqual(await unknown.json(), await wrong.json());
    } finally { a.server.close(); }
  });
});
