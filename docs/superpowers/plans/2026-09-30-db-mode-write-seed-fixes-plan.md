# db-mode write and seed fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the five known ways `BLAZE_WRITE_PORT=db` either cannot be set up or writes wrongly (BLZ-668, 669, 671, 672, 673), so BLZ-254 can plan a cutover against a write path with no known defects.

**Architecture:** One new pure module (`scripts/model/seed-counter.mjs`) owns the never-lower counter upsert and the three seed sources (ticket files, `.ids/` claims, database rows); `blaze db` gains a Postgres `init` and a `seed-counter` subcommand on top of it. The write port gains `reserve(id)` beside `allocate`, and `applyImport` takes both ids from the port; the fs allocators move into one exported factory (`fsAllocators`) so import keeps its exact no-network behaviour. `dbWritePort` stamps a missing `created`/`updated`. The groomer gains an async db branch (`groomOnceDb`) that materialises the ticket to a scratch file and writes back through the port; the fs groomer is not edited.

**Tech Stack:** Node 24 ESM, `node:test`, `node:sqlite`, `pg` (optional peer dep) against Postgres 17.

**Spec:** `docs/superpowers/specs/2026-09-30-db-mode-write-seed-fixes-design.md` — read it first; this plan argues from it.

**Prototype provenance.** Every code and test block below was run in a scratch worktree of `30978e5` against `postgres:17-alpine`. After adversarial review rounds 4 and 5, the plan was applied to a fresh worktree **one task at a time using its own literal `git add`/`git commit` blocks**; after each task `git status --short` printed nothing and that task's test command passed against the committed tree. On the final committed, clean tree, the full suite (serial, `BLAZE_TEST_PG_URL` set) and `npm run test:coverage` each → `tests 5334, pass 5333, fail 0, skipped 1`, and the c8 thresholds pass (statements 97.94 %, branches 87.91 %, functions 97.37 %, lines 97.94 % against 91/77/93/91). With `BLAZE_READONLY=1` exported, the fifteen affected test files fail only where base `30978e5` already fails (19 tests, e.g. `serve-db-mode`'s `/api/move` cases, which the board server refuses under readonly by design) — none new. The fs import was checked byte-identical against the unmodified engine (tickets, `.ids/` claims, `.cutover`, receipt entries) behind an unreachable git remote.

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
11. **`docs/guide/commands.md` has no `db` section**; Task 8 adds one and its table row. The page's "There are 16 subcommands" was already false (`cli.mjs` `SUBCOMMANDS` has 23), so Task 8 drops the count rather than claiming another wrong number. ADR-0037 is Accepted and ADR-0010/0012 already carry dated addenda, so BLZ-671's `reserve` is an **ADR-0037 addendum**; the groomer residual closure is an **ADR-0038 addendum**.
12. **Lost updates in the db groomer.** `writePort.write` is an upsert of the whole row at the status captured at selection, so a move/worklog/link made during the agent run (≤ `timeoutSec`, 900 s by default) would be silently reverted — reproduced in round 1 (a stub agent running a db-mode `move-runner ENG-1 in-progress` left ENG-1 `defined` and the groom reported success). Since round 3 this is caught by the **store fingerprint** (Finding 16): any port write moves `MAX(ticket_event.id)`, and the pass is refused `store-changed`. The fingerprint is re-checked immediately before the write, and the groomed row is re-read (`changed-concurrently`) — strictly redundant for port writes, kept as defence in depth because it also catches a raw SQL change to that row that appends no event. **Named residual:** check-then-write with no row lock; the window is milliseconds. Closing it (a version column / `SELECT … FOR UPDATE`) belongs to BLZ-254, which owns the concurrency proofs. **The same residual applies to db `reserve` (Finding 14):** its "row exists?" SELECT and the ticket upsert that follows are check-then-write too; a writer landing between them is not caught.
13. **No `write-port.mjs` seam pin is added for `reserve` (spec §3.2 said "the new port methods join write-port.mjs's pins").** `SEAM_WRITE_PROVIDERS` classifies a module's **exports**; `reserve` is a member of the object literals `fsWritePort`/`dbWritePort`/`dualWritePort` return, which the export classifier does not enumerate. Those three factories are already pinned (`inert`), and seam-closure passes 21/21 with no change to that entry — adding `"reserve"` would fail the "every export classified exactly once" assertion, since no export of that name exists. What *is* pinned is the fs allocator that `reserve` calls: `fsAllocators` joins write-port-resolve's `writes` (Task 5 Step 8).
14. **db `reserve` refuses an id that already has a row.** Import calls `reserve` only for an explicit-id **create**, which the planner classifies against the same database — so a row there means a concurrent writer took the id after planning, and the following upsert would overwrite it. The refusal surfaces as import exit 4 (board changed, receipt names the unwritten rows), and its message says what the operator meets next rather than "re-run": a plain re-run *finds* the id (skipped if identical, refused naming `--update` if it differs), and a mapped import with a source-id column refuses at exit 5 until `blaze import repair`. `update` rows never call `reserve`. Pinned at import level (Task 5: a concurrent row injected between plan and apply → exit 4, the concurrent ticket survives).
15. **Cutover cost, stated in the runbook text (Task 8):** after the flip every ticket in the groomer's columns re-grooms once — `.blaze/state.json` holds hashes of *file* text, and the db serialisation differs (it writes empty keys the file omitted). The state file is shared by both modes, so **flipping back to fs re-grooms everything once more** (the db-era hashes don't match the files). No code change; both costs are in the runbook text.
16. **db-groomer containment: one rule, three parts, and what it honestly does not do (rounds 3–4).** Round 3 replaced a patchwork (the round-2 survey excluded the SQLite store and judged it only by re-reading the groomed row — broken three ways: an agent-run `new-runner` planted `ENG-2`; a swapped `.blaze/blaze.db` swallowed the groom's write; a concurrent `import --apply` was half-reverted, its receipt deleted and ref rewound while its row stayed). **(a)** The agent is spawned with `BLAZE_READONLY: "1"`, so a `blaze` write it attempts **while following the rules** is refused. This is a guard, not a sandbox: the agent owns its environment and can unset it (round 4 reproduced `BLAZE_READONLY= new-runner …`), or reach a running board server that is not read-only. **(b)** What catches that is the **store fingerprint** — `MAX(ticket_event.id)` via the read-only `dbWritePort.storeFingerprint()` (the db port already holds the exec for both drivers; the readers expose none; no resolver signature changes; fs/dual untouched) plus, on SQLite, lstat dev/ino/type of `.blaze/blaze.db` and `.blaze/config.db` (not `-wal`/`-shm`/`-journal`: measured, another process's connection closing deletes and recreates them). Compared after the agent and again just before the write (that second check is **untested defence in depth** — no test injects a write between the two). If it moved — by anyone, **the agent included** — the pass is refused `store-changed` and the groom is not written; **the store's own writes stand** (a store cannot be rewound). Board files are left as found (`restoreSkipped`, `restoreSkippedWhy`: "the store changed during the agent run (by the agent or another writer)…") because rewinding another session's receipt or ref is a half-revert — **except** `ALWAYS_RESTORE` (anchored `^(\.blaze/database\.json|blaze\.config\.json|AGENTS\.md|\.blaze/identity\.db(-journal|-wal|-shm)?|\.git/config|\.git/hooks(/.*)?)$`): the DSN (read by `database-config.mjs`), the board config (holds `agentCommand`), `AGENTS.md` (the groomer's own "Grooming rules" — its next prompt), the identity store (`identity-db.mjs`'s `identityDbPath`, with its journal files), and git's execution sinks — restored on every refusal (probe D: DSN, `AGENTS.md` and `identity.db-journal` poison + an agent store write → store-changed, all three restored, the planted row named as standing). Three accepted tradeoffs, named in the code, `commands.md` and ADR-0019: restoring `identity.db` undoes a concurrent `blaze user add`; restoring `.git/config` undoes a concurrent session's own git config change (branch tracking, `git remote add`, `push -u`); restoring `AGENTS.md` undoes a person's own edit to it made during the agent run (or one arriving by `git pull`/`checkout`) — all judged smaller than an agent-written credential, `core.hooksPath` or grooming instruction. Other instruction and execution sinks at the data root (`CLAUDE.md`, `.claude/settings.json`, `.envrc`) are **not** on the list: on `store-changed` they fall under `restoreSkipped` (round 6, named residual; they affect the operator's later sessions, not the next groom, whose agent runs in a scratch cwd). **Back-off:** a store-changed pass records the ticket's current hash in `.blaze/state.json` (the existing shape; no new field) and the event says `backedOff: true`, so the **same unchanged ticket** is not offered to the agent again. That bounds reruns of one ticket; it does **not** stop an agent that unset `BLAZE_READONLY` from planting a ticket and being handed that one next — which is possible because `BLAZE_READONLY` is advisory (the named residual below). Cost: after an innocent concurrent write the ticket waits until it next changes; re-queue it by deleting its entry under `groomed` in `.blaze/state.json` (documented in `commands.md`). Works on Postgres (event id only). **(c)** Everything else on the data root is surveyed as `groomOnce` surveys it — refused `out-of-bounds`, restored, verified, `revertFailed`/`residual`/`newDirt`/`revertErrors` and survey-gap flags, on every non-store-changed refusal path including scratch-only ones; `newDirt` filtered by the same anchored store exclusion. The exclusion is anchored (`^\.blaze/(blaze|config)\.db(-wal|-shm|-journal)?$`) and pinned by a test. `cfg` is loaded before the agent runs. **Named residuals** (code comment, `commands.md`, `design.md`, ADR-0038 and ADR-0019 addenda): store writes by an agent that unset `BLAZE_READONLY` (detected, refused, but standing); a raw SQL write that appends no `ticket_event` row (an agent running `psql` with the credentials, a direct `sqlite3 … UPDATE`, a crafted `-wal`) — caught only on the groomed row, by the re-read; the check-then-write window, which on Postgres also includes identity values committing out of order (a transaction holding an id below the observed MAX that commits during the run).
17. **Named residual — no undo for a db groom.** The feed's revert button (`supervisor.mjs:139`) needs a `sha`; a db groom commits nothing, so there is none. Recorded in the ADR-0038 addendum; a revert through the port is BLZ-254's.
18. **Readonly guards.** `blaze db init`/`seed-counter` carry the per-runner guard AGENTS.md says every mutating runner carries ("Every mutating runner also carries its own `BLAZE_READONLY` guard, hoisted before it writes anything"), via `assertWritable` exactly as `link-runner.mjs`/`sprint-runner.mjs` do — placed after the config resolves (a bad project key is still named first, as `cli-key-refusal.test.mjs` expects) and before anything is opened; `status` stays unguarded. The **db groomer** refuses under `BLAZE_READONLY` too (round 5 reproduced `BLAZE_READONLY=1 BLAZE_WRITE_PORT=db node scripts/loops/groomer.mjs` grooming and writing): the CLI's db branch calls `assertWritable("run blaze groom", process.env)` and exits 1; the supervisor's `runGroomerDb` calls `assertWritable("run the groomer", process.env)` first, and the refusal lands in its `catch` as one groomer error event — published on every tick, as base already published BLZ-670's db refusal; unlike reconcile's readonly refusal it is **not** deduplicated through BLZ-425's `newRunErrorEvent` (round 6; acceptable, since an operator running the supervisor read-only under db sees one line per groomer tick, as today). **Named residual:** `user-runner.mjs`, `init-runner.mjs`, `migrate-runner.mjs`, `schedule-runner.mjs` and the **fs** path of `loops/groomer.mjs` have no per-runner guard (grep count 0 for the runners; the fs groomer commits with `git` directly); a direct `node scripts/<x>.mjs` bypasses `cli.mjs`'s dispatch gate. Not fixed here — each needs its own refusal placement and tests; recorded in the ADR-0019 addendum. **Ambient `BLAZE_READONLY`:** the new guard would have refused tests run under an exported `BLAZE_READONLY=1`; every in-process `runDb` call passes an explicit `env` (`QUIET.env`, `capture().io.env`, `read-storage-resolve`'s two calls), the spawned `db-runner.mjs init` in `config-install.test.mjs`, the new import-runner case and the CLI-groom test clear it, and the supervisor helper sets it explicitly. Verified: the affected files under `BLAZE_READONLY=1` produce no failure that base `30978e5` does not already produce.
19. **Every task's commit block was audited against its Files list and Steps (round-4 B1).** Task 6 Step 3 edits `scripts/model/write-port.mjs` (`storeFingerprint`) and Step 1 now edits `tests/model/write-port.test.mjs`; the round-3 pathspec omitted both, so the committed branch failed 15/17 groomer tests with `writePort.storeFingerprint is not a function`. Every commit block is now `git add <paths>` + `git commit … -- <same paths>` + `git status --short` (must print nothing), and the prototype was built by running those literal blocks task by task, running each task's tests against the committed tree.

## Review Focus

1. **A Postgres that is initialised but whose counter is stale** (ids handed out on the file path after `init`) → `seed-counter` raises it, never lowers it, and reports `before → after`. Pinned: Task 3 (`seed-counter on Postgres raises the counter to a new claim and is idempotent`).
2. **An operator re-runs `blaze db init` on a live Postgres, or passes `--force`** → refused, nothing dropped, the message names `blaze db seed-counter`; `--force` refused before any connection. Pinned: Task 2.
3. **An explicit-id import row whose `project` differs from its id prefix** (fs) → claim still written under the row's project, exactly as before. Pinned: Task 5 (`the fs port reserves an explicit id: the claim is written under the given project`) plus the byte-identical check in Task 5 Step 10.
4. **Another session writes to the store while the groomer's agent is running** (a move, an import) → the pass is refused `store-changed`, nothing is written or rewound, and the other session's work — row, receipt, git ref — survives. Pinned: Task 6 (`a move made by ANOTHER session…`, `a concurrent db-mode import…`, the Postgres case). The agent editing the file into something unparseable returns `reason: "unparseable"` (same path as `invalid`; not separately pinned — reviewers should read it).
5. **An operator runs `blaze groom` or the supervisor loop under `BLAZE_READONLY` in db mode** → refused (exit 1 / one groomer error), the agent never runs, nothing is written. Pinned: Task 7.
6. **The groomer's agent tries to write** — through `blaze` following the rules (refused by `BLAZE_READONLY`), through `blaze` after unsetting it (`store-changed`: its row stands, its DSN/config/hook poison is restored, the ticket backs off), by swapping the store file (`store-changed`), or anywhere else on the board (`.blaze/database.json`, a new ticket file, `blaze.config.json`, a look-alike store path → `out-of-bounds`, restored, nothing thrown). Pinned: Task 6 (probes 1, 2 and D, the back-off test, `a write ANYWHERE…`, `a corrupted blaze.config.json…`, `…ANCHORED…`).
7. **`blaze db init` on Postgres fails part-way (seed error after the schema exists, or a foreign/unstamped schema)** → a named error that says what state the database is in; only a genuinely initialised database is sent to `seed-counter`. Pinned: Task 2 (seed failure, foreign tables) and Task 3 (recovery via `seed-counter`).
8. **A db-mode groomer pass whose resolver refuses** (no shadow/no schema) → one `{type:"error", loop:"groomer"}` event, loop not left `busy`, ports closed. Pinned: Task 7.

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
git status --short   # must print nothing
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test --test-concurrency=1 tests/db-runner-pg.test.mjs`
Expected: FAIL (with `BLAZE_TEST_PG_URL` set) — acceptance: `/Postgres schema ready at …/` does not match (today's `init` builds a SQLite shadow instead); `--force`: exit 0 ≠ 1; seed failure: rejects with the uncaught `Error: ticket: missing frontmatter (--- on line 1)` from today's SQLite init walking the board; foreign tables: `0 !== 1` (today's init builds a SQLite shadow and exits 0); cleanup: message `blaze: this Postgres database has no Blaze schema` does not match `the Postgres database 127.0.0.1/blz668_refuse_…`.

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
import { corpusMaxima, seedCounter } from "./model/seed-counter.mjs";
```

and extend the existing `import { DB_SCHEMA_VERSION } from "./model/db-schema-version.mjs";` to

```js
import { DB_SCHEMA_VERSION, createDbSchema } from "./model/db-schema-version.mjs";
```

(one import per module; `openCheckedPg` is used from Task 3 — importing it now is harmless.)

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
    const where = describePgTarget(connection);
    try { await createDbSchema(exec, { dialect: "postgres" }); }
    catch (e) {
      err(`blaze db init: ${where} — ${e.message}.`);
      // Only an ALREADY-INITIALISED database is sent to seed-counter. Anything else (an
      // unstamped or foreign schema, a permission error) is surfaced as it is.
      if (/already holds a Blaze schema/.test(e.message)) {
        err("It is already initialised. To bring its id counter up to date, run:\n");
        err("    blaze db seed-counter\n");
      }
      return 1;
    }
    let rows;
    try {
      rows = await seedCounter(exec,
        await corpusMaxima({ projectsDir, readStorage: fsReadStorage }), { dialect: "postgres" });
    } catch (e) {
      // The schema now EXISTS, so re-running init would refuse. Say so, and name the step
      // that finishes the job once the cause is fixed.
      err(`blaze db init: the schema was created at ${where}, but seeding the id counter failed:`);
      err(`  ${e.message}\n`);
      err("Fix that, then finish with:\n");
      err("    blaze db seed-counter\n");
      return 1;
    }
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
Expected: PASS, 0 failures (db-runner-pg: 5 tests with `BLAZE_TEST_PG_URL` set).

- [ ] **Step 7: Commit**

```bash
git add scripts/db-runner.mjs scripts/model/write-port-resolve.mjs tests/db-runner-pg.test.mjs tests/model/seam-closure.test.mjs
git commit -m "BLZ-668: blaze db init on Postgres — schema and counter seed, --force refused, refusal names host/database" -- scripts/db-runner.mjs scripts/model/write-port-resolve.mjs tests/db-runner-pg.test.mjs tests/model/seam-closure.test.mjs
git status --short   # must print nothing
```

---

### Task 3: `blaze db seed-counter`, and SQLite init seeds the claims (BLZ-669)

**Files:**
- Modify: `scripts/db-runner.mjs` (add `seedCounterCmd`; dispatch; SQLite init calls `seedCounter`; per-runner `BLAZE_READONLY` guard on `init`/`seed-counter`)
- Modify: `tests/db-runner.test.mjs` (capture `env`, append), `tests/db-runner-pg.test.mjs` (append), `tests/helpers/db-board.mjs` (`QUIET.env`), `tests/read-storage-resolve.test.mjs` and `tests/model/config-install.test.mjs` (explicit env — ambient `BLAZE_READONLY` must not refuse them)

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
```

Because `init`/`seed-counter` now honour `BLAZE_READONLY`, every in-process `runDb` call in a test passes an explicit `env` so an ambient `BLAZE_READONLY=1` in the shell running the suite cannot refuse it (and the one spawn of `db-runner.mjs init` clears it):

- `tests/helpers/db-board.mjs`: replace `export const QUIET = { log() {}, err() {} };` with

```js
// `env: {}` — runDb's readonly guard reads `io.env ?? process.env`; tests pass an explicit,
// empty env so an ambient BLAZE_READONLY=1 in the shell running the suite cannot refuse them.
export const QUIET = { log() {}, err() {}, env: {} };
```

- `tests/db-runner.test.mjs` (its `capture` helper): replace `  const io = { log: (s) => out.push(String(s)), err: (s) => out.push(String(s)) };` with

```js
  // `env: {}` — runDb's readonly guard must not read an ambient BLAZE_READONLY (BLZ-668).
  const io = { log: (s) => out.push(String(s)), err: (s) => out.push(String(s)), env: {} };
```

- `tests/read-storage-resolve.test.mjs`: both `await runDb(["init"], { log() {}, err() {}, roots })` → `await runDb(["init"], { log() {}, err() {}, env: {}, roots })`.
- `tests/model/config-install.test.mjs` (the `init` spawn helper): replace `    { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });` with

```js
    // BLZ-668: db init is readonly-guarded now; an ambient BLAZE_READONLY must not refuse it here.
    { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects"), BLAZE_READONLY: "" }, encoding: "utf8" });
```

(`tests/db-runner-pg.test.mjs`'s `capture` already passes `env: {}` from Task 2.)

In `tests/db-runner.test.mjs` change `import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";` to

```js
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
```

add after `import { runDb } from "../scripts/db-runner.mjs";`:

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
    assert.equal(await runDb(["init"], { ...capture().io, roots }), 0);
    assert.equal(await counterOf(roots.dataRoot, "ENG"), 7);
  });

  test("seed-counter raises the counter to a claim made after init, then is idempotent", async () => {
    const roots = board();
    assert.equal(await runDb(["init"], { ...capture().io, roots }), 0);
    writeClaim(roots.projectsDir, "ENG", 9, "handed-out-on-the-file-path");
    const c1 = capture();
    assert.equal(await runDb(["seed-counter"], { ...c1.io, roots }), 0);
    assert.match(c1.text(), /ENG\s+1 → 9/);
    const c2 = capture();
    assert.equal(await runDb(["seed-counter"], { ...c2.io, roots }), 0);
    assert.match(c2.text(), /ENG\s+9 → 9/);
    assert.equal(await counterOf(roots.dataRoot, "ENG"), 9);
  });

  test("seed-counter before init refuses, naming blaze db init", async () => {
    const c = capture();
    assert.equal(await runDb(["seed-counter"], { ...c.io, roots: board() }), 1);
    assert.match(c.text(), /no shadow database/);
    assert.match(c.text(), /blaze db init/);
  });
});

