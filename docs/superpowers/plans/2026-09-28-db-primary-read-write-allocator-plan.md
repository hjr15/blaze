# Database-primary read path, Postgres wiring, and id allocator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking. **Do not begin executing until this plan has
> been through `adversarial-plan-review-before-execution`** — that review has not run as
> of this plan's writing.

**Goal:** Give the `blaze` engine a database-native id allocator, config-driven Postgres
wiring for the write port, and a real injection seam for the read path — the three pieces
an adversarial review found missing from the earlier cutover plan
(`docs/superpowers/plans/2026-09-23-blaze-phase2-cutover-and-retirement-kickoff.md`).

**Architecture:** Move id allocation into each write port as an `allocate(project)`
method (fs wraps existing `claims.mjs` logic unchanged; db uses a new
`project_counter` table with one atomic upsert-and-return statement; dual delegates to
its primary, exactly as every other verb in `dualWritePort` already does). Add a
`pgExec()` adapter mirroring the existing `sqliteExec()`, and teach `resolveWritePort()`
to open a real Postgres connection when configured to, instead of always opening the
local SQLite shadow. Implement ADR-0012's already-decided-but-unbuilt config shape to
drive that choice. Map and wire the read path last, since its current state turned out
to vary by file (verified below) rather than being uniformly absent.

**Tech Stack:** Node 24 (`/home/rnamwoh/.local/node24/bin`), `node:sqlite`, `pg`
(optional peer dependency, ADR-0011), Postgres 17 in CI.

**Spec:** `docs/superpowers/specs/2026-09-28-db-primary-read-write-and-allocator-design.md`.
Executors read both this plan and that spec.

## Global Constraints

- `export PATH=/home/rnamwoh/.local/node24/bin:$PATH` in every command.
- **No `Co-Authored-By:` trailer in any commit** — `scripts/ci/hygiene-check.mjs` rejects
  it, and also rejects absolute `/home/...` paths in added non-Markdown lines.
- Every commit: `<KEY>-n: description`. Every branch: `KEY-n-slug`. Every PR title:
  `KEY-n: description`.
- **Every PR gets an adversarial review in a separate worktree**, by an agent that did not
  write the branch, scoped to product behaviour.
- Model routing, set explicitly on every dispatch: `haiku` for read-only recon, `sonnet`
  for board ops and mechanical implementation, `opus` for complex implementation and
  every adversarial review round.
- **This work has no BLZ ticket yet.** Task 0 files one via `blaze-board-operator`
  (parent `BLZ-195` or `BLZ-254` — confirm which is more accurate at dispatch time by
  reading both bodies; estimate derived from this plan's task count, roughly 1800-2400
  minutes given ten tasks of comparable size to a single mid-sized feature ticket) before
  any other task starts, per house convention (ticket at create, with parent and
  estimate, not filed after the fact).

## Review Focus

Five failure modes the spec implies but no single task's own tests are guaranteed to
exercise unless explicitly added:

1. **Two different project keys allocating concurrently must not block each other.** The
   `project_counter` table's primary key is `project_key`, so `BLZ` and `OBA` allocating
   at the same instant should never contend on the same row lock. Task 8's test covers
   two callers on the *same* key; add a second assertion (or a sibling test) with two
   *different* keys interleaved, confirming neither's returned sequence has a gap or
   a value from the other key's range.
2. **A `.blaze/database.json` with a `passwordEnv` naming an environment variable that
   isn't set.** `resolveDatabaseConfig()` must refuse with a named error before ever
   attempting a connection with `password: undefined` — a `pg.Client` connecting with an
   undefined password can hang on an auth prompt or fail with a confusing driver error
   rather than a clear `blaze:` message. Task 2's tests must cover this explicitly.
3. **`blaze.config.json` says `driver: "postgres"` but `.blaze/database.json` is
   entirely absent.** Must refuse clearly, not silently fall back to the SQLite shadow —
   a silent fallback here is exactly the kind of "the flag does nothing" defect
   `write-port-resolve.mjs`'s own header comment already names as a real, previously-
   shipped bug class (BLZ-293/BLZ-299).
4. **A ticket insert that's rejected (a `CHECK` constraint failure, e.g. an invalid
   `parent_type` pairing) after allocation succeeds, inside the same transaction.** The
   spec's own risk table (§11) requires the counter increment to roll back with the
   failed insert. Task 4's tests must include this exact sequence, not just the happy
   path.
5. **`dbWritePort`'s existing `num(id)` helper (`write-port.mjs:161-165`) parses the id's
   last hyphen-segment as the ticket number.** The new allocator constructs
   `id = `${project}-${n}`` — confirm this round-trips through `num()` correctly for a
   project key that itself could theoretically contain characters `num()`'s
   `split("-").pop()` might mis-parse (project keys are letters+digits only per
   `AGENTS.md`, so this should be safe, but Task 4 must include a test proving it rather
   than asserting it from the schema rule alone — a rule enforced elsewhere is not a
   guarantee the code path in question honors it).

---

## Task 0: File the tracking ticket

**Files:** none (board operation only, in `blaze-pm-worktrees/v4-spine`).

- [ ] Dispatch `blaze-board-operator` (model: `sonnet`) with a complete brief: read
      `BLZ-195` and `BLZ-254`'s bodies in `blaze-pm-worktrees/v4-spine/projects/BLZ/`,
      pick the more accurate parent, and run
      `blaze new --project BLZ --type feature "Database-primary read path, Postgres wiring, and id allocator" --estimate <N> --parent <chosen>`
      where `<N>` is derived from this plan's ten tasks (state the derivation in the
      dispatch: this plan is comparable in shape to BLZ-253's storage-adapter phase but
      narrower in scope — recommend starting from roughly 2000 minutes and letting the
      operator adjust after reading both parent tickets' own estimate conventions).
