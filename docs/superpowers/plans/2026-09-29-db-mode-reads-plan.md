# Database-mode reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under `BLAZE_WRITE_PORT=db`, every production read of the ticket corpus comes from the database the writes go to, and `db`-mode verbs stop trying to git-commit id handles. `fs` and `dual` modes are unchanged.

**Architecture:**
- One resolver (`resolveReadStorage` / `resolvePorts`, beside `resolveWritePort`) derives the read source from the same `resolveWriteMode` the write side uses.
- Async entry points (runners, server handlers) await every read-seam call and pass the materialised ticket list into the unchanged synchronous pure core (`buildIndex`, `boardModel`, …).
- A mode-aware `stageFor(mode)` replaces direct `commitOrQueue` calls.

**Tech Stack:** Node 24 ESM, `node:test`, `node:sqlite` (`DatabaseSync`), optional `pg`.

**Spec:** `docs/superpowers/specs/2026-09-29-db-mode-reads-design.md`. Read it first; §2 is the verified inventory and §4.4a is the `db`-mode staging rule.

**Revision:** rev 2, after two adversarial reviews (2026-09-29). Every confirmed finding is folded in; the review records are in this session's history.

## Global Constraints

- Node **v24.19.0**. Prefix every shell command with `export PATH=/home/rnamwoh/.local/node24/bin:$PATH`.
- Worktree: `/home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-670`, branch `BLZ-670-db-mode-reads`. Work only there.
- Every commit subject is `BLZ-670: <description>`. **No `Co-Authored-By:` trailer** (`scripts/ci/hygiene-check.mjs` fails on it). Check `git log -1 --format=%B` after every commit.
- Run `node scripts/ci/hygiene-check.mjs origin/main` before handing a task back; it must print `hygiene: clean`.
- The mode source is `resolveWriteMode(env)` **only**. Never read `database.driver` to decide the mode.
- No path passes `create: true` to any opener. A read never writes DDL (BLZ-297).
- **The seam guard (`tests/model/seam-closure.test.mjs`)** pins, per module, exactly which write-reaching or write-primitive symbols the module takes. It also fails on a **stale** entry: a name listed but no longer taken.
  - Any task that changes a module's imports of `resolveWritePort`, `commitOrQueue`, `resolvePorts`, `stageFor` or `fsStorage` updates that module's entry to the exact new set, in the same commit.
  - Each such update carries a one-line `// BLZ-670:` comment saying why.
  - Never add a name the module does not take. Never delete or weaken an assertion.
  - **Every task's final test step runs `node --test tests/model/seam-closure.test.mjs`.**
