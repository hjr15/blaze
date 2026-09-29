# Database-mode reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under `BLAZE_WRITE_PORT=db`, every production read of the ticket corpus comes from the database the writes go to, and `db`-mode verbs stop trying to git-commit id handles. `fs` and `dual` modes are unchanged.

**Architecture:** One resolver (`resolveReadStorage` / `resolvePorts`, beside `resolveWritePort`) derives the read source from the same `resolveWriteMode` the write side uses. Async entry points (runners, server handlers) await every read-seam call and pass the materialised ticket list into the unchanged synchronous pure core (`buildIndex`, `boardModel`, …). A mode-aware `stageFor(mode)` replaces direct `commitOrQueue` calls.

**Tech Stack:** Node 24 ESM, `node:test`, `node:sqlite` (`DatabaseSync`), optional `pg`.

**Spec:** `docs/superpowers/specs/2026-09-29-db-mode-reads-design.md` (read it first; §2 is the verified inventory this plan works from).

## Global Constraints

- Node **v24.19.0**. Prefix every shell command with `export PATH=/home/rnamwoh/.local/node24/bin:$PATH`.
- Worktree: `/home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-670`, branch `BLZ-670-db-mode-reads`. Work only there.
- Every commit subject is `BLZ-670: <description>`. **No `Co-Authored-By:` trailer** (`scripts/ci/hygiene-check.mjs` fails on it). Check `git log -1 --format=%B` after every commit.
- Run `node scripts/ci/hygiene-check.mjs origin/main` before handing a task back; it must print `hygiene: clean`.
- The mode source is `resolveWriteMode(env)` **only**. Never read `database.driver` to decide the mode (settled in BLZ-667 Task 9).
- No path passes `create: true` to any opener. A read never writes DDL (BLZ-297).
- `tests/model/seam-closure.test.mjs` may only be extended by addition. Never loosen an existing assertion.
- Every scratch directory in a test goes through `scratchRegistry()` (`tests/helpers/scratch.mjs`), wrapping `mkdtempSync(join(tmpdir(), "<literal-prefix>-"))` with a literal prefix.
- Postgres tests are gated on `BLAZE_TEST_PG_URL` and follow the skip/CI-fail pattern at the bottom of `tests/model/driver-conformance.test.mjs`.
- Do not touch `/home/rnamwoh/Documents/Code/blaze-pm` or its worktrees.
- The full suite runs with `npm test` (after `npm ci` if `node_modules` is missing). Baseline on `5d3476c` without Postgres: 5143 tests / 5137 pass / 0 fail / 6 skipped.

## Review Focus

1. **A `db`-mode reader that is never closed on an error path.** A leaked `pg.Client` hangs a CLI process (the BLZ-534 class). Pinned in Task 4, which asserts `close` is reached when the body throws; the servers use `withReadStorage`, whose `finally` is tested in Task 4.
2. **The SQLite shadow missing, or a board that never ran `blaze db init`, under `BLAZE_WRITE_PORT=db`.** The expected result is a named "run `blaze db init`" refusal, with **no** `blaze.db` file created as a side effect. Pinned in Task 4.
3. **Record-shape drift between the batched Postgres `listTickets` and per-id `getTicket`** (order of labels/components/worklog/links, `note` omission). Pinned by Task 3's parity test.
4. **`dual` mode silently changing behaviour.** Reads must stay filesystem and commits must still happen. Pinned in Task 4 (resolver matrix) and Task 6 (the `stageFor("dual")` identity).
5. **`GET /api/panel` in `db` mode re-reading `row.file` as a path.** In `db` mode that is an id, so it would ENOENT and return 500. Pinned in Task 9 (`panelHtml` with `tickets` never touches disk) and Task 11 (end-to-end).

---

### Task 0: Board bookkeeping (not code; do this before Task 1)

Dispatch `blaze-board-operator` (model `sonnet`) against `/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine` with this brief:

- On BLZ-670:
  - Set the title to `Database-mode reads across every entry point (and no git commit in db mode)`.
  - Set `estimate` to `3000`.
  - Append to `## Notes`: `Re-scoped 2026-09-29 at design time with operator approval: in db mode every verb/runner/server read the filesystem, not only the five buildIndex sites; db-mode verbs also failed at commitOrQueue. Spec: blaze docs/superpowers/specs/2026-09-29-db-mode-reads-design.md.`
  - Replace the AC list with the four bullets from spec §1 and §5.3.
- Do **not** push blaze-pm.
- `blaze move BLZ-670 in-progress` is unnecessary: reconcile will move it once the branch is seen.

### Task 1: The split-brain regression test, proven failing

**Files:**
- Create: `tests/db-mode-reads.test.mjs`

**Interfaces:**
- Consumes: `runDb` (`scripts/db-runner.mjs`), the runner scripts as subprocesses.
- Produces: `dbBoard()` and `runner(name, args, env)` helpers used again in Task 11.

- [ ] **Step 1: Write the test.** It is marked `todo` so the suite stays green until Task 11 removes the marker.

```js
// tests/db-mode-reads.test.mjs — BLZ-670.
//
// THE SPLIT BRAIN, END TO END. Under BLAZE_WRITE_PORT=db every write went to the database and
// every read came from the files, so a second verb on the same ticket judged it by a status the
// database had already moved past. This drives the real runners as subprocesses so nothing in
// between can be mocked away. `todo` until the fix lands (Task 11 removes it) — it must FAIL
// against 5d3476c, and Step 2 below proves that before anything is changed.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runDb } from "../scripts/db-runner.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const TODO = "BLZ-670: removed in Task 11";

export function dbBoard() {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz670-")));
  const projectsDir = join(dataRoot, "projects");
  mkdirSync(join(projectsDir, "ENG", "defined"), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"),
    JSON.stringify({ projects: ["ENG"], schemaVersion: 2 }));
  writeFileSync(join(projectsDir, "ENG", "project.json"),
    JSON.stringify({ key: "ENG", components: [], labels: [] }));
  writeFileSync(join(projectsDir, "ENG", "defined", "ENG-1-a.md"),
    ["---", "id: ENG-1", "title: A task", "type: task", "project: ENG",
     "priority: medium", "assignee: unassigned", "estimate: 30",
     "created: 2026-01-01", "updated: 2026-01-01", "links:", "---", "",
     "## Acceptance Criteria", "", "- [ ] one", ""].join("\n"));
  return { dataRoot, projectsDir };
}

export function runner(name, args, { projectsDir }, extraEnv = {}) {
  return spawnSync(process.execPath, [join(SCRIPTS, name), ...args], {
    encoding: "utf8",
    env: { ...process.env, BLAZE_PROJECTS_DIR: projectsDir, BLAZE_WRITE_PORT: "db",
           BLAZE_READONLY: "", ...extraEnv },
  });
}

const quiet = { log() {}, err() {} };

describe("BLAZE_WRITE_PORT=db: every read comes from the database", () => {
  test("a second move sees the first (the verb reads what it wrote)", { todo: TODO }, async () => {
    const roots = dbBoard();
    assert.equal(0, await runDb(["init"], { ...quiet, roots }));
    const a = runner("move-runner.mjs", ["ENG-1", "in-progress"], roots);
    assert.equal(a.status, 0, a.stderr);
    const b = runner("move-runner.mjs", ["ENG-1", "in-review"], roots);
    assert.equal(b.status, 0, b.stderr);
    // The file never moved: the database is the store now.
    assert.ok(existsSync(join(roots.projectsDir, "ENG", "defined", "ENG-1-a.md")));
  });

  test("reindex writes the database's statuses, not the files'", { todo: TODO }, async () => {
    const roots = dbBoard();
    assert.equal(0, await runDb(["init"], { ...quiet, roots }));
    assert.equal(runner("move-runner.mjs", ["ENG-1", "in-progress"], roots).status, 0);
    const r = runner("reindex.mjs", [], roots);
    assert.equal(r.status, 0, r.stderr);
    const idx = JSON.parse(readFileSync(join(roots.dataRoot, ".blaze", "index.json"), "utf8"));
    assert.equal(idx.tickets.find((t) => t.id === "ENG-1").status, "in-progress");
  });

  test("rollup and audit read the database", { todo: TODO }, async () => {
    const roots = dbBoard();
    assert.equal(0, await runDb(["init"], { ...quiet, roots }));
    const n = runner("new-runner.mjs",
      ["--project", "ENG", "--type", "task", "--estimate", "15", "Created in the db"], roots);
    assert.equal(n.status, 0, n.stderr);
    const au = runner("audit-runner.mjs", ["--json"], roots);
    assert.match(au.stdout, /"ENG-2"|ENG-2/, "audit must see the ticket that exists only in the db");
  });
});
```

