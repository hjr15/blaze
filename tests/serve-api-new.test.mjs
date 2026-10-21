// tests/serve-api-new.test.mjs — BLZ-684 (spec §5.4): `POST /api/new` creates a ticket through
// the resolved write port, and `POST /api/link` — classified `write` since BLZ-323 but answered
// by no handler — reaches the ticket-link verb. Both record WHO in the event log (ADR-0013 §6).
// fs mode runs on a git board (per-op commits); db mode on the SQLite shadow. `/api/new` is
// db-mode ONLY (final review): a file board allocates ids from git, whose synchronous fetch
// would freeze the server — so on fs it is a 409, pinned below.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { startServer } from "../scripts/serve.mjs";
import { roundEstimate } from "../scripts/model/time.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { openSqliteRead } from "../scripts/model/sqlite-storage.mjs";
import { shadowDbPath } from "../scripts/model/write-port-resolve.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";

const scratch = scratchRegistry();

function gitBoard() {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz684-new-")));
  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"]]) {
    execFileSync("git", ["-C", root, ...a]);
  }
  mkdirSync(join(root, "projects", "OBA", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"] }));
  writeFileSync(join(root, "projects", "OBA", "defined", "OBA-1-one.md"),
    ["---", "id: OBA-1", "title: one", "type: task", "project: OBA", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  writeFileSync(join(root, "projects", "OBA", "defined", "OBA-2-two.md"),
    ["---", "id: OBA-2", "title: two", "type: task", "project: OBA", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return { dataRoot: root, projectsDir: join(root, "projects") };
}

async function serve(roots) {
  const server = startServer({ port: 0, root: roots.dataRoot, projectsDir: roots.projectsDir });
  await new Promise((res) => server.once("listening", res));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
const post = (base, path, body, token) => fetch(`${base}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

describe("fs mode", () => {
  test("POST /api/new is refused as a 409 on a file board — no id claimed, no file, no git process", async () => {
    const roots = gitBoard();
    // An origin that accepts the connection and never answers: any `git fetch` against it hangs.
    const hole = createServer(() => {});
    await new Promise((res) => hole.listen(0, "127.0.0.1", res));
    execFileSync("git", ["-C", roots.dataRoot, "remote", "add", "origin", `git://127.0.0.1:${hole.address().port}/x`]);
    const head = () => execFileSync("git", ["-C", roots.dataRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
    const { token } = await addUser(roots.dataRoot, { email: "m@example.com", role: "member" });
    execFileSync("git", ["-C", roots.dataRoot, "add", "-A"]);
    execFileSync("git", ["-C", roots.dataRoot, "commit", "-q", "-m", "users"]);
    const before = head();
    const { server, base } = await serve(roots);
    try {
      const t0 = Date.now();
      const r = await post(base, "/api/new", { project: "OBA", type: "task", title: "refused", estimate: 30 }, token.token);
      const body = await r.json();
      assert.ok(Date.now() - t0 < 2000, `answered promptly (${Date.now() - t0} ms) — nothing waited on the origin`);
      assert.equal(r.status, 409, JSON.stringify(body));
      assert.match(body.errors[0], /POST \/api\/new needs the database write port \(BLAZE_WRITE_PORT=db\)/);
      assert.doesNotMatch(body.errors[0], /\/tmp|\/home|projects\//, "no server path in the refusal");
      // Invalid input on a file board is the same refusal: the mode is checked before the body is.
      assert.equal((await post(base, "/api/new", { nonsense: true }, token.token)).status, 409);
      assert.equal(existsSync(join(roots.projectsDir, "OBA", "defined", "OBA-3-refused.md")), false);
      assert.equal(existsSync(join(roots.projectsDir, "OBA", "claims")), false, "no claim file");
      assert.equal(execFileSync("git", ["-C", roots.dataRoot, "status", "--short", "--", "projects"], { encoding: "utf8" }).trim(), "",
                   "nothing was written to the projects tree");
      assert.equal(head(), before, "no commit");
      // The board still answers while a slow origin exists.
      assert.equal((await fetch(`${base}/api/hash`, { headers: { authorization: `Bearer ${token.token}` } })).status, 200);
    } finally { server.close(); hole.close(); hole.closeAllConnections?.(); }
  });

  test("POST /api/link reaches the ticket-link verb: add, refuse an unknown type, remove", async () => {
    const roots = gitBoard();
    const { token } = await addUser(roots.dataRoot, { email: "m@example.com", role: "member" });
    const { server, base } = await serve(roots);
    try {
      const add = await post(base, "/api/link", { id: "OBA-1", type: "Relates", target: "OBA-2" }, token.token);
      assert.equal(add.status, 200, await add.text());
      const file = join(roots.projectsDir, "OBA", "defined", "OBA-1-one.md");
      assert.match(readFileSync(file, "utf8"), /type: Relates, target: OBA-2/);
      const bad = await post(base, "/api/link", { id: "OBA-1", type: "Nonsense", target: "OBA-2" }, token.token);
      assert.equal(bad.status, 422);
      assert.match((await bad.json()).errors[0], /unknown link type/);
      for (const body of [null, { id: "OBA-1", type: 7, target: "OBA-2" }, { id: "OBA-1", type: "Relates" }]) {
        const r = await post(base, "/api/link", body, token.token);
        assert.equal(r.status, 422, JSON.stringify(body));
        assert.match((await r.json()).errors[0], /must be non-empty strings/);
      }
      const rm = await post(base, "/api/link", { id: "OBA-1", type: "Relates", target: "OBA-2", remove: true }, token.token);
      assert.equal(rm.status, 200);
      assert.doesNotMatch(readFileSync(file, "utf8"), /target: OBA-2/);
    } finally { server.close(); }
  });

  test("POST /api/log honours `date`, so the remote `blaze log --date` is the local one", async () => {
    const roots = gitBoard();
    const { token } = await addUser(roots.dataRoot, { email: "m@example.com", role: "member" });
    const { server, base } = await serve(roots);
    try {
      const r = await post(base, "/api/log", { id: "OBA-1", minutes: 20, date: "2026-02-03", note: "n" }, token.token);
      assert.equal(r.status, 200, await r.text());
      assert.match(readFileSync(join(roots.projectsDir, "OBA", "defined", "OBA-1-one.md"), "utf8"),
                   /date: 2026-02-03, minutes: 20, note: n/);
      for (const date of ["not-a-date", "2026-02-30", "2026-01-01\nresolution: done", 12345]) {
        const bad = await post(base, "/api/log", { id: "OBA-1", minutes: 5, date }, token.token);
        assert.equal(bad.status, 422, JSON.stringify(date));
        assert.match((await bad.json()).errors[0], /a worklog date must be a real YYYY-MM-DD date/);
      }
      assert.doesNotMatch(readFileSync(join(roots.projectsDir, "OBA", "defined", "OBA-1-one.md"), "utf8"),
                          /not-a-date|resolution: done/);
    } finally { server.close(); }
  });
});

test("db mode: /api/new takes its id from the counter and /api/link writes the row; the events say who",
  async () => {
    const roots = dbBoard();
    assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
    const { token } = await addUser(roots.dataRoot, { email: "m@example.com", role: "member" });
    const before = process.env.BLAZE_WRITE_PORT;
    process.env.BLAZE_WRITE_PORT = "db";
    const { server, base } = await serve(roots);
    try {
      const r = await post(base, "/api/new", { project: "ENG", type: "task", title: "from afar", estimate: 15 }, token.token);
      const body = await r.json();
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.deepEqual(body, { ok: true, id: "ENG-2", warnings: body.warnings, db: true },
        "BLZ-254: no committed/queued — the server never commits");
      // A title whose file name would not fit is refused here too, and burns no number.
      const long = await post(base, "/api/new", { project: "ENG", type: "task", title: "x".repeat(300), estimate: 15 }, token.token);
      assert.equal(long.status, 422);
      assert.match((await long.json()).errors[0], /too long to name the ticket's file/);
      const next = await post(base, "/api/new", { project: "ENG", type: "task", title: "next", estimate: 15 }, token.token);
      assert.equal((await next.json()).id, "ENG-3", "the refused create consumed no number from the counter");
      assert.equal(existsSync(join(roots.projectsDir, "ENG", "defined", "ENG-2-from-afar.md")), false,
                   "under db a ticket is a row, never a file");
      const l = await post(base, "/api/link", { id: "ENG-2", type: "Blocks", target: "ENG-1" }, token.token);
      assert.equal(l.status, 200, await l.text());
      const rs = openSqliteRead(shadowDbPath(roots.dataRoot));
      try {
        assert.deepEqual(rs.getTicket(null, "ENG-2").found.frontmatter.links, [{ type: "Blocks", target: "ENG-1" }]);
        const actors = rs.listEvents(null, "ENG-2").map((e) => [e.kind, e.actor, e.source]);
        assert.deepEqual(actors, [["create", "m@example.com (m@example.com initial token)", "api"],
                                  ["edit", "m@example.com (m@example.com initial token)", "api"]]);
      } finally { rs.close(); }
    } finally {
      server.close();
      if (before === undefined) delete process.env.BLAZE_WRITE_PORT; else process.env.BLAZE_WRITE_PORT = before;
    }
  });

const estimateOf = (roots, id) => {
  const rs = openSqliteRead(shadowDbPath(roots.dataRoot));
  try { return rs.getTicket(null, id).found.frontmatter.estimate; } finally { rs.close(); }
};

/** A db-mode board (SQLite shadow) with a member's token, and the server over it. `port`
 *  is the BLAZE_WRITE_PORT the server runs ("dual" for the soak mode). */
async function dbServer(role = "member", port = "db") {
  const roots = dbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const { token } = await addUser(roots.dataRoot, { email: "m@example.com", role });
  const before = process.env.BLAZE_WRITE_PORT;
  process.env.BLAZE_WRITE_PORT = port;
  const { server, base } = await serve(roots);
  const stop = () => {
    server.close();
    if (before === undefined) delete process.env.BLAZE_WRITE_PORT; else process.env.BLAZE_WRITE_PORT = before;
  };
  const has = (id) => {
    const rs = openSqliteRead(shadowDbPath(roots.dataRoot));
    try { return Boolean(rs.getTicket(null, id)?.found); } finally { rs.close(); }
  };
  return { roots, token: token.token, base, stop, has };
}

test("db mode: POST /api/new refuses bad input as a 422 naming why — and burns no id doing it", async () => {
  const { roots, token, base, stop } = await dbServer();
  try {
    const ok = { project: "ENG", type: "task", title: "t", estimate: 30 };
    for (const [body, why] of [
      [{ project: "ENG", type: "task", title: "no estimate" }, /estimate/],
      [{ project: "ENG", type: "nonsense", title: "t" }, /unknown or missing type/],
      [{ project: "ENG", type: "task", estimate: 30 }, /title must be a non-empty string/],
      [{ ...ok, project: "o(" }, /"o\(" is not one this board configures/],
      [{ ...ok, project: "ZZZ" }, /"ZZZ" is not one this board configures \(ENG\)/],
      [{ ...ok, estimate: true }, /estimate must be a number of minutes/],
      [{ ...ok, estimate: 1e12 }, /estimate must be a number of minutes/],
      [{ ...ok, estimate: 0 }, /estimate must be a number of minutes/],
      [{ ...ok, title: "x".repeat(301) }, /title is too long \(300 characters max\)/],
      [{ ...ok, title: "x".repeat(250) }, /title is too long to name the ticket's file/],
      [{ ...ok, title: "x".repeat(300) }, /title is too long to name the ticket's file/],
      [{ ...ok, labels: "a,b" }, /labels must be a list of strings/],
      [{ ...ok, parent: 7 }, /parent must be a string/],
      [null, /the body must be a JSON object/],
    ]) {
      const r = await post(base, "/api/new", body, token);
      assert.equal(r.status, 422, JSON.stringify(body)?.slice(0, 80));
      assert.match((await r.json()).errors.join(" "), why);
    }
    const made = await post(base, "/api/new", { ...ok, estimate: 7.5 }, token);
    assert.equal((await made.json()).id, "ENG-2", "no refused create consumed a number");
    assert.equal(estimateOf(roots, "ENG-2"), roundEstimate(7.5), "7.5 is rounded exactly as `blaze new --estimate 7.5` rounds it");
  } finally { stop(); }
});

test("db mode: POST /api/new with no credential → 401; with a read-scope token → 403; nothing created", async () => {
  const { token, base, stop, has } = await dbServer("viewer");
  try {
    const body = { project: "ENG", type: "task", title: "nope", estimate: 30 };
    assert.equal((await post(base, "/api/new", body)).status, 401);
    const viewer = await post(base, "/api/new", body, token);
    assert.equal(viewer.status, 403);
    assert.match((await viewer.json()).errors[0], /does not carry the 'write' scope/);
    assert.equal(has("ENG-2"), false);
  } finally { stop(); }
});

test("BLZ-691: db mode — POST /api/new carries labels, priority and components onto the row", async () => {
  const { roots, token, base, stop } = await dbServer();
  try {
    const r = await post(base, "/api/new", { project: "ENG", type: "task", title: "labelled", estimate: 30,
                                             priority: "high", labels: ["alpha", "beta"], components: ["core"] }, token);
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    const rs = openSqliteRead(shadowDbPath(roots.dataRoot));
    try {
      const fm = rs.getTicket(null, body.id).found.frontmatter;
      assert.deepEqual([fm.priority, fm.labels, fm.components], ["high", ["alpha", "beta"], ["core"]]);
    } finally { rs.close(); }
  } finally { stop(); }
});

test("BLZ-691: BLAZE_READONLY=1 refuses POST /api/new and /api/link with a 403 — nothing allocated, nothing linked", async () => {
  const { roots, token, base, stop, has } = await dbServer();
  const before = process.env.BLAZE_READONLY;
  process.env.BLAZE_READONLY = "1";
  try {
    for (const [path, body] of [["/api/new", { project: "ENG", type: "task", title: "ro", estimate: 30 }],
                                ["/api/link", { id: "ENG-1", type: "Relates", target: "ENG-1" }]]) {
      const r = await post(base, path, body, token);
      assert.equal(r.status, 403, path);
      assert.match((await r.json()).errors[0], /read-only mode \(BLAZE_READONLY=1\)/, path);
    }
    assert.equal(has("ENG-2"), false);
    const rs = openSqliteRead(shadowDbPath(roots.dataRoot));
    try { assert.deepEqual(rs.getTicket(null, "ENG-1").found.frontmatter.links ?? [], []); } finally { rs.close(); }
    if (before === undefined) delete process.env.BLAZE_READONLY; else process.env.BLAZE_READONLY = before;
    const ok = await post(base, "/api/new", { project: "ENG", type: "task", title: "rw", estimate: 30 }, token);
    assert.equal((await ok.json()).id, "ENG-2", "the read-only refusals consumed no number");
  } finally {
    // Repeats the in-body restore for the failure path: an assertion above throws before it.
    if (before === undefined) delete process.env.BLAZE_READONLY; else process.env.BLAZE_READONLY = before;
    stop();
  }
});

test("BLZ-691: dual mode — POST /api/new is refused 409 like a file board, before anything is allocated", async () => {
  const { roots, token, base, stop, has } = await dbServer("member", "dual");
  try {
    const r = await post(base, "/api/new", { project: "ENG", type: "task", title: "dual", estimate: 30 }, token);
    assert.equal(r.status, 409);
    assert.match((await r.json()).errors[0], /POST \/api\/new needs the database write port \(BLAZE_WRITE_PORT=db\)/);
    assert.equal(has("ENG-2"), false);
    assert.equal(existsSync(join(roots.projectsDir, "ENG", "defined", "ENG-2-dual.md")), false);
  } finally { stop(); }
});
