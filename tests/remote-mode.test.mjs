// tests/remote-mode.test.mjs — BLZ-684 (spec §5.4): `blaze` in remote mode.
//
// With BLAZE_REMOTE_URL + BLAZE_TOKEN set, the six ticket verbs go to the board server over
// HTTP; every other command is refused; half-set is an error. The security half is pinned as
// carefully as the happy path: the token is only ever sent to BLAZE_REMOTE_URL's origin — not
// over plain http to a non-loopback host, not to a URL with a path, and not after a redirect.
// The CLI test is end to end: a real `blaze` process against a real server on an ephemeral port.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { startServer } from "../scripts/serve.mjs";
import { roundEstimate } from "../scripts/model/time.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { remoteFrom, requestFor, runRemote, REMOTE_VERBS } from "../scripts/remote-client.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { openSqliteRead } from "../scripts/model/sqlite-storage.mjs";
import { shadowDbPath } from "../scripts/model/write-port-resolve.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";

const scratch = scratchRegistry();
// `POST /api/new` is db-mode only (final review), so the servers below run the db write port.
// This file is its own process; the `blaze()` helper strips the variable from the CLI's env.
process.env.BLAZE_WRITE_PORT = "db";
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cli.mjs");

describe("remoteFrom — when remote mode is on, and when it refuses", () => {
  const env = (url, token) => ({ BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token });
  test("neither set: local; both set: remote, to the origin only", () => {
    assert.deepEqual(remoteFrom({}), { remote: false });
    assert.deepEqual(remoteFrom(env("", "")), { remote: false });
    assert.deepEqual(remoteFrom(env("https://blaze.example.com", "blz_t")),
                     { remote: true, origin: "https://blaze.example.com", token: "blz_t" });
    assert.deepEqual(remoteFrom(env("https://blaze.example.com/", "blz_t")).origin, "https://blaze.example.com");
    assert.deepEqual(remoteFrom(env("http://127.0.0.1:4321", "blz_t")).origin, "http://127.0.0.1:4321");
    assert.deepEqual(remoteFrom(env("http://localhost:4321", "blz_t")).origin, "http://localhost:4321");
  });
  test("half-set is an error naming both variables — never a fallback to local", () => {
    for (const e of [env("https://blaze.example.com", ""), env("", "blz_t"), { BLAZE_TOKEN: "blz_t" }]) {
      assert.match(remoteFrom(e).error, /needs both BLAZE_REMOTE_URL and BLAZE_TOKEN.*Refusing rather than writing to a local board/);
    }
  });
  test("a URL that could send the token anywhere else is refused", () => {
    for (const [url, why] of [
      ["http://blaze.example.com", /plain http to blaze\.example\.com/],
      ["ftp://blaze.example.com", /must be an https:\/\/ URL/],
      ["https://user:pw@blaze.example.com", /must not carry a user:password@/],
      ["https://blaze.example.com/board", /origin only/],
      ["https://blaze.example.com/?x=1", /origin only/],
      ["not a url", /is not a URL/],
    ]) {
      const r = remoteFrom(env(url, "blz_secret"));
      assert.match(r.error, why, url);
      assert.doesNotMatch(r.error, /blz_secret/, "a refusal never prints the token");
    }
    assert.match(remoteFrom(env("https://blaze.example.com", "blz a")).error, /whitespace/);
  });
  test("BLZ-691: plain http is accepted for 127.x, [::1] and localhost — and refused for the spellings URL rewrites", () => {
    assert.equal(remoteFrom(env("http://[::1]:4321", "blz_t")).origin, "http://[::1]:4321");
    assert.equal(remoteFrom(env("http://127.9.9.9:4321", "blz_t")).origin, "http://127.9.9.9:4321");
    // `new URL` normalises [::ffff:127.0.0.1] to [::ffff:7f00:1], and keeps the trailing dot
    // of `localhost.`: neither is on the accepted list, so both are refused. That is the safe
    // direction (the token is not sent), and the docs name the three accepted forms.
    for (const url of ["http://[::ffff:127.0.0.1]:4321", "http://localhost.:4321"]) {
      assert.match(remoteFrom(env(url, "blz_t")).error, /plain http to/, url);
    }
  });
});

