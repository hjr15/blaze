// tests/serve-api-body.test.mjs — BLZ-729 (spec §7 E3, OD-B5): a remote agent replaces a
// ticket's body, or just its AC section, through `POST /api/body`, and appends one criterion
// through `POST /api/ac/add`. `/api/ac` checks its payload's shape. Each write goes through the
// resolved port and records WHO in the event log; each refusal is a 422 that names no server path
// and writes nothing. Tokens are used only to authenticate: no assertion message quotes one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { openSqliteRead } from "../scripts/model/sqlite-storage.mjs";
import { shadowDbPath, pgExec } from "../scripts/model/write-port-resolve.mjs";
import { ROUTE_SCOPES } from "../scripts/model/serve-auth.mjs";
import { BODY_MAX_BYTES } from "../scripts/model/ticket-body.mjs";
import { createDbSchema } from "../scripts/model/db-schema-version.mjs";
import { identityStore } from "../scripts/model/identity-store.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient, pgEnvFor } from "./helpers/pg-scratch.mjs";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const SCRUB = ["BLAZE_WRITE_PORT", "BLAZE_READONLY", "BLAZE_REMOTE_URL", "BLAZE_TOKEN", "BLAZE_TOKEN_FILE"];

const post = (base, path, body, token) => fetch(`${base}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

/** A db-mode board (SQLite shadow) with a member and a viewer, the server over it, and one
 *  ticket created through `/api/new` (dbBoard seeds ENG-1, so it is the next id). */
async function bodyServer(newExtra = {}) {
  const roots = dbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const member = (await addUser(roots.dataRoot, { email: "m@example.com", role: "member" })).token.token;
  const viewer = (await addUser(roots.dataRoot, { email: "v@example.com", role: "viewer" })).token.token;
  const before = process.env.BLAZE_WRITE_PORT;
  process.env.BLAZE_WRITE_PORT = "db";
  const server = startServer({ port: 0, root: roots.dataRoot, projectsDir: roots.projectsDir });
  await new Promise((res) => server.once("listening", res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = () => {
    server.close();
    if (before === undefined) delete process.env.BLAZE_WRITE_PORT; else process.env.BLAZE_WRITE_PORT = before;
  };
  const made = await post(base, "/api/new", { project: "ENG", type: "task", title: "authored", estimate: 30, ...newExtra }, member);
  const res = await made.json();
  assert.equal(made.status, 200, "the scaffold ticket was created");
  const read = (fn) => {
    const rs = openSqliteRead(shadowDbPath(roots.dataRoot));
    try { return fn(rs); } finally { rs.close(); }
  };
  const bodyOf = (id = res.id) => read((rs) => rs.getTicket(null, id).found.body);
  const events = (id = res.id) => read((rs) => rs.listEvents(null, id));
  return { roots, base, member, viewer, stop, id: res.id, bodyOf, events };
}

const MEMBER_ACTOR = "m@example.com (m@example.com initial token)";

test("BLZ-729: the two routes are classified write", () => {
  assert.equal(ROUTE_SCOPES["POST /api/body"], "write");
  assert.equal(ROUTE_SCOPES["POST /api/ac/add"], "write");
});

test("BLZ-729: /api/body replaces the body and records an edit event", async () => {
  const s = await bodyServer();
  try {
    const before = s.events().length;
    const r = await post(s.base, "/api/body", { id: s.id, body: "## Context\r\n\r\nnew text\r\n\r\n## Acceptance Criteria\r\n\r\n- [ ] a\r\n- [x] b" }, s.member);
    const res = await r.json();
    assert.equal(r.status, 200, JSON.stringify(res));
    const want = "## Context\n\nnew text\n\n## Acceptance Criteria\n\n- [ ] a\n- [x] b\n";
    assert.equal(s.bodyOf(), want);
    assert.deepEqual(res, { ok: true, bodyBytes: Buffer.byteLength(want), acItems: 2 });
    const evs = s.events();
    assert.equal(evs.length, before + 1, "one event for one write");
    const last = evs[evs.length - 1];
    assert.deepEqual([last.kind, last.actor, last.source], ["edit", MEMBER_ACTOR, "api"]);
  } finally { s.stop(); }
});

test("BLZ-729: /api/body with ac only replaces just the AC section", async () => {
  const s = await bodyServer({ body: "## Context\n\nkeep me\n\n## Acceptance Criteria\n\n- [ ] old\n\n## Notes\n\nalso kept\n" });
  try {
    const r = await post(s.base, "/api/body", { id: s.id, ac: ["one", "- [x] two", "three"] }, s.member);
    const res = await r.json();
    assert.equal(r.status, 200, JSON.stringify(res));
    assert.equal(res.acItems, 3);
    const stored = s.bodyOf();
    assert.equal(stored, "## Context\n\nkeep me\n\n## Acceptance Criteria\n\n- [ ] one\n- [x] two\n- [ ] three\n\n## Notes\n\nalso kept\n");
    assert.equal(res.bodyBytes, Buffer.byteLength(stored));
    // Both at once: the given body, then its AC section replaced.
    const both = await post(s.base, "/api/body", { id: s.id, body: "## Context\n\nfresh\n", ac: ["x"] }, s.member);
    assert.equal(both.status, 200);
    assert.equal(s.bodyOf(), "## Context\n\nfresh\n\n## Acceptance Criteria\n\n- [ ] x\n");
  } finally { s.stop(); }
});

test("BLZ-729: /api/body refuses a body that fails validateTicket", async () => {
  const s = await bodyServer();
  try {
    const kept = s.bodyOf();
    const n = s.events().length;
    for (const [payload, why] of [
      [{ id: s.id, body: "\n" }, /body must not be blank/],
      [{ id: s.id }, /give body, ac, or both/],
      [{ id: s.id, body: null, ac: null }, /give body, ac, or both/],
      [{ id: s.id, body: 7 }, /body must be a string/],
      [{ id: s.id, body: "a\0b" }, /body must not contain a NUL byte/],
      [{ id: s.id, ac: ["a\0b"] }, /ac item 1 must not contain a NUL byte/],
      [{ id: s.id, ac: ["a\r\nb"] }, /ac item 1 spans more than one line/],
      [{ id: s.id, ac: [] }, /ac takes 1 to 100 items/],
      [{ body: "x" }, /id must be a non-empty string/],
      [{ id: "", body: "x" }, /id must be a non-empty string/],
      [null, /id must be a non-empty string/],
    ]) {
      const r = await post(s.base, "/api/body", payload, s.member);
      assert.equal(r.status, 422, JSON.stringify(payload));
      assert.match((await r.json()).errors.join(" "), why);
    }
    assert.equal(s.bodyOf(), kept, "no refusal wrote");
    assert.equal(s.events().length, n, "no refusal recorded an event");
  } finally { s.stop(); }
});

test("BLZ-729: /api/body refuses a composed body over the byte cap, before any write", async () => {
  const s = await bodyServer();
  try {
    const kept = s.bodyOf();
    const n = s.events().length;
    // Each part is within its own limit; together they are not.
    const body = `## Context\n\n${"b".repeat(BODY_MAX_BYTES - 100)}\n`;
    const r = await post(s.base, "/api/body", { id: s.id, body, ac: ["y".repeat(2000)] }, s.member);
    assert.equal(r.status, 422);
    assert.match((await r.json()).errors.join(" "), new RegExp(`the stored body would be \\d+ bytes; the limit is ${BODY_MAX_BYTES}`));
    assert.equal(s.bodyOf(), kept, "nothing written");
    assert.equal(s.events().length, n);
    // The same body alone is under the cap and is stored.
    assert.equal((await post(s.base, "/api/body", { id: s.id, body }, s.member)).status, 200);
  } finally { s.stop(); }
});

