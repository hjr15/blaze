// tests/model/seed-counter.test.mjs — BLZ-668 / BLZ-669.
//
// The db-mode allocator's counter must sit at or above every number already taken: by a
// ticket file (even one that will not parse), by an `.ids/` claim with no ticket yet, and by
// a row the database holds that no file does. And a seed may only RAISE a counter.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_DDL, SQLITE_PRAGMAS } from "../../scripts/model/sqlite-schema.mjs";
import { fsReadStorage } from "../../scripts/model/read-storage.mjs";
import { writeClaim } from "../../scripts/model/claims.mjs";
import { counterUpsertSql, corpusMaxima, seedCounter } from "../../scripts/model/seed-counter.mjs";
import { createDbSchema } from "../../scripts/model/db-schema-version.mjs";
import { pgExec } from "../../scripts/model/write-port-resolve.mjs";
import { scratchRegistry } from "../helpers/scratch.mjs";
import { PG_SKIP, scratchPgDb, pgClient } from "../helpers/pg-scratch.mjs";

const scratch = scratchRegistry();

function sqliteExec() {
  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_PRAGMAS); db.exec(SQLITE_DDL);
  return {
    run(sql, p = []) { return db.prepare(sql).run(...p); },
    all(sql, p = []) { return db.prepare(sql).all(...p); },
  };
}

const TICKET = (id) => ["---", `id: ${id}`, "title: t", "type: task", "project: ENG",
  "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n");

/** A board with ENG-3 (parseable) and, optionally, ENG-7 whose frontmatter is junk. */
function corpus({ unparseable = false } = {}) {
  const projectsDir = join(scratch(mkdtempSync(join(tmpdir(), "blz668-seed-"))), "projects");
  mkdirSync(join(projectsDir, "ENG", "defined"), { recursive: true });
  writeFileSync(join(projectsDir, "ENG", "defined", "ENG-3-t.md"), TICKET("ENG-3"));
  if (unparseable) writeFileSync(join(projectsDir, "ENG", "defined", "ENG-7-bad.md"), "no frontmatter at all\n");
  return projectsDir;
}

const counter = async (exec, key) =>
  Number((await exec.all("SELECT n FROM project_counter WHERE project_key = '" + key + "'", []))[0]?.n ?? 0);

describe("counterUpsertSql", () => {
  test("sqlite spells never-lower with max(), postgres with GREATEST()", () => {
    assert.match(counterUpsertSql("sqlite"), /SET n = max\(project_counter\.n, excluded\.n\)/);
    assert.match(counterUpsertSql("postgres"), /SET n = GREATEST\(project_counter\.n, excluded\.n\)/);
    assert.throws(() => counterUpsertSql("mysql"), /unknown dialect "mysql"/);
  });
});

describe("corpusMaxima", () => {
  test("corpus only: the highest ticket number per prefix", async () => {
    const m = await corpusMaxima({ projectsDir: corpus(), readStorage: fsReadStorage });
    assert.deepEqual([...m], [["ENG", 3]]);
  });

  test("an unparseable ticket file REFUSES the seed, naming the parse failure — never skipped", async () => {
    // The walk refuses a malformed `.md` by design (index.mjs, BLZ-430/ADR-0031): skipping it
    // would seed BELOW its number and hand that number out again in db mode.
    await assert.rejects(
      corpusMaxima({ projectsDir: corpus({ unparseable: true }), readStorage: fsReadStorage }),
      /missing frontmatter/);
  });

  test("a claim above every ticket raises the maximum — claims-only numbers are taken", async () => {
    const projectsDir = corpus();
    writeClaim(projectsDir, "ENG", 12, "claimed-no-ticket");
    const m = await corpusMaxima({ projectsDir, readStorage: fsReadStorage });
    assert.equal(m.get("ENG"), 12);
  });
});

describe("seedCounter on sqlite", () => {
  test("seeds from the maxima and reports before → after", async () => {
    const exec = sqliteExec();
    const rows = await seedCounter(exec, new Map([["ENG", 12]]), { dialect: "sqlite" });
    assert.deepEqual(rows, [{ project: "ENG", before: 0, after: 12 }]);
    assert.equal(await counter(exec, "ENG"), 12);
  });

  test("table only: a db-mode row no file holds raises the counter", async () => {
    const exec = sqliteExec();
    exec.run(`INSERT INTO ticket (id, project_key, num, type, status, title, body, created_on, updated_on)
              VALUES ('OPS-40', 'OPS', 40, 'task', 'defined', 't', '', '2026-01-01', '2026-01-01')`);
    const rows = await seedCounter(exec, new Map(), { dialect: "sqlite" });
    assert.deepEqual(rows, [{ project: "OPS", before: 0, after: 40 }]);
  });

  test("never lowers a counter already above every source", async () => {
    const exec = sqliteExec();
    exec.run("INSERT INTO project_counter (project_key, n) VALUES ('ENG', 50)");
    const rows = await seedCounter(exec, new Map([["ENG", 12]]), { dialect: "sqlite" });
    assert.deepEqual(rows, [{ project: "ENG", before: 50, after: 50 }]);
    assert.equal(await counter(exec, "ENG"), 50);
  });

  test("idempotent: a second run with no new ids reports before === after", async () => {
    const exec = sqliteExec();
    await seedCounter(exec, new Map([["ENG", 12]]), { dialect: "sqlite" });
    const rows = await seedCounter(exec, new Map([["ENG", 12]]), { dialect: "sqlite" });
    assert.deepEqual(rows, [{ project: "ENG", before: 12, after: 12 }]);
  });
});

test("seedCounter on postgres: seeds, never lowers, idempotent", PG_SKIP, async () => {
  const db = await scratchPgDb("seed");
  const client = await pgClient(db.url);
  try {
    const exec = pgExec(client);
    await createDbSchema(exec, { dialect: "postgres" });
    await exec.run(`INSERT INTO ticket (id, project_key, num, type, status, title, body, created_on, updated_on)
                    VALUES ('OPS-40', 'OPS', 40, 'task', 'defined', 't', '', '2026-01-01', '2026-01-01')`);
    await exec.run("INSERT INTO project_counter (project_key, n) VALUES ('BIG', 99)");
    const first = await seedCounter(exec, new Map([["ENG", 12], ["BIG", 5]]), { dialect: "postgres" });
    assert.deepEqual(first, [
      { project: "BIG", before: 99, after: 99 },
      { project: "ENG", before: 0, after: 12 },
      { project: "OPS", before: 0, after: 40 },
    ]);
    const second = await seedCounter(exec, new Map([["ENG", 12], ["BIG", 5]]), { dialect: "postgres" });
    assert.ok(second.every((r) => r.before === r.after), JSON.stringify(second));
    assert.equal(await counter(exec, "BIG"), 99);
  } finally {
    await client.end();
    await db.drop();
  }
});