// BLZ-668: `init` and `seed-counter` carry the per-runner BLAZE_READONLY guard (AGENTS.md), so a
// direct `node db-runner.mjs` refuses under it just as `blaze db` does at dispatch.
describe("blaze db under BLAZE_READONLY", () => {
  test("init refuses and creates no shadow; seed-counter refuses", async () => {
    const roots = board();
    const c = capture();
    assert.equal(await runDb(["init"], { ...c.io, roots, env: { BLAZE_READONLY: "1" } }), 1);
    assert.match(c.text(), /read-only mode \(BLAZE_READONLY=1\) — refusing to run blaze db init/);
    assert.equal(existsSync(join(roots.dataRoot, ".blaze", "blaze.db")), false);
    const c2 = capture();
    assert.equal(await runDb(["seed-counter"], { ...c2.io, roots, env: { BLAZE_READONLY: "1" } }), 1);
    assert.match(c2.text(), /refusing to run blaze db seed-counter/);
  });

  test("status still runs — it only reads", async () => {
    assert.equal(await runDb(["status"], { ...capture().io, roots: board(), env: { BLAZE_READONLY: "1" } }), 0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test --test-concurrency=1 tests/db-runner.test.mjs tests/db-runner-pg.test.mjs`
Expected: FAIL — `seed-counter` cases: `unknown command "seed-counter"` (exit 1 where 0 expected); `after init could not seed…`: the `seed-counter` step exits 1 (unknown command); `init seeds the counter from a claim above every ticket`: `1 !== 7` (loadCorpus counts tickets only); `blaze db under BLAZE_READONLY` → `init refuses…`: `0 !== 1` (no per-runner guard yet).

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
  if (!dbConfig || !writableOr(ctx, "seed-counter")) return 1;
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

(c) add the per-runner readonly guard AGENTS.md promises every mutating runner carries ("Every mutating runner also carries its own `BLAZE_READONLY` guard, hoisted before it writes anything"; `link-runner.mjs`/`sprint-runner.mjs` call `assertWritable` the same way). It runs AFTER the config is resolved, so a bad project key is still the refusal an operator sees first (`tests/cli-key-refusal.test.mjs`'s direct `db-runner.mjs init` case keeps passing even under an ambient `BLAZE_READONLY=1`). Change the import `import { DB_SCHEMA_VERSION, createDbSchema } from "./model/db-schema-version.mjs";` to be followed by

```js
import { assertWritable } from "./readonly.mjs";
```

insert immediately above `/** One line per project, \`before → after\`, plus a note when nothing moved. */`:

```js
/**
 * BLZ-668: the per-runner BLAZE_READONLY guard every mutating runner carries (AGENTS.md), for a
 * direct `node db-runner.mjs` that bypasses cli.mjs's dispatch gate. Called by `init` and
 * `seed-counter` AFTER the config is resolved (a bad project key is still named first, as in
 * the other runners) and BEFORE anything is opened or written. `status` only reads.
 */
function writableOr(ctx, what) {
  try { assertWritable(`run blaze db ${what}`, ctx.env); return true; }
  catch (e) { ctx.err(e.message); return false; }
}

```

in `init(ctx)` replace

```js
  const dbConfig = dbConfigOr(ctx);
  if (!dbConfig) return 1;
  if (dbConfig.driver === "postgres") return initPostgres(ctx, dbConfig.connection);
```

with

```js
  const dbConfig = dbConfigOr(ctx);
  if (!dbConfig || !writableOr(ctx, "init")) return 1;
  if (dbConfig.driver === "postgres") return initPostgres(ctx, dbConfig.connection);
```

and in `runDb` replace

```js
                openPgClient: io.openPostgresClient ?? openPostgresClient };
```

with

```js
                openPgClient: io.openPostgresClient ?? openPostgresClient,
                env: io.env ?? process.env };
```

(`io.env` is injectable for the tests; `status` stays unguarded — it only reads. `seedCounterCmd` in (a) already calls `writableOr(ctx, "seed-counter")`.)

(d) in `runDb` add after `if (cmd === "init") return init(ctx);`:

```js
  if (cmd === "seed-counter") return seedCounterCmd(ctx);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-concurrency=1 tests/db-runner.test.mjs tests/db-runner-pg.test.mjs tests/db-mode-reads.test.mjs tests/read-storage-resolve.test.mjs tests/model/config-install.test.mjs tests/model/seam-closure.test.mjs`
Expected: PASS — db-runner `pass 11`; db-runner-pg `pass 8` with Postgres; seam-closure 21/21 (db-runner's new calls reach no unpinned write member).

- [ ] **Step 5: Commit**

```bash
git add scripts/db-runner.mjs tests/db-runner.test.mjs tests/db-runner-pg.test.mjs tests/helpers/db-board.mjs tests/read-storage-resolve.test.mjs tests/model/config-install.test.mjs
git commit -m "BLZ-669: blaze db seed-counter for both drivers; SQLite init also seeds from .ids/ claims" -- scripts/db-runner.mjs tests/db-runner.test.mjs tests/db-runner-pg.test.mjs tests/helpers/db-board.mjs tests/read-storage-resolve.test.mjs tests/model/config-install.test.mjs
git status --short   # must print nothing
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
Expected: FAIL — `TypeError: Provided value cannot be bound to SQLite parameter 19.` (the `undefined` `created_on`; write-port "no created/updated" case), and the import exits 4 with the same message for `ENG-7` (`AssertionError: CREATED — 2 …`, since the report is the assertion message).

- [ ] **Step 4: Implement** — in `scripts/model/write-port.mjs` replace (the clock goes ABOVE the JSDoc, so the comment stays attached to `dbWritePort`)

```js
/**
 * Database adapter. `exec` is the same {run, all} shape the projection uses, so it
 * works against SQLite synchronously and Postgres asynchronously without a second
 * implementation — ADR-0010's async port doing the job it was chosen for.
 */
export function dbWritePort(exec, { dialect = "sqlite" } = {}) {
```

with

```js
/** `YYYY-MM-DD`, the same expression `new-runner.mjs` stamps `created`/`updated` with. */
const isoToday = () => new Date().toISOString().slice(0, 10);

/**
 * Database adapter. `exec` is the same {run, all} shape the projection uses, so it
 * works against SQLite synchronously and Postgres asynchronously without a second
 * implementation — ADR-0010's async port doing the job it was chosen for.
 */
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
git add scripts/model/write-port.mjs tests/model/write-port.test.mjs tests/import-db-mode.test.mjs
git commit -m "BLZ-672: db write port stamps a missing created/updated with the write's date" -- scripts/model/write-port.mjs tests/model/write-port.test.mjs tests/import-db-mode.test.mjs
git status --short   # must print nothing
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
  - `dbWritePort(...).reserve(id) → Promise<{}>` — throws `reserve: <id> already exists in the database — another writer created it after this import was planned, so this row was NOT written …` (the message then says what a re-run meets) when a `ticket` row has that id; otherwise the never-lower upsert keyed on the id's prefix.
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

  test("dbWritePort.reserve refuses an id that already has a row — the write after it would overwrite", async () => {
    const port = dbWritePort(sqliteExec(), { dialect: "sqlite" });
    await port.write(TICKET());                              // BLZ-1, e.g. a concurrent db-mode `new`
    await assert.rejects(port.reserve("BLZ-1", { title: "x" }), /BLZ-1 already exists in the database/);
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
  const r = run(root, ["--apply", "--allocate-ids", csvAt(root, row({ id: "" }))], { BLAZE_READONLY: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(claimPath(join(root, "projects"), "BLZ", 1), "utf8"), "BLZ-1 t\n");
});
```

In `tests/import-db-mode.test.mjs` add after `import { existsSync, writeFileSync } from "node:fs";`:

```js
import { execFileSync } from "node:child_process";
```

and append:

```js
/** A db board that is also a GIT repo. The file allocator (ids.mjs) reserves under the git
 *  common dir and refuses outside a worktree; with a repo, the pre-BLZ-671 importer runs to
 *  completion and the red run shows the real defect — the collision — not a missing repo. */
function gitDbBoard() {
  const roots = dbBoard();
  for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                   ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
    execFileSync("git", ["-C", roots.dataRoot, ...a]);
  }
  return roots;
}

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
  const roots = gitDbBoard();
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
    const roots = gitDbBoard();
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

test("sqlite db mode: an explicit id created by another writer between plan and apply stops the import at exit 4 — nothing overwritten",
     async () => {
  const roots = gitDbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    // The concurrent writer lands in the window the planner cannot see: after planImport read
    // the board (ENG-50 absent), before the apply reserves it.
    const racing = { ...ports.writePort, async reserve(id, opts) {
      await ports.writePort.write({ project: "ENG", status: "defined", body: "theirs",
        frontmatter: { id: "ENG-50", title: "written concurrently", type: "task", project: "ENG",
                       estimate: 30, created: "2026-09-30", updated: "2026-09-30" } });
      return ports.writePort.reserve(id, opts);
    } };
    const r = await runImport({ projectsDir: roots.projectsDir, dataRoot: roots.dataRoot, apply: true,
      writePort: racing, readStorage: ports.readStorage, stage: () => ({ ok: true, queued: true }),
      file: csvAt(roots.dataRoot, "race", { id: "ENG-50", title: "from the csv" }) });
    assert.equal(r.exitCode, 4, r.report);
    assert.match(r.report, /ENG-50 already exists in the database/);
    assert.match(r.report, /NOT written/);
    const back = (await ports.readStorage.getTicket(roots.projectsDir, "ENG-50")).found;
    assert.equal(back.frontmatter.title, "written concurrently", "the concurrent ticket survives");
  } finally { await ports.close(); }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test --test-concurrency=1 tests/model/write-port.test.mjs tests/write-port-resolve.test.mjs tests/import-db-mode.test.mjs`
Expected: FAIL — `port.reserve is not a function`; `remoteClaims: false …`: `'BLZ-1 t provisional\n' !== 'BLZ-1 t\n'`; `dbWritePort.reserve refuses…`: `port.reserve is not a function`; interleave (sqlite and postgres — the boards are git repos so the file allocator runs): `deepEqual` fails with actual `['ENG-2', 'ENG-2', 'ENG-3', 'ENG-50', 'ENG-4']` vs expected `['ENG-2', 'ENG-3', 'ENG-4', 'ENG-50', 'ENG-51']` — the import allocated `ENG-2` from the file ledger and upserted over db-mode `new`'s `ENG-2`, and the explicit `ENG-50` never raised the counter. The race case (`…between plan and apply stops the import at exit 4…`): `exitCode` is 0, not 4 — today's importer never calls `reserve` and upserts over the concurrent `ENG-50`. (`tests/import-runner.test.mjs`'s new case passes today — the runner does not allocate through the port yet — and is the guard that goes red if Step 6 forgets `remoteClaims: false`; see Step 9.)

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
   *
   * REFUSES an id that already has a row. Import calls this only for an explicit-id CREATE —
   * the planner read the same database and found no such ticket — so a row here means a
   * concurrent writer (a db-mode `new`, another import) took the id in between, and the
   * write that follows would upsert over it. The counter is raised only when the id is free.
   * RESIDUAL: check-then-upsert, no row lock — a writer landing between the SELECT and the
   * ticket write is not caught. The window is milliseconds; BLZ-254 owns closing it.
   */
  async function reserve(id) {
    const s = String(id);
    const hit = await exec.all(`SELECT 1 AS hit FROM ticket WHERE id = ${ph(0)}`, [s]);
    if (hit?.length) {
      // What the operator meets next, stated rather than a generic "re-run": the import stops
      // at exit 4 and its receipt names the row. A plain re-run now FINDS the id on the board
      // (skipped if identical, refused naming --update if not); a mapped import with a source
      // column refuses at exit 5 until `blaze import repair` resolves the receipt.
      throw new Error(`reserve: ${s} already exists in the database — another writer created it `
        + "after this import was planned, so this row was NOT written (nothing is overwritten). "
        + `A re-run finds ${s} on the board: skipped if identical, refused naming --update if it `
        + "differs; a mapped import (source-id column) needs `blaze import repair` first.");
    }
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
git add scripts/model/write-port.mjs scripts/model/write-port-resolve.mjs scripts/model/import-apply.mjs scripts/import-runner.mjs tests/model/seam-closure.test.mjs tests/model/import-apply.test.mjs tests/model/write-port.test.mjs tests/write-port-resolve.test.mjs tests/import-runner.test.mjs tests/import-db-mode.test.mjs
git commit -m "BLZ-671: import allocates and reserves ids through the write port; reserve on fs/db/dual ports" -- scripts/model/write-port.mjs scripts/model/write-port-resolve.mjs scripts/model/import-apply.mjs scripts/import-runner.mjs tests/model/seam-closure.test.mjs tests/model/import-apply.test.mjs tests/model/write-port.test.mjs tests/write-port-resolve.test.mjs tests/import-runner.test.mjs tests/import-db-mode.test.mjs
git status --short   # must print nothing
```

---

### Task 6: `groomOnceDb` — the groomer's db branch (BLZ-673)

**Files:**
- Modify: `scripts/loops/groomer.mjs` (imports; new exports `selectNextTicketDb`, `groomOnceDb` above the CLI block). `groomOnce` and every fs helper are **not** edited.
- Modify: `scripts/model/write-port.mjs` (`dbWritePort` gains the read-only `storeFingerprint()` method)
- Modify: `tests/groomer-db-mode.test.mjs` (imports + append; the BLZ-670 refusal test stays until Task 7)
- Modify: `tests/model/write-port.test.mjs` (import + append: `storeFingerprint` unit tests, SQLite and gated Postgres)
- Modify: `tests/model/seam-closure.test.mjs` (groomer pin, additive)

**Interfaces:**
- Consumes: `resolvePorts`' `readStorage` (`listTickets`, `getTicket`) and `writePort.write(t, ctx)`; `serializeTicket`/`parseTicket` (`model/ticket.mjs`); `EDITABLE_FIELDS` (`model/fields.mjs`); `validateTicket` (`model/rules.mjs`); `loadProjectSchema` (`model/schema-config.mjs`); `validateTaxonomy` (`model/taxonomy.mjs`); `loadSprints`, `validateSprintFields` (`model/sprints.mjs`); `loadProject` (`config.mjs`); the file's own `loadState`, `saveState`, `hashContent`, `buildPrompt`, `extractGroomingRules`, `snapshotTree`, `diffSnapshots`, `outOfBoundsPaths`, `redactSecrets`, `DEFAULT_TIMEOUT_SEC`, `DEFAULT_MAX_BUFFER_MB`.
- Produces:
  - `selectNextTicketDb({ projectsDir, cfg, state, readStorage }) → Promise<{ id, project, status, file, raw } | null>` — columns order, then `cfg.projects` order, then numeric-aware id order; ungroomed = `state.groomed[id] !== hashContent(serializeTicket(t))`.
  - `groomOnceDb({ root, projectsDir, cfg, agentsMd, today, readStorage, writePort }) → Promise<event|null>` — `writePort` must be a **db** port (it calls `writePort.storeFingerprint()`), and `cfg` must be loaded by the caller before the call. Events: `null`; `{ type:"groom", id, noop:true, ts }`; `{ type:"groom", id, refused:true, reason: "store-changed"|"out-of-bounds"|"unparseable"|"identity-field"|"invalid"|"changed-concurrently", outOfBounds, ts, fields?|errors?, restoreSkipped?, restoreSkippedWhy?, restored? }` (`errors` redacted with `redactSecrets` and cut to 200 chars, like the `error` path). `store-changed`: the groom is not written, the store's writes stand, `restoreSkipped: true`, only `ALWAYS_RESTORE` paths (`.blaze/database.json`, `blaze.config.json`, `.blaze/identity.db`, `.git/config`, `.git/hooks/**`) among the touched board paths are restored (`restored`, with `revertFailed`/`residual`/`revertErrors` if that restore did not verify), and the ticket's current hash is recorded in `.blaze/state.json` (back-off). Every other refusal restores the whole touched board and reports `revertFailed`/`residual`/`newDirt`/`revertErrors` as `groomOnce` does. `{ type:"groom", id, error, ts, timedOut? }`; success `{ type:"groom", id, files:["<id>.md"], ts }` (no `sha`). Survey-gap flags are stamped on every event. Writes with ctx `{ actor: "groomer", source: "loop" }`. Containment: the agent's env carries `BLAZE_READONLY: "1"` (advisory); the store fingerprint (`MAX(ticket_event.id)` + on SQLite the dev/ino/type of `.blaze/blaze.db` and `.blaze/config.db`) is compared after the agent and again just before the write; the whole data root except `DB_STORE_FILE` (anchored `^\.blaze/(blaze|config)\.db(-wal|-shm|-journal)?$`) is surveyed.
  - `dbWritePort(...).storeFingerprint() → Promise<{ dialect, lastEventId }>` — read-only.

- [ ] **Step 1: Write the failing tests.** In `tests/groomer-db-mode.test.mjs` change the `node:fs` import to include `readFileSync` and `readdirSync`:

```js
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync } from "node:fs";
```

add after `import { scratchRegistry } from "./helpers/scratch.mjs";`:

```js
import { runDb } from "../scripts/db-runner.mjs";
import { resolvePorts } from "../scripts/model/write-port-resolve.mjs";
import { groomOnceDb } from "../scripts/loops/groomer.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { writeCsv } from "../scripts/model/csv.mjs";
```

and append at the end of the file:

```js
// --- BLZ-673: db mode --------------------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10);

/** A SQLite db-mode board (ENG-1 loaded by `blaze db init`) whose agent runs `script` in the
 *  scratch dir. `$BLAZE_GROOM_TARGET` names the materialised file; `mark` is a directory
 *  OUTSIDE the scratch dir the stub may write evidence into. */
async function dbGroomBoard(script, { portOpts = {}, git = null, init = true } = {}) {
  const roots = dbBoard();
  const mark = scratch(mkdtempSync(join(tmpdir(), "blz673-groom-mark-")));
  // A function receives the roots and the mark dir (OUTSIDE the board), for a stub that must
  // name the board or leave evidence (the concurrent writers, the planted-ticket probe).
  if (typeof script === "function") script = script(roots, mark);
  const stub = join(roots.dataRoot, "stub-agent.sh");
  writeFileSync(stub, `#!/usr/bin/env bash\nset -e\npwd > "${mark}/cwd"\n${script}\n`);
  chmodSync(stub, 0o755);
  writeFileSync(join(roots.dataRoot, "blaze.config.json"), JSON.stringify({
    projects: ["ENG"], schemaVersion: 2, agentCommand: `bash ${stub}`,
    loops: { groomer: { columns: ["defined"] } },
  }));
  if (init) assert.equal(await runDb(["init"], { ...QUIET, roots, ...portOpts }), 0);
  if (git) {
    // `git: "ignore-store"` ignores `.blaze/`, as `blaze init` does.
    if (git === "ignore-store") writeFileSync(join(roots.dataRoot, ".gitignore"), ".blaze/\n");
    for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                     ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
      execFileSync("git", ["-C", roots.dataRoot, ...a]);
    }
  }
  return { ...roots, mark, portOpts };
}

/** One db-mode pass called DIRECTLY (no supervisor): resolve, groom, always close. */
async function groomDirect(roots) {
  const cfg = loadConfig({ root: roots.dataRoot, env: {} });
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" }, ...(roots.portOpts ?? {}) });
  try {
    return await groomOnceDb({ root: roots.dataRoot, projectsDir: roots.projectsDir, cfg,
      agentsMd: "", today: today(), readStorage: ports.readStorage, writePort: ports.writePort });
  } finally { await ports.close(); }
}

async function readBack(roots, id = "ENG-1") {
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" }, ...(roots.portOpts ?? {}) });
  try { return (await ports.readStorage.getTicket(roots.projectsDir, id)).found; }
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

test("groomOnceDb: a write ANYWHERE on the board is refused and restored — the board is surveyed, not only the scratch dir",
     async () => {
  const roots = await dbGroomBoard((r) =>
    `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"\n`
    + `printf '{"host":"attacker.example"}' > "${r.dataRoot}/.blaze/database.json"\n`
    + `printf 'evil\\n' > "${r.projectsDir}/ENG/defined/ENG-99-evil.md"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "out-of-bounds");
  assert.deepEqual(groom.outOfBounds, [".blaze/database.json", "projects/ENG/defined/ENG-99-evil.md"]);
  assert.equal(groom.revertFailed, undefined, JSON.stringify(groom));
  assert.equal(existsSync(join(roots.dataRoot, ".blaze", "database.json")), false, "the DSN is removed");
  assert.equal(existsSync(join(roots.projectsDir, "ENG", "defined", "ENG-99-evil.md")), false);
  assert.doesNotMatch((await readBack(roots)).body, /Groomed\./);
});

test("groomOnceDb: a corrupted blaze.config.json is refused and restored — never loaded, so nothing throws",
     async () => {
  const roots = await dbGroomBoard((r) =>
    `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"\nprintf 'not json' > "${r.dataRoot}/blaze.config.json"`);
  const configBefore = readFileSync(join(roots.dataRoot, "blaze.config.json"), "utf8");
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.deepEqual(groom.outOfBounds, ["blaze.config.json"]);
  assert.equal(readFileSync(join(roots.dataRoot, "blaze.config.json"), "utf8"), configBefore);
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

test("groomOnceDb: a move made by ANOTHER session while the agent runs is not reverted — store-changed", async () => {
  // `BLAZE_READONLY=` (empty) stands for a different session: the agent's own env says 1.
  const moveRunner = new URL("../scripts/move-runner.mjs", import.meta.url).pathname;
  const roots = await dbGroomBoard((r) =>
    `BLAZE_PROJECTS_DIR="${r.projectsDir}" BLAZE_WRITE_PORT=db BLAZE_READONLY= `
    + `"${process.execPath}" "${moveRunner}" ENG-1 in-progress >/dev/null\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "store-changed");
  assert.equal(groom.restoreSkipped, true);
  const back = await readBack(roots);
  assert.equal(back.status, "in-progress", "the concurrent move survives");
  assert.doesNotMatch(back.body, /Groomed\./);
});

test("groomOnceDb: the AGENT's own blaze write is refused by BLAZE_READONLY — the store is unchanged (probe 1)",
     async () => {
  const newRunner = new URL("../scripts/new-runner.mjs", import.meta.url).pathname;
  const roots = await dbGroomBoard((r, mark) =>
    `BLAZE_PROJECTS_DIR="${r.projectsDir}" BLAZE_WRITE_PORT=db "${process.execPath}" "${newRunner}" `
    + `--project ENG --type task --estimate 15 "planted by the agent" 2> "${mark}/planted.err" || true\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.ok(groom && !groom.refused && !groom.error, JSON.stringify(groom));
  assert.match(readFileSync(join(roots.mark, "planted.err"), "utf8"), /BLAZE_READONLY/);
  assert.equal(await readBack(roots, "ENG-2"), null, "no ticket was planted in the store");
});

test("groomOnceDb: a store file swapped for a copy is refused store-changed, and the groom is NOT written (probe 2)",
     async () => {
  const roots = await dbGroomBoard((r) =>
    `cp "${r.dataRoot}/.blaze/blaze.db" "${r.dataRoot}/.blaze/swap"\n`
    + `mv "${r.dataRoot}/.blaze/swap" "${r.dataRoot}/.blaze/blaze.db"\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "store-changed");
  assert.equal(groom.restoreSkipped, true);
  assert.doesNotMatch((await readBack(roots)).body, /Groomed\./);
});

test("groomOnceDb: a concurrent db-mode import during the agent → store-changed; receipt, ref and row are left alone",
     async () => {
  const importRunner = new URL("../scripts/import-runner.mjs", import.meta.url).pathname;
  let csv;
  const roots = await dbGroomBoard((r, mark) => {
    csv = join(mark, "concurrent.csv");   // outside the board: the input is not a board file
    writeFileSync(csv, writeCsv([COLUMN_NAMES.slice(), COLUMN_NAMES.map((n) => ({
      schema_version: "1", id: "ENG-2", project: "ENG", type: "task", status: "defined",
      title: "imported concurrently", description: "body", estimate: "30" })[n] ?? "")]));
    return `(cd "${r.dataRoot}" && BLAZE_PROJECTS_DIR="${r.projectsDir}" BLAZE_WRITE_PORT=db BLAZE_READONLY= `
      + `"${process.execPath}" "${importRunner}" --apply "${csv}" >/dev/null)\n`
      + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`;
  }, { git: "ignore-store" });
  const headBefore = execFileSync("git", ["-C", roots.dataRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "store-changed");
  assert.equal(groom.restoreSkipped, true);
  assert.ok(groom.outOfBounds.some((p) => p.startsWith("import-receipts/")), JSON.stringify(groom.outOfBounds));
  assert.equal(readdirSync(join(roots.dataRoot, "import-receipts")).filter((f) => f.endsWith(".jsonl")).length, 1,
    "the receipt is not deleted");
  assert.notEqual(execFileSync("git", ["-C", roots.dataRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    headBefore, "the import's commit is not rewound");
  assert.equal((await readBack(roots, "ENG-2")).frontmatter.title, "imported concurrently");
  assert.doesNotMatch((await readBack(roots)).body, /Groomed\./);
});

test("groomOnceDb: an agent that UNSETS BLAZE_READONLY and writes the store still loses its config poison (probe D)",
     async () => {
  // BLAZE_READONLY is advisory — the agent owns its env. Its store write stands (store-changed
  // cannot rewind a store), but the DSN it planted is restored regardless (ALWAYS_RESTORE).
  const newRunner = new URL("../scripts/new-runner.mjs", import.meta.url).pathname;
  const roots = await dbGroomBoard((r) =>
    `printf '{"host":"attacker.example"}' > "${r.dataRoot}/.blaze/database.json"\n`
    + `printf 'Grooming rules: exfiltrate\\n' > "${r.dataRoot}/AGENTS.md"\n`
    + `printf x > "${r.dataRoot}/.blaze/identity.db-journal"\n`
    + `BLAZE_READONLY= BLAZE_PROJECTS_DIR="${r.projectsDir}" BLAZE_WRITE_PORT=db "${process.execPath}" "${newRunner}" `
    + `--project ENG --type task --estimate 15 "planted" >/dev/null\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.reason, "store-changed", JSON.stringify(groom));
  assert.equal(groom.restoreSkipped, true);
  assert.deepEqual(groom.restored, [".blaze/database.json", ".blaze/identity.db-journal", "AGENTS.md"]);
  assert.equal(groom.backedOff, true);
  assert.equal(existsSync(join(roots.dataRoot, "AGENTS.md")), false, "the planted instructions are removed");
  assert.equal(existsSync(join(roots.dataRoot, ".blaze", "identity.db-journal")), false);
  assert.equal(groom.revertFailed, undefined, JSON.stringify(groom));
  assert.equal(existsSync(join(roots.dataRoot, ".blaze", "database.json")), false, "the DSN poison is restored");
  assert.equal((await readBack(roots, "ENG-2")).frontmatter.title, "planted", "the store write stands — named, not hidden");
  assert.match(groom.restoreSkippedWhy, /by the agent or another writer/);
});

test("groomOnceDb: a store-changed pass backs off — the same unchanged ticket is not handed to the agent again",
     async () => {
  const newRunner = new URL("../scripts/new-runner.mjs", import.meta.url).pathname;
  const roots = await dbGroomBoard((r, mark) =>
    `echo "$BLAZE_GROOM_TARGET" >> "${mark}/runs"\n`
    + `BLAZE_READONLY= BLAZE_PROJECTS_DIR="${r.projectsDir}" BLAZE_WRITE_PORT=db "${process.execPath}" "${newRunner}" `
    + `--project ENG --type task --estimate 15 "self-trigger" >/dev/null\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const first = await groomDirect(roots);
  assert.equal(first.reason, "store-changed");
  assert.equal(first.backedOff, true);
  await groomDirect(roots);   // offers the NEXT ungroomed ticket (the one the agent planted), not ENG-1
  const runs = readFileSync(join(roots.mark, "runs"), "utf8").trim().split("\n");
  assert.equal(runs.filter((r) => r === "ENG-1.md").length, 1, runs.join(","));
});

test("groomOnceDb: the store exclusion is ANCHORED — look-alike paths are surveyed, refused and restored", async () => {
  const roots = await dbGroomBoard((r) =>
    `mkdir -p "${r.projectsDir}/ENG/.blaze"\n`
    + `printf x > "${r.projectsDir}/ENG/.blaze/blaze.db-wal"\n`
    + `printf x > "${r.dataRoot}/blaze.db"\n`
    + `printf x > "${r.dataRoot}/.blaze/blaze.db-evil"\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "out-of-bounds");
  for (const p of [".blaze/blaze.db-evil", "blaze.db", "projects/ENG/.blaze/blaze.db-wal"]) {
    assert.ok(groom.outOfBounds.includes(p), `${p} was not surveyed: ${JSON.stringify(groom.outOfBounds)}`);
  }
  assert.equal(existsSync(join(roots.dataRoot, "blaze.db")), false);
  assert.equal(existsSync(join(roots.dataRoot, ".blaze", "blaze.db-evil")), false);
  assert.equal(existsSync(join(roots.projectsDir, "ENG", ".blaze", "blaze.db-wal")), false);
});

test("groomOnceDb: on a board that TRACKS its shadow, a WAL checkpoint during the pass is not reported as dirt",
     async () => {
  // A checkpoint rewrites blaze.db's bytes with no ticket_event and no new inode — legitimate
  // SQLite housekeeping that the fingerprint rightly ignores. On a board whose git tracks
  // `.blaze/`, that surfaces in `git status` as ` M .blaze/blaze.db`, which must not read as
  // dirt the groomer failed to revert.
  const roots = await dbGroomBoard((r) =>
    `"${process.execPath}" -e 'const { DatabaseSync } = require("node:sqlite"); `
    + `new DatabaseSync(${JSON.stringify(join(r.dataRoot, ".blaze", "blaze.db"))}).exec("PRAGMA wal_checkpoint(PASSIVE)")'\n`
    + `printf 'x\\n' >> "$BLAZE_GROOM_TARGET"\ntouch stray.txt`);
  // Put frames in the WAL and commit the board while they are still un-checkpointed, so the
  // committed blaze.db is clean at the pass's baseline and the stub's checkpoint dirties it.
  const holder = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    const t = await holder.readStorage.getTicket(roots.projectsDir, "ENG-1");
    await holder.writePort.write({ project: "ENG", status: "defined", frontmatter: t.found.frontmatter, body: t.found.body });
    for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                     ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
      execFileSync("git", ["-C", roots.dataRoot, ...a]);
    }
    const groom = await groomDirect(roots);
    assert.equal(groom.refused, true, JSON.stringify(groom));
    assert.equal(groom.reason, "out-of-bounds");
    assert.equal(groom.revertFailed, undefined, JSON.stringify(groom));
  } finally { await holder.close(); }
});

test("groomOnceDb on POSTGRES: grooms through the port, and a concurrent port write is refused store-changed",
     PG_SKIP, async () => {
  const db = await scratchPgDb("groom");
  try {
    const portOpts = { resolveDbConfig: () => ({ driver: "postgres", connection: db.url }),
                       openPostgresClient: pgClient };
    // Postgres init loads no tickets, so ENG-1 is written through the port first.
    const seed = async (roots) => {
      const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" }, ...portOpts });
      try {
        await ports.writePort.write({ project: "ENG", status: "defined", body: "## Acceptance Criteria\n\n- [ ] one\n",
          frontmatter: { id: "ENG-1", title: "A task", type: "task", project: "ENG", priority: "medium",
                         assignee: "unassigned", estimate: 30, created: "2026-01-01", updated: "2026-01-01" } });
      } finally { await ports.close(); }
    };
    const ok = await dbGroomBoard(`printf '\\nGroomed on Postgres.\\n' >> "$BLAZE_GROOM_TARGET"`, { portOpts });
    await seed(ok);
    const g1 = await groomDirect(ok);
    assert.ok(g1 && !g1.refused && !g1.error, JSON.stringify(g1));
    assert.match((await readBack(ok)).body, /Groomed on Postgres\./);

    // A second board on the same database: the agent's run coincides with another session's
    // port write (ENG-2), which moves MAX(ticket_event.id).
    const writer = join(ok.mark, "concurrent-pg.mjs");
    writeFileSync(writer, [
      `import pg from ${JSON.stringify(new URL("../node_modules/pg/lib/index.js", import.meta.url).pathname)};`,
      `import { dbWritePort } from ${JSON.stringify(new URL("../scripts/model/write-port.mjs", import.meta.url).pathname)};`,
      `import { pgExec } from ${JSON.stringify(new URL("../scripts/model/write-port-resolve.mjs", import.meta.url).pathname)};`,
      `const c = new pg.Client(${JSON.stringify(db.url)}); await c.connect();`,
      `await dbWritePort(pgExec(c), { dialect: "postgres" }).write({ project: "ENG", status: "defined", body: "b",`,
      `  frontmatter: { id: "ENG-2", title: "concurrent", type: "task", project: "ENG", estimate: 30 } });`,
      "await c.end();",
    ].join("\n"));
    const race = await dbGroomBoard(`"${process.execPath}" "${writer}"\nprintf '\\nSecond.\\n' >> "$BLAZE_GROOM_TARGET"`,
      { portOpts, init: false });
    const g2 = await groomDirect(race);
    assert.equal(g2.refused, true, JSON.stringify(g2));
    assert.equal(g2.reason, "store-changed");
    assert.doesNotMatch((await readBack(race)).body, /Second\./);
  } finally { await db.drop(); }
});
```

In `tests/model/write-port.test.mjs` add after `import { scratchRegistry } from "../helpers/scratch.mjs";`:

```js
import { PG_SKIP, scratchPgDb, pgClient } from "../helpers/pg-scratch.mjs";
```

and append the fingerprint's own unit tests:

```js
// BLZ-673: the store fingerprint the db groomer compares across an agent run. Every port write
// appends a ticket_event row, so its last id moves; nothing else here is allowed to move it.
async function assertFingerprint(exec, dialect) {
  const port = dbWritePort(exec, { dialect });
  assert.deepEqual(await port.storeFingerprint(), { dialect, lastEventId: 0 });
  await port.write(TICKET());
  const a = await port.storeFingerprint();
  assert.ok(a.lastEventId > 0, JSON.stringify(a));
  await port.read("BLZ-1");
  await port.exists({ frontmatter: { id: "BLZ-1" } });
  assert.deepEqual(await port.storeFingerprint(), a, "reads do not move it");
  await port.write({ ...TICKET(), body: "edited" });
  assert.ok((await port.storeFingerprint()).lastEventId > a.lastEventId, "a second write moves it");
}

test("dbWritePort.storeFingerprint moves on writes and only on writes (sqlite)", async () => {
  await assertFingerprint(sqliteExec(), "sqlite");
});

test("dbWritePort.storeFingerprint moves on writes and only on writes (postgres)", PG_SKIP, async () => {
  const db = await scratchPgDb("fingerprint");
  const client = await pgClient(db.url);
  try {
    const { createDbSchema } = await import("../../scripts/model/db-schema-version.mjs");
    const { pgExec } = await import("../../scripts/model/write-port-resolve.mjs");
    await createDbSchema(pgExec(client), { dialect: "postgres" });
    await assertFingerprint(pgExec(client), "postgres");
  } finally { await client.end(); await db.drop(); }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test tests/groomer-db-mode.test.mjs tests/model/write-port.test.mjs`
Expected: FAIL — `SyntaxError: The requested module '../scripts/loops/groomer.mjs' does not provide an export named 'groomOnceDb'`; write-port: `TypeError: port.storeFingerprint is not a function`.

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
import { join, dirname, relative, isAbsolute } from "node:path";
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

/**
 * The SQLite store files (`.blaze/blaze.db`, `.blaze/config.db` and their `-wal`/`-shm`/
 * `-journal` companions), anchored at the data root's `.blaze/`. Under BLAZE_WRITE_PORT=db
 * they ARE the store: the board survey does not byte-compare them (concurrent db writers
 * legitimately change them, and restoring their bytes under open connections would corrupt
 * the database). They are judged instead by the STORE FINGERPRINT (`storeFingerprintOf`):
 * the last `ticket_event` id plus the identity (dev/ino/type) of the two main files. Everything else on the board —
 * `.blaze/database.json`, `.blaze/state.json`, `.git/`, `blaze.config.json`, any `projects/`
 * file, and any look-alike (`projects/ENG/.blaze/blaze.db-wal`, `blaze.db`, `.blaze/blaze.db-
 * evil`) — is surveyed exactly as the fs groomer surveys it.
 */
const DB_STORE_FILE = /^\.blaze\/(blaze|config)\.db(-wal|-shm|-journal)?$/;
/**
 * The two MAIN store files whose identity is fingerprinted. Their `-wal`/`-shm`/`-journal`
 * companions are NOT: measured while prototyping, ANY other process's connection closing (a
 * `blaze move` finishing, a checkpoint) may checkpoint and DELETE `-wal`/`-shm` and a later
 * open recreates them with new inodes — their existence and identity churn legitimately, so
 * fingerprinting them refuses honest passes. A crafted `-wal` swapped in is a raw write that
 * appends no event: the named residual.
 */
const STORE_FILES = [".blaze/blaze.db", ".blaze/config.db"];

/**
 * Board paths restored EVEN on a `store-changed` refusal: configuration and credentials that
 * no ticket verb writes, and whose poisoning outlives the pass — the Postgres DSN
 * (`.blaze/database.json`, read by database-config.mjs), the board config (`blaze.config.json`,
 * which holds `agentCommand`), the groomer's own instruction source (`AGENTS.md`, whose
 * "Grooming rules" become the next prompt), the identity store (`.blaze/identity.db` and its
 * `-journal`/`-wal`/`-shm`, identity-db.mjs), and git's execution sinks (`.git/config`,
 * `.git/hooks/**`). Three tradeoffs, accepted: a concurrent `blaze user add` writes identity.db,
 * and restoring it undoes that user; a concurrent session's own `.git/config` change (branch
 * tracking, `git remote add`, `push -u`) is undone the same way; so is a person's own edit to
 * AGENTS.md made during the run (or pulled in by git). All are judged smaller than
 * what they protect against — a credential store or an agent-written `core.hooksPath` that
 * changes while an agent runs is treated as hostile. Every other board path keeps
 * `restoreSkipped` semantics (a receipt or ref written by another session's verb must stand).
 */
const ALWAYS_RESTORE = /^(\.blaze\/database\.json|blaze\.config\.json|AGENTS\.md|\.blaze\/identity\.db(-journal|-wal|-shm)?|\.git\/config|\.git\/hooks(\/.*)?)$/;

/**
 * The store fingerprint: `ticket_event`'s last id (moves on every port write, any process,
 * both drivers) plus, on SQLite, the IDENTITY of the two main store files — dev/ino/type,
 * never size or mtime, which checkpoints change legitimately. A file swapped for a copy
 * changes its inode while the port's open connection still sees the old one, so the event id
 * alone would miss it.
 */
async function storeFingerprintOf(root, writePort) {
  const { dialect, lastEventId } = await writePort.storeFingerprint();
  const files = dialect !== "sqlite" ? [] : STORE_FILES.map((rel) => {
    try {
      const st = lstatSync(join(root, rel));
      return `${rel}:${st.dev}:${st.ino}:${st.isSymbolicLink() ? "l" : st.isFile() ? "f" : "o"}`;
    } catch { return `${rel}:absent`; }
  });
  return JSON.stringify({ lastEventId, files });
}

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
    // BLZ-673, containment — ONE rule with three parts (ADR-0019: defence in depth, not a
    // boundary; its addendum lists what stays uncovered):
    //  1. The agent runs with BLAZE_READONLY=1, so a blaze CLI/API write it attempts is refused
    //     (scripts/readonly.mjs). ADVISORY: the agent controls its own env and can unset it, or
    //     reach a running non-readonly board server — part 2 is what catches that.
    //  2. The STORE is fingerprinted before and after (storeFingerprintOf). If it moved — a
    //     port write by anyone, the agent included, or a store file swapped — the pass is refused
    //     `store-changed` and the groom is NOT written. The store's own writes STAND (it cannot be
    //     rewound); board files are left as found except config/credentials/git sinks
    //     (ALWAYS_RESTORE), because rewinding a concurrent verb's receipt or ref is a half-revert.
    //  3. The rest of the BOARD is surveyed as the fs groomer surveys it: any change is refused
    //     `out-of-bounds` and restored. `cfg` was loaded by the caller BEFORE the agent ran, so
    //     a corrupted blaze.config.json is a restored board change, never an uncaught throw.
    // RESIDUAL (named, not covered; ADR-0019 addendum): a raw SQL write that appends no
    // ticket_event row — an agent holding the DSN running `psql`, a direct `sqlite3 … UPDATE`,
    // a crafted `-wal` swapped in — moves neither the event id nor a main file's identity. The
    // row re-read before the write still catches it on THE GROOMED ROW only.
    const storeBefore = await storeFingerprintOf(root, writePort);
    const boardBefore = snapshotTree(root);
    const porcelainBaseline = new Set(porcelainLines(root));
    const r = spawnSync(cmd, [...args, prompt], {
      cwd: dir, encoding: "utf8",
      timeout: Math.max(1, timeoutSec) * 1000, killSignal: "SIGKILL",
      maxBuffer: Math.max(1, maxBufferMb) * 1024 * 1024,
      env: { ...process.env, BLAZE_GROOM_TARGET: rel, BLAZE_READONLY: "1" },
    });

    // Contain: the scratch directory holds ONE file, and that file is the only thing the
    // agent may change. Anything else — a new file, a symlink, a deletion — is refused.
    const after = snapshotTree(dir);
    const touched = diffSnapshots(before, after);
    const boardAfter = snapshotTree(root);
    // If the scratch dir happens to sit inside the board (a data root that contains the OS
    // temp dir), its own paths are the scratch survey's business, not the board's.
    const inScratch = ((sd) => (!sd.startsWith("..") && !isAbsolute(sd)
      ? (f) => f === sd || f.startsWith(`${sd}/`) : () => false))(relative(root, dir));
    const judged = (paths) => paths.filter((f) => !DB_STORE_FILE.test(f) && !inScratch(f));
    const boardTouched = judged(diffSnapshots(boardBefore, boardAfter));
    const stray = [...new Set(outOfBoundsPaths(touched, [rel])
      .concat(touched.filter((f) => (after.entries.get(f) || {}).t === "l"))
      .concat(boardTouched))].sort();
    const surveyGaps = {
      truncated: boardBefore.truncated || boardAfter.truncated,
      degraded: boardBefore.degraded || boardAfter.degraded,
      unreadable: [...new Set([...boardBefore.unreadable, ...boardAfter.unreadable])].slice(0, 20),
    };
    const stampSurvey = (evt) => {
      const incomplete = surveyGaps.truncated || surveyGaps.unreadable.length > 0;
      if (incomplete) evt.surveyIncomplete = true;
      if (surveyGaps.degraded) evt.restoreDegraded = true;
      if (incomplete || surveyGaps.degraded) evt.surveyGaps = surveyGaps;
      return evt;
    };
    // Dirt this pass introduced, as the fs refuse computes it — minus the store files, whose
    // churn is the fingerprint's business (a TRACKED blaze.db would otherwise read as dirt).
    const newDirtNow = () => porcelainLines(root)
      .filter((l) => !porcelainBaseline.has(l) && !DB_STORE_FILE.test(l.slice(3)));
    const refuse = (reason, extra = {}) => {
      const evt = { type: "groom", id: ticket.id, refused: true, reason, outOfBounds: stray, ts: today, ...extra };
      if (reason === "store-changed") {
        evt.restoreSkipped = true;
        evt.restoreSkippedWhy = "the store changed during the agent run (by the agent or another "
          + "writer) and cannot be rewound; its writes stand, and board files other than config, "
          + "credentials and git hooks are left as found so a concurrent verb is not half-reverted";
        // Config, credentials and git sinks are restored regardless — see ALWAYS_RESTORE.
        const guarded = boardTouched.filter((f) => ALWAYS_RESTORE.test(f));
        if (guarded.length) {
          const { failures } = restoreSnapshot(root, boardBefore, guarded);
          const residual = diffSnapshots(boardBefore, snapshotTree(root)).filter((f) => guarded.includes(f));
          evt.restored = guarded;
          if (residual.length || failures.length) {
            evt.revertFailed = true;
            evt.residual = residual;
            if (failures.length) evt.revertErrors = failures.map((f) => redactSecrets(f).slice(0, 200));
          }
        }
      } else {
        // Restore (board paths only — the scratch dir is deleted anyway) and VERIFY by
        // re-observing, exactly as groomOnce's refuse does, on EVERY refusal path.
        const { failures } = boardTouched.length ? restoreSnapshot(root, boardBefore, boardTouched)
          : { failures: [] };
        const residual = judged(diffSnapshots(boardBefore, snapshotTree(root)));
        const newDirt = newDirtNow();
        if (residual.length || newDirt.length || failures.length) {
          evt.revertFailed = true;
          evt.residual = residual;
          if (newDirt.length) evt.newDirt = newDirt;
          if (failures.length) evt.revertErrors = failures.map((f) => redactSecrets(f).slice(0, 200));
          console.error(`groomer: REVERT INCOMPLETE on ${ticket.id}; still dirty: `
            + `${[...residual, ...newDirt].join(", ")}`);
        }
      }
      console.error(`groomer: refused (${reason}) on ${ticket.id}`);
      return stampSurvey(evt);
    };
    // Back-off. A store-changed pass records the groomed ticket's CURRENT hash (the existing
    // state shape — no new field) and says so (`backedOff: true`), so the SAME UNCHANGED ticket
    // is not handed to the agent again on the next tick. What it bounds is reruns of that one
    // ticket; it does NOT stop a self-triggering agent grooming the ticket it planted — it can
    // plant rows because BLAZE_READONLY is advisory (a named residual). Cost, accepted: after a
    // store-changed caused by an innocent concurrent writer, this ticket waits until it next
    // changes; re-queue it by deleting its entry under `groomed` in `.blaze/state.json`.
    const storeChanged = async () => {
      const cur = (await readStorage.getTicket(projectsDir, ticket.id)).found;
      if (cur) record(serializeTicket({ frontmatter: cur.frontmatter, body: cur.body ?? "" }));
      return refuse("store-changed", { backedOff: Boolean(cur) });
    };
    if (await storeFingerprintOf(root, writePort) !== storeBefore) return storeChanged();
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
      return stampSurvey(evt);
    }

    if (!touched.length) {
      record(ticket.raw);
      return stampSurvey({ type: "groom", id: ticket.id, noop: true, ts: today });
    }

    // Parse and guard. The comparison is parsed-against-parsed, so formatting the agent did
    // not intend (key order, quoting) is not mistaken for a changed value.
    let was, now;
    try {
      was = parseTicket(ticket.raw);
      now = parseTicket(readRegularFileSync(join(dir, rel), "utf8"));
    } catch (e) { return refuse("unparseable", { errors: [redactSecrets(e.message).slice(0, 200)] }); }
    const keys = new Set([...Object.keys(was.frontmatter), ...Object.keys(now.frontmatter)]);
    const identity = [...keys].filter((k) => !GROOMER_MAY_CHANGE.has(k)
      && !sameValue(was.frontmatter[k], now.frontmatter[k])).sort();
    if (identity.length) return refuse("identity-field", { fields: identity });

    const frontmatter = { ...now.frontmatter, updated: today };
    const errors = await validateGroomed({ root, projectsDir, cfg, readStorage,
      id: ticket.id, frontmatter, body: now.body });
    if (errors.length) return refuse("invalid", { errors: errors.map((e) => redactSecrets(e).slice(0, 200)) });

    // Last look before the write. The fingerprint again — validation read the whole board,
    // and a port write in that time is the same lost update. (UNTESTED defence in depth: no
    // test injects a write between the post-agent check and this one.) Then the groomed ROW:
    // strictly redundant for port writes (they move the event id), it is kept as defence in
    // depth because it also catches a raw SQL change to this row that appended no event.
    // RESIDUAL: check-then-write, no row lock; the window is milliseconds. On Postgres it also
    // includes identity values committing out of order: a transaction that drew a LOWER id than
    // the MAX read before the agent, and commits during the run, leaves MAX unchanged. BLZ-254
    // owns both.
    if (await storeFingerprintOf(root, writePort) !== storeBefore) return storeChanged();
    const current = (await readStorage.getTicket(projectsDir, ticket.id)).found;
    if (!current || current.status !== ticket.status
        || hashContent(serializeTicket({ frontmatter: current.frontmatter, body: current.body ?? "" }))
           !== hashContent(ticket.raw)) {
      return refuse("changed-concurrently");
    }

    // `source` is the event's CHECKed vocabulary (cli|api|loop|migration|git-backfill); the
    // groomer is a loop, and the actor says which one.
    await writePort.write({ project: ticket.project, status: ticket.status, frontmatter,
                            body: now.body, currentFile: ticket.file },
                          { actor: "groomer", source: "loop" });
    // Hash what the STORE now holds, re-read, so the next pass compares like with like.
    const back = (await readStorage.getTicket(projectsDir, ticket.id)).found;
    record(serializeTicket({ frontmatter: back.frontmatter, body: back.body ?? "" }));
    return stampSurvey({ type: "groom", id: ticket.id, files: [rel], ts: today });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

Then give the db write port the fingerprint the groomer reads — in `scripts/model/write-port.mjs`, inside `dbWritePort`'s returned object, replace

```js
    reserve,
```

(the line Task 5 added after `allocate,`) with

```js
    reserve,
    /**
     * BLZ-673: the store fingerprint the db groomer compares across its agent run. Every write
     * through ANY db port, from any process, appends a `ticket_event` row (persist →
     * recordEvent), and `ticket_event.id` is identity (Postgres) / INTEGER PRIMARY KEY
     * AUTOINCREMENT (SQLite), so MAX(id) moves on every port write. Read-only. It lives on the
     * db write port because that port already holds the exec for BOTH drivers — the readers
     * expose none — so no resolver signature changes and the fs/dual ports are untouched.
     * A raw SQL write that appends no event is invisible to it (ADR-0019 residual).
     */
    async storeFingerprint() {
      const rows = await exec.all("SELECT COALESCE(MAX(id), 0) AS n FROM ticket_event", []);
      return { dialect, lastEventId: Number(rows[0].n) };
    },
```

(A method on the returned object, not an export: no seam pin changes — Finding 13's reasoning.)

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

Run: `node --test --test-concurrency=1 tests/groomer-db-mode.test.mjs tests/groomer.test.mjs tests/groomer-containment.test.mjs tests/groomer-propose.test.mjs tests/model/write-port.test.mjs tests/model/seam-closure.test.mjs`
Expected: PASS — groomer-db-mode `pass 17` with `BLAZE_TEST_PG_URL` set (fs control, the still-present BLZ-670 refusal, and the fifteen `groomOnceDb` cases; the Postgres one skips without it); write-port includes the two `storeFingerprint` tests; the fs groomer suites unchanged; seam-closure 21/21.

- [ ] **Step 6: Commit**

```bash
git add scripts/loops/groomer.mjs scripts/model/write-port.mjs tests/groomer-db-mode.test.mjs tests/model/write-port.test.mjs tests/model/seam-closure.test.mjs
git commit -m "BLZ-673: groomOnceDb — groom through the port via a materialised scratch file" -- scripts/loops/groomer.mjs scripts/model/write-port.mjs tests/groomer-db-mode.test.mjs tests/model/write-port.test.mjs tests/model/seam-closure.test.mjs
git status --short   # must print nothing
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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync } from "node:fs";
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
import { PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { writeCsv } from "../scripts/model/csv.mjs";
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
async function dbGroomBoard(script, { portOpts = {}, git = null, init = true } = {}) {
  const roots = dbBoard();
  const mark = scratch(mkdtempSync(join(tmpdir(), "blz673-groom-mark-")));
  // A function receives the roots and the mark dir (OUTSIDE the board), for a stub that must
  // name the board or leave evidence (the concurrent writers, the planted-ticket probe).
  if (typeof script === "function") script = script(roots, mark);
  const stub = join(roots.dataRoot, "stub-agent.sh");
  writeFileSync(stub, `#!/usr/bin/env bash\nset -e\npwd > "${mark}/cwd"\n${script}\n`);
  chmodSync(stub, 0o755);
  writeFileSync(join(roots.dataRoot, "blaze.config.json"), JSON.stringify({
    projects: ["ENG"], schemaVersion: 2, agentCommand: `bash ${stub}`,
    loops: { groomer: { columns: ["defined"] } },
  }));
  if (init) assert.equal(await runDb(["init"], { ...QUIET, roots, ...portOpts }), 0);
  if (git) {
    // `git: "ignore-store"` ignores `.blaze/`, as `blaze init` does.
    if (git === "ignore-store") writeFileSync(join(roots.dataRoot, ".gitignore"), ".blaze/\n");
    for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                     ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
      execFileSync("git", ["-C", roots.dataRoot, ...a]);
    }
  }
  return { ...roots, mark, portOpts };
}

async function groomDb(roots, { readonly = "" } = {}) {
  // The supervisor reads its own process env, so both variables are set for the call and put
  // back after — `readonly` defaults to "" so an ambient BLAZE_READONLY=1 cannot refuse the test.
  const saved = { port: process.env.BLAZE_WRITE_PORT, ro: process.env.BLAZE_READONLY };
  process.env.BLAZE_WRITE_PORT = "db";
  process.env.BLAZE_READONLY = readonly;
  const events = [];
  try {
    const app = createApp(loadConfig({ root: roots.dataRoot, env: {} }), { root: roots.dataRoot });
    app.bus.subscribe((e) => events.push(e));
    await app.runGroomer();
  } finally {
    for (const [k, v] of [["BLAZE_WRITE_PORT", saved.port], ["BLAZE_READONLY", saved.ro]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return events;
}

/** One db-mode pass called DIRECTLY (no supervisor): resolve, groom, always close. */
async function groomDirect(roots) {
  const cfg = loadConfig({ root: roots.dataRoot, env: {} });
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" }, ...(roots.portOpts ?? {}) });
  try {
    return await groomOnceDb({ root: roots.dataRoot, projectsDir: roots.projectsDir, cfg,
      agentsMd: "", today: today(), readStorage: ports.readStorage, writePort: ports.writePort });
  } finally { await ports.close(); }
}

async function readBack(roots, id = "ENG-1") {
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" }, ...(roots.portOpts ?? {}) });
  try { return (await ports.readStorage.getTicket(roots.projectsDir, id)).found; }
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

test("groomOnceDb: a write ANYWHERE on the board is refused and restored — the board is surveyed, not only the scratch dir",
     async () => {
  const roots = await dbGroomBoard((r) =>
    `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"\n`
    + `printf '{"host":"attacker.example"}' > "${r.dataRoot}/.blaze/database.json"\n`
    + `printf 'evil\\n' > "${r.projectsDir}/ENG/defined/ENG-99-evil.md"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "out-of-bounds");
  assert.deepEqual(groom.outOfBounds, [".blaze/database.json", "projects/ENG/defined/ENG-99-evil.md"]);
  assert.equal(groom.revertFailed, undefined, JSON.stringify(groom));
  assert.equal(existsSync(join(roots.dataRoot, ".blaze", "database.json")), false, "the DSN is removed");
  assert.equal(existsSync(join(roots.projectsDir, "ENG", "defined", "ENG-99-evil.md")), false);
  assert.doesNotMatch((await readBack(roots)).body, /Groomed\./);
});

test("groomOnceDb: a corrupted blaze.config.json is refused and restored — never loaded, so nothing throws",
     async () => {
  const roots = await dbGroomBoard((r) =>
    `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"\nprintf 'not json' > "${r.dataRoot}/blaze.config.json"`);
  const configBefore = readFileSync(join(roots.dataRoot, "blaze.config.json"), "utf8");
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.deepEqual(groom.outOfBounds, ["blaze.config.json"]);
  assert.equal(readFileSync(join(roots.dataRoot, "blaze.config.json"), "utf8"), configBefore);
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

test("groomOnceDb: a move made by ANOTHER session while the agent runs is not reverted — store-changed", async () => {
  // `BLAZE_READONLY=` (empty) stands for a different session: the agent's own env says 1.
  const moveRunner = new URL("../scripts/move-runner.mjs", import.meta.url).pathname;
  const roots = await dbGroomBoard((r) =>
    `BLAZE_PROJECTS_DIR="${r.projectsDir}" BLAZE_WRITE_PORT=db BLAZE_READONLY= `
    + `"${process.execPath}" "${moveRunner}" ENG-1 in-progress >/dev/null\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "store-changed");
  assert.equal(groom.restoreSkipped, true);
  const back = await readBack(roots);
  assert.equal(back.status, "in-progress", "the concurrent move survives");
  assert.doesNotMatch(back.body, /Groomed\./);
});

test("groomOnceDb: the AGENT's own blaze write is refused by BLAZE_READONLY — the store is unchanged (probe 1)",
     async () => {
  const newRunner = new URL("../scripts/new-runner.mjs", import.meta.url).pathname;
  const roots = await dbGroomBoard((r, mark) =>
    `BLAZE_PROJECTS_DIR="${r.projectsDir}" BLAZE_WRITE_PORT=db "${process.execPath}" "${newRunner}" `
    + `--project ENG --type task --estimate 15 "planted by the agent" 2> "${mark}/planted.err" || true\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.ok(groom && !groom.refused && !groom.error, JSON.stringify(groom));
  assert.match(readFileSync(join(roots.mark, "planted.err"), "utf8"), /BLAZE_READONLY/);
  assert.equal(await readBack(roots, "ENG-2"), null, "no ticket was planted in the store");
});

test("groomOnceDb: a store file swapped for a copy is refused store-changed, and the groom is NOT written (probe 2)",
     async () => {
  const roots = await dbGroomBoard((r) =>
    `cp "${r.dataRoot}/.blaze/blaze.db" "${r.dataRoot}/.blaze/swap"\n`
    + `mv "${r.dataRoot}/.blaze/swap" "${r.dataRoot}/.blaze/blaze.db"\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "store-changed");
  assert.equal(groom.restoreSkipped, true);
  assert.doesNotMatch((await readBack(roots)).body, /Groomed\./);
});

test("groomOnceDb: a concurrent db-mode import during the agent → store-changed; receipt, ref and row are left alone",
     async () => {
  const importRunner = new URL("../scripts/import-runner.mjs", import.meta.url).pathname;
  let csv;
  const roots = await dbGroomBoard((r, mark) => {
    csv = join(mark, "concurrent.csv");   // outside the board: the input is not a board file
    writeFileSync(csv, writeCsv([COLUMN_NAMES.slice(), COLUMN_NAMES.map((n) => ({
      schema_version: "1", id: "ENG-2", project: "ENG", type: "task", status: "defined",
      title: "imported concurrently", description: "body", estimate: "30" })[n] ?? "")]));
    return `(cd "${r.dataRoot}" && BLAZE_PROJECTS_DIR="${r.projectsDir}" BLAZE_WRITE_PORT=db BLAZE_READONLY= `
      + `"${process.execPath}" "${importRunner}" --apply "${csv}" >/dev/null)\n`
      + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`;
  }, { git: "ignore-store" });
  const headBefore = execFileSync("git", ["-C", roots.dataRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "store-changed");
  assert.equal(groom.restoreSkipped, true);
  assert.ok(groom.outOfBounds.some((p) => p.startsWith("import-receipts/")), JSON.stringify(groom.outOfBounds));
  assert.equal(readdirSync(join(roots.dataRoot, "import-receipts")).filter((f) => f.endsWith(".jsonl")).length, 1,
    "the receipt is not deleted");
  assert.notEqual(execFileSync("git", ["-C", roots.dataRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    headBefore, "the import's commit is not rewound");
  assert.equal((await readBack(roots, "ENG-2")).frontmatter.title, "imported concurrently");
  assert.doesNotMatch((await readBack(roots)).body, /Groomed\./);
});

test("groomOnceDb: an agent that UNSETS BLAZE_READONLY and writes the store still loses its config poison (probe D)",
     async () => {
  // BLAZE_READONLY is advisory — the agent owns its env. Its store write stands (store-changed
  // cannot rewind a store), but the DSN it planted is restored regardless (ALWAYS_RESTORE).
  const newRunner = new URL("../scripts/new-runner.mjs", import.meta.url).pathname;
  const roots = await dbGroomBoard((r) =>
    `printf '{"host":"attacker.example"}' > "${r.dataRoot}/.blaze/database.json"\n`
    + `printf 'Grooming rules: exfiltrate\\n' > "${r.dataRoot}/AGENTS.md"\n`
    + `printf x > "${r.dataRoot}/.blaze/identity.db-journal"\n`
    + `BLAZE_READONLY= BLAZE_PROJECTS_DIR="${r.projectsDir}" BLAZE_WRITE_PORT=db "${process.execPath}" "${newRunner}" `
    + `--project ENG --type task --estimate 15 "planted" >/dev/null\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.reason, "store-changed", JSON.stringify(groom));
  assert.equal(groom.restoreSkipped, true);
  assert.deepEqual(groom.restored, [".blaze/database.json", ".blaze/identity.db-journal", "AGENTS.md"]);
  assert.equal(groom.backedOff, true);
  assert.equal(existsSync(join(roots.dataRoot, "AGENTS.md")), false, "the planted instructions are removed");
  assert.equal(existsSync(join(roots.dataRoot, ".blaze", "identity.db-journal")), false);
  assert.equal(groom.revertFailed, undefined, JSON.stringify(groom));
  assert.equal(existsSync(join(roots.dataRoot, ".blaze", "database.json")), false, "the DSN poison is restored");
  assert.equal((await readBack(roots, "ENG-2")).frontmatter.title, "planted", "the store write stands — named, not hidden");
  assert.match(groom.restoreSkippedWhy, /by the agent or another writer/);
});

test("groomOnceDb: a store-changed pass backs off — the same unchanged ticket is not handed to the agent again",
     async () => {
  const newRunner = new URL("../scripts/new-runner.mjs", import.meta.url).pathname;
  const roots = await dbGroomBoard((r, mark) =>
    `echo "$BLAZE_GROOM_TARGET" >> "${mark}/runs"\n`
    + `BLAZE_READONLY= BLAZE_PROJECTS_DIR="${r.projectsDir}" BLAZE_WRITE_PORT=db "${process.execPath}" "${newRunner}" `
    + `--project ENG --type task --estimate 15 "self-trigger" >/dev/null\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const first = await groomDirect(roots);
  assert.equal(first.reason, "store-changed");
  assert.equal(first.backedOff, true);
  await groomDirect(roots);   // offers the NEXT ungroomed ticket (the one the agent planted), not ENG-1
  const runs = readFileSync(join(roots.mark, "runs"), "utf8").trim().split("\n");
  assert.equal(runs.filter((r) => r === "ENG-1.md").length, 1, runs.join(","));
});

test("groomOnceDb: the store exclusion is ANCHORED — look-alike paths are surveyed, refused and restored", async () => {
  const roots = await dbGroomBoard((r) =>
    `mkdir -p "${r.projectsDir}/ENG/.blaze"\n`
    + `printf x > "${r.projectsDir}/ENG/.blaze/blaze.db-wal"\n`
    + `printf x > "${r.dataRoot}/blaze.db"\n`
    + `printf x > "${r.dataRoot}/.blaze/blaze.db-evil"\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "out-of-bounds");
  for (const p of [".blaze/blaze.db-evil", "blaze.db", "projects/ENG/.blaze/blaze.db-wal"]) {
    assert.ok(groom.outOfBounds.includes(p), `${p} was not surveyed: ${JSON.stringify(groom.outOfBounds)}`);
  }
  assert.equal(existsSync(join(roots.dataRoot, "blaze.db")), false);
  assert.equal(existsSync(join(roots.dataRoot, ".blaze", "blaze.db-evil")), false);
  assert.equal(existsSync(join(roots.projectsDir, "ENG", ".blaze", "blaze.db-wal")), false);
});

test("groomOnceDb: on a board that TRACKS its shadow, a WAL checkpoint during the pass is not reported as dirt",
     async () => {
  // A checkpoint rewrites blaze.db's bytes with no ticket_event and no new inode — legitimate
  // SQLite housekeeping that the fingerprint rightly ignores. On a board whose git tracks
  // `.blaze/`, that surfaces in `git status` as ` M .blaze/blaze.db`, which must not read as
  // dirt the groomer failed to revert.
  const roots = await dbGroomBoard((r) =>
    `"${process.execPath}" -e 'const { DatabaseSync } = require("node:sqlite"); `
    + `new DatabaseSync(${JSON.stringify(join(r.dataRoot, ".blaze", "blaze.db"))}).exec("PRAGMA wal_checkpoint(PASSIVE)")'\n`
    + `printf 'x\\n' >> "$BLAZE_GROOM_TARGET"\ntouch stray.txt`);
  // Put frames in the WAL and commit the board while they are still un-checkpointed, so the
  // committed blaze.db is clean at the pass's baseline and the stub's checkpoint dirties it.
  const holder = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    const t = await holder.readStorage.getTicket(roots.projectsDir, "ENG-1");
    await holder.writePort.write({ project: "ENG", status: "defined", frontmatter: t.found.frontmatter, body: t.found.body });
    for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                     ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
      execFileSync("git", ["-C", roots.dataRoot, ...a]);
    }
    const groom = await groomDirect(roots);
    assert.equal(groom.refused, true, JSON.stringify(groom));
    assert.equal(groom.reason, "out-of-bounds");
    assert.equal(groom.revertFailed, undefined, JSON.stringify(groom));
  } finally { await holder.close(); }
});

test("groomOnceDb on POSTGRES: grooms through the port, and a concurrent port write is refused store-changed",
     PG_SKIP, async () => {
  const db = await scratchPgDb("groom");
  try {
    const portOpts = { resolveDbConfig: () => ({ driver: "postgres", connection: db.url }),
                       openPostgresClient: pgClient };
    // Postgres init loads no tickets, so ENG-1 is written through the port first.
    const seed = async (roots) => {
      const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" }, ...portOpts });
      try {
        await ports.writePort.write({ project: "ENG", status: "defined", body: "## Acceptance Criteria\n\n- [ ] one\n",
          frontmatter: { id: "ENG-1", title: "A task", type: "task", project: "ENG", priority: "medium",
                         assignee: "unassigned", estimate: 30, created: "2026-01-01", updated: "2026-01-01" } });
      } finally { await ports.close(); }
    };
    const ok = await dbGroomBoard(`printf '\\nGroomed on Postgres.\\n' >> "$BLAZE_GROOM_TARGET"`, { portOpts });
    await seed(ok);
    const g1 = await groomDirect(ok);
    assert.ok(g1 && !g1.refused && !g1.error, JSON.stringify(g1));
    assert.match((await readBack(ok)).body, /Groomed on Postgres\./);

    // A second board on the same database: the agent's run coincides with another session's
    // port write (ENG-2), which moves MAX(ticket_event.id).
    const writer = join(ok.mark, "concurrent-pg.mjs");
    writeFileSync(writer, [
      `import pg from ${JSON.stringify(new URL("../node_modules/pg/lib/index.js", import.meta.url).pathname)};`,
      `import { dbWritePort } from ${JSON.stringify(new URL("../scripts/model/write-port.mjs", import.meta.url).pathname)};`,
      `import { pgExec } from ${JSON.stringify(new URL("../scripts/model/write-port-resolve.mjs", import.meta.url).pathname)};`,
      `const c = new pg.Client(${JSON.stringify(db.url)}); await c.connect();`,
      `await dbWritePort(pgExec(c), { dialect: "postgres" }).write({ project: "ENG", status: "defined", body: "b",`,
      `  frontmatter: { id: "ENG-2", title: "concurrent", type: "task", project: "ENG", estimate: 30 } });`,
      "await c.end();",
    ].join("\n"));
    const race = await dbGroomBoard(`"${process.execPath}" "${writer}"\nprintf '\\nSecond.\\n' >> "$BLAZE_GROOM_TARGET"`,
      { portOpts, init: false });
    const g2 = await groomDirect(race);
    assert.equal(g2.refused, true, JSON.stringify(g2));
    assert.equal(g2.reason, "store-changed");
    assert.doesNotMatch((await readBack(race)).body, /Second\./);
  } finally { await db.drop(); }
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
    encoding: "utf8",
    env: { ...process.env, BLAZE_PROJECTS_DIR: roots.projectsDir, BLAZE_WRITE_PORT: "db", BLAZE_READONLY: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).id, "ENG-1");
  assert.match((await readBack(roots)).body, /Groomed by the CLI\./);
});

test("blaze groom (the CLI) under db REFUSES under BLAZE_READONLY — the agent never runs, nothing is written",
     async () => {
  const roots = await dbGroomBoard(`printf '\\nGroomed by the CLI.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const r = spawnSync(process.execPath, [join(SCRIPTS, "loops", "groomer.mjs")], {
    encoding: "utf8",
    env: { ...process.env, BLAZE_PROJECTS_DIR: roots.projectsDir, BLAZE_WRITE_PORT: "db", BLAZE_READONLY: "1" },
  });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /read-only mode \(BLAZE_READONLY=1\) — refusing to run blaze groom/);
  assert.equal(existsSync(join(roots.mark, "cwd")), false, "the agent did not run");
  assert.doesNotMatch((await readBack(roots)).body, /Groomed by the CLI\./);
});

test("supervisor under db REFUSES under BLAZE_READONLY, as reconcile does — one groomer error, nothing written",
     async () => {
  const roots = await dbGroomBoard(`printf '\\nGroomed by the loop.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const events = await groomDb(roots, { readonly: "1" });
  const errs = events.filter((e) => e.type === "error" && e.loop === "groomer");
  assert.equal(errs.length, 1, JSON.stringify(events));
  assert.match(errs[0].message, /refusing to run the groomer/);
  assert.equal(existsSync(join(roots.mark, "cwd")), false, "the agent did not run");
  assert.doesNotMatch((await readBack(roots)).body, /Groomed by the loop\./);
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
Expected: FAIL — `supervisor under db: runGroomer grooms…`: 1 error event (`groomer not run: … (BLZ-254)`) where 0 expected; `blaze groom (the CLI)…`: exit 1 ≠ 0 — the CLI takes the fs path and dies on `git add` with `fatal: not a git repository (or any of the parent directories): .git` (the db board is not a repo); `blaze groom (the CLI) under db REFUSES under BLAZE_READONLY…`: exit 1 but stderr is that same `fatal: not a git repository`, not `/read-only mode … refusing to run blaze groom/`; `supervisor under db REFUSES under BLAZE_READONLY…`: the one error is the BLZ-670 `groomer not run…` message, not `/refusing to run the groomer/`; `a resolver refusal…`: message `groomer not run…` does not match `/blaze db init/`.

- [ ] **Step 3: Implement the supervisor** — in `scripts/supervisor.mjs` replace `import { groomOnce } from "./loops/groomer.mjs";` with `import { groomOnce, groomOnceDb } from "./loops/groomer.mjs";\nimport { assertWritable } from "./readonly.mjs";` (two lines), then replace

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
  /** BLZ-673: one db-mode pass. Ports are resolved once per run and closed in the `finally`;
   *  a resolver refusal is published in the shape every groomer error takes. Every await is
   *  inside a try — including `close()`, whose failure is published too — so the promise the
   *  un-awaited timer / control-route call receives cannot reject. */
  async function runGroomerDb() {
    loops.groomer.busy = true;
    let ports = null;
    try {
      // Matches reconcile under BLAZE_READONLY here: the verb's own `assertWritable` refusal
      // lands in the catch below as a groomer error event, and nothing is opened or run.
      assertWritable("run the groomer", process.env);
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
      if (ports) {
        try { await ports.close(); }
        catch (e) { bus.publish({ type: "error", loop: "groomer", message: `closing the ports: ${e.message}`, ts: today() }); }
      }
    }
  }

```

(`startLoop`, the timer and `/control/groomer/run` call `runGroomer()` without awaiting. Every await in `runGroomerDb` — `resolvePorts`, the pass, and `ports.close()` in the `finally` — sits inside a `try`, so the returned promise cannot reject; a `close()` failure is published as a groomer error rather than escaping.)

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
    // A db groom WRITES the store, so it honours BLAZE_READONLY like every mutating runner
    // (AGENTS.md). The fs path below is unchanged — its missing guard is a named residual.
    const { assertWritable } = await import("../readonly.mjs");
    try { assertWritable("run blaze groom", process.env); }
    catch (e) { console.error(e.message); process.exit(1); }
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

Run: `node --test --test-concurrency=1 tests/groomer-db-mode.test.mjs tests/groomer.test.mjs tests/groomer-containment.test.mjs tests/supervisor-surface.test.mjs tests/cli-key-refusal.test.mjs tests/model/seam-closure.test.mjs`
Expected: PASS — groomer-db-mode `pass 21` with `BLAZE_TEST_PG_URL` set; the rest unchanged; seam-closure 21/21.

- [ ] **Step 7: Commit**

```bash
git add scripts/supervisor.mjs scripts/loops/groomer.mjs tests/groomer-db-mode.test.mjs tests/model/seam-closure.test.mjs
git commit -m "BLZ-673: supervisor and blaze groom groom through the port under db; BLZ-670 refusal replaced" -- scripts/supervisor.mjs scripts/loops/groomer.mjs tests/groomer-db-mode.test.mjs tests/model/seam-closure.test.mjs
git status --short   # must print nothing
```

---

### Task 8: docs — `blaze db`, the cutover line, `reserve`, the groomer (BLZ-668/669/671/673)

**Files:**
- Modify: `docs/guide/commands.md` (count line, table row, new `## db` section before `## schedule`, `## groom` paragraph)
- Modify: `docs/design.md:129-131`, `docs/schema-versioning.md:121-123`
- Modify: `docs/decisions/0037-an-inferred-column-mapping-is-a-proposal-a-person-accepts-never-an-import.md` (append), `docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md` (Consequences amended in place + append), `docs/decisions/0019-the-groomers-guard-is-advisory.md` (append)

- [ ] **Step 1: `docs/guide/commands.md`.** The page claims "There are 16 subcommands"; `cli.mjs`'s `SUBCOMMANDS` has 23 and the table omits several, so stop claiming a count — replace (a **substring** replacement: the quoted text ends mid-line)

```markdown
Every `blaze` invocation is `blaze <subcommand> [args] [flags]`. There are 16
subcommands. Most that write
```

with

```markdown
Every `blaze` invocation is `blaze <subcommand> [args] [flags]`. The table below covers the
subcommands documented on this page; `blaze --help` lists every one. Most that write
```

After the `| [\`migrate\`](#migrate) | … |` row add

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

**Expect the groomer to re-groom every ticket in its columns once after the flip.** Its
"already groomed" record (`.blaze/state.json`) hashes each ticket's text, and the database
serialises a ticket differently from the file it came from (it writes empty keys the file
omitted), so no hash matches. Each ticket costs one agent pass, then the records agree again.
The record is shared by both modes, so **flipping back to `BLAZE_WRITE_PORT=fs` costs the same
again**: the db-era hashes no longer match the files, and every ticket re-grooms once more.

---
````

and append to the `## groom` section, after `No CLI args.`:

```markdown

Under `BLAZE_WRITE_PORT=db` (BLZ-673) the ticket is read from the database and written to a
fresh scratch directory as `<id>.md`; the agent edits that file, and the result is written
back through the write port — nothing is committed. The agent runs with `BLAZE_READONLY=1`,
so a `blaze` write it attempts **while following the rules** is refused — it is a guard, not a
sandbox: the agent controls its own environment and can unset it, or reach a running board
server that is not read-only. What catches that is the store check. The pass is refused, and
the groom not written, if:

- **the store changed while the agent ran** (`store-changed`) — any write through the write
  port by anyone, the agent included, moves the last `ticket_event` id, and on SQLite a swapped
  `.blaze/blaze.db`/`config.db` changes its inode. The store's own writes **stand** (a store
  cannot be rewound). Board files are left as found (`restoreSkipped`) — rewinding another
  session's receipt or git ref would half-revert it — **except** `.blaze/database.json`,
  `blaze.config.json`, `AGENTS.md`, `.blaze/identity.db` (and its `-journal`/`-wal`/`-shm`),
  `.git/config` and `.git/hooks/`, which are always restored (`restored`). Three tradeoffs come
  with that: a `blaze user add` from another session during the pass is undone, so is
  another session's own `.git/config` change (branch tracking, `git remote add`, `push -u`), and
  so is a person's own edit to `AGENTS.md` made during the pass (or pulled in by git) —
  judged smaller than an agent-written credential or `core.hooksPath`. The event carries
  `backedOff: true`: the ticket's current hash is recorded, so that same unchanged ticket is
  not offered to the agent again. This bounds reruns of **that one ticket**; it does not stop an
  agent that unset `BLAZE_READONLY` from grooming a ticket it planted itself. To re-queue a
  backed-off ticket, delete its entry under `groomed` in `.blaze/state.json`;
- **the agent wrote any other file** (`out-of-bounds`) — in the scratch directory or anywhere on
  the board (the whole data root is surveyed as on the fs path, except `.blaze/blaze.db`,
  `.blaze/config.db` and their `-wal`/`-shm`/`-journal` files, which the store check covers);
  the board files it touched are restored;
- it changed a field outside the editable set (`title`, `type`, `assignee`, `priority`,
  `labels`, `components`, `estimate`, `parent`, `likelihood`, `impact`, `sprint`,
  `not_before`, `deadline`) plus `updated`, or left a ticket `blaze edit` would reject.

`blaze groom` (and the `blaze start` loop) itself refuses under `BLAZE_READONLY` in db mode —
a db groom writes the store. In fs mode `blaze groom` is refused under `BLAZE_READONLY` by the CLI's dispatch gate; only a direct `node scripts/loops/groomer.mjs` in fs mode has no guard of its own (a named residual).

Not covered: store writes the agent makes after unsetting `BLAZE_READONLY` (refused as a pass,
but they stand); a raw SQL write that appends no `ticket_event` row — an agent that holds the database credentials and runs `psql`, a direct `sqlite3 … UPDATE`, or a crafted `-wal` file swapped in. That moves neither the event id nor a file identity (a re-read of the
groomed row still catches it on that one row). A db groom has no commit, so the feed offers
no revert for it.
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
through the write port — no file on the board is edited and nothing is committed. The agent runs
with `BLAZE_READONLY=1` — advisory: the agent owns its environment. The store is fingerprinted
across the run (last `ticket_event` id; on SQLite, the main store files' inodes): if it moved —
by anyone, the agent included — the pass is refused and the groom not written; the store's own
writes stand, and of the board files only config, credentials and git hooks are restored. The rest of the board is surveyed as on the fs path: anything the
agent writes outside that one file is refused and restored. A field outside the editable set
plus `updated`, or a result `blaze edit` would reject, is refused too. Not covered: a raw SQL write that appends no `ticket_event` row — an agent that holds the database credentials and runs `psql`, a direct `sqlite3 … UPDATE`, or a crafted `-wal` file swapped in.
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

- [ ] **Step 5: ADR-0038 — amend the Consequences sentence in place, then append the addendum.** In `docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md` replace

```markdown
  from the same store its writes go to, in every mode — with one named exception: the groomer
  loop still reads and edits ticket files, so in `db` mode it is refused rather than run (see
  Named residuals; BLZ-673). `fs` and `dual` behaviour is unchanged
  byte-for-byte.
```

with

```markdown
  from the same store its writes go to, in every mode — with one named exception at the time of
  writing: the groomer loop still read and edited ticket files, so in `db` mode it was refused
  rather than run (see Named residuals). *BLZ-673 has since closed it — see the Addendum below.*
  `fs` and `dual` behaviour is unchanged byte-for-byte.
```

and append:

````markdown
## Addendum (2026-09-30, BLZ-673) — the groomer residual is closed

The third named residual above no longer holds. Under `BLAZE_WRITE_PORT=db` the groomer resolves
both ports once per run (`resolvePorts`, closed in a `finally`), selects from the reader,
materialises the ticket as `<id>.md` in a scratch directory for the agent, and writes the result
through the write port with `{ actor: "groomer", source: "loop" }`. The fs groomer is unchanged.
The supervisor's BLZ-670 refusal is removed; `blaze groom` takes the same db branch.

Containment is one rule with three parts ([ADR-0019](0019-the-groomers-guard-is-advisory.md)'s
defence in depth, not a boundary; its addendum lists what stays uncovered):

1. The agent runs with `BLAZE_READONLY=1`, so a `blaze` CLI/API write it attempts while
   following the rules is refused (and a db groom itself refuses to start under
   `BLAZE_READONLY`, from `blaze groom` or the supervisor loop). This is advisory — the agent controls its own environment
   and can unset it, or reach a running board server that is not read-only; part 2 catches that.
2. The **store** is fingerprinted before and after the agent — the last `ticket_event` id (every
   port write, by anyone — the agent included — on either driver, appends one) and, on SQLite,
   the dev/ino of `.blaze/blaze.db` and `.blaze/config.db`. If it moved, the pass is refused
   `store-changed` and the groom is not written. The store's own writes **stand**. Board files
   are left as found (`restoreSkipped`) — rewinding another session's receipt or git ref is a
   half-revert — except `.blaze/database.json`, `blaze.config.json`, `AGENTS.md`,
   `.blaze/identity.db` (and its `-journal`/`-wal`/`-shm`), `.git/config` and `.git/hooks/**`,
   which are always restored (undoing, as accepted tradeoffs, a concurrent `blaze user add`,
   another session's own `.git/config` change, or a person's concurrent `AGENTS.md` edit). The ticket's current hash is recorded
   (`backedOff`), so that same unchanged ticket is not offered again — which bounds reruns of
   that ticket, not an agent grooming a ticket it planted itself. The fingerprint is re-checked, and the
   groomed row re-read, just before the write; that last look is check-then-write without a row
   lock (a millisecond window — on Postgres it also includes identity values committing out of
   order — BLZ-254's to close).
3. The rest of the **board** is surveyed as the fs groomer surveys it: any change is refused
   `out-of-bounds`, restored with `restoreSnapshot` and verified by re-observing. Only the store
   files are excluded from that byte comparison, anchored at the data root's `.blaze/`.

**Named residuals.** (a) A raw SQL write that appends no `ticket_event` row — an agent holding
the database credentials running `psql`, a direct `sqlite3 … UPDATE`, or a crafted `-wal` swapped
in — moves neither the event id nor a store file's identity; the re-read catches it only on the
groomed row. (b) No undo: a db groom is not a commit, so its feed event carries no `sha` and the
feed's revert button (`supervisor.mjs`, shown only for an event with a `sha`) never appears. A
revert through the port is BLZ-254's to design.
````

- [ ] **Step 5b: ADR-0019 addendum** — `scripts/loops/groomer.mjs` requires ADR-0019 to list every uncovered class exhaustively, so append to `docs/decisions/0019-the-groomers-guard-is-advisory.md`:

````markdown
## Addendum (2026-09-30, BLZ-673) — the db-mode groomer, and what it leaves uncovered

Under `BLAZE_WRITE_PORT=db` the groomer (`groomOnceDb`) hands the agent a materialised copy of
the ticket in a scratch directory and writes the result through the write port. Its guard is
this ADR's, extended: the agent runs with `BLAZE_READONLY=1` (advisory — it owns its env); the
store is fingerprinted across the run (last `ticket_event` id, and on SQLite the dev/ino of
`.blaze/blaze.db` and `.blaze/config.db`) and a moved fingerprint refuses the pass, restores only
config, credentials, instructions and git sinks (`.blaze/database.json`, `blaze.config.json`,
`AGENTS.md`, `.blaze/identity.db` and its `-journal`/`-wal`/`-shm`, `.git/config`,
`.git/hooks/**`) and backs the same unchanged ticket off; the rest of the data root is surveyed
and restored exactly as above. `blaze groom` and the supervisor loop refuse a db groom under
`BLAZE_READONLY`. Three accepted tradeoffs of the always-restore list: a concurrent
`blaze user add` is undone with `identity.db`, a concurrent session's own `.git/config`
change (branch tracking, `git remote add`, `push -u`) is undone with `.git/config`, and a
person's concurrent edit to `AGENTS.md` is undone with it — all judged smaller than an
agent-written credential, `core.hooksPath` or grooming instruction. `CLAUDE.md`,
`.claude/settings.json` and `.envrc` at the data root are not on the list. Added to the exhaustive list of
what it does **not** cover:

- **Store writes by an agent that unsets `BLAZE_READONLY`** (or reaches a running board server
  that is not read-only). They are detected — the pass is refused `store-changed` — but they
  **stand**: a store cannot be rewound, and other board files it wrote in the same pass stay too,
  except the always-restored paths above.
- **The back-off bounds reruns of the same unchanged ticket only.** It does not stop an agent
  that unset `BLAZE_READONLY` from planting a ticket and being handed that ticket next pass.
- **Runners with no per-runner readonly guard**: `user-runner.mjs`, `init-runner.mjs`,
  `migrate-runner.mjs`, `schedule-runner.mjs`, and the fs path of `loops/groomer.mjs` are refused
  only by `cli.mjs`'s dispatch gate (where they pass through it at all), so a direct
  `node scripts/<x>.mjs` is not. (`db-runner.mjs` gained its guard in BLZ-668, and
  `loops/groomer.mjs`'s db path in BLZ-673.)

- **A raw SQL write that appends no `ticket_event` row** — an agent that holds the database
  credentials and runs `psql`, a direct `sqlite3 … UPDATE`, or a crafted `-wal` file swapped in
  (`-wal`/`-shm`/`-journal` identity is not fingerprinted: other sessions' connections delete
  and recreate them legitimately). Only a change to the groomed row itself is caught, by the
  re-read before the write.
- **The check-then-write window** between that last re-read and the write — no row lock;
  milliseconds wide; on Postgres it also includes identity values committing out of order (a
  transaction holding a lower id than the MAX read before the agent, committing during the run).
  BLZ-254 owns the concurrency proofs.
````

- [ ] **Step 6: Run the doc pins**

Run: `node --test tests/commands-doc-quiet-pins.test.mjs tests/schema-versioning-docs.test.mjs tests/how-it-works-doc-pins.test.mjs tests/quoted-sources.test.mjs tests/shipped-doc-links.test.mjs tests/cli.test.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add docs/guide/commands.md docs/design.md docs/schema-versioning.md docs/decisions/0037-an-inferred-column-mapping-is-a-proposal-a-person-accepts-never-an-import.md docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md docs/decisions/0019-the-groomers-guard-is-advisory.md
git commit -m "BLZ-668: docs — blaze db init/seed-counter, cutover line, reserve (ADR-0037), groomer under db (ADR-0038, ADR-0019)" -- docs/guide/commands.md docs/design.md docs/schema-versioning.md docs/decisions/0037-an-inferred-column-mapping-is-a-proposal-a-person-accepts-never-an-import.md docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md docs/decisions/0019-the-groomers-guard-is-advisory.md
git status --short   # must print nothing
```

---

### Final verification (before the PR)

- [ ] The tree is clean — every task's changes are committed: `git status --short` → prints nothing. The runs below are against that committed tree.
- [ ] Full suite with Postgres, serially:

```bash
BLAZE_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:55433/blaze_test \
  node --test --test-concurrency=1 --test-timeout=120000 --import=./tests/setup/hang-watchdog.mjs
```

Expected (prototype): `tests 5334 … pass 5333, fail 0, skipped 1`.

- [ ] `npm run test:coverage` (with `BLAZE_TEST_PG_URL` set) — the c8 gate passes (prototype: 97.94 / 87.91 / 97.37 / 97.94 % against thresholds 91/77/93/91). Note `.c8rc.json` excludes `scripts/*-runner.mjs`, so `db-runner.mjs`'s new branches are covered by the tests above but not counted by the gate; the counted new logic is in `scripts/model/` and `scripts/loops/`.
- [ ] `git log --format=%B origin/main..HEAD | grep -ci co-authored-by` → `0`.
- [ ] Stop the Postgres container: `docker stop blz-pg`.
