// tests/event-actor.test.mjs — BLZ-348, ADR-0013 §6: "every event records who".
//
// `ticket_event.actor` has existed since the first schema with a default of 'unknown',
// both drivers read and write it, and NOTHING ever set it — the column was plumbing
// with no source. This wires it to the authenticated principal.
//
// Honest scope, stated here so nobody reads more into the green: `ticket_event` lives
// in the DATABASE. A board running the default `fs` write port has no event log at all,
// so there is nothing to attribute; the actor is threaded to the port that owns the
// table, and to nowhere else.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_DDL, SQLITE_PRAGMAS } from "../scripts/model/sqlite-schema.mjs";
import { dbWritePort } from "../scripts/model/write-port.mjs";
import { openShadow } from "../scripts/model/write-port-resolve.mjs";
import { applyEdit } from "../scripts/edit.mjs";
import { actorFor } from "../scripts/model/identity.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { startServer, CSRF } from "../scripts/serve.mjs";

function sqliteExec() {
  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_PRAGMAS); db.exec(SQLITE_DDL);
  return {
    run(sql, p = []) { return db.prepare(sql).run(...p); },
    all(sql, p = []) { return db.prepare(sql).all(...p); },
    _db: db,
  };
}

const TICKET = (over = {}) => ({
  project: "BLZ", status: "defined",
  frontmatter: {
    id: "BLZ-1", project: "BLZ", type: "task", title: "A task", priority: "medium",
    resolution: "", parent: "", assignee: "unassigned", estimate: 60, sprint: "",
    start: "", due: "", created: "2026-01-01", updated: "2026-01-01", links: [],
  },
  body: "the body",
  ...over,
});

describe("the database write port records who did it", () => {
  test("a first write is a `create` event, and it carries the actor it was given", async () => {
    const exec = sqliteExec();
    const port = dbWritePort(exec);
    await port.write(TICKET(), { actor: "ada@example.com (cli)", source: "api" });
    const rows = exec.all("SELECT kind, actor, source FROM ticket_event WHERE ticket_id = ?", ["BLZ-1"]);
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0] }, { kind: "create", actor: "ada@example.com (cli)", source: "api" });
  });

  test("with no actor supplied the column keeps its historic 'unknown'", async () => {
    const exec = sqliteExec();
    const port = dbWritePort(exec);
    await port.write(TICKET());
    const rows = exec.all("SELECT kind, actor, source FROM ticket_event WHERE ticket_id = ?", ["BLZ-1"]);
    assert.deepEqual({ ...rows[0] }, { kind: "create", actor: "unknown", source: "cli" });
  });

  test("a status change is a `transition` event with both statuses", async () => {
    const exec = sqliteExec();
    const port = dbWritePort(exec);
    await port.write(TICKET(), { actor: "a@b.c (t)" });
    await port.move({ ...TICKET(), status: "in-progress" }, { actor: "a@b.c (t)" });
    const rows = exec.all(
      "SELECT kind, from_status, to_status, actor FROM ticket_event WHERE ticket_id = ? ORDER BY id",
      ["BLZ-1"]);
    assert.equal(rows.length, 2);
    assert.deepEqual({ ...rows[1] },
      { kind: "transition", from_status: "defined", to_status: "in-progress", actor: "a@b.c (t)" });
  });

  test("a re-write of an existing ticket is an `edit`", async () => {
    const exec = sqliteExec();
    const port = dbWritePort(exec);
    await port.write(TICKET());
    await port.write(TICKET({ frontmatter: { ...TICKET().frontmatter, priority: "high" } }),
      { actor: "editor@example.com (tok)" });
    const rows = exec.all("SELECT kind, actor FROM ticket_event WHERE ticket_id = ? ORDER BY id", ["BLZ-1"]);
    assert.deepEqual({ ...rows[1] }, { kind: "edit", actor: "editor@example.com (tok)" });
  });
});

describe("the verbs pass the actor through to the port", () => {
  test("applyEdit forwards opts.actor as the port's context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blaze-actor-"));
    mkdirSync(join(dir, "BLZ", "defined"), { recursive: true });
    writeFileSync(join(dir, "BLZ", "defined", "BLZ-1.md"),
      ["---", "id: BLZ-1", "title: t", "type: task", "project: BLZ", "priority: medium",
       "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));

    const seen = [];
    const spy = {
      name: "spy",
      exists: () => true,
      write(t, ctx) { seen.push(ctx); return { file: "handle" }; },
      move(t, ctx) { seen.push(ctx); return { file: "handle" }; },
      read: () => null,
    };
    const r = await applyEdit(dir, "BLZ-1", { priority: "high" },
      { writePort: spy, actor: "someone@example.com (board)", source: "api" });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(seen, [{ actor: "someone@example.com (board)", source: "api" }]);
  });
});

describe("actorFor names the principal, and 'unknown' when there is none", () => {
  test("a principal becomes email (token name)", () => {
    assert.equal(actorFor({ email: "a@b.c", tokenName: "laptop" }), "a@b.c (laptop)");
    assert.equal(actorFor(null), "unknown");
  });
});

describe("end to end: an authenticated board write lands the principal in ticket_event", () => {
  test("POST /api/edit with an admin token records that admin as the actor", async () => {
    const root = mkdtempSync(join(tmpdir(), "blaze-actor-e2e-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", root, "config", "user.name", "t"]);
    const projects = join(root, "projects");
    mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
    writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
      ["---", "id: OBA-1", "title: t", "type: task", "project: OBA", "priority: medium",
       "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);

    // The shadow database is where ticket_event lives. Create it, then let the server
    // write through the dual port so the filesystem still decides the outcome.
    const made = await openShadow(root, { create: true });
    made.db.close();

    const { token } = await addUser(root, { email: "boss@example.com", role: "admin" });
    const before = process.env.BLAZE_WRITE_PORT;
    process.env.BLAZE_WRITE_PORT = "dual";
    const server = startServer({ port: 0, root, projectsDir: projects });
    await new Promise((res) => server.once("listening", res));
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/edit`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-blaze-csrf": CSRF,
                   authorization: `Bearer ${token.token}` },
        body: JSON.stringify({ id: "OBA-1", patch: { priority: "high" } }),
      });
      assert.equal(r.status, 200, JSON.stringify(await r.json().catch(() => ({}))));
    } finally {
      server.close();
      if (before === undefined) delete process.env.BLAZE_WRITE_PORT;
      else process.env.BLAZE_WRITE_PORT = before;
    }

    const shadow = await openShadow(root);
    const rows = shadow.exec.all("SELECT actor, source FROM ticket_event WHERE ticket_id = ?", ["OBA-1"]);
    shadow.db.close();
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0] }, { actor: "boss@example.com (boss@example.com initial token)", source: "api" });
  });
});
