// tests/remote-reads.test.mjs — BLZ-709 (spec D7): remote reads.
//
// `GET /api/ticket`, `GET /api/tickets` and `GET /api/projects` let an agent with no board
// checkout read the live board, and `blaze show` / `blaze list` are their remote-mode verbs.
// Pinned here: each route is classified `read` and refuses a caller with no credential (401) or
// with a token that lacks `read` (403); no answer carries a server filesystem path or a
// project's code-repo paths; and the CLI renders the answers, keeping `--json` stdout parseable.
//
// No failure message here prints a token: spawned output is checked with `assert.ok(re.test())`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { loadIdentity } from "../scripts/model/identity-db.mjs";
import { ROUTE_SCOPES } from "../scripts/model/serve-auth.mjs";
import { requestFor, runRemote } from "../scripts/remote-client.mjs";
import { ticketJson } from "../scripts/model/ticket-json.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";

const scratch = scratchRegistry();
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cli.mjs");
const ROUTES = ["/api/ticket?id=ENG-1", "/api/tickets", "/api/projects"];

/** Run `fn` with BLAZE_WRITE_PORT set to `value` (or deleted, for undefined), restored after. */
async function withWritePort(value, fn) {
  const saved = process.env.BLAZE_WRITE_PORT;
  if (value === undefined) delete process.env.BLAZE_WRITE_PORT; else process.env.BLAZE_WRITE_PORT = value;
  try { return await fn(); }
  finally { if (saved === undefined) delete process.env.BLAZE_WRITE_PORT; else process.env.BLAZE_WRITE_PORT = saved; }
}