test("BLZ-729: /api/ac/add appends and toggle checks it", async () => {
  const s = await bodyServer();
  try {
    const n = s.events().length;
    const r = await post(s.base, "/api/ac/add", { id: s.id, text: "ship it" }, s.member);
    const res = await r.json();
    assert.equal(r.status, 200, JSON.stringify(res));
    assert.deepEqual(res, { ok: true, index: 0, acItems: 1 }, "the scaffold's empty box is replaced");
    assert.match(s.bodyOf(), /^- \[ \] ship it$/m);
    const evs = s.events();
    assert.equal(evs.length, n + 1);
    assert.deepEqual([evs.at(-1).kind, evs.at(-1).actor], ["edit", MEMBER_ACTOR]);
    const second = await (await post(s.base, "/api/ac/add", { id: s.id, text: "- [ ] then this" }, s.member)).json();
    assert.deepEqual(second, { ok: true, index: 1, acItems: 2 });
    const t = await post(s.base, "/api/ac", { id: s.id, index: 0, checked: true }, s.member);
    const tres = await t.json();
    assert.equal(t.status, 200, JSON.stringify(tres));
    assert.equal(tres.acItems, 2);
    assert.match(s.bodyOf(), /^- \[x\] ship it$/m);
    assert.match(s.bodyOf(), /^- \[ \] then this$/m);
    for (const [payload, why] of [
      [{ id: s.id, text: " " }, /ac item 1 is blank/],
      [{ id: s.id, text: "a\nb" }, /ac item 1 spans more than one line/],
      [{ id: s.id, text: "a\0b" }, /ac item 1 must not contain a NUL byte/],
      [{ id: s.id, text: 5 }, /text must be a string/],
      [{ id: s.id }, /text must be a string/],
      [{ text: "x" }, /id must be a non-empty string/],
    ]) {
      const bad = await post(s.base, "/api/ac/add", payload, s.member);
      assert.equal(bad.status, 422, JSON.stringify(payload));
      assert.match((await bad.json()).errors.join(" "), why);
    }
  } finally { s.stop(); }
});

