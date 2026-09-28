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
6. **The board's live corpus already has tickets numbered up to at least BLZ-666** (the
   real max, re-derive at implementation time — an earlier version of this plan's own
   research guessed BLZ-700 and was off by tens). **A fresh `project_counter` row starting
   at 0 would allocate `BLZ-1` next, colliding with the real, existing `BLZ-1`.** Task 4
   must seed the counter from each project's current max ticket number before any
   allocation is trusted — this was found missing entirely during this plan's own
   adversarial review, not merely under-tested.

## A note on this plan's second draft

**This plan was refuted once already** by `adversarial-plan-review-before-execution`,
which ran its own code against a scratch copy of live `main` rather than only reading it.
That review found, with evidence: this repo has a write-seam guard
(`tests/model/seam-closure.test.mjs`) this plan's first draft did not know existed, which
a naive implementation of Tasks 1 and 5 would turn red; `dbWritePort.write()`'s underlying
`persist()` is not transactional, so the allocator's rollback guarantee doesn't exist
without adding one; the counter-seeding gap in Review Focus item 6 above; Task 7 targeted
the wrong test suite entirely; Task 8's "concurrency" test used one `pg.Client`, which
node-postgres queues serially, so it proved nothing; and Task 9 would have made reads
follow a different config flag than writes, silently reading Postgres while still writing
to the filesystem — directly contradicting the "mirror the write port's own mode" decision
made earlier in this brainstorm. Every task below has been revised against that review's
findings, re-verified against live `main` a second time (not merely patched from the
review's prose), before this second draft was written.

---

## Task 0: File the tracking ticket

**Files:** none (board operation only, in `blaze-pm-worktrees/v4-spine`).

- [ ] **Parent is `BLZ-195`, not `BLZ-254`** — confirmed against `scripts/model/schema.mjs`'s
      parent-type rule: a `feature` may only parent under `architecture`, `requirement`, or
      `goal`. `BLZ-254` is itself a `feature`, so `--parent BLZ-254` would be refused by
      the engine's own validation; `BLZ-195` (a requirement) is the only valid choice of
      the two.
- [ ] Dispatch `blaze-board-operator` (model: `sonnet`) with a complete brief: run
      `blaze new --project BLZ --type feature "Database-primary read path, Postgres wiring, and id allocator" --estimate 2400 --parent BLZ-195`.
      **Estimate derivation, stated rather than asserted:** the board's own median feature
      estimate is 240 minutes (across 38 features) and median task is 60 minutes (across
      297 tasks) — re-derive both at dispatch time, five days may have moved them. This
      plan's 10 tasks are each roughly feature-sub-task-sized, so `10 × 240 = 2400` is the
      starting figure; the operator may adjust after comparing against BLZ-253's real
      4800-minute estimate for its own comparably-scoped storage-adapter phase.
- [ ] Record the new ticket id here before Task 1 starts. **Create exactly one branch for
      this whole feature** — `git checkout -b <new-id>-db-primary-read-write-allocator` —
      and use the ticket id in every commit message (`<TICKET>: description`) throughout
      Tasks 1-9. Per house convention ("PR unit = the feature, not the ticket"), all nine
      tasks commit to this **one** branch; Task 10 opens exactly **one** PR for it, not
      one per task.

## Task 1: `pgExec()` write-side adapter

**This task also touches `tests/model/seam-closure.test.mjs` — read this before
objecting.** `write-port-resolve.mjs` is already a pinned module in that guard
(confirmed: line 926's `SEAM_WRITE_PROVIDERS` entry lists every one of its current
exports, classified `writes`/`sanctioned`/`inert`). Adding a new export to an
already-pinned module requires adding that export to its classification — the guard's
own test (`"every module the write allowlist names is pinned, export by export"`)
asserts pinned names equal actual exports exactly, so a new unpinned export fails it by
design. **This is not "improving" or "weakening" the guard** (both forbidden by house
convention for this file) — it is the guard's own documented normal path for a new,
legitimately-inert export, identical in shape to how `sqliteExec` is already classified
`inert` in the same entry. `pgExec` is inert by the same reasoning: it wraps a caller-
supplied client's own `.query` calls and reaches no `node:fs` write itself.

**Files:**
- Modify: `scripts/model/write-port-resolve.mjs` (add beside `sqliteExec`, currently at
  lines 32-38).
- Modify: `tests/model/seam-closure.test.mjs`'s `SEAM_WRITE_PROVIDERS` entry for
  `"model/write-port-resolve.mjs"` (line 926) — add `"pgExec"` to that entry's `inert`
  array, beside the existing `"sqliteExec"`.
- Test: `tests/write-port-resolve.test.mjs` (confirmed to be the real path — not
  `tests/model/write-port-resolve.test.mjs`, which does not exist; read this file's
  existing style before adding to it).

**Interfaces:**
- Produces: `pgExec(client)` → `{ run(sql, params) => Promise<void>, all(sql, params) => Promise<Array<object>> }`,
  matching `sqliteExec(db)`'s shape exactly (same two method names, same call shape) so
  `dbWritePort(exec, { dialect })` needs no changes to consume either.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pgExec } from "../scripts/model/write-port-resolve.mjs";

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

Run: `export PATH=/home/rnamwoh/.local/node24/bin:$PATH && node --test tests/write-port-resolve.test.mjs`
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

- [ ] **Step 5: Update the seam-closure pin, then run the guard**

Add `"pgExec"` to `SEAM_WRITE_PROVIDERS`'s `"model/write-port-resolve.mjs"` entry
(line 926)'s `inert` array, beside `"sqliteExec"`, with a one-line comment matching the
existing entry's style (e.g. "pgExec is the same adapter shape as sqliteExec, over a
caller-supplied client — reaches no node:fs write itself").

Run: `node --test tests/model/seam-closure.test.mjs`
Expected: PASS. If it still fails, re-read the failure message exactly — the guard names
the specific mismatch (missing export, or a second array update needed elsewhere in the
same file), don't guess a second fix.

- [ ] **Step 6: Commit**

```bash
git add scripts/model/write-port-resolve.mjs tests/write-port-resolve.test.mjs tests/model/seam-closure.test.mjs
git commit -m "<TICKET>: add pgExec, the async write-side Postgres adapter"
```

## Task 2: Config plumbing — `resolveDatabaseConfig()`

**Corrected after adversarial review, on three points, each cited:** (1) this task's
`Files` list no longer claims to modify `scripts/config.mjs` — no step ever did, and the
review caught the discrepancy; (2) Step 3's `database.url` refusal message now literally
contains the string `database.url`, since Step 1's own test asserts against that exact
pattern and the review ran the two together and got 4 pass / 1 fail; (3) this task now
also implements the `BLAZE_DB_*` env-var precedence tier and the `user:pass@` host
refusal ADR-0012 §2 and §4 require — the first draft's implementation only handled two
of ADR-0012's four precedence tiers while claiming to implement "§2–4 exactly."

