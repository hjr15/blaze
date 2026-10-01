// tests/db-runner-pg.test.mjs — BLZ-668 / BLZ-669, the Postgres half of `blaze db`.
//
// Before BLZ-668 `blaze db init` had no Postgres path at all (db-runner.mjs hard-coded
// openShadow and the "sqlite" dialect), so a Postgres project_counter was never seeded and the
// "no Blaze schema — run blaze db init" refusal named a command that could not help. Each test
// gets its OWN scratch database (tests/helpers/pg-scratch.mjs). Run with --test-concurrency=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDb } from "../scripts/db-runner.mjs";
import { resolvePorts, resolveWritePort } from "../scripts/model/write-port-resolve.mjs";
import { writeClaim } from "../scripts/model/claims.mjs";
import { applyNew } from "../scripts/new.mjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dbBoard } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";

const capture = () => {
  const out = [];
  // `env: {}` — runDb's readonly guard must not read an ambient BLAZE_READONLY (BLZ-668).
  const io = { log: (s) => out.push(String(s)), err: (s) => out.push(String(s)), env: {} };
  return { io, text: () => out.join("\n") };
};

/** runDb's injectables, pointed at one scratch database. `opened` counts connections
 *  opened (`n`) and closed (`ended`). */
function pgIo(url, opened = { n: 0, ended: 0 }) {
  return {
    resolveDbConfig: () => ({ driver: "postgres", connection: url }),
    openPostgresClient: async (c) => {
      opened.n++;
      const client = await pgClient(c);
      const end = client.end.bind(client);
      client.end = async () => { opened.ended++; return end(); };
      return client;
    },
  };
}

test("acceptance: Postgres init on an empty database → db-mode applyNew gets max + 1 → re-init refused",
     PG_SKIP, async () => {
  const db = await scratchPgDb("init");
  try {
    const roots = dbBoard();                                   // ENG-1 on disk
    writeClaim(roots.projectsDir, "ENG", 5, "claimed-no-ticket");  // a number taken on the file path
    const c1 = capture();
    assert.equal(await runDb(["init"], { ...c1.io, roots, ...pgIo(db.url) }), 0, c1.text());
    assert.match(c1.text(), /Postgres schema ready at 127\.0\.0\.1\/blz668_init_/);
    assert.match(c1.text(), /ENG\s+0 → 5/);
    assert.match(c1.text(), /tickets were NOT loaded/);

    const ports = await resolvePorts({
      ...roots, env: { BLAZE_WRITE_PORT: "db" },
      resolveDbConfig: () => ({ driver: "postgres", connection: db.url }),
      openPostgresClient: pgClient,
    });
    try {
      const n = await applyNew(roots.projectsDir, {
        project: "ENG", type: "task", title: "after init", today: "2026-09-30",
        extra: { estimate: 15 }, writePort: ports.writePort, readStorage: ports.readStorage,
      });
      assert.equal(n.ok, true, JSON.stringify(n.errors));
      assert.equal(n.id, "ENG-6", "the counter must follow the highest CLAIM, not only the tickets");
    } finally { await ports.close(); }

    const c2 = capture();
    assert.equal(await runDb(["init"], { ...c2.io, roots, ...pgIo(db.url) }), 1);
    assert.match(c2.text(), /already holds a Blaze schema/);
    assert.match(c2.text(), /blaze db seed-counter/);
  } finally { await db.drop(); }
});

test("init that cannot SEED says the schema now exists and names seed-counter; the client is closed",
     PG_SKIP, async () => {
  const db = await scratchPgDb("seedfail");
  try {
    const roots = dbBoard();
    const bad = join(roots.projectsDir, "ENG", "defined", "ENG-7-bad.md");
    writeFileSync(bad, "no frontmatter at all\n");       // the walk refuses it (ADR-0031)
    const opened = { n: 0, ended: 0 };
    const c = capture();
    assert.equal(await runDb(["init"], { ...c.io, roots, ...pgIo(db.url, opened) }), 1);
    assert.match(c.text(), new RegExp(`the schema was created at 127\\.0\\.0\\.1/${db.name}`));
    assert.match(c.text(), /missing frontmatter/);
    assert.match(c.text(), /blaze db seed-counter/);
    assert.doesNotMatch(c.text(), /already initialised/);
    assert.deepEqual(opened, { n: 1, ended: 1 });
  } finally { await db.drop(); }
});