- [ ] **Step 2: Prove it discriminates.** Temporarily delete the three `{ todo: TODO }` arguments and run:

Run: `export PATH=/home/rnamwoh/.local/node24/bin:$PATH; node --test tests/db-mode-reads.test.mjs`
Expected: **3 failures**.
- The first fails on `a.status`: the commit of the id handle fails with exit 1.
- The second fails because `index.json` says `defined`.
- The third fails because audit doesn't list ENG-2.

Record the three failure messages in the task report. Restore the `todo` markers.

- [ ] **Step 3: Run with the markers restored.** Expected: 3 `todo`, 0 fail.

- [ ] **Step 4: Commit.**

```bash
git add tests/db-mode-reads.test.mjs
git commit -m "BLZ-670: split-brain regression test for db-mode reads (todo until fixed)"
```

### Task 2: Driver operations `activityFeed`, `unreadableTicketDirs` and `close` on every driver

**Files:**
- Modify: `scripts/model/read-storage.mjs` (extract `readActivityFeed`; add `unreadableTicketDirs` to `fsReadStorage` and `memReadStorage`)
- Modify: `scripts/model/sqlite-storage.mjs` (add `activityFeed`, `unreadableTicketDirs`, `close`)
- Modify: `scripts/model/pg-storage.mjs` (add `activityFeed`, `unreadableTicketDirs`)
- Modify: `tests/model/driver-conformance.test.mjs`

**Interfaces:**
- Produces:
  - `readActivityFeed(dataRoot) → { text, unreadable }` (exported from `read-storage.mjs`).
  - On every driver: `activityFeed(dataRoot)` and `unreadableTicketDirs(root) → Array<{project,status,path,reason,detail,message}>`.
  - `close()` on every driver (sync on fs, mem and SQLite; async on Postgres).

- [ ] **Step 1: Write failing conformance tests.** Add them inside `conformance()` in `tests/model/driver-conformance.test.mjs`, after the `changeToken` test:

```js
  await test(`${name}: activityFeed reads <dataRoot>/.blaze/activity.jsonl, a missing feed is not unreadable`, async (t) => {
    const { s } = await openDriver(make, t);
    const dataRoot = mkdtempSync(join(tmpdir(), "blaze-conf-feed-"));
    t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
    assert.deepEqual(await s.activityFeed(dataRoot), { text: "", unreadable: null });
    mkdirSync(join(dataRoot, ".blaze"), { recursive: true });
    writeFileSync(join(dataRoot, ".blaze", "activity.jsonl"), '{"key":"BLZ-1"}\n');
    if (name === "mem") return;   // the in-memory driver has no feed by contract
    assert.deepEqual(await s.activityFeed(dataRoot), { text: '{"key":"BLZ-1"}\n', unreadable: null });
  });

  await test(`${name}: unreadableTicketDirs is a seam operation`, async (t) => {
    const { s, root } = await openDriver(make, t);
    assert.deepEqual(await s.unreadableTicketDirs(root), []);
  });

  await test(`${name}: close() exists and is safe to await`, async (t) => {
    const { s } = await openDriver(make, t);
    assert.equal(typeof s.close, "function");
  });
```

In `seedSqlite`, change `release(() => s.close?.());` to `release(() => s.close());` so a missing `close` fails loudly.

- [ ] **Step 2: Run the tests and watch them fail.**
Run: `node --test tests/model/driver-conformance.test.mjs`
Expected:
- `sqlite`: `s.activityFeed is not a function` and `s.unreadableTicketDirs is not a function`.
- `fs` and `mem`: the `unreadableTicketDirs` failure.
- `mem` and `fs`: `close` fails if absent.

- [ ] **Step 3: Implement.** In `scripts/model/read-storage.mjs`, move the body of `fsReadStorage.activityFeed` into an exported function (keep its whole comment block above the new function):

```js
import { unreadableTicketDirs as walkUnreadable, walkTickets } from "./index.mjs";

export function readActivityFeed(dataRoot) {
  const path = join(dataRoot, ".blaze", "activity.jsonl");
  try { return { text: readRegularFileSync(path), unreadable: null }; }
  catch (e) {
    if (e?.code === "ENOENT") return { text: "", unreadable: null };
    const detail = e instanceof NotARegularFileError
      ? e.message
      : `${path} could not be read (${(e && e.code) || e})`;
    return { text: "", unreadable: { path, detail } };
  }
}
```

In `fsReadStorage`:

```js
  activityFeed(dataRoot) { return readActivityFeed(dataRoot); },
  // The KNOWN GAP index.mjs's comment names: a fact about the corpus is a named question the
  // driver answers. The walk stays where it is; the database drivers answer [] because a
  // database has no directories to skip.
  unreadableTicketDirs(root) { return walkUnreadable(root); },
  close() {},
```

In `memReadStorage`, add `unreadableTicketDirs(_root) { return []; }` and `close() {}`.

In `sqlite-storage.mjs`, import `readActivityFeed` from `./read-storage.mjs`. Before importing, check that this does not create a cycle; `read-storage.mjs` imports only `index.mjs` and `regular-file.mjs`. Then add to the returned object:

```js
    activityFeed(dataRoot) { return readActivityFeed(dataRoot); },
    unreadableTicketDirs(_root) { return []; },
    close() { try { db.close(); } catch { /* already closed */ } },
```

In `pg-storage.mjs`, import `readActivityFeed` and add:

```js
    // The feed is a hook-written LOCAL file on every board type (read-storage.mjs says why),
    // so the database driver answers it with the same filesystem read, not from a table.
    async activityFeed(dataRoot) { return readActivityFeed(dataRoot); },
    async unreadableTicketDirs(_root) { return []; },
```

- [ ] **Step 4: Run the tests and watch them pass.**
Run: `node --test tests/model/driver-conformance.test.mjs tests/live-unreadable-on-the-seam.test.mjs tests/model/seam-closure.test.mjs`
Expected: all pass. If `seam-closure` flags `sqlite-storage.mjs` or `pg-storage.mjs` importing from `read-storage.mjs`, stop and report; do not loosen the guard.

- [ ] **Step 5: Commit.**
```bash
git add scripts/model/read-storage.mjs scripts/model/sqlite-storage.mjs scripts/model/pg-storage.mjs tests/model/driver-conformance.test.mjs
git commit -m "BLZ-670: activityFeed, unreadableTicketDirs and close on every read driver"
```

### Task 3: Postgres reader over an existing client, plus batched `listTickets`

**Files:**
- Modify: `scripts/model/pg-storage.mjs`
- Create: `tests/model/pg-list-batched.test.mjs`
- Modify: `tests/model/driver-conformance.test.mjs` (parity test)

**Interfaces:**
- Produces:
  - `postgresReader(client) → reader`: synchronous construction and **no schema check**. The caller has already checked; Task 4 does it with `closeOnSetupFailure`.
  - `openPostgresRead(connection, { create })`: unchanged signature. It becomes loadPg → connect → the existing checks → `postgresReader(client)`.
  - `reader.listTickets(root)` issues exactly **5** queries regardless of corpus size.

- [ ] **Step 1: Write a failing unit test with a fake client that counts queries.**