- [ ] Record the new ticket id here before Task 1 starts, and use it in every subsequent
      commit/branch/PR (`<new-id>-pg-exec-adapter`, etc.) in place of a placeholder.

## Task 1: `pgExec()` write-side adapter

**Files:**
- Modify: `scripts/model/write-port-resolve.mjs` (add beside `sqliteExec`, currently at
  lines 32-38).
- Test: `tests/model/write-port-resolve.test.mjs` (confirm this file exists and read its
  existing style before adding — if it doesn't exist, create it following
  `tests/model/write-port.test.mjs`'s conventions).

**Interfaces:**
- Produces: `pgExec(client)` → `{ run(sql, params) => Promise<void>, all(sql, params) => Promise<Array<object>> }`,
  matching `sqliteExec(db)`'s shape exactly (same two method names, same call shape) so
  `dbWritePort(exec, { dialect })` needs no changes to consume either.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pgExec } from "../../scripts/model/write-port-resolve.mjs";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH=/home/rnamwoh/.local/node24/bin:$PATH && node --test tests/model/write-port-resolve.test.mjs`
Expected: FAIL with `pgExec is not exported` or `is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
/** An async {run, all} over a connected pg.Client, the shape dbWritePort expects. */
export function pgExec(client) {
  return {
    async run(sql, params = []) { await client.query(sql, params); },
    async all(sql, params = []) { return (await client.query(sql, params)).rows; },
  };
}
```

Add this immediately after `sqliteExec` (after line 38) in
`scripts/model/write-port-resolve.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2. Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/model/write-port-resolve.mjs tests/model/write-port-resolve.test.mjs
git commit -m "<TICKET>: add pgExec, the async write-side Postgres adapter"
```

## Task 2: Config plumbing — `resolveDatabaseConfig()`

**Files:**
- Modify: `scripts/config.mjs` (add near `loadConfig`, currently defined at line 173).
- Create: `scripts/model/database-config.mjs` — a separate file, since this is model
  logic distinct from `config.mjs`'s existing `blaze.config.json`-only concern (which
  reads one tracked file; this reads a tracked file, an untracked file, and env vars
  together) and keeps `config.mjs` from growing an unrelated responsibility.
- Test: `tests/model/database-config.test.mjs`.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resolveDatabaseConfig({ dataRoot, config, env = process.env })` →
  `{ driver: "sqlite" | "postgres", connection: null | { host, port, database, user, password } }`.
  Task 3 and Task 9 both call this — its shape is load-bearing for both.

- [ ] **Step 1: Write the failing tests** (five cases, covering Review Focus items 2-3)

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDatabaseConfig } from "../../scripts/model/database-config.mjs";

function withDatabaseJson(dataRoot, obj) {
  writeFileSync(join(dataRoot, ".blaze", "database.json"), JSON.stringify(obj));
  chmodSync(join(dataRoot, ".blaze", "database.json"), 0o600);
}

test("defaults to sqlite with no config anywhere", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "blaze-dbcfg-"));
  const result = resolveDatabaseConfig({ dataRoot, config: {}, env: {} });
  assert.deepEqual(result, { driver: "sqlite", connection: null });
  rmSync(dataRoot, { recursive: true, force: true });
});

test("postgres driver with a complete .blaze/database.json resolves a connection", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "blaze-dbcfg-"));
  require("node:fs").mkdirSync(join(dataRoot, ".blaze"));
  withDatabaseJson(dataRoot, { host: "db.example", port: 5432, database: "blaze",
                               user: "blaze", passwordEnv: "BLZ_DB_PW" });
  const result = resolveDatabaseConfig({
    dataRoot, config: { database: { driver: "postgres" } },
    env: { BLZ_DB_PW: "secret" } });
  assert.equal(result.driver, "postgres");
  assert.deepEqual(result.connection,
    { host: "db.example", port: 5432, database: "blaze", user: "blaze", password: "secret" });
  rmSync(dataRoot, { recursive: true, force: true });
});

test("postgres driver with passwordEnv pointing at an unset var refuses", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "blaze-dbcfg-"));
  require("node:fs").mkdirSync(join(dataRoot, ".blaze"));
  withDatabaseJson(dataRoot, { host: "db.example", port: 5432, database: "blaze",
                               user: "blaze", passwordEnv: "BLZ_DB_PW_UNSET" });
  assert.throws(
    () => resolveDatabaseConfig({ dataRoot, config: { database: { driver: "postgres" } }, env: {} }),
    /blaze:.*BLZ_DB_PW_UNSET/);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("postgres driver with no .blaze/database.json at all refuses, not silently falls back", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "blaze-dbcfg-"));
  assert.throws(
    () => resolveDatabaseConfig({ dataRoot, config: { database: { driver: "postgres" } }, env: {} }),
    /blaze:.*\.blaze\/database\.json/);
  rmSync(dataRoot, { recursive: true, force: true });
});

