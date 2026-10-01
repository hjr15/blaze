// tests/import-db-mode.test.mjs — BLZ-671 + BLZ-672.
//
// BLZ-671: `applyImport` allocated with ids.mjs and wrote an `.ids/` claim directly, so a
// db-mode import took numbers from the FILE ledger while db-mode `new` took them from
// `project_counter` — the two collide. Now both go through the port (`allocate`, `reserve`).
// BLZ-672: a db-mode import row with no `created` bound undefined to `created_on NOT NULL`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDb } from "../scripts/db-runner.mjs";
import { resolvePorts } from "../scripts/model/write-port-resolve.mjs";
import { applyNew } from "../scripts/new.mjs";
import { runImport } from "../scripts/model/import-apply.mjs";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { writeCsv } from "../scripts/model/csv.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";

const isoToday = () => new Date().toISOString().slice(0, 10);

function csvAt(dataRoot, name, ...rows) {
  const p = join(dataRoot, `${name}.csv`);
  const base = { schema_version: "1", project: "ENG", type: "task", status: "defined",
                 description: "body", estimate: "30" };
  writeFileSync(p, writeCsv([COLUMN_NAMES.slice(),
    ...rows.map((r) => COLUMN_NAMES.map((n) => ({ ...base, ...r })[n] ?? ""))]));
  return p;
}

test("sqlite db mode: an imported row with no `created` lands with today's date; one with a date keeps it",
     async () => {
  const roots = dbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    const d0 = isoToday();
    const r = await runImport({
      projectsDir: roots.projectsDir, dataRoot: roots.dataRoot, apply: true,
      writePort: ports.writePort, readStorage: ports.readStorage, stage: () => ({ ok: true, queued: true }),
      file: csvAt(roots.dataRoot, "dates",
        { id: "ENG-7", title: "no dates" },
        { id: "ENG-8", title: "dated", created: "2026-01-02", updated: "2026-01-03" }),
    });
    assert.equal(r.exitCode, 0, r.report);
    const undated = (await ports.readStorage.getTicket(null, "ENG-7")).found.frontmatter;
    assert.ok([d0, isoToday()].includes(undated.created), `created=${undated.created}`);
    assert.equal(undated.updated, undated.created);
    const dated = (await ports.readStorage.getTicket(null, "ENG-8")).found.frontmatter;
    assert.equal(dated.created, "2026-01-02");
    assert.equal(dated.updated, "2026-01-03");
  } finally { await ports.close(); }
});
