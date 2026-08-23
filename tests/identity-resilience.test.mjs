// tests/identity-resilience.test.mjs — BLZ-348 follow-up: the gate must refuse
// requests, never the process.
//
// Security review of PR #96 found the wiring, not the auth logic, was the blocker.
// `serve.mjs` awaited `gate()` at the top of an async request handler with no
// try/catch, and `gate` → `identityStore.authenticate` → `touchToken` performs an
// UPDATE on identity.db on EVERY successful authentication. A failed write there
// became an unhandled rejection and Node exited.
//
// The irony was load-bearing: the POST branch a few lines below already carried a
// comment saying an uncaught throw in this handler "would crash the whole board
// server for every connected session, not just refuse one write" — and the new code
// put an unguarded awaited database WRITE above it.
//
// Two live repros, both in the Dockerfile's own documented deployment:
//   1. `-v <board>:/data:ro` — "attempt to write a readonly database", container dead
//   2. a concurrent `blaze user add` — "database is locked", server dead
//
// Three defences, and each is tested separately because each fails on its own:
//   1. touchToken can never fail a request  (identity-store.mjs)
//   2. gate() throwing is a 503, never a crash  (serve.mjs)
//   3. a concurrent writer waits rather than erroring  (identity-db.mjs busy_timeout)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { identityDdl } from "../scripts/model/identity-schema.mjs";
import { identityStore } from "../scripts/model/identity-store.mjs";
import { identityDbPath, openIdentityDb, loadIdentity } from "../scripts/model/identity-db.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { startServer } from "../scripts/serve.mjs";

function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-resil-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    ["---", "id: OBA-1", "title: t", "type: task", "project: OBA", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  return { root, projects };
}

async function boot(opts) {
  const server = startServer({ port: 0, ...opts });
  await new Promise((res) => server.once("listening", res));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

describe("1. a last-used stamp must never fail the request that earned it", () => {
  test("authenticate succeeds even when touchToken throws", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(identityDdl("sqlite"));
    const exec = {
      run(sql, p = []) {
        // Exactly what a read-only database or a locked one does on the UPDATE.
        if (/^UPDATE api_token SET last_used_at/.test(sql)) {
          throw new Error("attempt to write a readonly database");
        }
        return db.prepare(sql).run(...p);
      },
      all(sql, p = []) { return db.prepare(sql).all(...p); },
    };
    const store = identityStore(exec);
    const user = await store.createUser({ email: "a@b.c", role: "admin" });
    const issued = await store.issueToken({ userId: user.id, name: "t", scopes: ["read"] });

    const r = await store.authenticate({ presented: issued.token, operation: "read" });
    assert.equal(r.ok, true, `a failed last-used stamp must not fail auth: ${r.error}`);
    assert.equal(r.principal.email, "a@b.c");
  });
});

describe("2. gate() throwing is a refusal, not a process exit", () => {
  // The store is injected through startServer's `identity` parameter, so this needs no
  // read-only mount and no lock — it isolates the ONE thing under test: what the request
  // handler does when the gate rejects.
  const explodingIdentity = () => ({
    hasIdentity: true,
    close() {},
    store: { authenticate: async () => { throw new Error("database is locked"); } },
  });

  test("an /api/* request whose gate throws gets 503 and the server survives", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, identity: explodingIdentity() });
    try {
      const r = await fetch(`${base}/api/live`, { headers: { authorization: "Bearer blz_whatever" } });
      assert.equal(r.status, 503);
      assert.match((await r.json()).errors[0], /unavailable/i);

      // The whole point: a second request still gets an answer.
      const again = await fetch(`${base}/api/live`, { headers: { authorization: "Bearer blz_whatever" } });
      assert.equal(again.status, 503, "the server must still be listening");
    } finally { server.close(); }
  });

  test("it FAILS CLOSED — a thrown gate never lets the request through", async () => {
    const { root, projects } = board();
    const { server, base } = await boot({ root, projectsDir: projects, identity: explodingIdentity() });
    try {
      const r = await fetch(`${base}/api/edit`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer blz_whatever" },
        body: JSON.stringify({ id: "OBA-1", patch: { title: "WROTE THROUGH A BROKEN GATE" } }),
      });
      assert.equal(r.status, 503);
      const onDisk = await import("node:fs").then((fs) =>
        fs.readFileSync(join(projects, "OBA", "defined", "OBA-1.md"), "utf8"));
      assert.doesNotMatch(onDisk, /WROTE THROUGH A BROKEN GATE/,
        "a request the gate could not decide must not reach a write");
    } finally { server.close(); }
  });
});

