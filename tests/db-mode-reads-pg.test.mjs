// tests/db-mode-reads-pg.test.mjs — BLZ-670.
//
// The Postgres twin of tests/db-mode-reads.test.mjs. That file proves the split-brain fix
// end to end against the real runners (fs corpus seeded, SQLite db mode); this file proves
// the same resolved-seam contract — resolvePorts, applyMove, applyNew — against a REAL
// Postgres, in process rather than through subprocess runners, since the shape under test is
// resolvePorts' postgres branch specifically (openPostgresClient injection, postgresReader).
//
// Gated exactly like tests/model/driver-conformance.test.mjs: SKIPPED when
// BLAZE_TEST_PG_URL is unset locally, a hard CI failure when it is unset under CI — see the
// footer at the bottom of that file for why (a silently-dropped Postgres service must not
// stay green).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePorts } from "../scripts/model/write-port-resolve.mjs";
import { applyMove } from "../scripts/move.mjs";
import { applyNew } from "../scripts/new.mjs";
import { dbBoard } from "./helpers/db-board.mjs";

const PG = process.env.BLAZE_TEST_PG_URL ?? null;

async function openPostgresClient(connection) {
  const pg = (await import("pg")).default;
  const client = new pg.Client(connection);
  await client.connect();
  return client;
}

if (PG) {
  test("BLZ-670: db-mode reads through resolvePorts against Postgres — applyMove then applyNew", async () => {
    // Seed via openPostgresRead({ create: true }), exactly like driver-conformance's seedPg,
    // then close the seeding reader before resolvePorts opens its own client.
    const { openPostgresRead } = await import("../scripts/model/pg-storage.mjs");
    const seed = await openPostgresRead(PG, { create: true });
    try {
      // project_counter is included: a rerun would otherwise conflict on its primary key.
      await seed.client.query(
        "TRUNCATE ticket_event, ticket_link, acceptance_criterion, worklog_entry, project_counter, ticket CASCADE");
      await seed.client.query(
        `INSERT INTO ticket (id,project_key,num,type,status,title,parent_id,parent_type,body,created_on,updated_on)
         VALUES ('ENG-1','ENG',1,'task','defined','A task',NULL,NULL,'body of ENG-1','2026-01-01','2026-01-01')`);
      await seed.client.query("INSERT INTO project_counter (project_key, n) VALUES ('ENG', 1)");
    } finally {
      await seed.close();
    }

    const { dataRoot, projectsDir } = dbBoard();
    const { writePort, readStorage, close } = await resolvePorts({
      dataRoot, projectsDir, env: { BLAZE_WRITE_PORT: "db" },
      resolveDbConfig: () => ({ driver: "postgres", connection: PG }),
      openPostgresClient: async (c) => openPostgresClient(c),
    });
    try {
      const m1 = await applyMove(projectsDir, "ENG-1", "in-progress", { writePort, readStorage });
      assert.equal(m1.ok, true, JSON.stringify(m1.errors));
      const m2 = await applyMove(projectsDir, "ENG-1", "in-review", { writePort, readStorage });
      assert.equal(m2.ok, true, JSON.stringify(m2.errors));
      assert.equal((await readStorage.getTicket(null, "ENG-1")).found.status, "in-review");

      const n = await applyNew(projectsDir, {
        project: "ENG", type: "task", title: "B task", writePort, readStorage, today: "2026-09-29", extra: { estimate: 15 },
      });
      assert.equal(n.ok, true, JSON.stringify(n.errors));
      assert.equal(n.id, "ENG-2");
      assert.equal((await readStorage.getTicket(null, "ENG-2")).found?.frontmatter.id, "ENG-2");
    } finally {
      await close();
    }
  });
} else if (process.env.CI) {
  // Deleting the service container or its env var would otherwise drop this proof to zero
  // coverage and stay green — the suite would still claim db-mode reads work against
  // Postgres while quietly not checking. Make that loud, same as driver-conformance's guard.
  test("postgres db-mode reads: BLAZE_TEST_PG_URL must be set in CI", () => {
    assert.fail(
      "BLAZE_TEST_PG_URL is unset under CI. The tests workflow provisions a Postgres "
      + "service so this file proves resolvePorts/applyMove/applyNew against it too; if "
      + "that service or its env var was removed, restore it rather than letting this "
      + "twin go untested.");
  });
} else {
  test("postgres db-mode reads: SKIPPED — set BLAZE_TEST_PG_URL to run it", { skip: true }, () => {});
}