```js
// tests/model/pg-list-batched.test.mjs — BLZ-670.
// listTickets hydrated each row with 4 more queries: ~10,000 round trips for the live corpus.
// A fake client counts them, so this runs without a server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { postgresReader } from "../../scripts/model/pg-storage.mjs";

function fakeClient(n) {
  const calls = [];
  const ids = Array.from({ length: n }, (_, i) => `BLZ-${i + 1}`);
  return {
    calls,
    async query(sql, params) {
      calls.push(sql);
      if (/FROM ticket WHERE deleted_at IS NULL ORDER BY id/.test(sql))
        return { rows: ids.map((id, i) => ({ id, project_key: "BLZ", num: i + 1, type: "task",
          status: "defined", title: id, body: "", created_on: "2026-01-01", updated_on: "2026-01-01" })) };
      if (/FROM ticket_link/.test(sql)) return { rows: [{ src_id: "BLZ-2", link_type: "Blocks", target_id: "BLZ-1" }] };
      if (/FROM ticket_label/.test(sql)) return { rows: [{ ticket_id: "BLZ-1", label: "b", ord: 1 }, { ticket_id: "BLZ-1", label: "a", ord: 0 }] };
      if (/FROM ticket_component/.test(sql)) return { rows: [] };
      if (/FROM worklog_entry/.test(sql)) return { rows: [{ ticket_id: "BLZ-1", on_date: "2026-01-02", minutes: 5, note: null }] };
      return { rows: [] };
    },
    async end() {},
  };
}

test("listTickets costs 5 queries for 50 tickets, not 201", async () => {
  const c = fakeClient(50);
  const recs = await postgresReader(c).listTickets(null);
  assert.equal(recs.length, 50);
  assert.equal(c.calls.length, 5);
});

test("batched hydration groups child rows onto the right ticket, in ord order, omitting a NULL note", async () => {
  const c = fakeClient(2);
  const [one, two] = await postgresReader(c).listTickets(null);
  assert.deepEqual(one.frontmatter.labels, ["a", "b"]);
  assert.deepEqual(one.frontmatter.worklog, [{ date: "2026-01-02", minutes: 5 }]);
  assert.deepEqual(two.frontmatter.links, [{ type: "Blocks", target: "BLZ-1" }]);
  assert.deepEqual(two.frontmatter.labels, []);
});
```

- [ ] **Step 2: Run it and watch it fail.** Expected: `postgresReader is not a function` (import error).

- [ ] **Step 3: Implement.**
  - In `pg-storage.mjs`, split `openPostgresRead`. Everything after the `closeOnSetupFailure(...)` block moves into `export function postgresReader(client)`, and `openPostgresRead` ends with `return postgresReader(client);`.
  - Replace `listTickets` with:

```js
    async listTickets(_root) {
      // Five queries for the whole corpus, not 1 + 4N. Ordered exactly as the per-id fetches
      // order them (links by type,target; labels/components by ord; worklog by on_date,id) —
      // tests/model/driver-conformance.test.mjs pins the two paths against each other.
      const [t, l, lb, cp, wl] = await Promise.all([
        client.query(`SELECT ${COLS} FROM ticket WHERE ${ALIVE} ORDER BY id`),
        client.query("SELECT src_id, link_type, target_id FROM ticket_link ORDER BY src_id, link_type, target_id"),
        client.query("SELECT ticket_id, label, ord FROM ticket_label ORDER BY ticket_id, ord"),
        client.query("SELECT ticket_id, component, ord FROM ticket_component ORDER BY ticket_id, ord"),
        client.query("SELECT ticket_id, on_date::text AS on_date, minutes, note FROM worklog_entry ORDER BY ticket_id, on_date, id"),
      ]);
      const group = (rows, key, map) => {
        const m = new Map();
        for (const r of [...rows].sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0))) {
          if (!m.has(r[key])) m.set(r[key], []);
          m.get(r[key]).push(map(r));
        }
        return m;
      };
      const links = group(l.rows, "src_id", (r) => ({ type: r.link_type, target: r.target_id }));
      const labels = group(lb.rows, "ticket_id", (r) => r.label);
      const comps = group(cp.rows, "ticket_id", (r) => r.component);
      const work = group(wl.rows, "ticket_id", (w) => ({ date: w.on_date, minutes: w.minutes,
        ...(w.note == null ? {} : { note: w.note }) }));
      return t.rows.map((row) => toRecord(row, links.get(row.id) ?? [], labels.get(row.id) ?? [],
        comps.get(row.id) ?? [], work.get(row.id) ?? []));
    },
```

    The link and worklog rows carry no `ord`, so `(a.ord ?? 0) - (b.ord ?? 0)` is 0 for them. `Array.prototype.sort` is stable, so the SQL order is kept.
  - Add a conformance parity test to `driver-conformance.test.mjs`, inside `conformance()`:

```js
  await test(`${name}: listTickets returns the same records getTicket returns, id for id`, async (t) => {
    const { s, root } = await openDriver(make, t);
    for (const rec of [...await s.listTickets(root)]) {
      assert.deepEqual(rec, (await s.getTicket(root, rec.frontmatter.id)).found);
    }
  });
```

- [ ] **Step 4: Run the tests.**
  - `node --test tests/model/pg-list-batched.test.mjs tests/model/driver-conformance.test.mjs` → pass.
  - If a local Postgres is available, repeat with `BLAZE_TEST_PG_URL` set and record the result; otherwise say so explicitly in the report.
- [ ] **Step 5: Commit.** Subject: `BLZ-670: batched Postgres listTickets and postgresReader over an open client`.

### Task 4: `resolveReadStorage`, `resolvePorts`, `withReadStorage` and `stageFor`

**Files:**
- Modify: `scripts/model/write-port-resolve.mjs`
- Modify: `scripts/commit-or-queue.mjs`
- Create: `tests/read-storage-resolve.test.mjs`
- Modify: `tests/commit-or-queue.test.mjs`

**Interfaces:**
- Produces:
  - `resolveReadStorage({ dataRoot, projectsDir, env?, resolveDbConfig?, openPostgresClient?, openSqliteRead? }) → Promise<{ readStorage, mode, close }>`
  - `resolvePorts({ dataRoot, projectsDir, env?, storage?, onDivergence?, resolveDbConfig?, openPostgresClient?, openSqliteRead? }) → Promise<{ writePort, readStorage, mode, close }>`
  - `withReadStorage(opts, fn) → Promise<fn's result>`: resolves the reader, calls `fn(readStorage, mode)`, and always awaits `close()`.
  - `stageFor(mode) → (commitOrQueue args) => result`, and `skipCommit`, both exported from `commit-or-queue.mjs`.

- [ ] **Step 1: Write the failing tests** in `tests/read-storage-resolve.test.mjs`:

```js
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
    assert.equal(0, await runDb(["init"], { log() {}, err() {}, roots }));
    const r = await resolveReadStorage({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
    assert.equal(r.readStorage.name, "sqlite");
    await r.close();
  });

  test("db on sqlite with no shadow refuses by name and creates no file", async () => {
    const roots = board();
    await assert.rejects(resolveReadStorage({ ...roots, env: { BLAZE_WRITE_PORT: "db" } }), /blaze db init/);
    assert.equal(existsSync(shadowDbPath(roots.dataRoot)), false);
  });

  test("db on postgres reads postgres over the resolved client", async () => {
    const log = [];
    const r = await resolveReadStorage({ ...board(), env: { BLAZE_WRITE_PORT: "db" },
      resolveDbConfig: () => PG, openPostgresClient: async () => stampedClient(log) });
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
    const r = await resolvePorts({ ...board(), env: { BLAZE_WRITE_PORT: "db" },
      resolveDbConfig: () => PG, openPostgresClient: async () => { opened++; return stampedClient(log); } });
    assert.equal(opened, 1);
    assert.equal(r.writePort.name, "db");
    assert.equal(r.readStorage.name, "postgres");
    await r.close();
    assert.equal(log.filter((s) => s === "END").length, 1);
  });

  test("fs mode returns the fs reader and an fs port", async () => {
    const r = await resolvePorts({ ...board(), env: {} });
    assert.equal(r.readStorage, fsReadStorage);
    assert.equal(r.mode, "fs");
    r.close();
  });
});

describe("withReadStorage", () => {
  test("closes the reader even when the body throws", async () => {
    const log = [];
    await assert.rejects(withReadStorage({ ...board(), env: { BLAZE_WRITE_PORT: "db" },
      resolveDbConfig: () => PG, openPostgresClient: async () => stampedClient(log) },
      async () => { throw new Error("boom"); }), /boom/);
    assert.equal(log.at(-1), "END");
  });

  test("tags a RESOLUTION failure (blazeResolve) but not a failure inside the body", async () => {
    const e1 = await withReadStorage({ ...board(), env: { BLAZE_WRITE_PORT: "db" } }, async () => {})
      .catch((e) => e);
    assert.equal(e1.blazeResolve, true);   // no shadow: the resolver refused
    const e2 = await withReadStorage({ ...board(), env: {} }, async () => { throw new Error("read"); })
      .catch((e) => e);
    assert.equal(e2.blazeResolve, undefined);
  });
});
```