describe("requestFor — argv parsed as the local runner parses it", () => {
  test("each verb maps to its endpoint and body", () => {
    // BLZ-709: a write is a POST with `read: false`; the reads are pinned in remote-reads.test.mjs.
    const POST = { method: "POST", read: false, json: false };
    assert.deepEqual(requestFor("new", ["--project", "ENG", "--type", "task", "Do", "it", "--estimate", "30",
                                        "--labels", "a,b", "--parent", "ENG-1", "--not-before", "2026-11-01"]),
      { ...POST, path: "/api/new", body: { project: "ENG", type: "task", estimate: 30, labels: ["a", "b"],
                                           parent: "ENG-1", not_before: "2026-11-01", title: "Do it" } });
    assert.deepEqual(requestFor("move", ["ENG-1", "done"]), { ...POST, path: "/api/move", body: { id: "ENG-1", to: "done" } });
    assert.deepEqual(requestFor("edit", ["ENG-1", "title", "a", "--b"]),
                     { ...POST, path: "/api/edit", body: { id: "ENG-1", patch: { title: "a --b" } } });
    assert.deepEqual(requestFor("resolve", ["ENG-1", "wont-do"]),
                     { ...POST, path: "/api/resolve", body: { id: "ENG-1", resolution: "wont-do" } });
    assert.deepEqual(requestFor("log", ["ENG-1", "25", "--date", "2026-10-01", "--note", "n"]),
                     { ...POST, path: "/api/log", body: { id: "ENG-1", minutes: 25, date: "2026-10-01", note: "n" } });
    assert.deepEqual(requestFor("link", ["--rm", "ENG-1", "Blocks", "ENG-2"]),
                     { ...POST, path: "/api/link", body: { id: "ENG-1", type: "Blocks", target: "ENG-2", remove: true } });
    assert.deepEqual(Object.keys(REMOTE_VERBS), ["new", "move", "edit", "resolve", "log", "link", "show", "list"]);
  });
  test("BLZ-691: extra positionals are ignored, exactly as the local runners ignore them", () => {
    assert.deepEqual(requestFor("move", ["ENG-1", "done", "extra"]), requestFor("move", ["ENG-1", "done"]));
    assert.deepEqual(requestFor("resolve", ["ENG-1", "done", "extra"]), requestFor("resolve", ["ENG-1", "done"]));
    assert.deepEqual(requestFor("log", ["ENG-1", "5", "extra"]), requestFor("log", ["ENG-1", "5"]));
    assert.deepEqual(requestFor("link", ["ENG-1", "Blocks", "ENG-2", "x"]), requestFor("link", ["ENG-1", "Blocks", "ENG-2"]));
  });
  test("a missing argument, an unknown flag, or a derived field is refused before any request", () => {
    for (const [verb, argv, why] of [
      ["new", ["--project", "ENG", "x"], /usage: blaze new/],
      ["new", ["--project", "ENG", "--type", "task", "x", "--start", "2026-01-01"], /--start is derived by the scheduler; pass --not-before/],
      ["new", ["--bogus"], /unknown flag: --bogus/],
      ["move", ["ENG-1"], /usage: blaze move/],
      ["move", ["ENG-1", "--x"], /unknown flag/],
      ["edit", ["ENG-1", "title"], /usage: blaze edit/],
      ["log", ["ENG-1"], /usage: blaze log/],
      ["link", ["--rm", "ENG-1", "Blocks"], /usage: blaze link/],
      ["audit", [], /not available in remote mode/],
      ["constructor", [], /not available in remote mode/],
    ]) {
      assert.match(requestFor(verb, argv).error, why, `${verb} ${argv.join(" ")}`);
    }
  });
});

