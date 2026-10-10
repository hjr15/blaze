// tests/concurrency-proof.test.mjs — BLZ-684: the two-machine proof (spec §6 and §7 step 3).
//
// The Postgres test is spec §6's: two PROCESSES each fire 50 `POST /api/new` in parallel at one
// db-mode server, and the result is 100 distinct ids, 100 rows, and no gap the counter did not
// skip. The rest pins `scripts/ops/concurrency-proof.mjs` — the harness the operator runs on two
// real machines — against a filesystem board, so it is covered without a database.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { remoteFrom, requestRemote } from "../scripts/remote-client.mjs";
import { createMany, verifyLists, main } from "../scripts/ops/concurrency-proof.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";
import { QUIET } from "./helpers/db-board.mjs";
import { PG, PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";

const scratch = scratchRegistry();
const PROOF = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ops", "concurrency-proof.mjs");

function gitBoard() {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz684-proof-")));
  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"]]) {
    execFileSync("git", ["-C", root, ...a]);
  }
  mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["ENG"] }));
  writeFileSync(join(root, "projects", "ENG", "defined", "ENG-1-one.md"),
    ["---", "id: ENG-1", "title: one", "type: task", "project: ENG", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}
async function serve(root) {
  const server = startServer({ port: 0, root, projectsDir: join(root, "projects") });
  await new Promise((res) => server.once("listening", res));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const capture = () => {
  const out = [], err = [];
  return { out, err, io: { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) } };
};
/** The harness as a real process — async, so an in-process server can answer it. */
function proof(args, env) {
  return new Promise((resolve) => {
    const base = { ...process.env };
    for (const k of ["BLAZE_WRITE_PORT", "BLAZE_READONLY"]) delete base[k];
    const p = spawn(process.execPath, [PROOF, ...args], { env: { ...base, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
const num = (id) => Number(id.split("-").pop());

describe("the harness, against a filesystem board", () => {
  test("createMany creates distinct tickets in parallel; verifyLists passes them", async () => {
    const root = gitBoard();
    const { token } = await addUser(root, { email: "m@example.com", role: "member" });
    const { server, url } = await serve(root);
    try {
      const cfg = remoteFrom({ BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token.token });
      const r = await createMany(cfg, { project: "ENG", count: 4, parallel: 2, label: "t" });
      assert.deepEqual(r.failures, []);
      assert.deepEqual(r.ids.map(num).sort((a, b) => a - b), [2, 3, 4, 5]);
      assert.deepEqual(await verifyLists(cfg, [r.ids.slice(0, 2), r.ids.slice(2)]),
        { ok: true, total: 4, distinct: 4, duplicates: [], missing: [] });
    } finally { server.close(); }
  });

  test("verifyLists FAILS a duplicate across lists, an id the server lacks, and an empty set", async () => {
    const root = gitBoard();
    const { token } = await addUser(root, { email: "m@example.com", role: "member" });
    const { server, url } = await serve(root);
    try {
      const cfg = remoteFrom({ BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token.token });
      assert.deepEqual(await verifyLists(cfg, [["ENG-1"], ["ENG-1", "ENG-99"]]),
        { ok: false, total: 3, distinct: 2, duplicates: ["ENG-1"], missing: ["ENG-99"] });
      assert.equal((await verifyLists(cfg, [[], []])).ok, false, "a proof that created nothing proves nothing");
    } finally { server.close(); }
  });

  test("a refused create is counted as a failure, not an id; the run exits 1", async () => {
    const root = gitBoard();
    const { token } = await addUser(root, { email: "v@example.com", role: "viewer" });
    const { server, url } = await serve(root);
    try {
      const c = capture();
      const code = await main(["create", "--project", "ENG", "--count", "2"],
        { env: { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token.token }, ...c.io });
      assert.equal(code, 1);
      const printed = JSON.parse(c.out[0]);
      assert.deepEqual(printed.ids, []);
      assert.equal(printed.failures.length, 2);
      assert.match(c.err.join("\n"), /failed \(403\): this token does not carry the 'write' scope/);
    } finally { server.close(); }
  });

  test("main: create prints JSON a later verify reads; bad arguments print the usage", async () => {
    const root = gitBoard();
    const { token } = await addUser(root, { email: "m@example.com", role: "member" });
    const { server, url } = await serve(root);
    try {
      const env = { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token.token };
      const made = capture();
      assert.equal(await main(["create", "--project", "ENG", "--count", "3", "--label", "m1"], { env, ...made.io }), 0);
      const file = join(root, "m1.json");
      writeFileSync(file, made.out[0]);
      const v = capture();
      assert.equal(await main(["verify", file], { env, ...v.io }), 0);
      assert.match(v.out.join("\n"), /3 ids from 1 list\(s\): 3 distinct, 0 duplicated, 0 not on the server[\s\S]*PROOF: PASS/);
      for (const argv of [["create", "--count", "3"], ["create", "--project", "ENG", "--count", "0"],
                          ["create", "--project"], ["create", "--bogus", "1"], ["verify"], ["nonsense"]]) {
        const c = capture();
        assert.equal(await main(argv, { env, ...c.io }), 1, argv.join(" "));
        assert.match(c.err.join("\n"), /usage: node scripts\/ops\/concurrency-proof\.mjs/);
      }
      const unread = capture();
      assert.equal(await main(["verify", join(root, "absent.json")], { env, ...unread.io }), 1);
      assert.match(unread.err.join("\n"), /cannot read/);
      writeFileSync(join(root, "bad.json"), "{}");
      const bad = capture();
      assert.equal(await main(["verify", join(root, "bad.json")], { env, ...bad.io }), 1);
      assert.match(bad.err.join("\n"), /holds no "ids" list/);
      const local = capture();
      assert.equal(await main(["verify", file], { env: {}, ...local.io }), 1);
      assert.match(local.err.join("\n"), /remote mode is not configured/);
    } finally { server.close(); }
  });

  test("requestRemote never builds a URL off the configured origin", async () => {
    const cfg = remoteFrom({ BLAZE_REMOTE_URL: "http://127.0.0.1:9", BLAZE_TOKEN: "blz_t" });
    let called = false;
    await assert.rejects(requestRemote(cfg, "GET", "//evil.example/api/x", undefined,
      { fetch: async () => { called = true; } }), /refusing to send the token to http:\/\/evil\.example/);
    assert.equal(called, false);
  });
});

test("spec §6: 2 processes × 50 parallel POST /api/new on Postgres → 100 distinct ids, 100 rows, no gaps",
  PG_SKIP, async () => {
    const db = await scratchPgDb("proof");
    const root = scratch(mkdtempSync(join(tmpdir(), "blz684-pgproof-")));
    mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
    writeFileSync(join(root, "blaze.config.json"),
      JSON.stringify({ projects: ["ENG"], database: { driver: "postgres" } }));
    writeFileSync(join(root, "projects", "ENG", "defined", "ENG-1-one.md"),
      ["---", "id: ENG-1", "title: one", "type: task", "project: ENG", "estimate: 30",
       "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
    const u = new URL(PG);
    const dbEnv = { BLAZE_DB_HOST: u.hostname, BLAZE_DB_PORT: u.port || "5432", BLAZE_DB_NAME: db.name,
                    BLAZE_DB_USER: decodeURIComponent(u.username), BLAZE_DB_PASSWORD_ENV: "BLZ684_TEST_PGPW",
                    BLZ684_TEST_PGPW: decodeURIComponent(u.password), BLAZE_WRITE_PORT: "db" };
    const saved = Object.fromEntries(Object.keys(dbEnv).map((k) => [k, process.env[k]]));
    Object.assign(process.env, dbEnv);
    const roots = { dataRoot: root, projectsDir: join(root, "projects") };
    let server;
    try {
      assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
      assert.equal(await runDb(["load"], { ...QUIET, roots }), 0);
      const { token } = await addUser(root, { email: "m@example.com", role: "member" });
      ({ server } = await serve(root));
      const remote = { BLAZE_REMOTE_URL: `http://127.0.0.1:${server.address().port}`, BLAZE_TOKEN: token.token };
      const [a, b] = await Promise.all(["a", "b"].map((label) =>
        proof(["create", "--project", "ENG", "--count", "50", "--parallel", "5", "--label", label], remote)));
      assert.equal(a.status, 0, a.stderr);
      assert.equal(b.status, 0, b.stderr);
      const ids = [...JSON.parse(a.stdout).ids, ...JSON.parse(b.stdout).ids];
      assert.equal(ids.length, 100);
      assert.equal(new Set(ids).size, 100, "100 distinct ids");
      assert.deepEqual(ids.map(num).sort((x, y) => x - y), Array.from({ length: 100 }, (_, i) => i + 2),
        "ENG-2..ENG-101: no gap the counter did not skip");
      const c = await pgClient(db.url);
      try {
        assert.equal(Number((await c.query("SELECT count(*) AS n FROM ticket WHERE project_key = 'ENG'")).rows[0].n), 101);
        assert.equal(Number((await c.query("SELECT n FROM project_counter WHERE project_key = 'ENG'")).rows[0].n), 101);
      } finally { await c.end(); }
      // …and the operator's verify step agrees, over the API.
      writeFileSync(join(root, "a.json"), a.stdout);
      writeFileSync(join(root, "b.json"), b.stdout);
      const v = await proof(["verify", join(root, "a.json"), join(root, "b.json")], remote);
      assert.equal(v.status, 0, v.stdout + v.stderr);
      assert.match(v.stdout, /100 ids from 2 list\(s\): 100 distinct[\s\S]*PROOF: PASS/);
    } finally {
      server?.close();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await db.drop();
    }
  });
