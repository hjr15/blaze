# db-mode write and seed fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the five known ways `BLAZE_WRITE_PORT=db` either cannot be set up or writes wrongly (BLZ-668, 669, 671, 672, 673), so BLZ-254 can plan a cutover against a write path with no known defects.

**Architecture:** One new pure module (`scripts/model/seed-counter.mjs`) owns the never-lower counter upsert and the three seed sources (ticket files, `.ids/` claims, database rows); `blaze db` gains a Postgres `init` and a `seed-counter` subcommand on top of it. The write port gains `reserve(id)` beside `allocate`, and `applyImport` takes both ids from the port; the fs allocators move into one exported factory (`fsAllocators`) so import keeps its exact no-network behaviour. `dbWritePort` stamps a missing `created`/`updated`. The groomer gains an async db branch (`groomOnceDb`) that materialises the ticket to a scratch file and writes back through the port; the fs groomer is not edited.

**Tech Stack:** Node 24 ESM, `node:test`, `node:sqlite`, `pg` (optional peer dep) against Postgres 17.

**Spec:** `docs/superpowers/specs/2026-09-30-db-mode-write-seed-fixes-design.md` — read it first; this plan argues from it.

**Prototype provenance.** Every code and test block below was run in a scratch worktree of `30978e5` against `postgres:17-alpine`. With all eight tasks applied, the full suite ran green: `node --test --test-concurrency=1` with `BLAZE_TEST_PG_URL` set → `tests 5310, pass 5309, fail 0, skipped 1`. The fs import was checked byte-identical against the unmodified engine (tickets, `.ids/` claims, `.cutover`, receipt entries) behind an unreachable git remote.

## Global Constraints

- **`fs` and `dual` behaviour unchanged.** (fs import output byte-identical; fs groomer path not edited; `runGroomer` stays synchronous in fs mode.)
- **Mode comes from `resolveWriteMode(env)` only.** No code sniffs `writePort.name` or `database.driver` to decide a mode.
- **`tests/model/seam-closure.test.mjs` changes are additive or exact name swaps with a `// BLZ-6xx:` comment, never a weakened assertion.**
- **`applyNew` test calls pass `today`, and for `type: "task"` pass `extra: { estimate }`** (db-mode write rules and `validateTicket` require it).
- **Postgres tests are gated `{ skip: PG ? false : "set BLAZE_TEST_PG_URL" }` with a scratch database per test** (`tests/helpers/pg-scratch.mjs`, created in Task 1).
- **Run Postgres tests with `--test-concurrency=1`.**
- Commits: one per task, subject `BLZ-6xx: …` naming the ticket the task serves; stage with an explicit pathspec; **no `Co-Authored-By` / `Signed-off-by` trailer** (CI hygiene rejects them).
- Environment for every command: `export PATH=/home/rnamwoh/.local/node24/bin:$PATH`. Postgres for the gated tests:
  ```bash
  docker run -d --rm --name blz-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=blaze_test -p 127.0.0.1:55433:5432 postgres:17-alpine
  until docker exec blz-pg pg_isready -U postgres -d blaze_test; do sleep 1; done
  export BLAZE_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:55433/blaze_test
  ```
  (`npm ci` first if `node_modules/` is absent — `pg` is needed for the gated tests.)

## Findings that refine the spec (decided here, from the code)