Add to `tests/commit-or-queue.test.mjs`:

```js
import { stageFor, skipCommit, commitOrQueue } from "../scripts/commit-or-queue.mjs";
test("stageFor: db skips git, fs and dual commit exactly as before", () => {
  assert.equal(stageFor("fs"), commitOrQueue);
  assert.equal(stageFor("dual"), commitOrQueue);
  assert.equal(stageFor("db"), skipCommit);
  assert.deepEqual(skipCommit({ files: ["ENG-1"] }), { ok: true, committed: false, queued: false });
});
```

- [ ] **Step 2: Run them and watch them fail** (the missing exports are import errors).

- [ ] **Step 3: Implement** in `write-port-resolve.mjs`. Factor the Postgres open and check out of `resolveWritePort` so both callers share it:

```js
import { postgresReader } from "./pg-storage.mjs";
import { openSqliteRead as defaultOpenSqliteRead } from "./sqlite-storage.mjs";
import { fsReadStorage } from "./read-storage.mjs";

const unknownMode = (mode) => new Error(
  `blaze: ${WRITE_PORT_ENV}=${JSON.stringify(mode)} is not a write port — `
  + "expected 'fs', 'dual' or 'db'. Leaving it unset uses 'fs', which is the "
  + "filesystem behaviour Blaze has always had.");

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

async function dbConfigFor(dataRoot, resolveDbConfig) {
  const { loadConfig } = await import("../config.mjs");
  return resolveDbConfig({ dataRoot, config: loadConfig({ root: dataRoot }) });
}

function openShadowRead(dataRoot, openSqliteRead) {
  const path = shadowDbPath(dataRoot);
  // existsSync FIRST: `new DatabaseSync(path)` would CREATE an empty file, and a read must
  // never write one (BLZ-297). Same message openShadow gives.
  if (!existsSync(path)) {
    throw new Error(`blaze: no shadow database at ${path}.\n`
      + "Create it and load the board into it first:\n\n    blaze db init\n");
  }
  return openSqliteRead(path);
}

export async function resolveReadStorage({ dataRoot, projectsDir, env = process.env,
                                           resolveDbConfig = resolveDatabaseConfig,
                                           openPostgresClient: openPgClient = openPostgresClient,
                                           openSqliteRead = defaultOpenSqliteRead } = {}) {
  const mode = resolveWriteMode(env);
  if (mode === "fs" || mode === "dual") return { readStorage: fsReadStorage, mode, close() {} };
  if (mode !== "db") throw unknownMode(mode);
  const dbConfig = await dbConfigFor(dataRoot, resolveDbConfig);
  if (dbConfig.driver === "postgres") {
    const client = await openCheckedPg(dbConfig.connection, openPgClient);
    const readStorage = postgresReader(client);
    return { readStorage, mode,
             close: async () => { try { await client.end(); } catch { /* already closed */ } } };
  }
  const readStorage = openShadowRead(dataRoot, openSqliteRead);
  return { readStorage, mode, close: () => readStorage.close() };
}

export async function withReadStorage(opts, fn) {
  let resolved;
  // Only RESOLUTION failures are tagged: a server answers those 503 (fixable, not the caller's
  // fault), while a failure reading the board after resolution keeps each route's own report.
  try { resolved = await resolveReadStorage(opts); }
  catch (e) { if (e && typeof e === "object") e.blazeResolve = true; throw e; }
  try { return await fn(resolved.readStorage, resolved.mode); }
  finally { await resolved.close(); }
}
```

Rewrite `resolveWritePort`'s Postgres branch as `const client = await openCheckedPg(dbConfig.connection, openPgClient);`. Its behaviour and messages must stay identical, and the three existing Postgres tests in `tests/write-port-resolve.test.mjs` must pass unchanged. Replace its inline unknown-mode `Error` with `throw unknownMode(mode)`.

Then add `resolvePorts`:

```js
export async function resolvePorts(opts = {}) {
  const env = opts.env ?? process.env;
  const mode = resolveWriteMode(env);
  if (mode !== "db") {
    const w = await resolveWritePort({ ...opts, env });
    return { writePort: w.port, readStorage: fsReadStorage, mode, close: w.close };
  }
  const dbConfig = await dbConfigFor(opts.dataRoot, opts.resolveDbConfig ?? resolveDatabaseConfig);
  if (dbConfig.driver === "postgres") {
    const client = await openCheckedPg(dbConfig.connection, opts.openPostgresClient ?? openPostgresClient);
    return { writePort: dbWritePort(pgExec(client), { dialect: "postgres" }),
             readStorage: postgresReader(client), mode,
             close: async () => { try { await client.end(); } catch { /* already closed */ } } };
  }
  // SQLite: two handles on one file (spec §4.1) — node:sqlite commits before a write returns.
  const readStorage = openShadowRead(opts.dataRoot, opts.openSqliteRead ?? defaultOpenSqliteRead);
  let shadow;
  try { shadow = await openShadow(opts.dataRoot); }
  catch (e) { readStorage.close(); throw e; }
  return { writePort: dbWritePort(shadow.exec, { dialect: "sqlite" }), readStorage, mode,
           close: () => { readStorage.close(); try { shadow.db.close(); } catch { /* closed */ } } };
}
```

Import cycles: `pg-storage.mjs` is already imported here (`closeOnSetupFailure`). `sqlite-storage.mjs` and `read-storage.mjs` are new imports. Run the seam-closure suite after this step. Its write-seam ledger may name this module's imports explicitly; if it fails, add the new names **additively**, with a comment citing BLZ-670, and report the change.

In `scripts/commit-or-queue.mjs`:

```js
/** BLZ-670 (spec §4.4a): in `db` mode the database is the store and a verb's `file` is an id
 *  handle, not a path — there is nothing on disk for git to stage. The shape matches a
 *  `commitOrQueue` result with neither a commit nor a queue, so commitSuffix prints nothing. */
export function skipCommit() { return { ok: true, committed: false, queued: false }; }
export function stageFor(mode) { return mode === "db" ? skipCommit : commitOrQueue; }
```

- [ ] **Step 4: Run the tests.**
Run: `node --test tests/read-storage-resolve.test.mjs tests/commit-or-queue.test.mjs tests/write-port-resolve.test.mjs tests/model/seam-closure.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit.** Subject: `BLZ-670: resolveReadStorage, resolvePorts, withReadStorage and stageFor`.

### Task 5: Verbs read through the injected reader, awaited

**Files:**
- Modify: `scripts/model/index.mjs` (`locateTicket` becomes async)
- Modify: `scripts/move.mjs`, `scripts/edit.mjs` (both `applyEdit` and `applyToggleAc`), `scripts/log.mjs`, `scripts/resolve.mjs`, `scripts/link.mjs`, `scripts/new.mjs`
- Create: `tests/verbs-read-through-seam.test.mjs`

**Interfaces:**
- Consumes: `memReadStorage` (existing).
- Produces: every `apply*` honours `opts.readStorage` for **every** read, and `locateTicket(projectsDir, id, { storage }) → Promise<{found}|{found:null,duplicates}>`.

- [ ] **Step 1: Write the failing test.** Inject a `memReadStorage` whose record disagrees with the files, then assert that the verb acted on the injected record:

```js
// tests/verbs-read-through-seam.test.mjs — BLZ-670. Every verb ignored `opts.readStorage` for
// its ticket lookup: locateTicket was called without it, so it always walked the files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memReadStorage } from "../scripts/model/read-storage.mjs";
import { applyMove } from "../scripts/move.mjs";
import { applyEdit } from "../scripts/edit.mjs";
import { applyLog } from "../scripts/log.mjs";
import { applyResolve } from "../scripts/resolve.mjs";