**Files:**
- Create: `scripts/model/database-config.mjs` — separate from `config.mjs`, since this
  reads a tracked file, an untracked file, and env vars together, a different shape of
  concern from `config.mjs`'s existing single-tracked-file job.
- Test: `tests/model/database-config.test.mjs`.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resolveDatabaseConfig({ dataRoot, config, env = process.env })` →
  `{ driver: "sqlite" | "postgres", connection: null | { host, port, database, user, password } }`.
  Task 3 and Task 9 both call this — its shape is load-bearing for both.

- [ ] **Step 1: Write the failing tests** (eight cases now, covering Review Focus items
      2-3 plus the env-precedence and `user:pass@` gaps the review found missing)

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

test("a user:pass@ host in blaze.config.json is refused, per ADR-0012 §2", () => {
  assert.throws(
    () => resolveDatabaseConfig({ dataRoot: "/nonexistent",
                                   config: { database: { driver: "postgres", host: "user:pass@db.example" } },
                                   env: {} }),
    /blaze:.*user:pass@/);
});

test("BLAZE_DB_* env vars override .blaze/database.json, per ADR-0012 §4 precedence", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "blaze-dbcfg-"));
  mkdirSync(join(dataRoot, ".blaze"));
  withDatabaseJson(dataRoot, { host: "file-host", port: 5432, database: "file-db",
                               user: "file-user", passwordEnv: "FILE_PW" });
  const result = resolveDatabaseConfig({
    dataRoot, config: { database: { driver: "postgres" } },
    env: { FILE_PW: "unused", ENV_PW: "from-env",
           BLAZE_DB_HOST: "env-host", BLAZE_DB_PASSWORD_ENV: "ENV_PW" } });
  assert.equal(result.connection.host, "env-host");   // env wins over the file
  assert.equal(result.connection.password, "from-env");
  assert.equal(result.connection.database, "file-db"); // untouched fields still come from the file
  rmSync(dataRoot, { recursive: true, force: true });
});

test("with no .blaze/database.json, BLAZE_DB_* env vars alone are sufficient", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "blaze-dbcfg-"));
  const result = resolveDatabaseConfig({
    dataRoot, config: { database: { driver: "postgres" } },
    env: { BLAZE_DB_HOST: "h", BLAZE_DB_PORT: "5432", BLAZE_DB_NAME: "d",
           BLAZE_DB_USER: "u", ENV_PW: "p", BLAZE_DB_PASSWORD_ENV: "ENV_PW" } });
  assert.deepEqual(result.connection, { host: "h", port: 5432, database: "d", user: "u", password: "p" });
  rmSync(dataRoot, { recursive: true, force: true });
});
```

The full import list this test file needs at its top:
`import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";`
(the earlier snippets above call `mkdirSync` directly, not via `require` — this is the
one real import line, stated once here rather than repeated per snippet).

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

const ENV_KEYS = { host: "BLAZE_DB_HOST", port: "BLAZE_DB_PORT", database: "BLAZE_DB_NAME",
                   user: "BLAZE_DB_USER", passwordEnv: "BLAZE_DB_PASSWORD_ENV" };