1. **§2.2 Postgres DDL — answer: `createDbSchema(pgExec(client), { dialect: "postgres" })` alone is sufficient.** It installs `PG_DDL` (incl. `project_counter`), link/hierarchy/meta, the `blaze_config` schema and the view seed. `resolveWritePort`/`resolvePorts` and db-mode `applyNew` need nothing more: projection (`projectionDdl`) and write rules (`writeRulesDdl`) are **not** required on Postgres — the SQLite init installs them only because it also loads the corpus in migration mode. Proven by Task 2's acceptance test (init on an empty database → db-mode `applyNew` → `ENG-6`). Installing write rules on Postgres would additionally start enforcing required fields there, a behaviour change this PR does not want.
2. **Unparseable ticket files refuse, they are not counted.** `walkTickets` throws on a malformed `.md` by design (index.mjs, BLZ-430/ADR-0031), and `loadCorpus` inherits that. `corpusMaxima` therefore refuses too (and `seed-counter` exits 1 naming the parse error); skipping would seed *below* the file's number. `maxId` (filename scan) is still added as a source for files the walk does not visit.
3. **`reserve(id, { project, title })`, not `reserve(id, { title })`.** The planner does not check that an explicit id's prefix equals the row's `project`, and today's import writes the claim under `projects/<row.project>/.ids/`. To stay byte-identical the fs `reserve` takes the row's `project` (defaulting to the id prefix). The db `reserve` keys the counter on the id's prefix — `ticket`'s CHECK `id = project_key || '-' || num` makes any other key unwritable anyway.
4. **The runner's fs port now allocates for import, so it must be built with `remoteClaims: false`.** `import-runner.mjs` already hands `resolvePorts`' port to `runImport`; with allocation routed through the port, the fs/dual port's allocator would start calling `git fetch` and marking claims `provisional` behind an unreachable remote. `resolveWritePort` gains `remoteClaims` (default `true`), the runner passes `false`, and a discriminating test pins it (fails with `'BLZ-1 t provisional\n'` if the flag is dropped).
5. **Three fixture lines in `tests/model/import-apply.test.mjs` must change.** They build a bare `fsWritePort(projectsDir)` (no allocator injected); with ids from the port they throw `no allocate function was injected`. They are given the same allocators `applyImport`'s default gets. Every assertion in the file is unchanged — this is a fixture adaptation, not a weakening.
6. **Ordering inside an `--allocate-ids` row moves by one step:** the fs claim is now written inside `allocate`, i.e. *before* the `allocated` receipt entry rather than after it. Still before the ticket write, so §5.3's crash-residue argument (a claim without a ticket is harmless) holds. Receipt content is byte-identical.
7. **Event `source` for the groomer is `"loop"`, not `"groomer"`.** `ticket_event.source` has CHECK `IN ('cli','api','loop','migration','git-backfill')`; `"groomer"` would fail every db-mode groom. The actor carries `"groomer"`.
8. **`groomOnce` stays synchronous; the db branch is a separate export `groomOnceDb`.** Making `groomOnce` async would change every fs caller and test. `runGroomer` dispatches on `resolveWriteMode()` and returns the promise only in db mode.
9. **`blaze groom` (the CLI, `scripts/loops/groomer.mjs`'s main block) had no db refusal at all** — under db it silently groomed stale files. Task 7 routes it through `groomOnceDb` too.
10. **"Local date" in spec §4 is actually UTC:** `new-runner.mjs:79` is `new Date().toISOString().slice(0, 10)`. The db port's default clock uses that same expression.
11. **`docs/guide/commands.md` has no `db` section**; Task 8 adds one (and the table row, count 16 → 17). ADR-0037 is Accepted and ADR-0010/0012 already carry dated addenda, so BLZ-671's `reserve` is an **ADR-0037 addendum**; the groomer residual closure is an **ADR-0038 addendum**.

## Review Focus

1. **A Postgres that is initialised but whose counter is stale** (ids handed out on the file path after `init`) → `seed-counter` raises it, never lowers it, and reports `before → after`. Pinned: Task 3 (`seed-counter on Postgres raises the counter to a new claim and is idempotent`).
2. **An operator re-runs `blaze db init` on a live Postgres, or passes `--force`** → refused, nothing dropped, the message names `blaze db seed-counter`; `--force` refused before any connection. Pinned: Task 2.
3. **An explicit-id import row whose `project` differs from its id prefix** (fs) → claim still written under the row's project, exactly as before. Pinned: Task 5 (`the fs port reserves an explicit id: the claim is written under the given project`) plus the byte-identical check in Task 5 Step 7.
4. **The groomer agent edits the materialised file into something unparseable, or rewrites `created`, or writes a second file** → refused by name, nothing written, scratch removed. Pinned: Task 6 (out-of-bounds, identity-field, invalid); unparseable returns `reason: "unparseable"` (same code path as invalid; not separately pinned — reviewers should read it).
5. **A db-mode groomer pass whose resolver refuses** (no shadow/no schema) → one `{type:"error", loop:"groomer"}` event, loop not left `busy`, ports closed. Pinned: Task 7.

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `scripts/model/seed-counter.mjs` (new) | 1 | `counterUpsertSql`, `corpusMaxima`, `seedCounter` |
| `tests/helpers/pg-scratch.mjs` (new) | 1 | one scratch Postgres database per test |
| `tests/model/seed-counter.test.mjs` (new) | 1 | the module's tests |
| `scripts/migrate/load-corpus.mjs` | 1 | uses `counterUpsertSql("sqlite")` |
| `scripts/model/write-port-resolve.mjs` | 2, 5 | export `openCheckedPg`, `describePgTarget`; `fsAllocators`; `remoteClaims` |
| `scripts/db-runner.mjs` | 2, 3 | Postgres `init`; `seed-counter`; SQLite init seeds claims |
| `tests/db-runner-pg.test.mjs` (new) | 2, 3 | Postgres `blaze db` + real-connection refusal |
| `tests/db-runner.test.mjs` | 3 | SQLite `seed-counter` |
| `scripts/model/write-port.mjs` | 4, 5 | `today` clock; `reserve` on fs/db/dual |
| `tests/model/write-port.test.mjs` | 4, 5 | clock + reserve unit tests |
| `tests/import-db-mode.test.mjs` (new) | 4, 5 | db-mode import: dates; interleave |
| `scripts/model/import-apply.mjs` | 5 | ids through `allocate`/`reserve` |
| `scripts/import-runner.mjs` | 5 | `remoteClaims: false` |
| `tests/model/import-apply.test.mjs`, `tests/import-runner.test.mjs`, `tests/write-port-resolve.test.mjs` | 5 | fixture + no-fetch + reserve tests |
| `scripts/loops/groomer.mjs` | 6, 7 | `selectNextTicketDb`, `groomOnceDb`; CLI db branch |
| `scripts/supervisor.mjs` | 7 | refusal removed; `runGroomerDb` |
| `tests/groomer-db-mode.test.mjs` | 6, 7 | db grooming cases; refusal assertion replaced |
| `tests/model/seam-closure.test.mjs` | 2, 5, 6, 7 | additive pins / exact swaps |
| `docs/guide/commands.md`, `docs/design.md`, `docs/schema-versioning.md`, ADR-0037, ADR-0038 | 8 | docs |

---

### Task 1: `seed-counter.mjs` — the never-lower upsert and the three seed sources (BLZ-668)

**Files:**
- Create: `scripts/model/seed-counter.mjs`, `tests/helpers/pg-scratch.mjs`, `tests/model/seed-counter.test.mjs`
- Modify: `scripts/migrate/load-corpus.mjs:14` (import), `:183-189` (the seed upsert)

**Interfaces:**
- Consumes: `maxId(projectsDir, key)` (`ids.mjs`), `maxClaim(projectsDir, key)` (`claims.mjs`), a reader with `listTickets(root)` / `listProjects(root)`.
- Produces:
  - `counterUpsertSql(dialect: "sqlite"|"postgres") → string` — params `(project_key, n)`.
  - `corpusMaxima({ projectsDir, readStorage }) → Promise<Map<string, number>>` — `readStorage` is REQUIRED (the module must not name `fsReadStorage`; `FS_READER_ALLOWED` in seam-closure would reject it).
  - `seedCounter(exec, maxima, { dialect }) → Promise<Array<{ project, before, after }>>`, sorted by project; `exec` is `{run, all}`, sync or async.
  - `tests/helpers/pg-scratch.mjs`: `PG`, `PG_SKIP`, `scratchPgDb(tag) → { name, url, drop() }`, `pgClient(url) → connected pg.Client`.

- [ ] **Step 1: Write the scratch-database helper** — `tests/helpers/pg-scratch.mjs`:

```js
// tests/helpers/pg-scratch.mjs — BLZ-668. One fresh Postgres DATABASE per test, dropped after.
// Helpers ONLY (a module that declared tests would re-register them in every importer).
// The pattern is write-port.test.mjs's and allocate-concurrency.test.mjs's: two tests sharing
// one database collide on schema creation, so each gets its own.
import { randomUUID } from "node:crypto";

export const PG = process.env.BLAZE_TEST_PG_URL ?? null;
export const PG_SKIP = { skip: PG ? false : "set BLAZE_TEST_PG_URL" };

async function admin(fn) {
  const pg = (await import("pg")).default;
  const c = new pg.Client(PG);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** Create an empty scratch database. Returns its URL and a `drop()` for the test's `finally`. */
export async function scratchPgDb(tag) {
  const name = `blz668_${tag}_${process.pid}_${randomUUID().slice(0, 8)}`.toLowerCase();
  await admin((c) => c.query(`CREATE DATABASE ${name}`));
  const url = new URL(PG);
  url.pathname = `/${name}`;
  return {
    name, url: url.toString(),
    drop: () => admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)),
  };
}

/** A connected pg.Client on `url` — the openPostgresClient shape resolvePorts injects. */
export async function pgClient(url) {
  const pg = (await import("pg")).default;
  const c = new pg.Client(url);
  await c.connect();
  return c;
}
```

- [ ] **Step 2: Write the failing test** — `tests/model/seed-counter.test.mjs`:

```js
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test tests/model/seed-counter.test.mjs`
Expected: FAIL — `Cannot find module '…/scripts/model/seed-counter.mjs'`.

- [ ] **Step 4: Write the module** — `scripts/model/seed-counter.mjs`:

```js
// scripts/model/seed-counter.mjs — seeding the db-mode id allocator (BLZ-668, BLZ-669).
//
// `project_counter` holds the LAST number issued per project (BLZ-667). db-mode `allocate()`
// hands out `n + 1`, so the counter must sit at or above every number already taken — or the
// database issues an id the board already holds. "Taken" has three sources, and this module
// is the one place all three are read:
//
//   (a) the file corpus — every ticket file's number, INCLUDING one whose frontmatter will
//       not parse (its filename still holds the number), exactly as load-corpus.mjs counts
//       a row the database refused;
//   (b) the `.ids/` claims — a number handed out on the file path that may not have a ticket
//       yet (BLZ-136's ledger; `maxClaim` in claims.mjs reads it);
//   (c) the database's own `ticket` table — rows written in db mode that no file holds.
//
// NEVER LOWERS. `counterUpsertSql` is the only spelling of the upsert: a number already
// issued must not be issued twice, so a seed can only raise a counter.
import { maxId } from "./ids.mjs";
import { maxClaim } from "./claims.mjs";

const KEY_SHAPE = /^[A-Z][A-Z0-9]*$/;
const ID_SHAPE = /^([A-Z][A-Z0-9]*)-(\d+)$/;

/** The never-lower upsert on `project_counter`. Params: (project_key, n). */
export function counterUpsertSql(dialect) {
  if (dialect === "sqlite") {
    return `INSERT INTO project_counter (project_key, n) VALUES (?, ?)
     ON CONFLICT (project_key) DO UPDATE SET n = max(project_counter.n, excluded.n)`;
  }
  if (dialect === "postgres") {
    return `INSERT INTO project_counter (project_key, n) VALUES ($1, $2)
     ON CONFLICT (project_key) DO UPDATE SET n = GREATEST(project_counter.n, excluded.n)`;
  }
  throw new Error(`unknown dialect ${JSON.stringify(dialect)} — expected 'sqlite' or 'postgres'`);
}

/**
 * The highest number per prefix across the file corpus (a) and the claims (b).
 * `readStorage` is REQUIRED — the caller names the reader (ADR-0038); this module never
 * defaults to the filesystem one.
 * @returns Map<prefix, n>
 */
export async function corpusMaxima({ projectsDir, readStorage }) {
  const out = new Map();
  const bump = (key, n) => {
    if (!KEY_SHAPE.test(key) || !Number.isInteger(n) || n <= 0) return;
    if (n > (out.get(key) ?? 0)) out.set(key, n);
  };
  for (const t of await readStorage.listTickets(projectsDir)) {
    const m = ID_SHAPE.exec(String(t.frontmatter?.id ?? "").trim());
    if (m) bump(m[1], Number(m[2]));
  }
  for (const key of await readStorage.listProjects(projectsDir)) {
    if (!KEY_SHAPE.test(key)) continue;
    bump(key, maxId(projectsDir, key));      // (a) by FILENAME: an unparseable ticket still counts
    bump(key, maxClaim(projectsDir, key));   // (b)
  }
  return out;
}

/**
 * Raise every prefix's counter to max(corpus, claims, table). Idempotent; never lowers.
 * `exec` is the {run, all} shape — sync (node:sqlite) or async (pg); both are awaited.
 * @returns [{ project, before, after }] sorted by project
 */
export async function seedCounter(exec, maxima, { dialect }) {
  const upsert = counterUpsertSql(dialect);
  const before = new Map();
  for (const r of await exec.all("SELECT project_key, n FROM project_counter", [])) {
    before.set(r.project_key, Number(r.n));
  }
  const want = new Map(maxima);
  for (const r of await exec.all(
    "SELECT project_key, MAX(num) AS n FROM ticket GROUP BY project_key", [])) {
    const n = Number(r.n);
    if (n > (want.get(r.project_key) ?? 0)) want.set(r.project_key, n);
  }
  for (const key of before.keys()) if (!want.has(key)) want.set(key, 0);
  const out = [];
  for (const key of [...want.keys()].sort()) {
    const b = before.get(key) ?? 0;
    const n = want.get(key);
    if (n > b) await exec.run(upsert, [key, n]);
    out.push({ project: key, before: b, after: Math.max(b, n) });
  }
  return out;
}
```

- [ ] **Step 5: Switch `load-corpus.mjs` to the one spelling.** Add after `import { fsReadStorage } from "../model/read-storage.mjs";`:

```js
import { counterUpsertSql } from "../model/seed-counter.mjs";
```

and replace

```js
  const seedCounter = db.prepare(
    `INSERT INTO project_counter (project_key, n) VALUES (?, ?)
     ON CONFLICT (project_key) DO UPDATE SET n = max(project_counter.n, excluded.n)`);
```

with

```js
  // BLZ-668: the upsert is spelled once, in seed-counter.mjs, for both dialects.
  const seedCounter = db.prepare(counterUpsertSql("sqlite"));
```

(The SQL text is identical; SQLite behaviour is unchanged.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test --test-concurrency=1 tests/model/seed-counter.test.mjs tests/db-runner.test.mjs tests/model/seam-closure.test.mjs`
Expected: PASS — seed-counter `pass 9` with `BLAZE_TEST_PG_URL` set (8 + 1 skipped without it); db-runner 6/6; seam-closure 21/21 (the new module reaches no fs write and names no `fsReadStorage`, so no pin is needed).

- [ ] **Step 7: Commit**

```bash
git add scripts/model/seed-counter.mjs scripts/migrate/load-corpus.mjs tests/helpers/pg-scratch.mjs tests/model/seed-counter.test.mjs
git commit -m "BLZ-668: seed-counter module — never-lower counter upsert over tickets, claims and table" -- scripts/model/seed-counter.mjs scripts/migrate/load-corpus.mjs tests/helpers/pg-scratch.mjs tests/model/seed-counter.test.mjs
```

---

### Task 2: `blaze db init` on Postgres, and the refusal that names its target (BLZ-668 + cleanup)

**Files:**
- Modify: `scripts/model/write-port-resolve.mjs:262-275` (`openCheckedPg` exported; `describePgTarget` added)
- Modify: `scripts/db-runner.mjs` (imports; `init` split into `init`/`initPostgres`/`initSqlite`; injectables in `runDb`)
- Modify: `tests/model/seam-closure.test.mjs` (write-port-resolve `inert` += 2 names)
- Create: `tests/db-runner-pg.test.mjs`

**Interfaces:**
- Consumes: Task 1's `corpusMaxima`, `seedCounter`; `createDbSchema` (`db-schema-version.mjs`); `resolveDatabaseConfig`; `openPostgresClient` (`init-pg.mjs`).
- Produces:
  - `describePgTarget(connection: object|string) → "host/database"` (never the password).
  - `openCheckedPg(connection, openPgClient) → Promise<pg.Client>` — now exported; refusal text `blaze: the Postgres database <host/db> has no Blaze schema. Create it first:\n\n    blaze db init\n`.
  - `runDb(argv, io)` accepts `io.resolveDbConfig` and `io.openPostgresClient` (defaults: `resolveDatabaseConfig`, `openPostgresClient`).
  - Helpers inside `db-runner.mjs` used by Task 3: `dbConfigOr(ctx)`, `printSeed(rows, log)`; `ctx.openPgClient`.

- [ ] **Step 1: Write the failing tests** — `tests/db-runner-pg.test.mjs`:

```js
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
import { dbBoard } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";

const capture = () => {
  const out = [];
  const io = { log: (s) => out.push(String(s)), err: (s) => out.push(String(s)) };
  return { io, text: () => out.join("\n") };
};

/** runDb's injectables, pointed at one scratch database. `opened` counts connections. */
function pgIo(url, opened = { n: 0 }) {
  return {
    resolveDbConfig: () => ({ driver: "postgres", connection: url }),
    openPostgresClient: async (c) => { opened.n++; return pgClient(c); },
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test --test-concurrency=1 tests/db-runner-pg.test.mjs`
Expected: FAIL (with `BLAZE_TEST_PG_URL` set) — acceptance: `/Postgres schema ready at …/` does not match (today's `init` builds a SQLite shadow instead); `--force`: exit 0 ≠ 1; cleanup: message `blaze: this Postgres database has no Blaze schema` does not match `the Postgres database 127.0.0.1/blz668_refuse_…`.

- [ ] **Step 3: Export the checked open and name the target** — in `scripts/model/write-port-resolve.mjs` replace

```js
/** Connect, and refuse a missing or out-of-range schema, closing the socket on refusal. */
async function openCheckedPg(connection, openPgClient) {
  const client = await openPgClient(connection);
  await closeOnSetupFailure(client, async () => {
    const state = await checkDbSchema(pgExec(client), { dialect: "postgres" });
    if (!state.ok) throw new Error(`blaze: ${state.error}`);
    if (state.state === "empty") {
      throw new Error(
        "blaze: this Postgres database has no Blaze schema. Create it first:\n\n"
        + "    blaze db init\n");
    }
  });
  return client;
}
```

with

```js
/**
 * BLZ-668: which Postgres a message is about — `host/database`, never the password. Takes
 * either shape a connection arrives in: resolveDatabaseConfig's parsed parts, or a URL string
 * (tests). An unparseable string names nothing rather than echoing it back.
 */
export function describePgTarget(connection) {
  if (connection && typeof connection === "object") {
    return `${connection.host ?? "?"}/${connection.database ?? "?"}`;
  }
  try {
    const u = new URL(String(connection));
    return `${u.hostname}/${decodeURIComponent(u.pathname.replace(/^\//, "")) || "?"}`;
  } catch { return "an unparseable connection"; }
}

/** Connect, and refuse a missing or out-of-range schema, closing the socket on refusal. */
export async function openCheckedPg(connection, openPgClient) {
  const client = await openPgClient(connection);
  await closeOnSetupFailure(client, async () => {
    const state = await checkDbSchema(pgExec(client), { dialect: "postgres" });
    if (!state.ok) throw new Error(`blaze: ${state.error}`);
    if (state.state === "empty") {
      throw new Error(
        `blaze: the Postgres database ${describePgTarget(connection)} has no Blaze schema. `
        + "Create it first:\n\n"
        + "    blaze db init\n");
    }
  });
  return client;
}
```

(Existing fake-client tests in `tests/write-port-resolve.test.mjs:260` and `tests/read-storage-resolve.test.mjs:77` match `/no Blaze schema/` and still pass.)

- [ ] **Step 4: Add the Postgres init** — in `scripts/db-runner.mjs`:

(a) replace the import

```js
import { openShadow, shadowDbPath, configDbPath, divergenceLogPath,
         readSoakState } from "./model/write-port-resolve.mjs";
```

with

```js
import { openShadow, shadowDbPath, configDbPath, divergenceLogPath,
         readSoakState, pgExec, openCheckedPg, describePgTarget } from "./model/write-port-resolve.mjs";
import { resolveDatabaseConfig } from "./model/database-config.mjs";
import { openPostgresClient } from "./init-pg.mjs";
import { createDbSchema } from "./model/db-schema-version.mjs";
import { corpusMaxima, seedCounter } from "./model/seed-counter.mjs";
```

(`openCheckedPg` is used from Task 3; importing it now is harmless.)

(b) replace `USAGE`'s body lines

```
  init      create the shadow database and load this board into it
  status    what the database holds, and what the dual-write soak has found

  --force   with init: replace an existing shadow database
```

with

```
  init          create the database schema. SQLite: create the shadow database and load
                this board into it. Postgres: create the schema and seed the id counter
                (the board's tickets are NOT loaded — that is the BLZ-254 migration)
  seed-counter  raise the db-mode id counter to every number already taken (ticket files,
                .ids/ claims, database rows). Run it immediately before BLAZE_WRITE_PORT=db
  status        what the database holds, and what the dual-write soak has found

  --force       with init, SQLite only: replace an existing shadow database
```

(c) rename `async function init({ dataRoot, projectsDir, force, log, err }) {` to `async function initSqlite({ dataRoot, projectsDir, force, log, err }) {` (body unchanged) and insert **above** it:

```js
/** The resolved `database` block, or a printed refusal (null). Resolved BEFORE anything is
 *  touched, so a bad key or an incomplete Postgres connection changes nothing on disk. */
function dbConfigOr(ctx) {
  try { return ctx.resolveDbConfig({ dataRoot: ctx.dataRoot, config: loadConfig({ root: ctx.dataRoot }) }); }
  catch (e) { ctx.err(e.message); return null; }
}

/** One line per project, `before → after`, plus a note when nothing moved. */
function printSeed(rows, log) {
  if (!rows.length) { log("  (no projects — nothing to seed)"); return; }
  for (const r of rows) log(`  ${r.project.padEnd(10)} ${r.before} → ${r.after}`);
}

/**
 * BLZ-668: `blaze db init` on Postgres — schema + counter seed ONLY. Loading the corpus into
 * Postgres is BLZ-254's migration (it carries the zero-diff oracle), not this command.
 * `--force` is refused: a CLI flag never drops a real database's tables.
 */
async function initPostgres({ dataRoot, projectsDir, force, log, err, openPgClient }, connection) {
  if (force) {
    err("blaze db init: --force is refused on Postgres. It would drop a real database's tables;");
    err("Blaze never does that from a CLI flag. Drop the schema by hand if you mean it.");
    return 1;
  }
  let client;
  try { client = await openPgClient(connection); }
  catch (e) { err(`blaze db init: cannot connect to ${describePgTarget(connection)} — ${e.message}`); return 1; }
  try {
    const exec = pgExec(client);
    try { await createDbSchema(exec, { dialect: "postgres" }); }
    catch (e) {
      err(`blaze db init: ${describePgTarget(connection)} — ${e.message}.`);
      err("It is already initialised. To bring its id counter up to date, run:\n");
      err("    blaze db seed-counter\n");
      return 1;
    }
    const rows = await seedCounter(exec,
      await corpusMaxima({ projectsDir, readStorage: fsReadStorage }), { dialect: "postgres" });
    log(`Postgres schema ready at ${describePgTarget(connection)}  (schema v${DB_SCHEMA_VERSION})`);
    log("id counter seeded:");
    printSeed(rows, log);
    log("\nThe board's tickets were NOT loaded — Postgres holds the schema and the counter only.");
    return 0;
  } finally {
    try { await client.end(); } catch { /* already closed */ }
  }
}

async function init(ctx) {
  const dbConfig = dbConfigOr(ctx);
  if (!dbConfig) return 1;
  if (dbConfig.driver === "postgres") return initPostgres(ctx, dbConfig.connection);
  return initSqlite(ctx);
}
```

Note: `dbConfigOr` runs `loadConfig` first, so an invalid project key is now refused *before* `--force` removes any file (same message, same exit 1 — `tests/cli-key-refusal.test.mjs`'s `db-runner.mjs init` case still passes). `initSqlite`'s own later `InvalidProjectKeyError` catch stays as defence in depth.

(d) in `runDb` replace

```js
  const ctx = { dataRoot: roots.dataRoot, projectsDir: roots.projectsDir, force, log, err };
```

with

```js
  // `resolveDbConfig` / `openPostgresClient` are injectable exactly as resolveWritePort's are,
  // so a test drives the Postgres branch against a scratch database.
  const ctx = { dataRoot: roots.dataRoot, projectsDir: roots.projectsDir, force, log, err,
                resolveDbConfig: io.resolveDbConfig ?? resolveDatabaseConfig,
                openPgClient: io.openPostgresClient ?? openPostgresClient };
```

- [ ] **Step 5: Pin the two new exports** — in `tests/model/seam-closure.test.mjs`, the `model/write-port-resolve.mjs` entry of `SEAM_WRITE_PROVIDERS`, replace

```js
        "sqliteExec", "pgExec", "readSoakState", "assertConfigNamespace", "resolveWriteMode",
        "resolveReadStorage", "withReadStorage"] }],
```

with

```js
        "sqliteExec", "pgExec", "readSoakState", "assertConfigNamespace", "resolveWriteMode",
        "resolveReadStorage", "withReadStorage",
        // BLZ-668: `blaze db init`/`seed-counter` open Postgres through the resolver's own
        // checked open, and name the target in refusals. A client connect and a string — no fs.
        "openCheckedPg", "describePgTarget"] }],
```

(Additive. Without it the guard fails with `an unpinned member \`describePgTarget\` … \`openCheckedPg\``.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test --test-concurrency=1 tests/db-runner-pg.test.mjs tests/db-runner.test.mjs tests/write-port-resolve.test.mjs tests/read-storage-resolve.test.mjs tests/cli-key-refusal.test.mjs tests/model/config-install.test.mjs tests/model/seam-closure.test.mjs`
Expected: PASS, 0 failures (db-runner-pg: 3 tests with `BLAZE_TEST_PG_URL` set).

- [ ] **Step 7: Commit**

```bash
git commit -m "BLZ-668: blaze db init on Postgres — schema and counter seed, --force refused, refusal names host/database" -- scripts/db-runner.mjs scripts/model/write-port-resolve.mjs tests/db-runner-pg.test.mjs tests/model/seam-closure.test.mjs
```

(`git add tests/db-runner-pg.test.mjs` first — it is new.)

---

### Task 3: `blaze db seed-counter`, and SQLite init seeds the claims (BLZ-669)

**Files:**
- Modify: `scripts/db-runner.mjs` (add `seedCounterCmd`; dispatch; SQLite init calls `seedCounter`)
- Modify: `tests/db-runner.test.mjs` (append), `tests/db-runner-pg.test.mjs` (append)

**Interfaces:**
- Consumes: Task 2's `dbConfigOr`, `printSeed`, `ctx.openPgClient`, exported `openCheckedPg`, `describePgTarget`; Task 1's `seedCounter`, `corpusMaxima`; `openShadow(dataRoot)` (refuses a missing shadow naming `blaze db init`).
- Produces: `blaze db seed-counter` — exit 0 printing `id counter at <where>:` then `  <PROJECT padded to 10> <before> → <after>` per project; exit 1 on a database with no schema / no shadow.

- [ ] **Step 1: Write the failing tests.** Append to `tests/db-runner-pg.test.mjs` (before the final `cleanup:` test or at the end — order does not matter):

```js
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

```

In `tests/db-runner.test.mjs` add after `import { runDb } from "../scripts/db-runner.mjs";`:

```js
import { writeClaim } from "../scripts/model/claims.mjs";
import { openShadow } from "../scripts/model/write-port-resolve.mjs";
```

and append at the end of the file:

```js
// BLZ-668 / BLZ-669. The SQLite half of the counter seed: init now also counts `.ids/` claims,
// and `blaze db seed-counter` re-seeds an existing shadow.
describe("blaze db seed-counter (sqlite)", () => {
  const counterOf = async (dataRoot, key) => {
    const { db, exec } = await openShadow(dataRoot);
    try { return exec.all("SELECT n FROM project_counter WHERE project_key = ?", [key])[0]?.n ?? 0; }
    finally { db.close(); }
  };

  test("init seeds the counter from a claim above every ticket", async () => {
    const roots = board();
    writeClaim(roots.projectsDir, "ENG", 7, "claimed-no-ticket");
    assert.equal(0, await runDb(["init"], { ...capture().io, roots }));
    assert.equal(await counterOf(roots.dataRoot, "ENG"), 7);
  });

  test("seed-counter raises the counter to a claim made after init, then is idempotent", async () => {
    const roots = board();
    assert.equal(0, await runDb(["init"], { ...capture().io, roots }));
    writeClaim(roots.projectsDir, "ENG", 9, "handed-out-on-the-file-path");
    const c1 = capture();
    assert.equal(0, await runDb(["seed-counter"], { ...c1.io, roots }));
    assert.match(c1.text(), /ENG\s+1 → 9/);
    const c2 = capture();
    assert.equal(0, await runDb(["seed-counter"], { ...c2.io, roots }));
    assert.match(c2.text(), /ENG\s+9 → 9/);
    assert.equal(await counterOf(roots.dataRoot, "ENG"), 9);
  });

  test("seed-counter before init refuses, naming blaze db init", async () => {
    const c = capture();
    assert.equal(1, await runDb(["seed-counter"], { ...c.io, roots: board() }));
    assert.match(c.text(), /no shadow database/);
    assert.match(c.text(), /blaze db init/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test --test-concurrency=1 tests/db-runner.test.mjs tests/db-runner-pg.test.mjs`
Expected: FAIL — `seed-counter` cases: `unknown command "seed-counter"` (exit 1 where 0 expected); `init seeds the counter from a claim above every ticket`: `1 !== 7` (loadCorpus counts tickets only).

- [ ] **Step 3: Implement.** In `scripts/db-runner.mjs`:

(a) insert after the `init(ctx)` function from Task 2:

```js
/**
 * BLZ-669: `blaze db seed-counter`, both drivers. Opens the database the write port would
 * (refusing one with no schema), raises every counter to max(corpus, claims, table), prints
 * `project  before → after`. Never lowers; a second run reports before === after.
 */
async function seedCounterCmd(ctx) {
  const { dataRoot, projectsDir, log, err, openPgClient } = ctx;
  const dbConfig = dbConfigOr(ctx);
  if (!dbConfig) return 1;
  let exec, close, dialect, where;
  try {
    if (dbConfig.driver === "postgres") {
      const client = await openCheckedPg(dbConfig.connection, openPgClient);
      exec = pgExec(client); dialect = "postgres"; where = describePgTarget(dbConfig.connection);
      close = async () => { try { await client.end(); } catch { /* already closed */ } };
    } else {
      const shadow = await openShadow(dataRoot);
      exec = shadow.exec; dialect = "sqlite"; where = shadow.path;
      close = () => { try { shadow.db.close(); } catch { /* already closed */ } };
    }
  } catch (e) { err(e.message); return 1; }
  try {
    const rows = await seedCounter(exec,
      await corpusMaxima({ projectsDir, readStorage: fsReadStorage }), { dialect });
    log(`id counter at ${where}:`);
    printSeed(rows, log);
    return 0;
  } catch (e) {
    err(`blaze db seed-counter: ${e.message}`);
    return 1;
  } finally {
    await close();
  }
}
```

(b) in `initSqlite`, replace

```js
    db.exec(setMigrationModeSql("sqlite", false));
```

with

```js
    db.exec(setMigrationModeSql("sqlite", false));
    // BLZ-669: loadCorpus seeded from the tickets; this adds the `.ids/` claims (a number
    // handed out that may not have a ticket yet). It can only RAISE a counter.
    await seedCounter(exec, await corpusMaxima({ projectsDir, readStorage: fsReadStorage }),
                      { dialect: "sqlite" });
```

(c) in `runDb` add after `if (cmd === "init") return init(ctx);`:

```js
  if (cmd === "seed-counter") return seedCounterCmd(ctx);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-concurrency=1 tests/db-runner.test.mjs tests/db-runner-pg.test.mjs tests/db-mode-reads.test.mjs tests/read-storage-resolve.test.mjs tests/model/config-install.test.mjs tests/model/seam-closure.test.mjs`
Expected: PASS — db-runner `pass 9`; db-runner-pg `pass 5` with Postgres; seam-closure 21/21 (db-runner's new calls reach no unpinned write member).

- [ ] **Step 5: Commit**

```bash
git commit -m "BLZ-669: blaze db seed-counter for both drivers; SQLite init also seeds from .ids/ claims" -- scripts/db-runner.mjs tests/db-runner.test.mjs tests/db-runner-pg.test.mjs
```

---

### Task 4: the db port stamps a missing `created`/`updated` (BLZ-672)

**Files:**
- Modify: `scripts/model/write-port.mjs:167` (signature) and `:295` (bound values)
- Modify: `tests/model/write-port.test.mjs` (append)
- Create: `tests/import-db-mode.test.mjs`

**Interfaces:**
- Produces: `dbWritePort(exec, { dialect = "sqlite", today = isoToday } = {})` where `today: () => "YYYY-MM-DD"`. `created_on = nz(fm.created) ?? today()`, `updated_on = nz(fm.updated) ?? nz(fm.created) ?? today()`. `resolveWritePort`/`resolvePorts` keep calling `dbWritePort(exec, { dialect })` (real clock).

- [ ] **Step 1: Write the failing unit tests** — append to `tests/model/write-port.test.mjs`:

```js
// BLZ-672: `created_on`/`updated_on` are NOT NULL; an imported row may carry neither.
describe("dbWritePort stamps a MISSING date (BLZ-672)", () => {
  const undated = () => {
    const t = TICKET();
    const { created, updated, ...fm } = t.frontmatter;
    void created; void updated;
    return { ...t, frontmatter: fm };
  };

  test("no created/updated → both are the injected today", async () => {
    const port = dbWritePort(sqliteExec(), { dialect: "sqlite", today: () => "2026-09-30" });
    await port.write(undated());
    const r = await port.read("BLZ-1");
    assert.equal(r.frontmatter.created, "2026-09-30");
    assert.equal(r.frontmatter.updated, "2026-09-30");
  });

  test("created only → updated follows created, not today", async () => {
    const port = dbWritePort(sqliteExec(), { dialect: "sqlite", today: () => "2026-09-30" });
    const t = undated();
    await port.write({ ...t, frontmatter: { ...t.frontmatter, created: "2026-02-02" } });
    const r = await port.read("BLZ-1");
    assert.equal(r.frontmatter.created, "2026-02-02");
    assert.equal(r.frontmatter.updated, "2026-02-02");
  });

  test("present dates are written verbatim — the clock is never consulted", async () => {
    const port = dbWritePort(sqliteExec(), { dialect: "sqlite",
      today: () => { throw new Error("the clock must not be read when both dates are present"); } });
    await port.write(TICKET());
    const r = await port.read("BLZ-1");
    assert.equal(r.frontmatter.created, "2026-01-01");
    assert.equal(r.frontmatter.updated, "2026-01-01");
  });
});
```

- [ ] **Step 2: Write the failing db-mode import test** — `tests/import-db-mode.test.mjs` (Task 5 appends the interleave cases; the imports it needs are already here):

```js
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

```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test tests/model/write-port.test.mjs tests/import-db-mode.test.mjs`
Expected: FAIL — `NOT NULL constraint failed: ticket.created_on` (write-port "no created/updated" case, and the import exits 4 with that error for `ENG-7`).

- [ ] **Step 4: Implement** — in `scripts/model/write-port.mjs` replace

```js
export function dbWritePort(exec, { dialect = "sqlite" } = {}) {
```

with

```js
/** `YYYY-MM-DD`, the same expression `new-runner.mjs` stamps `created`/`updated` with. */
const isoToday = () => new Date().toISOString().slice(0, 10);

export function dbWritePort(exec, { dialect = "sqlite", today = isoToday } = {}) {
```

and in `persistRows`' `vals` replace

```js
                  fm.created, fm.updated,
```

with

```js
                  // BLZ-672: `created_on`/`updated_on` are NOT NULL, and an imported row may carry
                  // neither (import design §2.6: an absent value is an absent key). Only a MISSING
                  // value is filled — with the write's date — and a present one is written verbatim.
                  nz(fm.created) ?? today(), nz(fm.updated) ?? nz(fm.created) ?? today(),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/model/write-port.test.mjs tests/import-db-mode.test.mjs tests/verbs-dual-write.test.mjs tests/db-mode-reads.test.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add tests/import-db-mode.test.mjs
git commit -m "BLZ-672: db write port stamps a missing created/updated with the write's date" -- scripts/model/write-port.mjs tests/model/write-port.test.mjs tests/import-db-mode.test.mjs
```

---

### Task 5: `reserve` on every port, and import takes its ids from the port (BLZ-671)

**Files:**
- Modify: `scripts/model/write-port.mjs` (fs/db/dual `reserve`; import `counterUpsertSql`)
- Modify: `scripts/model/write-port-resolve.mjs:171-188` (`fsAllocator` → exported `fsAllocators`), `resolveWritePort` (`remoteClaims`)
- Modify: `scripts/model/import-apply.mjs` (imports; default port; step 2/4 through the port)
- Modify: `scripts/import-runner.mjs:224` (`remoteClaims: false`)
- Modify: `tests/model/seam-closure.test.mjs` (write-port-resolve `writes` += `fsAllocators`; import-apply `WRITE_ALLOWED` swap)
- Modify: `tests/model/import-apply.test.mjs` (fixture), `tests/model/write-port.test.mjs`, `tests/write-port-resolve.test.mjs`, `tests/import-runner.test.mjs`, `tests/import-db-mode.test.mjs` (append)

**Interfaces:**
- Consumes: Task 1's `counterUpsertSql`; Task 4's clock (the interleave writes undated rows).
- Produces:
  - `fsWritePort(projectsDir, storage, readStorage, { allocate, reserve })` — `reserve(id, opts)` throws `fsWritePort: no reserve function was injected` when absent.
  - `dbWritePort(...).reserve(id) → Promise<{}>` — never-lower upsert keyed on the id's prefix.
  - `dualWritePort(...).reserve(id, opts)` → `primary.reserve(id, opts)`.
  - `fsAllocators(projectsDir, { dataRoot = dirname(projectsDir), remoteClaims = true }) → { allocate(project, { title }) → { id, n, claimFile }, reserve(id, { project, title }) → { claimFile } }` (exported from `write-port-resolve.mjs`).
  - `resolveWritePort({ …, remoteClaims = true })`; `resolvePorts` forwards it (it spreads `opts` into `resolveWritePort`).
  - `new.mjs` is **not** changed: `applyNew` never reserves, and its default allocate closure already matches `fsAllocators(...).allocate` with `remoteClaims: true`.

- [ ] **Step 1: Write the failing unit tests.** Append to `tests/model/write-port.test.mjs`:

```js
// BLZ-671: `reserve(id)` — "this explicit id is now taken". Import's `BLZ-900` row never goes
// through `allocate`, so without it a later db-mode `new` hands 900 out again.
describe("reserve (BLZ-671)", () => {
  test("dbWritePort.reserve raises the counter to the id's number, so the next allocate follows it", async () => {
    const port = dbWritePort(sqliteExec(), { dialect: "sqlite" });
    await port.allocate("BLZ");                              // BLZ-1
    assert.deepEqual(await port.reserve("BLZ-900", { title: "x" }), {});
    assert.equal((await port.allocate("BLZ")).id, "BLZ-901");
  });

  test("dbWritePort.reserve never lowers the counter", async () => {
    const port = dbWritePort(sqliteExec(), { dialect: "sqlite" });
    for (let i = 0; i < 5; i++) await port.allocate("BLZ");  // counter at 5
    await port.reserve("BLZ-2");
    assert.equal((await port.allocate("BLZ")).id, "BLZ-6");
  });

  test("fsWritePort.reserve calls the injected function with id and options", async () => {
    const calls = [];
    const port = fsWritePort("/tmp/does-not-matter/projects", fsStorage, fsReadStorage,
      { reserve: async (id, opts) => { calls.push([id, opts]); return { claimFile: "/tmp/fake" }; } });
    assert.deepEqual(await port.reserve("BLZ-9", { project: "BLZ", title: "t" }), { claimFile: "/tmp/fake" });
    assert.deepEqual(calls, [["BLZ-9", { project: "BLZ", title: "t" }]]);
  });

  test("fsWritePort.reserve with no injected function refuses clearly, not silently", async () => {
    const port = fsWritePort("/tmp/does-not-matter/projects", fsStorage, fsReadStorage);
    await assert.rejects(() => port.reserve("BLZ-9", { title: "x" }), /no reserve function was injected/);
  });

  test("dualWritePort.reserve delegates to the primary only", async () => {
    let shadowCalled = false;
    const primary = { name: "fs", reserve: async (id, o) => ({ claimFile: `/c/${id}/${o.title}` }) };
    const shadow = { name: "db", reserve: async () => { shadowCalled = true; return {}; } };
    assert.deepEqual(await dualWritePort(primary, shadow).reserve("BLZ-9", { title: "t" }), { claimFile: "/c/BLZ-9/t" });
    assert.equal(shadowCalled, false);
  });
});
```

In `tests/write-port-resolve.test.mjs` add after `import { join } from "node:path";`:

```js
import { execFileSync } from "node:child_process";
```

and append:

```js
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
```

Append to `tests/import-runner.test.mjs`:

```js
// BLZ-671: the runner's port now ALLOCATES for import, so it must be built with import's
// no-network seed (`remoteClaims: false`, ADR-0037 §3). Behind an unreachable remote a
// fetching allocator reads `null` and marks the claim " provisional" — the byte this pins.
test("BLZ-671: an fs --allocate-ids import never fetches — no provisional claim behind an unreachable remote", (t) => {
  const root = board(t);
  spawnSync("git", ["-C", root, "remote", "add", "origin", "/nonexistent/blz671.git"]);
  const r = run(root, ["--apply", "--allocate-ids", csvAt(root, row({ id: "" }))]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(claimPath(join(root, "projects"), "BLZ", 1), "utf8"), "BLZ-1 t\n");
});
```

Append to `tests/import-db-mode.test.mjs`:

```js
/** new, import --allocate-ids, new, explicit-id import of a HIGH id, new — all through one
 *  resolved db-mode port pair, exactly as the runners resolve it. */
async function interleave(roots, ports) {
  const { projectsDir, dataRoot } = roots;
  const common = { projectsDir, dataRoot, apply: true, writePort: ports.writePort,
                   readStorage: ports.readStorage, stage: () => ({ ok: true, queued: true }) };
  const ids = [];
  const make = async (title) => {
    const n = await applyNew(projectsDir, { project: "ENG", type: "task", title, today: "2026-09-30",
      extra: { estimate: 15 }, writePort: ports.writePort, readStorage: ports.readStorage });
    assert.equal(n.ok, true, JSON.stringify(n.errors));
    ids.push(n.id);
  };
  await make("first new");
  const a = await runImport({ ...common, allocateIds: true,
    file: csvAt(dataRoot, "alloc", { id: "", title: "allocated by import" }) });
  assert.equal(a.exitCode, 0, a.report);
  ids.push(...a.result.written);
  await make("second new");
  const b = await runImport({ ...common,
    file: csvAt(dataRoot, "explicit", { id: "ENG-50", title: "explicit high id" }) });
  assert.equal(b.exitCode, 0, b.report);
  ids.push(...b.result.written);
  await make("after the high id");
  return ids;
}

test("sqlite db mode: new / import / new / explicit high id / new — all distinct, last is high + 1, no .ids/",
     async () => {
  const roots = dbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    const ids = await interleave(roots, ports);
    assert.deepEqual(ids, ["ENG-2", "ENG-3", "ENG-4", "ENG-50", "ENG-51"]);
    assert.equal(existsSync(join(roots.projectsDir, "ENG", ".ids")), false,
      "db mode must not write a file-ledger claim");
  } finally { await ports.close(); }
});

test("postgres db mode: the same interleave — all distinct, last is high + 1, no .ids/", PG_SKIP, async () => {
  const db = await scratchPgDb("interleave");
  try {
    const roots = dbBoard();
    const pgOpts = { resolveDbConfig: () => ({ driver: "postgres", connection: db.url }),
                     openPostgresClient: pgClient };
    assert.equal(await runDb(["init"], { ...QUIET, roots, ...pgOpts }), 0);
    const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" }, ...pgOpts });
    try {
      // Postgres init loads no tickets, so ENG-1 exists only as a file; the counter still starts past it.
      const ids = await interleave(roots, ports);
      assert.deepEqual(ids, ["ENG-2", "ENG-3", "ENG-4", "ENG-50", "ENG-51"]);
      assert.equal(existsSync(join(roots.projectsDir, "ENG", ".ids")), false);
      const undated = (await ports.readStorage.getTicket(null, "ENG-50")).found.frontmatter;
      assert.match(undated.created, /^\d{4}-\d{2}-\d{2}$/, "BLZ-672 on Postgres: created_on was stamped");
    } finally { await ports.close(); }
  } finally { await db.drop(); }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test --test-concurrency=1 tests/model/write-port.test.mjs tests/write-port-resolve.test.mjs tests/import-db-mode.test.mjs`
Expected: FAIL — `port.reserve is not a function`; `remoteClaims: false …`: `'BLZ-1 t provisional\n' !== 'BLZ-1 t\n'`; interleave: the import's allocated id collides (`ENG-2` twice, the second write overwriting the first) so `deepEqual` fails. (`tests/import-runner.test.mjs`'s new case passes today — the runner does not allocate through the port yet — and is the guard that goes red if Step 6 forgets `remoteClaims: false`; see Step 8.)

- [ ] **Step 3: Add `reserve` to the ports** — in `scripts/model/write-port.mjs`:

(a) add after `import { fsReadStorage } from "./read-storage.mjs";`:

```js
import { counterUpsertSql } from "./seed-counter.mjs";
```

(b) replace

```js
export function fsWritePort(projectsDir, storage = fsStorage, readStorage = fsReadStorage,
                            { allocate } = {}) {
  return {
    name: "fs",
    async allocate(project, opts = {}) {
      if (!allocate) throw new Error("fsWritePort: no allocate function was injected");
      return allocate(project, opts);
    },
```

with

```js
export function fsWritePort(projectsDir, storage = fsStorage, readStorage = fsReadStorage,
                            { allocate, reserve } = {}) {
  return {
    name: "fs",
    async allocate(project, opts = {}) {
      if (!allocate) throw new Error("fsWritePort: no allocate function was injected");
      return allocate(project, opts);
    },
    // BLZ-671: "this explicit id is now taken" — import's `BLZ-900` row. Injected exactly like
    // `allocate`; the fs one writes the id's `.ids/` claim and returns `{ claimFile }`.
    async reserve(id, opts = {}) {
      if (!reserve) throw new Error("fsWritePort: no reserve function was injected");
      return reserve(id, opts);
    },
```

(c) inside `dbWritePort`, insert immediately before the `/**\n   * BLZ-667: persist() is one transaction.` comment:

```js
  /**
   * BLZ-671: an explicit id is TAKEN. Import's explicit-id row (`BLZ-900`) never goes through
   * `allocate`, so without this a later db-mode `new` hands out 900 again. The counter is
   * raised to the id's number with the one never-lower upsert (seed-counter.mjs); a lower id
   * leaves it where it is. The key is the id's own prefix — `ticket`'s CHECK ties
   * `id = project_key || '-' || num`, so a row whose project disagrees could not be written.
   * Returns `{}`: db mode has no claim file.
   */
  async function reserve(id) {
    const s = String(id);
    await exec.run(counterUpsertSql(dialect), [s.slice(0, s.lastIndexOf("-")), num(s)]);
    return {};
  }
```

and in its returned object replace `    name: "db",\n    allocate,\n` with `    name: "db",\n    allocate,\n    reserve,\n`.

(d) in `dualWritePort`'s returned object replace

```js
    allocate(project, opts) { return primary.allocate(project, opts); },
    close() { primary.close?.(); shadow.close?.(); },
```

with

```js
    allocate(project, opts) { return primary.allocate(project, opts); },
    // BLZ-671: same principle — the primary decides what is taken.
    reserve(id, opts) { return primary.reserve(id, opts); },
    close() { primary.close?.(); shadow.close?.(); },
```

(`write-port.mjs` → `seed-counter.mjs` → `ids.mjs`/`claims.mjs` imports only their inert readers; no cycle, no new seam pin.)

- [ ] **Step 4: One fs allocator factory** — in `scripts/model/write-port-resolve.mjs` replace the whole `fsAllocator` doc comment and function (from `/**\n * The fs allocator \`fsWritePort\` is handed (BLZ-667)` through the closing `}` of `function fsAllocator`) with:

```js
/**
 * The fs allocators `fsWritePort` is handed (BLZ-667, BLZ-671): `allocate` seeds from the
 * remote's published claims, reserves the next id and writes its claim; `reserve` writes the
 * claim for an id the caller already has (import's explicit-id row). `title` is a CALL-time
 * argument — this port is built before the verb knows the ticket's title. The allocate closure
 * also lives in `applyNew`'s default `writePort` (new.mjs), duplicated deliberately.
 *
 * `remoteClaims: false` is import's contract (ADR-0037 §3: the import runs with no network):
 * `remoteMax` is the KNOWN-EMPTY 0, never the could-not-read null, so `git fetch` is never
 * called and no claim is marked provisional — byte for byte what import wrote before BLZ-671.
 */
export function fsAllocators(projectsDir, { dataRoot = dirname(projectsDir), remoteClaims = true } = {}) {
  return {
    async allocate(proj, { title: t } = {}) {
      // null = the remote could not be read (stale view): the claim is provisional.
      const remoteMax = remoteClaims ? remoteMaxClaim(dataRoot, proj) : 0;
      const { id, n } = allocateId(projectsDir, proj, { dataRoot, remoteMax: remoteMax ?? 0 });
      const claimFile = writeClaim(projectsDir, proj, n, slugify(t ?? ""),
                                   { provisional: remoteMax === null });
      return { id, n, claimFile };
    },
    // `project` defaults to the id's prefix; import passes the row's own project, which is
    // the directory its claim has always been written under.
    async reserve(id, { project, title } = {}) {
      const s = String(id);
      const proj = project ?? s.slice(0, s.lastIndexOf("-"));
      return { claimFile: writeClaim(projectsDir, proj, Number(s.split("-").pop()), slugify(title ?? "")) };
    },
  };
}
```

then in `resolveWritePort`'s parameter list replace

```js
                                         env = process.env, onDivergence,
                                         resolveDbConfig = resolveDatabaseConfig,
```

with

```js
                                         env = process.env, onDivergence,
                                         // BLZ-671: import passes false — see fsAllocators.
                                         remoteClaims = true,
                                         resolveDbConfig = resolveDatabaseConfig,
```

and the two construction sites:

```js
    return { port: fsWritePort(projectsDir, storage, undefined,
                               { allocate: fsAllocator(projectsDir) }), mode, close() {} };
```
→
```js
    return { port: fsWritePort(projectsDir, storage, undefined,
                               fsAllocators(projectsDir, { remoteClaims })), mode, close() {} };
```
and
```js
    fsWritePort(projectsDir, storage, undefined, { allocate: fsAllocator(projectsDir) }),
```
→
```js
    fsWritePort(projectsDir, storage, undefined, fsAllocators(projectsDir, { remoteClaims })),
```

With `remoteClaims: true` the allocate path is character-for-character the old closure (`remoteMaxClaim(dirname(projectsDir), proj)`, `allocateId(…, { dataRoot, remoteMax: remoteMax ?? 0 })`, `writeClaim(…, { provisional: remoteMax === null })`), so `blaze new` in fs/dual is unchanged.

- [ ] **Step 5: Import takes both ids from the port** — in `scripts/model/import-apply.mjs`:

(a) replace

```js
import { allocateId } from "./ids.mjs";
import { writeClaim } from "./claims.mjs";
import { slugify } from "./storage.mjs";
import { fsWritePort } from "./write-port.mjs";
```

with

```js
import { fsWritePort } from "./write-port.mjs";
// BLZ-671: ids come from the PORT (allocate / reserve). The fs default is handed the same
// allocators every fs port gets, with the remote seed off — see fsAllocators.
import { fsAllocators } from "./write-port-resolve.mjs";
```

(b) delete the now-unused helper:

```js
/** The numeric half of `<KEY>-<N>`. The planner has already proved the shape. */
function idNumber(id) { return Number(String(id).split("-").pop()); }

```

(c) in `applyImport`'s destructuring replace `    writePort = fsWritePort(projectsDir),` with

```js
    writePort = fsWritePort(projectsDir, undefined, undefined,
                            fsAllocators(projectsDir, { dataRoot, remoteClaims: false })),
```

(d) replace everything from `      let id = entry.id;\n      let n;\n` up to (not including) `      // --- step 5: write → board` — i.e. the step-2/3 `if (entry.allocate) … else { n = idNumber(id); }`, the `const frontmatter = …` line, and the step-4 comment + `writeClaim` + `files.push(claimFile)` — with:

```js
      let id = entry.id;
      let claimFile;
      if (entry.allocate) {
        // --- step 2: allocate → reservation, THROUGH THE PORT (BLZ-671). Before, this
        // called ids.mjs directly, so a db-mode import allocated from the file ledger and
        // collided with db-mode `new`. The fs port's allocate is the same `allocateId` with
        // `remoteMax: 0` — the KNOWN-EMPTY value, not the could-not-read `null`: ADR-0037 §3
        // promises the import runs with no network (`remoteClaims: false`), so `git fetch`
        // is never called. The cost is stated rather than hidden — BLZ-136's cross-machine
        // collision AVOIDANCE is not consulted here, and an operator who wants it runs
        // `git fetch` before `--apply`.
        //
        // --- step 4 rides with it: the fs port writes the claim INSIDE allocate, so the
        // claim now lands before the `allocated` receipt entry rather than after it. Still
        // BEFORE the ticket — the only ordering §5.3 and the crash-residue argument need.
        ({ id, claimFile } = await writePort.allocate(project, { title: ticket.frontmatter.title }));
        // --- step 3: allocated → receipt, immediately, so the window in
        // which a number is reserved but unrecorded is one append wide.
        append({ seq, phase: "allocated", id });
      } else {
        // --- step 4: claim → `.ids/` (fs) / counter (db), BEFORE the ticket. The
        // explicit-id path has no O_EXCL reservation, so on fs the claim is the only
        // ledger entry that number will ever get, and in db mode the counter must pass it
        // or a later db-mode `new` hands the number out again (BLZ-671). The crash residue
        // is then the harmless one (a claim with no ticket, which only advances the
        // allocation floor) rather than the damaging one (a ticket with no claim, a
        // `missingClaimErrors` ERROR on the operator's board after every partial apply).
        ({ claimFile } = await writePort.reserve(id, { project, title: ticket.frontmatter.title }));
      }

      const frontmatter = { ...ticket.frontmatter, id };
      // db mode has no claim file; the fs port always returns one.
      if (claimFile) files.push(claimFile);
```

(e) replace

```js
      append({ seq, phase: "done", id, file: relative(dataRoot, file), claim: true });
```

with

```js
      append({ seq, phase: "done", id, file: relative(dataRoot, file), claim: Boolean(claimFile) });
```

(fs: always `true`, as before; db: `false` — there is no claim.)

- [ ] **Step 6: The runner builds import's port without the network** — in `scripts/import-runner.mjs` replace

```js
  try { wp = await resolvePorts({ dataRoot, projectsDir }); }
```

with

```js
  // BLZ-671: `remoteClaims: false` — ADR-0037 §3's no-network import. The fs/dual port's
  // allocate now IS import's allocator, so it must seed with the known-empty 0, never fetch.
  try { wp = await resolvePorts({ dataRoot, projectsDir, remoteClaims: false }); }
```

- [ ] **Step 7: Adapt the import-apply fixture (not an assertion).** In `tests/model/import-apply.test.mjs` add after `import { fsWritePort } from "../../scripts/model/write-port.mjs";`:

```js
import { fsAllocators } from "../../scripts/model/write-port-resolve.mjs";
```

insert before the comment `// \`applyImport\` does NOT decide exit 5:`:

```js
// BLZ-671: import takes its ids from the port, so a hand-built fs port carries the same
// allocators `applyImport`'s own default does — `remoteClaims: false`, import's no-network seed.
const fsPort = (projectsDir, root) =>
  fsWritePort(projectsDir, undefined, undefined, fsAllocators(projectsDir, { dataRoot: root, remoteClaims: false }));

```

and replace the three bare constructions: `writePort: fsWritePort(projectsDir),` (in `ctxFor`) → `writePort: fsPort(projectsDir, root),`; both `const real = fsWritePort(projectsDir);` → `const real = fsPort(projectsDir, root);`. (Without this, 9 tests fail with `no allocate function was injected` / `no reserve function was injected`.)

- [ ] **Step 8: Seam pins** — in `tests/model/seam-closure.test.mjs`:

(a) `SEAM_WRITE_PROVIDERS`, `model/write-port-resolve.mjs` entry, replace

```js
    { writes: ["openShadow", "logDivergence", "recordSoakOp", "resolveWritePort",
      "resolvePorts"], sanctioned: [],
```

with

```js
    { writes: ["openShadow", "logDivergence", "recordSoakOp", "resolveWritePort",
      "resolvePorts",
      // BLZ-671: the fs allocate/reserve pair every fs port is handed — `allocateId` +
      // `writeClaim` behind a closure, under a caller-chosen projects dir. A write.
      "fsAllocators"], sanctioned: [],
```

(b) `WRITE_ALLOWED`, replace

```js
  ["model/import-apply.mjs", ["allocateId", "writeClaim", "commitOrQueue",
    "appendRegularFileSync", "mkdirSync", "unlinkSync"]],
```

with

```js
  // BLZ-671: `allocateId` + `writeClaim` → `fsAllocators`. Import now takes its ids from the
  // PORT (allocate / reserve), and its fs default is handed write-port-resolve's allocators
  // rather than calling the allocator itself — so a db-mode import allocates from the counter.
  ["model/import-apply.mjs", ["fsAllocators", "commitOrQueue",
    "appendRegularFileSync", "mkdirSync", "unlinkSync"]],
```

(An exact name swap. Leaving the old names fails `the write-seam scan OBSERVED the corpus…` with `allocateId (not reached any more)`.)

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test --test-concurrency=1 tests/model/write-port.test.mjs tests/write-port-resolve.test.mjs tests/import-db-mode.test.mjs tests/import-runner.test.mjs tests/model/import-apply.test.mjs tests/model/import-mapping.test.mjs tests/model/import-mapping-repair.test.mjs tests/import-sigkill.test.mjs tests/import-shared-rule.test.mjs tests/csv-round-trip.test.mjs tests/new.test.mjs tests/new-runner.test.mjs tests/model/seam-closure.test.mjs`
Expected: PASS, 0 failures.

Prove the runner guard discriminates: temporarily revert Step 6's `remoteClaims: false` and run `node --test --test-name-pattern="BLZ-671" tests/import-runner.test.mjs` → FAIL with `+ 'BLZ-1 t provisional\n'`; restore it → PASS.

- [ ] **Step 10: Byte-identical fs import check (manual, against the pre-change engine).** From a checkout of the base commit at `$BASE` (e.g. `git worktree add /tmp/claude-1000/blz668-base 30978e5`) and this tree at `$NEW`, run the same import on two fresh boards and diff everything under `projects/` plus the receipt phases:

```bash
mk() { d=$(mktemp -d /tmp/claude-1000/blz668-cmp-XXXX); mkdir -p "$d/projects/BLZ/defined"
  echo '{"projects":["BLZ"],"schemaVersion":2}' > "$d/blaze.config.json"
  echo '{"key":"BLZ","components":[],"labels":[]}' > "$d/projects/BLZ/project.json"
  git -C "$d" init -q; git -C "$d" config user.email t@t; git -C "$d" config user.name t
  git -C "$d" remote add origin /nonexistent/remote.git
  git -C "$d" add -A; git -C "$d" commit -qm seed
  node --input-type=module -e '
    import { COLUMN_NAMES } from "'"$NEW"'/scripts/model/csv-schema.mjs";
    import { writeCsv } from "'"$NEW"'/scripts/model/csv.mjs";
    const row = (o) => COLUMN_NAMES.map((n) => o[n] ?? "");
    const base = { schema_version: "1", project: "BLZ", type: "task", description: "body" };
    process.stdout.write(writeCsv([COLUMN_NAMES.slice(),
      row({ ...base, id: "BLZ-900", status: "defined", title: "Explicit high", estimate: "30", created: "2026-01-01", updated: "2026-01-01" }),
      row({ ...base, id: "", status: "in-progress", title: "Allocated one", estimate: "15" })]));' > "$d/in.csv"
  echo "$d"; }
run() { (cd "$2" && BLAZE_PROJECTS_DIR="$2/projects" BLAZE_COMMIT_MODE=batch node "$1/scripts/import-runner.mjs" --apply --allocate-ids in.csv); }
A=$(mk); B=$(mk); run "$BASE" "$A"; run "$NEW" "$B"
for d in "$A" "$B"; do (cd "$d" && find projects -type f | sort | while read -r f; do echo "== $f"; cat "$f"; done) > "$d.tree"
  grep -h '"phase"' "$d"/import-receipts/*.jsonl | sed 's/"row":[0-9]*,//' > "$d.rcpt"; done
diff "$A.tree" "$B.tree" && echo IDENTICAL; diff "$A.rcpt" "$B.rcpt" && echo "RECEIPTS IDENTICAL"
```

Expected: `IDENTICAL` and `RECEIPTS IDENTICAL`; `projects/BLZ/.ids/900` = `BLZ-900 explicit-high`, `.ids/901` = `BLZ-901 allocated-one` (no ` provisional`), `.ids/.cutover` = `900`. Remove the boards and the base worktree afterwards.

- [ ] **Step 11: Commit**

```bash
git commit -m "BLZ-671: import allocates and reserves ids through the write port; reserve on fs/db/dual ports" -- scripts/model/write-port.mjs scripts/model/write-port-resolve.mjs scripts/model/import-apply.mjs scripts/import-runner.mjs tests/model/seam-closure.test.mjs tests/model/import-apply.test.mjs tests/model/write-port.test.mjs tests/write-port-resolve.test.mjs tests/import-runner.test.mjs tests/import-db-mode.test.mjs
```

---

### Task 6: `groomOnceDb` — the groomer's db branch (BLZ-673)

**Files:**
- Modify: `scripts/loops/groomer.mjs` (imports; new exports `selectNextTicketDb`, `groomOnceDb` above the CLI block). `groomOnce` and every fs helper are **not** edited.
- Modify: `tests/groomer-db-mode.test.mjs` (imports + append; the BLZ-670 refusal test stays until Task 7)
- Modify: `tests/model/seam-closure.test.mjs` (groomer pin, additive)

**Interfaces:**
- Consumes: `resolvePorts`' `readStorage` (`listTickets`, `getTicket`) and `writePort.write(t, ctx)`; `serializeTicket`/`parseTicket` (`model/ticket.mjs`); `EDITABLE_FIELDS` (`model/fields.mjs`); `validateTicket` (`model/rules.mjs`); `loadProjectSchema` (`model/schema-config.mjs`); `validateTaxonomy` (`model/taxonomy.mjs`); `loadSprints`, `validateSprintFields` (`model/sprints.mjs`); `loadProject` (`config.mjs`); the file's own `loadState`, `saveState`, `hashContent`, `buildPrompt`, `extractGroomingRules`, `snapshotTree`, `diffSnapshots`, `outOfBoundsPaths`, `redactSecrets`, `DEFAULT_TIMEOUT_SEC`, `DEFAULT_MAX_BUFFER_MB`.
- Produces:
  - `selectNextTicketDb({ projectsDir, cfg, state, readStorage }) → Promise<{ id, project, status, file, raw } | null>` — columns order, then `cfg.projects` order, then numeric-aware id order; ungroomed = `state.groomed[id] !== hashContent(serializeTicket(t))`.
  - `groomOnceDb({ root, projectsDir, cfg, agentsMd, today, readStorage, writePort }) → Promise<event|null>`. Events: `null`; `{ type:"groom", id, noop:true, ts }`; `{ type:"groom", id, refused:true, reason: "out-of-bounds"|"unparseable"|"identity-field"|"invalid", outOfBounds, ts, fields?|errors? }`; `{ type:"groom", id, error, ts, timedOut? }`; success `{ type:"groom", id, files:["<id>.md"], ts }` (no `sha`). Writes with ctx `{ actor: "groomer", source: "loop" }`.

- [ ] **Step 1: Write the failing tests.** In `tests/groomer-db-mode.test.mjs` change the `node:fs` import to include `readFileSync`:

```js
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
```

add after `import { scratchRegistry } from "./helpers/scratch.mjs";`:

```js
import { runDb } from "../scripts/db-runner.mjs";
import { resolvePorts } from "../scripts/model/write-port-resolve.mjs";
import { groomOnceDb } from "../scripts/loops/groomer.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";
```

and append at the end of the file:

```js
// --- BLZ-673: db mode --------------------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10);

/** A SQLite db-mode board (ENG-1 loaded by `blaze db init`) whose agent runs `script` in the
 *  scratch dir. `$BLAZE_GROOM_TARGET` names the materialised file; `mark` is a directory
 *  OUTSIDE the scratch dir the stub may write evidence into. */
async function dbGroomBoard(script) {
  const roots = dbBoard();
  const mark = scratch(mkdtempSync(join(tmpdir(), "blz673-groom-mark-")));
  const stub = join(roots.dataRoot, "stub-agent.sh");
  writeFileSync(stub, `#!/usr/bin/env bash\nset -e\npwd > "${mark}/cwd"\n${script}\n`);
  chmodSync(stub, 0o755);
  writeFileSync(join(roots.dataRoot, "blaze.config.json"), JSON.stringify({
    projects: ["ENG"], schemaVersion: 2, agentCommand: `bash ${stub}`,
    loops: { groomer: { columns: ["defined"] } },
  }));
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  return { ...roots, mark };
}

/** One db-mode pass called DIRECTLY (no supervisor): resolve, groom, always close. */
async function groomDirect(roots) {
  const cfg = loadConfig({ root: roots.dataRoot, env: {} });
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    return await groomOnceDb({ root: roots.dataRoot, projectsDir: roots.projectsDir, cfg,
      agentsMd: "", today: today(), readStorage: ports.readStorage, writePort: ports.writePort });
  } finally { await ports.close(); }
}

async function readBack(roots) {
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try { return (await ports.readStorage.getTicket(roots.projectsDir, "ENG-1")).found; }
  finally { await ports.close(); }
}

test("groomOnceDb grooms ENG-1 through the port — the edit reads back, `updated` is stamped, scratch is gone",
     async () => {
  const roots = await dbGroomBoard(`printf '\\nGroomer proposals: add a test.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const d0 = today();
  const groom = await groomDirect(roots);
  assert.ok(groom && !groom.refused && !groom.error, JSON.stringify(groom));
  assert.deepEqual(groom.files, ["ENG-1.md"]);
  assert.equal(groom.sha, undefined, "nothing is committed in db mode");
  const back = await readBack(roots);
  assert.match(back.body, /Groomer proposals: add a test\./);
  assert.ok([d0, today()].includes(back.frontmatter.updated), back.frontmatter.updated);
  const cwd = readFileSync(join(roots.mark, "cwd"), "utf8").trim();
  assert.notEqual(cwd, roots.dataRoot, "the agent ran in a scratch dir, not the board");
  assert.equal(existsSync(cwd), false, "the scratch dir is removed after the pass");
  assert.equal(await groomDirect(roots), null,
    "a groomed ticket is not re-groomed: its hash is recorded against what the store holds");
});

test("groomOnceDb: a file written beside the ticket is refused, and nothing is written", async () => {
  const roots = await dbGroomBoard(
    `printf 'x\\n' >> "$BLAZE_GROOM_TARGET"\ntouch stray.txt`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "out-of-bounds");
  assert.deepEqual(groom.outOfBounds, ["stray.txt"]);
  assert.doesNotMatch((await readBack(roots)).body, /^x$/m);
});

test("groomOnceDb: changing an identity field (`created`) is refused by name, and nothing is written", async () => {
  const roots = await dbGroomBoard(
    `sed -i -e 's/^created: .*/created: 1999-01-01/' -e 's/^title: A task$/title: Retitled/' "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "identity-field");
  assert.deepEqual(groom.fields, ["created"]);
  const back = await readBack(roots);
  assert.equal(back.frontmatter.title, "A task", "the allowed half of a refused edit is not written either");
  assert.equal(back.frontmatter.created, "2026-01-01");
});

test("groomOnceDb: a result that fails validation is refused with the validator's errors", async () => {
  const roots = await dbGroomBoard(`sed -i 's/^type: task$/type: nonsense/' "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "invalid");
  assert.match(groom.errors.join("\n"), /unknown or missing type: nonsense/);
  assert.equal((await readBack(roots)).frontmatter.type, "task");
});

```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/groomer-db-mode.test.mjs`
Expected: FAIL — `SyntaxError: The requested module '../scripts/loops/groomer.mjs' does not provide an export named 'groomOnceDb'`.

- [ ] **Step 3: Implement.** In `scripts/loops/groomer.mjs` replace the import block

```js
import {
  readdirSync, writeFileSync, existsSync, mkdirSync, rmSync,
  lstatSync, readlinkSync, symlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseTicket } from "../model/ticket.mjs";
```

with

```js
import {
  readdirSync, writeFileSync, existsSync, mkdirSync, rmSync,
  lstatSync, readlinkSync, symlinkSync, mkdtempSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseTicket, serializeTicket } from "../model/ticket.mjs";
import { EDITABLE_FIELDS } from "../model/fields.mjs";
import { validateTicket } from "../model/rules.mjs";
import { loadProjectSchema } from "../model/schema-config.mjs";
import { validateTaxonomy } from "../model/taxonomy.mjs";
import { loadSprints, validateSprintFields } from "../model/sprints.mjs";
import { loadProject } from "../config.mjs";
```

and insert immediately above `// CLI: \`node scripts/loops/groomer.mjs\` runs one grooming pass.`:

```js
// --- BLZ-673: the groomer under BLAZE_WRITE_PORT=db --------------------------------------
//
// Under db the database is the store: there is no ticket FILE to hand the agent, and a git
// commit would record nothing anything reads. So the ticket is MATERIALISED — serialised into
// a fresh scratch directory — the agent edits that file exactly as it edits one on the fs path,
// and the result goes back through the WRITE PORT. `groomOnce` (the fs path) is not touched.

/** Keys the groomer may change: the fields a person may edit (`EDITABLE_FIELDS`, the same
 *  allowlist `blaze edit` and the board use) plus the `updated` stamp. `id`, `project`,
 *  `status`, `resolution`, `created`, `branch`, `pr` and every derived field are not its. */
const GROOMER_MAY_CHANGE = new Set([...EDITABLE_FIELDS, "updated"]);

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The first ungroomed ticket, from the READER: the configured columns in order, then the
 *  configured projects in order, then id order. "Ungroomed" is the fs path's test applied to
 *  the materialised text: `state.groomed[id] !== hashContent(serializeTicket(ticket))`. */
export async function selectNextTicketDb({ projectsDir, cfg, state, readStorage }) {
  const cols = cfg.loops.groomer.columns;
  const projects = cfg.projects ?? [];
  const byId = (a, b) => String(a.frontmatter.id).localeCompare(String(b.frontmatter.id), "en", { numeric: true });
  const candidates = [...await readStorage.listTickets(projectsDir)]
    .filter((t) => cols.includes(t.status) && projects.includes(t.project))
    .sort((a, b) => cols.indexOf(a.status) - cols.indexOf(b.status)
      || projects.indexOf(a.project) - projects.indexOf(b.project) || byId(a, b));
  for (const t of candidates) {
    const raw = serializeTicket({ frontmatter: t.frontmatter, body: t.body ?? "" });
    if (state.groomed[t.frontmatter.id] !== hashContent(raw)) {
      return { id: t.frontmatter.id, project: t.project, status: t.status, file: t.file, raw };
    }
  }
  return null;
}

/** The edit.mjs checks (validateTicket against the ticket's own project registry, taxonomy,
 *  sprint fields), run on the groomed result. Returns the error list. */
async function validateGroomed({ root, projectsDir, cfg, readStorage, id, frontmatter, body }) {
  const all = new Map();
  for (const t of await readStorage.listTickets(projectsDir)) {
    all.set(t.frontmatter.id, { frontmatter: t.frontmatter, body: t.body });
  }
  all.set(id, { frontmatter, body });
  const project = frontmatter.project ?? id.split("-")[0];
  const { types } = loadProjectSchema(projectsDir, project, { config: cfg });
  const errors = validateTicket({ frontmatter, body }, (pid) => all.get(pid) || null, { types });
  errors.push(...validateTaxonomy(frontmatter, loadProject(project, {
    root, projectsDir, source: `ticket ${id}'s 'project' field`,
  })));
  const { sprints } = loadSprints({ root });
  errors.push(...validateSprintFields(frontmatter, { sprintIds: new Set(sprints.map((s) => s.id)) }));
  return errors;
}

/**
 * One db-mode grooming pass. `readStorage`/`writePort` come from `resolvePorts`, which the
 * caller (supervisor.runGroomer) opens and closes. Returns the same event shapes as
 * `groomOnce`: null (nothing to groom), `{ noop }`, `{ refused, reason }`, `{ error }`, or a
 * success — which carries no `sha`, because nothing is committed.
 */
export async function groomOnceDb({ root, projectsDir, cfg, agentsMd, today, readStorage, writePort }) {
  const state = loadState(root);
  const ticket = await selectNextTicketDb({ projectsDir, cfg, state, readStorage });
  if (!ticket) return null;

  const gcfg = (cfg.loops && cfg.loops.groomer) || {};
  const timeoutSec = Number(gcfg.timeoutSec ?? DEFAULT_TIMEOUT_SEC);
  const maxBufferMb = Number(gcfg.maxBufferMb ?? DEFAULT_MAX_BUFFER_MB);
  const rel = `${ticket.id}.md`;
  const dir = mkdtempSync(join(tmpdir(), "blaze-groom-db-"));
  const record = (raw) => { state.groomed[ticket.id] = hashContent(raw); saveState(root, state); };
  try {
    writeFileSync(join(dir, rel), ticket.raw);
    const prompt = buildPrompt({ ...ticket, rel }, extractGroomingRules(agentsMd), cfg);
    const [cmd, ...args] = cfg.agentCommand.split(" ");
    const before = snapshotTree(dir);
    const r = spawnSync(cmd, [...args, prompt], {
      cwd: dir, encoding: "utf8",
      timeout: Math.max(1, timeoutSec) * 1000, killSignal: "SIGKILL",
      maxBuffer: Math.max(1, maxBufferMb) * 1024 * 1024,
      env: { ...process.env, BLAZE_GROOM_TARGET: rel },
    });

    // Contain: the scratch directory holds ONE file, and that file is the only thing the
    // agent may change. Anything else — a new file, a symlink, a deletion — is refused.
    const after = snapshotTree(dir);
    const touched = diffSnapshots(before, after);
    const stray = [...new Set(outOfBoundsPaths(touched, [rel])
      .concat(touched.filter((f) => (after.entries.get(f) || {}).t === "l")))].sort();
    const refuse = (reason, extra = {}) => {
      console.error(`groomer: refused (${reason}) on ${ticket.id}`);
      return { type: "groom", id: ticket.id, refused: true, reason, outOfBounds: stray, ts: today, ...extra };
    };
    if (stray.length) return refuse("out-of-bounds");

    if (r.error || r.status !== 0) {
      const code = r.error && r.error.code;
      const timedOut = code === "ETIMEDOUT";
      const raw = timedOut
        ? `agent command timed out after ${timeoutSec}s and was killed`
        : code === "ENOBUFS"
          ? `agent output exceeded maxBuffer (${maxBufferMb}MB)`
          : (r.stderr || (r.error && r.error.message) || "agent command failed") + "";
      const evt = { type: "groom", id: ticket.id, error: redactSecrets(raw).slice(0, 200), ts: today };
      if (timedOut) evt.timedOut = true;
      return evt;
    }

    if (!touched.length) {
      record(ticket.raw);
      return { type: "groom", id: ticket.id, noop: true, ts: today };
    }

    // Parse and guard. The comparison is parsed-against-parsed, so formatting the agent did
    // not intend (key order, quoting) is not mistaken for a changed value.
    let was, now;
    try {
      was = parseTicket(ticket.raw);
      now = parseTicket(readRegularFileSync(join(dir, rel), "utf8"));
    } catch (e) { return refuse("unparseable", { errors: [String(e.message).slice(0, 200)] }); }
    const keys = new Set([...Object.keys(was.frontmatter), ...Object.keys(now.frontmatter)]);
    const identity = [...keys].filter((k) => !GROOMER_MAY_CHANGE.has(k)
      && !sameValue(was.frontmatter[k], now.frontmatter[k])).sort();
    if (identity.length) return refuse("identity-field", { fields: identity });

    const frontmatter = { ...now.frontmatter, updated: today };
    const errors = await validateGroomed({ root, projectsDir, cfg, readStorage,
      id: ticket.id, frontmatter, body: now.body });
    if (errors.length) return refuse("invalid", { errors });

    // `source` is the event's CHECKed vocabulary (cli|api|loop|migration|git-backfill); the
    // groomer is a loop, and the actor says which one.
    await writePort.write({ project: ticket.project, status: ticket.status, frontmatter,
                            body: now.body, currentFile: ticket.file },
                          { actor: "groomer", source: "loop" });
    // Hash what the STORE now holds, re-read, so the next pass compares like with like.
    const back = (await readStorage.getTicket(projectsDir, ticket.id)).found;
    record(serializeTicket({ frontmatter: back.frontmatter, body: back.body ?? "" }));
    return { type: "groom", id: ticket.id, files: [rel], ts: today };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Pin the new exports** — in `tests/model/seam-closure.test.mjs` replace

```js
  ["loops/groomer.mjs", { writes: ["saveState", "restoreSnapshot", "groomOnce"], sanctioned: [],
    inert: ["hashContent", "loadState", "statusDirs", "matchersFor", "selectNextTicket",
```

with

```js
  // BLZ-673: `groomOnceDb` is the db-mode verb — it writes the scratch file the agent edits and
  // the groomer state, and writes the ticket through the injected port. `selectNextTicketDb`
  // reads through the injected reader and hashes; it reaches no write.
  ["loops/groomer.mjs", { writes: ["saveState", "restoreSnapshot", "groomOnce", "groomOnceDb"], sanctioned: [],
    inert: ["hashContent", "loadState", "statusDirs", "matchersFor", "selectNextTicket", "selectNextTicketDb",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/groomer-db-mode.test.mjs tests/groomer.test.mjs tests/groomer-containment.test.mjs tests/groomer-propose.test.mjs tests/model/seam-closure.test.mjs`
Expected: PASS — groomer-db-mode `pass 6` (fs control, the still-present BLZ-670 refusal, and the four `groomOnceDb` cases); the fs groomer suites unchanged; seam-closure 21/21.

- [ ] **Step 6: Commit**

```bash
git commit -m "BLZ-673: groomOnceDb — groom through the port via a materialised scratch file" -- scripts/loops/groomer.mjs tests/groomer-db-mode.test.mjs tests/model/seam-closure.test.mjs
```

---

### Task 7: the supervisor and `blaze groom` use the db branch; the BLZ-670 refusal is replaced (BLZ-673)

**Files:**
- Modify: `scripts/supervisor.mjs:15` (import), `:395-424` (`runGroomer`; new `runGroomerDb`)
- Modify: `scripts/loops/groomer.mjs` (CLI block only)
- Modify: `tests/groomer-db-mode.test.mjs` (whole file — the refusal assertion is **replaced**, the behaviour it pinned is deliberately removed)
- Modify: `tests/model/seam-closure.test.mjs` (supervisor `WRITE_ALLOWED` += `groomOnceDb`, additive)

**Interfaces:**
- Consumes: Task 6's `groomOnceDb`; `resolvePorts`, `resolveWriteMode`.
- Produces: `app.runGroomer()` returns `undefined` synchronously in fs/dual (unchanged) and a `Promise` in db. A resolver refusal → one `{ type:"error", loop:"groomer", message, ts }`; `busy` cleared and ports closed in `finally`.

- [ ] **Step 1: Write the failing tests** — replace `tests/groomer-db-mode.test.mjs` with:

```js
// tests/groomer-db-mode.test.mjs — BLZ-670 (final review), then BLZ-673.
//
// BLZ-670 made the supervisor REFUSE the groomer under BLAZE_WRITE_PORT=db: it read `.md`
// files, had an agent edit the file, and committed it, while the database was the store.
// BLZ-673 removes that refusal on purpose — the behaviour it pinned is gone — and replaces it
// with a db branch: the ticket is read through the port, materialised to a scratch file for the
// agent, and the result is written back through the port. The fs-mode control stays.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createApp } from "../scripts/supervisor.mjs";
import { loadConfig } from "../scripts/config.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { resolvePorts } from "../scripts/model/write-port-resolve.mjs";
import { groomOnceDb } from "../scripts/loops/groomer.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const today = () => new Date().toISOString().slice(0, 10);
const TICKET = "---\nid: TASK-001\ntitle: x\ntype: feature\npriority: medium\nlabels: []\n---\nbody\n";

/** A board whose stub agent leaves a marker OUTSIDE the board when it runs, so "a groom ran"
 *  is observable without depending on what the groomer does with the agent's edit. */
function board() {
  const dir = scratch(mkdtempSync(join(tmpdir(), "blaze-groom-dbmode-")));
  const marker = join(scratch(mkdtempSync(join(tmpdir(), "blaze-groom-dbmode-mark-"))), "ran");
  mkdirSync(join(dir, "backlog"), { recursive: true });
  const stub = join(dir, "stub-agent.sh");
  writeFileSync(stub, `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(stub, 0o755);
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({
    key: "TASK", agentCommand: `bash ${stub}`, loops: { groomer: { columns: ["backlog"] } },
  }, null, 2));
  writeFileSync(join(dir, "backlog", "TASK-001-x.md"), TICKET);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
  return { dir, marker };
}

function groomUnder(mode) {
  const { dir, marker } = board();
  const before = process.env.BLAZE_WRITE_PORT;
  process.env.BLAZE_WRITE_PORT = mode;
  const events = [];
  try {
    const app = createApp(loadConfig({ root: dir, env: {} }), { root: dir });
    app.bus.subscribe((e) => events.push(e));
    app.runGroomer();
  } finally {
    if (before === undefined) delete process.env.BLAZE_WRITE_PORT;
    else process.env.BLAZE_WRITE_PORT = before;
  }
  return { events, ran: existsSync(marker) };
}

test("control: under BLAZE_WRITE_PORT=fs the groomer runs the agent", () => {
  assert.equal(groomUnder("fs").ran, true);
});

// --- BLZ-673: db mode --------------------------------------------------------------------

/** A SQLite db-mode board (ENG-1 loaded by `blaze db init`) whose agent runs `script` in the
 *  scratch dir. `$BLAZE_GROOM_TARGET` names the materialised file; `mark` is a directory
 *  OUTSIDE the scratch dir the stub may write evidence into. */
async function dbGroomBoard(script) {
  const roots = dbBoard();
  const mark = scratch(mkdtempSync(join(tmpdir(), "blz673-groom-mark-")));
  const stub = join(roots.dataRoot, "stub-agent.sh");
  writeFileSync(stub, `#!/usr/bin/env bash\nset -e\npwd > "${mark}/cwd"\n${script}\n`);
  chmodSync(stub, 0o755);
  writeFileSync(join(roots.dataRoot, "blaze.config.json"), JSON.stringify({
    projects: ["ENG"], schemaVersion: 2, agentCommand: `bash ${stub}`,
    loops: { groomer: { columns: ["defined"] } },
  }));
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  return { ...roots, mark };
}

async function groomDb(roots) {
  const before = process.env.BLAZE_WRITE_PORT;
  process.env.BLAZE_WRITE_PORT = "db";
  const events = [];
  try {
    const app = createApp(loadConfig({ root: roots.dataRoot, env: {} }), { root: roots.dataRoot });
    app.bus.subscribe((e) => events.push(e));
    await app.runGroomer();
  } finally {
    if (before === undefined) delete process.env.BLAZE_WRITE_PORT;
    else process.env.BLAZE_WRITE_PORT = before;
  }
  return events;
}

/** One db-mode pass called DIRECTLY (no supervisor): resolve, groom, always close. */
async function groomDirect(roots) {
  const cfg = loadConfig({ root: roots.dataRoot, env: {} });
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    return await groomOnceDb({ root: roots.dataRoot, projectsDir: roots.projectsDir, cfg,
      agentsMd: "", today: today(), readStorage: ports.readStorage, writePort: ports.writePort });
  } finally { await ports.close(); }
}

async function readBack(roots) {
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try { return (await ports.readStorage.getTicket(roots.projectsDir, "ENG-1")).found; }
  finally { await ports.close(); }
}

test("groomOnceDb grooms ENG-1 through the port — the edit reads back, `updated` is stamped, scratch is gone",
     async () => {
  const roots = await dbGroomBoard(`printf '\\nGroomer proposals: add a test.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const d0 = today();
  const groom = await groomDirect(roots);
  assert.ok(groom && !groom.refused && !groom.error, JSON.stringify(groom));
  assert.deepEqual(groom.files, ["ENG-1.md"]);
  assert.equal(groom.sha, undefined, "nothing is committed in db mode");
  const back = await readBack(roots);
  assert.match(back.body, /Groomer proposals: add a test\./);
  assert.ok([d0, today()].includes(back.frontmatter.updated), back.frontmatter.updated);
  const cwd = readFileSync(join(roots.mark, "cwd"), "utf8").trim();
  assert.notEqual(cwd, roots.dataRoot, "the agent ran in a scratch dir, not the board");
  assert.equal(existsSync(cwd), false, "the scratch dir is removed after the pass");
  assert.equal(await groomDirect(roots), null,
    "a groomed ticket is not re-groomed: its hash is recorded against what the store holds");
});

test("groomOnceDb: a file written beside the ticket is refused, and nothing is written", async () => {
  const roots = await dbGroomBoard(
    `printf 'x\\n' >> "$BLAZE_GROOM_TARGET"\ntouch stray.txt`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "out-of-bounds");
  assert.deepEqual(groom.outOfBounds, ["stray.txt"]);
  assert.doesNotMatch((await readBack(roots)).body, /^x$/m);
});

test("groomOnceDb: changing an identity field (`created`) is refused by name, and nothing is written", async () => {
  const roots = await dbGroomBoard(
    `sed -i -e 's/^created: .*/created: 1999-01-01/' -e 's/^title: A task$/title: Retitled/' "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "identity-field");
  assert.deepEqual(groom.fields, ["created"]);
  const back = await readBack(roots);
  assert.equal(back.frontmatter.title, "A task", "the allowed half of a refused edit is not written either");
  assert.equal(back.frontmatter.created, "2026-01-01");
});

test("groomOnceDb: a result that fails validation is refused with the validator's errors", async () => {
  const roots = await dbGroomBoard(`sed -i 's/^type: task$/type: nonsense/' "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "invalid");
  assert.match(groom.errors.join("\n"), /unknown or missing type: nonsense/);
  assert.equal((await readBack(roots)).frontmatter.type, "task");
});

test("supervisor under db: runGroomer grooms through the port and publishes the event — no refusal",
     async () => {
  const roots = await dbGroomBoard(`printf '\\nGroomed by the loop.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const events = await groomDb(roots);
  assert.equal(events.filter((e) => e.type === "error").length, 0, JSON.stringify(events));
  const groom = events.find((e) => e.type === "groom");
  assert.ok(groom && !groom.refused, JSON.stringify(events));
  assert.match((await readBack(roots)).body, /Groomed by the loop\./);
});

test("blaze groom (the CLI) under db grooms through the port too", async () => {
  const roots = await dbGroomBoard(`printf '\\nGroomed by the CLI.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const r = spawnSync(process.execPath, [join(SCRIPTS, "loops", "groomer.mjs")], {
    encoding: "utf8", env: { ...process.env, BLAZE_PROJECTS_DIR: roots.projectsDir, BLAZE_WRITE_PORT: "db" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).id, "ENG-1");
  assert.match((await readBack(roots)).body, /Groomed by the CLI\./);
});

test("supervisor under db: a resolver refusal is published as a groomer error, and the loop is not left busy", async () => {
  const roots = dbBoard();   // no `blaze db init`: resolvePorts refuses — no shadow database
  writeFileSync(join(roots.dataRoot, "blaze.config.json"), JSON.stringify({
    projects: ["ENG"], schemaVersion: 2, agentCommand: "true", loops: { groomer: { columns: ["defined"] } },
  }));
  const events = await groomDb(roots);
  const errs = events.filter((e) => e.type === "error" && e.loop === "groomer");
  assert.equal(errs.length, 1, JSON.stringify(events));
  assert.match(errs[0].message, /blaze db init/);
  assert.ok(errs[0].ts);
  assert.equal((await groomDb(roots)).filter((e) => e.type === "error").length, 1,
    "a second run reaches the resolver again — `busy` was cleared in the finally");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/groomer-db-mode.test.mjs`
Expected: FAIL — `supervisor under db: runGroomer grooms…`: 1 error event (`groomer not run: … (BLZ-254)`) where 0 expected; `blaze groom (the CLI)…`: the CLI grooms the *file* path — no ENG-1 body change reads back from the database; `a resolver refusal…`: message `groomer not run…` does not match `/blaze db init/`.

- [ ] **Step 3: Implement the supervisor** — in `scripts/supervisor.mjs` replace `import { groomOnce } from "./loops/groomer.mjs";` with `import { groomOnce, groomOnceDb } from "./loops/groomer.mjs";`, then replace

```js
  function runGroomer() {
    if (loops.groomer.busy) return;
    loops.groomer.busy = true;
    try {
      // BLZ-670 (final review). The groomer picks a ticket by reading `.md` files, has an
      // agent edit that FILE, and commits it. Under BLAZE_WRITE_PORT=db the database is the
      // store, so it would groom stale files that nothing reads. Refused — and said on the
      // bus, in the shape every groomer error takes — until it goes through the port (BLZ-673).
      if (resolveWriteMode() === "db") {
        bus.publish({ type: "error", loop: "groomer", ts: today(),
          message: "groomer not run: it edits ticket files, and under BLAZE_WRITE_PORT=db the database is the store (BLZ-254)" });
        return;
      }
      let agentsMd = "";
```

with

```js
  function runGroomer() {
    if (loops.groomer.busy) return;
    // BLZ-673: under BLAZE_WRITE_PORT=db the groomer reads and writes through the port
    // (groomOnceDb). That path is async; the fs path below stays synchronous and unchanged.
    if (resolveWriteMode() === "db") return runGroomerDb();
    loops.groomer.busy = true;
    try {
      let agentsMd = "";
```

and insert immediately above `  function startLoop(name) {`:

```js
  /** BLZ-673: one db-mode pass. Ports are resolved once per run and ALWAYS closed; a
   *  resolver refusal is published in the shape every groomer error takes. */
  async function runGroomerDb() {
    loops.groomer.busy = true;
    let ports = null;
    try {
      ports = await resolvePorts({ dataRoot: root, projectsDir });
      let agentsMd = "";
      // Same rule as the fs path above: ENOENT is "no rules declared"; a refusal is reported.
      try { agentsMd = readRegularFileSync(join(root, "AGENTS.md"), "utf8"); }
      catch (e) { if (e instanceof NotARegularFileError) throw e; }
      const evt = await groomOnceDb({ root, projectsDir, cfg, agentsMd, today: today(),
                                      readStorage: ports.readStorage, writePort: ports.writePort });
      if (evt) bus.publish(evt);
    } catch (e) {
      bus.publish({ type: "error", loop: "groomer", message: e.message, ts: today() });
    } finally {
      loops.groomer.busy = false;
      if (ports) await ports.close();
    }
  }

```

(`startLoop`, the timer and `/control/groomer/run` call `runGroomer()` without awaiting; `runGroomerDb` catches everything, so no unhandled rejection is possible.)

- [ ] **Step 4: Implement the CLI branch** — in `scripts/loops/groomer.mjs`'s CLI block replace

```js
  const today = new Date().toISOString().slice(0, 10);
  const evt = groomOnce({ root, cfg, agentsMd, today });
  console.log(evt ? JSON.stringify(evt) : "groomer: nothing to groom.");
```

with

```js
  const today = new Date().toISOString().slice(0, 10);
  // BLZ-673: `blaze groom` under BLAZE_WRITE_PORT=db grooms through the port, as the
  // supervisor's loop does. The fs call is unchanged.
  const { resolveWriteMode, resolvePorts } = await import("../model/write-port-resolve.mjs");
  let evt;
  if (resolveWriteMode() === "db") {
    const { projectsDir } = resolveRoots();
    let ports;
    try { ports = await resolvePorts({ dataRoot: root, projectsDir }); }
    catch (e) { console.error(e.message); process.exit(1); }
    try {
      evt = await groomOnceDb({ root, projectsDir, cfg, agentsMd, today,
                                readStorage: ports.readStorage, writePort: ports.writePort });
    } finally { await ports.close(); }
  } else {
    evt = groomOnce({ root, cfg, agentsMd, today });
  }
  console.log(evt ? JSON.stringify(evt) : "groomer: nothing to groom.");
```

- [ ] **Step 5: Seam pin** — in `tests/model/seam-closure.test.mjs` replace

```js
  ["supervisor.mjs", ["groomOnce", "loadIdentity", "reconcile", "viewEnvelope", "resolvePorts", "stageFor"]],
```

with

```js
  // BLZ-673: runGroomer grooms through the port under db (groomOnceDb), resolving ports per run.
  ["supervisor.mjs", ["groomOnce", "groomOnceDb", "loadIdentity", "reconcile", "viewEnvelope", "resolvePorts", "stageFor"]],
```

(Additive; without it: `supervisor.mjs :: an unpinned member \`groomOnceDb\` of the write seam`.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/groomer-db-mode.test.mjs tests/groomer.test.mjs tests/groomer-containment.test.mjs tests/supervisor-surface.test.mjs tests/cli-key-refusal.test.mjs tests/model/seam-closure.test.mjs`
Expected: PASS — groomer-db-mode `pass 8`; the rest unchanged; seam-closure 21/21.

- [ ] **Step 7: Commit**

```bash
git commit -m "BLZ-673: supervisor and blaze groom groom through the port under db; BLZ-670 refusal replaced" -- scripts/supervisor.mjs scripts/loops/groomer.mjs tests/groomer-db-mode.test.mjs tests/model/seam-closure.test.mjs
```

---

### Task 8: docs — `blaze db`, the cutover line, `reserve`, the groomer (BLZ-668/669/671/673)

**Files:**
- Modify: `docs/guide/commands.md` (count line, table row, new `## db` section before `## schedule`, `## groom` paragraph)
- Modify: `docs/design.md:129-131`, `docs/schema-versioning.md:121-123`
- Modify: `docs/decisions/0037-an-inferred-column-mapping-is-a-proposal-a-person-accepts-never-an-import.md` (append), `docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md` (append)

- [ ] **Step 1: `docs/guide/commands.md`.** Change `There are 16\nsubcommands.` to `There are 17\nsubcommands.`; after the `| [\`migrate\`](#migrate) | … |` row add

```markdown
| [`db`](#db) | Create the database schema, seed its id counter, report the dual-write soak | yes (`init`, `seed-counter`); no (`status`) |
```

insert before `## schedule` (i.e. after the `---` that closes `## migrate`):

````markdown
## db

```
blaze db init [--force]
blaze db seed-counter
blaze db status
```

The database behind `BLAZE_WRITE_PORT=dual|db`. `database.driver` in `blaze.config.json`
picks SQLite (the default — the shadow at `.blaze/blaze.db`) or Postgres
([ADR-0012](../decisions/0012-how-an-installation-selects-and-stores-its-database.md)).

| Subcommand | SQLite | Postgres |
|---|---|---|
| `init` | Creates the shadow, loads the board into it, and seeds the id counter. Refuses an existing shadow unless `--force`, which rebuilds both `.blaze/blaze.db` and `.blaze/config.db`. | Creates the schema and seeds the id counter — **the board's tickets are not loaded** (that is the BLZ-254 migration). Refuses a database that already holds a Blaze schema, naming `blaze db seed-counter`. **`--force` is refused**: Blaze never drops a real database's tables from a CLI flag. |
| `seed-counter` | Raises each project's id counter to the highest number already taken — by a ticket file, an `.ids/` claim, or a database row — and prints `project  before → after`. Never lowers a counter; a second run prints `before → after` with the two equal. Refuses a database with no schema, naming `blaze db init`. | Same. |
| `status` | What the shadow holds, and what the dual-write soak has found. | — |

**Before setting `BLAZE_WRITE_PORT=db`, run `blaze db seed-counter` immediately beforehand.**
Every id handed out on the filesystem path since `init` — by `blaze new`, `blaze import`, or
another machine's claim you have pulled — is invisible to the database's counter until it is
re-seeded, and a db-mode `blaze new` would hand the same number out again.

---
````

and append to the `## groom` section, after `No CLI args.`:

```markdown

Under `BLAZE_WRITE_PORT=db` (BLZ-673) the ticket is read from the database and written to a
fresh scratch directory as `<id>.md`; the agent edits that file, and the result is written
back through the write port — nothing is committed. The pass is refused, and nothing written,
if the agent touches any other file there, changes a field outside the editable set (`title`,
`type`, `assignee`, `priority`, `labels`, `components`, `estimate`, `parent`, `likelihood`,
`impact`, `sprint`, `not_before`, `deadline`) plus `updated`, or leaves a ticket
`blaze edit` would reject.
```

- [ ] **Step 2: `docs/design.md`** — replace

```markdown
**Not under `BLAZE_WRITE_PORT=db`:** the groomer reads and edits ticket *files*, so when the
database is the store each pass is refused with a `{ type: "error", loop: "groomer" }` feed event
and grooms nothing (ADR-0038's named residuals; porting it is BLZ-673).
```

with

```markdown
**Under `BLAZE_WRITE_PORT=db`** (BLZ-673) the groomer reads the ticket through the port,
materialises it as `<id>.md` in a scratch directory for the agent, and writes the result back
through the write port — no file on the board is edited and nothing is committed. Anything the
agent writes beside that file, any change to a field outside the editable set plus `updated`,
and any result `blaze edit` would reject is refused and nothing is written.
```

- [ ] **Step 3: `docs/schema-versioning.md`** — replace

```markdown
Version 5 (BLZ-667) adds `project_counter`, the per-project counter db-mode id
allocation advances; `blaze db init` seeds it from the corpus's highest ticket number
per project.
```

with

```markdown
Version 5 (BLZ-667) adds `project_counter`, the per-project counter db-mode id
allocation advances; `blaze db init` seeds it from the highest number already taken per
project — ticket files and `.ids/` claims, plus the database's own rows — on both drivers,
and `blaze db seed-counter` re-seeds it the same way (BLZ-668, BLZ-669). A seed never lowers
a counter.
```

- [ ] **Step 4: ADR-0037 addendum** — append to `docs/decisions/0037-…-never-an-import.md`:

````markdown
## Addendum (2026-09-30, BLZ-671) — ids come from the port too

§1 made the port the only thing that places a ticket. It left the **id** outside it:
`applyImport` called `ids.mjs`'s `allocateId` and wrote the `.ids/` claim itself, so under
`BLAZE_WRITE_PORT=db` an import took numbers from the file ledger while db-mode `blaze new`
took them from `project_counter` — two allocators for one id space, and they collide.

The write port now answers both id questions, and `applyImport` asks it both:

| Question | Port method | fs | db | dual |
|---|---|---|---|---|
| "give me the next id" (`--allocate-ids`) | `allocate(project, { title })` | `allocateId` + claim, injected | `project_counter + 1` | primary |
| "this explicit id is now taken" (`BLZ-900` in the file) | `reserve(id, { project, title })` | the claim, injected | counter raised to the id's number, never lowered | primary |

`reserve` exists because `allocate` cannot express the second question: an explicit id never
passes through the allocator, so without it a later db-mode `new` hands the same number out
again. The fs allocators are built in one place (`fsAllocators`, `write-port-resolve.mjs`)
and import is handed them with `remoteClaims: false` — §3's no-network import, so the fs
output is byte for byte what it was. §1's sentence "nothing in the import path calls `node:fs`
to place a ticket" now holds for the claim as well: `import-apply.mjs` no longer names
`allocateId` or `writeClaim`.
````

- [ ] **Step 5: ADR-0038 addendum** — append to `docs/decisions/0038-…-entry-point.md`:

````markdown
## Addendum (2026-09-30, BLZ-673) — the groomer residual is closed

The third named residual above no longer holds. Under `BLAZE_WRITE_PORT=db` the groomer resolves
both ports once per run (`resolvePorts`, closed in a `finally`), selects from the reader,
materialises the ticket as `<id>.md` in a scratch directory for the agent, and writes the result
through the write port with `{ actor: "groomer", source: "loop" }`. The fs groomer is unchanged.
The supervisor's BLZ-670 refusal is removed; `blaze groom` takes the same db branch.
````

- [ ] **Step 6: Run the doc pins**

Run: `node --test tests/commands-doc-quiet-pins.test.mjs tests/schema-versioning-docs.test.mjs tests/how-it-works-doc-pins.test.mjs tests/quoted-sources.test.mjs tests/shipped-doc-links.test.mjs tests/cli.test.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 7: Commit**

```bash
git commit -m "BLZ-668: docs — blaze db init/seed-counter, cutover line, reserve (ADR-0037), groomer under db (ADR-0038)" -- docs/guide/commands.md docs/design.md docs/schema-versioning.md docs/decisions/0037-an-inferred-column-mapping-is-a-proposal-a-person-accepts-never-an-import.md docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md
```

---

### Final verification (before the PR)

- [ ] Full suite with Postgres, serially:

```bash
BLAZE_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:55433/blaze_test \
  node --test --test-concurrency=1 --test-timeout=120000 --import=./tests/setup/hang-watchdog.mjs
```

Expected (prototype): `tests 5310 … pass 5309, fail 0, skipped 1`.

- [ ] `npm run test:coverage` — the c8 gate still passes (the new logic lives in `scripts/model/`, `scripts/loops/` and `scripts/db-runner.mjs`, all exercised above).
- [ ] `git log --format=%B origin/main..HEAD | grep -ci co-authored-by` → `0`.
- [ ] Stop the Postgres container: `docker stop blz-pg`.
