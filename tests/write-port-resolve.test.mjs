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
import { execFileSync } from "node:child_process";
import { resolveWritePort, resolveWriteMode, openShadow, logDivergence, shadowDbPath,
         divergenceLogPath, sqliteExec, pgExec } from "../scripts/model/write-port-resolve.mjs";
import { createDbSchemaSync } from "../scripts/model/db-schema-version.mjs";
import { sqliteAttachConfig, configDbPathFor } from "../scripts/model/config-schema.mjs";
import { SQLITE_PRAGMAS } from "../scripts/model/sqlite-schema.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

// BLZ-503: every scratch directory this file mints, removed when the file is done with
// it. Registered rather than written as a test's trailing statement, so a failing
// assertion earlier in the test cannot skip it.
const scratch = scratchRegistry();

const root = () => scratch(mkdtempSync(join(tmpdir(), "blaze-wpr-")));

async function seededBoard() {
  const dataRoot = root();
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(join(dataRoot, ".blaze"), { recursive: true });
  const db = new DatabaseSync(shadowDbPath(dataRoot));
  db.exec(SQLITE_PRAGMAS);
  // BLZ-377: hand-rolling an opener means hand-rolling its ATTACH too. `createDbSchemaSync`
  // refuses without it rather than silently putting the config in memory.
  db.exec(sqliteAttachConfig(configDbPathFor(shadowDbPath(dataRoot))));
  createDbSchemaSync(sqliteExec(db));
  db.close();
  return dataRoot;
}

describe("resolveWriteMode reads BLAZE_WRITE_PORT synchronously, with no database touched", () => {
  test("resolveWriteMode reads BLAZE_WRITE_PORT synchronously, defaulting to fs", () => {
    assert.equal(resolveWriteMode({}), "fs");
    assert.equal(resolveWriteMode({ BLAZE_WRITE_PORT: "db" }), "db");
    assert.equal(resolveWriteMode({ BLAZE_WRITE_PORT: "dual" }), "dual");
  });
});

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

describe("resolveWritePort opens real Postgres when database.driver is postgres", () => {
  // A fake client whose schema looks stamped at the current version — the tests below
  // that need a REFUSAL build their own fake with a different answer to these same queries.
  const stampedCurrentClient = () => ({
    async query(sql) {
      if (sql.includes("information_schema.tables")) return { rows: [{ hit: 1 }] };
      if (sql.includes("blaze_meta")) return { rows: [{ value: "5" }] };
      return { rows: [] };
    },
    async end() {},
  });

  test("resolveWritePort opens Postgres when configured, not the SQLite shadow", async () => {
    const calls = [];
    const client = stampedCurrentClient();
    const fakeOpenPostgresClient = async (conn) => { calls.push(conn); return client; };
    const { port, mode, close } = await resolveWritePort({
      dataRoot: "/tmp/does-not-matter", projectsDir: "/tmp/does-not-matter/projects",
      env: { BLAZE_WRITE_PORT: "db" },
      resolveDbConfig: () => ({ driver: "postgres",
                                 connection: { host: "h", port: 5432, database: "d", user: "u", password: "p" } }),
      openPostgresClient: fakeOpenPostgresClient,
    });
    assert.equal(calls.length, 1);
    assert.equal(port.name, "db");
    await close();
  });

  test("an empty Postgres database is refused, not silently written through", async () => {
    const ended = [];
    const client = {
      async query() { return { rows: [] }; }, // no tables at all — judgeDbSchema's "empty" state
      async end() { ended.push(true); },
    };
    await assert.rejects(
      () => resolveWritePort({
        dataRoot: "/tmp/does-not-matter", projectsDir: "/tmp/does-not-matter/projects",
        env: { BLAZE_WRITE_PORT: "db" },
        resolveDbConfig: () => ({ driver: "postgres",
                                   connection: { host: "h", port: 5432, database: "d", user: "u", password: "p" } }),
        openPostgresClient: async () => client,
      }),
      /no Blaze schema/,
    );
    assert.deepEqual(ended, [true]); // the socket is live the moment connect() returns — must close on refusal
  });

  test("a Postgres database stamped below this engine's floor is refused, not written through", async () => {
    const ended = [];
    const client = {
      async query(sql) {
        if (sql.includes("information_schema.tables")) return { rows: [{ hit: 1 }] };
        if (sql.includes("blaze_meta")) return { rows: [{ value: "4" }] }; // below MIN_DB_SCHEMA_VERSION
        return { rows: [] };
      },
      async end() { ended.push(true); },
    };
    await assert.rejects(
      () => resolveWritePort({
        dataRoot: "/tmp/does-not-matter", projectsDir: "/tmp/does-not-matter/projects",
        env: { BLAZE_WRITE_PORT: "db" },
        resolveDbConfig: () => ({ driver: "postgres",
                                   connection: { host: "h", port: 5432, database: "d", user: "u", password: "p" } }),
        openPostgresClient: async () => client,
      }),
      /older than this engine supports/,
    );
    assert.deepEqual(ended, [true]);
  });
});