export function resolveDatabaseConfig({ dataRoot, config = {}, env = process.env }) {
  const dbConfig = config.database ?? {};
  if ("url" in dbConfig) {
    throw new Error(
      "blaze: blaze.config.json's database block may not carry 'database.url' — "
      + "connection details belong in .blaze/database.json, never in tracked config.");
  }
  if ("password" in dbConfig) {
    throw new Error(
      "blaze: blaze.config.json's database block may not carry 'password' — "
      + "connection details belong in .blaze/database.json, never in tracked config.");
  }
  if (typeof dbConfig.host === "string" && dbConfig.host.includes("@")) {
    throw new Error(
      "blaze: blaze.config.json's database.host may not carry a 'user:pass@' form — "
      + "a credential belongs in .blaze/database.json, never in tracked config.");
  }
  const driver = dbConfig.driver ?? "sqlite";
  if (driver !== "sqlite" && driver !== "postgres") {
    throw new Error(`blaze: database.driver=${JSON.stringify(driver)} is not supported — expected 'sqlite' or 'postgres'.`);
  }
  if (driver === "sqlite") return { driver, connection: null };

  // Precedence: env > .blaze/database.json > blaze.config.json > default (ADR-0012 §4).
  // blaze.config.json never carries connection fields (refused above), so the "file"
  // layer here is .blaze/database.json, read only if present — env alone may suffice.
  const path = join(dataRoot, ".blaze", "database.json");
  const fileValues = existsSync(path) ? JSON.parse(readRegularFileSync(path, "utf8")) : {};
  const merged = {};
  for (const [field, envKey] of Object.entries(ENV_KEYS)) {
    merged[field] = env[envKey] ?? fileValues[field];
  }
  if (!merged.host || !merged.port || !merged.database || !merged.user || !merged.passwordEnv) {
    throw new Error(
      `blaze: database.driver is 'postgres' but no complete connection was found — need `
      + "host, port, database, user, passwordEnv from .blaze/database.json and/or "
      + `BLAZE_DB_HOST/BLAZE_DB_PORT/BLAZE_DB_NAME/BLAZE_DB_USER/BLAZE_DB_PASSWORD_ENV. `
      + `Checked ${path} (${existsSync(path) ? "present" : "absent"}).`);
  }
  const password = env[merged.passwordEnv];
  if (password === undefined) {
    throw new Error(
      `blaze: passwordEnv names '${merged.passwordEnv}', but that environment `
      + "variable is not set. Set it before connecting — the password is never stored.");
  }
  return { driver, connection: { host: merged.host, port: Number(merged.port),
                                  database: merged.database, user: merged.user, password } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: same as Step 2. Expected: PASS, 8 tests.

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

**Corrected after adversarial review, on four points:** (1) the first draft's Step 1 test
called `openPostgresClient` with no way to avoid a real network connection, and actually
run, it failed with `EAI_AGAIN getaddrinfo EAI_AGAIN h` — this draft makes the underlying
`pg.Client` constructor injectable so the test never touches a network; (2)
`tests/init-pg.test.mjs` does not exist and there is no existing direct unit test of
`openPostgres` to mirror (its own coverage is indirect, via `tests/init.test.mjs`
injecting a fake `openPostgres` function at a higher call site) — this draft creates the
new file honestly, as new, rather than claiming to extend something that isn't there; (3)
the prior draft's Steps 4-6 were accidentally duplicated with a stale placeholder path
(`tests/model/<located-file>`) — removed; (4) `openPostgresClient` skipped the
schema-version check `openShadow` and `openPostgresRead` both perform — noted below as a
real, separate follow-up rather than silently accepted, since fully closing it means
importing `checkDbSchema`/`createDbSchema` here too and this task is already large enough
to review as one unit without also absorbing that.

**Files:**
- Modify: `scripts/init-pg.mjs` — add `openPostgresClient` beside the existing
  `openPostgres` (lines 1-46), sharing its optional-dependency error handling (this
  duplicates the same `import("pg")` try/catch a third time — `pg-storage.mjs:66`'s
  private `loadPg()` and `init-pg.mjs`'s own `openPostgres` each already have their own
  copy; exporting and sharing one is a legitimate future cleanup, out of scope for this
  task, which follows the codebase's own existing precedent rather than fixing it here).
- Modify: `scripts/model/write-port-resolve.mjs:152-190` (`resolveWritePort`).
- Test: `tests/init-pg.test.mjs` (new file — confirmed no existing direct test of this
  module to extend) and `tests/write-port-resolve.test.mjs` (from Task 1).

**Interfaces:**
- Produces: `openPostgresClient(connection, { Client } = {})` →
  `Promise<pg.Client-shaped>` (connected — `Client` is injectable for testing, defaulting
  to the real `pg.Client` via dynamic import), for `pgExec` (Task 1) to consume.
- Consumes (in `resolveWritePort`): `pgExec` (Task 1), `resolveDatabaseConfig` (Task 2),
  `openPostgresClient` (this task).
- Produces (in `resolveWritePort`): no new exports — its existing return shape
  (`{ port, mode, close }`) is unchanged; only its internal db-vs-sqlite choice changes.

**Follow-up to file, not fixed here:** `openPostgresClient` should check `DB_SCHEMA_VERSION`
the same way `openShadow`/`openPostgresRead` already do, so a stale production Postgres
schema is refused with a named error rather than silently misread — this task does not
close that gap, and it should be a tracked bug ticket (parent to the ticket Task 0 files)
rather than an unmarked omission.

- [ ] **Step 1: Write the failing test for `openPostgresClient`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openPostgresClient } from "../scripts/init-pg.mjs";

test("openPostgresClient connects via the injected Client and returns it", async () => {
  const calls = { constructed: null, connected: false };
  class FakeClient {
    constructor(conn) { calls.constructed = conn; }
    async connect() { calls.connected = true; }
    async query() { return { rows: [] }; }
    async end() {}
  }
  const client = await openPostgresClient(
    { host: "h", port: 5432, database: "d", user: "u", password: "p" },
    { Client: FakeClient });
  assert.deepEqual(calls.constructed, { host: "h", port: 5432, database: "d", user: "u", password: "p" });
  assert.equal(calls.connected, true);
  assert.equal(typeof client.query, "function");
});

test("openPostgresClient without an injected Client, and 'pg' unavailable, refuses clearly", async () => {
  // No Client injected and no real 'pg' package assumed installed in the test environment
  // — this exercises the ERR_MODULE_NOT_FOUND branch for real, not by injection, so it
  // only asserts loosely on the message shape rather than the exact 'pg' import outcome,
  // which depends on whether 'pg' happens to be installed where the suite runs.
  // Skip cleanly if 'pg' IS installed (the error path this test targets can't fire then).
  let pgInstalled = true;
  try { await import("pg"); } catch { pgInstalled = false; }
  if (pgInstalled) { return; } // nothing to assert in this environment; not a false pass — the OTHER test above proves the connect path
  await assert.rejects(
    () => openPostgresClient({ host: "h", port: 5432, database: "d", user: "u", password: "p" }),
    /npm install pg/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/init-pg.test.mjs`
Expected: FAIL, `openPostgresClient is not exported`.

- [ ] **Step 3: Implement, beside `openPostgres` in `scripts/init-pg.mjs`**

```js
/** The production write-port's connection: the raw, connected client, no test wrapper.
 *  Separate from openPostgres() above, which is testConnection-shaped for the wizard —
 *  reusing that wrapper here would give write-port callers no .query to call.
 *  `Client` is injectable so tests never open a real socket. */
export async function openPostgresClient({ host, port, database, user, password }, { Client } = {}) {
  if (!Client) {
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
    Client = pg.Client;
  }
  const client = new Client({ host, port, database, user, password });
  await client.connect();
  return client;
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS, 1 or 2 tests depending on whether `pg` is installed in this environment
(the second test self-skips cleanly rather than false-passing — confirm its skip path
actually runs by temporarily breaking the import path and observing the OTHER test still
passes, per this repo's own "prove the test discriminates" rule, rather than trusting an
untested skip branch).

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

Run: `node --test tests/write-port-resolve.test.mjs` (the real path, confirmed in Task 1)
plus any test importing `resolveWritePort` elsewhere (`grep -rl "resolveWritePort" tests/`).
Expected: PASS, no regressions.

- [ ] **Step 10: Commit**

```bash
git add scripts/init-pg.mjs scripts/model/write-port-resolve.mjs tests/init-pg.test.mjs tests/write-port-resolve.test.mjs
git commit -m "<TICKET>: openPostgresClient, and resolveWritePort opens real Postgres when configured"
```

## Task 4: `project_counter` table, `dbWritePort.allocate()`, transactions, and seeding

**Corrected after adversarial review — three real gaps found, not just citation
errors, all confirmed by actually running probes against live code:**

1. **`persist()` is confirmed not transactional** (`grep -n "BEGIN\|COMMIT\|ROLLBACK"
   write-port.mjs` returns nothing). This task now wraps `persist()`'s own multi-statement
   sequence in a transaction — but **allocation and the ticket insert remain two separate,
   independently-committed operations**, since they're called from different places
   (Task 5's `new.mjs`, not from inside `dbWritePort` itself) and unifying them would mean
   a bigger interface change than this task should absorb. A failed insert after a
   successful allocation **burns that number** — this is accepted, not fixed, matching
   the design spec's own §11 risk table ("tolerable, since gaps are already tolerated by
   design"). The original draft's rollback test asserted the number becomes available
   again; that was wrong given this task's real scope, and is corrected below.
2. **The review's own probe found `persist()` does not even reject an invalid parent** —
   it silently stores `parent_id = null` instead (write-port.mjs's `persist`, the
   `parentId`/`parentType` lookup). An invalid-parent write was the wrong test case for
   "a rejected insert" because it doesn't reject at all; this draft uses an empty
   `title`, which the schema's own `CHECK (btrim(title) <> '')` genuinely rejects.
3. **The counter is never seeded, and the live corpus already has tickets past
   BLZ-666** (Review Focus item 6). A fresh `project_counter` row starting at 0 would
   collide with real existing tickets. This task adds seeding as part of `blaze db init`'s
   corpus load, and a schema-version bump so an *existing* shadow database also gets the
   new table (per `db-schema-version.mjs`'s own stated rule that adding a table to an
   already-shipped version needs a version bump, since `openShadow` only creates schema
   on an empty database).

**Files:**
- Modify: `scripts/model/pg-schema.mjs` and `scripts/model/sqlite-schema.mjs` (add the
  `project_counter` DDL, matching `pg-schema.mjs`'s `ticket` table at line 21's style).
- Modify: `scripts/model/write-port.mjs` (add `allocate` to `dbWritePort`'s returned
  object; wrap `persist()`'s body in a transaction).
- Modify: `scripts/model/db-schema-version.mjs` (bump `DB_SCHEMA_VERSION`, currently `4`
  at line 34, to `5`, with a comment matching the file's existing per-version rationale
  style).
- Modify: `scripts/migrate/load-corpus.mjs` (seed `project_counter` from the loaded
  corpus's actual max ticket number per project, as the last step of `loadCorpus`).
- Test: `tests/model/write-port.test.mjs` (confirmed to exist and cover `dbWritePort` —
  `TICKET()` at line 32 and `sqliteExec()` at line 44 are its real existing fixtures, per
  this plan's own review; there is no existing invalid-ticket fixture, so Step 2 below
  builds the one case it needs inline rather than assuming one exists) and
  `tests/migrate/load-corpus.test.mjs` (for the seeding step).

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

- [ ] **Step 2: Write the failing tests** (covering Review Focus items 1, 5, 6; item 4 is
      addressed with a corrected expectation, see the third test below)

```js
test("dbWritePort.allocate returns sequential numbers for one project", async () => {
  const exec = sqliteExec(); // this file's existing in-memory-db-with-schema helper, per this plan's own verified research
  const port = dbWritePort(exec, { dialect: "sqlite" });
  const a = await port.allocate("BLZ");
  const b = await port.allocate("BLZ");
  assert.deepEqual([a.n, b.n], [1, 2]);
  assert.deepEqual([a.id, b.id], ["BLZ-1", "BLZ-2"]);
});

test("dbWritePort.allocate keeps separate projects independent", async () => {
  const exec = sqliteExec();
  const port = dbWritePort(exec, { dialect: "sqlite" });
  const a = await port.allocate("BLZ");
  const b = await port.allocate("OBA");
  assert.equal(a.n, 1);
  assert.equal(b.n, 1); // OBA's own counter, not BLZ's
});

test("a rejected ticket insert burns its allocated number — accepted, per the design's own risk table", async () => {
  const exec = sqliteExec();
  const port = dbWritePort(exec, { dialect: "sqlite" });
  const { id, n } = await port.allocate("BLZ");
  // An empty title genuinely rejects, via the schema's own CHECK (btrim(title) <> '') —
  // an earlier draft of this test used an invalid parent, which the review's own probe
  // found persist() silently NULLs rather than rejecting, so that case never exercised
  // a real rejection at all.
  await assert.rejects(() => port.write(TICKET({ id, title: "" })));
  const { n: nextN } = await port.allocate("BLZ");
  assert.equal(nextN, n + 1); // the failed attempt's number is NOT reused — a gap, and
                              // gaps are already tolerated by design (ADR-0018).
});

test("allocated id round-trips through dbWritePort's own num() parsing", async () => {
  const exec = sqliteExec();
  const port = dbWritePort(exec, { dialect: "sqlite" });
  const { id } = await port.allocate("BLZ");
  await port.write(TICKET({ id })); // must not throw "cannot derive num from id"
});
```

(`TICKET(...)` and `sqliteExec()` are this file's real existing fixture helpers, per this
plan's own verified research — re-confirm their exact call shape by reading
`tests/model/write-port.test.mjs` in full immediately before writing these tests, since
this plan's research read them by citation rather than transcribing their full bodies.)

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

- [ ] **Step 5: Wrap `persist()`'s body in a transaction** (confirmed by this plan's own
      review to not exist today — `grep -n "BEGIN\|COMMIT\|ROLLBACK" write-port.mjs`
      returns nothing). Wrap `persist()`'s existing sequence (ticket upsert, link
      delete/insert, label/component delete/insert, worklog delete/insert, event insert)
      between `await exec.run("BEGIN")` and `await exec.run("COMMIT")`, with a
      `try`/`catch` that runs `await exec.run("ROLLBACK")` and re-throws on any failure.
      **This protects `persist()`'s own multi-statement sequence** (e.g. a worklog insert
      failing after the ticket row already wrote) — it does **not** make `allocate()` and
      a subsequent `write()` call atomic with each other, since they're invoked from two
      different call sites (this task and Task 5's `new.mjs`, respectively). State this
      distinction in the commit message, not just in this plan, so a future reader doesn't
      assume more than what's actually built.

- [ ] **Step 6: Run tests to verify they pass**

Expected: PASS, all four tests.

- [ ] **Step 7: Add the schema-version bump**

In `scripts/model/db-schema-version.mjs`, change `export const DB_SCHEMA_VERSION = 4;`
(currently line 34) to `5`, with a comment following the file's own established
per-version rationale style, e.g.: `// 5 under <TICKET>, which adds project_counter for
database-native id allocation. An existing v4 shadow has no such table, and blaze db
init --force recreates it from the corpus — same precedent as version 3's own comment:
there is no upgrade to write and no data to lose.`

- [ ] **Step 8: Seed `project_counter` from the live corpus during `blaze db init`**

Write a failing test in `tests/migrate/load-corpus.test.mjs` first, asserting that after
`loadCorpus` runs against a fixture corpus containing `BLZ-3` and `BLZ-7` (and no
`project_counter` row), `project_counter`'s row for `BLZ` holds `n = 7` (the max, not the
count) — then implement: as the last step of `loadCorpus` (`scripts/migrate/load-corpus.mjs`),
after all tickets are inserted, compute the max ticket number per project from the
in-memory ticket list already being iterated (parse each `id`'s numeric suffix, the same
way `dbWritePort`'s own `num()` helper does — reuse that exact parsing rule, don't
re-derive a second one) and `INSERT ... ON CONFLICT (project_key) DO UPDATE SET n = <max>`
for each project. Run the test, confirm it fails, implement, confirm it passes.

- [ ] **Step 9: Run the full existing `load-corpus` test suite** to confirm no regression
      in `blaze db init`'s existing tallies/behavior.

Run: `node --test tests/migrate/load-corpus.test.mjs`
Expected: PASS, no regressions.

- [ ] **Step 10: Commit**

```bash
git add scripts/model/pg-schema.mjs scripts/model/sqlite-schema.mjs scripts/model/write-port.mjs scripts/model/db-schema-version.mjs scripts/migrate/load-corpus.mjs tests/model/write-port.test.mjs tests/migrate/load-corpus.test.mjs
git commit -m "<TICKET>: add project_counter, dbWritePort.allocate(), persist() transactions, and corpus seeding"
```

## Task 5: `fsWritePort.allocate()` via dependency injection, and `new.mjs`'s call-site change

**Redesigned after adversarial review, to avoid a much larger side effect the first
draft would have caused.** Importing `allocateId`/`claims.mjs` directly into
`write-port.mjs` (as the first draft did) turns `tests/model/seam-closure.test.mjs` red:
confirmed, `write-port.mjs`'s import allowlist in that guard (line 2099) permits only
`["fsStorage"]` — adding `allocateId` there is a new import edge the guard doesn't
recognize, and `write-port.mjs` is a much larger module (nine current exports, all
classified `inert`) than `write-port-resolve.mjs` was in Task 1, so pinning it properly
would be a disproportionate side task. **The fix is dependency injection, not a bigger
guard change:** `fsWritePort` takes an injected `allocate` function; `new.mjs` (which
**already** imports `allocateId`/`writeClaim`/`remoteMaxClaim` today, and is **already**
pinned in the guard for exactly those imports — line 2024, `["allocateId", "writeClaim",
"fsStorage"]`, unchanged by this task) supplies the real implementation as a closure. No
new import edge is created anywhere, so no guard change is needed for this task at all.

This also resolves the first draft's open "two options" fork cleanly: the injected
closure is defined inside `new.mjs`'s own `applyNew`, where `title` is already in scope
(it's destructured earlier in the same parameter list `writePort`'s default is part of —
JS evaluates default parameter expressions left-to-right within one destructuring
pattern), so the closure can call `writeClaim` itself and return `{ id, n, claimFile }`
in one step. There is exactly one design now, not two to choose between.

**Files:**
- Modify: `scripts/model/write-port.mjs:77-115` (`fsWritePort`) — add an `allocate`
  parameter, no new imports.
- Modify: `scripts/new.mjs` — the allocation sequence (confirmed by this plan's review to
  actually be at **lines 110-111** for `remoteMaxClaim`/`allocateId`, not 105 as the first
  draft cited, and `writeClaim` at **line 123**, not folded into the 105-118 range the
  first draft claimed).
- Test: `tests/model/write-port.test.mjs` (fs port section, injection-only — no git
  fixture needed, see below) and `tests/new.test.mjs` (the real end-to-end path, which
  **does** need a git fixture — confirmed the file's own `root()` helper at line 14
  already provides one, since `allocateId` reaches into a git worktree via
  `git-common.mjs`; `write-port.test.mjs` has no such fixture, so the end-to-end case
  belongs in `tests/new.test.mjs`, not there).

**Interfaces:**
- Produces: `fsWritePort(projectsDir, storage, readStorage, { allocate })` — the fourth
  parameter's `allocate` is `(project) => Promise<{ id, n, claimFile }>`, supplied by the
  caller. `fsWritePort(...).allocate(project)` calls it.
- Produces: `applyNew`'s default `writePort` now supplies a real `allocate` closure
  inline; `dbWritePort.allocate` (Task 4) returns `{ id, n }` with no `claimFile` —
  `applyNew`'s return object includes `claimFile: undefined` in db/dual-mode, which is
  harmless (existing db-mode git-staging behavior in `new-runner.mjs` is unaffected by
  this task either way, since `write()` already returns an opaque id handle rather than a
  path in db mode — a pre-existing BLZ-299 design point, not something this task changes).

- [ ] **Step 1: Write the failing injection-only test (no git fixture)**

```js
test("fsWritePort.allocate calls the injected function and returns its result", async () => {
  const calls = [];
  const fakeAllocate = async (project) => { calls.push(project); return { id: `${project}-9`, n: 9, claimFile: "/tmp/fake-claim" }; };
  const port = fsWritePort("/tmp/does-not-matter/projects", fsStorage, fsReadStorage, { allocate: fakeAllocate });
  const result = await port.allocate("BLZ");
  assert.deepEqual(calls, ["BLZ"]);
  assert.deepEqual(result, { id: "BLZ-9", n: 9, claimFile: "/tmp/fake-claim" });
});

test("fsWritePort.allocate with no injected function refuses clearly, not silently", async () => {
  const port = fsWritePort("/tmp/does-not-matter/projects", fsStorage, fsReadStorage);
  await assert.rejects(() => port.allocate("BLZ"), /no allocate function was injected/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL, `fsWritePort` doesn't accept a fourth parameter yet.

- [ ] **Step 3: Implement in `write-port.mjs`**

```js
export function fsWritePort(projectsDir, storage = fsStorage, readStorage = fsReadStorage,
                             { allocate } = {}) {
  return {
    name: "fs",
    async allocate(project) {
      if (!allocate) throw new Error("fsWritePort: no allocate function was injected");
      return allocate(project);
    },
    write({ project, status, frontmatter, body, currentFile }) { /* unchanged */ },
    move({ project, status, frontmatter, body, currentFile }) { /* unchanged */ },
    exists({ project, status, frontmatter }) { /* unchanged */ },
    read(id, ctx) { /* unchanged */ },
    close() {},
  };
}
```

(Elide only the four bodies already shown verified in this plan's spec §2 research —
copy them unchanged from the current file; do not retype them from memory.)

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS, 2 tests.

- [ ] **Step 5: Write the failing end-to-end test in `tests/new.test.mjs`**, using its
      existing `root()` git fixture (read it first — don't reinvent it):

```js
test("applyNew's default writePort allocates via fsWritePort.allocate and writes a claim file", async () => {
  const { projectsDir } = root(); // this file's existing git-backed fixture
  const result = await applyNew(projectsDir, { project: "BLZ", type: "task", title: "A test ticket", estimate: 30 });
  assert.equal(result.ok, true);
  assert.match(result.id, /^BLZ-\d+$/);
  assert.ok(result.claimFile);
});
```

- [ ] **Step 6: Run to verify it fails**, then **implement** — in `scripts/new.mjs`,
      replace the current direct sequence (lines 110-111's `remoteMaxClaim`/`allocateId`
      call, and line 123's `writeClaim` call) with the injected default and a single call
      site:

```js
// In the opts-destructuring line, add the writePort default's fourth argument:
writePort = fsWritePort(projectsDir, storage, readStorage, {
  allocate: async (proj) => {
    const dataRoot = dirname(projectsDir);
    const remoteMax = remoteMaxClaim(dataRoot, proj);
    const { id, n } = allocateId(projectsDir, proj, { dataRoot, remoteMax: remoteMax ?? 0 });
    const claimFile = writeClaim(projectsDir, proj, n, slugify(title),
                                  { provisional: remoteMax === null });
    return { id, n, claimFile };
  },
})

// Replacing the body's old sequence:
const { id, n, claimFile } = await writePort.allocate(project);
frontmatter.id = id;
// ... existing target/exists/write logic, unchanged ...
// (claimFile is already computed — no separate writeClaim call remains in the body)
return { ok: true, id, type, project, status, file, claimFile, warnings };
```

`new.mjs`'s imports of `allocateId`, `remoteMaxClaim`, `writeClaim` are unchanged — they
move from the function body into the default-parameter closure, staying in the same
file, so the seam-closure guard's existing pin for `new.mjs` (already permitting exactly
these three imports) needs no change.

- [ ] **Step 7: Run tests to verify they pass**, including re-running `new.mjs`'s full
      existing test suite to confirm zero regression in `blaze new`'s default (fs) path —
      the highest-risk regression surface in this whole plan.

Run: `node --test tests/new.test.mjs tests/model/write-port.test.mjs`
Expected: PASS, zero regressions in `blaze new`'s existing test count.

- [ ] **Step 8: Run the seam-closure guard**, to confirm this task's prediction (no
      change needed) is actually true, not merely argued:

Run: `node --test tests/model/seam-closure.test.mjs`
Expected: PASS, unchanged.

- [ ] **Step 9: Commit**

```bash
git add scripts/model/write-port.mjs scripts/new.mjs tests/new.test.mjs tests/model/write-port.test.mjs
git commit -m "<TICKET>: fsWritePort.allocate via injection, new.mjs supplies the real allocator"
```

## Task 6: `dualWritePort.allocate()`

**Line citation corrected after review:** `dualWritePort` spans `write-port.mjs:386-429`
(the review found the `name` property construction specifically at **line 419**, not 401
as an earlier draft cited — 401 is inside the `try {` of the `both()` helper). This task's
own one-line change is unaffected by the correction, only the citation was wrong.

**No longer conditional on Task 5's design fork** — Task 5's redesign (dependency
injection) produces exactly one `allocate` shape per port, not two to branch on, so this
task's one-line delegation is correct unconditionally.

**Files:**
- Modify: `scripts/model/write-port.mjs:386-429` (`dualWritePort`).
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

## Task 7: `allocate()` proven identical across both write dialects

**Retargeted after adversarial review — the original target didn't exist for this
purpose.** `tests/model/driver-conformance.test.mjs` is confirmed to be a **read**-path
conformance suite (`conformance(seedFs/seedMem/seedSqlite/seedPg)`, exercising
`openSqliteRead`/`openPostgresRead` — no `dbWritePort` or `exec` anywhere in it). There is
no existing shared write-conformance suite spanning both dialects to extend. This task
instead adds one parametrized test directly to `tests/model/write-port.test.mjs` (which
already covers `dbWritePort`, per Task 4), run against SQLite always and Postgres when
available — a smaller, honest target rather than forcing a fit into the wrong file.

**Files:**
- Modify: `tests/model/write-port.test.mjs`.

**Interfaces:**
- Consumes: `dbWritePort(exec, { dialect }).allocate` from both dialects (Task 4).

- [ ] **Step 1: Write one assertion function, called against both dialects**

```js
async function assertAllocateSequential(exec, dialect) {
  const port = dbWritePort(exec, { dialect });
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await port.allocate("SEQ"));
  assert.deepEqual(results.map((r) => r.n), [1, 2, 3, 4, 5]);
  assert.deepEqual(results.map((r) => r.id), ["SEQ-1", "SEQ-2", "SEQ-3", "SEQ-4", "SEQ-5"]);
}

test("dbWritePort.allocate is sequential on sqlite", async () => {
  await assertAllocateSequential(sqliteExec(), "sqlite");
});

test("dbWritePort.allocate is sequential on postgres",
     { skip: !process.env.BLAZE_TEST_PG_URL }, async () => {
  // Reuse whatever this file's own (or the pg conformance suite's) Postgres schema-setup
  // helper already exists — locate via `grep -rn "BLAZE_TEST_PG_URL" tests/` before
  // writing a new one; a project key unique to this test ("SEQPG") avoids collision with
  // other Postgres-backed tests sharing the same CI database.
  const client = new (await import("pg")).default.Client(process.env.BLAZE_TEST_PG_URL);
  await client.connect();
  // ... apply schema via the located helper ...
  await assertAllocateSequential(pgExec(client), "postgres");
  await client.end();
});
```

- [ ] **Step 2: Run without Postgres** — confirm the postgres test reports `skipped`
      visibly, not silently absent.

Run: `node --test tests/model/write-port.test.mjs`
Expected: sqlite test PASS, postgres test skipped (visible in output).

- [ ] **Step 3: Run WITH Postgres up**:
      ```
      docker run --rm -d -e POSTGRES_PASSWORD=x -p 55481:5432 --name blzpg-55481 postgres:17-alpine
      for i in $(seq 1 60); do docker exec blzpg-55481 pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
      export BLAZE_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55481/postgres
      node --test tests/model/write-port.test.mjs
      ```
      Expected: PASS, both tests.
- [ ] **Step 4: Commit**

```bash
git add tests/model/write-port.test.mjs
git commit -m "<TICKET>: prove allocate() sequential and identical across both write dialects"
```

## Task 8: Concurrent-allocation property test against real Postgres

**Corrected after adversarial review — the original test proved nothing about
concurrency.** It ran all 100 `allocate()` calls through **one shared `pg.Client`**, and
node-postgres queues every query on that client's own `_queryQueue` — confirmed by the
review — so the calls executed one after another regardless of the `Promise.all` wrapping
them. That's a test of sequential correctness under one connection, not of the property
BLZ-254's AC actually names (two agents, two machines — i.e., two genuinely separate
connections). This draft uses **two separate `pg.Client` connections**, so the database's
own row-level locking is what's actually being exercised. It also removes the `// ...`
schema-setup placeholder the review flagged, and uses a run-unique project key so a
shared CI Postgres database across test runs can't produce a false pass or false fail
from leftover state.

**Files:**
- Create: `tests/model/allocate-concurrency.test.mjs`.

**Interfaces:**
- Consumes: `dbWritePort` (Task 4), `pgExec` (Task 1), two real Postgres connections
  (`BLAZE_TEST_PG_URL`).

- [ ] **Step 1: Locate the schema-setup helper** the existing pg conformance tests use
      (`grep -rn "BLAZE_TEST_PG_URL\|createDbSchema\|applySchema" tests/model/*.test.mjs`)
      and confirm its exact name and call shape before writing Step 2 — do not leave a
      placeholder comment where a real import belongs.

- [ ] **Step 2: Write the test**, using two independent connections and a run-unique
      project key:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { dbWritePort } from "../../scripts/model/write-port.mjs";
import { pgExec } from "../../scripts/model/write-port-resolve.mjs";
// import Step 1's located schema-setup helper here, e.g.:
// import { applySchema } from "./<located-helper>.mjs";

async function connect() {
  const client = new pg.Client(process.env.BLAZE_TEST_PG_URL);
  await client.connect();
  return client;
}

test("50x50 concurrent allocations on one project, across two real connections: exactly {1..100}, no dup, no gap",
     { skip: !process.env.BLAZE_TEST_PG_URL }, async () => {
  const key = `CT${randomUUID().slice(0, 8).toUpperCase()}`; // run-unique — never collides across CI runs
  const [clientA, clientB] = await Promise.all([connect(), connect()]);
  // await applySchema(clientA); // Step 1's helper, run once against either connection
  const portA = dbWritePort(pgExec(clientA), { dialect: "postgres" });
  const portB = dbWritePort(pgExec(clientB), { dialect: "postgres" });
  const [a, b] = await Promise.all([
    Promise.all(Array.from({ length: 50 }, () => portA.allocate(key))),
    Promise.all(Array.from({ length: 50 }, () => portB.allocate(key))),
  ]);
  const all = [...a, ...b].map((r) => r.n).sort((x, y) => x - y);
  assert.deepEqual(all, Array.from({ length: 100 }, (_, i) => i + 1));
  await Promise.all([clientA.end(), clientB.end()]);
});

test("concurrent allocations on two DIFFERENT projects, across two connections, never collide",
     { skip: !process.env.BLAZE_TEST_PG_URL }, async () => {
  const keyA = `CT${randomUUID().slice(0, 8).toUpperCase()}`;
  const keyB = `CT${randomUUID().slice(0, 8).toUpperCase()}`;
  const [clientA, clientB] = await Promise.all([connect(), connect()]);
  const portA = dbWritePort(pgExec(clientA), { dialect: "postgres" });
  const portB = dbWritePort(pgExec(clientB), { dialect: "postgres" });
  const [resA, resB] = await Promise.all([
    Promise.all(Array.from({ length: 20 }, () => portA.allocate(keyA))),
    Promise.all(Array.from({ length: 20 }, () => portB.allocate(keyB))),
  ]);
  assert.deepEqual(resA.map((r) => r.n).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(resB.map((r) => r.n).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
  await Promise.all([clientA.end(), clientB.end()]);
});
```

- [ ] **Step 3: Run without Postgres** — confirm both tests report `skipped`, not
      silently absent (per this repo's own "assert the observation happened" rule).

Run: `node --test tests/model/allocate-concurrency.test.mjs`
Expected: 2 skipped, 0 failed.

- [ ] **Step 4: Run WITH Postgres up** (same docker setup as Task 7's):

Run: `BLAZE_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55481/postgres node --test tests/model/allocate-concurrency.test.mjs`
Expected: PASS, 2 tests, 0 skipped.

- [ ] **Step 5: Commit**

```bash
git add tests/model/allocate-concurrency.test.mjs
git commit -m "<TICKET>: prove concurrent allocation across two real connections, not one queued client"
```

## Task 9: Wire `buildIndex`'s read source to the write port's own mode; scope the rest as a follow-up

**Substantially re-scoped after adversarial review, which found two problems too large
for this task to absorb, plus a real bug in the design this task must fix:**

1. **The bug: reads and writes must not resolve their driver independently.** The first
   draft had this task call `resolveDatabaseConfig()` (Task 2's `driver` field) to decide
   the reader, while `resolveWritePort` (Task 3) decides the writer from
   `BLAZE_WRITE_PORT`. With `driver: "postgres"` configured but `BLAZE_WRITE_PORT` unset
   (defaulting to `fs`), reads would silently come from Postgres while writes still went
   to the filesystem — directly contradicting the "mirror the write port's own mode, no
   separate flag" decision made earlier in this brainstorm, and confirmed as a real defect
   by the review. **The fix: whatever decides the read source must derive from the SAME
   resolution `resolveWritePort` already produces (its `mode`), not from a second,
   independent call to `resolveDatabaseConfig`.** Concretely: `mode === "db"` reads from
   the database; `mode === "fs"` or `"dual"` reads from the filesystem — one decision,
   reused, not two flags that can disagree.
2. **Too large for this task: `scripts/views/data.mjs`'s synchronous internals.** Its
   `boardModel` does `[...readStorage.listTickets(projectsDir)]` **synchronously**
   (confirmed, line 25) — spreading an iterable immediately, which cannot accept
   `openPostgresRead`'s **async** methods (`pg-storage.mjs`'s reader is async throughout,
   per ADR-0010). Making `views/data.mjs` accept a database reader means converting its
   read path to async **throughout**, a cross-cutting change ADR-0010's own text already
   anticipates ("the transitional filesystem seam stays sync and is deleted at cutover")
   but which is its own body of work, not a sub-step of wiring one config value. The
   Postgres reader is also confirmed **missing an `activityFeed` method** entirely (that
   exists only on `read-storage.mjs`'s filesystem reader, lines 179/231) — a second,
   separate gap. **This task does not attempt either fix.** File a follow-up ticket,
   parented under Task 0's ticket, scoped exactly as: "convert `views/data.mjs`'s read
   path to async and add `activityFeed` to the Postgres reader" — do not silently expand
   this task's scope to cover it, and do not leave it unticketed either.
3. **The locate list was incomplete.** The review found four more `buildIndex(projectsDir)`
   call sites this task's first draft didn't name: `scripts/views/graph.mjs:139`,
   `scripts/views/data.mjs:146`, `scripts/rollup-runner.mjs:60`,
   `scripts/views/panel-content.mjs:81` (re-verify all line numbers at implementation
   time — confirm via `grep -rn "buildIndex(" scripts/`, not by trusting this list).

**This task's actual, completable scope: wire `buildIndex`'s ticket source to
`resolveWritePort`'s resolved mode, everywhere `buildIndex` is called with a
`projectsDir` and no pre-supplied `tickets` array.** `buildIndex` itself needs no
change (it already accepts an optional `tickets` array) — only its callers do.

**Files:**
- Modify: every real call site the corrected locate command finds (at minimum the four
  above, re-verified, plus whatever `serve.mjs`/`reindex.mjs`/`cli.mjs` already had).
- Create: a small SQLite-mode ticket loader analogous to what `openPostgresRead` provides
  for Postgres — **locate whether one already exists first**
  (`grep -rn "openSqliteRead" scripts/model/*.mjs`; if it exists, this task calls it
  rather than building a second one).
- Test: whichever existing test files cover the located callers' current behavior.

- [ ] **Step 1: Run the corrected locate command and read every result in full.**

```
grep -rn "buildIndex(" scripts/
```

Do not proceed until you can answer, with a specific file:line citation for each real
call site: does it already receive a `tickets` array, or does it rely on `buildIndex`'s
own `walkTickets` fallback? Which of these run in an `async` context already (most do,
since they're request handlers or CLI runners), and which — if any — are synchronous
call sites that would need converting to call an async loader (a real, separate finding
to report if found, not silently worked around).

- [ ] **Step 2: Confirm `openSqliteRead`'s existence and shape**

```
grep -rn "openSqliteRead" scripts/model/*.mjs
```

The review confirmed it exists at `scripts/model/sqlite-storage.mjs:65` and is already
imported by `driver-conformance.test.mjs:24` — re-confirm this citation directly rather
than trusting it secondhand, then read its return shape before Step 4.

- [ ] **Step 3: Write the failing test**, at one representative call site (pick the one
      Step 1's reading judges least risky to change first — likely `reindex.mjs`, since
      it's a batch CLI runner rather than a live request path):

```js
test("buildIndex's caller loads tickets from the database when write mode is db", async () => {
  // Shape depends on the real call site's own test conventions, located in Step 1 —
  // assert that with a fake resolveWritePort reporting mode: "db", the tickets fed to
  // buildIndex come from a database loader, not walkTickets; and with mode: "fs" (the
  // default), behavior is byte-for-byte unchanged from today.
});
```

- [ ] **Step 4: Run to verify it fails, then implement** for that one call site: thread
      `resolveWritePort`'s already-resolved `mode` through (not a fresh
      `resolveDatabaseConfig()` call — reuse the same resolution the write path already
      computed, per this task's own corrected framing above) to decide `walkTickets` vs.
      the database loader.
- [ ] **Step 5: Run to verify it passes.**
- [ ] **Step 6: Repeat Steps 3-5 for each remaining real call site** Step 1 found,
      one at a time, each with its own fail-then-pass cycle — not batched, so a failure in
      one doesn't mask a false pass in another.
- [ ] **Step 7: Run the full suite** to confirm no regression in the filesystem-mode
      behavior of every call site touched — the highest-risk task in this plan for silent
      regressions, since the review already found this task's first draft would have
      shipped a real read/write inconsistency bug.

```
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
npm test 2>&1 | tail -9
npm run test:coverage
node scripts/ci/hygiene-check.mjs origin/main
```

- [ ] **Step 8: File the follow-up ticket** for `views/data.mjs`'s async conversion and
      the missing `activityFeed` method (point 2 above), via `blaze-board-operator`,
      parented under Task 0's ticket, before closing this task out — an unticketed known
      gap is exactly the kind of silent scope-narrowing this plan's own review process
      exists to catch.
- [ ] **Step 9: Commit** (one commit per call site converted is reasonable, given each is
      independently testable and independently reviewable per this plan's own task-sizing
      rule — do not batch all call sites into one commit):

```bash
git add <the specific files changed for one call site> tests/...
git commit -m "<TICKET>: <call site> reads from the database when write mode is db"
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

- [ ] **Corrected after adversarial review: one PR for the whole feature, not four.**
      This plan is one ticket (Task 0), and house convention is "PR unit = the feature,
      not the ticket" — one PR per feature integration branch, never split across
      several. Every task's commits (Tasks 1-9) land on the **one** branch created at
      Task 0's dispatch (`<TICKET>-slug`, e.g. `BLZ-7XX-db-primary-read-write-allocator`)
      — no task above creates a separate branch, and none should. Open **one** PR titled
      `<TICKET>: database-primary read path, Postgres wiring, and id allocator` for the
      whole branch.
- [ ] The PR gets an adversarial review in a separate worktree, by an agent that did not
      write the branch (model: `opus`), before merge.

---

## Self-review notes

- **Spec coverage:** §5 (config plumbing) → Task 2. §6 (write-side Postgres wiring) →
  Tasks 1 and 3. §7 (read seam) → Task 9 (re-scoped — see below). §8 (allocator wiring) →
  Tasks 4-6. §9 (claims.mjs retirement timing) → unaffected by this plan, correctly out of
  scope per the spec's own §3. §10 (testing) → Tasks 7-8. §11 (risks) → Review Focus
  items 1-6 and Task 4's transaction/seeding work.
- **This is this plan's second draft, after a real adversarial review ran its own code
  against live `main` rather than only reading it.** That review found defects a reading-
  only pass would not have: a write-seam guard (`tests/model/seam-closure.test.mjs`) the
  first draft never knew existed, which Tasks 1 and 5 as first written would have turned
  red; `persist()` confirmed non-transactional by an actual probe, not just an unread
  grep; a counter-seeding collision with the live corpus's real max ticket number,
  confirmed by actually listing it; a concurrency test that, run for real, proved nothing
  because node-postgres queues queries on one client; a read/write mode inconsistency bug
  that would have shipped a real defect, not a citation error, into production. Every one
  is fixed above, each with the specific evidence that found it, not merely patched to
  look complete.
- **Task 9 was narrowed, not just fixed — stated plainly rather than smoothed over.**
  The original scope (wire `views/data.mjs`, `audit-runner.mjs`, and `buildIndex`'s
  callers all in one task) turned out to require an async conversion of `views/data.mjs`'s
  synchronous internals and a missing `activityFeed` method on the Postgres reader —
  real, separate bodies of work this plan does not attempt. Task 9 now delivers only
  `buildIndex`'s read-source wiring, correctly derived from the write port's own resolved
  mode (fixing the read/write inconsistency bug), and files the rest as a named follow-up
  ticket rather than silently dropping it or falsely claiming to close it.
- **Type/name consistency:** `allocate(project) → { id, n }` (with `fsWritePort`'s
  injected closure adding `claimFile`, `dbWritePort` not) is used identically across
  Tasks 4, 5, 6, and the conformance/concurrency tests in 7-8 — Task 5's redesign
  (dependency injection, resolved during this second draft) removed the two-option fork
  the first draft left open, so there is exactly one shape now, not a choice Task 6 had
  to remain conditional on.
- **Resolved during this plan's own writing (first draft):** `scripts/init-pg.mjs`'s full
  46-line body was read and confirmed `openPostgres()` is wizard-connection-test-shaped,
  not query-shaped — Task 3 adds a separate `openPostgresClient()`. **Resolved during the
  second draft:** that function is now built with an injectable `Client` so its own test
  never opens a real socket, closing the exact defect (`EAI_AGAIN`) the review found when
  it actually ran the first draft's test.
- **Genuinely still open, correctly left to implementation, and small enough that
  guessing wrong costs one task's rework, not the whole plan's premise:** Task 1/Task 3's
  exact schema-setup helper names in the Postgres-backed tests (Steps explicitly say
  "locate before writing," per the review's own finding that helper names invented
  without checking don't exist), and the follow-up ticket Task 9 files is scoped but not
  designed — a future plan, not this one.
