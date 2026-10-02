// tests/read-storage-resolve.test.mjs — BLZ-670. Reads resolve from the WRITE mode, never
// independently from database.driver (BLZ-667 Task 9's bug, one layer over).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveReadStorage, resolvePorts, withReadStorage, shadowDbPath }
  from "../scripts/model/write-port-resolve.mjs";
import { fsReadStorage } from "../scripts/model/read-storage.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
function board() {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz670-resolve-")));
  const projectsDir = join(dataRoot, "projects");
  mkdirSync(join(projectsDir, "ENG", "defined"), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"), JSON.stringify({ projects: ["ENG"], schemaVersion: 2 }));
  return { dataRoot, projectsDir };
}
const PG = { driver: "postgres", connection: { host: "h", port: 5432, database: "d", user: "u", password: "p" } };
const stampedClient = (log = []) => ({
  async query(sql) {
    log.push(sql);
    if (sql.includes("information_schema.tables")) return { rows: [{ hit: 1 }] };
    if (sql.includes("blaze_meta")) return { rows: [{ value: "5" }] };
    return { rows: [] };
  },
  async end() { log.push("END"); },
});
const pgOpts = (log) => ({ env: { BLAZE_WRITE_PORT: "db" }, resolveDbConfig: () => PG,
                           openPostgresClient: async () => stampedClient(log) });

describe("resolveReadStorage", () => {
  test("fs and unset read the filesystem and open nothing", async () => {
    for (const env of [{}, { BLAZE_WRITE_PORT: "fs" }]) {
      const r = await resolveReadStorage({ ...board(), env });
      assert.equal(r.readStorage, fsReadStorage);
      assert.equal(r.mode, "fs");
      await r.close();
    }
  });

  test("dual reads the filesystem, because the filesystem decides dual's outcomes", async () => {
    const r = await resolveReadStorage({ ...board(), env: { BLAZE_WRITE_PORT: "dual" } });
    assert.equal(r.readStorage, fsReadStorage);
    assert.equal(r.mode, "dual");
  });

  test("db on sqlite reads the shadow", async () => {
    const roots = board();
    assert.equal(0, await runDb(["init"], { log() {}, err() {}, env: {}, roots }));
    const r = await resolveReadStorage({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
    assert.equal(r.readStorage.name, "sqlite");
    await r.close();
  });

  test("db on sqlite with no shadow refuses by name and creates no file", async () => {
    const roots = board();
    await assert.rejects(resolveReadStorage({ ...roots, env: { BLAZE_WRITE_PORT: "db" } }), /blaze db init/);
    assert.equal(existsSync(shadowDbPath(roots.dataRoot)), false);
  });

  test("db on postgres reads postgres and closes its client", async () => {
    const log = [];
    const r = await resolveReadStorage({ ...board(), ...pgOpts(log) });
    assert.equal(r.readStorage.name, "postgres");
    await r.close();
    assert.equal(log.at(-1), "END");
  });

  test("an empty postgres schema is refused and the socket closed", async () => {
    const log = [];
    const empty = { async query() { return { rows: [] }; }, async end() { log.push("END"); } };
    await assert.rejects(resolveReadStorage({ ...board(), env: { BLAZE_WRITE_PORT: "db" },
      resolveDbConfig: () => PG, openPostgresClient: async () => empty }), /no Blaze schema/);
    assert.deepEqual(log, ["END"]);
  });

  test("an unknown mode refuses with the write side's message", async () => {
    await assert.rejects(resolveReadStorage({ ...board(), env: { BLAZE_WRITE_PORT: "postgres" } }),
      /is not a write port/);
  });
});

describe("resolvePorts: one resolution, one source", () => {
  test("postgres read and write share ONE client, closed once", async () => {
    let opened = 0; const log = [];
    const r = await resolvePorts({ ...board(), env: { BLAZE_WRITE_PORT: "db" }, resolveDbConfig: () => PG,
      openPostgresClient: async () => { opened++; return stampedClient(log); } });
    assert.equal(opened, 1);
    assert.equal(r.writePort.name, "db");
    assert.equal(r.readStorage.name, "postgres");
    await r.close();
    assert.equal(log.filter((s) => s === "END").length, 1);
  });

  test("db on sqlite: both ports over the shadow, closed together", async () => {
    const roots = board();
    assert.equal(0, await runDb(["init"], { log() {}, err() {}, env: {}, roots }));
    const r = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
    assert.equal(r.readStorage.name, "sqlite");
    assert.equal(r.writePort.name, "db");
    await r.close();
  });

  test("fs mode returns the fs reader and an fs port", async () => {
    const r = await resolvePorts({ ...board(), env: {} });
    assert.equal(r.readStorage, fsReadStorage);
    assert.equal(r.mode, "fs");
    await r.close();
  });
});

describe("withReadStorage", () => {
  test("closes the reader even when the body throws", async () => {
    const log = [];
    await assert.rejects(withReadStorage({ ...board(), ...pgOpts(log) },
      async () => { throw new Error("boom"); }), /boom/);
    assert.equal(log.at(-1), "END");
  });

  test("tags a RESOLUTION failure, not a failure inside the body", async () => {
    const e1 = await withReadStorage({ ...board(), env: { BLAZE_WRITE_PORT: "db" } }, async () => {}).catch((e) => e);
    assert.equal(e1.blazeResolve, true);
    const e2 = await withReadStorage({ ...board(), env: {} }, async () => { throw new Error("read"); }).catch((e) => e);
    assert.equal(e2.blazeResolve, undefined);
  });
});
