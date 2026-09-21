// tests/serve-survives-unreadable-board.test.mjs — BLZ-519.
//
// A board file blaze REFUSES to open (a FIFO ticket `.md`, a FIFO `sprints.json`) — or one
// that is malformed — took the WHOLE `blaze serve` PROCESS down, not the route that touched
// it. `serve.mjs`'s request handler is `async`, `/api/live` and `/` called into the model
// with no `try` around either, and an uncaught throw inside an async handler is an unhandled
// rejection, which Node ends the process for. Measured against a real spawned server at
// `44b797f`: one unauthenticated `GET /api/live` → `curl` gets `000`, the process is gone,
// and every other connected session goes with it.
//
// THIS IS NOT A REGRESSION FROM BLZ-493. Before the guard the same board wedged the server
// forever with nothing on stderr, and a loud crash is strictly better than a permanent
// silent wedge. It is a pre-existing crash class that BLZ-493 made VISIBLE, and ADR-0031 §5
// understated it — it said "a throw would take a route down". It took the process down.
//
// EVERY CASE HERE DRIVES A REAL SPAWNED SERVER. An in-process `startServer()` test cannot
// observe this at all: the throw would surface as a rejected promise inside the test
// runner's own process, which is a different thing entirely from what Node does to a
// standalone `node scripts/serve.mjs`.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";

const SERVE = join(import.meta.dirname, "..", "scripts", "serve.mjs");
const fifo = (p) => execFileSync("mkfifo", [p]);
const children = [];

after(() => { for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } } });

/** A one-ticket board the server can actually render. */
function board() {
  const root = mkdtempSync(join(tmpdir(), "blz519-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "BLZ", "backlog"), { recursive: true });
  writeFileSync(join(projects, "BLZ", "backlog", "BLZ-1-t.md"),
    "---\nid: BLZ-1\ntype: task\nproject: BLZ\ntitle: t\n---\n\nbody\n");
  writeFileSync(join(projects, "BLZ", "project.json"), JSON.stringify({ key: "BLZ", codeRepos: [] }));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "BLZ", projects: ["BLZ"] }));
  return { root, projects };
}

/** Spawn `node scripts/serve.mjs` on an ephemeral port and wait for its banner. */
async function serve({ root, projects }) {
  const child = spawn(process.execPath, [SERVE], {
    cwd: root,
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", BLAZE_PROJECTS_DIR: projects },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", (b) => { stdout += b; });
  child.stderr.on("data", (b) => { stderr += b; });
  const port = await new Promise((resolve) => {
    const done = setTimeout(() => resolve(null), 10000);
    const poll = setInterval(() => {
      const m = stdout.match(/http:\/\/[^:\s]+:(\d+)/);
      if (m) { clearInterval(poll); clearTimeout(done); resolve(Number(m[1])); }
    }, 25);
    child.on("exit", () => { clearInterval(poll); clearTimeout(done); resolve(null); });
  });
  assert.ok(port, `the server never announced a port.\nstdout: ${stdout}\nstderr: ${stderr}`);
  return { child, port, out: () => stdout + stderr };
}

/** A bounded GET. `null` means the connection died — which is what a dead server looks
 *  like from the outside, and is never confused here with an error RESPONSE. */
async function get(port, path) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`,
      { signal: AbortSignal.timeout(8000) });
    return { status: res.status, body: await res.text() };
  } catch { return null; }
}

/** Still there? Asked by making a second request AND by looking at the process, because
 *  either one alone can lie: `exitCode === null` is also true of a process that is wedged,
 *  and a refused connection is also what a port in TIME_WAIT looks like. */
async function stillServing(srv) {
  const probe = await get(srv.port, "/api/sync");
  return { alive: srv.child.exitCode === null && srv.child.signalCode === null, probe };
}

describe("BLZ-519: a board file the server cannot read must not end the PROCESS", () => {
  test("/api/live REPORTS a refusing ticket file and the process survives it", async () => {
    const b = board();
    try {
      const srv = await serve(b);
      assert.equal((await get(srv.port, "/api/live")).status, 200, "the healthy board first");

      const bad = join(b.projects, "BLZ", "backlog", "BLZ-2-x.md");
      fifo(bad);

      const res = await get(srv.port, "/api/live");
      assert.ok(res, "the request must get a RESPONSE. `null` here is the connection dying "
        + "under the request, which is the whole defect: the process went with it.");

      // REPORTED, not swallowed. ADR-0030: a run that could not look must not report what a
      // run that looked reports — and `{ groups: [] }` with a 200 is exactly what the Live
      // view renders as "No recent activity."
      assert.notEqual(res.status, 200,
        `a board this run could not read must not come back as a board it read. Got 200: ${res.body}`);
      assert.match(res.body, /unreadable/,
        `the response must carry the condition, not just a status. Got: ${res.body}`);
      assert.ok(res.body.includes(bad),
        `and it must NAME the file it would not open. Got: ${res.body}`);

      const after = await stillServing(srv);
      assert.ok(after.alive,
        "THE PROCESS DIED. One unauthenticated GET against a board with a FIFO ticket file "
        + `ended the server for every connected session.\n${srv.out()}`);
      assert.ok(after.probe, "and it must still answer the NEXT request, not merely not be dead");
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  });

  test("the page route REPORTS a refusing board and the process survives it", async () => {
    const b = board();
    try {
      const srv = await serve(b);
      assert.equal((await get(srv.port, "/")).status, 200, "the healthy board first");

      // `sprints.json`, not a ticket: this enters through `loadSprints` on the PAGE path
      // rather than through `buildIndex`, so it pins the page route's own catch and not a
      // second copy of the case above.
      fifo(join(b.root, "sprints.json"));

      const res = await get(srv.port, "/");
      assert.ok(res, "the page request must get a RESPONSE, not a dead socket");
      assert.notEqual(res.status, 200,
        `a board that could not be read must not render as a board. Got 200: ${res.body.slice(0, 300)}`);
      assert.ok(res.body.includes("sprints.json"),
        `the page must NAME the file it could not read. Got: ${res.body.slice(0, 500)}`);

      const after = await stillServing(srv);
      assert.ok(after.alive,
        `THE PROCESS DIED on a page request over an unreadable board.\n${srv.out()}`);
      assert.ok(after.probe, "and it must still answer the next request");
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  });

  test("a MALFORMED ticket file is the same class, and also must not end the process", async () => {
    const b = board();
    try {
      const srv = await serve(b);
      assert.equal((await get(srv.port, "/api/live")).status, 200, "the healthy board first");

      // Not a refusal — a regular file `parseTicket` THROWS on: no `---` on line 1, which
      // is `ticket.mjs`'s one hard refusal. The ticket names both shapes, and they reach
      // the handler by the same route: an uncaught throw in an async handler. A fix that
      // caught only `NotARegularFileError` would leave this one, and it is here to fail
      // if one does.
      writeFileSync(join(b.projects, "BLZ", "backlog", "BLZ-3-m.md"),
        "id: BLZ-3\ntype: task\nproject: BLZ\ntitle: no frontmatter delimiter\n");

      const res = await get(srv.port, "/api/live");
      assert.ok(res, "the request must get a RESPONSE, not a dead socket");
      const after = await stillServing(srv);
      assert.ok(after.alive,
        `THE PROCESS DIED on a malformed ticket file.\n${srv.out()}`);
      assert.ok(after.probe, "and it must still answer the next request");
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  });
});
