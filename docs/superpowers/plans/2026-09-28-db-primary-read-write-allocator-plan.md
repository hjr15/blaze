# Database-primary read path, Postgres wiring, and id allocator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking. **Do not begin executing until this plan has
> been through `adversarial-plan-review-before-execution`** — that review has not run as
> of this plan's writing.

**Goal:** Give the `blaze` engine a database-native id allocator and config-driven
Postgres wiring for the write port — two of the three pieces an adversarial review found
missing from the earlier cutover plan
(`docs/superpowers/plans/2026-09-23-blaze-phase2-cutover-and-retirement-kickoff.md`). The
third piece, the read path, turned out — after four rounds of adversarial review actually
running this plan's own code against live `main` — to need a real async conversion this
plan does not attempt; this plan delivers one small, genuinely useful piece of it
(`resolveWriteMode()`) and files the rest as its own follow-up ticket rather than
overclaiming completion.

**Architecture:** Move id allocation into each write port as an
`allocate(project, { title })` method (fs wraps existing `claims.mjs` logic, constructed
at both real places `fsWritePort` is built in production — `applyNew`'s default parameter
and `resolveWritePort`'s own `fs`/`dual` branches, since only the latter is actually
reached by the CLI; db uses a new `project_counter` table with one atomic
upsert-and-return statement; dual delegates to its primary, exactly as every other verb in
`dualWritePort` already does). Add a `pgExec()` adapter mirroring the existing
`sqliteExec()`, and teach `resolveWritePort()` to open a real Postgres connection when
configured to, instead of always opening the local SQLite shadow. Implement ADR-0012's
already-decided-but-unbuilt config shape to drive that choice, with its credential
refusal living in `loadConfig` so it fires unconditionally. Extract a synchronous
`resolveWriteMode()` for callers that need to know the configured mode without opening a
connection — the one piece of the read-path story this plan actually completes.

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

