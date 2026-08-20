// tests/model/driver-conformance.test.mjs — BLZ-282.
//
// ONE suite, every driver. This is Phase 1's headline criterion — "the same
// acceptance suite passes against SQLite and Postgres" — and the reason it can exist
// at all is that every assertion `await`s.
//
// `await` on a plain value is a no-op, so these identical assertions run unchanged
// against the SYNC filesystem and SQLite drivers and against the ASYNC Postgres one.
// That is what makes ADR-0010's split workable: the transitional fs seam stays sync,
// the v3 port is async, and one suite still holds both to the same semantics.
//
// Postgres is skipped rather than failed when unreachable — CI has no server, and a
// suite that goes red on infrastructure absence teaches people to ignore it. When it
// IS reachable the assertions are identical, not merely similar.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsReadStorage, memReadStorage } from "../../scripts/model/read-storage.mjs";
import { openSqliteRead } from "../../scripts/model/sqlite-storage.mjs";

const PG = process.env.BLAZE_TEST_PG_URL ?? null;

// One logical corpus, built four ways. If a driver cannot represent it, that is the
// finding — which is why the seeds are written per driver rather than shared through
// a lowest-common-denominator abstraction.
const CORPUS = [
  { id: "BLZ-1", num: 1, status: "defined", parent: "", links: [{ type: "Blocks", target: "BLZ-1" }] },
  { id: "BLZ-2", num: 2, status: "defined", parent: "BLZ-1", links: [{ type: "Blocks", target: "BLZ-1" }] },
  { id: "BLZ-3", num: 3, status: "done", parent: "BLZ-1", links: [{ type: "Blocks", target: "BLZ-1" }] },
  { id: "BLZ-4", num: 4, status: "defined", parent: "", links: [{ type: "Relates", target: "BLZ-1" }] },
];

function seedFs() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-conf-"));
  for (const t of CORPUS) {
    mkdirSync(join(dir, "BLZ", t.status), { recursive: true });
    writeFileSync(join(dir, "BLZ", t.status, `${t.id}-x.md`),
      ["---", `id: ${t.id}`, `title: ${t.id} title`, "type: task", "project: BLZ",
       `parent: ${t.parent}`, "links:",
       ...t.links.map((l) => `  - { type: ${l.type}, target: ${l.target} }`),
       "---", "", `body of ${t.id}`, ""].join("\n"));
  }
  return { s: fsReadStorage, root: dir };
}

function seedMem() {
  return { s: memReadStorage(CORPUS.map((t) => ({
    frontmatter: { id: t.id, title: `${t.id} title`, type: "task", project: "BLZ",
                   parent: t.parent, links: t.links },
    body: `body of ${t.id}`, project: "BLZ", status: t.status, file: t.id,
  }))), root: null };
}

function seedSqlite() {
  const s = openSqliteRead();
  const ins = s.db.prepare(
    `INSERT INTO ticket (id,project_key,num,type,status,title,parent_id,parent_type,body,created_on,updated_on)
     VALUES (?,'BLZ',?,'task',?,?,?,?,?,'2026-01-01','2026-01-01')`);
  const link = s.db.prepare("INSERT INTO ticket_link VALUES (?,?,?)");
  for (const t of CORPUS)
    ins.run(t.id, t.num, t.status, `${t.id} title`, t.parent || null, t.parent ? "task" : null, `body of ${t.id}`);
  for (const t of CORPUS) for (const l of t.links) link.run(t.id, l.type, l.target);
  return { s, root: null };
}

async function seedPg() {
  const { openPostgresRead } = await import("../../scripts/model/pg-storage.mjs");
  const s = await openPostgresRead(PG);
  await s.client.query("TRUNCATE ticket_event, ticket_link, acceptance_criterion, worklog_entry, ticket CASCADE");
  for (const t of CORPUS)
    await s.client.query(
      `INSERT INTO ticket (id,project_key,num,type,status,title,parent_id,parent_type,body,created_on,updated_on)
       VALUES ($1,'BLZ',$2,'task',$3,$4,$5,$6,$7,'2026-01-01','2026-01-01')`,
      [t.id, t.num, t.status, `${t.id} title`, t.parent || null, t.parent ? "task" : null, `body of ${t.id}`]);
  for (const t of CORPUS) for (const l of t.links)
    await s.client.query("INSERT INTO ticket_link VALUES ($1,$2,$3)", [t.id, l.type, l.target]);
  return { s, root: null };
}

/** Every assertion the contract makes. Awaited, so sync and async drivers both pass. */
async function conformance(make, name) {
  await test(`${name}: getTicket resolves by id, with status and body`, async () => {
    const { s, root } = await make();
    const r = await s.getTicket(root, "BLZ-2");
    assert.equal(r.found?.frontmatter.id, "BLZ-2");
    assert.equal(r.found.status, "defined");
    assert.match(r.found.body, /body of BLZ-2/);
    await s.close?.();
  });

  await test(`${name}: getTicket returns found:null for an unknown id`, async () => {
    const { s, root } = await make();
    assert.equal((await s.getTicket(root, "BLZ-999")).found, null);
    await s.close?.();
  });

  await test(`${name}: records carry project and status first-class`, async () => {
    const { s, root } = await make();
    const r = (await s.getTicket(root, "BLZ-3")).found;
    assert.equal(r.project, "BLZ");
    assert.equal(r.status, "done");
    await s.close?.();
  });

  await test(`${name}: listChildren answers the drill`, async () => {
    const { s, root } = await make();
    const kids = (await s.listChildren(root, "BLZ-1")).map((t) => t.frontmatter.id).sort();
    assert.deepEqual(kids, ["BLZ-2", "BLZ-3"]);
    assert.deepEqual(await s.listChildren(root, "BLZ-4"), []);
    await s.close?.();
  });

  await test(`${name}: blockersOf returns inbound Blocks only, never the ticket itself`, async () => {
    const { s, root } = await make();
    const ids = (await s.blockersOf(root, "BLZ-1")).map((t) => t.frontmatter.id).sort();
    assert.deepEqual(ids, ["BLZ-2", "BLZ-3"], "BLZ-4 Relates; BLZ-1 blocks itself and must be excluded");
    await s.close?.();
  });

  await test(`${name}: listTickets yields the whole corpus`, async () => {
    const { s, root } = await make();
    const ids = [...await s.listTickets(root)].map((t) => t.frontmatter.id).sort();
    assert.deepEqual(ids, ["BLZ-1", "BLZ-2", "BLZ-3", "BLZ-4"]);
    await s.close?.();
  });

  await test(`${name}: listProjects returns the project keys`, async () => {
    const { s, root } = await make();
    assert.deepEqual(await s.listProjects(root), ["BLZ"]);
    await s.close?.();
  });

  await test(`${name}: changeToken is a stable opaque string`, async () => {
    const { s, root } = await make();
    const a = await s.changeToken(root);
    assert.equal(typeof a, "string");
    assert.equal(a, await s.changeToken(root));
    await s.close?.();
  });
}

describe("driver conformance — one suite, every driver", async () => {
  await conformance(seedFs, "fs");
  await conformance(seedMem, "mem");
  await conformance(seedSqlite, "sqlite");

  if (PG) {
    await conformance(seedPg, "postgres");
  } else {
    test("postgres: SKIPPED — set BLAZE_TEST_PG_URL to run it", { skip: true }, () => {});
  }
});