test("init on a database holding FOREIGN tables surfaces that refusal verbatim — not 'already initialised'",
     PG_SKIP, async () => {
  const db = await scratchPgDb("foreign");
  try {
    const client = await pgClient(db.url);
    try { await client.query("CREATE TABLE ticket (x integer)"); } finally { await client.end(); }
    const c = capture();
    assert.equal(await runDb(["init"], { ...c.io, roots: dbBoard(), ...pgIo(db.url) }), 1);
    assert.match(c.text(), /no Blaze schema stamp/);
    assert.doesNotMatch(c.text(), /already initialised|seed-counter/);
  } finally { await db.drop(); }
});

test("init --force is refused on Postgres, before any connection is opened", PG_SKIP, async () => {
  const db = await scratchPgDb("force");
  try {
    const opened = { n: 0 };
    const c = capture();
    assert.equal(await runDb(["init", "--force"], { ...c.io, roots: dbBoard(), ...pgIo(db.url, opened) }), 1);
    assert.match(c.text(), /--force is refused on Postgres/);
    assert.equal(opened.n, 0);
  } finally { await db.drop(); }
});

test("cleanup: resolveWritePort on a REAL empty database refuses, names host/database, closes the client",
     PG_SKIP, async () => {
  const db = await scratchPgDb("refuse");
  try {
    let ended = 0;
    const open = async (url) => {
      const client = await pgClient(url);
      const end = client.end.bind(client);
      client.end = async () => { ended++; return end(); };
      return client;
    };
    await assert.rejects(resolveWritePort({
      ...dbBoard(), env: { BLAZE_WRITE_PORT: "db" },
      resolveDbConfig: () => ({ driver: "postgres", connection: db.url }),
      openPostgresClient: open,
    }), (e) => {
      assert.match(e.message, new RegExp(`the Postgres database 127\\.0\\.0\\.1/${db.name} has no Blaze schema`));
      assert.match(e.message, /blaze db init/);
      assert.doesNotMatch(e.message, /postgres:postgres@/, "the password must never appear");
      return true;
    });
    assert.equal(ended, 1, "the refused client must be closed");
  } finally { await db.drop(); }
});

test("seed-counter on Postgres raises the counter to a new claim and is idempotent", PG_SKIP, async () => {
  const db = await scratchPgDb("seed");
  try {
    const roots = dbBoard();
    assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    writeClaim(roots.projectsDir, "ENG", 20, "handed-out-on-the-file-path");
    const c1 = capture();
    assert.equal(await runDb(["seed-counter"], { ...c1.io, roots, ...pgIo(db.url) }), 0, c1.text());
    assert.match(c1.text(), /ENG\s+1 → 20/);
    const c2 = capture();
    assert.equal(await runDb(["seed-counter"], { ...c2.io, roots, ...pgIo(db.url) }), 0);
    assert.match(c2.text(), /ENG\s+20 → 20/);
  } finally { await db.drop(); }
});

test("seed-counter on an uninitialised Postgres refuses, naming the database and blaze db init",
     PG_SKIP, async () => {
  const db = await scratchPgDb("noschema");
  try {
    const c = capture();
    assert.equal(await runDb(["seed-counter"], { ...c.io, roots: dbBoard(), ...pgIo(db.url) }), 1);
    assert.match(c.text(), new RegExp(`the Postgres database 127\\.0\\.0\\.1/${db.name} has no Blaze schema`));
    assert.match(c.text(), /blaze db init/);
  } finally { await db.drop(); }
});

test("after init could not seed, fixing the cause and running seed-counter finishes the job", PG_SKIP, async () => {
  const db = await scratchPgDb("seedfix");
  try {
    const roots = dbBoard();
    const bad = join(roots.projectsDir, "ENG", "defined", "ENG-7-bad.md");
    writeFileSync(bad, "no frontmatter at all\n");
    assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 1);
    // The operator fixes the file, then finishes with the command the message named.
    writeFileSync(bad, ["---", "id: ENG-7", "title: fixed", "type: task", "project: ENG",
      "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
    const c = capture();
    assert.equal(await runDb(["seed-counter"], { ...c.io, roots, ...pgIo(db.url) }), 0, c.text());
    assert.match(c.text(), /ENG\s+0 → 7/);
  } finally { await db.drop(); }
});
