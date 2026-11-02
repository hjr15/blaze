// tests/remote-body.test.mjs — BLZ-729 (E3, part 3): authoring a ticket's body and acceptance
// criteria from a client. `blaze new|edit --body-file/--ac-file`, remote `blaze ac add|toggle`,
// the client's size caps, and the errors an OLDER server earns (it drops or 404s what it does
// not know). No failure message here prints a token: spawned output is checked with
// `assert.ok(re.test())` or by `includes` on the token, never echoed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { requestFor, runRemote } from "../scripts/remote-client.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const CLI = join(SCRIPTS, "cli.mjs");
const SCRUB = ["BLAZE_REMOTE_URL", "BLAZE_TOKEN", "BLAZE_TOKEN_FILE", "BLAZE_WRITE_PORT",
               "BLAZE_READONLY", "BLAZE_PROJECTS_DIR"];

const POST = { method: "POST", read: false, json: false };
const files = (map) => ({ readFile: (p) => {
  if (!(p in map)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  return map[p];
} });
const NEW = ["--project", "ENG", "--type", "task", "T"];

/** `blaze <args>` as a real process; the board-selecting variables are deleted, never "". */
function blaze(args, env = {}) {
  return new Promise((resolve) => {
    const base = { ...process.env };
    for (const k of SCRUB) delete base[k];
    const cwd = scratch(mkdtempSync(join(tmpdir(), "blz729c-cwd-")));
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...base, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const tmp = () => scratch(mkdtempSync(join(tmpdir(), "blz729c-")));
const put = (dir, name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };

/** A db-mode board, a member and the server over it. */
async function withServer(fn) {
  const roots = dbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const member = (await addUser(roots.dataRoot, { email: "m@example.com", role: "member" })).token.token;
  const before = process.env.BLAZE_WRITE_PORT;
  process.env.BLAZE_WRITE_PORT = "db";
  const server = startServer({ port: 0, root: roots.dataRoot, projectsDir: roots.projectsDir });
  await new Promise((res) => server.once("listening", res));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { return await fn({ url, member, roots }); }
  finally {
    server.close();
    if (before === undefined) delete process.env.BLAZE_WRITE_PORT; else process.env.BLAZE_WRITE_PORT = before;
  }
}

/** A stub that answers every request with `status`/`json`, and records the paths it saw. */
async function withStub(status, json, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push(req.url);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  try { return await fn({ url: `http://127.0.0.1:${server.address().port}`, seen }); }
  finally { server.close(); }
}

test("BLZ-729: requestFor maps body and AC flags", () => {
  const rf = files({ b: "## Context\n\nhi\n", a: "one\n\n  \ntwo\r\n", bad: "x" });
  assert.deepEqual(requestFor("new", [...NEW, "--body-file", "b", "--ac-file", "a"], rf),
    { ...POST, path: "/api/new",
      body: { project: "ENG", type: "task", title: "T", body: "## Context\n\nhi\n", ac: ["one", "two"] } });
  assert.deepEqual(requestFor("new", NEW, rf).body, { project: "ENG", type: "task", title: "T" },
    "both flags are optional");
  assert.deepEqual(requestFor("edit", ["ENG-1", "--ac-file", "a"], rf),
    { ...POST, path: "/api/body", body: { id: "ENG-1", ac: ["one", "two"] } });
  assert.deepEqual(requestFor("edit", ["ENG-1", "--body-file", "b", "--ac-file", "a"], rf),
    { ...POST, path: "/api/body", body: { id: "ENG-1", body: "## Context\n\nhi\n", ac: ["one", "two"] } });
  assert.deepEqual(requestFor("ac", ["add", "ENG-1", "write", "the", "docs"], rf),
    { ...POST, path: "/api/ac/add", body: { id: "ENG-1", text: "write the docs" } });
  assert.deepEqual(requestFor("ac", ["toggle", "ENG-1", "2", "--uncheck"], rf),
    { ...POST, path: "/api/ac", body: { id: "ENG-1", index: 1, checked: false } });
  assert.deepEqual(requestFor("ac", ["toggle", "ENG-1", "1"], rf),
    { ...POST, path: "/api/ac", body: { id: "ENG-1", index: 0, checked: true } });
  // The field/value form is untouched.
  assert.deepEqual(requestFor("edit", ["ENG-1", "title", "x"], rf),
    { ...POST, path: "/api/edit", body: { id: "ENG-1", patch: { title: "x" } } });

  const EDIT_USAGE = "usage: blaze edit <id> <field> <value…> | blaze edit <id> [--body-file P] [--ac-file Q]";
  assert.deepEqual(requestFor("edit", ["ENG-1", "--body-file", "b", "title", "x"], rf), { error: EDIT_USAGE });
  assert.deepEqual(requestFor("edit", ["ENG-1", "title", "x", "--ac-file", "a"], rf), { error: EDIT_USAGE });
  assert.deepEqual(requestFor("edit", ["ENG-1", "--body-file"], rf),
    { error: "blaze edit: --body-file needs a value" });
  for (const n of ["0", "-1", "1.5", "x", "01"]) {
    assert.deepEqual(requestFor("ac", ["toggle", "ENG-1", n], rf),
      { error: "blaze ac toggle: <n> must be a criterion number counting from 1" }, n);
  }
  const AC_USAGE = "usage: blaze ac add <id> <text…> | blaze ac toggle <id> <n> [--uncheck]";
  for (const argv of [[], ["bogus"], ["add"], ["add", "ENG-1"], ["toggle"], ["toggle", "ENG-1"]]) {
    assert.deepEqual(requestFor("ac", argv, rf), { error: AC_USAGE }, JSON.stringify(argv));
  }
  assert.deepEqual(requestFor("ac", ["toggle", "ENG-1", "1", "--bogus"], rf), { error: "unknown flag: --bogus" });
});

test("BLZ-729: an unreadable file is an error naming the code, never the content", () => {
  const rf = { readFile: () => { throw Object.assign(new Error("TOP-SECRET-CONTENT"), { code: "EACCES" }); } };
  assert.deepEqual(requestFor("new", [...NEW, "--body-file", "p/b.md"], rf),
    { error: "blaze new: cannot read --body-file p/b.md: EACCES" });
  assert.deepEqual(requestFor("edit", ["ENG-1", "--ac-file", "p/a.md"], rf),
    { error: "blaze edit: cannot read --ac-file p/a.md: EACCES" });
  assert.ok(!JSON.stringify(requestFor("new", [...NEW, "--body-file", "p"], rf)).includes("TOP-SECRET"));
  assert.deepEqual(requestFor("new", [...NEW, "--ac-file", "nope"], files({})),
    { error: "blaze new: cannot read --ac-file nope: ENOENT" });
});

test("BLZ-729: the client refuses an oversize body file and an oversize request, sending nothing", async () => {
  let calls = 0;
  const fetch = async () => { calls++; throw new Error("must not be called"); };
  assert.deepEqual(requestFor("new", [...NEW, "--body-file", "big"], files({ big: "x".repeat(131073) })),
    { error: "blaze new: --body-file big is 131073 bytes; the limit is 131072" });
  // 131,072 bytes passes the file cap but JSON-escapes past 256 KiB.
  const quotes = '"'.repeat(131072);
  const r = requestFor("edit", ["ENG-1", "--body-file", "q"], files({ q: quotes }));
  assert.match(r.error ?? "", /^blaze edit: the request is \d+ bytes; the board accepts at most 262144 — shorten the body or the criteria$/);
  assert.equal(requestFor("new", [...NEW, "--body-file", "ok"], files({ ok: "x".repeat(131072) })).error, undefined,
    "a maximum-size plain body is within both caps");

  for (const [argv, map] of [
    [[...NEW, "--body-file", "big"], { big: "x".repeat(131073) }],
    [["ENG-1", "--body-file", "q"], { q: quotes }],
  ]) {
    const errs = [];
    const code = await runRemote(argv.length === 3 ? "edit" : "new", argv, {
      env: { BLAZE_REMOTE_URL: "http://127.0.0.1:9", BLAZE_TOKEN: "tok" }, fetch,
      err: (m) => errs.push(m), out() {}, ...files(map),
    });
    assert.equal(code, 1);
    assert.match(errs.join("\n"), /the limit is 131072|the request is \d+ bytes/);
  }
  assert.equal(calls, 0, "nothing was sent");
});

test("BLZ-729: remote new, edit, ac add and ac toggle round-trip end to end", async () => {
  await withServer(async ({ url, member }) => {
    const dir = tmp();
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, `${member}\n`, { mode: 0o600 });
    const env = { BLAZE_REMOTE_URL: url, BLAZE_TOKEN_FILE: tokenFile };
    const bodyText = "## Context\n\nwhy we do it\n\n## Notes\n\nn1\n";
    const b = put(dir, "b.md", bodyText);
    const a = put(dir, "a.md", "one\n\n- [x] two\n");
    const all = [];
    const run = async (args) => {
      const r = await blaze(args, env);
      all.push(r.stdout, r.stderr);
      assert.equal(r.status, 0, `${args.join(" ")}\n${r.stderr}`);
      return r;
    };

    const made = await run(["new", "--project", "ENG", "--type", "task", "Authored", "--estimate", "30",
                            "--body-file", b, "--ac-file", a]);
    const id = /created (ENG-\d+)/.exec(made.stdout)?.[1];
    assert.ok(id, made.stdout);
    let shown = JSON.parse((await run(["show", id, "--json"])).stdout);
    assert.ok(shown.body.includes("why we do it") && shown.body.includes("n1"), "the sent body");
    assert.ok(shown.body.includes("- [ ] one") && shown.body.includes("- [x] two"), "the sent criteria");

    const added = await run(["ac", "add", id, "added", "later"]);
    assert.match(added.stdout, new RegExp(`${id}: criterion 3 added \\(remote: ${url}\\)`));
    const toggled = await run(["ac", "toggle", id, "1"]);
    assert.match(toggled.stdout, new RegExp(`${id}: criterion 1 checked \\(remote: ${url}\\)`));
    shown = JSON.parse((await run(["show", id, "--json"])).stdout);
    assert.ok(shown.body.includes("- [ ] added later"), shown.body);
    assert.ok(shown.body.includes("- [x] one"), "criterion 1 is checked");
    const un = await run(["ac", "toggle", id, "1", "--uncheck"]);
    assert.match(un.stdout, /criterion 1 unchecked/);

    const b2 = put(dir, "b2.md", "## Context\n\nreplaced\n\n## Acceptance Criteria\n\n- [ ] only\n");
    const edited = await run(["edit", id, "--body-file", b2]);
    assert.match(edited.stdout, new RegExp(`${id}: body replaced \\(\\d+ bytes, 1 criteria\\) \\(remote: ${url}\\)`));
    const a2 = put(dir, "a2.md", "x\ny\n");
    const acEd = await run(["edit", id, "--ac-file", a2]);
    assert.match(acEd.stdout, /body replaced \(\d+ bytes, 2 criteria\)/);
    shown = JSON.parse((await run(["show", id, "--json"])).stdout);
    assert.ok(shown.body.includes("replaced") && shown.body.includes("- [ ] x") && !shown.body.includes("only"), shown.body);

    assert.ok(all.every((s) => !s.includes(member)), "the token never reaches stdout or stderr");
  });
});

test("BLZ-729: a maximum-size plain body is accepted end to end, never a 400", async () => {
  await withServer(async ({ url, member }) => {
    const dir = tmp();
    const env = { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: member };
    // 131,072 bytes including the final newline.
    const big = put(dir, "big.md", `${"x".repeat(131071)}\n`);
    const r = await blaze(["new", "--project", "ENG", "--type", "task", "Big", "--estimate", "30", "--body-file", big], env);
    assert.equal(r.status, 0, r.stderr);
    const id = /created (ENG-\d+)/.exec(r.stdout)?.[1];
    const shown = JSON.parse((await blaze(["show", id, "--json"], env)).stdout);
    assert.equal(Buffer.byteLength(shown.body, "utf8"), 131072);
  });
});

test("BLZ-729: remote new with --body-file against a server that drops body exits 1", async () => {
  await withStub(200, { ok: true, id: "ENG-9" }, async ({ url }) => {
    const dir = tmp();
    const b = put(dir, "b.md", "## Context\n\nhi\n");
    const r = await blaze(["new", "--project", "ENG", "--type", "task", "T", "--estimate", "30", "--body-file", b],
      { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: "tok-stub" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /created ENG-9 but ignored the body/);
    assert.match(r.stderr, /older than BLZ-729/);
    // And a plain `new` against the same stub is still a success.
    const plain = await blaze(["new", "--project", "ENG", "--type", "task", "T", "--estimate", "30"],
      { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: "tok-stub" });
    assert.equal(plain.status, 0, plain.stderr);
  });
});

test("BLZ-729: edit --body-file and ac add against a server without the routes name the version", async () => {
  await withStub(404, { ok: false, errors: ["unknown endpoint"] }, async ({ url }) => {
    const dir = tmp();
    const b = put(dir, "b.md", "## Context\n\nhi\n");
    const env = { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: "tok-stub" };
    const edit = await blaze(["edit", "ENG-1", "--body-file", b], env);
    assert.equal(edit.status, 1);
    assert.match(edit.stderr, /has no \/api\/body — it is older than BLZ-729/);
    assert.ok(edit.stderr.includes(`the server at ${url} has no /api/body`), edit.stderr);
    const add = await blaze(["ac", "add", "ENG-1", "text"], env);
    assert.equal(add.status, 1);
    assert.match(add.stderr, /blaze ac: the server at .* has no \/api\/ac\/add — it is older than BLZ-729 \(0\.11\.0\)/);
    // Any other 404 keeps the generic line.
    const move = await blaze(["move", "ENG-1", "done"], env);
    assert.equal(move.status, 1);
    assert.ok(!/older than BLZ-729/.test(move.stderr), move.stderr);
  });
});

test("BLZ-729: ac is remote-only", async () => {
  const r = await blaze(["ac", "add", "ENG-1", "text"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /runs in remote mode only/);
  assert.match(r.stderr, /writes to the live board/);
  assert.ok(!/reads the live board/.test(r.stderr), "a mutating verb does not say it reads");
  const show = await blaze(["show", "ENG-1"]);
  assert.match(show.stderr, /reads the live board over HTTP/, "the reads keep their wording");
  const ro = await blaze(["ac", "add", "ENG-1", "text"], { BLAZE_READONLY: "1" });
  assert.equal(ro.status, 1);
  assert.match(ro.stderr, /read-only mode .* ac/);
});

test("BLZ-729: local new and edit take the body flags", () => {
  const roots = dbBoard();
  // An fs board reserves ids through git, so its data root must be a worktree.
  assert.equal(spawnSync("git", ["-C", roots.dataRoot, "init", "-q"]).status, 0);
  const dir = tmp();
  const env = (() => { const e = { ...process.env, BLAZE_PROJECTS_DIR: roots.projectsDir };
                       for (const k of SCRUB.filter((k) => k !== "BLAZE_PROJECTS_DIR")) delete e[k]; return e; })();
  const run = (script, args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: "utf8", env });
  const b = put(dir, "b.md", "## Context\r\n\r\nlocal body\r\n");
  const a = put(dir, "a.md", "first\nsecond\n");

  const made = run("new-runner.mjs", ["--project", "ENG", "--type", "task", "Local", "--estimate", "30",
                                      "--body-file", b, "--ac-file", a]);
  assert.equal(made.status, 0, made.stderr);
  const file = (id) => {
    const d = join(roots.projectsDir, "ENG", "defined");
    return readFileSync(join(d, readdirSync(d).find((f) => f.startsWith(`${id}-`))), "utf8");
  };
  const created = file("ENG-2");
  assert.ok(created.includes("## Context\n\nlocal body\n"), created);
  assert.ok(created.includes("- [ ] first\n- [ ] second"), created);
  assert.ok(!created.includes("\r"));

  const edited = run("edit-runner.mjs", ["ENG-1", "--ac-file", a]);
  assert.equal(edited.status, 0, edited.stderr);
  const one = file("ENG-1");
  assert.ok(one.includes("- [ ] first\n- [ ] second") && !one.includes("- [ ] one"), one);
  const edited2 = run("edit-runner.mjs", ["ENG-1", "--body-file", b]);
  assert.equal(edited2.status, 0, edited2.stderr);
  assert.ok(file("ENG-1").includes("local body"));

  // Refusals: exit 1 with the reasons, nothing written.
  const empty = put(dir, "empty.md", "  \n");
  const bad = run("new-runner.mjs", ["--project", "ENG", "--type", "task", "Bad", "--estimate", "30", "--body-file", empty]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /body must not be blank/);
  const noFile = run("edit-runner.mjs", ["ENG-1", "--body-file", join(dir, "absent")]);
  assert.equal(noFile.status, 1);
  assert.match(noFile.stderr, /cannot read --body-file .*: ENOENT/);
  const mixed = run("edit-runner.mjs", ["ENG-1", "--body-file", b, "title", "x"]);
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /usage: blaze edit <id> <field> <value…> \| blaze edit <id> \[--body-file P\] \[--ac-file Q\]/);
  assert.ok(readdirSync(join(roots.projectsDir, "ENG", "defined")).length === 2, "no ticket was created by the bad calls");
});