const rec = (status) => ({ frontmatter: { id: "ENG-1", title: "t", type: "task", project: "ENG",
  priority: "medium", assignee: "unassigned", estimate: 30, created: "2026-01-01", updated: "2026-01-01",
  links: [], worklog: [] }, body: "## Acceptance Criteria\n\n- [ ] one\n", project: "ENG", status, file: "ENG-1" });

function capturingPort() {
  const seen = [];
  return { seen, port: {
    name: "capture",
    async move(t) { seen.push(["move", t]); return { file: "ENG-1", fromFile: "ENG-1" }; },
    async write(t) { seen.push(["write", t]); return { file: "ENG-1" }; },
    async read() { return null; }, async exists() { return true; }, close() {},
  } };
}

// "/nonexistent/projects" has NO files: a verb that still walks the filesystem finds nothing.
const P = "/nonexistent/blz670/projects";

test("applyMove resolves the ticket through the injected reader", async () => {
  const { port, seen } = capturingPort();
  const r = await applyMove(P, "ENG-1", "in-review", { readStorage: memReadStorage([rec("in-progress")]), writePort: port, requireWorklog: false });
  assert.equal(r.ok, true, r.errors?.join("; "));
  assert.equal(r.from, "in-progress");
  assert.equal(seen[0][0], "move");
});

test("applyLog, applyResolve and applyEdit find the ticket only the reader holds", async () => {
  for (const [fn, args] of [[applyLog, [30, {}]], [applyResolve, ["wont-do"]]]) {
    const { port } = capturingPort();
    const r = await fn(P, "ENG-1", ...args.slice(0, 1), { ...(args[1] ?? {}), readStorage: memReadStorage([rec("defined")]), writePort: port });
    assert.notMatch((r.errors ?? []).join(" "), /ticket not found/, fn.name);
  }
  const { port } = capturingPort();
  const e = await applyEdit(P, "ENG-1", { priority: "high" }, { readStorage: memReadStorage([rec("defined")]), writePort: port });
  assert.notMatch((e.errors ?? []).join(" "), /ticket not found/);
});
```

Before writing this test, the implementer reads `applyLog`'s and `applyResolve`'s real signatures (`scripts/log.mjs:12`, `scripts/resolve.mjs:13`) and adjusts the argument tuples to match. `applyEdit` may fail validation on `project.json` or `blaze.config.json` absence under `P`. The assertion is only that the error is not "ticket not found". If it fails *before* the lookup for a config reason, make `P` a scratch board with no ticket files instead of a nonexistent path.

- [ ] **Step 2: Run it and watch it fail.** Every verb reports `ticket not found: ENG-1`.

- [ ] **Step 3: Implement.**
  - `index.mjs`: `export async function locateTicket(projectsDir, id, { storage = fsReadStorage } = {}) { return await storage.getTicket(projectsDir, id); }`
  - At every `locateTicket` call site (`move.mjs:18`, `edit.mjs:35`, `edit.mjs:100`, `log.mjs:14`, `resolve.mjs:15`, `link.mjs:17`, `link.mjs:23`): `await locateTicket(projectsDir, id, { storage: readStorage })`. `resolve.mjs`, `log.mjs` and `link.mjs` must destructure `readStorage = fsReadStorage` from `opts` if they don't already; import `fsReadStorage` where needed.
  - `move.mjs:51`: `for (const t of await readStorage.blockersOf(projectsDir, id))`.
  - `edit.mjs:48` and `new.mjs:86`: `for (const t of await readStorage.listTickets(projectsDir))`.
  - `applyNew`'s default `writePort` already receives `readStorage`; leave it.
  - `grep -rn "locateTicket(" scripts tests` must show no un-awaited call.
- [ ] **Step 4: Run the tests.**
Run: `node --test tests/verbs-read-through-seam.test.mjs tests/move*.test.mjs tests/edit*.test.mjs tests/log*.test.mjs tests/resolve*.test.mjs tests/link*.test.mjs tests/new*.test.mjs tests/locate-ambiguous-refuses.test.mjs`
Expected: all pass.
- [ ] **Step 5: Commit.** Subject: `BLZ-670: verbs resolve tickets through the injected reader, awaited`.

### Task 6: Verb runners and import use `resolvePorts` and `stageFor`

**Files:**
- Modify: `scripts/move-runner.mjs`, `edit-runner.mjs`, `log-runner.mjs`, `resolve-runner.mjs`, `link-runner.mjs`, `new-runner.mjs`, `import-runner.mjs`
- Modify: `scripts/model/import-apply.mjs` (`loadBoard` becomes async; `runImport` awaits it)
- Modify: `scripts/model/import-mapping.mjs` (`runMappedImport` and `runRepair` await `loadBoard`)
- Test: `tests/db-mode-reads.test.mjs` (Task 1). Its first test's `todo` stays; running it with the marker removed locally must now pass.

**Interfaces:**
- Consumes: `resolvePorts`, `stageFor` (Task 4); the `apply*` `readStorage` option (Task 5).

- [ ] **Step 1: The failing test already exists** (Task 1, test 1). Remove its `todo` locally, run it, and confirm it still fails with the commit error.

- [ ] **Step 2: Implement.** In each verb runner, replace the `resolveWritePort` block with the pattern below (shown for `move-runner.mjs`; the other five differ only in the verb):

```js
import { resolvePorts } from "./model/write-port-resolve.mjs";
import { stageFor, commitSuffix } from "./commit-or-queue.mjs";
// ...
let __wp;
try { __wp = await resolvePorts({ dataRoot, projectsDir }); }
catch (e) { console.error(e.message); process.exit(1); }
const { writePort, readStorage, mode, close: closePorts } = __wp;
let r;
try { r = await applyMove(projectsDir, id, toStatus, { today, writePort, readStorage }); }
catch (e) {
  await closePorts();
  if (e instanceof InvalidProjectKeyError) { console.error(e.message); process.exit(1); }
  throw e;
}
await closePorts();
// ...
const c = stageFor(mode)({ root: dataRoot, mode: cfg.commitMode, op: "move", id, message: `${id}: ${r.from} → ${r.to}`, files: [r.fromFile, r.file] });
```

  Keep every existing comment block. Replace only the lines shown. `closePorts` may be sync or async, so always `await` it.

  In `import-runner.mjs`:
  - Swap `resolveWritePort` for `resolvePorts`.
  - Pass `readStorage` and `stage: stageFor(mode)` into the `common` options object (next to `writePort: wp.writePort`) and into the `runRepair` call.
  - In `import-apply.mjs`, make `loadBoard` `async` and change its loop to `for (const t of await readStorage.listTickets(projectsDir))`. At `:595` it becomes `const board = await loadBoard(...)`.
  - In `import-mapping.mjs:629`: `await loadBoard(...)`; at `:887`: `(await loadBoard(...)).byId`.
  - `grep -rn "loadBoard(" scripts tests` finds every test caller. Add `await` to each and list them in the task report.

- [ ] **Step 3: Run the tests.**
  - `node --test tests/db-mode-reads.test.mjs` with test 1's `todo` removed locally → test 1 passes. Restore the marker.
  - `node --test tests/*runner*.test.mjs tests/import*.test.mjs tests/model/import*.test.mjs tests/event-actor.test.mjs` → all pass.
- [ ] **Step 4: Commit.** Subject: `BLZ-670: verb runners and import resolve both ports once and skip git in db mode`.

### Task 7: `reconcile` reads and writes through the resolved ports

**Files:**
- Modify: `scripts/reconcile.mjs` (`:1852` signature, `:2008`, `:2046`, `:2491`, CLI block `:2607-2611`)
- Modify: `scripts/supervisor.mjs:294` (`runReconcile`)
- Modify: `scripts/serve.mjs:77-79` (`reconcilePreview`)
- Create: `tests/reconcile-db-mode.test.mjs`

**Interfaces:**
- Produces: `reconcile({ …, readStorage, writePort, stage = commitOrQueue })`.

- [ ] **Step 1: Write a failing test.** Call `reconcile({ root, projectsDir, dryRun: true, readStorage: memReadStorage([...]) })` on a scratch board whose files hold nothing. Assert:
  - `--ticket ENG-1` (i.e. `tickets: ["ENG-1"]`) does **not** return the "do not exist on this board" refusal.
  - A reader whose `unreadableTicketDirs` returns one entry produces an `unreadable-ticket-directory` finding. Use `{ ...memReadStorage(...), unreadableTicketDirs: () => [{ message: "X was NOT read" }] }`.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcile } from "../scripts/reconcile.mjs";
import { memReadStorage } from "../scripts/model/read-storage.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";
const scratch = scratchRegistry();
const root = () => {
  const r = scratch(mkdtempSync(join(tmpdir(), "blz670-rec-")));
  mkdirSync(join(r, "projects", "ENG"), { recursive: true });
  writeFileSync(join(r, "blaze.config.json"), JSON.stringify({ projects: ["ENG"], schemaVersion: 2 }));
  return r;
};
const rec = { frontmatter: { id: "ENG-1", type: "task", project: "ENG", title: "t" }, body: "", project: "ENG", status: "defined", file: "ENG-1" };

test("reconcile finds a ticket only the injected reader holds", async () => {
  const r = await reconcile({ root: root(), dryRun: true, tickets: ["ENG-1"], readStorage: memReadStorage([rec]) });
  assert.notMatch(String(r.error ?? ""), /do not exist on this board/);
});

test("reconcile asks the reader which directories it could not read", async () => {
  const rs = { ...memReadStorage([rec]), unreadableTicketDirs: () => [{ message: "X was NOT read" }] };
  const r = await reconcile({ root: root(), dryRun: true, readStorage: rs });
  assert.ok(r.findings.some((f) => f.kind === "unreadable-ticket-directory"));
});
```

- [ ] **Step 2: Run it and watch it fail.** The first test gets the refusal; the second gets no finding.
- [ ] **Step 3: Implement.**
  - `:2008`: `const allTickets = [...(await readStorage.listTickets(projectsDir))];`
  - `:2046`: `for (const u of await readStorage.unreadableTicketDirs(projectsDir))`. Drop the now-unused `unreadableTicketDirs` import if `grep` shows no other use.
  - Add `stage = commitOrQueue` to the signature and replace `commitOrQueue(` at `:2491` with `stage(`.
  - The CLI block wraps the call:

```js
  let ports;
  try { ports = await (apply ? resolvePorts : resolveReadStorage)({ dataRoot: resolveRoots().dataRoot, projectsDir: resolveRoots().projectsDir }); }
  catch (e) { console.error(e.message); process.exit(1); }
  try {
    r = await reconcile({ fetch: fetchFlag, commit: apply, dryRun: !apply,
      projects: sawProject ? projectKeys : null, tickets: sawTicket ? ticketIds : null,
      readStorage: ports.readStorage, writePort: ports.writePort ?? null, stage: stageFor(ports.mode) });
  } catch (e) { /* existing handling */ } finally { await ports.close(); }
