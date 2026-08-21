// tests/write-port-resolve.test.mjs — BLZ-299.
//
// `selectWritePort` existed from BLZ-293 and NOTHING in production called it. The verbs
// each defaulted to their own fsWritePort, so setting BLAZE_WRITE_PORT did exactly
// nothing — a flag that silently does nothing is worse than no flag, because it invites
// you to believe a soak is running when it is not.
//
// These tests are the wiring, and the guarantee that the default never quietly moves.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWritePort, openShadow, logDivergence, shadowDbPath,
         divergenceLogPath, sqliteExec } from "../scripts/model/write-port-resolve.mjs";
import { createDbSchemaSync } from "../scripts/model/db-schema-version.mjs";
import { SQLITE_PRAGMAS } from "../scripts/model/sqlite-schema.mjs";

const root = () => mkdtempSync(join(tmpdir(), "blaze-wpr-"));

async function seededBoard() {
  const dataRoot = root();
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(join(dataRoot, ".blaze"), { recursive: true });
  const db = new DatabaseSync(shadowDbPath(dataRoot));
  db.exec(SQLITE_PRAGMAS);
  createDbSchemaSync(sqliteExec(db));
  db.close();
  return dataRoot;
}

describe("the default is the filesystem, and it opens no database", () => {
  test("unset means fs", async () => {
    const r = await resolveWritePort({ dataRoot: root(), projectsDir: "/x", env: {} });
    assert.equal(r.mode, "fs");
    assert.equal(r.port.name, "fs");
    r.close();
  });

  test("fs does NOT create a shadow database as a side effect", async () => {
    // If merely resolving a port created a database, every `blaze new` on every board
    // would start writing one — which is not a default anyone chose.
    const dataRoot = root();
    const r = await resolveWritePort({ dataRoot, projectsDir: "/x", env: {} });
    r.close();
    assert.equal(existsSync(shadowDbPath(dataRoot)), false);
  });

  test("close() is safe to call for fs, so callers need no special case", async () => {
    const r = await resolveWritePort({ dataRoot: root(), projectsDir: "/x", env: {} });
    r.close();
    r.close();
  });

  test("an unrecognised value is an error, not a fallback in either direction", async () => {
    // Falling back to fs would hide a typo during a soak; falling back to db would be
    // the accident this whole design exists to prevent.
    await assert.rejects(
      resolveWritePort({ dataRoot: root(), projectsDir: "/x", env: { BLAZE_WRITE_PORT: "postgres" } }),
      /is not a write port — expected 'fs', 'dual' or 'db'/);
  });
});

describe("dual and db need a shadow that already exists", () => {
  test("a missing shadow is an instruction, not a silent creation", async () => {
    // BLZ-297: nothing creates schema behind your back. The message names the command.
    await assert.rejects(
      resolveWritePort({ dataRoot: root(), projectsDir: "/x", env: { BLAZE_WRITE_PORT: "dual" } }),
      /no shadow database at .*\n[\s\S]*blaze db init/);
  });

  test("dual resolves to a dual port over the existing shadow", async () => {
    const dataRoot = await seededBoard();
    const r = await resolveWritePort({ dataRoot, projectsDir: join(dataRoot, "projects"),
                                       env: { BLAZE_WRITE_PORT: "dual" } });
    assert.equal(r.mode, "dual");
    assert.match(r.port.name, /^dual\(fs->db\)$/);
    r.close();
  });

  test("db resolves to the database port alone", async () => {
    const dataRoot = await seededBoard();
    const r = await resolveWritePort({ dataRoot, projectsDir: join(dataRoot, "projects"),
                                       env: { BLAZE_WRITE_PORT: "db" } });
    assert.equal(r.mode, "db");
    assert.equal(r.port.name, "db");
    r.close();
  });

  test("openShadow refuses a database this engine cannot read", async () => {
    const dataRoot = root();
    const { DatabaseSync } = await import("node:sqlite");
    mkdirSync(join(dataRoot, ".blaze"), { recursive: true });
    const db = new DatabaseSync(shadowDbPath(dataRoot));
    // Tables, no stamp — an older engine's database, or not a Blaze one at all.
    db.exec("CREATE TABLE ticket (id TEXT PRIMARY KEY)");
    db.close();
    await assert.rejects(openShadow(dataRoot), /no Blaze schema stamp/);
  });
});