async function listen(roots) {
  const server = startServer({ root: roots.dataRoot, projectsDir: roots.projectsDir, port: 0 });
  await new Promise((res) => server.once("listening", res));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/**
 * A db-mode board (SQLite shadow): ENG-1 (task, defined) and ENG-2 (bug, in-progress), a
 * project.json with a label and a code repo, a viewer, a member, and a member-owned token that
 * carries `write` but not `read`. Runs `fn` with the server up and BLAZE_WRITE_PORT=db.
 */
async function withDbBoard(fn) {
  const roots = dbBoard();
  writeFileSync(join(roots.projectsDir, "ENG", "project.json"),
    JSON.stringify({ key: "ENG", components: [], labels: ["ux"], codeRepos: ["../somewhere"] }));
  mkdirSync(join(roots.projectsDir, "ENG", "in-progress"), { recursive: true });
  writeFileSync(join(roots.projectsDir, "ENG", "in-progress", "ENG-2-b.md"),
    ["---", "id: ENG-2", "title: A bug", "type: bug", "project: ENG",
     "priority: high", "assignee: unassigned", "estimate: 60",
     "created: 2026-01-02", "updated: 2026-01-02", "links:", "---", "", "two", ""].join("\n"));
  return withWritePort("db", async () => {
    assert.equal(await runDb(["init"], { ...QUIET, roots }), 0, "db init");
    const viewer = await addUser(roots.dataRoot, { email: "v@example.com", role: "viewer" });
    const member = await addUser(roots.dataRoot, { email: "m@example.com", role: "member" });
    const id = loadIdentity(roots.dataRoot);
    let writeOnly;
    try {
      writeOnly = (await id.store.issueToken({ userId: member.user.id, name: "write only", scopes: ["write"] })).token;
    } finally { id.close(); }
    const { server, url } = await listen(roots);
    try {
      return await fn({ ...roots, url, viewer: viewer.token.token, member: member.token.token, writeOnly });
    } finally { server.close(); }
  });
}

async function get(url, path, token) {
  const res = await fetch(new URL(path, url), token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: res.status, text, body };
}

/** `blaze <args>` as a real process. The remote and write-port variables are deleted, never "". */
function blaze(args, env = {}) {
  return new Promise((resolve) => {
    const base = { ...process.env };
    for (const k of ["BLAZE_REMOTE_URL", "BLAZE_TOKEN", "BLAZE_TOKEN_FILE", "BLAZE_WRITE_PORT",
                     "BLAZE_READONLY", "BLAZE_PROJECTS_DIR"]) delete base[k];
    const cwd = scratch(mkdtempSync(join(tmpdir(), "blz709-cwd-")));
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...base, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("BLZ-709: the three read routes are classified read", () => {
  assert.equal(ROUTE_SCOPES["GET /api/ticket"], "read");
  assert.equal(ROUTE_SCOPES["GET /api/tickets"], "read");
  assert.equal(ROUTE_SCOPES["GET /api/projects"], "read");
});

test("BLZ-709: ticketJson keeps id, project, status, frontmatter and body, and drops the file path", () => {
  const rec = { file: "/srv/board/projects/ENG/defined/ENG-1-a.md", status: "defined", project: "ENG",
                frontmatter: { id: "ENG-1", title: "t" }, body: "b", extra: 1 };
  assert.deepEqual(ticketJson(rec),
    { id: "ENG-1", project: "ENG", status: "defined", frontmatter: { id: "ENG-1", title: "t" }, body: "b" });
  assert.deepEqual(Object.keys(ticketJson(rec, { body: false })), ["id", "project", "status", "frontmatter"]);
  assert.equal(ticketJson({ frontmatter: { project: "X" } }).project, "X");
  assert.equal(ticketJson({}).id, null);
});

test("BLZ-709: a viewer reads a ticket; no token is 401", async () => {
  await withDbBoard(async ({ url, viewer }) => {
    const r = await get(url, "/api/ticket?id=ENG-1", viewer);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.ticket.id, "ENG-1");
    assert.equal(r.body.ticket.status, "defined");
    assert.equal(r.body.ticket.frontmatter.estimate, 30);
    assert.ok(r.body.ticket.body.includes("one"), "the body rides along");
    assert.equal((await get(url, "/api/ticket?id=ENG-1")).status, 401);
  });
});

test("BLZ-709: every read route refuses no credential (401) and a token without read (403)", async () => {
  await withDbBoard(async ({ url, viewer, writeOnly }) => {
    for (const path of ROUTES) {
      assert.equal((await get(url, path, viewer)).status, 200, `${path}: viewer`);
      const none = await get(url, path);
      assert.equal(none.status, 401, `${path}: no credential`);
      assert.equal(none.body?.ok, undefined, `${path}: a refusal carries no board data`);
      const bad = await get(url, path, "blz_not-a-real-token");
      assert.equal(bad.status, 401, `${path}: an unknown token`);
      const wo = await get(url, path, writeOnly);
      assert.equal(wo.status, 403, `${path}: a write-only token`);
      assert.ok(/'read' scope/.test(wo.text), `${path}: the 403 names the read scope`);
      assert.ok(!/ENG-1|A task/.test(none.text + bad.text + wo.text), `${path}: a refusal leaks no ticket`);
    }
  });
});

test("BLZ-709: unknown id 404, missing id 400", async () => {
  await withDbBoard(async ({ url, viewer }) => {
    const nf = await get(url, "/api/ticket?id=ENG-99", viewer);
    assert.equal(nf.status, 404);
    assert.deepEqual(nf.body, { ok: false, errors: ["not found"] });
    const missing = await get(url, "/api/ticket", viewer);
    assert.equal(missing.status, 400);
    assert.deepEqual(missing.body, { ok: false, errors: ["id is required"] });
  });
});

test("BLZ-709: list filters by project, status and type", async () => {
  await withDbBoard(async ({ url, viewer }) => {
    const ids = async (q) => {
      const r = await get(url, `/api/tickets${q}`, viewer);
      assert.equal(r.status, 200, q);
      assert.equal(r.body.ok, true);
      for (const t of r.body.tickets) assert.equal(Object.hasOwn(t, "body"), false, `${t.id} carries no body`);
      return r.body.tickets.map((t) => t.id);
    };
    assert.deepEqual(await ids("?status=in-progress"), ["ENG-2"]);
    assert.deepEqual(await ids("?type=task"), ["ENG-1"]);
    assert.deepEqual(await ids("?project=ENG"), ["ENG-1", "ENG-2"]);
    assert.deepEqual(await ids(""), ["ENG-1", "ENG-2"]);
  });
});

test("BLZ-709 review M6: an unknown project, status or type is a 422 naming the value, never an empty 200", async () => {
  await withDbBoard(async ({ url, viewer }) => {
    for (const [q, name] of [["?project=eng", "eng"], ["?project=ENGX", "ENGX"],
                             ["?status=inprogress", "inprogress"], ["?type=tsk", "tsk"],
                             ["?project=ENG&status=nope", "nope"]]) {
      const r = await get(url, `/api/tickets${q}`, viewer);
      assert.equal(r.status, 422, q);
      assert.equal(r.body.ok, false, q);
      assert.ok(r.body.errors.some((e) => e.includes(name)), `${q}: the error names the value`);
    }
    assert.equal((await get(url, "/api/tickets?project=ENG&status=in-progress&type=bug", viewer)).status, 200);
  });
});

test("BLZ-709 review M6: blaze list reports an unknown filter value as a failure, exit 1", async () => {
  await withDbBoard(async ({ url, viewer }) => {
    const r = await blaze(["list", "--project", "NOPE"], { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: viewer });
    assert.equal(r.status, 1);
    assert.ok(/answered 422/.test(r.stderr) && /NOPE/.test(r.stderr), "the 422 and the value are reported");
    assert.equal(r.stdout, "");
  });
});

test("BLZ-709: /api/projects carries taxonomy and no server path", async () => {
  await withDbBoard(async ({ url, viewer }) => {
    const r = await get(url, "/api/projects", viewer);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, projects: [{ key: "ENG", labels: ["ux"], components: [],
      requireLabels: false, requireComponents: false, requireWorklogBeforeTerminal: false }] });
    assert.ok(!r.text.includes("somewhere"), "codeRepos never leave the server");
  });
});

test("BLZ-709: no read answer contains a server filesystem path", async () => {
  await withDbBoard(async ({ url, viewer, projectsDir, dataRoot }) => {
    for (const path of ROUTES) {
      const { status, text } = await get(url, path, viewer);
      assert.equal(status, 200, path);
      assert.ok(!text.includes(projectsDir) && !text.includes(dataRoot), `${path} names a server path`);
    }
  });
});

test("BLZ-709: an fs board's duplicate id is 409 without paths", async () => {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz709-fs-")));
  const projectsDir = join(dataRoot, "projects");
  writeFileSync(join(dataRoot, "blaze.config.json"), JSON.stringify({ projects: ["ENG"], schemaVersion: 2 }));
  for (const [dir, file] of [["defined", "ENG-1-a.md"], ["done", "ENG-1-b.md"]]) {
    mkdirSync(join(projectsDir, "ENG", dir), { recursive: true });
    writeFileSync(join(projectsDir, "ENG", dir, file),
      ["---", "id: ENG-1", `title: ${file}`, "type: task", "project: ENG", "priority: medium",
       "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "x", ""].join("\n"));
  }
  await withWritePort(undefined, async () => {
    const { server, url } = await listen({ dataRoot, projectsDir });
    try {
      const r = await get(url, "/api/ticket?id=ENG-1");
      assert.equal(r.status, 409);
      assert.deepEqual(r.body, { ok: false, errors: ["ENG-1 is ambiguous: 2 records carry it"] });
      assert.ok(!r.text.includes(projectsDir) && !r.text.includes(dataRoot), "the 409 names no server path");
    } finally { server.close(); }
  });
});

test("BLZ-709: remote show and list round-trip end to end", async () => {
  await withDbBoard(async ({ url, viewer }) => {
    const env = { BLAZE_REMOTE_URL: url, BLAZE_TOKEN: viewer };
    const sj = await blaze(["show", "ENG-1", "--json"], env);
    assert.equal(sj.status, 0, "show --json exits 0");
    assert.equal(JSON.parse(sj.stdout).id, "ENG-1");

    const s = await blaze(["show", "ENG-1"], env);
    assert.equal(s.status, 0, "show exits 0");
    const lines = s.stdout.split("\n");
    assert.equal(lines[0], "ENG-1  defined  task  A task");
    assert.ok(lines.includes("  estimate: 30"), "frontmatter fields are listed");
    assert.ok(lines.includes("  priority: medium"), "frontmatter fields are listed");
    assert.ok(!lines.some((l) => /^ {2}(id|title|type|project):/.test(l)), "the header fields are not repeated");
    assert.ok(/- \[ \] one/.test(s.stdout), "the body follows");

    const lj = await blaze(["list", "--project", "ENG", "--json"], env);
    assert.equal(lj.status, 0, "list --json exits 0");
    assert.deepEqual(JSON.parse(lj.stdout).map((t) => t.id), ["ENG-1", "ENG-2"]);

    const pj = await blaze(["list", "--projects", "--json"], env);
    assert.equal(pj.status, 0, "list --projects --json exits 0");
    const projects = JSON.parse(pj.stdout);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].key, "ENG");
    assert.deepEqual(projects[0].labels, ["ux"]);

    const p = await blaze(["list", "--projects"], env);
    assert.equal(p.status, 0, "list --projects exits 0");
    assert.equal(p.stdout, "ENG  labels: ux  components: -\n");
    assert.ok(/1 project\(s\) \(remote: /.test(p.stderr), "the count goes to stderr");

    const l = await blaze(["list", "--status", "in-progress"], env);
    assert.equal(l.status, 0, "list exits 0");
    assert.equal(l.stdout, "ENG-2  in-progress  bug  A bug\n");
    assert.ok(/1 ticket\(s\) \(remote: /.test(l.stderr), "the count goes to stderr");

    const nf = await blaze(["show", "ENG-99"], env);
    assert.equal(nf.status, 1, "an unknown id exits 1");
    assert.ok(/answered 404/.test(nf.stderr) && /not found/.test(nf.stderr), "the 404 is reported");
    assert.equal(nf.stdout, "");
  });
});

test("BLZ-709: show and list refuse outside remote mode", async () => {
  for (const args of [["show", "ENG-1"], ["list"], ["list", "--projects"]]) {
    const r = await blaze(args);
    assert.equal(r.status, 1, args.join(" "));
    assert.ok(/runs in remote mode only/.test(r.stderr), `${args.join(" ")}: names remote mode`);
    assert.equal(r.stdout, "");
  }
});

test("BLZ-709: requestFor builds GETs and refuses unknown flags", () => {
  assert.deepEqual(requestFor("show", ["A B"]),
    { method: "GET", path: "/api/ticket?id=A%20B", body: undefined, read: "ticket", json: false });
  assert.equal(requestFor("show", ["ENG-1", "--json"]).json, true);
  assert.equal(requestFor("list", ["--status", "done", "--type", "bug"]).path, "/api/tickets?status=done&type=bug");
  assert.equal(requestFor("list", []).path, "/api/tickets");
  assert.equal(requestFor("list", ["--project", "ENG"]).read, "tickets");
  assert.deepEqual(requestFor("list", ["--projects", "--json"]),
    { method: "GET", path: "/api/projects", body: undefined, read: "projects", json: true });
  assert.deepEqual(requestFor("list", ["--bogus"]), { error: "unknown flag: --bogus" });
  assert.deepEqual(requestFor("show", ["--bogus"]), { error: "unknown flag: --bogus" });
  assert.deepEqual(requestFor("show", []), { error: "usage: blaze show <id> [--json]" });
  assert.match(requestFor("list", ["--status"]).error, /--status needs a value/);
  assert.match(requestFor("list", ["--projects", "--status", "done"]).error, /--projects/);
  assert.equal(requestFor("move", ["ENG-1", "done"]).method, "POST");
  assert.equal(requestFor("move", ["ENG-1", "done"]).read, false);
});

test("BLZ-709 review: a filter flag never takes the next flag as its value", () => {
  for (const f of ["--project", "--status", "--type"]) {
    assert.deepEqual(requestFor("list", [f, "--json"]), { error: `blaze list: ${f} needs a value` });
    assert.deepEqual(requestFor("list", [f]), { error: `blaze list: ${f} needs a value` });
  }
});

test("BLZ-709 review: a 200 ok answer without its payload is a failure, never 'undefined' or a throw", async () => {
  const env = { BLAZE_REMOTE_URL: "http://127.0.0.1:1", BLAZE_TOKEN: "blz_t" };
  const answering = (body) => async () => new Response(JSON.stringify(body),
    { status: 200, headers: { "content-type": "application/json" } });
  for (const [verb, argv, body] of [
    ["show", ["ENG-1"], { ok: true }],
    ["show", ["ENG-1"], { ok: true, ticket: "x" }],
    ["show", ["ENG-1", "--json"], { ok: true }],
    ["list", [], { ok: true }],
    ["list", [], { ok: true, tickets: {} }],
    ["list", ["--json"], { ok: true, tickets: null }],
    ["list", ["--projects"], { ok: true, projects: "x" }],
    ["list", ["--projects", "--json"], { ok: true }],
  ]) {
    const out = [], err = [];
    const code = await runRemote(verb, argv, { env, fetch: answering(body),
      out: (x) => out.push(String(x)), err: (x) => err.push(String(x)) });
    const what = `${verb} ${argv.join(" ")} ${JSON.stringify(body)}`;
    assert.equal(code, 1, what);
    assert.deepEqual(out, [], what);
    assert.deepEqual(err, [`blaze ${verb} failed: malformed answer`], what);
  }
});