test("blaze.config.json carrying database.url is refused at load, per ADR-0012 §2", () => {
  assert.throws(
    () => resolveDatabaseConfig({ dataRoot: "/nonexistent",
                                   config: { database: { driver: "postgres", url: "postgres://x" } },
                                   env: {} }),
    /blaze:.*database\.url/);
});
```

(Replace the two `require("node:fs")` calls with a proper `import { mkdirSync } from
"node:fs"` at the top — written inline above only to keep this step's diff visible
against the earlier import list; the real file must not mix `require` and `import`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/model/database-config.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/model/database-config.mjs — ADR-0012's config shape: the driver name is
// repo config, the connection is not.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRegularFileSync } from "./regular-file.mjs";

export function resolveDatabaseConfig({ dataRoot, config = {}, env = process.env }) {
  const dbConfig = config.database ?? {};
  if ("url" in dbConfig || "password" in dbConfig) {
    throw new Error(
      "blaze: blaze.config.json's database block may not carry 'url' or 'password' — "
      + "connection details belong in .blaze/database.json, never in tracked config.");
  }
  const driver = dbConfig.driver ?? "sqlite";
  if (driver !== "sqlite" && driver !== "postgres") {
    throw new Error(`blaze: database.driver=${JSON.stringify(driver)} is not supported — expected 'sqlite' or 'postgres'.`);
  }
  if (driver === "sqlite") return { driver, connection: null };

  const path = join(dataRoot, ".blaze", "database.json");
  if (!existsSync(path)) {
    throw new Error(
      `blaze: database.driver is 'postgres' but ${path} does not exist. `
      + "Create it with { host, port, database, user, passwordEnv } — see ADR-0012.");
  }
  const raw = JSON.parse(readRegularFileSync(path, "utf8"));
  const { host, port, database, user, passwordEnv } = raw;
  if (!host || !port || !database || !user || !passwordEnv) {
    throw new Error(`blaze: ${path} is missing a required field (host, port, database, user, passwordEnv).`);
  }
  const password = env[passwordEnv];
  if (password === undefined) {
    throw new Error(
      `blaze: ${path}'s passwordEnv names '${passwordEnv}', but that environment `
      + "variable is not set. Set it before connecting — the password is never stored.");
  }
  return { driver, connection: { host, port, database, user, password } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2. Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/model/database-config.mjs tests/model/database-config.test.mjs
git commit -m "<TICKET>: implement ADR-0012's database config resolution"
```

## Task 3: A production Postgres client, and wiring `resolveWritePort()` to it

**Resolved during this plan's own writing, not left as a guess:** `scripts/init-pg.mjs`'s
existing `openPostgres()` (read in full) is the wizard's *connection-test* wrapper — it
returns `{ serverVersionNum, encoding, probeCreate, close }`, deliberately not a raw
query method, since its whole job is testing a connection before `blaze db init`, not
serving ongoing writes. Reusing it here would be a purpose mismatch. This task adds a
second, small function beside it for the production path.

**Files:**
- Modify: `scripts/init-pg.mjs` — add `openPostgresClient` beside the existing
  `openPostgres` (lines 1-46), sharing its optional-dependency error handling.
- Modify: `scripts/model/write-port-resolve.mjs:152-190` (`resolveWritePort`).
- Test: `tests/init-pg.test.mjs` (or wherever `openPostgres` is already tested — confirm
  via `grep -rl "openPostgres" tests/` — add the new function's tests beside it) and
  whichever file already covers `resolveWritePort` (`grep -rl "resolveWritePort" tests/`).

**Interfaces:**
- Produces: `openPostgresClient({ host, port, database, user, password })` →
  `Promise<pg.Client>` (connected, raw — no wrapper), for `pgExec` (Task 1) to consume.
- Consumes (in `resolveWritePort`): `pgExec` (Task 1), `resolveDatabaseConfig` (Task 2),
  `openPostgresClient` (this task).
- Produces (in `resolveWritePort`): no new exports — its existing return shape
  (`{ port, mode, close }`) is unchanged; only its internal db-vs-sqlite choice changes.

- [ ] **Step 1: Write the failing test for `openPostgresClient`**

```js
test("openPostgresClient returns a connected, raw client with .query", async (t) => {
  // Mirror however tests/init-pg.test.mjs's existing tests fake the 'pg' module import
  // for openPostgres — reuse that exact mocking approach, don't invent a second one.
  const client = await openPostgresClient({ host: "h", port: 5432, database: "d", user: "u", password: "p" });
  assert.equal(typeof client.query, "function");
  await client.end();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/init-pg.test.mjs` (path confirmed by the earlier grep).
Expected: FAIL, `openPostgresClient is not exported`.

- [ ] **Step 3: Implement, beside `openPostgres` in `scripts/init-pg.mjs`**

```js
/** The production write-port's connection: the raw, connected client, no test wrapper.
 *  Separate from openPostgres() above, which is testConnection-shaped for the wizard —
 *  reusing that wrapper here would give write-port callers no .query to call. */
export async function openPostgresClient({ host, port, database, user, password }) {
  let pg;
  try {
    pg = (await import("pg")).default;
  } catch (cause) {
    if (cause?.code !== "ERR_MODULE_NOT_FOUND") throw cause;
    throw new Error(
      "The Postgres driver needs the 'pg' package, which Blaze does not install by "
      + "default. Install it alongside Blaze to use a Postgres board:\n\n"
      + "    npm install pg\n\n"
      + "No other driver requires it — sqlite works without.", { cause });
  }
  const client = new pg.Client({ host, port, database, user, password });
  await client.connect();
  return client;
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Write the failing test for `resolveWritePort`**

```js
test("resolveWritePort opens Postgres when configured, not the SQLite shadow", async () => {
  const calls = [];
  const fakeOpenPostgresClient = async (conn) => { calls.push(conn); return { query: async () => ({ rows: [] }), end: async () => {} }; };
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
```

- [ ] **Step 6: Run test to verify it fails**

Expected: FAIL — `resolveWritePort` doesn't accept `resolveDbConfig`/`openPostgresClient`
yet and would try to open the real local SQLite shadow, which doesn't exist at that path.

- [ ] **Step 7: Modify `resolveWritePort`**

```js
export async function resolveWritePort({ dataRoot, projectsDir, storage = fsStorage,
                                         env = process.env, onDivergence,
                                         resolveDbConfig = resolveDatabaseConfig,
                                         openPostgresClient: openPgClient = openPostgresClient } = {}) {
  const mode = (env[WRITE_PORT_ENV] ?? "fs").trim();
  if (mode === "fs") {
    return { port: fsWritePort(projectsDir, storage), mode, close() {} };
  }
  if (mode !== "dual" && mode !== "db") {
    throw new Error(
      `blaze: ${WRITE_PORT_ENV}=${JSON.stringify(mode)} is not a write port — `
      + "expected 'fs', 'dual' or 'db'. Leaving it unset uses 'fs', which is the "
      + "filesystem behaviour Blaze has always had.");
  }

  const { loadConfig } = await import("../config.mjs");
  const dbConfig = resolveDbConfig({ dataRoot, config: loadConfig({ root: dataRoot }) });
  let db, close;
  if (dbConfig.driver === "postgres") {
    const client = await openPgClient(dbConfig.connection);
    db = dbWritePort(pgExec(client), { dialect: "postgres" });
    close = async () => { try { await client.end(); } catch { /* already closed */ } };
  } else {
    const shadow = await openShadow(dataRoot);
    db = dbWritePort(shadow.exec, { dialect: "sqlite" });
    close = () => { try { shadow.db.close(); } catch { /* already closed */ } };
  }

  if (mode === "db") return { port: db, mode, close };

  const report = onDivergence ?? ((d) => logDivergence(dataRoot, d));
  const port = dualWritePort(fsWritePort(projectsDir, storage), db, { onDivergence: report });
  const counted = {
    ...port,
    write(t, ctx) { recordSoakOp(dataRoot); return port.write(t, ctx); },
    move(t, ctx) { recordSoakOp(dataRoot); return port.move(t, ctx); },
  };
  return { port: counted, mode, close };
}
```

Add the corresponding imports at the top of `write-port-resolve.mjs`:
`resolveDatabaseConfig` from `./database-config.mjs`, `openPostgresClient` from
`../init-pg.mjs`, `pgExec` (already local to this file from Task 1).

- [ ] **Step 8: Run tests to verify they pass**

Expected: PASS.

- [ ] **Step 9: Run the full existing `resolveWritePort` test suite to confirm no
      regression on the `fs`/`dual`/sqlite-`db` paths**

Run: `node --test tests/model/write-port-resolve.test.mjs` (or whatever file the earlier
grep located) plus any test importing `resolveWritePort` elsewhere.
Expected: PASS, no regressions.

- [ ] **Step 10: Commit**

```bash
git add scripts/init-pg.mjs scripts/model/write-port-resolve.mjs tests/init-pg.test.mjs tests/model/write-port-resolve.test.mjs
git commit -m "<TICKET>: openPostgresClient, and resolveWritePort opens real Postgres when configured"
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Run the full existing `resolveWritePort` test suite to confirm no
      regression on the `fs`/`dual`/sqlite-`db` paths**

Run: `node --test tests/model/write-port-resolve.test.mjs` (or whatever file Step 1
located) plus any test importing `resolveWritePort` elsewhere
(`grep -rl "resolveWritePort" tests/`).
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add scripts/model/write-port-resolve.mjs tests/model/<located-file>
git commit -m "<TICKET>: resolveWritePort opens real Postgres when configured"
```

## Task 4: `project_counter` table and `dbWritePort.allocate()`

**Files:**
- Modify: `scripts/model/pg-schema.mjs` and `scripts/model/sqlite-schema.mjs` (add the
  `project_counter` DDL — locate the exact `CREATE TABLE` block pattern each file uses,
  e.g. `pg-schema.mjs`'s `ticket` table at line 21, and add a new table following the
  same style).
- Modify: `scripts/model/write-port.mjs` (add `allocate` to `dbWritePort`'s returned
  object, after line 154's function opens — the return object itself starts at the line
  containing `return { name: "db", ...}`, confirmed above to include `exists`/`write`/
  `move`/`read`).
- Test: `tests/model/write-port.test.mjs` (or wherever `dbWritePort` is already tested —
  confirm via `grep -rl "dbWritePort" tests/`).

**Interfaces:**
- Consumes: the `ph(i)` placeholder helper and `pg` dialect boolean already defined
  inside `dbWritePort`'s closure (write-port.mjs, confirmed present at lines 158-159).
- Produces: `allocate(project)` → `Promise<{ id: string, n: number }>`, the same shape
  `allocateId()` (`scripts/model/ids.mjs:66`) already returns, so Task 5's `fsWritePort`
  counterpart and Task 6's `dualWritePort` counterpart don't need a shape adapter.

- [ ] **Step 1: Add the DDL** to both schema files, matching each file's existing style
      (verified from `pg-schema.mjs`'s `ticket` table): for Postgres,

```sql
CREATE TABLE IF NOT EXISTS project_counter (
  project_key text PRIMARY KEY,
  n           integer NOT NULL DEFAULT 0 CHECK (n >= 0)
);
```

and the SQLite-dialect equivalent (`INTEGER` for `n`, ` STRICT` table suffix, matching
`sqlite-schema.mjs`'s established pattern for every other table in that file — read one
of its existing tables immediately before writing this one, to match its exact dialect
helper usage).

- [ ] **Step 2: Write the failing tests** (covering Review Focus items 1, 4, 5)

```js
test("dbWritePort.allocate returns sequential numbers for one project", async () => {
  const exec = testExecFor("sqlite"); // however this test file's existing helper opens an in-memory db with schema applied — reuse it, don't invent a new one
  const port = dbWritePort(exec, { dialect: "sqlite" });
  const a = await port.allocate("BLZ");
  const b = await port.allocate("BLZ");
  assert.deepEqual([a.n, b.n], [1, 2]);
  assert.deepEqual([a.id, b.id], ["BLZ-1", "BLZ-2"]);
});

test("dbWritePort.allocate keeps separate projects independent", async () => {
  const exec = testExecFor("sqlite");
  const port = dbWritePort(exec, { dialect: "sqlite" });
  const a = await port.allocate("BLZ");
  const b = await port.allocate("OBA");
  assert.equal(a.n, 1);
  assert.equal(b.n, 1); // OBA's own counter, not BLZ's
});

test("a rejected ticket insert rolls back its allocation", async () => {
  const exec = testExecFor("sqlite");
  const port = dbWritePort(exec, { dialect: "sqlite" });
  const { id, n } = await port.allocate("BLZ");
  // Force the subsequent insert to violate a real constraint — e.g. an invalid
  // parent_type pairing, matching Review Focus item 4. Exact construction depends on
  // this test file's existing fixture-ticket helper; use it rather than hand-building
  // frontmatter here.
  await assert.rejects(() => port.write(invalidTicketFixture({ id, parent: "NONEXISTENT-1" })));
  const { n: nextN } = await port.allocate("BLZ");
  assert.equal(nextN, n); // the failed attempt's number is available again — NOT n+2
});

test("allocated id round-trips through dbWritePort's own num() parsing", async () => {
  const exec = testExecFor("sqlite");
  const port = dbWritePort(exec, { dialect: "sqlite" });
  const { id } = await port.allocate("BLZ");
  await port.write(minimalTicketFixture({ id })); // must not throw "cannot derive num from id"
});
```

(`testExecFor`, `invalidTicketFixture`, `minimalTicketFixture` are placeholders for
whatever this test file's real existing helpers are named — locate them via
`grep -n "^function\|^const.*=.*=>" tests/model/write-port.test.mjs` before writing the
final version of these tests; do not invent new fixture helpers duplicating existing
ones.)

- [ ] **Step 3: Run tests to verify they fail**

Expected: FAIL, `allocate is not a function`.

- [ ] **Step 4: Implement `allocate` inside `dbWritePort`**, added to the closure
      alongside `persist`/`recordEvent` and exposed on the returned object:

```js
async function allocate(project) {
  const rows = await exec.all(
    `INSERT INTO project_counter (project_key, n) VALUES (${ph(0)}, 1)
     ON CONFLICT (project_key) DO UPDATE SET n = project_counter.n + 1
     RETURNING n`,
    [project]);
  const n = rows[0].n;
  return { id: `${project}-${n}`, n };
}
```

Add `allocate,` to the returned object (alongside `name: "db"`, `exists`, `write`,
`move`, `read`).

**On the rollback test (Step 2's third test):** confirm whether `dbWritePort.write()`
already wraps its multi-statement `persist()` in a transaction — read `persist()`'s body
(write-port.mjs, confirmed spanning roughly lines 204-291) for a `BEGIN`/`COMMIT` or
equivalent. If it does not, this task must also wrap `allocate` + the immediately
following `write` call at whichever call site chains them (Task 5's `new.mjs` change) in
one transaction — note this explicitly as a finding if `persist()` turns out not to be
transactional today, since it would mean the rollback property Review Focus item 4
requires does not yet exist for ordinary ticket writes either, which is a defect to
report, not silently work around inside this task alone.

- [ ] **Step 5: Run tests to verify they pass**

Expected: PASS, all four tests (or investigate/report per Step 4's transaction note if
the rollback test can't pass without a wider transactional fix).

- [ ] **Step 6: Commit**

```bash
git add scripts/model/pg-schema.mjs scripts/model/sqlite-schema.mjs scripts/model/write-port.mjs tests/model/write-port.test.mjs
git commit -m "<TICKET>: add project_counter and dbWritePort.allocate()"
```

## Task 5: `fsWritePort.allocate()` and `new.mjs`'s one call-site change

**Files:**
- Modify: `scripts/model/write-port.mjs:77-115` (`fsWritePort`).
- Modify: `scripts/new.mjs:1-16` (imports) and the allocation sequence at lines 105-118
  (verified above: `remoteMaxClaim` → `allocateId` → `writeClaim`, in that order,
  currently split across three direct calls).
- Test: `tests/model/write-port.test.mjs` (fs port section) and `tests/new.test.mjs` (or
  wherever `applyNew`'s own tests live — confirm via
  `grep -rl "applyNew" tests/`).

**Interfaces:**
- Consumes: `allocateId`, `remoteMaxClaim`, `writeClaim` (unchanged, from
  `scripts/model/ids.mjs` and `scripts/model/claims.mjs` — this task moves their call
  site, not their implementation).
- Produces: `fsWritePort(...).allocate(project)` → `Promise<{ id, n, claimFile }>` — note
  the extra `claimFile` field versus `dbWritePort`'s `{ id, n }`: `new-runner.mjs:118`'s
  `commitOrQueue({ files: [r.file, r.claimFile] })` needs the claim file's path for git
  staging, so it must keep surfacing through `applyNew`'s return value. `dbWritePort`'s
  `allocate` has no equivalent field; callers that destructure `{ id, n }` and ignore
  extra properties are unaffected either way.

- [ ] **Step 1: Write the failing test**

```js
test("fsWritePort.allocate returns id, n, and a claim file path", async () => {
  const { projectsDir, storage } = testFsFixture(); // reuse this file's existing fs-fixture helper
  const port = fsWritePort(projectsDir, storage);
  const { id, n, claimFile } = await port.allocate("BLZ");
  assert.match(id, /^BLZ-\d+$/);
  assert.equal(typeof n, "number");
  assert.ok(claimFile);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL, `allocate is not a function`.

- [ ] **Step 3: Implement**, moving (not rewriting) the existing sequence into
      `fsWritePort`:

```js
export function fsWritePort(projectsDir, storage = fsStorage, readStorage = fsReadStorage) {
  return {
    name: "fs",
    async allocate(project) {
      const dataRoot = dirname(projectsDir);
      const remoteMax = remoteMaxClaim(dataRoot, project);
      const { id, n } = allocateId(projectsDir, project, { dataRoot, remoteMax: remoteMax ?? 0 });
      return { id, n, remoteMax, provisional: remoteMax === null };
      // claimFile is written by write()/move() below once the ticket's slug is known —
      // see the note under Step 3 continued.
    },
    write({ project, status, frontmatter, body, currentFile }) { /* ...unchanged... */ },
    // ...
  };
}
```

**This needs one more decision the plan's own research didn't fully resolve: `writeClaim`
requires the ticket's `slugify(title)`, which `allocate(project)` doesn't have (it's
called before the ticket's frontmatter is fully built in `new.mjs`'s current sequence —
confirmed at line 105, `allocateId` runs before `frontmatter.id = id` is even set).**
Two options, to be decided during implementation by re-reading `new.mjs`'s full sequence
side-by-side with this task:
(a) keep `allocate(project)` returning only `{ id, n }` and have `new.mjs` still call
`writeClaim` itself after `allocate` returns — a smaller, safer change that doesn't fully
achieve "id allocation moves entirely inside the port" but avoids guessing an interface
this plan's research didn't fully nail down; or
(b) change `allocate`'s signature to `allocate(project, { title })` so it has what it
needs to call `writeClaim` internally, matching the spec's original intent more closely.
**Recommend (a) for this task, since it is provably correct against the interfaces this
plan actually verified, and note (b) as a follow-up refinement** — a plan that guesses an
interface it didn't verify is exactly the failure mode the last review caught three times;
this plan should not repeat it a fourth, even under schedule pressure to look "complete."

Given (a): `new.mjs`'s new sequence becomes:

```js
const { id, n } = await writePort.allocate(project);
frontmatter.id = id;
// ... existing target/exists/write logic, unchanged ...
const claimFile = writeClaim(projectsDir, project, n, slugify(title), { provisional: remoteMax === null });
```

removing the direct `allocateId`/`remoteMaxClaim` calls and their imports from
`new.mjs`, keeping `writeClaim`'s import and call site as today. `dbWritePort.allocate`
(Task 4) already returns `{ id, n }`, so this call site works identically for both ports
— `writeClaim` is simply never meaningful in db mode, so `new.mjs` must branch: only call
`writeClaim` when `writePort.name === "fs"`. Confirm `dualWritePort`'s exposed `name`
(`\`dual(${primary.name}->${shadow.name})\``, confirmed in `write-port.mjs:401`) doesn't
break a naive `=== "fs"` check — dual mode still wants the claim file written (the
primary is fs), so the check should be `writePort.name === "fs" || writePort.name.startsWith("dual(fs->")`
or, cleaner, expose a boolean like `writePort.needsClaimFile` from each port factory
instead of pattern-matching `name` — **decide and implement whichever is cleaner during
this task**, since this plan's research surfaced the problem precisely but ran out of
scope to fully resolve which of the two is better without seeing more of `new.mjs`'s
surrounding code than was read.

- [ ] **Step 4: Run tests to verify they pass**, including re-running `new.mjs`'s full
      existing test suite to confirm the refactor didn't change `blaze new`'s behavior
      for the fs (default) path — this is the highest-risk regression in this whole plan,
      since it touches the ticket-creation path directly.

Run: `node --test tests/new.test.mjs tests/model/write-port.test.mjs`
Expected: PASS, zero regressions in `blaze new`'s existing test count.

- [ ] **Step 5: Commit**

```bash
git add scripts/model/write-port.mjs scripts/new.mjs tests/new.test.mjs tests/model/write-port.test.mjs
git commit -m "<TICKET>: move id allocation into fsWritePort, new.mjs calls writePort.allocate"
```

## Task 6: `dualWritePort.allocate()`

**Files:**
- Modify: `scripts/model/write-port.mjs:386-425` (`dualWritePort`).
- Test: same file as Task 4/5's dual-port tests — locate via
  `grep -n "dualWritePort" tests/model/write-port.test.mjs`.

**Interfaces:**
- Consumes: Task 4's `dbWritePort.allocate`, Task 5's `fsWritePort.allocate`.
- Produces: `dualWritePort(primary, shadow, opts).allocate(project)` → delegates to
  `primary.allocate(project)` only, per the function's own stated principle ("the primary
  decides every outcome").

- [ ] **Step 1: Write the failing test**

```js
test("dualWritePort.allocate delegates to the primary only", async () => {
  let shadowCalled = false;
  const primary = { name: "fs", allocate: async (p) => ({ id: `${p}-1`, n: 1 }) };
  const shadow = { name: "db", allocate: async () => { shadowCalled = true; return { id: "X-99", n: 99 }; } };
  const port = dualWritePort(primary, shadow);
  const result = await port.allocate("BLZ");
  assert.deepEqual(result, { id: "BLZ-1", n: 1 });
  assert.equal(shadowCalled, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL, `allocate is not a function`.

- [ ] **Step 3: Implement** — add one line to the returned object (alongside `exists`,
      `write`, `move`, `read`, `close`, per the pattern already there):

```js
allocate(project) { return primary.allocate(project); },
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/model/write-port.mjs tests/model/write-port.test.mjs
git commit -m "<TICKET>: dualWritePort.allocate delegates to primary"
```

## Task 7: Extend driver-conformance suite

**Files:**
- Modify: `tests/model/driver-conformance.test.mjs`.

**Interfaces:**
- Consumes: `dbWritePort(exec, { dialect }).allocate` from both dialects (Task 4).

- [ ] **Step 1: Read the existing conformance suite's structure** (`grep -n "^test\|describe" tests/model/driver-conformance.test.mjs`)
      to match its existing pattern for running one assertion body against both a SQLite
      and a Postgres `exec`, before writing new assertions — this file's whole point is
      one shared assertion list run against two drivers; a new assertion added outside
      that shared list defeats the suite's purpose.
- [ ] **Step 2: Add an assertion** (in the shared list, run against both dialects):
      allocate 5 times for one project, assert the returned `n` values are exactly
      `[1,2,3,4,5]` in order, and the returned `id` values match `project-n`.
- [ ] **Step 3: Run against SQLite** (no `BLAZE_TEST_PG_URL` set):
      `node --test tests/model/driver-conformance.test.mjs`. Expected: PASS.
- [ ] **Step 4: Run against real Postgres**:
      ```
      docker run --rm -d -e POSTGRES_PASSWORD=x -p 55481:5432 --name blzpg-55481 postgres:17-alpine
      for i in $(seq 1 60); do docker exec blzpg-55481 pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
      export BLAZE_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55481/postgres
      node --test tests/model/driver-conformance.test.mjs
      ```
      Expected: PASS against both drivers, same assertions.
- [ ] **Step 5: Commit**

```bash
git add tests/model/driver-conformance.test.mjs
git commit -m "<TICKET>: extend driver conformance to allocate()"
```

## Task 8: Concurrent-allocation property test against real Postgres

**Files:**
- Create: `tests/model/allocate-concurrency.test.mjs`.

**Interfaces:**
- Consumes: `dbWritePort` (Task 4), a real Postgres connection (`BLAZE_TEST_PG_URL`).

- [ ] **Step 1: Write the test** (covers this plan's Review Focus item 1 for both the
      same-key and cross-key cases in one file):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { dbWritePort } from "../../scripts/model/write-port.mjs";
import { pgExec } from "../../scripts/model/write-port-resolve.mjs";
// import whatever schema-creation helper the existing pg conformance tests use — locate
// via grep, do not hand-write DDL setup here duplicating an existing fixture.

test("50x2 concurrent allocations on one project: exactly {1..100}, no dup, no gap", { skip: !process.env.BLAZE_TEST_PG_URL }, async () => {
  const client = new pg.Client(process.env.BLAZE_TEST_PG_URL);
  await client.connect();
  // ... apply schema via the located helper ...
  const port = dbWritePort(pgExec(client), { dialect: "postgres" });
  const [a, b] = await Promise.all([
    Promise.all(Array.from({ length: 50 }, () => port.allocate("BLZ"))),
    Promise.all(Array.from({ length: 50 }, () => port.allocate("BLZ"))),
  ]);
  const all = [...a, ...b].map((r) => r.n).sort((x, y) => x - y);
  assert.deepEqual(all, Array.from({ length: 100 }, (_, i) => i + 1));
  await client.end();
});

test("concurrent allocations on two DIFFERENT projects never collide or block each other's sequence", { skip: !process.env.BLAZE_TEST_PG_URL }, async () => {
  const client = new pg.Client(process.env.BLAZE_TEST_PG_URL);
  await client.connect();
  const port = dbWritePort(pgExec(client), { dialect: "postgres" });
  const [blz, oba] = await Promise.all([
    Promise.all(Array.from({ length: 20 }, () => port.allocate("BLZ2"))), // distinct keys from the prior test
    Promise.all(Array.from({ length: 20 }, () => port.allocate("OBA2"))),
  ]);
  assert.deepEqual(blz.map((r) => r.n).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(oba.map((r) => r.n).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
  await client.end();
});
```

- [ ] **Step 2: Run without Postgres** — confirm both tests report `skipped`, not
      silently absent (per this repo's own "assert the observation happened" rule —
      a skip must be visible in the test output, not indistinguishable from the test
      never having existed).

Run: `node --test tests/model/allocate-concurrency.test.mjs`
Expected: 2 skipped, 0 failed.

- [ ] **Step 3: Run WITH Postgres up** (same docker setup as Task 7 Step 4):

Run: `BLAZE_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55481/postgres node --test tests/model/allocate-concurrency.test.mjs`
Expected: PASS, 2 tests, 0 skipped.

- [ ] **Step 4: Commit**

```bash
git add tests/model/allocate-concurrency.test.mjs
git commit -m "<TICKET>: prove the concurrent-allocation property against real Postgres"
```

## Task 9: Map and wire the read-side injection seam

**This task starts with mapping, not implementing — the three files this plan's spec
named turned out to be in three different states, verified during this plan's own
research:**

- `scripts/audit-runner.mjs` — hardcoded `import { fsReadStorage } from "./model/read-storage.mjs"`,
  three direct call sites (confirmed lines 120, 181, and one more — re-verify exact line
  numbers at implementation time, five more days will have passed), **no injection point
  at all**.
- `scripts/views/data.mjs` — **already has** an injectable `readStorage = fsReadStorage`
  parameter on at least three exported functions (confirmed at lines 24, 114, 142). This
  file needs its call sites wired to the configured reader, not a new seam added.
- `scripts/model/index.mjs`'s `buildIndex(projectsDir, { tickets, sprints })` — **already
  accepts a pre-built `tickets` array**, bypassing the filesystem entirely when supplied.
  This is a different shape of seam than a `readStorage` parameter: the caller of
  `buildIndex` (not `buildIndex` itself) needs to decide whether to call `walkTickets`
  (fs) or a new database-backed ticket-loading function and pass the result in.

**Files:**
- Modify: `scripts/audit-runner.mjs` (add an injectable parameter — this file's own
  existing call structure needs reading in full first, since it's a top-level script,
  not obviously a function taking options today; confirm its actual entry-point shape
  before assuming a parameter can simply be added).
- Modify: whichever module constructs and calls `views/data.mjs`'s functions and
  `buildIndex` today for the live-serving path (`scripts/serve.mjs` and/or
  `scripts/reindex.mjs` — **locate the exact call sites first**:
  `grep -n "buildIndex\|from \"./views/data.mjs\"\|from \"../views/data.mjs\"" scripts/serve.mjs scripts/reindex.mjs scripts/cli.mjs`).
- Test: whichever existing test files cover `serve.mjs`'s and `reindex.mjs`'s current
  behavior — locate before modifying.

- [ ] **Step 1: Run the locate command above and read every result in full.** Do not
      proceed to Step 2 until you can answer, with a specific file:line citation for
      each: where does `serve.mjs` get the value it passes as `views/data.mjs`'s
      `readStorage` argument today (if it passes one explicitly at all, vs. relying on
      the default), and where does whatever builds the live index call `buildIndex`
      with or without a `tickets` array?
- [ ] **Step 2: For `views/data.mjs`'s three-plus call sites**, thread
      `resolveDatabaseConfig()` (Task 2) through to decide `readStorage`: when
      `driver === "postgres"`, pass `openPostgresRead(connection)` (confirmed to exist,
      `scripts/model/pg-storage.mjs:108`); otherwise the existing default. Write a
      failing test first asserting `serve.mjs`'s (or wherever the wiring lands) behavior
      changes correctly under a mocked `postgres` config, following whatever DI pattern
      that file already uses for its own tests.
- [ ] **Step 3: For `buildIndex`'s caller(s)**, add a function that loads tickets from
      the database (via `openPostgresRead`/an equivalent SQLite reader — **locate whether
      one already exists as a counterpart to `openPostgresRead`, likely named something
      like `openSqliteRead`, before writing a new one**: `grep -rn "openSqliteRead"
      scripts/model/*.mjs`), and call it instead of `walkTickets` when the resolved
      driver is a database. Write a failing test first, at whatever call site Step 1
      located, asserting the ticket set fed to `buildIndex` comes from the injected
      reader when configured, and from `walkTickets` otherwise.
- [ ] **Step 4: For `audit-runner.mjs`**, based on what Step 1's reading of its actual
      structure revealed: add whatever injection point its real shape supports (a
      function parameter if it's already function-shaped; a module-level override
      accepted at its entry point if it's a top-level script — decide based on the real
      file, not assumed here). Write a failing test first.
- [ ] **Step 5: Run each new test, confirm fail-then-pass, per the standard TDD cycle**,
      for each of Steps 2-4's changes individually rather than batched, so a failure in
      one doesn't mask a false pass in another.
- [ ] **Step 6: Run the full suite** to confirm no regression in `blaze serve`,
      `blaze audit`, or `blaze reindex`'s filesystem-mode behavior — this is the
      highest-risk task in this plan for silent regressions, since it touches three
      read paths simultaneously.

```
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
npm test 2>&1 | tail -9
npm run test:coverage
node scripts/ci/hygiene-check.mjs origin/main
```

- [ ] **Step 7: Commit** (likely as more than one commit, given the task's own
      three-sub-file scope — split by file if a reviewer could meaningfully approve one
      part while rejecting another, per this plan's own task-sizing rule):

```bash
git add scripts/views/data.mjs scripts/serve.mjs scripts/reindex.mjs scripts/audit-runner.mjs tests/...
git commit -m "<TICKET>: wire the read seam to the configured database driver"
```

## Task 10: Full-suite verification and PR

- [ ] Run the complete verification sequence from a clean worktree:

```
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55481/postgres
npm ci
npm test 2>&1 | tail -9
npm run test:coverage
node scripts/ci/hygiene-check.mjs origin/main
```

- [ ] Open one PR per the natural task grouping this plan's own task boundaries imply
      (likely: Tasks 1-3 as one PR, "write-side wiring"; Tasks 4-6 as one PR, "the
      allocator"; Tasks 7-8 as one PR, "conformance and concurrency proof"; Task 9 as its
      own PR, "the read seam" — each independently reviewable and each leaves the suite
      green, per this repo's PR-unit convention). Title each `<TICKET>: description`.
- [ ] Each PR gets an adversarial review in a separate worktree, by an agent that did not
      write the branch (model: `opus`), before merge.

---

## Self-review notes

- **Spec coverage:** §5 (config plumbing) → Task 2. §6 (write-side Postgres wiring) →
  Tasks 1 and 3. §7 (read seam) → Task 9. §8 (allocator wiring) → Tasks 4-6. §9 (claims.mjs
  retirement timing) → unaffected by this plan, correctly out of scope per the spec's own
  §3. §10 (testing) → Tasks 7-8. §11 (risks) → Review Focus items 1-5 and Task 4's
  rollback test.
- **Placeholder scan:** Task 5 and Task 9 both contain explicit "this plan's research
  didn't fully resolve X, decide during implementation" notes rather than guessed exact
  answers. These are flagged as open decisions with the specific question stated and the
  reason a guess would be worse than the flag (repeating the last plan's citation-error
  failure) — not vague "add error handling"-style placeholders. An adversarial reviewer
  should treat these as the plan's own honesty about its research boundary, and confirm
  each one gets resolved with a real answer during implementation, not left unresolved
  past Task 5/9's own commit.
- **Type/name consistency:** `allocate(project) → { id, n }` (with `fsWritePort` adding
  extra fields, `dbWritePort` not) is used identically across Tasks 4, 5, 6, and the
  conformance/concurrency tests in 7-8.
- **Resolved during this plan's own writing:** `scripts/init-pg.mjs`'s full 46-line body
  was read (not just its first ~30 lines) and confirmed `openPostgres()` is wizard-
  connection-test-shaped, not query-shaped — Task 3 was rewritten to add a separate
  `openPostgresClient()` rather than reuse it. The adversarial review should still
  independently re-read `init-pg.mjs` before clearing Task 3, per this plan's own
  standing rule that a claim carried into a plan gets re-verified, not trusted — but this
  is no longer an open question this plan leaves unanswered.
- **Remaining genuine open decision, correctly left to implementation:** Task 5's
  `fsWritePort.allocate()` claim-file interface (option (a) vs (b)) and Task 9's exact
  read-seam call sites are the two places this plan explicitly says "decide/locate during
  implementation" rather than guessing — both are scoped narrowly enough that guessing
  wrong would cost one task's rework, not the whole plan's premise, unlike the citation
  errors the prior plan's review caught.