**Corrected after adversarial review, on four points, each cited:** (1) this task's
`Files` list no longer claims to modify `scripts/config.mjs` — no step ever did, and the
review caught the discrepancy; (2) Step 3's `database.url` refusal message now literally
contains the string `database.url`, since Step 1's own test asserts against that exact
pattern and the review ran the two together and got 4 pass / 1 fail; (3) this task now
also implements the `BLAZE_DB_*` env-var precedence tier and the `user:pass@` host
refusal ADR-0012 §2 and §4 require — the first draft's implementation only handled two
of ADR-0012's four precedence tiers while claiming to implement "§2–4 exactly"; (4) the
review found the `database.url`/`user:pass@` refusal only fired when
`resolveDatabaseConfig` was actually called — which Task 3 only does in `dual`/`db` write
mode — so a committed `database.url` in `blaze.config.json` would go **unrefused** on a
board running the default `fs` mode, contradicting ADR-0012's literal text ("`loadConfig`
throws"). **This draft moves that specific refusal into `config.mjs`'s own `loadConfig`**,
so it fires unconditionally, exactly as ADR-0012 states, while the rest of connection
resolution stays in `resolveDatabaseConfig` (only reached in `dual`/`db` mode, which is
correct — there's no connection to resolve in `fs` mode).

**Files:**
- Modify: `scripts/config.mjs`'s `loadConfig` (confirmed at line 173) — add the
  `database.url`/`database.password`/`user:pass@` refusal here, unconditionally.
- Create: `scripts/model/database-config.mjs` — the rest of connection resolution
  (untracked-file reading, env-var precedence), separate from `config.mjs` since it reads
  a tracked file, an untracked file, and env vars together, a different shape of concern
  from `config.mjs`'s existing single-tracked-file job. It no longer re-checks
  `url`/`password`/`user:pass@` itself — `loadConfig` already refused those before this
  function is ever reached with a config object.
- Test: `tests/model/database-config.test.mjs`.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resolveDatabaseConfig({ dataRoot, config, env = process.env })` →
  `{ driver: "sqlite" | "postgres", connection: null | { host, port, database, user, password } }`.
  Task 3 and Task 9 both call this — its shape is load-bearing for both.

- [ ] **Step 1: Write the failing tests** (six cases for `resolveDatabaseConfig` itself —
      covering Review Focus items 2-3 plus the env-precedence gap the review found
      missing; the `database.url`/`user:pass@` refusal tests live in Step 3a instead,
      against `loadConfig`, per this round's correction)

**Corrected after adversarial review: this file's temp-directory cleanup used manual
trailing `rmSync` calls, which the review found breaks two other repo guards** — a
trailing statement is skipped whenever an earlier assertion throws (exactly the red-run
case where cleanup matters most, per `scripts/ci/temp-cleanup-guard.mjs`'s own BLZ-603
finding), and this file's un-registered temp directories also tripped the
`quoted-sources` doc-count guard. This repo already has the right tool for this —
`tests/helpers/scratch.mjs`'s `scratchRegistry()`, used elsewhere in this test suite
(`tests/config.test.mjs`, `tests/db-runner.test.mjs`) for exactly this shape of problem —
so this draft uses that instead of hand-rolled cleanup:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchRegistry } from "../helpers/scratch.mjs"; // this test file lives in tests/model/; scratch.mjs is in tests/helpers/ — confirmed by the review, which found "./helpers/" (as if this file were in tests/ root) fails to resolve
import { resolveDatabaseConfig } from "../../scripts/model/database-config.mjs";

const scratch = scratchRegistry();

function withDatabaseJson(dataRoot, obj) {
  mkdirSync(join(dataRoot, ".blaze"));
  writeFileSync(join(dataRoot, ".blaze", "database.json"), JSON.stringify(obj));
  chmodSync(join(dataRoot, ".blaze", "database.json"), 0o600);
}

test("defaults to sqlite with no config anywhere", () => {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blaze-dbcfg-")));
  const result = resolveDatabaseConfig({ dataRoot, config: {}, env: {} });
  assert.deepEqual(result, { driver: "sqlite", connection: null });
});

test("postgres driver with a complete .blaze/database.json resolves a connection", () => {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blaze-dbcfg-")));
  withDatabaseJson(dataRoot, { host: "db.example", port: 5432, database: "blaze",
                               user: "blaze", passwordEnv: "BLZ_DB_PW" });
  const result = resolveDatabaseConfig({
    dataRoot, config: { database: { driver: "postgres" } },
    env: { BLZ_DB_PW: "secret" } });
  assert.equal(result.driver, "postgres");
  assert.deepEqual(result.connection,
    { host: "db.example", port: 5432, database: "blaze", user: "blaze", password: "secret" });
});

test("postgres driver with passwordEnv pointing at an unset var refuses", () => {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blaze-dbcfg-")));
  withDatabaseJson(dataRoot, { host: "db.example", port: 5432, database: "blaze",
                               user: "blaze", passwordEnv: "BLZ_DB_PW_UNSET" });
  assert.throws(
    () => resolveDatabaseConfig({ dataRoot, config: { database: { driver: "postgres" } }, env: {} }),
    /blaze:.*BLZ_DB_PW_UNSET/);
});

test("postgres driver with no .blaze/database.json at all refuses, not silently falls back", () => {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blaze-dbcfg-")));
  assert.throws(
    () => resolveDatabaseConfig({ dataRoot, config: { database: { driver: "postgres" } }, env: {} }),
    /blaze:.*\.blaze\/database\.json/);
});

// The `database.url` / `user:pass@` refusal tests moved to Step 3a below — they test
// `loadConfig`, not `resolveDatabaseConfig`, since that's where the refusal now lives
// (unconditionally, matching ADR-0012's literal text) rather than only when this
// function happens to be called.

test("BLAZE_DB_* env vars override .blaze/database.json, per ADR-0012 §4 precedence", () => {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blaze-dbcfg-")));
  withDatabaseJson(dataRoot, { host: "file-host", port: 5432, database: "file-db",
                               user: "file-user", passwordEnv: "FILE_PW" });
  const result = resolveDatabaseConfig({
    dataRoot, config: { database: { driver: "postgres" } },
    env: { FILE_PW: "unused", ENV_PW: "from-env",
           BLAZE_DB_HOST: "env-host", BLAZE_DB_PASSWORD_ENV: "ENV_PW" } });
  assert.equal(result.connection.host, "env-host");   // env wins over the file
  assert.equal(result.connection.password, "from-env");
  assert.equal(result.connection.database, "file-db"); // untouched fields still come from the file
});

test("with no .blaze/database.json, BLAZE_DB_* env vars alone are sufficient", () => {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blaze-dbcfg-")));
  const result = resolveDatabaseConfig({
    dataRoot, config: { database: { driver: "postgres" } },
    env: { BLAZE_DB_HOST: "h", BLAZE_DB_PORT: "5432", BLAZE_DB_NAME: "d",
           BLAZE_DB_USER: "u", ENV_PW: "p", BLAZE_DB_PASSWORD_ENV: "ENV_PW" } });
  assert.deepEqual(result.connection, { host: "h", port: 5432, database: "d", user: "u", password: "p" });
});
```

`withDatabaseJson` now creates `.blaze/` itself (folded in, since every real call site
needs it and the review found the first draft's separate `require("node:fs").mkdirSync`
calls were themselves invalid — `require` doesn't exist in an ESM test file).

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/model/database-config.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3a: Move the credential refusal into `loadConfig` first, unconditionally**

Write a failing test in whichever file already covers `loadConfig`
(`grep -rl "loadConfig" tests/`), asserting `loadConfig` itself throws on a
`database.url`, a `database.password`, or a `database.host` containing `@` — regardless
of `BLAZE_WRITE_PORT`. Run it, confirm it fails, then add the check to `loadConfig`
(`scripts/config.mjs:173`), immediately after it parses `blaze.config.json`, before it
returns, using this exact wording (this step's own new test asserts against it — Step 1's
test file no longer covers these three cases at all, since they moved here):

```js
// Inside loadConfig, after parsing but before returning:
const dbConfig = cfg.database ?? {};
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
```

Run the new test, confirm it passes. Run `loadConfig`'s full existing test suite to
confirm no regression for boards with no `database` block at all (the common case).

- [ ] **Step 3b: Write `resolveDatabaseConfig` itself — no credential checks here anymore**

Since `loadConfig` (Step 3a) already refuses `url`/`password`/`user:pass@` before this
function ever sees a config object, `resolveDatabaseConfig` only handles driver
validation and connection resolution:

```js
// scripts/model/database-config.mjs — ADR-0012's config shape: the driver name is
// repo config, the connection is not. Credential refusal lives in loadConfig (Step 3a),
// unconditionally — this function only runs the resolution loadConfig has already
// validated the inputs for.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRegularFileSync } from "./regular-file.mjs";

const ENV_KEYS = { host: "BLAZE_DB_HOST", port: "BLAZE_DB_PORT", database: "BLAZE_DB_NAME",
                   user: "BLAZE_DB_USER", passwordEnv: "BLAZE_DB_PASSWORD_ENV" };

export function resolveDatabaseConfig({ dataRoot, config = {}, env = process.env }) {
  const dbConfig = config.database ?? {};
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

Run: same as Step 2. Expected: PASS, 6 tests (two moved to Step 3a's `loadConfig` suite).

- [ ] **Step 5: Commit**

```bash
git add scripts/config.mjs scripts/model/database-config.mjs tests/model/database-config.test.mjs tests/config.test.mjs
git commit -m "<TICKET>: implement ADR-0012's database config resolution, refusal in loadConfig"
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

test("openPostgresClient without an injected Client, and 'pg' unavailable, refuses clearly", async (t) => {
  // No Client injected, exercising the real ERR_MODULE_NOT_FOUND branch rather than a
  // mock — only meaningful when 'pg' genuinely isn't installed where the suite runs.
  // Corrected after review: an early `return` here reports as a PASS with nothing
  // asserted, not a SKIP — use node:test's own t.skip() so a run where 'pg' IS installed
  // (asserting nothing) is visibly distinguishable from one that actually proved the
  // refusal, per this repo's own "assert the observation happened" rule.
  let pgInstalled = true;
  try { await import("pg"); } catch { pgInstalled = false; }
  if (pgInstalled) { t.skip("'pg' is installed in this environment; the other test above already proves the connect path"); return; }
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
  // An empty title genuinely rejects, via the schema's own CHECK (btrim(title) <> '').
  // Corrected AGAIN after a fourth-round review found the spread-override pattern from
  // the prior draft ({ ...TICKET(), id, title: "" }) still fails: port.write() reads
  // frontmatter.id/frontmatter.title (write-port.mjs's write({ frontmatter, ... })
  // signature), not top-level id/title, so the override landed on properties nothing
  // reads. The fix overrides inside frontmatter specifically:
  const t1 = TICKET();
  await assert.rejects(() => port.write({ ...t1, frontmatter: { ...t1.frontmatter, id, title: "" } }));
  const { n: nextN } = await port.allocate("BLZ");
  assert.equal(nextN, n + 1); // the failed attempt's number is NOT reused — a gap, and
                              // gaps are already tolerated by design (ADR-0018).
});

test("allocated id round-trips through dbWritePort's own num() parsing", async () => {
  const exec = sqliteExec();
  const port = dbWritePort(exec, { dialect: "sqlite" });
  const { id } = await port.allocate("BLZ"); // n=1
  const t = TICKET();
  await port.write({ ...t, frontmatter: { ...t.frontmatter, id } }); // must not throw "cannot derive num from id"
  // Corrected after a fifth-round review: merely not-throwing doesn't prove the
  // override took effect — the review found a MIS-placed top-level override (the exact
  // bug this test exists to catch) still passed the prior draft, because nothing read
  // the written row back. Read it back and assert on it directly.
  const written = await port.read(id);
  assert.equal(written.frontmatter.id, id);
});
```

(`TICKET(...)` and `sqliteExec()` are this file's real existing fixture helpers, confirmed
by review to return a `{ frontmatter: { id: "BLZ-1", title: ..., ... }, project, status,
body, ... }` shape matching `write-port.mjs`'s `write({ frontmatter, ... })` signature —
override inside `frontmatter`, not at the top level.)

- [ ] **Step 3: Run tests to verify they fail**

Expected: FAIL, `allocate is not a function`.

- [ ] **Step 4: Implement `allocate` inside `dbWritePort`**, added to the closure
      alongside `persist`/`recordEvent` and exposed on the returned object:

```js
// `title` is accepted for call-site uniformity with fsWritePort.allocate (Task 5) and
// ignored here — db mode has no claim file, so there is nothing to slug it into.
async function allocate(project, { title } = {}) {
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

- [ ] **Step 5: Write the failing test proving `persist()` is transactional** —
      **the review found the original Step 5 had no such test at all**, and a manual
      probe confirmed the property empirically true only after wrapping: forcing a
      duplicate-label failure partway through `persist()`'s sequence left **zero** ticket
      rows when wrapped in a transaction, versus **one** (a half-written ticket) with the
      wrap removed. Pin that exact property as a real test, not an unverified claim:

```js
test("a mid-sequence failure in persist() leaves no partial ticket row", async () => {
  const exec = sqliteExec();
  const port = dbWritePort(exec, { dialect: "sqlite" });
  const { id } = await port.allocate("BLZ");
  // Duplicate labels violate ticket_label's PRIMARY KEY (ticket_id, label) — confirmed
  // by the fourth-round review, which also confirmed labels/title must be overridden
  // inside `frontmatter`, the same fixture-shape correction as the tests above.
  const t = TICKET();
  await assert.rejects(() => port.write({ ...t, frontmatter: { ...t.frontmatter, id, labels: ["a", "a"] } }));
  const rows = await exec.all("SELECT 1 AS hit FROM ticket WHERE id = ?", [id]);
  assert.equal(rows.length, 0, "a half-written ticket row survived a mid-sequence failure");
});
```

- [ ] **Step 6: Run the test to verify it fails** (no transaction exists yet — expect a
      surviving row, i.e. `rows.length === 1`, failing the assertion above).

- [ ] **Step 7: Implement** — wrap `persist()`'s existing sequence (ticket upsert, link
      delete/insert, label/component delete/insert, worklog delete/insert, event insert)
      between `await exec.run("BEGIN")` and `await exec.run("COMMIT")`, with a
      `try`/`catch` that runs `await exec.run("ROLLBACK")` and re-throws on any failure.
      **This protects `persist()`'s own multi-statement sequence only** — it does **not**
      make `allocate()` and a subsequent `write()` call atomic with each other, since
      they're invoked from two different call sites (this task and Task 5's `new.mjs`,
      respectively). State this distinction in the commit message.

- [ ] **Step 8: Run all tests to verify they pass**

Expected: PASS, all five tests (the four from Step 2 plus this step's new one).

- [ ] **Step 9: Bump BOTH schema-version constants and the docs they're described in**
      — **the review found the first draft bumped only `DB_SCHEMA_VERSION`, leaving
      `MIN_DB_SCHEMA_VERSION` at 4, so an existing v4 shadow (with no `project_counter`
      table) would still be silently ACCEPTED and `allocate` would fail on "no such
      table" instead of the named refusal this whole module exists to produce.** Both
      constants are confirmed at `scripts/model/db-schema-version.mjs:39` and `:59`
      respectively — change both `4` to `5`:

```js
// Line 39:
export const DB_SCHEMA_VERSION = 5;
// Line 59, with a comment matching the file's own established per-version style
// (its existing version-4 comment is directly above this constant, in the same file):
// Rises again to 5 under <TICKET>: a v4 shadow has no project_counter table, so a v5
// engine that accepted one would fail later with a raw "no such table" error instead of
// this module's own named refusal — the same failure class every prior version bump
// here exists to replace.
export const MIN_DB_SCHEMA_VERSION = 5;
```

Also update `docs/schema-versioning.md` (confirmed to state "Both are 4 as of BLZ-377" at
line 112, with supporting detail through line 140) — change it to
**`**Both are 5 as of <TICKET>.**`** (keep the `**` bold markers and the exact sentence
shape the existing "Both are 4 as of BLZ-377" line uses — a fifth-round review confirmed
`schema-versioning-docs.test.mjs`'s regex needs both), **substituting the real ticket id
Task 0 created for `<TICKET>` literally, not leaving the placeholder text or its
surrounding backticks in the actual file.**

- [ ] **Step 10: Update the four existing assertions this repo already hard-codes to `4`
      — confirmed by a fifth-round review to be the one real remaining blocker, and the
      sole cause of every full-suite failure it found.** Bumping the two constants
      (Step 9) without also updating these leaves the suite red:
      - `tests/model/config-install.test.mjs:55-56` and `:210` (the last one Postgres-only)
      - `tests/model/db-schema-version.test.mjs:175`, `:180`, and `:242`

      Read each cited line in the real file and change its hard-coded `4` to `5` (or
      whatever the assertion's own wording requires — e.g. "the stamp is 4" becomes "the
      stamp is 5"). These are pins on this plan's OWN change, not pre-existing tests to
      leave alone — a version bump that doesn't move its own test suite's expectations
      forward is not actually verified.

- [ ] **Step 11: Run the schema-version test suite to confirm all bumps are consistent**

```
node --test tests/model/db-schema-version.test.mjs tests/model/config-install.test.mjs tests/schema-versioning-docs.test.mjs
```

(confirm these three exact file paths before running — locate via
`grep -rl "DB_SCHEMA_VERSION\|schema-versioning" tests/` if any don't exist as named.)
Expected: PASS, all three files — a fifth-round review confirmed this exact set of
changes (both constants, the four assertions, and the docs sentence) takes the full
suite from failing to 0 failures with Postgres up.

- [ ] **Step 12: Seed `project_counter` from the live corpus during `blaze db init`**

**Corrected after review: `num()` cannot literally be reused as first drafted** — it's a
closure private to `dbWritePort` (write-port.mjs:161-165), not an export, and exporting
it would trip the seam-closure guard's export-classification test the same way an earlier
attempt did. `load-corpus.mjs` already has its own numeric-suffix parsing (confirmed at
line 91, its own `split("-")` rule) — **use that existing rule, in the same file, rather
than importing anything new.** The review confirmed this step is achievable without
restructuring: `load-corpus.mjs`'s ticket list is fully available before its own
`COMMIT` (confirmed around line 177), so seeding fits naturally as the last step before
that commit. A manual test with `BLZ-3` and `BLZ-7` (no `project_counter` row) correctly
seeded `n = 7` (the max, not the count) when implemented this way.

Write a failing test in `tests/migrate/load-corpus.test.mjs` first, asserting the above,
then implement: as the last step of `loadCorpus`, before its own final `COMMIT`, compute
the max ticket number per project from the ticket list already being iterated (using
`load-corpus.mjs`'s own existing numeric-suffix parsing, not a new import) and
`INSERT ... ON CONFLICT (project_key) DO UPDATE SET n = <max>` for each project. Run the
test, confirm it fails, implement, confirm it passes.

- [ ] **Step 13: Run the full existing `load-corpus` test suite** to confirm no regression
      in `blaze db init`'s existing tallies/behavior.

Run: `node --test tests/migrate/load-corpus.test.mjs`
Expected: PASS, no regressions.

- [ ] **Step 14: File two follow-up tickets for what this task does not close** — the
      review found both, and neither is fixable inside this task's own scope without
      expanding it into a separate body of work:
      1. **Postgres itself is never seeded.** `blaze db init` only ever loads the local
         SQLite shadow (`db-runner.mjs`, confirmed) — a real production Postgres instance
         needs its own seeding step before it can safely serve `db`-mode allocation. This
         is properly an operational runbook step for whoever executes the eventual
         BLZ-254 cutover's soak, not something `blaze db init` itself can do today.
      2. **The counter can drift stale during a dual-write soak.** Tickets created via the
         filesystem path after seeding continue to advance `claims.mjs`'s ledger, not
         `project_counter` — so the counter must be re-seeded immediately before flipping
         `BLAZE_WRITE_PORT` to `db`, not only once at the soak's start. Name this
         explicitly in whatever runbook governs the eventual cutover (the companion
         cutover plan/spec, not this one).
      File both via `blaze-board-operator`, parented under this plan's own ticket
      (Task 0), before closing this task out.

- [ ] **Step 15: Commit**

```bash
git add scripts/model/pg-schema.mjs scripts/model/sqlite-schema.mjs scripts/model/write-port.mjs scripts/model/db-schema-version.mjs docs/schema-versioning.md tests/model/config-install.test.mjs tests/model/db-schema-version.test.mjs scripts/migrate/load-corpus.mjs tests/model/write-port.test.mjs tests/migrate/load-corpus.test.mjs
git commit -m "<TICKET>: add project_counter, dbWritePort.allocate(), persist() transactions, schema-version bump, and corpus seeding"
```

## Task 5: `fsWritePort.allocate()`, constructed at BOTH real call sites, `title` at call time

**Redesigned a second time after adversarial review — the first redesign's injection
point was wrong for production.** The DI approach (an `allocate` closure baked into
`applyNew`'s own default parameter, closing over `title`) was proven broken by an actual
CLI run: `new-runner.mjs` calls `resolveWritePort()` to get its `writePort` and always
passes that explicit object into `applyNew`, so `applyNew`'s *default* parameter — where
the first redesign put the real closure — **never runs in production**. The review ran
`blaze new --project BLZ --type task "Probe ticket" --estimate 30` against the patched
code and got `Error: fsWritePort: no allocate function was injected`; the same command
against unpatched code created `BLZ-1` normally. Worse, closing over `title` was never
going to work here regardless: in the real call chain, `resolveWritePort()` constructs
`writePort` **before** `applyNew` even runs, so `title` isn't known yet at construction
time in production, only at `applyNew`'s own call time.

**The fix: `allocate` takes `title` as a call-time argument, not a construction-time
closure capture, and the real implementation is constructed at BOTH places `fsWritePort`
is actually built** — `applyNew`'s own default parameter (for direct/test callers) *and*
`resolveWritePort()`'s `fs`/`dual` branches (the actual production path). This means
`write-port-resolve.mjs` needs three new imports (`allocateId`, `remoteMaxClaim`,
`writeClaim`) it doesn't have today, plus `slugify` from a module it already partially
imports (`./storage.mjs`, currently only for `fsStorage`) — a real, needed guard change,
not one to route around a second time. `resolveWritePort` is **already** classified
`writes` in the seam-closure guard's export list (line 926's entry lists it under
`writes: [..., "resolveWritePort"]`, confirmed), so this does not change its
classification — only its **import allowlist** (a separate list, line 1982:
`["appendFileSync", "mkdirSync", OPAQUE, "fsStorage"]`) needs the four new names added.
This is smaller and more honest than either of the first two attempts to avoid it.

**Files:**
- Modify: `scripts/model/write-port.mjs:77-115` (`fsWritePort`) — `allocate` now forwards
  `(project, { title })` to the injected function; no new imports here.
- Modify: `scripts/model/write-port-resolve.mjs` — imports `allocateId` (from
  `./ids.mjs`), `remoteMaxClaim`/`writeClaim` (from `./claims.mjs`), `slugify` (added to
  the existing `./storage.mjs` import line); construct the real `allocate` closure in the
  `fs`/`dual` branches of `resolveWritePort` (currently around lines 161-162 for `fs` and
  the dual branch further down).
- Modify: `tests/model/seam-closure.test.mjs`'s import-allowlist entry for
  `"model/write-port-resolve.mjs"` (line 1982) — add `"allocateId"`, `"remoteMaxClaim"`,
  `"writeClaim"`, `"slugify"`.
- Modify: `scripts/new.mjs` — the allocation sequence (confirmed at **lines 110-111** for
  `remoteMaxClaim`/`allocateId`, and `writeClaim` at **line 123**) becomes a call to
  `writePort.allocate(project, { title })`, and `applyNew`'s own default `writePort`
  parameter supplies the same closure shape (duplicated, deliberately — see below).
- Test: `tests/model/write-port.test.mjs` (fs port, injection-only) and
  `tests/new.test.mjs` (the real end-to-end path — **its `root()` fixture returns a
  string path, not `{ projectsDir }`**, and `applyNew`'s `estimate` option belongs under
  `extra.estimate`, not top-level; both corrected below after the review caught both).

**On the duplication between `new.mjs`'s default parameter and
`resolveWritePort`'s construction:** both build the same four-line closure
(`remoteMaxClaim` → `allocateId` → `writeClaim` → return). This is small, deliberate
duplication rather than a shared export, because the alternative (a shared helper
exported from one module and imported by the other) adds a new cross-module edge that
would need its own guard pin either way, for a four-line function. If this bothers a
future reader, factoring it out is a clean, low-risk refactor once both sites are proven
correct independently — not a precondition for this task.

**Interfaces:**
- Produces: `fsWritePort(projectsDir, storage, readStorage, { allocate })` — `allocate` is
  now `(project, { title }) => Promise<{ id, n, claimFile }>`.
- Produces: `dbWritePort.allocate(project, { title })` (Task 4) — `title` is accepted and
  ignored (db mode has no claim file), keeping the call-site signature uniform across all
  three ports so `applyNew`'s one call site never branches on port type.

**A real, minor behavior change, named rather than silently introduced:** today,
`writeClaim` runs strictly *after* the ticket's `exists`/`write` sequence succeeds. This
redesign's `allocate` closure calls `writeClaim` as part of allocation itself, which now
happens *before* the exists-check. In the ordinary case this is inert — a freshly
allocated id has never been written before, so `exists` cannot meaningfully fail for it —
but it is a real reordering, confirmed by a fourth-round review that ran the actual CLI
and diffed the resulting claim file's write order against unpatched code. Accepted as a
low-probability edge case (a claim can already be "provisional" and wrong under a
cross-machine race, per the existing design) rather than redesigned to preserve the exact
original order, since preserving it would mean NOT bundling `writeClaim` into `allocate`
— defeating this task's own point. State this in the commit message.

**A real gap between this commit and Task 6's, named rather than hidden:** after this
task's own commit (before Task 6 lands), `BLAZE_WRITE_PORT=dual` breaks `blaze new`
outright (`dualWritePort`'s primary `fsWritePort` has no `allocate` yet) — confirmed by
the review running `BLAZE_WRITE_PORT=dual blaze new ...` against Tasks 1-5 alone. This is
expected and resolves once Task 6 lands two commits later on the same branch (this plan's
tasks are sequential commits toward one PR, not independent deployments — see Task 10),
but **no existing test in this repo covers `blaze new` under dual mode at all**, so
neither this task's own test run nor its full-suite run would have caught the gap if
Task 6 were skipped or broke differently. Task 6 adds a manual smoke-test step for this —
run by hand and recorded in that commit's message, not an automated `node:test` case
(confirmed by a fifth-round review: Task 6's own commit stages no new test file).

- [ ] **Step 1: Write the failing injection-only test (no git fixture)**

```js
test("fsWritePort.allocate calls the injected function with project and title", async () => {
  const calls = [];
  const fakeAllocate = async (project, { title }) => { calls.push([project, title]); return { id: `${project}-9`, n: 9, claimFile: "/tmp/fake-claim" }; };
  const port = fsWritePort("/tmp/does-not-matter/projects", fsStorage, fsReadStorage, { allocate: fakeAllocate });
  const result = await port.allocate("BLZ", { title: "A test ticket" });
  assert.deepEqual(calls, [["BLZ", "A test ticket"]]);
  assert.deepEqual(result, { id: "BLZ-9", n: 9, claimFile: "/tmp/fake-claim" });
});

test("fsWritePort.allocate with no injected function refuses clearly, not silently", async () => {
  const port = fsWritePort("/tmp/does-not-matter/projects", fsStorage, fsReadStorage);
  await assert.rejects(() => port.allocate("BLZ", { title: "x" }), /no allocate function was injected/);
});
```

(Confirm `fsStorage` and `fsReadStorage` are already imported in this test file before
using them here — the second review found the first draft's test used `fsStorage` in a
file that never imported it; if it isn't imported, add the import rather than assuming.)

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL, `fsWritePort` doesn't accept a fourth parameter yet.

- [ ] **Step 3: Implement in `write-port.mjs`**

```js
export function fsWritePort(projectsDir, storage = fsStorage, readStorage = fsReadStorage,
                             { allocate } = {}) {
  return {
    name: "fs",
    async allocate(project, opts = {}) {
      if (!allocate) throw new Error("fsWritePort: no allocate function was injected");
      return allocate(project, opts);
    },
    write({ project, status, frontmatter, body, currentFile }) { /* unchanged */ },
    move({ project, status, frontmatter, body, currentFile }) { /* unchanged */ },
    exists({ project, status, frontmatter }) { /* unchanged */ },
    read(id, ctx) { /* unchanged */ },
    close() {},
  };
}
```

(Elide only the four bodies already verified in this plan's spec §2 research — copy them
unchanged from the current file; do not retype them from memory.)

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS, 2 tests.

- [ ] **Step 5: Write the failing end-to-end test in `tests/new.test.mjs`**, using its
      real fixture shape (read `root()`'s actual return value first):

```js
test("applyNew's default writePort allocates via fsWritePort.allocate and writes a claim file", async () => {
  // Corrected after a fourth-round review: root() returns the git DATA ROOT, not
  // projectsDir — passing it directly makes the allocator throw
  // "blaze: /tmp is not inside a git worktree". join(root(), "projects") is what this
  // file's existing tests already do; confirm that's still the real pattern before using
  // it, since a fixture's shape can drift between plan-writing and execution.
  const projectsDir = join(root(), "projects");
  const result = await applyNew(projectsDir, { project: "BLZ", type: "task", title: "A test ticket",
                                                extra: { estimate: 30 } }); // estimate under extra, confirmed by review
  assert.equal(result.ok, true);
  assert.match(result.id, /^BLZ-\d+$/);
  assert.ok(result.claimFile);
});
```

- [ ] **Step 6: Run to verify it fails**, then **implement in `scripts/new.mjs`** —
      replace the current direct sequence (lines 110-111, line 123) with a call to
      `writePort.allocate(project, { title })`, and give the default `writePort` parameter
      the same closure shape:

```js
// In the opts-destructuring line, the writePort default's fourth argument:
writePort = fsWritePort(projectsDir, storage, readStorage, {
  allocate: async (proj, { title: t } = {}) => {
    const dataRoot = dirname(projectsDir);
    const remoteMax = remoteMaxClaim(dataRoot, proj);
    const { id, n } = allocateId(projectsDir, proj, { dataRoot, remoteMax: remoteMax ?? 0 });
    const claimFile = writeClaim(projectsDir, proj, n, slugify(t ?? ""),
                                  { provisional: remoteMax === null });
    return { id, n, claimFile };
  },
})

// Replacing the body's old sequence:
const { id, n, claimFile } = await writePort.allocate(project, { title });
frontmatter.id = id;
// ... existing target/exists/write logic, unchanged ...
return { ok: true, id, type, project, status, file, claimFile, warnings };
```

- [ ] **Step 7: Implement the production path in `write-port-resolve.mjs`** — add the
      three new imports plus `slugify` to the existing `./storage.mjs` import line, then
      in `resolveWritePort`'s `fs` branch (and the `fsWritePort(...)` call inside its dual
      branch), construct `fsWritePort` with the identical closure shape from Step 6:

```js
// Added imports at the top of write-port-resolve.mjs:
import { allocateId } from "./ids.mjs";
import { remoteMaxClaim, writeClaim } from "./claims.mjs";
import { fsStorage, slugify } from "./storage.mjs"; // slugify added to the existing line

// Both the `mode === "fs"` early-return AND the fs half of the dual branch construct:
fsWritePort(projectsDir, storage, undefined, {
  allocate: async (proj, { title: t } = {}) => {
    const dataRoot = dirname(projectsDir);
    const remoteMax = remoteMaxClaim(dataRoot, proj);
    const { id, n } = allocateId(projectsDir, proj, { dataRoot, remoteMax: remoteMax ?? 0 });
    const claimFile = writeClaim(projectsDir, proj, n, slugify(t ?? ""),
                                  { provisional: remoteMax === null });
    return { id, n, claimFile };
  },
})
```

- [ ] **Step 8: Update the seam-closure guard's import allowlist — only two names, not
      four.** A fourth-round review found that adding all four (`allocateId`,
      `remoteMaxClaim`, `writeClaim`, `slugify`) fails the guard's own reachability check
      (`"the write-seam scan OBSERVED the corpus, and its allowlist is all load-bearing"`)
      with `remoteMaxClaim (not reached any more)` and `slugify (not reached any more)` —
      the guard only accepts names that actually reach a write, and those two don't
      (`remoteMaxClaim` only reads; `slugify` is pure string manipulation). Add only
      `"allocateId"` and `"writeClaim"` to `"model/write-port-resolve.mjs"`'s entry (line
      1982) — the exact same two names `new.mjs`'s own entry already permits (line 2024),
      confirmed to give 20/20 when run for real.

- [ ] **Step 9: Run tests to verify they pass**, including re-running `new.mjs`'s full
      existing test suite AND a real CLI smoke test — this is the exact regression the
      review caught by running the CLI directly, not just the test suite:

```
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
node --test tests/new.test.mjs tests/model/write-port.test.mjs
# Real CLI smoke test against a scratch board — must succeed, not throw:
mkdir -p /tmp/blaze-smoke-$$/projects/BLZ/defined
cd /tmp/blaze-smoke-$$ && git init -q
node <path-to-blaze-cli>/cli.mjs new --project BLZ --type task "Smoke test ticket" --estimate 30
```

Expected: all tests PASS, and the CLI smoke test creates a real ticket with exit 0 — not
the `no allocate function was injected` error the review found.

- [ ] **Step 10: Run the seam-closure guard**, confirming the import-allowlist update
      actually closes the gap rather than merely arguing it does:

Run: `node --test tests/model/seam-closure.test.mjs`
Expected: PASS.

- [ ] **Step 11: Run the FULL suite**, not just this task's own files — the review found
      15 unrelated test failures (`new-runner.test.mjs`, `cli-key-refusal`,
      `commit-status`, `runner-dataroot`, and others) from the first redesign's breakage,
      which this task's own narrow test run would not have caught:

```
npm test 2>&1 | tail -20
```

Expected: zero regressions anywhere in the suite, not just in the files this task touched.

- [ ] **Step 12: Commit**

```bash
git add scripts/model/write-port.mjs scripts/model/write-port-resolve.mjs scripts/new.mjs tests/new.test.mjs tests/model/write-port.test.mjs tests/model/seam-closure.test.mjs
git commit -m "<TICKET>: fsWritePort.allocate constructed at both real call sites, title at call time"
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
- Produces: `dualWritePort(primary, shadow, opts).allocate(project, { title })` →
  delegates to `primary.allocate(project, { title })` only, per the function's own stated
  principle ("the primary decides every outcome").

- [ ] **Step 1: Write the failing test**

```js
test("dualWritePort.allocate delegates to the primary only, forwarding title", async () => {
  let shadowCalled = false;
  const primary = { name: "fs", allocate: async (p, { title }) => ({ id: `${p}-1`, n: 1, title }) };
  const shadow = { name: "db", allocate: async () => { shadowCalled = true; return { id: "X-99", n: 99 }; } };
  const port = dualWritePort(primary, shadow);
  const result = await port.allocate("BLZ", { title: "A test ticket" });
  assert.deepEqual(result, { id: "BLZ-1", n: 1, title: "A test ticket" });
  assert.equal(shadowCalled, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL, `allocate is not a function`.

- [ ] **Step 3: Implement** — add one line to the returned object (alongside `exists`,
      `write`, `move`, `read`, `close`, per the pattern already there):

```js
allocate(project, opts) { return primary.allocate(project, opts); },
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS.

- [ ] **Step 5: Close the dual-mode `blaze new` gap Task 5 named** — a fourth-round review
      found **no existing test in this repo covers `blaze new` under
      `BLAZE_WRITE_PORT=dual` at all**. Add one, since this is exactly the mode this whole
      subsystem exists to make trustworthy for the eventual soak:

```
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
mkdir -p /tmp/blaze-dual-smoke-$$/projects/BLZ/defined
cd /tmp/blaze-dual-smoke-$$ && git init -q
node <path-to-blaze-cli>/cli.mjs db init   # a fifth-round review found the command below
                                            # fails with "no shadow database ... run
                                            # blaze db init" without this first
BLAZE_WRITE_PORT=dual node <path-to-blaze-cli>/cli.mjs new --project BLZ --type task "Dual-mode probe" --estimate 30
```

Expected: exit 0, a real ticket created, and the shadow reports no divergences — matching
`fs`-mode behavior, not the `TypeError: writePort.allocate is not a function` a
fourth-round review found when this was tried against Tasks 1-5 alone (before this task's
own fix lands). **This is a manual smoke test, not an automated one — a fifth-round
review confirmed this task's commit stages no new test file, so Task 5's earlier claim
that "Task 6 adds the missing coverage" overstated what actually lands.** Run it by hand
and record the exact output in the commit message; if this repo's existing test
conventions make it straightforward to automate as a real `node:test` case during
implementation, do so, but do not claim automated coverage exists if it doesn't.

- [ ] **Step 6: Commit**

```bash
git add scripts/model/write-port.mjs tests/model/write-port.test.mjs
git commit -m "<TICKET>: dualWritePort.allocate delegates to primary; verify blaze new under dual mode"
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
import { randomUUID } from "node:crypto";

async function assertAllocateSequential(exec, dialect, key) {
  const port = dbWritePort(exec, { dialect });
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await port.allocate(key));
  assert.deepEqual(results.map((r) => r.n), [1, 2, 3, 4, 5]);
  assert.deepEqual(results.map((r) => r.id), [1, 2, 3, 4, 5].map((n) => `${key}-${n}`));
}

test("dbWritePort.allocate is sequential on sqlite", async () => {
  await assertAllocateSequential(sqliteExec(), "sqlite", "SEQ");
});

test("dbWritePort.allocate is sequential on postgres",
     { skip: !process.env.BLAZE_TEST_PG_URL }, async () => {
  // Real schema setup, per this repo's own established pattern
  // (tests/model/config-install.test.mjs's "BLZ-377: Postgres installs the same
  // namespace" test): a DEDICATED database per test, not a shared one — schema
  // creation itself collides if two tests race it against one database, confirmed by a
  // fourth-round review that found the prior draft's un-isolated schema setup fails on
  // its second concurrent user. `createDbSchema` (imported below) is the real function;
  // "applySchema" from an earlier draft did not exist.
  const pg = (await import("pg")).default;
  const { createDbSchema } = await import("../../scripts/model/db-schema-version.mjs");
  const { pgExec } = await import("../../scripts/model/write-port-resolve.mjs");
  const dbName = `blz_allocate_seq_${process.pid}`;
  const admin = new pg.Client(process.env.BLAZE_TEST_PG_URL);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const dbUrl = new URL(process.env.BLAZE_TEST_PG_URL);
  dbUrl.pathname = `/${dbName}`;
  const client = new pg.Client(dbUrl.toString());
  await client.connect();
  try {
    await createDbSchema(pgExec(client), { dialect: "postgres" });
    const key = `SQ${randomUUID().slice(0, 6).toUpperCase()}`;
    await assertAllocateSequential(pgExec(client), "postgres", key);
  } finally {
    await client.end(); // runs even if an assertion above throws
    // A fifth-round review found this test (unlike config-install.test.mjs's own
    // dedicated-database test, which this pattern is copied from) never dropped its
    // database — confirmed to leave blz_allocate_seq_<pid> behind after every run. Drop
    // it here, matching the pattern it was copied from.
    const cleanup = new pg.Client(process.env.BLAZE_TEST_PG_URL);
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await cleanup.end();
  }
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

**Corrected a second time after adversarial review — round 4 found round 3's fix
incomplete, not just uncommitted-placeholder-shaped.** No `applySchema` helper exists
anywhere in this repo — round 3's own fix left the literal placeholder import in place.
The real function is `createDbSchema(exec, { dialect })`
(`scripts/model/db-schema-version.mjs`). Worse: even calling the real function, **schema
creation itself collides** when two tests (or two connections in one test) target the
same database — `createDbSchema` refuses on a database that already holds a schema, so
the second test to run failed with `"this database already holds a Blaze schema at
version 5"`. This repo already has the right pattern for exactly this problem —
`tests/model/config-install.test.mjs`'s `"BLZ-377: Postgres installs the same namespace"`
test creates a **dedicated database per test** via an admin connection, per its own
comment explaining why (`configDdl`'s schema name is hardcoded, so two tests building it
cannot be isolated by `search_path`, and `npm test` runs files concurrently against one
server). This draft uses that same pattern: one dedicated database per test (still with
two separate `pg.Client` connections *within* that one database, which is what actually
exercises real cross-connection concurrency), not one shared database across tests.

- [ ] **Step 1: Read `tests/model/config-install.test.mjs`'s dedicated-database pattern
      in full** (its `"BLZ-377: Postgres installs the same namespace"` test) before
      writing Step 2 — confirm the exact `dbName`/`CREATE DATABASE`/`DROP DATABASE`/`URL`
      construction shown there still matches what's in the file, rather than
      transcribing it from this plan's own citation of it.

- [ ] **Step 2: Write the test**, one dedicated database per test, two connections within
      it, run-unique project keys, and `try`/`finally` so a failed assertion still closes
      every connection:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { dbWritePort } from "../../scripts/model/write-port.mjs";
import { pgExec } from "../../scripts/model/write-port-resolve.mjs";
import { createDbSchema } from "../../scripts/model/db-schema-version.mjs";

/** One fresh, isolated database, schema applied, two connections into it — mirrors
 *  config-install.test.mjs's own dedicated-database pattern, since two tests (or two
 *  connections) sharing ONE database collide on schema creation.
 *
 *  Corrected after a fifth-round review reproduced a leak-then-hang: if `createDbSchema`
 *  (or either `connect()`) throws, the caller's OWN try/finally never starts (its
 *  destructuring assignment hasn't run yet), so any client already opened here is never
 *  closed and the test process hangs. This function now closes whatever it opened,
 *  itself, on its own failure — the caller's try/finally only needs to cover the
 *  ordinary post-setup path. Also returns `dbName` so the caller can drop the database
 *  on cleanup, which the second-to-last review round found this test never did. */
async function isolatedDbTwoConnections(name) {
  const dbName = `blz_allocate_${name}_${process.pid}`;
  const admin = new pg.Client(process.env.BLAZE_TEST_PG_URL);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const dbUrl = new URL(process.env.BLAZE_TEST_PG_URL);
  dbUrl.pathname = `/${dbName}`;
  const clientA = new pg.Client(dbUrl.toString());
  const clientB = new pg.Client(dbUrl.toString());
  try {
    await Promise.all([clientA.connect(), clientB.connect()]);
    await createDbSchema(pgExec(clientA), { dialect: "postgres" });
  } catch (e) {
    await Promise.allSettled([clientA.end(), clientB.end()]); // close whatever opened, even on failure
    throw e;
  }
  return { clientA, clientB, dbName };
}

/** Drops the database this helper created — call in the test's own `finally`. */
async function dropDb(dbName) {
  const admin = new pg.Client(process.env.BLAZE_TEST_PG_URL);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
}

test("50x50 concurrent allocations on one project, across two real connections: exactly {1..100}, no dup, no gap",
     { skip: !process.env.BLAZE_TEST_PG_URL }, async () => {
  const key = `CT${randomUUID().slice(0, 8).toUpperCase()}`;
  const { clientA, clientB, dbName } = await isolatedDbTwoConnections("onekey");
  try {
    const portA = dbWritePort(pgExec(clientA), { dialect: "postgres" });
    const portB = dbWritePort(pgExec(clientB), { dialect: "postgres" });
    const [a, b] = await Promise.all([
      Promise.all(Array.from({ length: 50 }, () => portA.allocate(key))),
      Promise.all(Array.from({ length: 50 }, () => portB.allocate(key))),
    ]);
    const all = [...a, ...b].map((r) => r.n).sort((x, y) => x - y);
    assert.deepEqual(all, Array.from({ length: 100 }, (_, i) => i + 1));
  } finally {
    await Promise.all([clientA.end(), clientB.end()]); // runs even if an assertion above throws
    await dropDb(dbName);
  }
});

test("concurrent allocations on two DIFFERENT projects, across two connections, never collide",
     { skip: !process.env.BLAZE_TEST_PG_URL }, async () => {
  const keyA = `CT${randomUUID().slice(0, 8).toUpperCase()}`;
  const keyB = `CT${randomUUID().slice(0, 8).toUpperCase()}`;
  const { clientA, clientB, dbName } = await isolatedDbTwoConnections("twokeys"); // its OWN database, not the prior test's
  try {
    const portA = dbWritePort(pgExec(clientA), { dialect: "postgres" });
    const portB = dbWritePort(pgExec(clientB), { dialect: "postgres" });
    const [resA, resB] = await Promise.all([
      Promise.all(Array.from({ length: 20 }, () => portA.allocate(keyA))),
      Promise.all(Array.from({ length: 20 }, () => portB.allocate(keyB))),
    ]);
    assert.deepEqual(resA.map((r) => r.n).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.deepEqual(resB.map((r) => r.n).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
  } finally {
    await Promise.all([clientA.end(), clientB.end()]);
    await dropDb(dbName);
  }
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

## Task 9: Extract `resolveWriteMode()`; defer all actual read-wiring to the follow-up ticket

**Narrowed a second time after a fourth-round review.** The third draft still assumed
`reindex.mjs` was "an async CLI runner" and planned to prove the read-wiring pattern
there first. The review found `reindex.mjs` is **top-level synchronous code with no
`await` at all** — the same as four of the other five call sites. **There is no call site
among the five where this task can cleanly wire in an actual database read today** — every
one is synchronous, and `openPostgresRead`'s methods are async throughout (ADR-0010).
Pretending otherwise a third time would repeat the exact pattern this session's reviews
keep catching: claiming a task is scoped to something achievable when it isn't. **This
task's real, honest scope shrinks to exactly one thing: extract and pin
`resolveWriteMode()`, a genuinely useful, small, synchronous building block — and defer
*all* actual read-source wiring, at all five call sites, to the follow-up ticket already
being filed for `views/data.mjs`'s async conversion.** That ticket's scope (Step 4 below)
grows to include all five sites, not just `views/data.mjs`, since they share the same
root blocker.

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
   separate gap. **This task does not attempt either fix — both fold into the single
   follow-up ticket Step 4 below files**, which covers this gap plus the five call sites
   named in point 3, as one piece of work, not two separately-scoped tickets.
3. **The locate list was both wrong and incomplete, twice over now.** `scripts/views/graph.mjs:139`
   is actually `scripts/model/graph.mjs:139` (wrong directory). `scripts/views/data.mjs:146`
   (`liveModel`) is a real site the second draft missed; `scripts/views/data.mjs:35`
   (`boardModel`) is a false positive — it already receives `tickets: walked` as a
   parameter, so by this task's own rule ("only callers with no pre-supplied `tickets`
   array") it's already out of scope and was wrongly listed. `scripts/rollup-runner.mjs:60`
   and `scripts/views/panel-content.mjs:81` are correctly named. **`scripts/reindex.mjs`'s
   own call site is top-level synchronous code with no `await` anywhere** — not "an async
   CLI runner" as this task's second draft claimed. **Every one of the five real call
   sites is synchronous.** There is no call site left to treat as "the safe one to prove
   the pattern on first" — that framing itself was the mistake.

**The one thing this task can honestly deliver: extract mode detection from
connection-opening**, since it's independently useful (any future caller, sync or async,
needs a cheap way to ask "what write mode is configured" without opening a database
connection just to find out) and carries no dependency on solving the sync/async problem.
**Everything about actually loading tickets from a database, for all five call sites, is
deferred to the follow-up ticket (Step 4 below)** — not narrowed to "four of five" or "the
easy one first," since round 4 found there is no easy one.

**Files:**
- Modify: `scripts/model/write-port-resolve.mjs` — extract `resolveWriteMode(env)` from
  `resolveWritePort`'s first few lines (confirmed at line 160:
  `const mode = (env[WRITE_PORT_ENV] ?? "fs").trim();`), have `resolveWritePort` call it
  internally instead of duplicating the logic.
- Modify: `tests/model/seam-closure.test.mjs`'s `SEAM_WRITE_PROVIDERS` entry for
  `"model/write-port-resolve.mjs"` (line 926) — add `"resolveWriteMode"` to its `inert`
  array. **This step was missing from the third draft entirely** — a fourth-round review
  found the new export trips the same "every module the write allowlist names is pinned,
  export by export" check Task 1 already handled for `pgExec`, and this task's third
  draft never added the corresponding pin.
- Test: a new test for `resolveWriteMode` itself, plus re-running
  `tests/write-port-resolve.test.mjs` and `tests/model/seam-closure.test.mjs` to confirm
  zero regression.

- [ ] **Step 1: Write the failing test for `resolveWriteMode`**

```js
test("resolveWriteMode reads BLAZE_WRITE_PORT synchronously, defaulting to fs", () => {
  assert.equal(resolveWriteMode({}), "fs");
  assert.equal(resolveWriteMode({ BLAZE_WRITE_PORT: "db" }), "db");
  assert.equal(resolveWriteMode({ BLAZE_WRITE_PORT: "dual" }), "dual");
});
```

- [ ] **Step 2: Run to verify it fails, then extract and implement**

```js
// New export in write-port-resolve.mjs, lifted from resolveWritePort's own first lines:
export function resolveWriteMode(env = process.env) {
  return (env[WRITE_PORT_ENV] ?? "fs").trim();
}
```

Change `resolveWritePort`'s own `const mode = (env[WRITE_PORT_ENV] ?? "fs").trim();` to
`const mode = resolveWriteMode(env);`. Run to verify the new test passes, then run
`tests/write-port-resolve.test.mjs` to confirm zero regression in `resolveWritePort`'s
own existing behavior.

- [ ] **Step 3: Add the seam-closure pin and run the guard**

Add `"resolveWriteMode"` to `SEAM_WRITE_PROVIDERS`'s `"model/write-port-resolve.mjs"`
entry's `inert` array (beside `sqliteExec`, `pgExec` from Task 1), with a comment
matching the existing entries' style (it reads an env var and returns a string — reaches
no write of any kind).

Run: `node --test tests/model/seam-closure.test.mjs`
Expected: PASS. Re-read the failure message exactly if it doesn't — don't guess a second
fix, per this plan's own standing rule for this specific guard.

- [ ] **Step 4: File the follow-up ticket, now covering all five call sites, not just
      `views/data.mjs`** — via `blaze-board-operator`, parented under Task 0's ticket,
      scoped as: "convert the five confirmed `buildIndex` callers
      (`scripts/reindex.mjs:67`, `scripts/model/graph.mjs:139`,
      `scripts/views/data.mjs:146`, `scripts/rollup-runner.mjs:60`,
      `scripts/views/panel-content.mjs:81` — re-verify all five via
      `grep -rn "buildIndex(" scripts/` at ticket-filing time) to support database-mode
      reads. All five are currently synchronous; `openPostgresRead`'s methods are async
      throughout (ADR-0010), so this requires either an async conversion of each call
      site (and everything upstream of it) or a synchronous SQLite-only read path with an
      explicit, separately-decided answer for what a synchronous caller does when the
      configured driver is Postgres specifically. Also carries `views/data.mjs`'s missing
      `activityFeed` method on the Postgres reader (point 2 above). This is real,
      multi-file architectural work — size it accordingly, do not treat it as a quick
      follow-on."

- [ ] **Step 5: Run the full suite** to confirm zero regression from this task's own
      narrow change:

```
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
npm test 2>&1 | tail -9
node scripts/ci/hygiene-check.mjs origin/main
```

- [ ] **Step 6: Commit**

```bash
git add scripts/model/write-port-resolve.mjs tests/write-port-resolve.test.mjs tests/model/seam-closure.test.mjs
git commit -m "<TICKET>: extract resolveWriteMode; defer all read-source wiring to a follow-up ticket"
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
- **Task 9 was narrowed twice, not just fixed — stated plainly rather than smoothed
  over.** The original scope (wire `views/data.mjs`, `audit-runner.mjs`, and
  `buildIndex`'s callers all in one task) turned out to require an async conversion of
  `views/data.mjs`'s synchronous internals and a missing `activityFeed` method on the
  Postgres reader. A second draft narrowed to "wire `buildIndex`'s five callers to the
  write port's resolved mode," but a fifth-round review found even that overstated what's
  achievable: every one of the five real call sites is synchronous, including
  `reindex.mjs`, which this plan wrongly called "an async CLI runner" twice before that
  was checked for real. **Task 9 now delivers exactly one thing — `resolveWriteMode()`, a
  small synchronous mode-check, pinned in the seam-closure guard** — and files everything
  about actually reading from a database at any of the five call sites as one follow-up
  ticket, rather than a third overstated partial-completion claim.
- **Type/name consistency:** `allocate(project, { title }) → { id, n }` (`fsWritePort`
  additionally returning `claimFile`, `dbWritePort` ignoring `title`) is used identically
  across Tasks 4, 5, 6, and the conformance/concurrency tests in 7-8. This is the THIRD
  shape this signature has held across three drafts — closure-captured `title` (draft 2)
  was proven wrong by an actual CLI run, not just reasoning, before landing on `title` as
  a call-time argument (draft 3), which is now consistent with how the real production
  call chain actually constructs a write port before a ticket's title is known.
- **This is this plan's THIRD draft.** Draft 2's adversarial review (run against a scratch
  copy of live `main`, not just read) found something more severe than draft 1's citation
  errors: draft 2's Task 5 redesign, run as a live CLI command
  (`blaze new --project BLZ --type task ...`), threw `no allocate function was injected`
  and would have broken ticket creation for every user — because the real production
  construction site (`resolveWritePort`, not `applyNew`'s default parameter) never got
  the fix. This draft constructs the real `allocate` closure at **both** places
  `fsWritePort` is actually built, verified against the exact production call chain
  (`new-runner.mjs` → `resolveWritePort` → `applyNew`), and Task 5 now includes a real CLI
  smoke test specifically to catch a regression of this class again, not just a unit-test
  run. Also fixed this round: `persist()`'s transaction has a real discriminating test
  (draft 2's had none); the schema-version bump now updates the floor
  (`MIN_DB_SCHEMA_VERSION`) and the docs, not just the version number; `num()`'s reuse
  claim was corrected to describe what's actually possible (load-corpus.mjs's own
  parsing, not an export from a closure); the concurrency test's schema setup and
  connection cleanup are real rather than commented-out placeholders; Task 2's temp-file
  cleanup uses this repo's own `scratchRegistry()` convention instead of manual `rmSync`
  calls that broke two other guards; the `database.url` refusal moved into `loadConfig`
  so it fires unconditionally, matching ADR-0012's literal text, not only when
  `resolveDatabaseConfig` happens to be reached; and Task 9's citations and its
  sync/async mismatch are resolved via an extracted `resolveWriteMode()` rather than
  assumed away.
- **Genuinely still open, correctly left to implementation, and small enough that
  guessing wrong costs one task's rework, not the whole plan's premise:** the two
  follow-up tickets Tasks 4 and 9 file are scoped but not designed — future plans, not
  this one. **Two operational gaps this plan deliberately does not close, ticketed
  instead:** seeding a real production Postgres instance's `project_counter` (only the
  local SQLite shadow gets seeded by `blaze db init`), and re-seeding the counter
  immediately before a dual-write soak flips to `db` mode.
- **This is this plan's FOURTH draft.** Round 4's adversarial review — the first to apply
  every task's code to a scratch copy and run the full suite, not just individual test
  files — reported the design itself sound (Task 5's core fix, verified against the exact
  live CLI command that broke round 3's version, now succeeds) and found nine remaining
  defects, all fixed in this draft: a wrong relative import path in Task 2's test
  (`./helpers/` vs `../helpers/`, since the test file lives in `tests/model/` not
  `tests/`); `TICKET()`'s fixture shape requiring overrides inside `frontmatter`, not at
  the top level, in three of Task 4's tests (two of which could not previously fail *or*
  pass meaningfully as a result); a literal `<TICKET>` placeholder left in prose that
  `schema-versioning-docs.test.mjs` checks by regex; Task 5's seam-closure fix requesting
  two more import-allowlist names than the guard's own reachability check accepts;
  `root()` returning the git data root, not `projectsDir`, in Task 5's end-to-end test;
  no test anywhere covering `blaze new` under dual mode (added to Task 6); a missing
  `pgExec` import and the same commented-out-schema-plus-no-cleanup defect Task 8 already
  fixed, recurring unfixed in Task 7; a nonexistent `applySchema` helper in Task 8 plus a
  schema-creation collision between tests sharing one database (fixed using this repo's
  own `config-install.test.mjs` dedicated-database-per-test pattern); and Task 9's own
  claim that `reindex.mjs` was "an async CLI runner" being false — it's synchronous, like
  all five real call sites — which is why Task 9's real scope narrowed to extracting
  `resolveWriteMode()` alone, with all five call sites' actual read-wiring deferred to a
  follow-up ticket rather than a false claim of partial completion.