- Every scratch directory in a test goes through `scratchRegistry()` (`tests/helpers/scratch.mjs`), wrapping `mkdtempSync(join(tmpdir(), "<literal-prefix>-"))` with a literal prefix. No bare `mkdtempSync` + `t.after(rmSync)`.
- A missing named ESM export fails at import time with `SyntaxError: The requested module … does not provide an export named …`. That is the expected red for any test that imports a not-yet-written export.
- Use `assert.doesNotMatch`. `node:assert` has no `notMatch`.
- Postgres tests are gated on `BLAZE_TEST_PG_URL` and follow the skip/CI-fail pattern at the bottom of `tests/model/driver-conformance.test.mjs`. It is not set locally, so say so in any report rather than claim a Postgres result.
- Do not touch `/home/rnamwoh/Documents/Code/blaze-pm` or its worktrees (the only exception is Task 0's dispatched board operator).
- Full suite: `npm test` (after `npm ci` if `node_modules` is missing). Baseline on `5d3476c` without Postgres: 5143 tests / 5137 pass / 0 fail / 6 skipped.

## Review Focus

1. **A `db`-mode reader never closed on an error path.** A leaked `pg.Client` hangs a CLI process (the BLZ-534 class). Pinned in Task 4 (the `withReadStorage` `finally`) and Task 6 (close in `finally` in every runner).
2. **The SQLite shadow missing under `BLAZE_WRITE_PORT=db`.** The expected result is a named "run `blaze db init`" refusal, and no `blaze.db` is created. Pinned in Task 4.
3. **Record-shape drift between batched Postgres `listTickets` and per-id `getTicket`.** Pinned by Task 3's parity test.
4. **`dual` mode silently changing.** Reads must stay filesystem and commits must still happen. Pinned in Task 4 (the resolver matrix and `stageFor("dual") === commitOrQueue`).
5. **A `db`-mode consumer treating `t.file` as a path.** `panelHtml` re-reading it, audit deriving status from `dirname(t.file)`, and `schedule --write` writing to it. Pinned in Tasks 9, 8 and 8 respectively.

---

### Task 0: Board bookkeeping (not code; do this before Task 1)

Dispatch `blaze-board-operator` (model `sonnet`) against `/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine`:

- On BLZ-670:
  - Set the title to `Database-mode reads across every entry point (and no git commit in db mode)`.
  - Set `estimate: 3000`.
  - Append to `## Notes`: `Re-scoped 2026-09-29 at design time with operator approval: in db mode every verb/runner/server read the filesystem, not only the five buildIndex sites; db-mode verbs also failed at commitOrQueue. Spec: blaze docs/superpowers/specs/2026-09-29-db-mode-reads-design.md.`
  - Replace the AC list with:
    - `[ ] Under BLAZE_WRITE_PORT=db (SQLite and Postgres), every verb, CLI runner and both servers read the database the writes go to; fs/dual unchanged.`
    - `[ ] db-mode verbs, import and reconcile --apply succeed without trying to git-commit id handles; real record files are still committed.`
    - `[ ] activityFeed and unreadableTicketDirs are seam operations on every driver; Postgres listTickets is batched.`
    - `[ ] An end-to-end regression and a read-source seam guard pin the above; the design is recorded in ADR-0038.`
- Do **not** push blaze-pm.

### Task 1: Shared db-board helpers and the split-brain regression test (proven failing)

**Files:**
- Create: `tests/helpers/db-board.mjs` (helpers only, with no tests, so importing it registers nothing)
- Create: `tests/db-mode-reads.test.mjs`

**Interfaces:**
- Produces:
  - `dbBoard() → { dataRoot, projectsDir }`: a scratch board with ENG-1 in `defined`.
  - `runner(name, args, roots, extraEnv?) → spawnSync result`, with `BLAZE_WRITE_PORT=db`.
  - `QUIET = { log(){}, err(){} }`.

- [ ] **Step 1: Write the helpers.**

```js
// tests/helpers/db-board.mjs — BLZ-670. Shared by the db-mode tests. Helpers ONLY: a module
// that also declared tests would re-register them in every file that imports it.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scratchRegistry } from "./scratch.mjs";

const scratch = scratchRegistry();
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");
export const QUIET = { log() {}, err() {} };

export function dbBoard() {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz670-board-")));
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
```

`tests/tmp-scratch-attribution.test.mjs` scans for a literal prefix at each `mkdtempSync`; `"blz670-board-"` satisfies it. If that guard only scans `*.test.mjs` or objects to helpers, follow what it says; `tests/helpers/scratch.mjs` is itself a helper, so helpers are allowed.

- [ ] **Step 2: Write the regression test.** It is marked `todo`; each marker is removed by the task that fixes it.

```js
// tests/db-mode-reads.test.mjs — BLZ-670.
//
// THE SPLIT BRAIN, END TO END. Under BLAZE_WRITE_PORT=db every write went to the database and
// every read came from the files. The real runners run as subprocesses, so nothing between
// them can be mocked away. Each test is `todo` until the task that fixes it removes the marker.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runDb } from "../scripts/db-runner.mjs";
import { dbBoard, runner, QUIET } from "./helpers/db-board.mjs";

async function initialised() {
  const roots = dbBoard();
  assert.equal(0, await runDb(["init"], { ...QUIET, roots }));
  return roots;
}
const ok = (r) => assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);

describe("BLAZE_WRITE_PORT=db: every read comes from the database", () => {
  test("a second move sees the first", { todo: "BLZ-670 Task 6" }, async () => {
    const roots = await initialised();
    ok(runner("move-runner.mjs", ["ENG-1", "in-progress"], roots));
    ok(runner("move-runner.mjs", ["ENG-1", "in-review"], roots));
    assert.ok(existsSync(join(roots.projectsDir, "ENG", "defined", "ENG-1-a.md")),
      "the file never moves: the database is the store");
  });

  test("reindex writes the database's statuses", { todo: "BLZ-670 Task 8" }, async () => {
    const roots = await initialised();
    ok(runner("move-runner.mjs", ["ENG-1", "in-progress"], roots));
    ok(runner("reindex.mjs", [], roots));
    const idx = JSON.parse(readFileSync(join(roots.dataRoot, ".blaze", "index.json"), "utf8"));
    assert.equal(idx.tickets.find((t) => t.id === "ENG-1").status, "in-progress");
  });

  test("audit, rollup, export and schedule see a ticket that exists only in the db", { todo: "BLZ-670 Task 8" }, async () => {
    const roots = await initialised();
    ok(runner("new-runner.mjs", ["--project", "ENG", "--type", "task", "--estimate", "15", "Only in the db"], roots));
    const audit = runner("audit-runner.mjs", ["--json"], roots);
    assert.match(audit.stdout, /ENG-2/, "audit");
    const roll = runner("rollup-runner.mjs", ["ENG-2"], roots);
    ok(roll); assert.match(roll.stdout, /ENG-2/, "rollup");
    const exp = runner("export-runner.mjs", ["--format", "csv"], roots);
    ok(exp); assert.match(exp.stdout, /Only in the db/, "export");
    const sch = runner("schedule-runner.mjs", ["migrate-dates"], roots);
    ok(sch); assert.match(sch.stdout, /\b2 tickets\b/, "schedule sees both tickets");
  });

  test("schedule migrate-dates --write refuses in db mode", { todo: "BLZ-670 Task 8" }, async () => {
    const roots = await initialised();
    const r = runner("schedule-runner.mjs", ["migrate-dates", "--write"], roots);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BLAZE_WRITE_PORT=db/);
  });
});
```

Before writing the schedule assertions, check `schedule-runner.mjs`'s real usage line and dry-run output: `grep -n "usage\|tickets;" scripts/schedule-runner.mjs`. Adjust the argv and the `2 tickets` regex to the real text (`:82` prints `${tickets.length} tickets;`).

- [ ] **Step 3: Prove it fails on `5d3476c`, for the reasons it fails today.** Remove the four `todo` options locally and run:
Run: `node --test tests/db-mode-reads.test.mjs`
Expected: 4 failures.
- Tests 1–3 fail at the first mutating runner with `blaze move: file relocated but commit failed (status 128)` or `blaze new: file written but commit failed (status 128)`. That is the commit half of the defect (spec §4.4a).
- Test 4 fails because `--write` is not refused.

The **read** half becomes reachable only after Task 6 fixes the commit. At that point, re-running with the markers removed shows `illegal transition: defined → in-review`, `index.json` saying `defined`, and no ENG-2 in audit (both reviewers reproduced this on a git-initialised board). Record each run's real messages in the task report. Restore the markers.

- [ ] **Step 4: Run with the markers on.** Expected: 4 todo, 0 fail. Also run `node --test tests/tmp-scratch-attribution.test.mjs tests/model/seam-closure.test.mjs`; both must pass.
- [ ] **Step 5: Commit.** Subject: `BLZ-670: db-mode split-brain regression test and shared db-board helpers`.

### Task 2: `activityFeed`, `unreadableTicketDirs` and `close` on every driver

**Files:**
- Modify: `scripts/model/read-storage.mjs`, `scripts/model/sqlite-storage.mjs`, `scripts/model/pg-storage.mjs`
- Modify: `tests/model/driver-conformance.test.mjs`

**Interfaces:**
- Produces:
  - `readActivityFeed(dataRoot) → { text, unreadable }`, exported from `read-storage.mjs`.
  - On every driver: `activityFeed(dataRoot)`, `unreadableTicketDirs(root) → Array<{…, message}>` and `close()`.

- [ ] **Step 1: Write the failing conformance tests.** At the top of `driver-conformance.test.mjs`, add `import { scratchRegistry } from "../helpers/scratch.mjs";` and `const scratch = scratchRegistry();`. Inside `conformance()`, after the `changeToken` test:

```js
  await test(`${name}: activityFeed reads <dataRoot>/.blaze/activity.jsonl; a missing feed is not unreadable`, async (t) => {
    const { s } = await openDriver(make, t);
    const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blaze-conf-feed-")));
    assert.deepEqual(await s.activityFeed(dataRoot), { text: "", unreadable: null });
    if (name === "mem") return;   // the in-memory driver has no feed by contract
    mkdirSync(join(dataRoot, ".blaze"), { recursive: true });
    writeFileSync(join(dataRoot, ".blaze", "activity.jsonl"), '{"key":"BLZ-1"}\n');
    assert.deepEqual(await s.activityFeed(dataRoot), { text: '{"key":"BLZ-1"}\n', unreadable: null });
  });

  await test(`${name}: unreadableTicketDirs is a seam operation`, async (t) => {
    const { s, root } = await openDriver(make, t);
    assert.deepEqual(await s.unreadableTicketDirs(root), []);
  });

  await test(`${name}: close() exists`, async (t) => {
    const { s } = await openDriver(make, t);
    assert.equal(typeof s.close, "function");
  });
```

In `seedSqlite`, change `release(() => s.close?.());` to `release(() => s.close());`.

- [ ] **Step 2: Run the tests and watch them fail.**
Run: `node --test tests/model/driver-conformance.test.mjs`
Expected: `s.activityFeed is not a function` (sqlite), `s.unreadableTicketDirs is not a function` (fs, mem, sqlite), and `close` failures for fs and mem.

- [ ] **Step 3: Implement.** In `read-storage.mjs`, extend the existing `./index.mjs` import (the circular import already exists and is safe) and extract the feed read. Keep the existing comment block above the new function:

```js
import { walkTickets, unreadableTicketDirs as walkUnreadable } from "./index.mjs";

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

`fsReadStorage` gains:

```js
  activityFeed(dataRoot) { return readActivityFeed(dataRoot); },
  // index.mjs's KNOWN GAP, closed: "which directories could this run not read" is a named
  // question the driver answers. The walk stays in index.mjs; database drivers answer [].
  unreadableTicketDirs(root) { return walkUnreadable(root); },
  close() {},
```

`memReadStorage` gains `unreadableTicketDirs(_root) { return []; }` and `close() {}`.

`sqlite-storage.mjs` imports `readActivityFeed` from `./read-storage.mjs`, and its returned object gains:

```js
    activityFeed(dataRoot) { return readActivityFeed(dataRoot); },
    unreadableTicketDirs(_root) { return []; },
    close() { try { db.close(); } catch { /* already closed */ } },
```

`pg-storage.mjs` imports `readActivityFeed`, and its returned object gains:

```js
    // The feed is a hook-written LOCAL file on every board type (read-storage.mjs says why),
    // so the database driver answers it with the same filesystem read, not from a table.
    async activityFeed(dataRoot) { return readActivityFeed(dataRoot); },
    async unreadableTicketDirs(_root) { return []; },
```

- [ ] **Step 4: Run the tests.**
Run: `node --test tests/model/driver-conformance.test.mjs tests/live-unreadable-on-the-seam.test.mjs tests/model/seam-closure.test.mjs`
Expected: all pass (reviewer-measured: 42 conformance tests, 41 pass, 1 skipped Postgres).
- [ ] **Step 5: Commit.** Subject: `BLZ-670: activityFeed, unreadableTicketDirs and close on every read driver`.

### Task 3: Postgres reader over an open client, plus batched `listTickets`

**Files:**
- Modify: `scripts/model/pg-storage.mjs`
- Create: `tests/model/pg-list-batched.test.mjs`
- Modify: `tests/model/driver-conformance.test.mjs` (parity test)

**Interfaces:**
- Produces:
  - `postgresReader(client) → reader`: synchronous construction and no schema check. Callers check first.
  - `openPostgresRead(connection, { create })`: unchanged signature, ending in `return postgresReader(client)`.
  - `reader.listTickets` issues exactly 5 queries.

- [ ] **Step 1: Write the failing test.**

```js
// tests/model/pg-list-batched.test.mjs — BLZ-670. listTickets hydrated each row with 4 more
// queries: ~10,000 round trips on the live corpus. A fake client counts them; no server needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { postgresReader } from "../../scripts/model/pg-storage.mjs";

function fakeClient(n) {
  const calls = [];
  const ids = Array.from({ length: n }, (_, i) => `BLZ-${i + 1}`);
  return {
    calls,
    async query(sql) {
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
  assert.equal((await postgresReader(c).listTickets(null)).length, 50);
  assert.equal(c.calls.length, 5);
});

test("batched hydration groups child rows onto the right ticket, in ord order, omitting a NULL note", async () => {
  const [one, two] = await postgresReader(fakeClient(2)).listTickets(null);
  assert.deepEqual(one.frontmatter.labels, ["a", "b"]);
  assert.deepEqual(one.frontmatter.worklog, [{ date: "2026-01-02", minutes: 5 }]);
  assert.deepEqual(two.frontmatter.links, [{ type: "Blocks", target: "BLZ-1" }]);
  assert.deepEqual(two.frontmatter.labels, []);
});
```

- [ ] **Step 2: Run it and watch it fail.** Expected: `SyntaxError: … does not provide an export named 'postgresReader'`.
- [ ] **Step 3: Implement.**
  - Everything in `openPostgresRead` after its `closeOnSetupFailure(...)` block moves into `export function postgresReader(client)`: `linksFor`, `childrenFor`, `hydrate`, `hydrateAll` and the returned object. `COLS`, `ALIVE` and `toRecord` are module-level already.
  - `openPostgresRead` ends with `return postgresReader(client);`.
  - Replace `listTickets` with:

```js
    async listTickets(_root) {
      // Five queries for the whole corpus, not 1 + 4N. Ordered exactly as the per-id fetches
      // order them (links by type,target; labels/components by ord; worklog by on_date,id) —
      // driver-conformance.test.mjs pins the two paths against each other.
      const [t, l, lb, cp, wl] = await Promise.all([
        client.query(`SELECT ${COLS} FROM ticket WHERE ${ALIVE} ORDER BY id`),
        client.query("SELECT src_id, link_type, target_id FROM ticket_link ORDER BY src_id, link_type, target_id"),
        client.query("SELECT ticket_id, label, ord FROM ticket_label ORDER BY ticket_id, ord"),
        client.query("SELECT ticket_id, component, ord FROM ticket_component ORDER BY ticket_id, ord"),
        client.query("SELECT ticket_id, on_date::text AS on_date, minutes, note FROM worklog_entry ORDER BY ticket_id, on_date, id"),
      ]);
      // Array.prototype.sort is stable, so rows without `ord` (links, worklog) keep SQL order.
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

  - Add the parity test inside `conformance()` in `driver-conformance.test.mjs`:

```js
  await test(`${name}: listTickets returns the same records getTicket returns, id for id`, async (t) => {
    const { s, root } = await openDriver(make, t);
    for (const rec of [...await s.listTickets(root)]) {
      assert.deepEqual(rec, (await s.getTicket(root, rec.frontmatter.id)).found);
    }
  });
```

- [ ] **Step 4: Run the tests.**
Run: `node --test tests/model/pg-list-batched.test.mjs tests/model/driver-conformance.test.mjs tests/model/seam-closure.test.mjs`
Expected: all pass. The Postgres parity result is skipped locally; say so.
- [ ] **Step 5: Commit.** Subject: `BLZ-670: batched Postgres listTickets and postgresReader over an open client`.

### Task 4: `resolveReadStorage`, `resolvePorts`, `withReadStorage` and `stageFor`

**Files:**
- Modify: `scripts/model/write-port-resolve.mjs`, `scripts/commit-or-queue.mjs`, `tests/model/seam-closure.test.mjs` (ledger entries only)
- Create: `tests/read-storage-resolve.test.mjs`
- Modify: `tests/commit-or-queue.test.mjs`

**Interfaces:**
- Produces:
  - `resolveReadStorage({ dataRoot, projectsDir, env?, resolveDbConfig?, openPostgresClient?, openSqliteRead? }) → Promise<{ readStorage, mode, close }>`
  - `resolvePorts({ dataRoot, projectsDir, env?, storage?, onDivergence?, resolveDbConfig?, openPostgresClient?, openSqliteRead? }) → Promise<{ writePort, readStorage, mode, close }>`
  - `withReadStorage(opts, fn) → Promise<fn result>`. A **resolution** error is tagged `e.blazeResolve = true`; an error thrown by `fn` is not.
  - `stageFor(mode) → stage function` (`commit-or-queue.mjs`).

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
    assert.equal(0, await runDb(["init"], { log() {}, err() {}, roots }));
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
```

Add to `tests/commit-or-queue.test.mjs` (match its existing imports; it imports from `../scripts/commit-or-queue.mjs`):

```js
import { stageFor, commitOrQueue } from "../scripts/commit-or-queue.mjs";
test("BLZ-670 stageFor: fs and dual are commitOrQueue itself", () => {
  assert.equal(stageFor("fs"), commitOrQueue);
  assert.equal(stageFor("dual"), commitOrQueue);
});
test("BLZ-670 stageFor(db): id handles are dropped; nothing real left means no commit", () => {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz670-stage-")));
  assert.deepEqual(stageFor("db")({ root, mode: "per-op", op: "move", id: "ENG-1", message: "m",
    files: ["ENG-1", "ENG-1"] }), { ok: true, committed: false, queued: false });
});
```

If `tests/commit-or-queue.test.mjs` has no `scratch` registry or these fs imports, add them in the file's existing style. The positive half, "db mode still commits a real file", is exercised end-to-end by `import` in Task 6.

- [ ] **Step 2: Run them and watch them fail.** Expected: `SyntaxError: … does not provide an export named 'resolveReadStorage'` (and `'stageFor'`).

- [ ] **Step 3: Implement** in `write-port-resolve.mjs`. `sqlite-storage.mjs` already imports `assertConfigNamespace` from this module, so the new import closes a cycle. The reviewer found it harmless (only function references, used at call time), but keep the import at module top so the ordering doesn't change.

```js
import { closeOnSetupFailure, postgresReader } from "./pg-storage.mjs";   // extend the existing import
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

const endQuietly = (client) => async () => { try { await client.end(); } catch { /* already closed */ } };

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
    return { readStorage: postgresReader(client), mode, close: endQuietly(client) };
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
             readStorage: postgresReader(client), mode, close: endQuietly(client) };
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

In `resolveWritePort`:
- Replace the inline Postgres open-and-check with `const client = await openCheckedPg(dbConfig.connection, openPgClient); const exec = pgExec(client);`.
- Replace the unknown-mode `Error` with `throw unknownMode(mode)`.
- Its messages are unchanged, so the three existing Postgres tests in `tests/write-port-resolve.test.mjs` must pass unmodified.

In `scripts/commit-or-queue.mjs` (add `existsSync` to a `node:fs` import and `isAbsolute, join` to the `node:path` import):

```js
/** BLZ-670 (spec §4.4a). In `db` mode the database is the store: a verb's `file` is an id
 *  handle, not a path, and there is nothing for git to stage. Only paths that EXIST are kept —
 *  so a verb commits nothing, while `blaze import`'s receipt and source-id map (real record
 *  files, "a record, not a cache") are still committed. `fs` and `dual` are untouched. */
export function stageFor(mode) {
  if (mode !== "db") return commitOrQueue;
  return (args) => {
    const real = (args.files ?? []).filter((f) => existsSync(isAbsolute(f) ? f : join(args.root, f)));
    return real.length ? commitOrQueue({ ...args, files: real })
                       : { ok: true, committed: false, queued: false };
  };
}
```

**Seam ledger (same commit).** Update `tests/model/seam-closure.test.mjs`:
- The `model/write-port-resolve.mjs` export ledger (`:929`): `writes` += `"resolvePorts"`; `inert` += `"resolveReadStorage"`, `"withReadStorage"`.
- The `commit-or-queue.mjs` export ledger: `writes` += `"stageFor"`. It reaches `commitOrQueue`, so it is a write, not inert.

Each gets a `// BLZ-670:` comment. Run the guard: if it names a different classification (for example, it judges `resolveReadStorage` as reaching a write through `openSqliteRead`), follow the guard's derivation, record it in the report, and never mark a write as inert.

- [ ] **Step 4: Run the tests.**
Run: `node --test tests/read-storage-resolve.test.mjs tests/commit-or-queue.test.mjs tests/write-port-resolve.test.mjs tests/model/seam-closure.test.mjs`
Expected: all pass.
- [ ] **Step 5: Commit.** Subject: `BLZ-670: resolveReadStorage, resolvePorts, withReadStorage and stageFor`.

### Task 5: Verbs read through the injected reader, awaited

**Files:**
- Modify: `scripts/model/index.mjs` (`locateTicket` becomes async), `scripts/move.mjs`, `scripts/edit.mjs`, `scripts/log.mjs`, `scripts/resolve.mjs`, `scripts/link.mjs`, `scripts/new.mjs`
- Create: `tests/verbs-read-through-seam.test.mjs`

**Interfaces:**
- Produces:
  - Every `apply*` honours `opts.readStorage` for every ticket read.
  - `locateTicket(projectsDir, id, { storage }) → Promise`.

- [ ] **Step 1: Write the failing test.** The board has config and a project but **no ticket files**, so a verb that still walks the files finds nothing.

```js
// tests/verbs-read-through-seam.test.mjs — BLZ-670. Every verb ignored `opts.readStorage` for
// its ticket lookup: locateTicket was called without it, so it always walked the files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memReadStorage } from "../scripts/model/read-storage.mjs";
import { applyMove } from "../scripts/move.mjs";
import { applyEdit } from "../scripts/edit.mjs";
import { applyLog } from "../scripts/log.mjs";
import { applyResolve } from "../scripts/resolve.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
function emptyBoard() {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz670-verbs-")));
  const projectsDir = join(dataRoot, "projects");
  mkdirSync(join(projectsDir, "ENG", "defined"), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"), JSON.stringify({ projects: ["ENG"], schemaVersion: 2 }));
  writeFileSync(join(projectsDir, "ENG", "project.json"), JSON.stringify({ key: "ENG", components: [], labels: [] }));
  return projectsDir;
}
const rec = (status) => ({ frontmatter: { id: "ENG-1", title: "t", type: "task", project: "ENG",
  priority: "medium", assignee: "unassigned", estimate: 30, created: "2026-01-01", updated: "2026-01-01",
  links: [], worklog: [] }, body: "## Acceptance Criteria\n\n- [ ] one\n", project: "ENG", status, file: "ENG-1" });
function capturingPort() {
  const seen = [];
  return { seen, port: { name: "capture",
    async move(t) { seen.push(["move", t]); return { file: "ENG-1", fromFile: "ENG-1" }; },
    async write(t) { seen.push(["write", t]); return { file: "ENG-1" }; },
    async read() { return null; }, async exists() { return true; }, close() {} } };
}

test("applyMove resolves the ticket through the injected reader", async () => {
  const { port, seen } = capturingPort();
  const r = await applyMove(emptyBoard(), "ENG-1", "in-review",
    { readStorage: memReadStorage([rec("in-progress")]), writePort: port, requireWorklog: false });
  assert.equal(r.ok, true, r.errors?.join("; "));
  assert.equal(r.from, "in-progress");
  assert.equal(seen[0][0], "move");
});

test("applyEdit finds a ticket only the reader holds", async () => {
  const { port } = capturingPort();
  const r = await applyEdit(emptyBoard(), "ENG-1", { priority: "high" },
    { readStorage: memReadStorage([rec("defined")]), writePort: port });
  assert.equal(r.ok, true, r.errors?.join("; "));
});

test("applyLog and applyResolve find a ticket only the reader holds", async () => {
  // The implementer fills these two calls from the REAL signatures: `sed -n 10,16p scripts/log.mjs`
  // and `sed -n 10,16p scripts/resolve.mjs`. The assertion is fixed: not "ticket not found".
  const P = emptyBoard();
  for (const call of [
    (o) => applyLog(P, "ENG-1", 30, o),
    (o) => applyResolve(P, "ENG-1", "wont-do", o),
  ]) {
    const { port } = capturingPort();
    const r = await call({ readStorage: memReadStorage([rec("defined")]), writePort: port });
    assert.doesNotMatch((r.errors ?? []).join(" "), /ticket not found/);
  }
});
```

The two `call` lambdas above assume `(projectsDir, id, <value>, opts)`. If `sed` shows a different parameter order, correct the lambdas and note it in the report. The assertion stays the same.

- [ ] **Step 2: Run it and watch it fail.** Expected: every test reports `ticket not found: ENG-1`.
- [ ] **Step 3: Implement.**
  - `index.mjs:315`: `export async function locateTicket(projectsDir, id, { storage = fsReadStorage } = {}) { return await storage.getTicket(projectsDir, id); }`. Keep the existing comments.
  - At every call site (`move.mjs:18`, `edit.mjs:35`, `edit.mjs:100`, `log.mjs:14`, `resolve.mjs:15`, `link.mjs:17`, `link.mjs:23`): `await locateTicket(projectsDir, <id>, { storage: readStorage })`.
  - In `log.mjs`, `resolve.mjs` and `link.mjs`, add `readStorage = fsReadStorage` to the options destructure, and import `fsReadStorage` from `./model/read-storage.mjs` where missing.
  - `move.mjs:51`: `for (const t of await readStorage.blockersOf(projectsDir, id))`.
  - `edit.mjs:48` and `new.mjs:86`: `for (const t of await readStorage.listTickets(projectsDir))`.
  - Verify with `grep -rn "locateTicket(" scripts tests`: every call is awaited (the reviewer found no other callers).
- [ ] **Step 4: Run the tests.**
Run: `node --test tests/verbs-read-through-seam.test.mjs tests/move*.test.mjs tests/edit*.test.mjs tests/log*.test.mjs tests/resolve*.test.mjs tests/link*.test.mjs tests/new*.test.mjs tests/locate-ambiguous-refuses.test.mjs tests/model/seam-closure.test.mjs`
Expected: all pass. If the guard flags the new `fsReadStorage` import in `log.mjs`, `resolve.mjs` or `link.mjs` (read primitives are not pinned today; the reviewer found it clean), follow the ledger rule.
- [ ] **Step 5: Commit.** Subject: `BLZ-670: verbs resolve tickets through the injected reader, awaited`.

### Task 6: Verb runners and import use `resolvePorts` and `stageFor`

**Files:**
- Modify: `scripts/move-runner.mjs`, `edit-runner.mjs`, `log-runner.mjs`, `resolve-runner.mjs`, `link-runner.mjs`, `new-runner.mjs`, `import-runner.mjs`
- Modify: `scripts/model/import-apply.mjs` (`loadBoard` becomes async), `scripts/model/import-mapping.mjs`
- Modify (callers of `loadBoard`): `tests/model/import-apply.test.mjs` (the sync `planFor` helper at `:68` becomes async, and its 11 call sites await it), `tests/markdown-round-trip.test.mjs:142,183`
- Modify: `tests/model/seam-closure.test.mjs` (the ledger entries for the seven runners, `:2049-2054` and import-runner's)
- Test: `tests/db-mode-reads.test.mjs` (remove test 1's `todo`)

**Interfaces:**
- Consumes: `resolvePorts`, `stageFor` (Task 4); `apply*`'s `readStorage` (Task 5).

- [ ] **Step 1: The failing test exists.** Run test 1 with its marker removed: it fails with `commit failed (status 128)`.
- [ ] **Step 2: Implement each runner.** The shared shape is: resolve both ports once; pass `readStorage` into `apply*`; always close in `finally`; stage through `stageFor(mode)`. Keep every existing comment. Only the lines shown change.

  **`move-runner.mjs`** and **`edit-runner.mjs`** (both already wrap `apply*` in try/catch):

```js
import { resolvePorts } from "./model/write-port-resolve.mjs";
import { stageFor, commitSuffix } from "./commit-or-queue.mjs";   // replaces the commitOrQueue import
let __wp;
try { __wp = await resolvePorts({ dataRoot, projectsDir }); }
catch (e) { console.error(e.message); process.exit(1); }
const { writePort, readStorage, mode, close: closePorts } = __wp;
let r;
try { r = await applyMove(projectsDir, id, toStatus, { today, writePort, readStorage }); }
catch (e) {
  if (e instanceof InvalidProjectKeyError) { await closePorts(); console.error(e.message); process.exit(1); }
  await closePorts(); throw e;
}
await closePorts();
// ...unchanged...
const c = stageFor(mode)({ root: dataRoot, mode: cfg.commitMode, op: "move", id, message: `${id}: ${r.from} → ${r.to}`, files: [r.fromFile, r.file] });
```

  `edit-runner.mjs` is the same, with its own `applyEdit`/`applyToggleAc` call and its own `commitOrQueue(` → `stageFor(mode)(` replacement.

  **`log-runner.mjs`, `resolve-runner.mjs`, `link-runner.mjs`** (no try/catch around `apply*` today). Add one, so the reader closes on a throw:

```js
let r;
try { r = await applyLog(/* the runner's existing arguments */, { /* existing opts */, writePort, readStorage }); }
finally { await closePorts(); }
```

  Read each file's existing `apply*` call and keep its arguments byte-for-byte apart from adding `readStorage`. Replace its `commitOrQueue(` with `stageFor(mode)(`.

  **`new-runner.mjs`** passes `{ ...opts, writePort }`. Make it `{ ...opts, writePort, readStorage }`, wrap it in `try { … } finally { await closePorts(); }`, and stage through `stageFor(mode)`.

  **`import-runner.mjs`:**
  - Move port resolution **above** the repair branch (`:194`). Change `try { wp = await resolveWritePort(...) }` at `:209` to `resolvePorts`, placed before the `if` that selects repair.
  - The repair branch passes `readStorage: wp.readStorage, stage: stageFor(wp.mode)` into `runRepair`, and calls `await wp.close()` **before** its `process.exit`.
  - The apply path's `common` object uses `writePort: wp.writePort` (it was `wp.port` at `:219`), and adds `readStorage: wp.readStorage` and `stage: stageFor(wp.mode)`.
  - Close in `finally` around `guarded(...)`.
  - Read `:180-235` first. If `runRepair`'s options don't accept `stage`/`readStorage`, check `import-mapping.mjs:803-807`; they do (`readStorage`, `stage`).

  **`loadBoard`:**
  - `import-apply.mjs:309` becomes `export async function loadBoard(…)`, and `:317` becomes `for (const t of await readStorage.listTickets(projectsDir))`.
  - `:595` becomes `const board = await loadBoard(…)`.
  - `import-mapping.mjs:629` becomes `await loadBoard(…)`, and `:887` becomes `(await loadBoard(…)).byId`.
  - Test callers: `tests/model/import-apply.test.mjs` (`planFor` becomes async, and each of its 11 callers awaits it) and `tests/markdown-round-trip.test.mjs:142,183`.
  - Re-grep with `grep -rn "loadBoard(" scripts tests` and list every changed line in the report.

  **Seam ledger:** each of the seven runner entries swaps `resolveWritePort` → `resolvePorts` and `commitOrQueue` → `stageFor`, keeping any other names (e.g. new-runner's `applyNew`). Each gets a `// BLZ-670:` comment. Run the guard; the runner entries must match what the modules take exactly.

- [ ] **Step 3: Run the tests.**
  - Remove test 1's `todo` for good. `node --test tests/db-mode-reads.test.mjs` → test 1 passes.
  - With test 2's marker removed **locally**, confirm the read-side red now shows (`index.json` says `defined`), and record the message. Restore that marker.
  - Then run: `node --test tests/*runner*.test.mjs tests/import*.test.mjs tests/model/import*.test.mjs tests/markdown-round-trip.test.mjs tests/event-actor.test.mjs tests/model/seam-closure.test.mjs` → all pass.
- [ ] **Step 4: Commit.** Subject: `BLZ-670: verb runners and import resolve both ports once and stage by mode`.

### Task 7: `reconcile` reads, writes and stages through the resolved ports

**Files:**
- Modify: `scripts/reconcile.mjs` (`:1852` signature, `:2008`, `:2046`, `:2482-2491` commit block, CLI `:2607-2615`)
- Modify: `scripts/reconcile-commit-report.mjs` (a `db` outcome)
- Modify: `scripts/supervisor.mjs:294` (`runReconcile`), `scripts/serve.mjs:77-79` (`reconcilePreview`) and route `:722`
- Modify: `tests/model/seam-closure.test.mjs` (the `reconcile.mjs`, `supervisor.mjs` and `serve.mjs` entries, as they change)
- Create: `tests/reconcile-db-mode.test.mjs`

**Interfaces:**
- Produces:
  - `reconcile({ …, readStorage, writePort, stage = commitOrQueue, mode = "fs" })`.
  - `commitOutcome` can be `"db"`.

- [ ] **Step 1: Write the failing tests.** An **async** reader is what exposes today's synchronous spread.

```js
// tests/reconcile-db-mode.test.mjs — BLZ-670.
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
const rec = { frontmatter: { id: "ENG-1", type: "task", project: "ENG", title: "t" }, body: "",
              project: "ENG", status: "defined", file: "ENG-1" };
// The ASYNC shape every database reader has. `[...promise]` throws on it; `await` does not.
const asyncReader = (extra = {}) => ({ ...memReadStorage([rec]), listTickets: async () => [rec],
  unreadableTicketDirs: async () => [], ...extra });

test("reconcile awaits listTickets (an async reader is not iterable)", async () => {
  const r = await reconcile({ root: root(), dryRun: true, tickets: ["ENG-1"], readStorage: asyncReader() });
  assert.equal(r.ok, true, r.error);
});

test("reconcile asks the reader which directories it could not read", async () => {
  const r = await reconcile({ root: root(), dryRun: true,
    readStorage: asyncReader({ unreadableTicketDirs: async () => [{ message: "X was NOT read" }] }) });
  assert.ok(r.findings.some((f) => f.kind === "unreadable-ticket-directory"));
});
```

  Add to the existing `reconcile-commit-report` test file (`ls tests | grep commit-report`):

```js
test("BLZ-670: a db-mode apply says the moves are in the database, never 'already matched HEAD'", () => {
  const out = /* the report function that file already calls, with outcome "db" and movedCount 2 */;
  assert.match(out.text, /database/);
  assert.doesNotMatch(out.text, /matched HEAD/);
  assert.equal(out.exit, 0);
});
```

  Fill the report call from that test file's existing calls, using the same function and argument shape with `outcome: "db"`.

  For the `--apply` write path in `db` mode, add a third test to `tests/reconcile-db-mode.test.mjs`. Build it from the smallest existing apply fixture: `grep -ln "commit: true\|dryRun: false" tests/reconcile*.test.mjs`, pick the shortest, and copy its board and git setup. Assert that with `mode: "db"`, a capturing `writePort` (as in Task 5) and `stage: stageFor("db")`:
  - the move goes through `writePort.move`;
  - the ticket file did not move;
  - `r.commitOutcome === "db"`.

- [ ] **Step 2: Run them and watch them fail.**
  - Test 1: `TypeError: … is not iterable`.
  - Test 2: no finding.
  - The report test: no `db` branch.
  - The apply test: outcome `"no-op"` or files moved.
- [ ] **Step 3: Implement.**
  - `:2008`: `const allTickets = [...(await readStorage.listTickets(projectsDir))];`
  - `:2046`: `for (const u of await readStorage.unreadableTicketDirs(projectsDir))`. Remove the `unreadableTicketDirs` import if `grep` shows no other use.
  - Signature: add `stage = commitOrQueue, mode = "fs"`. At `:2491`, `commitOrQueue(` → `stage(`. Where `commitOutcome` is computed from the stage's result (read `:2482-2530`), set `commitOutcome = "db"` when `mode === "db"`.
  - `reconcile-commit-report.mjs`: add, before the `no-op` branch, `if (outcome === "db") return { stream: "out", exit: 0, text: \`reconcile: ${movedCount} ticket(s) moved${suffix} in the database — db mode makes no git commit.\` };`. Match that file's variable names.
  - CLI block (`:2607`):

```js
  const roots = resolveRoots();
  let ports;
  try { ports = await (apply ? resolvePorts : resolveReadStorage)({ dataRoot: roots.dataRoot, projectsDir: roots.projectsDir }); }
  catch (e) { console.error(e.message); process.exit(1); }
  try {
    r = await reconcile({ fetch: fetchFlag, commit: apply, dryRun: !apply,
      projects: sawProject ? projectKeys : null, tickets: sawTicket ? ticketIds : null,
      readStorage: ports.readStorage, writePort: ports.writePort ?? null,
      stage: stageFor(ports.mode), mode: ports.mode });
  } catch (e) {
    if (e instanceof InvalidProjectKeyError) { await ports.close(); console.error(e.message); process.exit(1); }
    await ports.close(); throw e;
  }
  await ports.close();
```

  - `supervisor.mjs` `runReconcile` (`:294`): resolve `resolvePorts({ dataRoot: root, projectsDir })` inside its existing try; pass `readStorage`, `writePort`, `stage: stageFor(mode)` and `mode`; `finally { await ports.close(); }`. A resolver refusal flows into its existing catch.
  - `serve.mjs` `reconcilePreview`: `return withReadStorage({ dataRoot: root, projectsDir }, (readStorage, mode) => reconcile({ fetch: false, commit: false, dryRun: true, root, projectsDir, projects, readStorage, mode }));`. Route `:722`: `try { return json(200, await reconcilePreview({ root, projectsDir })); } catch (e) { if (e?.blazeResolve) return json(503, { errors: [String(e.message)] }); throw e; }`.
  - Seam ledger: update the `reconcile.mjs`, `supervisor.mjs` and `serve.mjs` entries to the exact names they now take (for example, `stageFor`, `resolvePorts`, `withReadStorage` where it is classed a write), each with a `// BLZ-670:` comment.
- [ ] **Step 4: Run the tests.**
Run: `node --test tests/reconcile*.test.mjs tests/supervisor*.test.mjs tests/serve*.test.mjs tests/model/seam-closure.test.mjs`
Expected: all pass.
- [ ] **Step 5: Commit.** Subject: `BLZ-670: reconcile reads, writes and stages through the resolved ports`.

### Task 8: The five synchronous CLI scripts read through the resolver

**Files:**
- Modify: `scripts/reindex.mjs`, `scripts/rollup-runner.mjs`, `scripts/audit-runner.mjs`, `scripts/schedule-runner.mjs`, `scripts/export-runner.mjs`, `scripts/model/export-rows.mjs`
- Modify: `tests/model/seam-closure.test.mjs` if `schedule-runner.mjs`'s entry (`fsStorage`) is affected
- Test: `tests/db-mode-reads.test.mjs` (remove the `todo` from tests 2, 3 and 4)

- [ ] **Step 1: Confirm the failures.** With tests 2–4's markers removed locally, all three fail on the read side (Task 6 fixed the commit side). Record the messages.
- [ ] **Step 2: Implement.** Add `import { resolveReadStorage } from "./model/write-port-resolve.mjs";` at each file's **top level**, never inside a function.
  - **`reindex.mjs`:** inside the existing `try`, **after** `assertWritable(...)` and `mkdirSync(dbDir, …)`, so walk refusals keep going to its `blaze reindex failed:` handler:

```js
  const rs = await resolveReadStorage({ dataRoot, projectsDir });
  let tickets;
  try { tickets = [...(await rs.readStorage.listTickets(projectsDir))]; } finally { await rs.close(); }
  const idx = buildIndex(projectsDir, { tickets });
  // db mode: the claims ledger is the FILESYSTEM allocator's; the database's project_counter is
  // the id authority there (BLZ-667). Removing claims altogether is BLZ-254.
  const claimErrors = rs.mode === "db" ? [] : missingClaimErrors(projectsDir, idx.rows);
```

    A top-level `await` inside a top-level `try` in an ES module is legal.
  - **`rollup-runner.mjs`:** `main` becomes `async function main()`. Right after its `loadConfig`/argv parsing, add `const rs = await resolveReadStorage({ dataRoot, projectsDir }); let tickets; try { tickets = [...(await rs.readStorage.listTickets(projectsDir))]; } finally { await rs.close(); }` and use `buildIndex(projectsDir, { tickets })`. The entry becomes `try { await main(); } catch …`. `rollupLines` stays a synchronous export; tests import it.
  - **`export-runner.mjs`:** the same shape. `main` becomes async, its entry is `try { await main(); } catch …`, and the call is `exportCsv(projectsDir, { tickets })`. In `export-rows.mjs:110`: `export function exportRows(projectsDir, { storage = fsReadStorage, tickets: given = null } = {}) { const tickets = given ? [...given] : [...storage.listTickets(projectsDir)];` (the rest is unchanged).
  - **`audit-runner.mjs`:**
    - Before `const keys = …` (`:118`): `const rs = await resolveReadStorage({ dataRoot, projectsDir }).catch((e) => { console.error(e.message); process.exit(1); });`. Use the file's own `dataRoot`/`projectsDir` names; grep them.
    - `:120`: `?? (await rs.readStorage.listProjects(projectsDir))`.
    - `:181`: `const allTickets = [...(await rs.readStorage.listTickets(projectsDir))];` then `for (const t of allTickets) {`. **Keep the `tickets` accumulator's name**, since lines 184/189/227/268/317/365–371 all use it.
    - `:199`: `const unreadable = await rs.readStorage.unreadableTicketDirs(projectsDir);`, then `await rs.close();`. Also close before every `process.exit` between `:118` and `:199` (the `:126` and `:169` exits).
    - `:271`: `statusOf.set(id, t.status);`. In `db` mode `t.file` is an id, so `dirname` gives `"."` and silences `terminal-goal-unverified-requirement`. Remove `basename`/`dirname` from the imports if now unused.
    - Remove the now-unused `fsReadStorage` import and the `unreadableTicketDirs` import (`:9`).
    - Add a unit test to `tests/audit-terminal-goal-unverified.test.mjs` or its nearest sibling. Feed the runner a board whose ticket `file` values are not status paths, or unit-test through the same function if the runner is subprocess-only. If only a subprocess run is possible, Task 1's test 3 is the coverage; say so.
  - **`schedule-runner.mjs`:**
    - After `resolveRoots()` (`:51`): `const rs = await resolveReadStorage({ dataRoot, projectsDir }).catch((e) => { console.error(e.message); process.exit(1); });`.
    - Refuse `--write` in `db` mode, right after arg parsing: `if (rs.mode === "db" && write) { await rs.close(); console.error("blaze schedule: --write rewrites ticket files directly, and under BLAZE_WRITE_PORT=db the database is the store — refusing. Run the dry run to see the plan; writing it through the port is BLZ-254's."); process.exit(1); }`. Check the file's real flag variable name (`write`).
    - `:67`: `const allTickets = [...(await rs.readStorage.listTickets(projectsDir))]; await rs.close(); for (const t of allTickets) {`. Keep the `tickets` accumulator.
    - Remove the `fsReadStorage` import.
- [ ] **Step 3: Run the tests.**
  - Remove tests 2–4's markers for good. `node --test tests/db-mode-reads.test.mjs` → 4 pass.
  - Then run: `node --test tests/reindex*.test.mjs tests/rollup-runner.test.mjs tests/audit*.test.mjs tests/export-runner.test.mjs tests/schedule*.test.mjs tests/csv-round-trip*.test.mjs tests/model/seam-closure.test.mjs` → all pass.
  - Also run the FIFO case: `grep -ln "FIFO\|mkfifo" tests/reindex*.test.mjs`. If a reindex FIFO test exists it must still pass; if none exists, add one asserting `blaze reindex failed:` on stderr and no stack trace.
- [ ] **Step 4: Commit.** Subject: `BLZ-670: reindex, rollup, audit, schedule and export read through the resolver`.

### Task 9: Views accept pre-loaded tickets and feed

**Files:**
- Modify: `scripts/views/data.mjs` (`boardModel`, `liveModel`), `scripts/views/panel-content.mjs` (`panelHtml`), `scripts/views/page.mjs` (`renderView`, `viewEnvelope`, `pageHtml`)
- Create: `tests/views-take-tickets.test.mjs`

**Interfaces:**
- Produces:
  - `boardModel(projectsDir, { …, tickets })`
  - `liveModel(dataRoot, projectsDir, { …, tickets, feed })`
  - `panelHtml(projectsDir, id, { tickets })`
  - `viewEnvelope({ …, tickets })`, `pageHtml({ …, tickets })`, `renderView(name, { …, tickets })`

  When `tickets` is omitted, behaviour is byte-identical to today.

- [ ] **Step 1: Write the failing tests.**

```js
// tests/views-take-tickets.test.mjs — BLZ-670.
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
  assert.match(panelHtml(join(board(), "projects"), "ENG-1", { tickets: [rec] }), /db body/);
});

test("liveModel uses the supplied feed and tickets", () => {
  const r = board();
  const feed = { text: JSON.stringify({ ts: new Date().toISOString(), key: "ENG-1", branch: "ENG-1-x", tool: "Edit", cwd: "/" }) + "\n", unreadable: null };
  const m = liveModel(r, join(r, "projects"), { tickets: [rec], feed });
  assert.equal(m.groups[0].key, "ENG-1");
  assert.equal(m.groups[0].column, "in-progress");   // groupByTicket's field (activity.mjs:39)
});
```

- [ ] **Step 2: Run them and watch them fail** (the reviewer confirmed all three fail on HEAD).
- [ ] **Step 3: Implement.**
  - `boardModel`: add `tickets = null`, then `const walked = tickets ? [...tickets] : [...readStorage.listTickets(projectsDir)];`.
  - `liveModel`: add `tickets = null, feed = null`, then `const { text, unreadable } = feed ?? readStorage.activityFeed(dataRoot);` and `for (const r of buildIndex(projectsDir, tickets ? { tickets } : {}).rows) …`.
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

    The existing re-read and its comment stay below, unchanged.
  - `page.mjs`: add `tickets` to the option lists.
    - `renderView`: `boardModel(pDir, { project, flat: true, index: m.index, tickets })` at `:82`.
    - `viewEnvelope`: `boardModel(pDir, { project, focus, flat, tickets })`, and pass `tickets` to its `renderView` call.
    - `pageHtml`: `boardModel(pDir, { project, focus, flat, tickets })`, and pass `tickets` to its `renderView` call at `:339`.
- [ ] **Step 4: Run the tests.**
Run: `node --test tests/views-take-tickets.test.mjs tests/live-unreadable-on-the-seam.test.mjs tests/board*.test.mjs tests/views/*.test.mjs tests/model/seam-closure.test.mjs`
Expected: all pass.
- [ ] **Step 5: Commit.** Subject: `BLZ-670: board, panel and live views accept pre-loaded tickets and feed`.

### Task 10: Both servers read per request through the resolver and write through `resolvePorts`

**Files:**
- Modify: `scripts/serve.mjs` (`/api/hash :682`, `/api/live :687`, `/api/panel :707`, `/view/:name :724`, `/ :738`, mutating block `:805-860`)
- Modify: `scripts/supervisor.mjs` (`/api/hash :522`, `/view/:name :548`, `/ :567`; it has no `/api/panel` or `/api/live`)
- Modify: `tests/model/seam-closure.test.mjs` (the `serve.mjs`/`supervisor.mjs` entries)
- Create: `tests/serve-db-mode.test.mjs`

**Interfaces:**
- Consumes: `withReadStorage` and its `blazeResolve` tag, `resolvePorts`, `stageFor` (Task 4); the view options from Task 9; `dbBoard`, `QUIET` (`tests/helpers/db-board.mjs`).

- [ ] **Step 1: Write the failing tests.** Follow `tests/event-actor.test.mjs:140-165` for `startServer({ port: 0, … })`, the CSRF header and the `BLAZE_WRITE_PORT` set/restore; copy its server start/stop and fetch helpers exactly. Seed with `dbBoard()` plus `runDb(["init"], { ...QUIET, roots })`. Write each as its own `test()`:
  1. `POST /api/move {id:"ENG-1",to:"in-progress"}` returns 200.
  2. After it, `GET /api/panel?id=ENG-1` returns 200 and the HTML contains `in-progress`.
  3. `GET /api/live` returns 200.
  4. `GET /` returns 200 and contains `ENG-1`.
  5. `GET /api/hash` differs before and after the move.
  6. With `.blaze/blaze.db` deleted, `GET /` returns 503 and the body names `blaze db init`.
- [ ] **Step 2: Run them and watch them fail.** Test 1 fails on the id-handle commit; test 6 gets 200 or 500, not 503.
- [ ] **Step 3: Implement** in `serve.mjs`. `json` is created per request inside `handle` (`:406`), so define `reading` **inside `handle`**, right after `json`:

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
    const allTickets = async (rs) => [...(await rs.listTickets(projectsDir))];
```

  - **`/api/hash`:** `return reading(async (rs) => { const token = await rs.changeToken(projectsDir, { project: u.searchParams.get("project") || null }); res.writeHead(200, { "content-type": "text/plain" }); res.end(token); });`. The await happens **before** `writeHead`.
  - **`/api/live`:** keep the existing try/catch and 500 body. Inside the `try`: `return await reading(async (rs) => json(200, liveModel(root, projectsDir, { tickets: await allTickets(rs), feed: await rs.activityFeed(root) })));`
  - **`/api/panel`:** inside its existing try: `return await reading(async (rs) => { const html = panelHtml(projectsDir, u.searchParams.get("id"), { tickets: await allTickets(rs) }); if (html === null) return json(404, { errors: ["not found"] }); res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); });`
  - **`/view/:name`:** `return reading(async (rs) => { const envelope = viewEnvelope({ …existing…, tickets: await allTickets(rs) }); … });`
  - **`/`:** keep the nonce and the error-page catch. Inside the catch's `try`: `html = await reading(async (rs) => pageHtml({ …existing…, tickets: await allTickets(rs) }));`. If `reading` already sent a 503, `html` is the return of `json(...)`, so `return` when `res.headersSent`.
  - **Mutating block:** `done` (`:805-810`) is defined before the port is resolved (`:823`), and closes over the stage.
    - Declare `let writePort, readStorage, mode, closeWritePort;` above `done`.
    - Inside the existing try, write `({ writePort, readStorage, mode, close: closeWritePort } = await resolvePorts({ dataRoot: root, projectsDir }));`.
    - In `done` and every mutating route, `commitOrQueue(` → `stageFor(mode)(`.
    - Pass `readStorage` into every `apply*` call.
    - Keep the existing 503 catch and close-after, and make the close `await closeWritePort()`.
  - **`supervisor.mjs`:** add the same `reading` helper (inside its handler, after its own `json`) and apply the same `/api/hash`, `/view/:name` and `/` changes. Its root variable is `root`.
  - **Seam ledger:** update the `serve.mjs` and `supervisor.mjs` entries to exactly what they now take (`resolveWritePort` → `resolvePorts`; `commitOrQueue` → `stageFor`; plus `withReadStorage` if the guard classes it a write), each with a `// BLZ-670:` comment.
- [ ] **Step 4: Run the tests.**
Run: `node --test tests/serve-db-mode.test.mjs tests/serve*.test.mjs tests/supervisor*.test.mjs tests/board*.test.mjs tests/live*.test.mjs tests/event-actor.test.mjs tests/model/seam-closure.test.mjs`
Expected: all pass.
- [ ] **Step 5: Commit.** Subject: `BLZ-670: both servers read per request through the resolver and write through resolvePorts`.

### Task 11: The read-source seam guard and the Postgres twin

**Files:**
- Modify: `tests/model/seam-closure.test.mjs` (additive: one new test)
- Create: `tests/db-mode-reads-pg.test.mjs`

- [ ] **Step 1: Add the guard.** It reuses the file's `parseModule`/`astIndex`/`jsFiles`/`SCRIPTS`/`relative`, all verified present:

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
  const offenders = [], unused = [];
  const named = new Set();
  for (const file of jsFiles(SCRIPTS)) {
    const rel = relative(SCRIPTS, file).split("\\").join("/");
    const { ast } = parseModule(readFileSync(file, "utf8"));
    if (!ast) { offenders.push(`${rel} (unparseable)`); continue; }
    if (astIndex(ast).nodes.some((n) => n.type === "Identifier" && n.name === "fsReadStorage")) named.add(rel);
  }
  for (const rel of named) if (!FS_READER_ALLOWED.has(rel)) offenders.push(rel);
  for (const rel of FS_READER_ALLOWED.keys()) if (!named.has(rel)) unused.push(rel);
  assert.deepEqual(offenders, [],
    "Resolve the reader with resolveReadStorage/resolvePorts (write-port-resolve.mjs) instead.");
  assert.deepEqual(unused, [], "An allowlist entry for a module that no longer names fsReadStorage is stale — remove it.");
});
```

  Prove it discriminates, in both directions:
  - Temporarily add `import { fsReadStorage } from "./model/read-storage.mjs"; void fsReadStorage;` to `scripts/rollup-runner.mjs`. The test names it. Revert.
  - Temporarily add a bogus entry `["bogus.mjs", "x"]`. The test names it as stale. Revert.
  - Record both outputs.
- [ ] **Step 2: The Postgres twin**, in `tests/db-mode-reads-pg.test.mjs`. It is gated on `BLAZE_TEST_PG_URL` and uses the skip/CI-fail footer copied from `driver-conformance.test.mjs`.
  - Seed via `openPostgresRead(PG, { create: true })`, then `TRUNCATE ticket_event, ticket_link, acceptance_criterion, worklog_entry, project_counter, ticket CASCADE`. **Include `project_counter`**, or a rerun conflicts on its primary key.
  - Insert ENG-1 as `seedPg` does, then `INSERT INTO project_counter (project_key, n) VALUES ('ENG', 1)`. Check the column names in `scripts/model/pg-schema.mjs`.
  - Close the seeding reader.
  - Then `resolvePorts({ dataRoot, projectsDir, env: { BLAZE_WRITE_PORT: "db" }, resolveDbConfig: () => ({ driver: "postgres", connection: PG }), openPostgresClient: async (c) => { const pg = (await import("pg")).default; const cl = new pg.Client(c); await cl.connect(); return cl; } })`. `dataRoot`/`projectsDir` come from `dbBoard()`.
  - Run `applyMove` to `in-progress`, then to `in-review`, with `{ writePort, readStorage }`. Both return `ok`. Then assert `(await readStorage.getTicket(null, "ENG-1")).found.status === "in-review"`.
  - Run `applyNew` for ENG and assert the reader sees ENG-2.
  - `await close()` in `finally`.
- [ ] **Step 3: Run the full suite.**
Run: `npm test 2>&1 | tail -15`
Expected: 0 fail. Record the exact totals (tests / pass / fail / skipped). The Postgres twin is skipped locally; say so.
- [ ] **Step 4: Commit.** Subject: `BLZ-670: read-source seam guard and the Postgres db-mode twin`.

### Task 12: Docs (same PR)

**Files:**
- Create: `docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md` (0038 is free; there is no ADR index to update)
- Modify: `docs/decisions/0010-v3-storage-port-is-async-the-fs-seam-is-not.md`, `docs/decisions/0012-how-an-installation-selects-and-stores-its-database.md`
- Modify: `docs/design/csv-import-and-export.md` (the `BLAZE_WRITE_PORT` passages at about `:480` and `:1729`)
- Modify: `AGENTS.md` ("Derived caches": `blaze reindex` "rebuilds both from `projects/`" is false in db mode)

- [ ] **Step 1: ADR-0038.** Match the house format (`# 38. …`, `Date: 2026-09-29`, `## Status` Accepted (BLZ-670), `## Context`, `## Decision`, `## Consequences`). Content:
  - spec §3 and §4.1;
  - the rejected alternatives (full async cascade; sync SQLite-only; blocking shim);
  - spec §4.4a's `db`-mode staging rule and why it does not decide `commit-or-queue.mjs`'s fate;
  - the `db` refusal of `schedule --write`;
  - the named residuals: `transitions.json` from git, `sprints.json`, connection pooling.
- [ ] **Step 2: ADR-0010 addendum.** Add `## Addendum (2026-09-29, BLZ-670)`: consumers now await every seam call; the synchronous fs seam and the synchronous SQLite driver are unchanged; `await` on their values is a no-op, as the conformance suite already relied on. Link ADR-0038.
- [ ] **Step 3: ADR-0012, csv design and AGENTS.md.**
  - ADR-0012: one paragraph saying that under `BLAZE_WRITE_PORT=db` the `database.driver` driver serves reads as well as writes, via `resolvePorts`.
  - `csv-import-and-export.md`: at each `BLAZE_WRITE_PORT` passage, say that in `db` mode `import` reads the board from the database and commits only its receipt and source-id map.
  - `AGENTS.md`: in "Derived caches", add that under `BLAZE_WRITE_PORT=db` `blaze reindex` rebuilds the index from the database, while `transitions.json` still comes from git history.
  - Link ADR-0038 from each by full GitHub URL where the file already links that way (ADR-0028: shipped docs link out by URL).
- [ ] **Step 4: Check.** Run `node scripts/ci/hygiene-check.mjs origin/main` and `npm test -- tests/*doc*.test.mjs` (4 doc-pin files); both must be green.
- [ ] **Step 5: Commit.** Subject: `BLZ-670: ADR-0038, ADR-0010/0012 addenda, and db-mode read docs`.

---

## Finish

1. `git fetch origin`. `git log origin/main..BLZ-670-db-mode-reads --format=%s` must print only `BLZ-670:` subjects. If `git merge-base BLZ-670-db-mode-reads origin/main` is not `origin/main`'s own SHA, main has moved, so rebase or ask the operator before opening the PR.
2. Run the final whole-branch adversarial review: model `opus`, in a separate worktree, by an agent that wrote none of the branch. Fix confirmed findings, then re-run the full suite.
3. `git push -u origin BLZ-670-db-mode-reads`, then open the PR titled `BLZ-670: database-mode reads across every entry point`. Its body lists:
   - every sync → async signature change with its callers;
   - the Task 1 red-run evidence (both the commit-half and read-half messages);
   - the guard's two red runs;
   - the exact suite totals.
4. Before merging, `gh pr checks --watch`. Never `--admin` over a failing check. After merging, dispatch `blaze-board-operator` to `blaze log` BLZ-670's time and `blaze reconcile` from the v4-spine worktree (no push).