describe("3. a concurrent writer waits rather than killing the request", () => {
  test("an in-flight `blaze user add`-shaped write does not break authentication", async () => {
    const { root, projects } = board();
    const { token } = await addUser(root, { email: "a@b.c", role: "admin" });
    const { server, base } = await boot({ root, projectsDir: projects });

    // The lock holder is a SEPARATE PROCESS, because node:sqlite is synchronous: a
    // holder in this process would block the event loop, its own release timer could
    // never fire, and the test would deadlock until busy_timeout expired. A separate
    // process is also the honest repro — `blaze user add` is a separate process.
    //
    // It releases mid-flight, which is what makes this discriminate FIX 3 rather than
    // fix 1: if the lock were held to the end, busy_timeout would expire, the stamp
    // would throw, and fix 1's catch would return 200 anyway — green for the wrong
    // reason. Releasing part-way means only a connection that WAITED lands the write,
    // so last_used_at is the evidence that it waited.
    const holder = spawn(process.execPath, ["--input-type=module", "-e", `
      import { createRequire } from "node:module";
import { spawn } from "node:child_process";
      const { DatabaseSync } = createRequire(${JSON.stringify(import.meta.url)})("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(identityDbPath(root))});
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO app_user (id,email,display_name,status,created_at) VALUES (?,?,?,'active',?)")
        .run("hog", "hog@x.y", "hog", new Date().toISOString());
      console.log("held");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
      db.exec("ROLLBACK"); db.close();
    `], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((res, rej) => {
      holder.stdout.on("data", (b) => { if (String(b).includes("held")) res(); });
      holder.on("exit", () => rej(new Error("the lock holder exited before taking the lock")));
    });

    try {
      const r = await fetch(`${base}/api/live`, { headers: { authorization: `Bearer ${token.token}` } });
      assert.equal(r.status, 200, "a concurrent writer must not fail an authenticated read");

      const { store, close } = loadIdentity(root);
      const users = await store.listUsers();
      const rows = await store.listTokens(users.find((u) => u.email === "a@b.c").id);
      close();
      assert.notEqual(rows[0].last_used_at, null,
        "the stamp must land after the lock clears — proof the write waited rather than erroring");
    } finally {
      try { holder.kill("SIGKILL"); } catch { /* already gone */ }
      server.close();
    }
  });

  test("a read-only identity database still authenticates", async () => {
    const { root, projects } = board();
    const { token } = await addUser(root, { email: "ro@b.c", role: "admin" });
    chmodSync(identityDbPath(root), 0o444);
    const { server, base } = await boot({ root, projectsDir: projects });
    try {
      const r = await fetch(`${base}/api/live`, { headers: { authorization: `Bearer ${token.token}` } });
      assert.equal(r.status, 200, "a read-only board must still be readable by its users");
    } finally { chmodSync(identityDbPath(root), 0o600); server.close(); }
  });
});

describe("W3. the identity database is not world-readable", () => {
  test("the file is 0600 and its directory 0700", async () => {
    const { root } = board();
    await addUser(root, { email: "p@b.c", role: "admin" });
    const path = identityDbPath(root);
    assert.equal(statSync(path).mode & 0o777, 0o600, "the roster must not be world-readable");
    assert.equal(statSync(join(root, ".blaze")).mode & 0o777, 0o700,
      "a group-writable .blaze/ lets a same-group user REPLACE identity.db");
  });

  test("openIdentityDb tightens an already-loose file rather than trusting it", () => {
    const { root } = board();
    openIdentityDb(root, { create: true }).db.close();
    chmodSync(identityDbPath(root), 0o644);
    openIdentityDb(root, { create: true }).db.close();
    assert.equal(statSync(identityDbPath(root)).mode & 0o777, 0o600);
  });
});