// --- against a real server -------------------------------------------------------------------
function gitBoard() {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz684-remote-")));
  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"]]) {
    execFileSync("git", ["-C", root, ...a]);
  }
  mkdirSync(join(root, "projects", "OBA", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"] }));
  writeFileSync(join(root, "projects", "OBA", "defined", "OBA-1-one.md"),
    ["---", "id: OBA-1", "title: one", "type: task", "project: OBA", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}
/** A db-mode board (SQLite shadow, project ENG) with one user, and the server over it. */
async function board(role = "member") {
  const roots = dbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const { token } = await addUser(roots.dataRoot, { email: "r@example.com", role });
  const server = startServer({ port: 0, root: roots.dataRoot, projectsDir: roots.projectsDir });
  await new Promise((res) => server.once("listening", res));
  return { root: roots.dataRoot, server, url: `http://127.0.0.1:${server.address().port}`, token: token.token };
}
/** The row for `id` as the shadow holds it, or null. */
function row(root, id) {
  const rs = openSqliteRead(shadowDbPath(root));
  try { return rs.getTicket(null, id).found; } finally { rs.close(); }
}
const capture = () => {
  const out = [], err = [];
  return { out, err, io: { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) } };
};
/** `blaze <args>` as a real process — async, so the in-process server can answer it. */
function blaze(args, env, cwd) {
  return new Promise((resolve) => {
    const base = { ...process.env };
    for (const k of ["BLAZE_REMOTE_URL", "BLAZE_TOKEN", "BLAZE_WRITE_PORT", "BLAZE_READONLY", "BLAZE_PROJECTS_DIR"]) delete base[k];
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...base, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("runRemote drives all six verbs against the server, and the board changes", async () => {
  const { root, server, url, token } = await board();
  try {
    const env = { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token };
    const run = async (verb, argv) => {
      const c = capture();
      const code = await runRemote(verb, argv, { env, ...c.io });
      return { code, out: c.out.join("\n"), err: c.err.join("\n") };
    };
    // 7.5, as round-2 review's parity check: the server rounds it exactly as `blaze new` does locally.
    const made = await run("new", ["--project", "ENG", "--type", "task", "--estimate", "7.5", "Remote", "two"]);
    assert.equal(made.code, 0, made.err);
    assert.equal(made.out, `created ENG-2 (remote: ${url})`);
    assert.equal((await run("move", ["ENG-2", "in-progress"])).code, 0);
    assert.equal((await run("edit", ["ENG-2", "priority", "high"])).code, 0);
    assert.equal((await run("log", ["ENG-2", "15", "--note", "n"])).code, 0);
    assert.equal((await run("link", ["ENG-2", "Relates", "ENG-1"])).code, 0);
    assert.equal((await run("resolve", ["ENG-2", "wont-do"])).code, 0);
    const t = row(root, "ENG-2").frontmatter;
    assert.equal(t.estimate, roundEstimate(7.5));
    assert.equal(t.priority, "high");
    assert.deepEqual(t.worklog.map((w) => [w.minutes, w.note]), [[15, "n"]]);
    assert.deepEqual(t.links, [{ type: "Relates", target: "ENG-1" }]);
    assert.equal(t.resolution, "wont-do");
    const refused = await run("move", ["ENG-2", "nowhere"]);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /blaze move failed \(http:\/\/127\.0\.0\.1:\d+ answered 422\)/);
  } finally { server.close(); }
});

test("end to end: `blaze new` in remote mode, a real process against a real server", async () => {
  const { server, url, token } = await board();
  const elsewhere = scratch(mkdtempSync(join(tmpdir(), "blz684-cwd-")));   // no board here at all
  try {
    const r = await blaze(["new", "--project", "ENG", "--type", "task", "--estimate", "30", "From", "another", "machine"],
                          { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token }, elsewhere);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `created ENG-2 (remote: ${url})`);
  } finally { server.close(); }
});

test("in remote mode every other command is refused, and half-set refuses everything", async () => {
  const elsewhere = scratch(mkdtempSync(join(tmpdir(), "blz684-cwd-")));
  const remote = { BLAZE_REMOTE_URL: "https://blaze.example.com", BLAZE_TOKEN: "blz_t" };
  for (const args of [["audit"], ["reconcile"], ["db", "status"], [], ["board"]]) {
    const r = await blaze(args, remote, elsewhere);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /is not available in remote mode — BLAZE_REMOTE_URL is set/);
  }
  for (const args of [["new", "--project", "X", "--type", "task", "t"], ["audit"]]) {
    const r = await blaze(args, { BLAZE_TOKEN: "blz_t" }, elsewhere);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /remote mode needs both BLAZE_REMOTE_URL and BLAZE_TOKEN/);
  }
  const ro = await blaze(["move", "OBA-1", "done"], { ...remote, BLAZE_READONLY: "1" }, elsewhere);
  assert.equal(ro.status, 1);
  assert.match(ro.stderr, /read-only mode/, "a refused write is refused in remote mode too");
});

test("the token goes to BLAZE_REMOTE_URL's origin only — a redirect elsewhere is refused, not followed", async () => {
  // `seen` records every request either server receives, Authorization header included.
  const seen = [];
  const listen = (handler) => new Promise((res) => {
    const s = createServer(handler).listen(0, "127.0.0.1", () => res(s));
  });
  const other = await listen((req, res) => {
    seen.push({ server: "other", auth: req.headers.authorization ?? null });
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true,"id":"X-1"}');
  });
  const first = await listen((req, res) => {
    seen.push({ server: "first", path: req.url, auth: req.headers.authorization ?? null });
    res.writeHead(307, { location: `http://127.0.0.1:${other.address().port}/api/new` }); res.end();
  });
  try {
    const c = capture();
    const code = await runRemote("new", ["--project", "OBA", "--type", "task", "t"],
      { env: { BLAZE_REMOTE_URL: `http://127.0.0.1:${first.address().port}`, BLAZE_TOKEN: "blz_secret" }, ...c.io });
    assert.equal(code, 1);
    assert.deepEqual(seen, [{ server: "first", path: "/api/new", auth: "Bearer blz_secret" }],
      "the configured origin got exactly one request; the redirect target got none");
    assert.doesNotMatch(c.err.join("\n"), /blz_secret/);
    // BLZ-691: the server DID answer — with a redirect, which was refused. Not "no answer".
    assert.match(c.err.join("\n"), /^blaze new: refused a redirect from http:\/\/127\.0\.0\.1:\d+ — /);
    assert.doesNotMatch(c.err.join("\n"), /no answer|unexpected redirect/);
  } finally { first.close(); other.close(); }
});