describe("divergences go to a file, not to whichever terminal happened to run the verb", () => {
  test("each divergence is one JSON line, timestamped", () => {
    // A soak runs across many separate CLI invocations over days. A divergence printed
    // into scrollback is a divergence nobody will ever total up.
    const dataRoot = root();
    logDivergence(dataRoot, { op: "write", id: "BLZ-1", fields: [{ field: "body" }] },
                  { now: "2026-08-21T00:00:00.000Z" });
    logDivergence(dataRoot, { op: "move", id: "BLZ-2", shadowError: "boom" },
                  { now: "2026-08-21T00:00:01.000Z" });
    const lines = readFileSync(divergenceLogPath(dataRoot), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.at, "2026-08-21T00:00:00.000Z");
    assert.equal(first.id, "BLZ-1");
    assert.equal(JSON.parse(lines[1]).shadowError, "boom");
  });

  test("the log is appended to across calls, never rewritten", () => {
    const dataRoot = root();
    for (let i = 0; i < 5; i++) logDivergence(dataRoot, { op: "write", id: `T-${i}` });
    assert.equal(readFileSync(divergenceLogPath(dataRoot), "utf8").trim().split("\n").length, 5);
  });

  test("a caller can intercept divergences instead of writing them", async () => {
    const dataRoot = await seededBoard();
    const seen = [];
    const r = await resolveWritePort({ dataRoot, projectsDir: join(dataRoot, "projects"),
                                       env: { BLAZE_WRITE_PORT: "dual" },
                                       onDivergence: (d) => seen.push(d) });
    assert.equal(r.mode, "dual");
    r.close();
    assert.equal(existsSync(divergenceLogPath(dataRoot)), false,
      "an intercepted soak must not also write the file");
  });
});

describe("the soak has a denominator (BLZ-300)", () => {
  // "Zero divergences" is not evidence on its own. Zero divergences across zero
  // operations is what an INACTIVE soak looks like, and it is indistinguishable from a
  // perfect one unless something counts the denominator. A week of a forgotten env var
  // would otherwise read as a week of perfect agreement.
  test("counting starts at one and accumulates across separate invocations", async () => {
    const { recordSoakOp, readSoakState } = await import("../scripts/model/write-port-resolve.mjs");
    const dataRoot = root();
    assert.equal(readSoakState(dataRoot), null, "nothing counted before anything runs");
    assert.equal(recordSoakOp(dataRoot, { now: "2026-08-21T00:00:00.000Z" }).operations, 1);
    assert.equal(recordSoakOp(dataRoot, { now: "2026-08-22T00:00:00.000Z" }).operations, 2);
    const s = readSoakState(dataRoot);
    assert.equal(s.operations, 2);
    assert.equal(s.firstAt, "2026-08-21T00:00:00.000Z", "the window's start is kept");
    assert.equal(s.lastAt, "2026-08-22T00:00:00.000Z");
  });

  test("a corrupt counter restarts rather than taking the verb down", async () => {
    // The counter is telemetry. Losing the count is a nuisance; failing the write
    // because telemetry is unreadable would make the instrument the outage.
    const { recordSoakOp, soakStatePath } = await import("../scripts/model/write-port-resolve.mjs");
    const dataRoot = root();
    mkdirSync(join(dataRoot, ".blaze"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(soakStatePath(dataRoot), "not json" + String.fromCharCode(10));
    // The corrupt line still counts as an operation — losing the timestamp is a
    // nuisance, miscounting the denominator is not.
    const s2 = recordSoakOp(dataRoot);
    assert.equal(s2.operations, 2);
    assert.equal(s2.firstAt, "unknown");
  });

  test("a dual port counts every write and move", async () => {
    const { readSoakState } = await import("../scripts/model/write-port-resolve.mjs");
    const dataRoot = await seededBoard();
    const projectsDir = join(dataRoot, "projects");
    mkdirSync(join(projectsDir, "ENG", "defined"), { recursive: true });
    const r = await resolveWritePort({ dataRoot, projectsDir,
                                       env: { BLAZE_WRITE_PORT: "dual" },
                                       onDivergence: () => {} });
    const t = {
      project: "ENG", status: "defined",
      frontmatter: { id: "ENG-1", project: "ENG", type: "task", title: "t",
                     priority: "medium", assignee: "unassigned",
                     created: "2026-01-01", updated: "2026-01-01", links: [] },
      body: "b",
    };
    const w = await r.port.write(t);
    await r.port.move({ ...t, status: "in-progress", currentFile: w.file });
    r.close();
    assert.equal(readSoakState(dataRoot).operations, 2);
  });

  test("the fs port counts nothing — there is no soak to measure", async () => {
    const { readSoakState } = await import("../scripts/model/write-port-resolve.mjs");
    const dataRoot = root();
    const r = await resolveWritePort({ dataRoot, projectsDir: join(dataRoot, "projects"), env: {} });
    r.close();
    assert.equal(readSoakState(dataRoot), null);
  });
});