test("BLZ-729: /api/ac/add refuses an append that takes the body over the byte cap", async () => {
  const s = await bodyServer();
  try {
    const big = `## Acceptance Criteria\n\n- [ ] first\n\n## Notes\n\n${"n".repeat(BODY_MAX_BYTES - 1000)}\n`;
    assert.equal((await post(s.base, "/api/body", { id: s.id, body: big }, s.member)).status, 200);
    const kept = s.bodyOf();
    const n = s.events().length;
    const r = await post(s.base, "/api/ac/add", { id: s.id, text: "z".repeat(2000) }, s.member);
    assert.equal(r.status, 422);
    assert.match((await r.json()).errors.join(" "), new RegExp(`the stored body would be \\d+ bytes; the limit is ${BODY_MAX_BYTES}`));
    assert.equal(s.bodyOf(), kept, "nothing written");
    assert.equal(s.events().length, n);
    // A short item still fits.
    assert.equal((await post(s.base, "/api/ac/add", { id: s.id, text: "small" }, s.member)).status, 200);
  } finally { s.stop(); }
});

test("BLZ-729: /api/ac refuses a malformed index or checked", async () => {
  const s = await bodyServer();
  try {
    const kept = s.bodyOf();
    for (const [payload, why] of [
      [{ id: s.id, index: "0", checked: true }, /index must be a non-negative integer/],
      [{ id: s.id, index: -1, checked: true }, /index must be a non-negative integer/],
      [{ id: s.id, index: 0.5, checked: true }, /index must be a non-negative integer/],
      [{ id: s.id, checked: true }, /index must be a non-negative integer/],
      [{ id: s.id, index: 0, checked: "yes" }, /checked must be true or false/],
      [{ id: s.id, index: 0 }, /checked must be true or false/],
    ]) {
      const r = await post(s.base, "/api/ac", payload, s.member);
      assert.equal(r.status, 422, JSON.stringify(payload));
      assert.match((await r.json()).errors.join(" "), why);
    }
    assert.equal(s.bodyOf(), kept);
  } finally { s.stop(); }
});

test("BLZ-729: a viewer is 403 on both routes; no token is 401", async () => {
  const s = await bodyServer();
  try {
    const kept = s.bodyOf();
    for (const [path, payload] of [["/api/body", { id: s.id, body: "## Context\n\nnope\n" }],
                                   ["/api/ac/add", { id: s.id, text: "nope" }]]) {
      assert.equal((await post(s.base, path, payload)).status, 401, path);
      const v = await post(s.base, path, payload, s.viewer);
      assert.equal(v.status, 403, path);
      assert.match((await v.json()).errors[0], /does not carry the 'write' scope/);
    }
    assert.equal(s.bodyOf(), kept, "nothing written");
  } finally { s.stop(); }
});