```

    Keep the existing `InvalidProjectKeyError` catch inside that `catch`. `resolveRoots` is already imported in `reconcile.mjs`; confirm with grep.
  - `supervisor.mjs:294`: wrap the same way, with `resolvePorts({ dataRoot: root, projectsDir })` and `finally { await ports.close(); }`. A resolver refusal there is logged through the supervisor's existing reconcile-error path; read `runReconcile`'s current catch and reuse it.
  - `serve.mjs` `reconcilePreview`: `return withReadStorage({ dataRoot: root, projectsDir }, (readStorage) => reconcile({ ..., readStorage }))`. The route at `:722` catches a resolver throw and returns `json(503, { errors: [String(e?.message ?? e)] })`.
- [ ] **Step 4: Run the tests.**
Run: `node --test tests/reconcile*.test.mjs tests/supervisor*.test.mjs tests/serve*.test.mjs`
Expected: all pass.
- [ ] **Step 5: Commit.** Subject: `BLZ-670: reconcile reads, writes and stages through the resolved ports`.

### Task 8: The five synchronous CLI scripts read through the resolver

**Files:**
- Modify: `scripts/reindex.mjs`, `scripts/rollup-runner.mjs`, `scripts/audit-runner.mjs`, `scripts/schedule-runner.mjs`, `scripts/export-runner.mjs`
- Modify: `scripts/model/export-rows.mjs` (`exportRows` accepts `{ tickets }`)
- Test: `tests/db-mode-reads.test.mjs` (tests 2 and 3, `todo` removed locally), `tests/reindex*.test.mjs`, `tests/rollup-runner.test.mjs`, `tests/audit*.test.mjs`, `tests/export-runner.test.mjs`, `tests/schedule*.test.mjs`

- [ ] **Step 1: Confirm the failures.** Remove the `todo` from Task 1's tests 2 and 3 locally. Both fail; test 2 fails on `index.json` saying `defined`.
- [ ] **Step 2: Implement.** Each script gets this top-level-await block right after its existing `loadConfig` guard:

```js
import { resolveReadStorage } from "./model/write-port-resolve.mjs";
let __rs;
try { __rs = await resolveReadStorage({ dataRoot, projectsDir }); }
catch (e) { console.error(e.message); process.exit(1); }
const tickets = [...(await __rs.readStorage.listTickets(projectsDir))];
await __rs.close();
```

  Per script:
  - **`reindex.mjs`:** place the block before the `try`, and inside the `try` use `const idx = buildIndex(projectsDir, { tickets });`. Guard the claims check with `const claimErrors = __rs.mode === "db" ? [] : missingClaimErrors(projectsDir, idx.rows);`, with a comment: `// db mode: the claims ledger is the FILESYSTEM allocator's; the database's project_counter is the id authority (BLZ-667). Removing claims is BLZ-254.`
  - **`rollup-runner.mjs`:** `main` becomes `async function main()`, the block goes inside it, and it uses `buildIndex(projectsDir, { tickets })`. The entry becomes `try { await main(); } catch …`.
  - **`audit-runner.mjs`:**
    - Place the block before `const keys = …`.
    - `fsReadStorage.listProjects(projectsDir)` at `:120` becomes `(await __rs.readStorage.listProjects(projectsDir))`. Keep `__rs` open until after `unreadableTicketDirs`, and move `await __rs.close()` below `:199`.
    - `:181` iterates `tickets` from the block. Rename the existing `const tickets = []` accumulator to `const audited = []` and update its uses at `:184` and `:189`.
    - `:199` becomes `await __rs.readStorage.unreadableTicketDirs(projectsDir)`.
    - Remove the `fsReadStorage` import.
  - **`schedule-runner.mjs`:** `:67` iterates the block's `tickets`. Remove the `fsReadStorage` import. Rename the existing `tickets` accumulator to `planned`, and update every reference in the file (grep `tickets` in that file and list each line changed).
  - **`export-runner.mjs`:** `main` becomes async, and the call becomes `exportCsv(projectsDir, { tickets })`. In `export-rows.mjs:110`: `export function exportRows(projectsDir, { storage = fsReadStorage, tickets: given = null } = {}) { const tickets = given ? [...given] : [...storage.listTickets(projectsDir)];`.
- [ ] **Step 3: Run the tests.**
  - `node --test tests/db-mode-reads.test.mjs` with the markers removed locally → tests 2 and 3 pass. Restore the markers.
  - Then run: `node --test tests/reindex*.test.mjs tests/rollup-runner.test.mjs tests/audit*.test.mjs tests/export-runner.test.mjs tests/schedule*.test.mjs tests/model/seam-closure.test.mjs` → all pass.