test("an unauthenticated or read-scope caller is refused by the server, and nothing is written", async () => {
  const { root, server, url } = await board("viewer");
  try {
    const bad = capture();
    assert.equal(await runRemote("new", ["--project", "ENG", "--type", "task", "--estimate", "30", "x"],
      { env: { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: "blz_not-a-real-token" }, ...bad.io }), 1);
    assert.match(bad.err.join("\n"), /answered 401/);
    const { token } = await addUser(root, { email: "v2@example.com", role: "viewer" });
    const c = capture();
    assert.equal(await runRemote("new", ["--project", "ENG", "--type", "task", "--estimate", "30", "x"],
      { env: { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token.token }, ...c.io }), 1);
    assert.match(c.err.join("\n"), /answered 403[\s\S]*does not carry the 'write' scope/);
    assert.equal(row(root, "ENG-2"), null);
  } finally { server.close(); }
});

test("remote `blaze new` against a file board prints the server's 409 as-is, and nothing is created", async () => {
  // The one board here that is NOT db mode: the server refuses `/api/new` on it (final review).
  const root = gitBoard();
  const { token } = await addUser(root, { email: "r@example.com", role: "member" });
  const server = startServer({ port: 0, root, projectsDir: join(root, "projects") });
  await new Promise((res) => server.once("listening", res));
  const saved = process.env.BLAZE_WRITE_PORT;
  delete process.env.BLAZE_WRITE_PORT;
  try {
    const c = capture();
    assert.equal(await runRemote("new", ["--project", "OBA", "--type", "task", "--estimate", "30", "x"],
      { env: { BLAZE_REMOTE_URL: `http://127.0.0.1:${server.address().port}`, BLAZE_TOKEN: token.token }, ...c.io }), 1);
    assert.match(c.err.join("\n"), /answered 409\)[\s\S]*blaze: POST \/api\/new needs the database write port \(BLAZE_WRITE_PORT=db\)/);
    assert.equal(existsSync(join(root, "projects", "OBA", "defined", "OBA-2-x.md")), false);
  } finally { server.close(); process.env.BLAZE_WRITE_PORT = saved; }
});

test("BLZ-691: a non-numeric --estimate or minutes reaches the server as null, and the server refuses it by name", async () => {
  const { root, server, url, token } = await board();
  try {
    const env = { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: token };
    assert.equal(requestFor("new", ["--project", "ENG", "--type", "task", "--estimate", "abc", "t"]).body.estimate, NaN);
    const n = capture();
    assert.equal(await runRemote("new", ["--project", "ENG", "--type", "task", "--estimate", "abc", "t"], { env, ...n.io }), 1);
    assert.match(n.err.join("\n"), /answered 422\)[\s\S]*estimate must be a number of minutes/);
    assert.equal(row(root, "ENG-2"), null, "nothing created");
    const l = capture();
    assert.equal(await runRemote("log", ["ENG-1", "abc"], { env, ...l.io }), 1);
    assert.match(l.err.join("\n"), /answered 422\)/);
    assert.deepEqual(row(root, "ENG-1").frontmatter.worklog ?? [], [], "nothing logged");
  } finally { server.close(); }
});