test("BLZ-729: no answer contains a server path", async () => {
  const s = await bodyServer();
  try {
    for (const [path, payload] of [["/api/body", { id: "ENG-999", body: "x" }],
                                   ["/api/ac/add", { id: "ENG-999", text: "x" }]]) {
      const r = await post(s.base, path, payload, s.member);
      assert.equal(r.status, 422, path);
      const text = await r.text();
      assert.ok(text.includes("ticket not found: ENG-999"), path);
      assert.equal(text.includes(s.roots.projectsDir), false, `${path} names no server path`);
      assert.equal(text.includes(s.roots.dataRoot), false, `${path} names no server path`);
    }
  } finally { s.stop(); }
  // On a file board an id held by two files is refused with both FILE PATHS in the verb's
  // message; the answer carries them relative to `projects/`, never the server's absolute path.
  const roots = dbBoard();
  const dup = readFileSync(join(roots.projectsDir, "ENG", "defined", "ENG-1-a.md"), "utf8");
  mkdirSync(join(roots.projectsDir, "ENG", "in-progress"), { recursive: true });
  writeFileSync(join(roots.projectsDir, "ENG", "in-progress", "ENG-1-a.md"), dup);
  const member = (await addUser(roots.dataRoot, { email: "m@example.com", role: "member" })).token.token;
  const before = process.env.BLAZE_WRITE_PORT;
  delete process.env.BLAZE_WRITE_PORT;
  const server = startServer({ port: 0, root: roots.dataRoot, projectsDir: roots.projectsDir });
  try {
    await new Promise((res) => server.once("listening", res));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [path, payload] of [["/api/body", { id: "ENG-1", body: "x" }],
                                   ["/api/ac/add", { id: "ENG-1", text: "x" }]]) {
      const r = await post(base, path, payload, member);
      assert.equal(r.status, 422, path);
      const text = await r.text();
      assert.ok(text.includes("ENG-1 resolves to 2 files"), path);
      assert.ok(text.includes("projects/ENG/in-progress/ENG-1-a.md"), `${path} keeps the relative path`);
      assert.equal(text.includes(roots.projectsDir), false, `${path} names no server path`);
    }
  } finally {
    server.close();
    if (before !== undefined) process.env.BLAZE_WRITE_PORT = before;
  }
});

function childEnv(extra) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  return { ...env, ...extra };
}

test("BLZ-729 (pg): body and AC round-trip on a Postgres board", PG_SKIP, async () => {
  const db = await scratchPgDb("blz729_body");
  let child;
  try {
    const { dataRoot, projectsDir } = dbBoard();
    const cfgPath = join(dataRoot, "blaze.config.json");
    writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, "utf8")), database: { driver: "postgres" } }));
    const c = await pgClient(db.url);
    let token;
    try {
      await createDbSchema(pgExec(c), { dialect: "postgres" });
      const store = identityStore(pgExec(c), { dialect: "postgres" });
      const user = await store.createUser({ email: "m@example.com", role: "member" });
      ({ token } = await store.issueToken({ userId: user.id, name: "t", scopes: ["read", "write"] }));
    } finally { await c.end(); }
    child = spawn(process.execPath, [join(SCRIPTS, "serve.mjs")], {
      env: childEnv({ BLAZE_PROJECTS_DIR: projectsDir, BLAZE_WRITE_PORT: "db", PORT: "0", HOST: "127.0.0.1", ...pgEnvFor(db.url) }),
    });
    const port = await new Promise((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
        const m = out.match(/board → http:\/\/localhost:(\d+)/);
        if (m) resolve(Number(m[1]));
      });
      child.stderr.resume();
      // The exit code only: the child's output is never quoted into a failure message.
      child.on("exit", (code) => reject(new Error(`serve.mjs exited ${code} before listening`)));
    });
    const base = `http://127.0.0.1:${port}`;
    const made = await post(base, "/api/new", { project: "ENG", type: "task", title: "pg body", estimate: 30,
                                                body: "## Context\n\nfrom postgres\n" }, token);
    const res = await made.json();
    assert.equal(made.status, 200, "created");
    const b = await post(base, "/api/body", { id: res.id, ac: ["round", "trip"] }, token);
    assert.equal(b.status, 200, "body replaced");
    assert.deepEqual((await b.json()).acItems, 2);
    const add = await post(base, "/api/ac/add", { id: res.id, text: "third" }, token);
    assert.deepEqual(await add.json(), { ok: true, index: 2, acItems: 3 });
    const got = await fetch(`${base}/api/ticket?id=${res.id}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(got.status, 200);
    assert.equal((await got.json()).ticket.body,
      "## Context\n\nfrom postgres\n\n## Acceptance Criteria\n\n- [ ] round\n- [ ] trip\n- [ ] third\n");
  } finally { child?.kill(); await db.drop(); }
});