- [ ] **Step 4: Commit.** Subject: `BLZ-670: reindex, rollup, audit, schedule and export read through the resolver`.

### Task 9: Views accept pre-loaded tickets and feed

**Files:**
- Modify: `scripts/views/data.mjs` (`boardModel`, `liveModel`)
- Modify: `scripts/views/panel-content.mjs` (`panelHtml`)
- Modify: `scripts/views/page.mjs` (`renderView`, `viewEnvelope`, `pageHtml`)
- Create: `tests/views-take-tickets.test.mjs`

**Interfaces:**
- Produces:
  - `boardModel(projectsDir, { …, tickets })`
  - `liveModel(dataRoot, projectsDir, { …, tickets, feed })`
  - `panelHtml(projectsDir, id, { tickets })`
  - `viewEnvelope({ …, tickets })`, `pageHtml({ …, tickets })`, `renderView(name, { …, tickets })`

  When `tickets` is omitted, behaviour is byte-identical to today.

- [ ] **Step 1: Write failing tests.** Use a nonexistent `projectsDir` and supply `tickets`; each view must render the supplied ticket and must not touch disk:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardModel, liveModel } from "../scripts/views/data.mjs";
import { panelHtml } from "../scripts/views/panel-content.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";
const scratch = scratchRegistry();
const rec = { frontmatter: { id: "ENG-1", title: "Only in the db", type: "task", project: "ENG", links: [] },
              body: "db body", project: "ENG", status: "in-progress", file: "ENG-1" };
const board = () => { const r = scratch(mkdtempSync(join(tmpdir(), "blz670-views-")));
  writeFileSync(join(r, "blaze.config.json"), JSON.stringify({ projects: ["ENG"], schemaVersion: 2 })); return r; };

test("boardModel renders supplied tickets", () => {
  const m = boardModel(join(board(), "projects"), { tickets: [rec], flat: true });
  assert.equal(m.index.get("ENG-1").status, "in-progress");
});

test("panelHtml renders the supplied record and never opens row.file (an id in db mode)", () => {
  const html = panelHtml(join(board(), "projects"), "ENG-1", { tickets: [rec] });
  assert.match(html, /db body/);
});

test("liveModel uses the supplied feed and tickets", () => {
  const r = board();
  const feed = { text: JSON.stringify({ ts: new Date().toISOString(), key: "ENG-1", branch: "ENG-1-x", tool: "Edit", cwd: "/" }) + "\n", unreadable: null };
  const m = liveModel(r, join(r, "projects"), { tickets: [rec], feed });
  assert.equal(m.groups[0].key, "ENG-1");
  assert.equal(m.groups[0].status ?? m.groups[0].column, "in-progress");
});
```

The `liveModel` assertion's field name comes from `groupByTicket` (`scripts/model/activity.mjs`). Read it and assert the real field that carries `statusByKey`'s value. `"ENG-1"` is not a real file, so without `tickets` the `panelHtml` test fails with ENOENT on `row.file`.

- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
  - `boardModel`: add `tickets = null` to its options, and use `const walked = tickets ? [...tickets] : [...readStorage.listTickets(projectsDir)];`.
  - `liveModel`: add `tickets = null, feed = null`; then `const { text, unreadable } = feed ?? readStorage.activityFeed(dataRoot);` and `for (const r of buildIndex(projectsDir, tickets ? { tickets } : {}).rows) …`.
  - `panelHtml(projectsDir, id, { tickets = null } = {})`:

```js
  const index = buildIndex(projectsDir, tickets ? { tickets } : {});
  const row = index.get(id);
  if (!row) return null;
  // BLZ-670: a database record already carries frontmatter and body, and its `file` is an id,
  // not a path. Re-reading it from disk is the filesystem's answer to "give me the ticket".
  if (tickets) {
    const t = tickets.find((x) => x.frontmatter?.id === id);
    return panelContentHtml(panelModel(index, id, { frontmatter: t.frontmatter, body: t.body }));
  }
