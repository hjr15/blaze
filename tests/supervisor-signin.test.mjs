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

async function app({ withUser = true } = {}) {
  const root = board();
  if (withUser) {
    await addUser(root, { email: "op@example.com", role: "admin" });
    const id = loadIdentity(root);
    await id.store.setPassword({ email: "op@example.com", password: PASSWORD });
    id.close();
  }
  const a = createApp(loadConfig({ root }), { root });
  await new Promise((res) => a.server.listen(0, "127.0.0.1", res));
  return { root, a, base: `http://127.0.0.1:${a.server.address().port}` };
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