describe("pgExec mirrors sqliteExec's shape, over a caller-supplied client", () => {
  test("pgExec.all returns rows from client.query", async () => {
    const calls = [];
    const fakeClient = {
      async query(sql, params) {
        calls.push([sql, params]);
        return { rows: [{ n: 1 }] };
      },
    };
    const exec = pgExec(fakeClient);
    const rows = await exec.all("SELECT $1 AS n", [1]);
    assert.deepEqual(rows, [{ n: 1 }]);
    assert.deepEqual(calls, [["SELECT $1 AS n", [1]]]);
  });

  test("pgExec.run executes without returning rows", async () => {
    const fakeClient = { async query() { return { rows: [] }; } };
    const exec = pgExec(fakeClient);
    await assert.doesNotReject(() => exec.run("SELECT 1", []));
  });
});

// BLZ-671: every fs port the resolver builds can RESERVE an explicit id, and import's
// `remoteClaims: false` never reaches the network — the allocate claim is never provisional.
describe("fsAllocators via resolveWritePort (BLZ-671)", () => {
  // A git worktree (allocateId reserves under its common dir) whose remote cannot be reached:
  // a FETCHING allocator reads `null` there and marks its claim provisional.
  const gitRoot = () => {
    const dataRoot = root();
    execFileSync("git", ["-C", dataRoot, "init", "-q"]);
    execFileSync("git", ["-C", dataRoot, "remote", "add", "origin", "/nonexistent/blz671.git"]);
    return dataRoot;
  };

  test("the fs port reserves an explicit id: the claim is written under the given project", async () => {
    const dataRoot = root();
    const { port } = await resolveWritePort({ dataRoot, projectsDir: join(dataRoot, "projects"), env: {} });
    const { claimFile } = await port.reserve("BLZ-900", { project: "BLZ", title: "Explicit high" });
    assert.equal(claimFile, join(dataRoot, "projects", "BLZ", ".ids", "900"));
    assert.equal(readFileSync(claimFile, "utf8"), "BLZ-900 explicit-high\n");
  });

  test("remoteClaims: false allocates with the known-empty remote — never provisional", async () => {
    const dataRoot = gitRoot();
    const { port } = await resolveWritePort({ dataRoot, projectsDir: join(dataRoot, "projects"),
                                              env: {}, remoteClaims: false });
    const { id, claimFile } = await port.allocate("BLZ", { title: "t" });
    assert.equal(id, "BLZ-1");
    assert.equal(readFileSync(claimFile, "utf8"), "BLZ-1 t\n");
  });

  test("control: the default (remoteClaims: true) on the same board IS provisional", async () => {
    const dataRoot = gitRoot();
    const { port } = await resolveWritePort({ dataRoot, projectsDir: join(dataRoot, "projects"), env: {} });
    const { claimFile } = await port.allocate("BLZ", { title: "t" });
    assert.equal(readFileSync(claimFile, "utf8"), "BLZ-1 t provisional\n");
  });
});