```

    The existing re-read and its comment stay below, unchanged, for the no-`tickets` path.
  - `page.mjs`:
    - Thread `tickets` through `renderView`'s options: `boardModel(pDir, { project, flat: true, index: m.index, tickets })` at `:82`.
    - Thread it through `viewEnvelope`: `boardModel(pDir, { project, focus, flat, tickets })` and pass it on to `renderView`.
    - Thread it through `pageHtml`: `boardModel(pDir, { project, focus, flat, tickets })`. If `pageHtml` calls `renderView`, pass `tickets` there too; grep inside `pageHtml` for `renderView(`.
- [ ] **Step 4: Run the tests.**
Run: `node --test tests/views-take-tickets.test.mjs tests/live-unreadable-on-the-seam.test.mjs tests/board*.test.mjs tests/views/*.test.mjs`
Expected: all pass.
- [ ] **Step 5: Commit.** Subject: `BLZ-670: board, panel and live views accept pre-loaded tickets and feed`.

### Task 10: Both servers read through a per-request reader, and write through `resolvePorts`

**Files:**
- Modify: `scripts/serve.mjs` (`/api/hash :682`, `/api/live :687`, `/api/panel :707`, `/view/:name :724`, `/ :738`, mutating block `:812-860`)
- Modify: `scripts/supervisor.mjs` (`/api/hash :522`, `/view/:name :548`, `/ :567`)
- Create: `tests/serve-db-mode.test.mjs`

**Interfaces:**
- Consumes: `withReadStorage`, `resolvePorts` (Task 4); view `tickets`/`feed` options (Task 9); `stageFor` (Task 4).

- [ ] **Step 1: Write failing tests.** Start `startServer({ projectsDir, root, port: 0, identity: <whatever an existing serve test passes for "no identities"> })`. Copy the setup (identity, CSRF header, closing) from an existing `serve.mjs` HTTP test: `grep -ln "startServer(" tests` and pick the smallest file. Set `process.env.BLAZE_WRITE_PORT = "db"` for the file and restore it in `after()`, as `tests/event-actor.test.mjs:145-160` does. Seed the board with Task 1's `dbBoard()` plus `runDb(["init"])`, then move ENG-1 to `in-progress` through `POST /api/move`. Assert:
  - `POST /api/move` returns 200 (today it is 500 or "commit failed" because of the id handle).
  - `GET /api/panel?id=ENG-1` returns 200 and contains `in-progress`.
  - `GET /api/live` returns 200.
  - `GET /` returns 200 and contains `ENG-1`.
  - `GET /api/hash` changes after the move.
  - With the shadow deleted, `GET /` returns **503** with the `blaze db init` message.

  Write each as its own `test()`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.** In `serve.mjs`, add a helper inside `startServer`'s scope, next to `json`:

```js
    // BLZ-670: every board READ resolves its reader per request, exactly as the write port
    // already is (BLZ-301), and closes it however the request ends. A resolver refusal is the
    // write side's 503 — the caller is not at fault and the condition is fixable.
    const reading = async (fn) => {
      try { return await withReadStorage({ dataRoot: root, projectsDir }, fn); }
      catch (e) {
        if (e?.blazeResolve) return json(503, { errors: [String(e.message)] });
        throw e;
      }
    };
```

  `e.blazeResolve` is set by Task 4's `withReadStorage` on resolution failures only.

  Then, per route:
  - **`/api/hash`:** `return reading(async (rs) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(await rs.changeToken(projectsDir, { project: u.searchParams.get("project") || null })); });`
  - **`/api/live`:** keep the existing try/catch and its 500 body. Inside the `try`: `return await reading(async (rs) => json(200, liveModel(root, projectsDir, { tickets: [...(await rs.listTickets(projectsDir))], feed: await rs.activityFeed(root) })));`
  - **`/api/panel`:** likewise, with `panelHtml(projectsDir, id, { tickets: [...(await rs.listTickets(projectsDir))] })`.
  - **`/view/:name` and `/`:** load `tickets` inside `reading`, and pass `tickets` to `viewEnvelope`/`pageHtml`. Keep `/`'s existing error-page catch around the render.
  - **Mutating block:**
    - Replace `resolveWritePort(...)` with `resolvePorts({ dataRoot: root, projectsDir })`, destructuring `{ writePort, readStorage, mode, close: closeWritePort }`.
    - Pass `readStorage` into every `apply*` call.
    - Replace each `commitOrQueue(` in this block with `stageFor(mode)(`.
    - Keep the existing 503 catch and the existing close-after.

  `supervisor.mjs`: apply the same `reading` helper and the same changes to its `/api/hash`, `/view/:name` and `/`. Its root variable is named `root`; confirm by reading `createApp`'s parameters.
- [ ] **Step 4: Run the tests.**
Run: `node --test tests/serve-db-mode.test.mjs tests/serve*.test.mjs tests/supervisor*.test.mjs tests/board*.test.mjs tests/live*.test.mjs`
Expected: all pass.
- [ ] **Step 5: Commit.** Subject: `BLZ-670: both servers read per request through the resolver and write through resolvePorts`.

### Task 11: The read-seam guard, the regression turned on, and the Postgres twin

**Files:**
- Modify: `tests/model/seam-closure.test.mjs` (additive: one new test)
- Modify: `tests/db-mode-reads.test.mjs` (remove `todo`; add the Postgres twin and the panel/live legs)

- [ ] **Step 1: Add the guard.** It fails first on any bypass left. Reuse the file's `parseModule`/`astIndex`/`jsFiles`:

```js
// BLZ-670: the READ-SOURCE guard. `walkTickets` above keeps reads on the seam; this keeps them
// on the RESOLVED seam. A module that names `fsReadStorage` reads the filesystem whatever
// BLAZE_WRITE_PORT says — that is how every verb read files while writing the database.
const FS_READER_ALLOWED = new Map([
  ["model/read-storage.mjs", "defines it"],
  ["model/index.mjs", "locateTicket's library default"],
  ["model/write-port-resolve.mjs", "the resolver returns it for fs and dual"],
  ["model/write-port.mjs", "fsWritePort's default reader, fs mode only"],
  ["db-runner.mjs", "blaze db init seeds FROM the filesystem by definition"],
  ["migrate/load-corpus.mjs", "the seed source"],
  ["migrate/zero-diff.mjs", "the migration oracle compares fs to db"],
  ["cli.mjs", "preflight lists projects before any runner, from config first"],
  ["views/data.mjs", "library default for callers that pass no tickets"],
  ["move.mjs", "library default; runners inject"], ["edit.mjs", "library default; runners inject"],
  ["new.mjs", "library default; runners inject"], ["log.mjs", "library default; runners inject"],
  ["resolve.mjs", "library default; runners inject"], ["link.mjs", "library default; runners inject"],
  ["reconcile.mjs", "library default; entry points inject"],
  ["model/import-apply.mjs", "library default; the runner injects"],
  ["model/import-mapping.mjs", "library default; the runner injects"],
  ["model/export-rows.mjs", "library default; the runner passes tickets"],
  ["model/import-markdown.mjs", "no production caller (spec §4.3)"],
]);

test("BLZ-670: only allowlisted modules name fsReadStorage; entry points resolve their reader", () => {
  const offenders = [];
  for (const file of jsFiles(SCRIPTS)) {
    const rel = relative(SCRIPTS, file).split("\\").join("/");
    if (FS_READER_ALLOWED.has(rel)) continue;
    const { ast } = parseModule(readFileSync(file, "utf8"));
    if (!ast) { offenders.push(`${rel} (unparseable)`); continue; }
    if (astIndex(ast).nodes.some((n) => n.type === "Identifier" && n.name === "fsReadStorage")) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    "Resolve the reader with resolveReadStorage/resolvePorts (write-port-resolve.mjs) instead.");
});
```

  Before relying on it, check that `parseModule` and `astIndex` exist with these names and return shapes (`callsIn` above uses them). If the allowlist is too wide (a listed file has no `fsReadStorage` reference), remove that entry; the list must be exact. Then prove the guard discriminates: temporarily add `import { fsReadStorage } from "./model/read-storage.mjs"; void fsReadStorage;` to `scripts/rollup-runner.mjs`, run the test, see it name `rollup-runner.mjs`, and revert.
- [ ] **Step 2: Turn on the regression.**
  - Remove all three `todo` markers from `tests/db-mode-reads.test.mjs` and delete the `TODO` constant.
  - Append a `BLAZE_TEST_PG_URL`-gated `describe` that runs `resolvePorts` against real Postgres: `new`, then `move` twice, via `applyNew`/`applyMove` with the resolved ports, then `(await readStorage.getTicket(null, id)).found.status` equals the second move's target.
    - Inject `resolveDbConfig: () => ({ driver: "postgres", connection: process.env.BLAZE_TEST_PG_URL })`.
    - Inject `openPostgresClient: async (c) => { const pg = (await import("pg")).default; const cl = new pg.Client(c); await cl.connect(); return cl; }`.
    - Seed the schema with the same `openPostgresRead(PG, { create: true })` plus `TRUNCATE` pattern that `seedPg` uses in the conformance suite, then insert ENG-1 and a `project_counter` row for ENG.
    - Use the skip/CI-fail guard from the conformance suite's footer.
- [ ] **Step 3: Run the full suite.**
Run: `npm test 2>&1 | tail -15`
Expected: 0 fail. The pass count is the baseline plus the new tests. Record the exact totals.
- [ ] **Step 4: Commit.** Subject: `BLZ-670: read-source seam guard, and the db-mode regression turned on`.

### Task 12: Docs (same PR)

**Files:**
- Create: `docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md`
- Modify: `docs/decisions/0010-v3-storage-port-is-async-the-fs-seam-is-not.md` (append an addendum section)
- Modify: `docs/decisions/0012-how-an-installation-selects-and-stores-its-database.md` (append a note on read-side resolution)

- [ ] **Step 1: ADR-0038.** Match the house ADR format (`# 38. …`, `Date`, `## Status` Accepted (BLZ-670), `## Context`, `## Decision`, `## Consequences`). The content is spec §3 and §4.1, plus:
  - the rejected alternatives (full async cascade; sync SQLite-only; the blocking shim);
  - the `db`-mode git skip (spec §4.4a) and why it does not decide `commit-or-queue.mjs`'s deletion;
  - the named residuals: `transitions.json` from git, `sprints.json`, and connection pooling.
- [ ] **Step 2: ADR-0010 addendum.** Add `## Addendum (2026-09-29, BLZ-670)`: every consumer now awaits every seam call; the synchronous fs seam and the synchronous SQLite driver are unchanged; `await` on their values is a no-op, as the conformance suite already relied on. Link ADR-0038.
- [ ] **Step 3: ADR-0012 note.** One paragraph: in `BLAZE_WRITE_PORT=db` the driver selected by `database.driver` serves reads as well as writes, via `resolvePorts`. Link ADR-0038.
- [ ] **Step 4: Check.** Run `node scripts/ci/hygiene-check.mjs origin/main` and `npm test -- tests/*doc*.test.mjs` (doc-pin tests exist; they must stay green).
- [ ] **Step 5: Commit.** Subject: `BLZ-670: ADR-0038, and ADR-0010/0012 addenda for db-mode reads`.

---

## Finish

1. `git fetch origin`. Then check that `git log origin/main..BLZ-670-db-mode-reads --format=%s` prints only `BLZ-670:` subjects. Also check the branch base: if `git merge-base BLZ-670-db-mode-reads origin/main` is not `origin/main`'s own SHA, main has moved, so rebase or ask the operator before opening the PR.
2. Run the final whole-branch adversarial review: model `opus`, in a separate worktree, by an agent that wrote none of the branch.
3. Open the PR titled `BLZ-670: database-mode reads across every entry point`. Its body lists every sync → async signature change with its callers, the Task 1 red-run evidence, the guard's red-run evidence, and the exact suite totals.
4. Before merging, `gh pr checks --watch`: never `--admin` over a failing check.
