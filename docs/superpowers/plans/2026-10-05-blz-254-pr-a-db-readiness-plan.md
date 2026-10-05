# BLZ-254 PR A — db readiness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the engine ready for the live-board cutover without changing `fs` or `dual` behaviour: load the board into Postgres (`blaze db load`), prove the load (`blaze db verify`), keep the metrics history under db, re-home blaze-pm's governance scripts into `blaze audit` and `blaze matrices`, and close the PR #194 residuals (pg one-query-at-a-time, the 0.8.0 version, the readonly guards, the reserve window).

**Architecture:** `load-corpus.mjs` splits into one pure row builder (`corpusRows` + `relationRows`) and two executors (the existing sync SQLite `loadCorpus`, a new async `loadCorpusAsync` over `exec`); `blaze db load` runs it on Postgres in one transaction, and `blaze db verify` recomputes the expected row counts from the same builder and gates on `zeroDiff`. db-mode readers gain `listTransitions` over the existing `ticket_transition` view; both servers feed it to the metrics view under db only. Three governance kinds and `--fail-on` live in `scripts/model/audit.mjs`; `blaze matrices` is a pure renderer (`scripts/model/matrices.mjs`) plus a thin runner. A create through the db port becomes a plain INSERT that refuses an existing row.

**Tech Stack:** Node 24 ESM, `node:test`, `node:sqlite`, `pg` 8 (optional peer dependency) against Postgres 17; Python 3 only for the operator's generator-oracle step.

**Spec:** `docs/superpowers/specs/2026-10-05-blz-254-live-board-cutover-design.md` — §5.2, §5.3, §5.6, §5.7, §5.8 and §8 row A. Read it first; this plan argues from it. Recon (git-ignored, file:line evidence) is under `.superpowers/sdd/blz-254/recon/` in the main checkout.

**Prototype provenance.** Every code and test block below was run, task by task, in a scratch worktree of `ca07c6f` against `postgres:17-alpine`. This Markdown was then GENERATED from that prototype's per-task trees: each "replace" block was checked to occur exactly once in its file at that point, and applying all of them in order reproduces the prototype byte for byte. Each task's tests were shown to FAIL on the pre-task tree and pass after it — including BLZ-675's AC (`grep -c "already executing"` over every Postgres test file: 9 files at base, 0 after Task 1). On the final tree, `npm run test:coverage` with `BLAZE_TEST_PG_URL` set and a private `TMPDIR` → `tests 5398, pass 5397, fail 0, skipped 1`; c8 statements 97.99 %, branches 88.15 %, functions 97.46 %, lines 97.99 % (thresholds 91/77/93/91); 0 deprecation lines in the whole run; `hygiene-check` clean; no attributable scratch directory left. Live-corpus rehearsal of Tasks 3–7 against a read-only COPY of blaze-pm's `BLZ-305-v4-spine` (`8bd7fd3d`, 2,930 tickets) in a scratch database: `blaze db load` → 2,930 tickets, 1,884 links, 1,905 worklog, 2,505 labels, 2,861 components in 17.9 s; `blaze db verify` → PASS in 1.3 s (0 value diffs, 0 missing, 0 extra, every row count equal, 6,885 criteria checked, 0 criteria diffs, 0 byte diffs); one changed title made it exit 1 naming the ticket and field. `blaze matrices` wrote all 22 files with zero `diff -r` against `build_matrices.py`'s own output, in both `fs` and `db` mode. `blaze audit` reproduced `terminal_parent_scan.py` (66 parents, 279 open children) and `empty_body_scan.py` (27) exactly.

## Global Constraints

- **`fs` and `dual` behaviour stay unchanged.** Mode comes only from `resolveWriteMode(env)` (or the `mode` that `resolveReadStorage`/`withReadStorage` return); nothing sniffs `writePort.name` or `database.driver` to choose a mode.
- **`tests/model/seam-closure.test.mjs`: changes are additive or exact name swaps, each with a `// BLZ-6xx:` comment naming the child ticket; never weaken an assertion.** Any module that names `fsReadStorage` must be on `FS_READER_ALLOWED` (this plan adds none: `db-runner.mjs` and `migrate/load-corpus.mjs` already are).
- **Postgres tests use `tests/helpers/pg-scratch.mjs`** (`PG`, `PG_SKIP`, `scratchPgDb`, `pgClient`), one scratch database per test, gated `PG_SKIP`; a host in an assertion is derived with `new URL(PG).hostname`, never hard-coded.
- **Hand-rolled `applyNew` calls pass `today`, and a `task` passes `extra: { estimate }`.**
- **Reuse, don't re-derive:** `resolveReadStorage`, `resolvePorts`, `withReadStorage`, `resolveWriteMode` (`write-port-resolve.mjs`); `postgresReader(client)`; `dbWritePort(exec, { dialect, today })`; `seedCounter(exec, maxima, { dialect })`, `corpusMaxima`, `counterUpsertSql(dialect)`; `openCheckedPg`, `describePgTarget`; `zeroDiff` (`scripts/migrate/zero-diff.mjs`); `acCriteria` (`ac-oracle-matcher.mjs`, through `zeroDiff`).
- **Test hygiene the suite enforces:** a scratch directory is minted as `scratch(mkdtempSync(join(tmpdir(), "<literal-prefix>-")))` with `scratchRegistry()` (the attribution guard reads the literal); no `rmSync` in a test body (the BLZ-603 debt ratchet counts it); a spawned runner gets an env with `BLAZE_WRITE_PORT` DELETED, never set to `""` (an empty value is refused).
- **Commits:** one per task, subject `BLZ-n: …` naming the CHILD ticket the task serves (BLZ-675, BLZ-674, BLZ-678, BLZ-679, BLZ-680, BLZ-681, BLZ-682, BLZ-683); staged and committed with an explicit pathspec; **no `Co-Authored-By` or `Signed-off-by` trailer** (hygiene CI rejects them); no `/home/` path or `*.howman.link` hostname in an added non-Markdown line.
- **Every task ends:** `git diff --cached | grep -c '^+```'` prints 0 (Task 7: exactly 2, its usage block) before the commit; commit with the explicit pathspec; then `git status --short` prints nothing and the task's tests pass on the committed tree.
- **The npm publish is NOT a plan step.** BLZ-674's publish is operator-gated and happens after merge.
- **Environment for every command** (the worktree needs `npm ci` once if `node_modules/` is absent — `pg` is needed for the gated tests):
  ```bash
  cd /home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-254-live-board-cutover
  export PATH=/home/rnamwoh/.local/node24/bin:$PATH
  docker run -d --rm --name blz-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=blaze_test -p 127.0.0.1:55432:5432 postgres:17-alpine
  until docker exec blz-pg pg_isready -U postgres -d blaze_test; do sleep 1; done
  export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test
  ```
  Run Postgres tests with `--test-concurrency=1`.

## Findings that refine the spec (decided here, from the code)

1. **BLZ-675 is three sites, not one.** At base every one of the 9 Postgres test files printed pg's "Calling client.query() when the client is already executing a query" deprecation. `applyCreate` was the first in each; with it fixed, `postgresReader` (`childrenFor`/`hydrate`/`hydrateAll`/`listTickets` — `Promise.all` over one client) and `tests/model/allocate-concurrency.test.mjs` (50 `allocate()`s at once on one client) surfaced next. The ticket's AC ("Postgres test runs are free of the warning") needs all three. One client runs one query at a time anyway, so awaiting in turn costs nothing; the allocate test keeps its real property — the race BETWEEN two connections — and its assertions are byte-unchanged.
2. **BLZ-674 vs ADR-0008's freeze.** ADR-0008 (*Proposed*) says `@hjr15/blaze-board` "freezes at 0.7.0", and `why-blaze.md` says so twice. The kickoff asks for 0.8.0; npm refuses a republish of 0.7.0, which lacks BLZ-131. Task 2 bumps to **0.8.0** (a minor: it also carries the new db commands) and records why in an ADR-0008 addendum and the two `why-blaze.md` lines. If the operator wants the freeze kept as a patch instead, it is 0.7.1 in the same five places.
3. **`blaze db load` and `verify` are Postgres-only.** The SQLite shadow is still loaded by `blaze db init` (its `loadCorpus` now runs on the shared builder). `load` on SQLite exits 1 naming `blaze db init`; `verify` on SQLite exits 2 ("could not run"). The async executor still takes `dialect` and is tested over SQLite, which is how "the two executors cannot drift" is pinned without a server.
4. **The load is all or nothing.** Each ticket inserts under a `SAVEPOINT` so EVERY refused row is named, then any refusal rolls the whole transaction back (exit 1, "NOTHING was loaded"). A half-loaded board would only fail `verify` and force `--replace` on the re-run. Measured: 0 calendar-invalid dates on the live corpus, the one class SQLite accepts and Postgres's `date` refuses.
5. **`--replace` truncates `ticket_link, ticket_label, ticket_component, worklog_entry, acceptance_criterion, ticket_event, ticket` — never `project_counter`.** `ticket_event`'s FK to `ticket` is `ON DELETE RESTRICT`, so it must go too; `TRUNCATE` does not fire the append-only row triggers. A number already issued is never issued again, so the counter is only raised (`seedCounter`).
6. **The builder de-duplicates labels, components and links per ticket.** Their primary keys refuse a repeat, so a repeat was never a row; counting it made the tally disagree with the table — and `verify`'s row-count condition compares the two. The SQLite shadow's rows are unchanged; only its `labels`/`links` tally numbers drop by the repeats (and a label after a repeat gets the next `ord` rather than skipping one).
7. **"The loader's tallies" are recomputed, not remembered.** `verify` runs the same `corpusRows` + `relationRows` over the files and compares each table's `count(*)` with that; nothing stores a tally between the two commands. A row `postgresReader` hides (a soft-deleted ticket) still fails the count.
8. **`criteriaFor` on Postgres is the engine's own parser over the loaded body.** Postgres keeps no `acceptance_criterion` rows (spec §5.2), and every db-mode reader and writer takes criteria from `body`; the oracle reads the SOURCE body with `ac-oracle-matcher.mjs`, which shares no code with it. `verifyLoad` takes `criteriaOf` as an injectable only so a test can fail condition 4 on its own.
9. **Transitions under db (BLZ-680):** a new inert module `scripts/model/transitions-db.mjs` (`dbTransitions(readStorage, mode, view, root)`) answers only for `mode === "db"` and the `metrics` view, so `fs`/`dual` and every other view are as before (no new export on the write-allowlisted `transitions.mjs`, so no seam pin changes). Both servers (`serve.mjs`, `supervisor.mjs`) call it on the page and `/view/<name>` routes. The SQLite `blaze db init` imports the git history too, so a SQLite board switched to db mode keeps its metrics. Imported events: `source = 'git-backfill'` (already allowed by the CHECK), actor `git-history`; a transition for an id that did not load, or with no timestamp, is counted, never inserted. `BLZ-305-v4-spine` holds 914 git transitions.
10. **`terminal-parent-open-child` is HARD as the spec says — and the live board has 66.** Ported with the script's own fixed terminal set (`done/achieved/mitigated/accepted/obsolete`), not the schema's terminals, so counts match the script exactly (66 parents, 279 open children on `BLZ-305-v4-spine@8bd7fd3d`). Consequence for spec §7 steps 3–4 ("audit has 0 hard findings"): that gate fails until INF-733's remedy runs on the board, or the runbook gates with `blaze audit --fail-on <kinds>`. This plan does not change the runbook; the operator decides.
11. **One existing test fixture changes, no assertion.** `tests/audit-terminal-goal-unverified.test.mjs`'s "R48: a soft finding does not fail the run" built an `achieved` goal over an `implemented` requirement — now ALSO a hard `terminal-parent-open-child` (`implemented` is not in the script's set). Its goal moves to `canceled` (terminal for R48, not for the new kind), and the test gains an assertion that the R48 finding is still raised.
12. **`config-project-drift` is skipped when the config lists no projects** (absent or `[]`): the audit already falls back to the store's listing then, and a `blaze audit <dir>` outside any board has no config at all (without this, `tests/audit.test.mjs`'s 1,200-finding pipe test gains a 1,201st). Under db the store's projects are `DISTINCT project_key`, so a configured project with no tickets reads as drift there.
13. **`--fail-on` refuses an unknown or empty kind list with exit 2** (a typo would otherwise be a gate that can never fail) and accepts soft kinds too.
14. **Added by the coordinator, verified against the code: `--projects` resolved links against the scoped set.** `audit-runner.mjs` filtered to `--projects` before `auditCorpus` built its id set, so `blaze audit --projects BLZ` on the live copy reported 5 hard `dangling-target`s (BLZ-134→INF-750, BLZ-136→INF-744, BLZ-142→INF-798, BLZ-96→INF-556, BLZ-97→INF-556) that the unscoped run does not. `auditCorpus` gains `universe` (resolve against every ticket the store holds; judge only `tickets`); after the fix the scoped run reports 0. Folded into Task 6 (BLZ-681).
15. **Matrices keep the script's header text** ("Regenerate with `python3 scripts/build_matrices.py`") — changing it would break the byte-for-byte oracle; once blaze-pm switches to `blaze matrices`, rewording it is a one-line follow-up there. **Ties on `ref` are ordered by path.** The script's ties follow `glob.glob`, i.e. directory order, which differs per filesystem: blaze-pm's committed `blz-architecture-matrix.md` orders its 6 ref-less decisions differently from a sorted glob. The oracle therefore runs the script with `sorted(glob.glob(…))` (a no-op on its rules) on a scratch copy. Against the COMMITTED files, `blaze matrices --check` on the live copy names `blz-requirements-matrix.md` (BLZ-676's existing drift), `nca-requirements-matrix.md` (BLZ-555's known exception) and `blz-architecture-matrix.md` (that tie order).
16. **`blaze matrices` is `mutates: true` with `readOnlyFlags: ["--check"]`** (BLZ-499's mechanism), carries its own readonly guard, writes through `writeRegularFileSync` (one new `WRITE_ALLOWED` entry and its pin), defaults to every configured project and `<data root>/docs/matrices`, and exits 2 on an empty project set. Under db a ticket's link is `ticketPath`'s canonical path; on the live copy that gave zero diff against fs mode. The new fixture board moves `scripts/model/schema-version.mjs`'s derived census comment from 5 to 6 fixture boards (`tests/schema-version-fixture-census.test.mjs` pins it).
17. **§5.8's reserve window: the spec's premise was false at base.** "The losing writer fails loudly on the unique key" — but the create write was `INSERT … ON CONFLICT (id) DO UPDATE`, so a ticket created by another writer after `reserve` (or after `new`'s `exists`) was silently overwritten (each Task 8 race test fails at base). Fix: `applyNew` and import's create rows write with `{ create: true }`; `dbWritePort.persist` then refuses a row it can see (`already exists … NOT written`) and inserts without `ON CONFLICT`, so one committed mid-write hits `ticket_pkey`. Edits and moves are unchanged; the fs port ignores the context; under dual the shadow reports it as a divergence instead of upserting. Both §5.8 items (guards and window) belong to BLZ-683, the only §5.8 child.
18. **Readonly guard placement (BLZ-683):** after argument validation (a usage error is still named first), before the first write. `migrate` is guarded in both modes (its dry run writes `migration/`); `schedule` only under `--write` (its dry run is a read, and stays allowed); `init` uses its injected `io.env`.
19. **`cli.mjs`'s preflight comment count** becomes "21 of the 24 subcommands" — `tests/cli.test.mjs` derives and pins it.

## Review Focus

1. **`blaze db load` re-run against a database that is already the board** (loaded, then written in db mode) → refused, nothing changed, the message says `--replace` erases tickets AND event history and names `blaze db verify`. Pinned: Task 3 (`a second load is REFUSED…`).
2. **A row Postgres refuses that the files and SQLite accepted** (a constraint the builder cannot see) → every such row named, the whole load rolled back, the table empty. Pinned: Task 3 (`a row Postgres refuses rolls the WHOLE load back…`).
3. **The database drifted after the load in a way the reader cannot show** (a soft-deleted row) → `verify` still fails, on the row count. Pinned: Task 4 (`a row the reader never shows…`), plus each of the four conditions failing alone.
4. **`blaze audit --projects X` on a board whose tickets link across projects** → no false `dangling-target`/`dangling-parent`; a truly missing target is still hard. Pinned: Task 6 (`--projects scopes what is JUDGED…`).
5. **A second writer lands between "this id is free" and the create** (import after `reserve`, `new` after `exists`, or mid-INSERT on Postgres) → the loser fails loudly and the winner's ticket survives. Pinned: Task 8 (`tests/reserve-window.test.mjs`).

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `scripts/model/db-schema-version.mjs` | 1 | `applyCreate` runs its DDL one statement at a time |
| `scripts/model/pg-storage.mjs` | 1, 5 | reader queries one at a time; `listTransitions` |
| `tests/model/pg-one-query-at-a-time.test.mjs` (new) | 1 | fake-client overlap detectors + real-pg warning check |
| `tests/model/allocate-concurrency.test.mjs` | 1 | per-connection calls in turn; the cross-connection race kept |
| `package.json`, `package-lock.json`, `tests/package.test.mjs` | 2 | 0.8.0 |
| `scripts/migrate/load-corpus.mjs` | 3, 5 | `corpusRows`, `relationRows`, `loadCorpus`, `loadCorpusAsync`; `transitionEvents`, `importTransitions` |
| `scripts/db-runner.mjs` | 3, 4, 5 | `load`, `verify`; transitions imported by `load` and SQLite `init` |
| `scripts/migrate/verify-load.mjs` (new) | 4 | `verifyLoad`, `expectedCounts`, `criteriaFromBody` |
| `scripts/model/sqlite-storage.mjs` | 5 | `listTransitions` |
| `scripts/model/transitions-db.mjs` (new) | 5 | `dbTransitions` |
| `scripts/serve.mjs`, `scripts/supervisor.mjs` | 5 | metrics history from the database under db |
| `scripts/model/audit.mjs` | 6 | three kinds, `governanceFindings`, `auditCorpus({ universe })` |
| `scripts/audit-runner.mjs` | 6 | `--fail-on`; governance kinds; resolve against the whole store |
| `scripts/model/matrices.mjs` (new) | 7 | the pure renderer |
| `scripts/matrices-runner.mjs` (new), `scripts/cli.mjs`, `scripts/model/schema-version.mjs` | 7 | `blaze matrices`; census comment |
| `tests/fixtures/matrices-board/` (new) | 7 | a board + the script's own output for it |
| `scripts/{user,init,migrate,schedule}-runner.mjs` | 8 | readonly guards |
| `scripts/model/write-port.mjs`, `scripts/new.mjs`, `scripts/model/import-apply.mjs` | 8 | a create never overwrites |
| `tests/{db-load,db-verify,db-transitions,audit-governance,matrices,readonly-runners,reserve-window}.test.mjs` (new) | 3–8 | the tests |
| `docs/guide/commands.md`, `AGENTS.md`, ADR-0008/0019/0038, `docs/guide/why-blaze.md` | 2–8 | docs, in each task's own commit |

---

### Task 1: pg queries one at a time — `applyCreate`, the reader, the allocate test (BLZ-675)

**Files:**
- Create: `tests/model/pg-one-query-at-a-time.test.mjs`
- Modify: `tests/model/allocate-concurrency.test.mjs`
- Modify: `scripts/model/db-schema-version.mjs`
- Modify: `scripts/model/pg-storage.mjs`

**Interfaces:**
- Consumes: `createDbSchema(exec, { dialect })`, `postgresReader(client)` (unchanged signatures).
- Produces: nothing new — same exports, same results; every statement on one client now awaits the one before it.

- [ ] **Step 1: Write the failing tests.**

In `tests/model/allocate-concurrency.test.mjs`, replace (1/3):

```js

/** Drops the database this helper created — call in the test's own `finally`. */
```

with:

```js

/** BLZ-675: `n` calls on ONE connection, each awaited before the next. A `Promise.all` here
 *  issued them all at once on one pg.Client — which pg queues anyway (the header above), and
 *  deprecates. The race this file proves is BETWEEN the two connections, and that stays. */
async function inTurn(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await fn());
  return out;
}

/** Drops the database this helper created — call in the test's own `finally`. */
```

In `tests/model/allocate-concurrency.test.mjs`, replace (2/3):

```js
    const [a, b] = await Promise.all([
      Promise.all(Array.from({ length: 50 }, () => portA.allocate(key))),
      Promise.all(Array.from({ length: 50 }, () => portB.allocate(key))),
    ]);
```

with:

```js
    const [a, b] = await Promise.all([
      inTurn(50, () => portA.allocate(key)),
      inTurn(50, () => portB.allocate(key)),
    ]);
```

In `tests/model/allocate-concurrency.test.mjs`, replace (3/3):

```js
    const [resA, resB] = await Promise.all([
      Promise.all(Array.from({ length: 20 }, () => portA.allocate(keyA))),
      Promise.all(Array.from({ length: 20 }, () => portB.allocate(keyB))),
    ]);
```

with:

```js
    const [resA, resB] = await Promise.all([
      inTurn(20, () => portA.allocate(keyA)),
      inTurn(20, () => portB.allocate(keyB)),
    ]);
```

Create `tests/model/pg-one-query-at-a-time.test.mjs`:

```js
// tests/model/pg-one-query-at-a-time.test.mjs — BLZ-675.
//
// `createDbSchema` issued every DDL statement before awaiting the first, and the Postgres
// reader hydrated tickets through `Promise.all` — both N concurrent `client.query()` calls on
// ONE pg.Client. pg 8 queues them but prints "Calling client.query() when the client is
// already executing a query is deprecated"; pg 9 is set to refuse. The fakes below FAIL the
// moment a second query starts before the first has settled, so they discriminate without a
// server; the last test proves the real driver prints no such warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDbSchema } from "../../scripts/model/db-schema-version.mjs";
import { postgresReader } from "../../scripts/model/pg-storage.mjs";
import { PG_SKIP, scratchPgDb } from "../helpers/pg-scratch.mjs";

/** Settles on a LATER macrotask, so an overlapping caller is really overlapping. */
const later = (v) => new Promise((resolve) => setImmediate(() => resolve(v)));

function oneAtATime(answer) {
  const seen = { calls: 0, overlaps: [] };
  let busy = null;
  const query = async (sql) => {
    seen.calls++;
    if (busy !== null) seen.overlaps.push({ running: busy.slice(0, 60), started: String(sql).slice(0, 60) });
    busy = String(sql);
    try { return await later(answer(String(sql))); } finally { busy = null; }
  };
  return { seen, query };
}

test("createDbSchema on an async driver runs ONE statement at a time", async () => {
  const { seen, query } = oneAtATime(() => ({ rows: [] }));   // every lookup: empty database
  const exec = { run: (sql) => query(sql), all: async (sql) => (await query(sql)).rows };
  const r = await createDbSchema(exec, { dialect: "postgres" });
  assert.deepEqual(r, { created: true, version: 5 });
  assert.ok(seen.calls > 10, `only ${seen.calls} statements seen — the fake is not observing the create`);
  assert.deepEqual(seen.overlaps, [], "a statement started while another was still running");
});

test("the Postgres reader issues one query at a time on its client", async () => {
  const row = (id, parent = null) => ({ id, project_key: "BLZ", num: Number(id.split("-")[1]), type: "task",
    status: "defined", title: id, priority: "medium", assignee: "unassigned", parent_id: parent,
    body: "", created_on: "2026-01-01", updated_on: "2026-01-01" });
  const { seen, query } = oneAtATime((sql) => {
    if (/FROM ticket WHERE id = \$1/.test(sql)) return { rows: [row("BLZ-1")] };
    if (/FROM ticket WHERE parent_id = \$1/.test(sql)) return { rows: [row("BLZ-2", "BLZ-1"), row("BLZ-3", "BLZ-1")] };
    if (/FROM ticket WHERE deleted_at IS NULL ORDER BY id/.test(sql)) return { rows: [row("BLZ-1"), row("BLZ-2")] };
    if (/JOIN ticket t/.test(sql)) return { rows: [row("BLZ-4")] };
    return { rows: [] };
  });
  const r = postgresReader({ query, end: async () => {} });
  assert.equal((await r.getTicket(null, "BLZ-1")).found.frontmatter.id, "BLZ-1");
  assert.equal((await r.listChildren(null, "BLZ-1")).length, 2);
  assert.equal((await r.blockersOf(null, "BLZ-1")).length, 1);
  assert.equal((await r.listTickets(null)).length, 2);
  assert.ok(seen.calls >= 20, `only ${seen.calls} queries seen — the fake is not observing the reads`);
  assert.deepEqual(seen.overlaps, [], "a query started while another was still running");
});

test("real Postgres: init, a write and every reader path print no pg deprecation warning", PG_SKIP, async () => {
  const db = await scratchPgDb("seq");
  try {
    // A CHILD process, because Node prints a given deprecation once per process: a warning an
    // earlier test in this file triggered would hide this one's. Its stderr is the evidence.
    const mod = (p) => JSON.stringify(new URL(`../../scripts/${p}`, import.meta.url).href);
    const src = `
      import pg from "pg";
      import { createDbSchema } from ${mod("model/db-schema-version.mjs")};
      import { dbWritePort } from ${mod("model/write-port.mjs")};
      import { pgExec } from ${mod("model/write-port-resolve.mjs")};
      import { postgresReader } from ${mod("model/pg-storage.mjs")};
      const c = new pg.Client(process.env.SCRATCH_URL);
      await c.connect();
      try {
        await createDbSchema(pgExec(c), { dialect: "postgres" });
        const port = dbWritePort(pgExec(c), { dialect: "postgres", today: () => "2026-10-05" });
        for (const [id, parent] of [["ENG-1", ""], ["ENG-2", "ENG-1"]]) {
          await port.write({ project: "ENG", status: "defined", body: "b",
            frontmatter: { id, title: id, type: "task", estimate: 30, parent, labels: ["x"],
                           worklog: [{ date: "2026-10-05", minutes: 5 }],
                           links: parent ? [{ type: "Blocks", target: parent }] : [] } });
        }
        const r = postgresReader(c);
        await r.listTickets(null); await r.getTicket(null, "ENG-1");
        await r.listChildren(null, "ENG-1"); await r.blockersOf(null, "ENG-1");
        console.log("done");
      } finally { await c.end(); }`;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8",
      env: { ...process.env, SCRATCH_URL: db.url },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /done/);
    assert.doesNotMatch(run.stderr, /already executing a query/);
  } finally { await db.drop(); }
});

```


- [ ] **Step 2: Run them to verify they fail.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/model/pg-one-query-at-a-time.test.mjs
```

Expected: 3 failures — `createDbSchema on an async driver runs ONE statement at a time` (overlaps recorded), `the Postgres reader issues one query at a time on its client` (overlaps recorded), `real Postgres: … print no pg deprecation warning` (stderr matches `already executing a query`). Without `BLAZE_TEST_PG_URL` the third is skipped and the first two still fail.

- [ ] **Step 3: Implement.**

In `scripts/model/db-schema-version.mjs`, replace:

```js
  }
  const runs = [
    exec.run(ddl, []),
    exec.run(linkDdl(dialect), []),
    exec.run(hierarchyDdl(dialect), []),
    exec.run(metaDdl(dialect), []),
    // `configDdl` emits `CREATE SCHEMA IF NOT EXISTS blaze_config` on Postgres and nothing on
    // SQLite, where the ATTACH above IS the namespace. `viewDdl` must follow it: `view`'s FKs
    // point at `project` (config's) and `view_type` (its own), and BLZ-371 established that in
    // SQLite an FK cannot cross a database file — which is why `view` lives here at all.
    exec.run(configDdl(dialect), []),
    exec.run(viewDdl(dialect), []),
    ...viewTypeSeedSql(dialect).map(({ sql, params }) => exec.run(sql, params)),
    exec.run(
      `INSERT INTO blaze_meta (key, value) VALUES (${ph(dialect, 0)}, ${ph(dialect, 1)})`,
      ["schema_version", String(DB_SCHEMA_VERSION)]),
  ];
  // Await only if the driver actually returned promises — one body, both drivers.
  const done = { created: true, version: DB_SCHEMA_VERSION };
  // The config seed is NOT in `runs`: it needs its own transaction, because
  // `workflow.reopen_to` is a deferred circular FK and the seed is only consistent at COMMIT.
  // The sync driver needs the SYNCHRONOUS twin — `seedConfigInTransaction` is async, so with
  // node:sqlite every await in it defers to a microtask and this function would return with
  // the config tables still empty.
  if (runs.some((r) => r instanceof Promise)) {
    return Promise.all(runs)
      .then(() => seedConfigInTransaction((sql, params) => exec.run(sql, params), dialect))
      .then(() => done);
  }
  seedConfigSync((sql, params) => exec.run(sql, params), dialect);
```

with:

```js
  }
  // BLZ-675: each statement is a THUNK, run one at a time. This used to be an array of
  // `exec.run(...)` CALLS, so every statement was issued before the first was awaited — against
  // a real pg.Client that is N concurrent `client.query()` calls on one connection, which pg 8
  // queues but deprecates ("Calling client.query() when the client is already executing a
  // query") and pg 9 is set to refuse.
  const steps = [
    () => exec.run(ddl, []),
    () => exec.run(linkDdl(dialect), []),
    () => exec.run(hierarchyDdl(dialect), []),
    () => exec.run(metaDdl(dialect), []),
    // `configDdl` emits `CREATE SCHEMA IF NOT EXISTS blaze_config` on Postgres and nothing on
    // SQLite, where the ATTACH above IS the namespace. `viewDdl` must follow it: `view`'s FKs
    // point at `project` (config's) and `view_type` (its own), and BLZ-371 established that in
    // SQLite an FK cannot cross a database file — which is why `view` lives here at all.
    () => exec.run(configDdl(dialect), []),
    () => exec.run(viewDdl(dialect), []),
    ...viewTypeSeedSql(dialect).map(({ sql, params }) => () => exec.run(sql, params)),
    () => exec.run(
      `INSERT INTO blaze_meta (key, value) VALUES (${ph(dialect, 0)}, ${ph(dialect, 1)})`,
      ["schema_version", String(DB_SCHEMA_VERSION)]),
  ];
  const done = { created: true, version: DB_SCHEMA_VERSION };
  // The config seed is NOT a step: it needs its own transaction, because
  // `workflow.reopen_to` is a deferred circular FK and the seed is only consistent at COMMIT.
  // The sync driver needs the SYNCHRONOUS twin — `seedConfigInTransaction` is async, so with
  // node:sqlite every await in it defers to a microtask and this function would return with
  // the config tables still empty.
  //
  // One body, both drivers: the FIRST step's result says which kind this exec is. An async
  // driver returns a promise, and then every later step waits for the one before it.
  const first = steps[0]();
  if (first instanceof Promise) {
    return (async () => {
      await first;
      for (const step of steps.slice(1)) await step();
      await seedConfigInTransaction((sql, params) => exec.run(sql, params), dialect);
      return done;
    })();
  }
  for (const step of steps.slice(1)) step();
  seedConfigSync((sql, params) => exec.run(sql, params), dialect);
```

In `scripts/model/pg-storage.mjs`, replace (1/3):

```js
  // `ord` preserves what the operator wrote, and `worklog_entry` has no ord so it uses on_date.
  const childrenFor = async (id) => {
    const [labels, components, worklog] = await Promise.all([
      client.query("SELECT label FROM ticket_label WHERE ticket_id = $1 ORDER BY ord", [id]),
      client.query("SELECT component FROM ticket_component WHERE ticket_id = $1 ORDER BY ord", [id]),
      client.query("SELECT on_date::text AS on_date, minutes, note FROM worklog_entry WHERE ticket_id = $1 ORDER BY on_date, id", [id]),
    ]);
    return [
```

with:

```js
  // `ord` preserves what the operator wrote, and `worklog_entry` has no ord so it uses on_date.
  // BLZ-675: one query at a time. These were `Promise.all`s over ONE pg.Client — concurrent
  // `client.query()` calls on a single connection, which pg 8 queues but deprecates and pg 9 is
  // set to refuse. One connection runs one query at a time anyway, so awaiting each in turn
  // costs nothing; it only stops asking the client to queue.
  const childrenFor = async (id) => {
    const labels = await client.query("SELECT label FROM ticket_label WHERE ticket_id = $1 ORDER BY ord", [id]);
    const components = await client.query("SELECT component FROM ticket_component WHERE ticket_id = $1 ORDER BY ord", [id]);
    const worklog = await client.query("SELECT on_date::text AS on_date, minutes, note FROM worklog_entry WHERE ticket_id = $1 ORDER BY on_date, id", [id]);
    return [
```

In `scripts/model/pg-storage.mjs`, replace (2/3):

```js
    if (!row) return null;
    const [links, [labels, components, worklog]] = await Promise.all([linksFor(row.id), childrenFor(row.id)]);
    return toRecord(row, links, labels, components, worklog);
  };
  const hydrateAll = async (rows) => Promise.all(rows.map(hydrate));

```

with:

```js
    if (!row) return null;
    const links = await linksFor(row.id);
    const [labels, components, worklog] = await childrenFor(row.id);
    return toRecord(row, links, labels, components, worklog);
  };
  const hydrateAll = async (rows) => {
    const out = [];
    for (const row of rows) out.push(await hydrate(row));
    return out;
  };

```

In `scripts/model/pg-storage.mjs`, replace (3/3):

```js
      // driver-conformance.test.mjs pins the two paths against each other.
      const [t, l, lb, cp, wl] = await Promise.all([
        client.query(`SELECT ${COLS} FROM ticket WHERE ${ALIVE} ORDER BY id`),
        client.query("SELECT src_id, link_type, target_id FROM ticket_link ORDER BY src_id, link_type, target_id"),
        client.query("SELECT ticket_id, label, ord FROM ticket_label ORDER BY ticket_id, ord"),
        client.query("SELECT ticket_id, component, ord FROM ticket_component ORDER BY ticket_id, ord"),
        client.query("SELECT ticket_id, on_date::text AS on_date, minutes, note FROM worklog_entry ORDER BY ticket_id, on_date, id"),
      ]);
      // Array.prototype.sort is stable, so rows without `ord` (links, worklog) keep SQL order.
```

with:

```js
      // driver-conformance.test.mjs pins the two paths against each other.
      const t = await client.query(`SELECT ${COLS} FROM ticket WHERE ${ALIVE} ORDER BY id`);
      const l = await client.query("SELECT src_id, link_type, target_id FROM ticket_link ORDER BY src_id, link_type, target_id");
      const lb = await client.query("SELECT ticket_id, label, ord FROM ticket_label ORDER BY ticket_id, ord");
      const cp = await client.query("SELECT ticket_id, component, ord FROM ticket_component ORDER BY ticket_id, ord");
      const wl = await client.query("SELECT ticket_id, on_date::text AS on_date, minutes, note FROM worklog_entry ORDER BY ticket_id, on_date, id");
      // Array.prototype.sort is stable, so rows without `ord` (links, worklog) keep SQL order.
```


- [ ] **Step 4: Run them to verify they pass**, then the neighbours this task touches.

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/model/pg-one-query-at-a-time.test.mjs
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/model/allocate-concurrency.test.mjs tests/model/pg-list-batched.test.mjs tests/model/db-schema-version.test.mjs tests/model/driver-conformance.test.mjs tests/model/config-install.test.mjs tests/db-runner-pg.test.mjs tests/db-mode-reads-pg.test.mjs
```

Expected: all pass. Then the AC itself — every Postgres test file, warning count 0:

```bash
for f in $(grep -rl "BLAZE_TEST_PG_URL\|pg-scratch" tests --include=*.test.mjs | sort); do
  n=$(node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs "$f" 2>&1 | grep -c "already executing")
  [ "$n" != 0 ] && echo "$n $f"
done; echo done        # prints only "done"
```

- [ ] **Step 5: Fence check, commit, prove the committed tree.**

```bash
git add tests/model/allocate-concurrency.test.mjs tests/model/pg-one-query-at-a-time.test.mjs scripts/model/db-schema-version.mjs scripts/model/pg-storage.mjs
git diff --cached | grep -c '^+```'      # must print 0
git commit -m "BLZ-675: apply DDL and reader queries one at a time on a pg client" -m "applyCreate runs each statement after the one before; postgresReader awaits its child queries in turn; allocate-concurrency issues each connection's calls in turn (the cross-connection race and every assertion unchanged). New tests/model/pg-one-query-at-a-time.test.mjs." -- tests/model/allocate-concurrency.test.mjs tests/model/pg-one-query-at-a-time.test.mjs scripts/model/db-schema-version.mjs scripts/model/pg-storage.mjs
git status --short                        # must print nothing
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/model/pg-one-query-at-a-time.test.mjs   # green on the COMMITTED tree
```


---

### Task 2: version 0.8.0, so the next publish carries BLZ-131 (BLZ-674)

**Files:**
- Modify: `tests/package.test.mjs`
- Modify: `package-lock.json`
- Modify: `package.json`
- Modify: `docs/decisions/0008-v3-ships-as-hjr15-blaze.md`
- Modify: `docs/guide/why-blaze.md`

**Interfaces:**
- Produces: `package.json` / `package-lock.json` version `0.8.0`. The publish itself is operator-gated, after merge — not a step here.

- [ ] **Step 1: Write the failing tests.**

In `tests/package.test.mjs`, replace:

```js
  assert.equal(pkg.engines?.node, ">=24", "engine floor matches the tested Node line — node:sqlite needs 24 (BLZ-264)");
});
```

with:

```js
  assert.equal(pkg.engines?.node, ">=24", "engine floor matches the tested Node line — node:sqlite needs 24 (BLZ-264)");
});

// BLZ-674. npm already holds a 0.7.0 cut BEFORE BLZ-131's squash-body reconcile landed, and a
// registry never accepts the same version twice — so the fix reaches blaze-pm only under a NEW
// version. The publish itself is an operator step after merge; this pins what it will publish.
test("BLZ-674: the next publish is 0.8.0, and it carries BLZ-131's squash-body reconcile", async () => {
  assert.equal(pkg.version, "0.8.0");
  const lock = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8"));
  assert.equal(lock.version, "0.8.0", "package-lock.json's top-level version must move with it");
  assert.equal(lock.packages[""].version, "0.8.0", "…and its root package entry");
  const { idsFromCommitMessage } = await import("../scripts/reconcile.mjs");
  assert.deepEqual(idsFromCommitMessage("BLZ-675: x (#9)\n\n* BLZ-674: y\n* BLZ-678: z", "BLZ"),
    ["BLZ-675", "BLZ-674", "BLZ-678"], "a bundled squash recovers every child");
});
```


- [ ] **Step 2: Run them to verify they fail.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/package.test.mjs
```

Expected: 1 failure — `BLZ-674: the next publish is 0.8.0…` (`'0.7.0' !== '0.8.0'`).

- [ ] **Step 3: Implement.**

In `package-lock.json`, replace (1/2):

```json
  "name": "@hjr15/blaze-board",
  "version": "0.7.0",
  "lockfileVersion": 3,
```

with:

```json
  "name": "@hjr15/blaze-board",
  "version": "0.8.0",
  "lockfileVersion": 3,
```

In `package-lock.json`, replace (2/2):

```json
      "name": "@hjr15/blaze-board",
      "version": "0.7.0",
      "license": "MIT",
```

with:

```json
      "name": "@hjr15/blaze-board",
      "version": "0.8.0",
      "license": "MIT",
```

In `package.json`, replace:

```json
  "name": "@hjr15/blaze-board",
  "version": "0.7.0",
  "description": "A file-based, git-native issue board that AI coding agents can drive. Tickets are markdown; status is the directory.",
```

with:

```json
  "name": "@hjr15/blaze-board",
  "version": "0.8.0",
  "description": "A file-based, git-native issue board that AI coding agents can drive. Tickets are markdown; status is the directory.",
```


- [ ] **Step 4: Run them to verify they pass**, then the neighbours this task touches.

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/package.test.mjs
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/reconcile-delivery-truth.test.mjs tests/shipped-doc-links.test.mjs
```

Expected: all pass. (`npm version 0.8.0 --no-git-tag-version` makes exactly the three version edits below, if you prefer it to editing by hand.)

- [ ] **Step 5: Docs, in the same commit.**

In `docs/decisions/0008-v3-ships-as-hjr15-blaze.md`, replace:

```markdown
  deprecation note is what keeps that cost bounded.
```

with:

```markdown
  deprecation note is what keeps that cost bounded.

## Addendum (2026-10-05, BLZ-674) — one more release of the file-based line: 0.8.0

This ADR is still *Proposed*, and `@hjr15/blaze` has not shipped: the engine in this repository
still publishes as `@hjr15/blaze-board`, and the live board (blaze-pm) still installs it. The
published 0.7.0 predates BLZ-131's squash-body reconcile, so a bundled feature PR's children are
not moved to `done` on that board; and npm never accepts a version twice. The line therefore
gets **one more release, 0.8.0** — a minor, because it also carries the database-mode work
(`blaze db load`/`verify`, `blaze matrices`, `blaze audit --fail-on`). The freeze moves to
0.8.0 on the same terms: the rename decision above is unchanged, and so is the promise that an
existing user is not upgraded by accident.
```

In `docs/guide/why-blaze.md`, replace (1/2):

```markdown
Everything above describes `@hjr15/blaze-board`, the file-based line, and stays
true of it. **`@hjr15/blaze-board` is frozen at 0.7.0.**

```

with:

```markdown
Everything above describes `@hjr15/blaze-board`, the file-based line, and stays
true of it. **`@hjr15/blaze-board` is frozen at 0.8.0**, its last release
([ADR-0008](../decisions/0008-v3-ships-as-hjr15-blaze.md)'s addendum says why there was one
more after 0.7.0).

```

In `docs/guide/why-blaze.md`, replace (2/2):

```markdown
- These ADRs stay in this repo and stay readable without the board.
- `@hjr15/blaze-board@0.7.0` keeps working exactly as this page describes, for as
  long as you keep using it.
```

with:

```markdown
- These ADRs stay in this repo and stay readable without the board.
- `@hjr15/blaze-board@0.8.0` keeps working exactly as this page describes, for as
  long as you keep using it.
```


- [ ] **Step 6: Fence check, commit, prove the committed tree.**

```bash
git add tests/package.test.mjs package-lock.json package.json docs/decisions/0008-v3-ships-as-hjr15-blaze.md docs/guide/why-blaze.md
git diff --cached | grep -c '^+```'      # must print 0
git commit -m "BLZ-674: version 0.8.0 so the next publish carries the squash-body reconcile" -m "package.json and package-lock.json at 0.8.0; tests/package.test.mjs pins it and BLZ-131's bundled-child recovery; ADR-0008 addendum and why-blaze.md record one more release of the file-based line." -- tests/package.test.mjs package-lock.json package.json docs/decisions/0008-v3-ships-as-hjr15-blaze.md docs/guide/why-blaze.md
git status --short                        # must print nothing
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/package.test.mjs   # green on the COMMITTED tree
```


---

### Task 3: `blaze db load` — the board into Postgres, one transaction, one row builder (BLZ-678)

**Files:**
- Create: `tests/db-load.test.mjs`
- Modify: `scripts/db-runner.mjs`
- Modify: `scripts/migrate/load-corpus.mjs`
- Modify: `docs/guide/commands.md`

**Interfaces:**
- Consumes: `fsReadStorage` (sync `listTickets`), `parseAcBlocks`, `storableEstimate`, `extraFields`, `counterUpsertSql`, `seedCounter`, `corpusMaxima`, `openCheckedPg`, `pgExec`, `describePgTarget`.
- Produces (`scripts/migrate/load-corpus.mjs`):
  - `TICKET_COLUMNS: string[]` — the 28 `ticket` columns both executors insert, in order.
  - `corpusRows(source, projectsDir, { today }) → { tickets: Row[], maxNum: Map<prefix, n>, report }` — `Row = { id, project, type, values (TICKET_COLUMNS order), acHeading, labels, components, ac, worklog: {date, minutes, note}[], worklogDropped: {id, minutes}[], parent, links: {type, target}[] }`.
  - `relationRows(tickets, typeById: Map<id, type>) → { parents: {id, parent, parentType}[], links: {src, type, target}[], danglingParents, danglingLinks }`.
  - `loadCorpus(db, projectsDir, { source, today }) → tally` — unchanged signature and shape.
  - `loadCorpusAsync(exec, projectsDir, { source, today, dialect }) → Promise<tally & { typeById }>` — runs INSIDE the caller's transaction; leaves `acceptance_criterion`/`ac_heading` empty.
- Produces (`runDb`): `blaze db load [--replace]` — exit 0 loaded, 1 refused or failed (nothing written).

- [ ] **Step 1: Write the failing tests.**

Create `tests/db-load.test.mjs`:

```js
// tests/db-load.test.mjs — BLZ-678, `blaze db load`: the board's tickets into Postgres.
//
// One row builder (`corpusRows`), two executors (the sync SQLite `loadCorpus`, the async
// `loadCorpusAsync`). The first block proves the executors cannot drift without a server; the
// Postgres block proves the command: one transaction, refuses a non-empty table unless
// --replace, all-or-nothing on a refused row, and the counter seeded from what loaded.
// Each Postgres test gets its OWN scratch database. Run with --test-concurrency=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_DDL, SQLITE_PRAGMAS } from "../scripts/model/sqlite-schema.mjs";
import { corpusRows, relationRows, loadCorpus, loadCorpusAsync } from "../scripts/migrate/load-corpus.mjs";
import { fsReadStorage } from "../scripts/model/read-storage.mjs";
import { sqliteExec } from "../scripts/model/write-port-resolve.mjs";
import { postgresReader } from "../scripts/model/pg-storage.mjs";
import { writeClaim } from "../scripts/model/claims.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { dbBoard } from "./helpers/db-board.mjs";
import { PG, PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pgHost = () => escapeRegExp(new URL(PG).hostname);

/** dbBoard()'s ENG-1, plus ENG-2: a child of ENG-1 that Blocks it, with a repeated label, a
 *  worklog entry, a sub-half-minute worklog entry, and a link to a ticket that does not exist. */
function board() {
  const roots = dbBoard();
  writeFileSync(join(roots.projectsDir, "ENG", "defined", "ENG-2-b.md"),
    ["---", "id: ENG-2", "title: B task", "type: task", "project: ENG", "priority: high",
     "assignee: unassigned", "estimate: 15", "parent: ENG-1", "labels: [x, y, x]",
     "created: 2026-01-02", "updated: 2026-01-03",
     "worklog:", "  - { date: 2026-01-03, minutes: 10, note: first }", "  - { date: 2026-01-03, minutes: 0.2 }",
     "links:", "  - { type: Blocks, target: ENG-1 }", "  - { type: Relates, target: ENG-99 }",
     "---", "", "B body", ""].join("\n"));
  return roots;
}

const capture = () => {
  const out = [];
  const io = { log: (s) => out.push(String(s)), err: (s) => out.push(String(s)), env: {} };
  return { io, text: () => out.join("\n") };
};
const pgIo = (url) => ({
  resolveDbConfig: () => ({ driver: "postgres", connection: url }),
  openPostgresClient: (c) => pgClient(c),
});
const count = async (url, sql) => {
  const c = await pgClient(url);
  try { return Number((await c.query(sql)).rows[0].n); } finally { await c.end(); }
};

test("corpusRows builds once: repeated labels collapse, a dropped worklog is named, links stay raw", () => {
  const { projectsDir } = board();
  const { tickets, maxNum, report } = corpusRows(fsReadStorage, projectsDir, { today: "2026-10-05" });
  const two = tickets.find((t) => t.id === "ENG-2");
  assert.deepEqual(two.labels, ["x", "y"], "a repeated label is one row — the PK refuses the second");
  assert.deepEqual(two.worklog, [{ date: "2026-01-03", minutes: 10, note: "first" }]);
  assert.deepEqual(two.worklogDropped, [{ id: "ENG-2", minutes: "0.2" }]);
  assert.equal(two.parent, "ENG-1");
  assert.equal(two.links.length, 2, "dangling is decided by the executor, against what loaded");
  assert.deepEqual([...maxNum], [["ENG", 2]]);
  assert.equal(report.tickets, 0, "the builder inserts nothing, so it counts no loaded ticket");
});

test("relationRows links only what loaded: a dangling link and parent are counted, never forged", () => {
  const { projectsDir } = board();
  const { tickets } = corpusRows(fsReadStorage, projectsDir);
  const all = relationRows(tickets, new Map([["ENG-1", "task"], ["ENG-2", "task"]]));
  assert.deepEqual(all.parents, [{ id: "ENG-2", parent: "ENG-1", parentType: "task" }]);
  assert.deepEqual(all.links, [{ src: "ENG-2", type: "Blocks", target: "ENG-1" }]);
  assert.equal(all.danglingLinks, 1);
  const withoutOne = relationRows(tickets, new Map([["ENG-2", "task"]]));   // ENG-1 refused
  assert.equal(withoutOne.danglingParents, 1);
  assert.equal(withoutOne.danglingLinks, 2);
});

test("the two executors cannot drift: async over SQLite tallies exactly what the sync loader does", async () => {
  const { projectsDir } = board();
  const sync = new DatabaseSync(":memory:");
  sync.exec(SQLITE_PRAGMAS); sync.exec(SQLITE_DDL);
  const a = loadCorpus(sync, projectsDir, { today: "2026-10-05" });

  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_PRAGMAS); db.exec(SQLITE_DDL);
  const exec = sqliteExec(db);
  exec.run("BEGIN", []);
  const { typeById, ...b } = await loadCorpusAsync(exec, projectsDir, { today: "2026-10-05", dialect: "sqlite" });
  exec.run("COMMIT", []);

  // The tally agrees on everything except the derived AC index, which only the shadow fills.
  const drop = ({ criteria, notes, acHeadings, ...rest }) => rest;
  assert.deepEqual(drop(b), drop(a));
  assert.deepEqual([...typeById.keys()].sort(), ["ENG-1", "ENG-2"]);
  for (const t of ["ticket", "ticket_link", "ticket_label", "worklog_entry"]) {
    assert.equal(db.prepare(`SELECT count(*) n FROM ${t}`).get().n, sync.prepare(`SELECT count(*) n FROM ${t}`).get().n, t);
  }
  assert.equal(db.prepare("SELECT count(*) n FROM acceptance_criterion").get().n, 0,
    "the async executor leaves the derived AC index empty (spec §5.2)");
  assert.equal(sync.prepare("SELECT count(*) n FROM acceptance_criterion").get().n, 1);
  assert.equal(b.labels, 2, "x, y — the repeated x is not a row and is not counted");
});

test("an unknown dialect is refused before anything runs", async () => {
  await assert.rejects(loadCorpusAsync({ run() {}, all() { return []; } }, "/nowhere", { dialect: "mysql" }),
    /unknown dialect "mysql"/);
});

test("acceptance: init → load → the reader holds the board; the counter follows the highest CLAIM",
     PG_SKIP, async () => {
  const db = await scratchPgDb("load");
  try {
    const roots = board();
    writeClaim(roots.projectsDir, "ENG", 9, "claimed-no-ticket");
    assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    const c = capture();
    assert.equal(await runDb(["load"], { ...c.io, roots, ...pgIo(db.url) }), 0, c.text());
    assert.match(c.text(), new RegExp(`loaded ${pgHost()}/${db.name}`));
    assert.match(c.text(), /tickets\s+2/);
    assert.match(c.text(), /links\s+1/);
    assert.match(c.text(), /dangling links dropped: 1/);
    assert.match(c.text(), /worklog entries dropped: 1/);
    assert.match(c.text(), /ENG\s+9 → 9/, "init already seeded 9 from the claim; load keeps it");
    assert.match(c.text(), /blaze db verify/);

    const client = await pgClient(db.url);
    try {
      const two = (await postgresReader(client).getTicket(null, "ENG-2")).found;
      assert.equal(two.frontmatter.parent, "ENG-1");
      assert.deepEqual(two.frontmatter.labels, ["x", "y"]);
      assert.deepEqual(two.frontmatter.links, [{ type: "Blocks", target: "ENG-1" }]);
      assert.deepEqual(two.frontmatter.worklog, [{ date: "2026-01-03", minutes: 10, note: "first" }]);
      assert.equal(two.frontmatter.created, "2026-01-02");
      assert.match(two.body, /B body/);
    } finally { await client.end(); }
    assert.equal(await count(db.url, "SELECT count(*) n FROM acceptance_criterion"), 0);
    assert.equal(await count(db.url, "SELECT n FROM project_counter WHERE project_key = 'ENG'"), 9);
  } finally { await db.drop(); }
});

test("a second load is REFUSED and changes nothing; --replace reloads and never lowers the counter",
     PG_SKIP, async () => {
  const db = await scratchPgDb("reload");
  try {
    const roots = board();
    assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    assert.equal(await runDb(["load"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    const c1 = await pgClient(db.url);
    try { await c1.query("UPDATE project_counter SET n = 40 WHERE project_key = 'ENG'"); } finally { await c1.end(); }

    const again = capture();
    assert.equal(await runDb(["load"], { ...again.io, roots, ...pgIo(db.url) }), 1);
    assert.match(again.text(), /already holds 2 ticket\(s\)\. Nothing was loaded/);
    assert.match(again.text(), /blaze db verify/);
    assert.match(again.text(), /--replace/);

    const rep = capture();
    assert.equal(await runDb(["load", "--replace"], { ...rep.io, roots, ...pgIo(db.url) }), 0, rep.text());
    assert.match(rep.text(), /--replace: the previous tickets were erased first/);
    assert.equal(await count(db.url, "SELECT count(*) n FROM ticket"), 2);
    assert.equal(await count(db.url, "SELECT count(*) n FROM ticket_link"), 1);
    assert.equal(await count(db.url, "SELECT n FROM project_counter WHERE project_key = 'ENG'"), 40,
      "a number already issued is never issued again — --replace does not reset the counter");
  } finally { await db.drop(); }
});

test("a row Postgres refuses rolls the WHOLE load back and names every refusal", PG_SKIP, async () => {
  const db = await scratchPgDb("refused");
  try {
    const roots = board();
    // Filed under ENG, but its id is lower-case: ticket's CHECK (id = project_key || '-' || num)
    // refuses it. The builder cannot know that; the database can.
    mkdirSync(join(roots.projectsDir, "ENG", "done"), { recursive: true });
    writeFileSync(join(roots.projectsDir, "ENG", "done", "eng-7-bad.md"),
      ["---", "id: eng-7", "title: bad", "type: task", "project: ENG", "---", "", "x", ""].join("\n"));
    assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    const c = capture();
    assert.equal(await runDb(["load"], { ...c.io, roots, ...pgIo(db.url) }), 1);
    assert.match(c.text(), /refused 1 row\(s\), so NOTHING was loaded/);
    assert.match(c.text(), /eng-7: .*check constraint/i);
    assert.equal(await count(db.url, "SELECT count(*) n FROM ticket"), 0, "ENG-1 and ENG-2 rolled back too");
  } finally { await db.drop(); }
});

test("load refuses a SQLite board, a database with no schema, and BLAZE_READONLY", PG_SKIP, async () => {
  const db = await scratchPgDb("loadrefuse");
  try {
    const roots = board();
    const sq = capture();
    assert.equal(await runDb(["load"], { ...sq.io, roots, resolveDbConfig: () => ({ driver: "sqlite" }) }), 1);
    assert.match(sq.text(), /loads a Postgres database/);

    const empty = capture();
    assert.equal(await runDb(["load"], { ...empty.io, roots, ...pgIo(db.url) }), 1);
    assert.match(empty.text(), /has no Blaze schema/);
    assert.match(empty.text(), /blaze db init/);

    const ro = capture();
    assert.equal(await runDb(["load"], { ...ro.io, env: { BLAZE_READONLY: "1" }, roots, ...pgIo(db.url) }), 1);
    assert.match(ro.text(), /read-only mode \(BLAZE_READONLY=1\) — refusing to run blaze db load/);
  } finally { await db.drop(); }
});
```


- [ ] **Step 2: Run them to verify they fail.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/db-load.test.mjs
```

Expected: the file fails to load — `SyntaxError: The requested module '../scripts/migrate/load-corpus.mjs' does not provide an export named 'corpusRows'`.

- [ ] **Step 3: Implement.**

In `scripts/db-runner.mjs`, replace (1/8):

```js
// scripts/db-runner.mjs — `blaze db init|status` (BLZ-299).
//
```

with:

```js
// scripts/db-runner.mjs — `blaze db init|seed-counter|load|status` (BLZ-299).
//
```

In `scripts/db-runner.mjs`, replace (2/8):

```js
import { corpusMaxima, seedCounter } from "./model/seed-counter.mjs";
import { WRITE_PORT_ENV } from "./model/write-port.mjs";
```

with:

```js
import { corpusMaxima, seedCounter } from "./model/seed-counter.mjs";
import { loadCorpusAsync } from "./migrate/load-corpus.mjs";
import { WRITE_PORT_ENV } from "./model/write-port.mjs";
```

In `scripts/db-runner.mjs`, replace (3/8):

```js
                this board into it. Postgres: create the schema and seed the id counter
                (the board's tickets are NOT loaded — that is the BLZ-254 migration)
  seed-counter  raise the db-mode id counter to every number already taken (ticket files,
                .ids/ claims, database rows). Run it immediately before BLAZE_WRITE_PORT=db
  status        what the database holds, and what the dual-write soak has found

  --force       with init, SQLite only: replace an existing shadow database
`;
```

with:

```js
                this board into it. Postgres: create the schema and seed the id counter
                (the board's tickets are NOT loaded — run 'blaze db load' next)
  seed-counter  raise the db-mode id counter to every number already taken (ticket files,
                .ids/ claims, database rows). Run it immediately before BLAZE_WRITE_PORT=db
  load          Postgres only: load this board's tickets into the database, in one
                transaction, then raise the id counter. Refuses a database that already
                holds tickets unless --replace
  status        what the database holds, and what the dual-write soak has found

  --force       with init, SQLite only: replace an existing shadow database
  --replace     with load: empty the ticket tables first, in the same transaction
`;
```

In `scripts/db-runner.mjs`, replace (4/8):

```js
    log("\nThe board's tickets were NOT loaded — Postgres holds the schema and the counter only.");
    return 0;
```

with:

```js
    log("\nThe board's tickets were NOT loaded — Postgres holds the schema and the counter only.");
    log("Load them with 'blaze db load', then check the load with 'blaze db verify'.");
    return 0;
```

In `scripts/db-runner.mjs`, replace (5/8):

```js
    await close();
  }
```

with:

```js
    await close();
  }
}

/** BLZ-678: the tables `blaze db load --replace` empties — the ticket corpus and its history.
 *  NOT `project_counter`: a number already issued must never be issued again, so the counter
 *  is only ever raised (seedCounter), never reset. */
const LOAD_TABLES = ["ticket_link", "ticket_label", "ticket_component", "worklog_entry",
                     "acceptance_criterion", "ticket_event", "ticket"];

/**
 * BLZ-678: `blaze db load [--replace]` — the board's tickets into Postgres (spec §5.2).
 *
 * ONE TRANSACTION, ALL OR NOTHING. The emptiness check, a `--replace` truncate, the load and
 * the counter seed commit together. A row the database refuses is counted (each ticket runs
 * under a savepoint, so every refusal is named, not just the first) and then the WHOLE load is
 * rolled back: a half-loaded board is one `blaze db verify` would only fail, and a re-run would
 * then need `--replace` to get past the rows the failed run left behind.
 *
 * Refuses a database that already holds tickets unless `--replace`. After the cutover that
 * database IS the board, and `--replace` erases its tickets and their event history — which is
 * why it is never the default.
 */
async function loadCmd(ctx) {
  const { projectsDir, log, err, openPgClient, replace } = ctx;
  const dbConfig = dbConfigOr(ctx);
  if (!dbConfig || !writableOr(ctx, "load")) return 1;
  if (dbConfig.driver !== "postgres") {
    err("blaze db load: loads a Postgres database. The SQLite shadow is loaded by 'blaze db init'");
    err("(pass --force there to rebuild it).");
    return 1;
  }
  let client;
  try { client = await openCheckedPg(dbConfig.connection, openPgClient); }
  catch (e) { err(e.message); return 1; }
  const exec = pgExec(client);
  const where = describePgTarget(dbConfig.connection);
  try {
    await exec.run("BEGIN", []);
    let tally, seeded;
    try {
      const held = Number((await exec.all("SELECT count(*) AS n FROM ticket", []))[0].n);
      if (held > 0 && !replace) {
        await exec.run("ROLLBACK", []);
        err(`blaze db load: ${where} already holds ${held} ticket(s). Nothing was loaded.`);
        err("To check them against this board instead, run 'blaze db verify'. To erase them —");
        err("their event history included — and load this board in their place, pass --replace.");
        return 1;
      }
      if (replace) await exec.run(`TRUNCATE ${LOAD_TABLES.join(", ")}`, []);
      tally = await loadCorpusAsync(exec, projectsDir, {
        source: fsReadStorage, today: new Date().toISOString().slice(0, 10), dialect: "postgres" });
      if (tally.skipped.insertFailed.length) {
        await exec.run("ROLLBACK", []);
        err(`blaze db load: ${where} refused ${tally.skipped.insertFailed.length} row(s), so NOTHING was loaded:`);
        for (const f of tally.skipped.insertFailed) err(`  ${f.id}: ${f.reason}`);
        return 1;
      }
      // Spec §5.2: the counter is seeded from what was just loaded (seedCounter reads the
      // ticket table's MAX inside this transaction) and from the files and `.ids/` claims, so
      // the load and the counter cannot disagree.
      seeded = await seedCounter(exec,
        await corpusMaxima({ projectsDir, readStorage: fsReadStorage }), { dialect: "postgres" });
      await exec.run("COMMIT", []);
    } catch (e) {
      try { await exec.run("ROLLBACK", []); } catch { /* the original error is what matters */ }
      err(`blaze db load: ${where} — ${e.message}`);
      err("Nothing was loaded: the load runs in one transaction.");
      return 1;
    }
    log(`loaded ${where}${replace ? "  (--replace: the previous tickets were erased first)" : ""}`);
    log(`  tickets      ${tally.tickets}`);
    log(`  links        ${tally.links}`);
    log(`  worklog      ${tally.worklog}`);
    log(`  labels       ${tally.labels}   components ${tally.components}`);
    // Every substitution is named (BLZ-280). A tally that reports only successes cannot be trusted.
    if (tally.titleFallbacks) log(`  ⚠ titles substituted from id: ${tally.titleFallbacks}`);
    if (tally.danglingParents) log(`  ⚠ dangling parents counted: ${tally.danglingParents}`);
    if (tally.danglingLinks) log(`  ⚠ dangling links dropped: ${tally.danglingLinks}`);
    if (tally.skipped.worklogDropped.length) log(`  ⚠ worklog entries dropped: ${tally.skipped.worklogDropped.length}`);
    if (tally.skipped.noId || tally.skipped.badId) {
      log(`  ⚠ files skipped: ${tally.skipped.noId} with no id, ${tally.skipped.badId} with a malformed id`);
    }
    log("id counter seeded:");
    printSeed(seeded, log);
    log("\nNow check it: blaze db verify");
    return 0;
  } finally {
    try { await client.end(); } catch { /* already closed */ }
  }
```

In `scripts/db-runner.mjs`, replace (6/8):

```js
  const force = argv.includes("--force");
  if (!cmd || argv.includes("--help") || argv.includes("-h")) { log(USAGE); return cmd ? 0 : 1; }
```

with:

```js
  const force = argv.includes("--force");
  const replace = argv.includes("--replace");
  if (!cmd || argv.includes("--help") || argv.includes("-h")) { log(USAGE); return cmd ? 0 : 1; }
```

In `scripts/db-runner.mjs`, replace (7/8):

```js
  // so a test drives the Postgres branch against a scratch database.
  const ctx = { dataRoot: roots.dataRoot, projectsDir: roots.projectsDir, force, log, err,
                resolveDbConfig: io.resolveDbConfig ?? resolveDatabaseConfig,
```

with:

```js
  // so a test drives the Postgres branch against a scratch database.
  const ctx = { dataRoot: roots.dataRoot, projectsDir: roots.projectsDir, force, replace, log, err,
                resolveDbConfig: io.resolveDbConfig ?? resolveDatabaseConfig,
```

In `scripts/db-runner.mjs`, replace (8/8):

```js
  if (cmd === "seed-counter") return seedCounterCmd(ctx);
  if (cmd === "status") return status(ctx);
```

with:

```js
  if (cmd === "seed-counter") return seedCounterCmd(ctx);
  if (cmd === "load") return loadCmd(ctx);
  if (cmd === "status") return status(ctx);
```

Replace the whole of `scripts/migrate/load-corpus.mjs` with:

```js
// scripts/migrate/load-corpus.mjs — load the filesystem board into a database (BLZ-280,
// BLZ-678).
//
// A MIGRATION HARNESS, not a shipped feature. Its job is to move the corpus once and
// to prove, by counting, that nothing was lost doing it. ADR-0006 declined a git
// mirror precisely so this stays one-directional and disposable.
//
// It reports rather than asserts. A loader that throws on the first odd ticket in a
// 2,500-ticket corpus tells you about one problem; one that loads what it can and
// hands back a tally tells you about all of them, which is what you need before
// cutover. Nothing is silently dropped — every skip is counted and named.
//
// BLZ-678: ONE ROW BUILDER, TWO EXECUTORS. `corpusRows` turns the corpus into rows and is
// pure; `loadCorpus` (sync, node:sqlite — `blaze db init`'s shadow) and `loadCorpusAsync`
// (an `exec`, either dialect — `blaze db load` on Postgres) only insert what it built. Two
// loaders that each normalised a ticket would drift, and the drift would be invisible until
// the oracle ran — so the normalising lives in exactly one place.
import { parseAcBlocks } from "../model/ac-blocks.mjs";
import { storableEstimate } from "../model/time.mjs";
import { extraFields } from "../model/write-port.mjs";
import { fsReadStorage } from "../model/read-storage.mjs";
import { counterUpsertSql } from "../model/seed-counter.mjs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Frontmatter dates are authored by hand; a bad one must not abort the load. */
function isoDate(v, fallback) {
  const s = String(v ?? "").trim();
  return ISO_DATE.test(s) ? s : fallback;
}

/** estimate is text in frontmatter and an integer here; 242 tickets have none. */
// `storableEstimate` is time.mjs's one rule, shared with write-port.mjs. These two disagreed
// three ways about `estimate: 7` until it existed.
const estimate = storableEstimate;

const nzs = (v) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};
const asList = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean)
  : typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);
/** First occurrence wins. The tables' primary keys refuse a repeat, so a repeat is not a row,
 *  and a tally that counted it would disagree with the table it describes (BLZ-679's gate). */
const unique = (xs) => [...new Set(xs)];

/** The `ticket` columns both executors insert, in order. `parent_id`/`parent_type` are set by
 *  pass two, once every ticket exists. */
export const TICKET_COLUMNS = [
  "id", "project_key", "num", "type", "status", "title", "priority", "resolution",
  "assignee", "estimate_minutes", "sprint_id", "start_date", "due_date",
  "constraint_start_no_earlier_than", "deadline", "body", "ac_heading", "created_on", "updated_on",
  "branch", "pr", "ref", "category", "verification", "derived", "likelihood", "impact", "extra_json",
];

/** The tally's starting shape — one definition, so the two executors cannot report differently. */
function emptyReport() {
  return {
    tickets: 0, links: 0, worklog: 0, criteria: 0, notes: 0, acHeadings: 0,
    labels: 0, components: 0,
    skipped: { worklogDropped: [], noId: 0, badId: 0, insertFailed: [] },
    danglingLinks: 0, danglingParents: 0,
    // A ticket with no title still loads — losing it would be worse — but the id is
    // substituted, and substituting is inventing. Counted so the tally never claims a
    // clean load when 40 titles were manufactured.
    titleFallbacks: 0,
    // A field the source simply did not carry, given the schema's documented default.
    // Applying a default is correct — the read path does it too — but it is still a
    // value the source did not state, so it is counted rather than assumed away.
    defaultsApplied: { priority: 0, assignee: 0 },
  };
}

/**
 * The pure half: every well-formed ticket as the rows it becomes. Reads `source` once and
 * touches no database.
 *
 * @param source       a SYNC read driver (`listTickets(projectsDir)`), the filesystem by default
 * @returns { tickets, maxNum, report } — `report` carries the build-time counts (noId, badId,
 *          titleFallbacks, defaultsApplied); the executor adds what only inserting can know.
 */
export function corpusRows(source, projectsDir, { today = null } = {}) {
  const now = today ?? new Date().toISOString().slice(0, 10);
  const report = emptyReport();
  const tickets = [];
  // BLZ-667: the highest number the corpus holds, per id prefix — what project_counter is
  // seeded from. Taken from every well-formed id, INCLUDING a row the database then refuses:
  // that ticket still exists on disk, so its number is still taken.
  const maxNum = new Map();

  for (const t of [...source.listTickets(projectsDir)]) {
    const fm = t.frontmatter ?? {};
    const id = String(fm.id ?? "").trim();
    if (!id) { report.skipped.noId++; continue; }
    const [key, numRaw] = id.split("-");
    const num = Number(numRaw);
    if (!key || !Number.isFinite(num) || num <= 0) { report.skipped.badId++; continue; }
    if (Number.isInteger(num) && num > (maxNum.get(key) ?? 0)) maxNum.set(key, num);

    const ac = parseAcBlocks(t.body);
    const title = String(fm.title ?? "").trim() || id;
    if (title === id && String(fm.title ?? "").trim() === "") report.titleFallbacks++;
    const priority = String(fm.priority ?? "").trim() || "medium";
    if (!String(fm.priority ?? "").trim()) report.defaultsApplied.priority++;
    const assignee = String(fm.assignee ?? "").trim() || "unassigned";
    if (!String(fm.assignee ?? "").trim()) report.defaultsApplied.assignee++;

    // Worklog: Math.round because `minutes` is INTEGER and STRICT refuses a REAL. COUNTED,
    // never silently skipped — `Math.round(0.4)` is 0, and this file's header promises every
    // skip is named (BLZ-393).
    const worklog = [], worklogDropped = [];
    for (const w of Array.isArray(fm.worklog) ? fm.worklog : []) {
      const m = Math.round(Number(w?.minutes));
      if (!Number.isFinite(m) || m <= 0) { worklogDropped.push({ id, minutes: w?.minutes ?? null }); continue; }
      worklog.push({ date: isoDate(w.date, now), minutes: m, note: w.note ?? null });
    }

    tickets.push({
      id, project: t.project ?? key, type: String(fm.type ?? "task"),
      values: [
        id, t.project ?? key, num, String(fm.type ?? "task"), t.status,
        title, priority,
        String(fm.resolution ?? "") || null,
        assignee,
        estimate(fm.estimate), String(fm.sprint ?? "") || null,
        isoDate(fm.start, null), isoDate(fm.due, null),
        // BLZ-391: ADR-0022's two constraint columns arrived with PR #110 and this loader
        // predates them, so a migrated ticket lost its `not_before`/`deadline` outright.
        isoDate(fm.not_before, null), isoDate(fm.deadline, null),
        t.body ?? "", ac.heading,
        isoDate(fm.created, now), isoDate(fm.updated, now),
        nzs(fm.branch), nzs(fm.pr), nzs(fm.ref), nzs(fm.category),
        nzs(fm.verification), nzs(fm.derived), nzs(fm.likelihood), nzs(fm.impact),
        JSON.stringify(extraFields(fm)),
      ],
      acHeading: ac.heading,
      // BLZ-295. Without these the migration silently dropped every one of them: 926 of
      // 2,561 tickets (36.2%) carry at least one, and extra_json is what keeps the
      // round-trip promise for keys nobody has thought of yet.
      labels: unique(asList(fm.labels)),
      components: unique(asList(fm.components)),
      ac: ac.blocks,
      worklog, worklogDropped,
      parent: String(fm.parent ?? "").trim(),
      links: (Array.isArray(fm.links) ? fm.links : [])
        .filter((l) => l?.type && l?.target)
        .map((l) => ({ type: String(l.type), target: String(l.target) })),
    });
  }
  return { tickets, maxNum, report };
}

/**
 * Pass two, pure: parents and links between the tickets that ACTUALLY LOADED. Doing it in one
 * pass would make load order decide which foreign keys survive — exactly the silent,
 * order-dependent loss this harness exists to rule out. A link to a ticket that did not load is
 * counted and dropped, never forged; a repeated link is one row.
 *
 * @param typeById  Map<id, type> of the tickets the executor inserted
 */
export function relationRows(tickets, typeById) {
  const parents = [], links = [];
  let danglingParents = 0, danglingLinks = 0;
  const seen = new Set();
  for (const t of tickets) {
    if (!typeById.has(t.id)) continue;
    if (t.parent) {
      if (typeById.has(t.parent)) parents.push({ id: t.id, parent: t.parent, parentType: typeById.get(t.parent) });
      else danglingParents++;   // counted, never invented
    }
    for (const l of t.links) {
      if (!typeById.has(l.target)) { danglingLinks++; continue; }
      const k = `${t.id}\u0000${l.type}\u0000${l.target}`;
      if (seen.has(k)) continue;
      seen.add(k);
      links.push({ src: t.id, type: l.type, target: l.target });
    }
  }
  return { parents, links, danglingParents, danglingLinks };
}

/**
 * The sync executor: node:sqlite, its own transaction. `blaze db init`'s shadow loader.
 *
 * @param db      an open SQLite handle with the schema applied
 * @param source  a read driver (defaults to the filesystem)
 * @returns a tally: what loaded, what was skipped, and why
 */
export function loadCorpus(db, projectsDir, { source = fsReadStorage, today = null } = {}) {
  const { tickets, maxNum, report } = corpusRows(source, projectsDir, { today });
  const insTicket = db.prepare(
    `INSERT INTO ticket (${TICKET_COLUMNS.join(", ")}) VALUES (${TICKET_COLUMNS.map(() => "?").join(",")})`);
  const insLabel = db.prepare(
    "INSERT OR IGNORE INTO ticket_label (ticket_id, project_key, label, ord) VALUES (?,?,?,?)");
  const insComponent = db.prepare(
    "INSERT OR IGNORE INTO ticket_component (ticket_id, project_key, component, ord) VALUES (?,?,?,?)");
  const setParent = db.prepare("UPDATE ticket SET parent_id = ?, parent_type = ? WHERE id = ?");
  const insLink = db.prepare("INSERT OR IGNORE INTO ticket_link VALUES (?,?,?)");
  const insWork = db.prepare("INSERT INTO worklog_entry (ticket_id,on_date,minutes,note) VALUES (?,?,?,?)");
  const insAc = db.prepare("INSERT INTO acceptance_criterion (ticket_id,ord,kind,text,checked) VALUES (?,?,?,?,?)");

  const typeById = new Map();
  db.exec("BEGIN");
  for (const t of tickets) {
    try {
      insTicket.run(...t.values);
      t.labels.forEach((l, ord) => insLabel.run(t.id, t.project, l, ord));
      t.components.forEach((c, ord) => insComponent.run(t.id, t.project, c, ord));
    } catch (e) {
      // Named, not swallowed: the tally is only trustworthy if a refusal is visible.
      report.skipped.insertFailed.push({ id: t.id, reason: String(e.message).slice(0, 120) });
      continue;
    }
    report.tickets++;
    report.labels += t.labels.length;
    report.components += t.components.length;
    typeById.set(t.id, t.type);
    if (t.acHeading) report.acHeadings++;
    for (const [i, b] of t.ac.entries()) {
      insAc.run(t.id, i, b.kind, b.text, b.kind === "criterion" && b.checked ? 1 : 0);
      b.kind === "criterion" ? report.criteria++ : report.notes++;
    }
    report.skipped.worklogDropped.push(...t.worklogDropped);
    for (const w of t.worklog) {
      // The try/catch because a single bad worklog row once killed the entire load with an
      // uncaught throw and left the BEGIN uncommitted. Now it is a counted skip like any other.
      try {
        insWork.run(t.id, w.date, w.minutes, w.note);
        report.worklog++;
      } catch (e) {
        report.skipped.insertFailed.push({ id: t.id, reason: `worklog: ${String(e.message).slice(0, 100)}` });
      }
    }
  }

  const rel = relationRows(tickets, typeById);
  for (const p of rel.parents) setParent.run(p.parent, p.parentType, p.id);
  for (const l of rel.links) insLink.run(l.src, l.type, l.target);
  report.links = rel.links.length;
  report.danglingParents = rel.danglingParents;
  report.danglingLinks = rel.danglingLinks;

  // BLZ-667: seed the db-mode allocator, so its first number follows the corpus's last
  // rather than colliding with it. The MAX, not the count — numbering has gaps. And never
  // lower an existing counter: a number already issued must not be issued twice.
  // BLZ-668: the upsert is spelled once, in seed-counter.mjs, for both dialects.
  const seed = db.prepare(counterUpsertSql("sqlite"));
  for (const [key, n] of maxNum) seed.run(key, n);
  db.exec("COMMIT");
  return report;
}

/**
 * The async executor (BLZ-678): the same rows through an `exec` ({run, all}, awaited), with
 * either dialect's placeholders. `blaze db load` runs it on Postgres.
 *
 * It does NOT open or close a transaction — the CALLER owns the one transaction the whole load
 * runs in (spec §5.2), so the refusal check, a `--replace` truncate, this load and the counter
 * seed commit or roll back together. Each ticket runs under its own SAVEPOINT: on Postgres a
 * failed statement aborts the whole transaction, and the savepoint is what lets one refused row
 * be counted and skipped — the same "load what it can, tally the rest" promise the sync
 * executor keeps.
 *
 * `acceptance_criterion` and `ac_heading` are left EMPTY (spec §5.2). They are a derived index:
 * nothing in db mode reads them — the reader returns `body` verbatim, criteria included — and
 * `dbWritePort` does not maintain them, so filling them here would plant rows that the first
 * db-mode edit leaves stale. SQLite-shadow-only.
 *
 * @returns the tally, same shape as `loadCorpus`'s, plus `typeById` for callers that link to
 *          the loaded set (the transition import)
 */
export async function loadCorpusAsync(exec, projectsDir, { source = fsReadStorage, today = null,
                                                          dialect = "postgres" } = {}) {
  if (dialect !== "sqlite" && dialect !== "postgres") {
    throw new Error(`unknown dialect ${JSON.stringify(dialect)} — expected 'sqlite' or 'postgres'`);
  }
  const ph = (i) => (dialect === "postgres" ? `$${i + 1}` : "?");
  const list = (n) => Array.from({ length: n }, (_, i) => ph(i)).join(", ");
  const { tickets, report } = corpusRows(source, projectsDir, { today });
  const AC_HEADING = TICKET_COLUMNS.indexOf("ac_heading");

  const typeById = new Map();
  for (const t of tickets) {
    await exec.run("SAVEPOINT blaze_load_ticket", []);
    try {
      const values = [...t.values];
      values[AC_HEADING] = null;
      await exec.run(`INSERT INTO ticket (${TICKET_COLUMNS.join(", ")}) VALUES (${list(TICKET_COLUMNS.length)})`, values);
      for (const [table, col, vals] of [["ticket_label", "label", t.labels], ["ticket_component", "component", t.components]]) {
        for (const [ord, v] of vals.entries()) {
          await exec.run(`INSERT INTO ${table} (ticket_id, project_key, ${col}, ord) VALUES (${list(4)})`,
                         [t.id, t.project, v, ord]);
        }
      }
      for (const w of t.worklog) {
        await exec.run(`INSERT INTO worklog_entry (ticket_id, on_date, minutes, note) VALUES (${list(4)})`,
                       [t.id, w.date, w.minutes, w.note]);
      }
      await exec.run("RELEASE SAVEPOINT blaze_load_ticket", []);
    } catch (e) {
      await exec.run("ROLLBACK TO SAVEPOINT blaze_load_ticket", []);
      await exec.run("RELEASE SAVEPOINT blaze_load_ticket", []);
      // Named, not swallowed — and the WHOLE ticket goes, worklog included: a half-loaded
      // ticket is a value diff the oracle would have to explain.
      report.skipped.insertFailed.push({ id: t.id, reason: String(e.message).slice(0, 120) });
      continue;
    }
    report.tickets++;
    report.labels += t.labels.length;
    report.components += t.components.length;
    report.worklog += t.worklog.length;
    report.skipped.worklogDropped.push(...t.worklogDropped);
    typeById.set(t.id, t.type);
  }

  const rel = relationRows(tickets, typeById);
  for (const p of rel.parents) {
    await exec.run(`UPDATE ticket SET parent_id = ${ph(0)}, parent_type = ${ph(1)} WHERE id = ${ph(2)}`,
                   [p.parent, p.parentType, p.id]);
  }
  for (const l of rel.links) {
    await exec.run(`INSERT INTO ticket_link (src_id, link_type, target_id) VALUES (${list(3)})`,
                   [l.src, l.type, l.target]);
  }
  report.links = rel.links.length;
  report.danglingParents = rel.danglingParents;
  report.danglingLinks = rel.danglingLinks;
  return { ...report, typeById };
}
```


- [ ] **Step 4: Run them to verify they pass**, then the neighbours this task touches.

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/db-load.test.mjs
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/migrate/*.test.mjs tests/db-runner.test.mjs tests/db-runner-pg.test.mjs tests/model/read-seam-projection.test.mjs tests/model/seam-closure.test.mjs
```

Expected: 8/8 pass in `tests/db-load.test.mjs` (4 skip without Postgres), and every neighbour green — `tests/migrate/load-corpus.test.mjs`'s assertions are unchanged.

- [ ] **Step 5: Docs, in the same commit.**

In `docs/guide/commands.md`, replace (1/3):

```markdown
| [`migrate`](#migrate) | Import tickets from an external tracker | with `--live` |
| [`db`](#db) | Create the database schema, seed its id counter, report the dual-write soak | yes (`init`, `seed-counter`); no (`status`) |
| [`user`](#user) | Add a board user and issue its API token | yes |
```

with:

```markdown
| [`migrate`](#migrate) | Import tickets from an external tracker | with `--live` |
| [`db`](#db) | Create the database schema, load the board into Postgres, seed its id counter, report the dual-write soak | yes (`init`, `seed-counter`, `load`); no (`status`) |
| [`user`](#user) | Add a board user and issue its API token | yes |
```

In `docs/guide/commands.md`, replace (2/3):

```markdown
blaze db seed-counter
blaze db status
```

with:

```markdown
blaze db seed-counter
blaze db load [--replace]
blaze db status
```

In `docs/guide/commands.md`, replace (3/3):

```markdown
|---|---|---|
| `init` | Creates the shadow, loads the board into it, and seeds the id counter. Refuses an existing shadow unless `--force`, which rebuilds both `.blaze/blaze.db` and `.blaze/config.db`. | Creates the schema and seeds the id counter — **the board's tickets are not loaded** (that is the BLZ-254 migration). Refuses a database that already holds a Blaze schema, naming `blaze db seed-counter`. **`--force` is refused**: Blaze never drops a real database's tables from a CLI flag. |
| `seed-counter` | Raises each project's id counter to the highest number already taken — by a ticket file, an `.ids/` claim, or a database row — and prints `project  before → after`. Never lowers a counter; a second run prints `before → after` with the two equal. Refuses a database with no schema, naming `blaze db init`. | Same. |
```

with:

```markdown
|---|---|---|
| `init` | Creates the shadow, loads the board into it, and seeds the id counter. Refuses an existing shadow unless `--force`, which rebuilds both `.blaze/blaze.db` and `.blaze/config.db`. | Creates the schema and seeds the id counter — **the board's tickets are not loaded**; `blaze db load` does that. Refuses a database that already holds a Blaze schema, naming `blaze db seed-counter`. **`--force` is refused**: Blaze never drops a real database's tables from a CLI flag. |
| `load` | — (refused: `init` loads the shadow) | Loads this board's tickets — with their labels, components, worklog, parents and links — in **one transaction**, then raises the id counter from what it loaded, the files and the `.ids/` claims. **All or nothing**: a row the database refuses is named, every one of them, and nothing is loaded. Refuses a database that already holds tickets unless `--replace`, which empties the ticket tables (their event history included, never the id counter) in the same transaction. `acceptance_criterion` stays empty — db mode reads criteria from the body. |
| `seed-counter` | Raises each project's id counter to the highest number already taken — by a ticket file, an `.ids/` claim, or a database row — and prints `project  before → after`. Never lowers a counter; a second run prints `before → after` with the two equal. Refuses a database with no schema, naming `blaze db init`. | Same. |
```


- [ ] **Step 6: Fence check, commit, prove the committed tree.**

```bash
git add tests/db-load.test.mjs scripts/db-runner.mjs scripts/migrate/load-corpus.mjs docs/guide/commands.md
git diff --cached | grep -c '^+```'      # must print 0
git commit -m "BLZ-678: blaze db load — the board into Postgres in one transaction, on a shared row builder" -m "load-corpus.mjs splits into corpusRows/relationRows and two executors (loadCorpus sync SQLite, loadCorpusAsync over exec); db-runner gains load [--replace], all or nothing, counter seeded from what loaded; init points at it. New tests/db-load.test.mjs; commands.md db section." -- tests/db-load.test.mjs scripts/db-runner.mjs scripts/migrate/load-corpus.mjs docs/guide/commands.md
git status --short                        # must print nothing
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/db-load.test.mjs   # green on the COMMITTED tree
```


---

### Task 4: `blaze db verify` — the zero-diff oracle as the migration gate (BLZ-679)

**Files:**
- Create: `tests/db-verify.test.mjs`
- Create: `scripts/migrate/verify-load.mjs`
- Modify: `scripts/db-runner.mjs`
- Modify: `docs/guide/commands.md`

**Interfaces:**
- Consumes: Task 3's `corpusRows`, `relationRows`; `zeroDiff`; `parseAcBlocks`; `postgresReader(client).listTickets`.
- Produces (`scripts/migrate/verify-load.mjs`):
  - `VERIFY_TABLES = ["ticket", "ticket_link", "worklog_entry", "ticket_label", "ticket_component"]`.
  - `expectedCounts(source, projectsDir) → { [table]: number }`.
  - `criteriaFromBody(body) → { text, checked }[]`.
  - `verifyLoad({ source, sourceRoot, loadedTickets, counts, criteriaOf? }) → { ok, failures: string[], report, expected, countDiffs }`.
- Produces (`runDb`): `blaze db verify` — exit 0 pass, 1 differences, 2 could not run. Read-only (no readonly guard).

- [ ] **Step 1: Write the failing tests.**

Create `tests/db-verify.test.mjs`:

```js
// tests/db-verify.test.mjs — BLZ-679, `blaze db verify`: the migration gate (spec §5.3).
//
// zeroDiff (BLZ-281) is the oracle; this is its first production caller. The pure verdict is
// tested with no server — including each of the four conditions failing ON ITS OWN, because a
// gate whose conditions only ever fail together cannot be shown to check any one of them. The
// Postgres block runs the command end to end, and proves it discriminates by changing ONE value
// in a loaded board (prove-test-discriminates-by-injecting-regression).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fsReadStorage } from "../scripts/model/read-storage.mjs";
import { verifyLoad, expectedCounts, criteriaFromBody, VERIFY_TABLES } from "../scripts/migrate/verify-load.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { dbBoard } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";

function board() {
  const roots = dbBoard();
  writeFileSync(join(roots.projectsDir, "ENG", "defined", "ENG-2-b.md"),
    ["---", "id: ENG-2", "title: B task", "type: task", "project: ENG", "priority: high",
     "assignee: unassigned", "estimate: 15", "parent: ENG-1", "labels: [x, y]",
     "created: 2026-01-02", "updated: 2026-01-03",
     "worklog:", "  - { date: 2026-01-03, minutes: 10, note: first }",
     "links:", "  - { type: Blocks, target: ENG-1 }",
     "---", "", "## Acceptance Criteria", "", "- [x] done", "- [ ] open", ""].join("\n"));
  return roots;
}

/** The filesystem's own tickets as the "loaded" side: a perfect load, by construction. */
const asLoaded = (projectsDir) => [...fsReadStorage.listTickets(projectsDir)]
  .map((t) => ({ ...t, frontmatter: { ...t.frontmatter } }));

test("a perfect load passes all four conditions", () => {
  const { projectsDir } = board();
  const counts = expectedCounts(fsReadStorage, projectsDir);
  assert.deepEqual(counts, { ticket: 2, ticket_link: 1, worklog_entry: 1, ticket_label: 2, ticket_component: 0 });
  const v = verifyLoad({ source: fsReadStorage, sourceRoot: projectsDir, loadedTickets: asLoaded(projectsDir), counts });
  assert.equal(v.ok, true, v.failures.join("; "));
  assert.equal(v.report.criteriaChecked, 3, "ENG-1's one criterion and ENG-2's two were checked, not skipped");
  assert.deepEqual(v.failures, []);
});

test("condition 1 alone: one changed VALUE fails, and names the field", () => {
  const { projectsDir } = board();
  const loaded = asLoaded(projectsDir);
  loaded.find((t) => t.frontmatter.id === "ENG-2").frontmatter.priority = "low";
  const v = verifyLoad({ source: fsReadStorage, sourceRoot: projectsDir, loadedTickets: loaded,
                         counts: expectedCounts(fsReadStorage, projectsDir) });
  assert.equal(v.ok, false);
  assert.deepEqual(v.failures, ["1 value difference(s)"]);
  assert.deepEqual(v.report.valueDiffs, [{ id: "ENG-2", field: "priority", source: "high", loaded: "low" }]);
});

test("condition 2 alone: a ticket missing from the database fails", () => {
  const { projectsDir } = board();
  const loaded = asLoaded(projectsDir).filter((t) => t.frontmatter.id !== "ENG-2");
  const v = verifyLoad({ source: fsReadStorage, sourceRoot: projectsDir, loadedTickets: loaded,
                         counts: expectedCounts(fsReadStorage, projectsDir) });
  assert.deepEqual(v.failures, ["the id sets differ: 1 missing from the database, 0 only in the database"]);
  assert.deepEqual(v.report.missing, ["ENG-2"]);
});

test("condition 3 alone: a row count the builder does not predict fails, every table checked", () => {
  const { projectsDir } = board();
  for (const table of VERIFY_TABLES) {
    const counts = { ...expectedCounts(fsReadStorage, projectsDir) };
    counts[table] += 1;
    const v = verifyLoad({ source: fsReadStorage, sourceRoot: projectsDir, loadedTickets: asLoaded(projectsDir), counts });
    assert.deepEqual(v.failures, [`row counts differ in ${table}`], table);
  }
});

test("condition 4 alone: criteria that disagree fail even when every value agrees", () => {
  const { projectsDir } = board();
  const v = verifyLoad({ source: fsReadStorage, sourceRoot: projectsDir, loadedTickets: asLoaded(projectsDir),
                         counts: expectedCounts(fsReadStorage, projectsDir),
                         criteriaOf: (body) => criteriaFromBody(body).map((c) => ({ ...c, checked: !c.checked })) });
  assert.deepEqual(v.report.valueDiffs, []);
  assert.deepEqual(v.failures, ["3 acceptance-criteria difference(s)"]);
});

test("criteriaFromBody is the engine's parser: criteria only, in order, with their checks", () => {
  assert.deepEqual(criteriaFromBody("## Acceptance Criteria\nprose\n- [x] a\n- [ ] b\n"),
    [{ text: "a", checked: true }, { text: "b", checked: false }]);
  assert.deepEqual(criteriaFromBody(undefined), []);
});

// --- Postgres ---------------------------------------------------------------------------------
const capture = () => {
  const out = [];
  const io = { log: (s) => out.push(String(s)), err: (s) => out.push(String(s)), env: {} };
  return { io, text: () => out.join("\n") };
};
const pgIo = (url) => ({
  resolveDbConfig: () => ({ driver: "postgres", connection: url }),
  openPostgresClient: (c) => pgClient(c),
});
async function loadedBoard(tag) {
  const db = await scratchPgDb(tag);
  const roots = board();
  assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
  assert.equal(await runDb(["load"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
  return { db, roots };
}
const sql = async (url, text) => {
  const c = await pgClient(url);
  try { await c.query(text); } finally { await c.end(); }
};

test("acceptance: load → verify exits 0 and prints PASS", PG_SKIP, async () => {
  const { db, roots } = await loadedBoard("verify");
  try {
    const c = capture();
    assert.equal(await runDb(["verify"], { ...c.io, roots, ...pgIo(db.url) }), 0, c.text());
    assert.match(c.text(), /compared\s+2 tickets/);
    assert.match(c.text(), /criteria\s+3 checked, 0 diffs/);
    assert.match(c.text(), /verify: PASS/);
  } finally { await db.drop(); }
});

test("one injected value change in the database → exit 1, naming the ticket and field", PG_SKIP, async () => {
  const { db, roots } = await loadedBoard("verifyval");
  try {
    await sql(db.url, "UPDATE ticket SET title = 'tampered' WHERE id = 'ENG-2'");
    const c = capture();
    assert.equal(await runDb(["verify"], { ...c.io, roots, ...pgIo(db.url) }), 1);
    assert.match(c.text(), /ENG-2 {2}title: "B task" → "tampered"/);
    assert.match(c.text(), /verify: FAIL — 1 value difference\(s\)/);
  } finally { await db.drop(); }
});

test("a row the reader never shows (a soft-deleted ticket) still fails the row count", PG_SKIP, async () => {
  const { db, roots } = await loadedBoard("verifycount");
  try {
    await sql(db.url, `INSERT INTO ticket (id, project_key, num, type, status, title, created_on, updated_on, deleted_at)
                       VALUES ('ENG-3', 'ENG', 3, 'task', 'defined', 'gone', '2026-01-01', '2026-01-01', now())`);
    const c = capture();
    assert.equal(await runDb(["verify"], { ...c.io, roots, ...pgIo(db.url) }), 1);
    assert.match(c.text(), /rows ticket\s+3 loaded, 2 expected/);
    assert.match(c.text(), /verify: FAIL — row counts differ in ticket$/m);
  } finally { await db.drop(); }
});

test("could not run → exit 2: not Postgres, no schema, an unreadable source ticket", PG_SKIP, async () => {
  const db = await scratchPgDb("verifyrefuse");
  try {
    const roots = board();
    const sq = capture();
    assert.equal(await runDb(["verify"], { ...sq.io, roots, resolveDbConfig: () => ({ driver: "sqlite" }) }), 2);
    assert.match(sq.text(), /could not run/);

    const empty = capture();
    assert.equal(await runDb(["verify"], { ...empty.io, roots, ...pgIo(db.url) }), 2);
    assert.match(empty.text(), /has no Blaze schema/);

    assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    writeFileSync(join(roots.projectsDir, "ENG", "defined", "ENG-9-bad.md"), "no frontmatter at all\n");
    const bad = capture();
    assert.equal(await runDb(["verify"], { ...bad.io, roots, ...pgIo(db.url) }), 2);
    assert.match(bad.text(), /missing frontmatter/);
    assert.doesNotMatch(bad.text(), /PASS/);
  } finally { await db.drop(); }
});
```


- [ ] **Step 2: Run them to verify they fail.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/db-verify.test.mjs
```

Expected: the file fails to load — `Cannot find module '…/scripts/migrate/verify-load.mjs'`.

- [ ] **Step 3: Implement.**

In `scripts/db-runner.mjs`, replace (1/5):

```js
// scripts/db-runner.mjs — `blaze db init|seed-counter|load|status` (BLZ-299).
//
```

with:

```js
// scripts/db-runner.mjs — `blaze db init|seed-counter|load|verify|status` (BLZ-299).
//
```

In `scripts/db-runner.mjs`, replace (2/5):

```js
import { loadCorpusAsync } from "./migrate/load-corpus.mjs";
import { WRITE_PORT_ENV } from "./model/write-port.mjs";
```

with:

```js
import { loadCorpusAsync } from "./migrate/load-corpus.mjs";
import { verifyLoad, VERIFY_TABLES } from "./migrate/verify-load.mjs";
import { postgresReader } from "./model/pg-storage.mjs";
import { WRITE_PORT_ENV } from "./model/write-port.mjs";
```

In `scripts/db-runner.mjs`, replace (3/5):

```js
                holds tickets unless --replace
  status        what the database holds, and what the dual-write soak has found
```

with:

```js
                holds tickets unless --replace
  verify        Postgres only: compare the database with this board's files — the
                migration gate. Exit 0 pass, 1 differences found, 2 could not run
  status        what the database holds, and what the dual-write soak has found
```

In `scripts/db-runner.mjs`, replace (4/5):

```js

async function initSqlite({ dataRoot, projectsDir, force, log, err }) {
```

with:

```js

/**
 * BLZ-679: `blaze db verify` — the migration gate (spec §5.3). The filesystem reader over this
 * board is the SOURCE; the Postgres reader, every ticket fetched up front (zeroDiff is
 * synchronous), is the LOADED side. `verifyLoad` decides; this prints and picks the exit code:
 *   0  every condition holds
 *   1  it ran, and found a difference
 *   2  it could not run — no config, not Postgres, no connection or schema, or a source file
 *      it could not read. A verify that could not look must never print a pass.
 * Read-only: no BLAZE_READONLY guard, and nothing is written.
 */
async function verifyCmd(ctx) {
  const { projectsDir, log, err, openPgClient } = ctx;
  const dbConfig = dbConfigOr(ctx);
  if (!dbConfig) return 2;
  if (dbConfig.driver !== "postgres") {
    err("blaze db verify: verifies a Postgres database loaded by 'blaze db load'. It could not run.");
    return 2;
  }
  let client;
  try { client = await openCheckedPg(dbConfig.connection, openPgClient); }
  catch (e) { err(e.message); err("blaze db verify could not run."); return 2; }
  const where = describePgTarget(dbConfig.connection);
  let verdict;
  try {
    const loadedTickets = await postgresReader(client).listTickets(null);
    const counts = {};
    for (const t of VERIFY_TABLES) counts[t] = Number((await client.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
    verdict = verifyLoad({ source: fsReadStorage, sourceRoot: projectsDir, loadedTickets, counts });
  } catch (e) {
    err(`blaze db verify: ${where} — ${e.message}`);
    err("blaze db verify could not run.");
    return 2;
  } finally {
    try { await client.end(); } catch { /* already closed */ }
  }
  const { report, expected, countDiffs } = verdict;
  const SHOW = 20;
  log(`blaze db verify — ${projectsDir} against ${where}`);
  log(`  compared       ${report.compared} tickets, ${report.fieldsChecked} fields`);
  log(`  value diffs    ${report.valueDiffs.length}`);
  for (const d of report.valueDiffs.slice(0, SHOW)) {
    log(`      ${d.id}  ${d.field}${d.source === undefined ? "" : `: ${JSON.stringify(d.source)} → ${JSON.stringify(d.loaded)}`}`);
  }
  log(`  missing        ${report.missing.length}${report.missing.length ? `  (${report.missing.slice(0, SHOW).join(", ")})` : ""}`);
  log(`  extra          ${report.extra.length}${report.extra.length ? `  (${report.extra.slice(0, SHOW).join(", ")})` : ""}`);
  for (const t of VERIFY_TABLES) {
    const d = countDiffs.find((x) => x.table === t);
    log(`  rows ${t.padEnd(17)} ${d ? `${d.loaded} loaded, ${d.expected} expected  ✗` : expected[t]}`);
  }
  log(`  criteria       ${report.criteriaChecked} checked, ${report.criteriaDiffs.length} diffs`);
  for (const d of report.criteriaDiffs.slice(0, SHOW)) log(`      ${d.id}  ${d.kind}`);
  // Informational, never gating — spec §5.3 and zero-diff.mjs's own header say why.
  log(`  byte diffs     ${report.byteDiffs}  (field order only — informational)`);
  log(`  defaulted      ${report.defaulted.length}  (no value in the file; the schema default applied)`);
  if (verdict.ok) { log("verify: PASS"); return 0; }
  log(`verify: FAIL — ${verdict.failures.join("; ")}`);
  return 1;
}

async function initSqlite({ dataRoot, projectsDir, force, log, err }) {
```

In `scripts/db-runner.mjs`, replace (5/5):

```js
  if (cmd === "load") return loadCmd(ctx);
  if (cmd === "status") return status(ctx);
```

with:

```js
  if (cmd === "load") return loadCmd(ctx);
  if (cmd === "verify") return verifyCmd(ctx);
  if (cmd === "status") return status(ctx);
```

Create `scripts/migrate/verify-load.mjs`:

```js
// scripts/migrate/verify-load.mjs — the migration gate's verdict (BLZ-679, spec §5.3).
//
// `zero-diff.mjs` (BLZ-281) had no production caller: it ran from migration TEST suites only.
// `blaze db verify` is that caller, and this is its pure half — given the source corpus, the
// loaded tickets (already fetched) and the loaded tables' row counts, it decides PASS or FAIL.
// The runner owns the I/O; nothing here opens a connection, so the verdict is unit-tested.
//
// It passes only if ALL FOUR hold (spec §5.3):
//   1. zeroDiff's `valueDiffs` is empty — no field VALUE changed;
//   2. the id set on each side is identical — nothing missing, nothing extra;
//   3. each table's row count equals what the loader's own row builder says it inserts;
//   4. acceptance criteria agree on every ticket, read by `ac-oracle-matcher.mjs` on the source
//      side, which shares no code with the importer's parser.
// `byteDiffs` (BLZ-253's field-order noise) is reported, never gated.
import { zeroDiff } from "./zero-diff.mjs";
import { corpusRows, relationRows } from "./load-corpus.mjs";
import { parseAcBlocks } from "../model/ac-blocks.mjs";

/** The tables whose row counts gate, in the order they are printed. */
export const VERIFY_TABLES = ["ticket", "ticket_link", "worklog_entry", "ticket_label", "ticket_component"];

/**
 * What the loader inserts for this source, per table — computed by the SAME row builder
 * `blaze db load` ran (`corpusRows` + `relationRows`), so "the loader's tallies" are recomputed
 * rather than remembered. A load the database refused any row of was rolled back whole, so
 * every ticket the builder produced is expected.
 */
export function expectedCounts(source, projectsDir) {
  const { tickets } = corpusRows(source, projectsDir);
  const rel = relationRows(tickets, new Map(tickets.map((t) => [t.id, t.type])));
  const sum = (f) => tickets.reduce((n, t) => n + f(t), 0);
  return {
    ticket: tickets.length,
    ticket_link: rel.links.length,
    worklog_entry: sum((t) => t.worklog.length),
    ticket_label: sum((t) => t.labels.length),
    ticket_component: sum((t) => t.components.length),
  };
}

/**
 * What the LOADED side holds as acceptance criteria. Postgres keeps no criterion rows (spec
 * §5.2 — the `acceptance_criterion` index is SQLite-shadow-only), and every db-mode reader and
 * writer takes them from `body`, so the loaded criteria are the engine's own parser over the
 * loaded body. The oracle reads the SOURCE body with an independent matcher; agreement means
 * what db mode will show as criteria is what the files said.
 */
export function criteriaFromBody(body) {
  return parseAcBlocks(body ?? "").blocks
    .filter((b) => b.kind === "criterion")
    .map((b) => ({ text: b.text, checked: b.checked }));
}

/**
 * @param source         a SYNC read driver holding the original corpus (the filesystem)
 * @param sourceRoot     its projects directory
 * @param loadedTickets  every loaded ticket, ALREADY AWAITED — zeroDiff is synchronous
 * @param counts         { [table]: rows } for each of VERIFY_TABLES, as the database holds them
 * @param criteriaOf     (body) => [{ text, checked }]; injectable only so a test can prove the
 *                       criteria condition gates on its own
 * @returns { ok, failures: string[], report, expected, countDiffs }
 */
export function verifyLoad({ source, sourceRoot, loadedTickets, counts, criteriaOf = criteriaFromBody }) {
  const bodies = new Map(loadedTickets.map((t) => [String(t.frontmatter?.id), t.body ?? ""]));
  const report = zeroDiff(source, sourceRoot, { listTickets: () => loadedTickets },
                          { criteriaFor: (id) => criteriaOf(bodies.get(id)) });
  const expected = expectedCounts(source, sourceRoot);
  const countDiffs = VERIFY_TABLES
    .filter((t) => expected[t] !== counts[t])
    .map((t) => ({ table: t, expected: expected[t], loaded: counts[t] }));
  const failures = [];
  if (report.valueDiffs.length) failures.push(`${report.valueDiffs.length} value difference(s)`);
  if (report.missing.length || report.extra.length) {
    failures.push(`the id sets differ: ${report.missing.length} missing from the database, `
      + `${report.extra.length} only in the database`);
  }
  if (countDiffs.length) failures.push(`row counts differ in ${countDiffs.map((d) => d.table).join(", ")}`);
  if (report.criteriaDiffs.length) failures.push(`${report.criteriaDiffs.length} acceptance-criteria difference(s)`);
  return { ok: failures.length === 0, failures, report, expected, countDiffs };
}
```


- [ ] **Step 4: Run them to verify they pass**, then the neighbours this task touches.

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/db-verify.test.mjs
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/db-load.test.mjs tests/migrate/*.test.mjs tests/db-runner-pg.test.mjs tests/model/seam-closure.test.mjs
```

Expected: 10/10 pass (4 skip without Postgres).

- [ ] **Step 5: Docs, in the same commit.**

In `docs/guide/commands.md`, replace (1/3):

```markdown
| [`migrate`](#migrate) | Import tickets from an external tracker | with `--live` |
| [`db`](#db) | Create the database schema, load the board into Postgres, seed its id counter, report the dual-write soak | yes (`init`, `seed-counter`, `load`); no (`status`) |
| [`user`](#user) | Add a board user and issue its API token | yes |
```

with:

```markdown
| [`migrate`](#migrate) | Import tickets from an external tracker | with `--live` |
| [`db`](#db) | Create the database schema, load the board into Postgres, check the load, seed its id counter, report the dual-write soak | yes (`init`, `seed-counter`, `load`); no (`verify`, `status`) |
| [`user`](#user) | Add a board user and issue its API token | yes |
```

In `docs/guide/commands.md`, replace (2/3):

```markdown
blaze db load [--replace]
blaze db status
```

with:

```markdown
blaze db load [--replace]
blaze db verify
blaze db status
```

In `docs/guide/commands.md`, replace (3/3):

```markdown
| `seed-counter` | Raises each project's id counter to the highest number already taken — by a ticket file, an `.ids/` claim, or a database row — and prints `project  before → after`. Never lowers a counter; a second run prints `before → after` with the two equal. Refuses a database with no schema, naming `blaze db init`. | Same. |
| `status` | What the shadow holds, and what the dual-write soak has found. | — |
```

with:

```markdown
| `seed-counter` | Raises each project's id counter to the highest number already taken — by a ticket file, an `.ids/` claim, or a database row — and prints `project  before → after`. Never lowers a counter; a second run prints `before → after` with the two equal. Refuses a database with no schema, naming `blaze db init`. | Same. |
| `verify` | — (refused, exit 2) | **The migration gate.** Compares the database with this board's files: every field value, the id sets, each table's row count against what the loader builds for these files, and every ticket's acceptance criteria (read by an independent matcher). Prints each difference; byte-order noise is shown but never gates. Exit `0` pass, `1` a difference, `2` could not run (no schema, no connection, a ticket file that will not parse). |
| `status` | What the shadow holds, and what the dual-write soak has found. | — |
```


- [ ] **Step 6: Fence check, commit, prove the committed tree.**

```bash
git add tests/db-verify.test.mjs scripts/db-runner.mjs scripts/migrate/verify-load.mjs docs/guide/commands.md
git diff --cached | grep -c '^+```'      # must print 0
git commit -m "BLZ-679: blaze db verify — the zero-diff oracle as the migration gate" -m "New scripts/migrate/verify-load.mjs (verifyLoad: value diffs, id sets, row counts recomputed by the loader's own builder, criteria by the independent matcher; byte diffs informational); db-runner verify with exit 0/1/2. New tests/db-verify.test.mjs; commands.md." -- tests/db-verify.test.mjs scripts/db-runner.mjs scripts/migrate/verify-load.mjs docs/guide/commands.md
git status --short                        # must print nothing
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/db-verify.test.mjs   # green on the COMMITTED tree
```


---

### Task 5: under db, metrics history from `ticket_transition`; the load imports git's (BLZ-680)

**Files:**
- Create: `tests/db-transitions.test.mjs`
- Create: `scripts/model/transitions-db.mjs`
- Modify: `scripts/db-runner.mjs`
- Modify: `scripts/migrate/load-corpus.mjs`
- Modify: `scripts/model/pg-storage.mjs`
- Modify: `scripts/model/sqlite-storage.mjs`
- Modify: `scripts/serve.mjs`
- Modify: `scripts/supervisor.mjs`
- Modify: `AGENTS.md`
- Modify: `docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md`
- Modify: `docs/guide/commands.md`

**Interfaces:**
- Consumes: `buildTransitions({ root })` (git rename history, pure), Task 3's `loadCorpusAsync` (its `typeById`).
- Produces:
  - `postgresReader(client).listTransitions(root) → Promise<{id, from, to, ts}[]>` and `openSqliteRead(path).listTransitions(root) → {id, from, to, ts}[]`, ordered `ts, id`.
  - `dbTransitions(readStorage, mode, view, root) → Promise<list | undefined>` (`scripts/model/transitions-db.mjs`) — `undefined` unless `mode === "db" && view === "metrics"`.
  - `GIT_TRANSITION_ACTOR = "git-history"`, `transitionEvents(transitions, loadedIds: Set) → { rows, unknown, undated }`, `importTransitions(exec, transitions, loadedIds, { dialect }) → Promise<{ imported, unknown, undated }>` (`load-corpus.mjs`).

- [ ] **Step 1: Write the failing tests.**

Create `tests/db-transitions.test.mjs`:

```js
// tests/db-transitions.test.mjs — BLZ-680 (spec §5.7): under BLAZE_WRITE_PORT=db the metrics
// view's status history comes from `ticket_transition`, and `blaze db load` (and the SQLite
// `blaze db init`) import the git-era history into it once. fs mode is unchanged: it still
// reads git, and `dbTransitions` answers `undefined` there so the page derives it as before.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { transitionEvents, GIT_TRANSITION_ACTOR } from "../scripts/migrate/load-corpus.mjs";
import { dbTransitions } from "../scripts/model/transitions-db.mjs";
import { openSqliteRead } from "../scripts/model/sqlite-storage.mjs";
import { shadowDbPath } from "../scripts/model/write-port-resolve.mjs";
import { postgresReader } from "../scripts/model/pg-storage.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { startServer, CSRF } from "../scripts/serve.mjs";
import { createApp } from "../scripts/supervisor.mjs";
import { loadConfig } from "../scripts/config.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

/** dbBoard() as a git repo whose history moved ENG-1 defined → in-progress: one transition. */
function gitBoard() {
  const roots = dbBoard();
  git(roots.dataRoot, "init", "-q");
  git(roots.dataRoot, "config", "user.email", "t@t.t");
  git(roots.dataRoot, "config", "user.name", "t");
  git(roots.dataRoot, "add", "-A");
  git(roots.dataRoot, "commit", "-qm", "seed");
  mkdirSync(join(roots.projectsDir, "ENG", "in-progress"), { recursive: true });
  renameSync(join(roots.projectsDir, "ENG", "defined", "ENG-1-a.md"),
             join(roots.projectsDir, "ENG", "in-progress", "ENG-1-a.md"));
  git(roots.dataRoot, "add", "-A");
  git(roots.dataRoot, "commit", "-qm", "move");
  return roots;
}

describe("the pure parts", () => {
  test("transitionEvents: one row per git transition of a LOADED ticket; the rest are counted", () => {
    const r = transitionEvents([
      { id: "ENG-1", from: "defined", to: "in-progress", ts: "2026-10-01T10:00:00+10:00" },
      { id: "ENG-9", from: "defined", to: "done", ts: "2026-10-01T11:00:00+10:00" },
      { id: "ENG-1", from: "in-progress", to: "done", ts: null },
    ], new Set(["ENG-1"]));
    assert.deepEqual(r.rows, [["ENG-1", "transition", "2026-10-01T10:00:00+10:00", GIT_TRANSITION_ACTOR,
                               "git-backfill", "defined", "in-progress"]]);
    assert.equal(r.unknown, 1);
    assert.equal(r.undated, 1);
  });

  test("dbTransitions answers only for db mode's metrics view", async () => {
    const rs = { listTransitions: async () => [{ id: "ENG-1" }] };
    assert.deepEqual(await dbTransitions(rs, "db", "metrics", "/p"), [{ id: "ENG-1" }]);
    assert.equal(await dbTransitions(rs, "db", "board", "/p"), undefined, "no other view pays for the query");
    assert.equal(await dbTransitions(rs, "fs", "metrics", "/p"), undefined, "fs keeps git");
    assert.equal(await dbTransitions(rs, "dual", "metrics", "/p"), undefined, "dual keeps git");
  });
});

test("SQLite `blaze db init` imports the git history, and the shadow reader returns it", async () => {
  const roots = gitBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const r = openSqliteRead(shadowDbPath(roots.dataRoot));
  try {
    const got = r.listTransitions(null);
    assert.equal(got.length, 1);
    assert.deepEqual({ ...got[0], ts: "*" }, { id: "ENG-1", from: "defined", to: "in-progress", ts: "*" });
    assert.match(got[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  } finally { r.close(); }
});

/** The metrics view's cumulative-flow series, as the server rendered it. */
async function cfdSeries(base) {
  const r = await fetch(`${base}/view/metrics`);
  assert.equal(r.status, 200);
  const m = /id="cfd-series">([\s\S]*?)<\/script>/.exec((await r.json()).html);
  assert.ok(m, "the metrics view carries its series");
  return JSON.parse(m[1]);
}

async function withDbBoard(fn) {
  const roots = dbBoard();               // NOT a git repo: git has no history to offer here
  assert.equal(0, await runDb(["init"], { ...QUIET, roots }));
  const before = process.env.BLAZE_WRITE_PORT;
  process.env.BLAZE_WRITE_PORT = "db";
  try { await fn(roots); }
  finally {
    if (before === undefined) delete process.env.BLAZE_WRITE_PORT;
    else process.env.BLAZE_WRITE_PORT = before;
  }
}

for (const [name, boot] of [
  ["blaze board", (roots) => startServer({ port: 0, root: roots.dataRoot, projectsDir: roots.projectsDir })],
  ["blaze start", (roots) => {
    const app = createApp(loadConfig({ root: roots.dataRoot }), { root: roots.dataRoot });
    app.server.listen(0, "127.0.0.1");
    return app.server;
  }],
]) {
  test(`${name} under db: a move made through the port shows in the metrics history`, async () => {
    await withDbBoard(async (roots) => {
      const server = boot(roots);
      if (!server.listening) await new Promise((res) => server.once("listening", res));
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        assert.deepEqual(await cfdSeries(base), [], "no history yet: nothing has moved");
        if (name === "blaze board") {
          const m = await fetch(`${base}/api/move`, { method: "POST",
            headers: { "content-type": "application/json", "x-blaze-csrf": CSRF },
            body: JSON.stringify({ id: "ENG-1", to: "in-progress" }) });
          assert.equal(m.status, 200, await m.text());
        } else {
          // The supervisor serves no /api/move; write the event the port would have written.
          const r = openSqliteRead(shadowDbPath(roots.dataRoot));
          try {
            r.appendEvent(null, { ticket_id: "ENG-1", kind: "transition", from_status: "defined",
                                  to_status: "in-progress", source: "cli" });
          } finally { r.close(); }
        }
        // Before BLZ-680 this stayed [] — the page asked git, and this board has no git history.
        assert.ok((await cfdSeries(base)).length > 0, "the database's transition reached the view");
      } finally {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    });
  });
}

test("Postgres `blaze db load` imports the git history as transition events", PG_SKIP, async () => {
  const db = await scratchPgDb("transitions");
  try {
    const roots = gitBoard();
    const pgIo = { resolveDbConfig: () => ({ driver: "postgres", connection: db.url }),
                   openPostgresClient: (c) => pgClient(c) };
    assert.equal(await runDb(["init"], { ...QUIET, roots, ...pgIo }), 0);
    const out = [];
    const io = { log: (s) => out.push(String(s)), err: (s) => out.push(String(s)), env: {} };
    assert.equal(await runDb(["load"], { ...io, roots, ...pgIo }), 0, out.join("\n"));
    assert.match(out.join("\n"), /transitions\s+1\s+\(from git history\)/);
    const c = await pgClient(db.url);
    try {
      const got = await postgresReader(c).listTransitions(null);
      assert.equal(got.length, 1);
      assert.deepEqual([got[0].id, got[0].from, got[0].to], ["ENG-1", "defined", "in-progress"]);
      const ev = (await c.query("SELECT actor, source FROM ticket_event")).rows;
      assert.deepEqual(ev, [{ actor: GIT_TRANSITION_ACTOR, source: "git-backfill" }]);
    } finally { await c.end(); }
  } finally { await db.drop(); }
});
```


- [ ] **Step 2: Run them to verify they fail.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/db-transitions.test.mjs
```

Expected: the file fails to load — `does not provide an export named 'GIT_TRANSITION_ACTOR'` (and `transitions-db.mjs` does not exist yet).

- [ ] **Step 3: Implement.**

In `scripts/db-runner.mjs`, replace (1/7):

```js
import { corpusMaxima, seedCounter } from "./model/seed-counter.mjs";
import { loadCorpusAsync } from "./migrate/load-corpus.mjs";
import { verifyLoad, VERIFY_TABLES } from "./migrate/verify-load.mjs";
```

with:

```js
import { corpusMaxima, seedCounter } from "./model/seed-counter.mjs";
import { loadCorpusAsync, importTransitions } from "./migrate/load-corpus.mjs";
import { buildTransitions } from "./model/transitions.mjs";
import { verifyLoad, VERIFY_TABLES } from "./migrate/verify-load.mjs";
```

In `scripts/db-runner.mjs`, replace (2/7):

```js
async function loadCmd(ctx) {
  const { projectsDir, log, err, openPgClient, replace } = ctx;
  const dbConfig = dbConfigOr(ctx);
```

with:

```js
async function loadCmd(ctx) {
  const { dataRoot, projectsDir, log, err, openPgClient, replace } = ctx;
  const dbConfig = dbConfigOr(ctx);
```

In `scripts/db-runner.mjs`, replace (3/7):

```js
    await exec.run("BEGIN", []);
    let tally, seeded;
    try {
```

with:

```js
    await exec.run("BEGIN", []);
    let tally, seeded, history;
    try {
```

In `scripts/db-runner.mjs`, replace (4/7):

```js
      }
      // Spec §5.2: the counter is seeded from what was just loaded (seedCounter reads the
```

with:

```js
      }
      // BLZ-680 (spec §5.7): the git-era status history, once, as `transition` events — under
      // db the metrics view reads `ticket_transition`, and git's log stops growing at cutover.
      history = await importTransitions(exec, buildTransitions({ root: dataRoot }).transitions,
                                        new Set(tally.typeById.keys()), { dialect: "postgres" });
      // Spec §5.2: the counter is seeded from what was just loaded (seedCounter reads the
```

In `scripts/db-runner.mjs`, replace (5/7):

```js
    if (tally.skipped.worklogDropped.length) log(`  ⚠ worklog entries dropped: ${tally.skipped.worklogDropped.length}`);
    if (tally.skipped.noId || tally.skipped.badId) {
```

with:

```js
    if (tally.skipped.worklogDropped.length) log(`  ⚠ worklog entries dropped: ${tally.skipped.worklogDropped.length}`);
    log(`  transitions  ${history.imported}  (from git history)`);
    if (history.unknown) log(`  ⚠ transitions for tickets not in this board: ${history.unknown}`);
    if (history.undated) log(`  ⚠ transitions with no timestamp: ${history.undated}`);
    if (tally.skipped.noId || tally.skipped.badId) {
```

In `scripts/db-runner.mjs`, replace (6/7):

```js
    db.exec(setMigrationModeSql("sqlite", false));
    // BLZ-669: loadCorpus seeded from the tickets; this adds the `.ids/` claims (a number
```

with:

```js
    db.exec(setMigrationModeSql("sqlite", false));
    // BLZ-680: the same git-era history `blaze db load` imports on Postgres, so a SQLite board
    // switched to BLAZE_WRITE_PORT=db keeps its metrics history too. One transaction: a file
    // database commits each autocommitted INSERT to disk on its own.
    db.exec("BEGIN");
    const history = await importTransitions(exec, buildTransitions({ root: dataRoot }).transitions,
      new Set(exec.all("SELECT id FROM ticket", []).map((r) => r.id)), { dialect: "sqlite" });
    db.exec("COMMIT");
    // BLZ-669: loadCorpus seeded from the tickets; this adds the `.ids/` claims (a number
```

In `scripts/db-runner.mjs`, replace (7/7):

```js
    log(`  labels       ${tally.labels}   components ${tally.components}`);
    // Every substitution is named. A tally that reports only successes is a tally that
```

with:

```js
    log(`  labels       ${tally.labels}   components ${tally.components}`);
    log(`  transitions  ${history.imported}  (from git history)`);
    // Every substitution is named. A tally that reports only successes is a tally that
```

In `scripts/migrate/load-corpus.mjs`, replace:

```js
  return { ...report, typeById };
}
```

with:

```js
  return { ...report, typeById };
}

/** BLZ-680: who a git-era transition is recorded as. Git's rename log names a commit, not an
 *  operator, and `ticket_event.actor` must not invent one. */
export const GIT_TRANSITION_ACTOR = "git-history";

/**
 * BLZ-680 (spec §5.7), pure: the git-derived transitions (`buildTransitions`) as `transition`
 * ticket_events, for the tickets that loaded. Under db the metrics view reads history from
 * `ticket_transition`, and the git rename log stops growing once moves stop touching files —
 * so the history up to the load is imported, once, here.
 *
 * A transition for an id that did not load, or with no timestamp, is COUNTED and skipped: the
 * event table's foreign key and NOT NULL `at` would refuse it, and refusing it silently would
 * be the drop this file promises never to make.
 */
export function transitionEvents(transitions, loadedIds) {
  const rows = [];
  let unknown = 0, undated = 0;
  for (const tr of transitions ?? []) {
    if (!loadedIds.has(tr.id)) { unknown++; continue; }
    if (!tr.ts) { undated++; continue; }
    rows.push([tr.id, "transition", tr.ts, GIT_TRANSITION_ACTOR, "git-backfill", tr.from, tr.to]);
  }
  return { rows, unknown, undated };
}

/** Insert `transitionEvents`' rows through an `exec`, either dialect, sync or async. */
export async function importTransitions(exec, transitions, loadedIds, { dialect = "postgres" } = {}) {
  const ph = (i) => (dialect === "postgres" ? `$${i + 1}` : "?");
  const { rows, unknown, undated } = transitionEvents(transitions, loadedIds);
  for (const r of rows) {
    await exec.run(
      `INSERT INTO ticket_event (ticket_id, kind, at, actor, source, from_status, to_status)
       VALUES (${r.map((_, i) => ph(i)).join(", ")})`, r);
  }
  return { imported: rows.length, unknown, undated };
}
```

In `scripts/model/pg-storage.mjs`, replace:

```js

    async appendEvent(_root, e) {
```

with:

```js

    // BLZ-680: the status-move history under BLAZE_WRITE_PORT=db, from the `ticket_transition`
    // view over `ticket_event` — the `{ id, from, to, ts }` shape metrics.mjs reads from git in
    // fs mode. `blaze db load` imports the git-era history into it, once.
    async listTransitions(_root) {
      const { rows } = await client.query(`SELECT id, "from", "to", ts FROM ticket_transition ORDER BY ts, id`);
      return rows;
    },

    async appendEvent(_root, e) {
```

In `scripts/model/sqlite-storage.mjs`, replace (1/2):

```js
       FROM ticket_event WHERE ticket_id = ? ORDER BY at, id`);
  const appendEv = db.prepare(
```

with:

```js
       FROM ticket_event WHERE ticket_id = ? ORDER BY at, id`);
  // BLZ-680: see listTransitions below.
  const transitionsAll = db.prepare(
    `SELECT id, "from", "to", ts FROM ticket_transition ORDER BY ts, id`);
  const appendEv = db.prepare(
```

In `scripts/model/sqlite-storage.mjs`, replace (2/2):

```js

    appendEvent(_root, e) {
```

with:

```js

    // BLZ-680: the status-move history under BLAZE_WRITE_PORT=db — pg-storage.mjs says why.
    listTransitions(_root) {
      return transitionsAll.all().map((r) => ({ id: r.id, from: r.from, to: r.to, ts: r.ts }));
    },

    appendEvent(_root, e) {
```

Create `scripts/model/transitions-db.mjs`:

```js
// scripts/model/transitions-db.mjs — where the metrics view's status-move history comes from
// under BLAZE_WRITE_PORT=db (BLZ-680, spec §5.7).
//
// In fs and dual mode the history is git's rename log (transitions.mjs), and once moves stop
// touching files — db mode — that log stops growing. The database records every move as a
// `transition` ticket_event, exposed by the `ticket_transition` view, and `blaze db load`
// imports the git-era history into it once. So under db the history is read from there.
//
// `undefined` means "not mine to answer": the page then derives it from git, lazily, exactly as
// before — fs and dual are untouched, and no view but metrics pays for the query.

/** @returns the `{ id, from, to, ts }` list under db for the metrics view, else `undefined`. */
export async function dbTransitions(readStorage, mode, view, root) {
  if (mode !== "db" || view !== "metrics") return undefined;
  return readStorage.listTransitions(root);
}
```

In `scripts/serve.mjs`, replace (1/3):

```js
import { pageHtml, viewEnvelope, CSRF } from "./views/page.mjs";
import { checkBindSafety, gate, pageScopeFor } from "./model/serve-auth.mjs";
```

with:

```js
import { pageHtml, viewEnvelope, CSRF } from "./views/page.mjs";
import { dbTransitions } from "./model/transitions-db.mjs";
import { checkBindSafety, gate, pageScopeFor } from "./model/serve-auth.mjs";
```

In `scripts/serve.mjs`, replace (2/3):

```js
    if (vm) {
      return reading(async (rs) => {
        const envelope = viewEnvelope({
          view: vm[1],
          project: u.searchParams.get("project") || "all",
```

with:

```js
    if (vm) {
      return reading(async (rs, mode) => {
        const envelope = viewEnvelope({
          view: vm[1],
          // BLZ-680: under db the metrics history is the database's (ticket_transition); left
          // undefined otherwise, so fs and dual still take it from git, lazily, as before.
          transitions: await dbTransitions(rs, mode, vm[1], projectsDir),
          project: u.searchParams.get("project") || "all",
```

In `scripts/serve.mjs`, replace (3/3):

```js
      try {
        html = await reading(async (rs) => pageHtml({ project, focus, flat, sprint, view, views,
          projectsDir, nonce, tickets: await allTickets(rs) }));
      } catch (e) {
```

with:

```js
      try {
        html = await reading(async (rs, mode) => pageHtml({ project, focus, flat, sprint, view, views,
          projectsDir, nonce, tickets: await allTickets(rs),
          transitions: await dbTransitions(rs, mode, view, projectsDir) }));
      } catch (e) {
```

In `scripts/supervisor.mjs`, replace (1/3):

```js
import { viewEnvelope, CSRF } from "./views/page.mjs";
import { createBus } from "./event-bus.mjs";
```

with:

```js
import { viewEnvelope, CSRF } from "./views/page.mjs";
import { dbTransitions } from "./model/transitions-db.mjs";
import { createBus } from "./event-bus.mjs";
```

In `scripts/supervisor.mjs`, replace (2/3):

```js
    if (vm) {
      return reading(async (rs) => {
        const envelope = viewEnvelope({
          view: vm[1],
          project: u.searchParams.get("project") || "all",
```

with:

```js
    if (vm) {
      return reading(async (rs, mode) => {
        const envelope = viewEnvelope({
          view: vm[1],
          // BLZ-680: serve.mjs's rule — the database's history under db, git's otherwise.
          transitions: await dbTransitions(rs, mode, vm[1], projectsDir),
          project: u.searchParams.get("project") || "all",
```

In `scripts/supervisor.mjs`, replace (3/3):

```js
      try {
        html = await reading(async (rs) => pageHtml({
          project: u.searchParams.get("project") || "all",
```

with:

```js
      try {
        html = await reading(async (rs, mode) => pageHtml({
          transitions: await dbTransitions(rs, mode, u.searchParams.get("view") || "board", projectsDir),
          project: u.searchParams.get("project") || "all",
```


- [ ] **Step 4: Run them to verify they pass**, then the neighbours this task touches.

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/db-transitions.test.mjs
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/serve*.test.mjs tests/supervisor*.test.mjs tests/db-*.test.mjs tests/views/*.test.mjs tests/db-mode-reads*.test.mjs tests/groomer-db-mode.test.mjs tests/model/driver-conformance.test.mjs tests/model/seam-closure.test.mjs
```

Expected: 7/7 pass (1 skips without Postgres). Discrimination was proven in the prototype: with Step 3's `serve.mjs`/`supervisor.mjs` edits reverted, both `… shows in the metrics history` tests fail (`[]`).

- [ ] **Step 5: Docs, in the same commit.**

In `AGENTS.md`, replace:

```markdown
[ADR-0038](https://github.com/hjr15/blaze/blob/main/docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md).
`.blaze/transitions.json` still comes from git history in every mode, `db` included.

```

with:

```markdown
[ADR-0038](https://github.com/hjr15/blaze/blob/main/docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md).
`.blaze/transitions.json` still comes from git history in `fs` and `dual` mode. Under
`BLAZE_WRITE_PORT=db` the Metrics view reads its status-move history from the database
instead — every move is a `transition` event, read through the `ticket_transition` view — and
`blaze db load` (or, for the SQLite shadow, `blaze db init`) imports the git-era history into it
once, because git's rename log stops growing when moves stop touching files.

```

In `docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md`, replace:

```markdown
revert through the port is BLZ-254's to design.
```

with:

```markdown
revert through the port is BLZ-254's to design.

## Addendum (2026-10-05, BLZ-254 PR A) — the remaining named residuals

BLZ-254 decided each residual this ADR left open ([spec](../superpowers/specs/2026-10-05-blz-254-live-board-cutover-design.md) §5.7 and §5.8):

- **`.blaze/transitions.json` — closed (BLZ-680).** Under `db` the Metrics view reads its
  history from the `ticket_transition` view over `ticket_event` (`dbTransitions`, called by both
  servers for the metrics view only). `blaze db load` imports the git-era history once, as
  `transition` events with `source = 'git-backfill'` and actor `git-history`; the SQLite
  `blaze db init` does the same for the shadow. `fs` and `dual` still read git, unchanged.
- **`sprints.json` — kept as a data-root config file**, like `blaze.config.json`. It is a small
  operator-edited registry; a ticket's sprint membership is already the `ticket.sprint_id`
  column. It moves with config in Phase 5.
- **Connection pooling — measure first.** The cutover rehearsal times 200 sequential `GET /` and
  100 `POST /api/new` against the cluster database; a `pg.Pool` (max 5) is built only if either
  p95 exceeds 250 ms, or connecting takes more than 20% of p95. The numbers are recorded on
  BLZ-254 either way.
```

In `docs/guide/commands.md`, replace:

```markdown
| `init` | Creates the shadow, loads the board into it, and seeds the id counter. Refuses an existing shadow unless `--force`, which rebuilds both `.blaze/blaze.db` and `.blaze/config.db`. | Creates the schema and seeds the id counter — **the board's tickets are not loaded**; `blaze db load` does that. Refuses a database that already holds a Blaze schema, naming `blaze db seed-counter`. **`--force` is refused**: Blaze never drops a real database's tables from a CLI flag. |
| `load` | — (refused: `init` loads the shadow) | Loads this board's tickets — with their labels, components, worklog, parents and links — in **one transaction**, then raises the id counter from what it loaded, the files and the `.ids/` claims. **All or nothing**: a row the database refuses is named, every one of them, and nothing is loaded. Refuses a database that already holds tickets unless `--replace`, which empties the ticket tables (their event history included, never the id counter) in the same transaction. `acceptance_criterion` stays empty — db mode reads criteria from the body. |
| `seed-counter` | Raises each project's id counter to the highest number already taken — by a ticket file, an `.ids/` claim, or a database row — and prints `project  before → after`. Never lowers a counter; a second run prints `before → after` with the two equal. Refuses a database with no schema, naming `blaze db init`. | Same. |
```

with:

```markdown
| `init` | Creates the shadow, loads the board into it, and seeds the id counter. Refuses an existing shadow unless `--force`, which rebuilds both `.blaze/blaze.db` and `.blaze/config.db`. | Creates the schema and seeds the id counter — **the board's tickets are not loaded**; `blaze db load` does that. Refuses a database that already holds a Blaze schema, naming `blaze db seed-counter`. **`--force` is refused**: Blaze never drops a real database's tables from a CLI flag. |
| `load` | — (refused: `init` loads the shadow) | Loads this board's tickets — with their labels, components, worklog, parents and links, and the git history of their status moves as `transition` events — in **one transaction**, then raises the id counter from what it loaded, the files and the `.ids/` claims. **All or nothing**: a row the database refuses is named, every one of them, and nothing is loaded. Refuses a database that already holds tickets unless `--replace`, which empties the ticket tables (their event history included, never the id counter) in the same transaction. `acceptance_criterion` stays empty — db mode reads criteria from the body. |
| `seed-counter` | Raises each project's id counter to the highest number already taken — by a ticket file, an `.ids/` claim, or a database row — and prints `project  before → after`. Never lowers a counter; a second run prints `before → after` with the two equal. Refuses a database with no schema, naming `blaze db init`. | Same. |
```


- [ ] **Step 6: Fence check, commit, prove the committed tree.**

```bash
git add tests/db-transitions.test.mjs scripts/db-runner.mjs scripts/migrate/load-corpus.mjs scripts/model/pg-storage.mjs scripts/model/sqlite-storage.mjs scripts/model/transitions-db.mjs scripts/serve.mjs scripts/supervisor.mjs AGENTS.md docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md docs/guide/commands.md
git diff --cached | grep -c '^+```'      # must print 0
git commit -m "BLZ-680: under db, metrics history from ticket_transition; db load imports git transitions" -m "pg and sqlite readers gain listTransitions; new scripts/model/transitions-db.mjs; serve.mjs and supervisor.mjs pass it to the metrics view under db only; load-corpus.mjs gains transitionEvents/importTransitions, used by db load and the SQLite init. New tests/db-transitions.test.mjs; AGENTS.md, commands.md, ADR-0038 addendum." -- tests/db-transitions.test.mjs scripts/db-runner.mjs scripts/migrate/load-corpus.mjs scripts/model/pg-storage.mjs scripts/model/sqlite-storage.mjs scripts/model/transitions-db.mjs scripts/serve.mjs scripts/supervisor.mjs AGENTS.md docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md docs/guide/commands.md
git status --short                        # must print nothing
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/db-transitions.test.mjs   # green on the COMMITTED tree
```


---

### Task 6: `blaze audit --fail-on`, three governance kinds, and `--projects` that resolves across projects (BLZ-681)

**Files:**
- Create: `tests/audit-governance.test.mjs`
- Modify: `tests/audit-terminal-goal-unverified.test.mjs`
- Modify: `scripts/audit-runner.mjs`
- Modify: `scripts/model/audit.mjs`
- Modify: `docs/guide/commands.md`

**Interfaces:**
- Produces (`scripts/model/audit.mjs`): `SOFT_KINDS` += `empty-body`, `config-project-drift`; `HARD_KINDS` += `terminal-parent-open-child`; `TERMINAL_PARENT_STATUSES`, `EMPTY_BODY_TERMINAL` (Sets); `isScaffoldLine(line) → boolean`; `bodyIsEmpty(body) → boolean`; `governanceFindings({ tickets, configProjects: string[]|null, storeProjects: string[] }) → finding[]`; `auditCorpus({ tickets, projects, config, universe })` — `universe` (default `tickets`) is what ids and parent types resolve against.
- Produces (`blaze audit`): `--fail-on k1,k2` — exit 1 iff a finding of a named kind, else 0; unknown or empty → exit 2; JSON gains `failOn`, `failing` when given.

- [ ] **Step 1: Write the failing tests.**

Create `tests/audit-governance.test.mjs`:

```js
// tests/audit-governance.test.mjs — BLZ-681 (spec §5.6). blaze-pm's governance scripts,
// re-homed as `blaze audit` kinds: terminal-parent-open-child (hard), empty-body (soft),
// config-project-drift (soft), plus `--fail-on <kinds>` so one kind can gate on its own. The
// rules are the scripts' own, pinned here; the runner tests prove they read through the
// resolved store — the db-mode test deletes a ticket FILE after loading the shadow, and the
// finding is still reported, because it came from the database.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { governanceFindings, isScaffoldLine, bodyIsEmpty, TERMINAL_PARENT_STATUSES,
         EMPTY_BODY_TERMINAL, HARD_KINDS, SOFT_KINDS } from "../scripts/model/audit.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";
import { QUIET } from "./helpers/db-board.mjs";

const scratch = scratchRegistry();
const AUDIT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "audit-runner.mjs");

const t = (id, status, { type = "task", parent = "", body = "Some prose." } = {}) =>
  ({ frontmatter: { id, type, parent }, status, body });

describe("the rules, as the scripts wrote them", () => {
  test("the two terminal sets are the scripts' sets, verbatim", () => {
    assert.deepEqual([...TERMINAL_PARENT_STATUSES].sort(), ["accepted", "achieved", "done", "mitigated", "obsolete"]);
    assert.deepEqual([...EMPTY_BODY_TERMINAL].sort(),
      ["accepted", "achieved", "done", "implemented", "mitigated", "obsolete", "rejected"]);
  });

  test("severities: terminal-parent-open-child is hard; empty-body and config-project-drift are soft", () => {
    assert.ok(HARD_KINDS.has("terminal-parent-open-child"));
    for (const k of ["empty-body", "config-project-drift"]) {
      assert.ok(SOFT_KINDS.includes(k), k);
      assert.ok(!HARD_KINDS.has(k), k);
    }
  });

  test("terminal-parent-open-child: any type pair, cross-project, open children in id order", () => {
    const f = governanceFindings({ tickets: [
      t("ENG-1", "done", { type: "feature" }),
      t("ENG-10", "in-progress", { parent: "ENG-1" }), t("ENG-2", "defined", { parent: "ENG-1" }),
      t("OPS-3", "done", { parent: "ENG-1" }),
      t("ENG-5", "achieved", { type: "goal" }), t("OPS-9", "proposed", { type: "requirement", parent: "ENG-5" }),
      t("ENG-7", "implemented", { type: "requirement" }), t("ENG-8", "defined", { parent: "ENG-7" }),
      t("ENG-11", "defined", { parent: "ENG-404" }),
    ] }).filter((x) => x.kind === "terminal-parent-open-child");
    assert.deepEqual(f, [
      { ticket: "ENG-1", kind: "terminal-parent-open-child", detail: "feature done with 2/3 children open: ENG-2, ENG-10" },
      { ticket: "ENG-5", kind: "terminal-parent-open-child", detail: "goal achieved with 1/1 children open: OPS-9" },
    ], "`implemented` is not in the script's set, and a dangling parent is dangling-parent's job");
  });

  test("empty-body: scaffold-only bodies, non-terminal tickets only", () => {
    for (const line of ["", "   ", "## Context", "- [ ]", "* [x]", "-", "*", "<!-- note -->"]) {
      assert.equal(isScaffoldLine(line), true, JSON.stringify(line));
    }
    for (const line of ["prose", "- [ ] a real criterion", "- a bullet", "<!-- open"]) {
      assert.equal(isScaffoldLine(line), false, JSON.stringify(line));
    }
    assert.equal(bodyIsEmpty("## Context\n\n## Acceptance Criteria\n\n- [ ]\n"), true);
    assert.equal(bodyIsEmpty(""), true);
    const f = governanceFindings({ tickets: [
      t("ENG-1", "defined", { body: "## Context\n\n- [ ]\n" }),
      t("ENG-2", "done", { body: "" }),
      t("ENG-3", "defined"),
    ] }).filter((x) => x.kind === "empty-body");
    assert.deepEqual(f, [{ ticket: "ENG-1", kind: "empty-body", detail: "defined" }]);
  });

  test("config-project-drift: both directions; skipped when the config did not load", () => {
    const f = governanceFindings({ configProjects: ["ENG", "OPS"], storeProjects: ["ENG", "NEW"] });
    assert.deepEqual(f.map((x) => [x.ticket, x.kind]), [["NEW", "config-project-drift"], ["OPS", "config-project-drift"]]);
    assert.match(f[0].detail, /store holds this project but blaze\.config\.json's projects does not list it/);
    assert.match(f[1].detail, /lists this project but the store holds none of it/);
    assert.deepEqual(governanceFindings({ configProjects: null, storeProjects: ["X"] }), []);
  });
});

// --- the runner ----------------------------------------------------------------------------------
const doc = (fm, body = "Some prose.") =>
  ["---", ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), "---", "", body, ""].join("\n");

/** A done feature ENG-1 with an open child ENG-2 whose body is scaffold-only; config lists ENG
 *  and a project OPS that has no directory. */
function board() {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz681-audit-")));
  const projectsDir = join(dataRoot, "projects");
  for (const s of ["done", "defined"]) mkdirSync(join(projectsDir, "ENG", s), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"), JSON.stringify({ projects: ["ENG", "OPS"] }));
  writeFileSync(join(projectsDir, "ENG", "done", "ENG-1-f.md"),
    doc({ id: "ENG-1", title: "F", type: "feature", project: "ENG", components: "[a]", labels: "[b]" }));
  writeFileSync(join(projectsDir, "ENG", "defined", "ENG-2-t.md"),
    doc({ id: "ENG-2", title: "T", type: "task", project: "ENG", parent: "ENG-1", estimate: 30,
          components: "[a]", labels: "[b]" }, "## Context\n\n## Acceptance Criteria\n\n- [ ]"));
  return { dataRoot, projectsDir };
}
/** `blaze audit` against `projectsDir`, with the caller's mode only: an ambient
 *  BLAZE_WRITE_PORT must not leak in, and an EMPTY one is refused, so it is removed. */
function audit(projectsDir, args = [], env = {}) {
  const base = { ...process.env };
  delete base.BLAZE_WRITE_PORT;
  return spawnSync(process.execPath, [AUDIT, ...args, projectsDir],
    { encoding: "utf8", env: { ...base, ...env } });
}

test("blaze audit reports all three, and the hard one fails the run", () => {
  const { projectsDir } = board();
  const r = audit(projectsDir, ["--json"]);
  assert.equal(r.status, 1, r.stderr);
  const kinds = JSON.parse(r.stdout).findings.map((f) => `${f.ticket} ${f.kind}`);
  for (const k of ["ENG-1 terminal-parent-open-child", "ENG-2 empty-body", "OPS config-project-drift"]) {
    assert.ok(kinds.includes(k), `${k} missing from ${kinds.join("; ")}`);
  }
});

test("--fail-on gates on the named kinds only, hard or soft, and says so", () => {
  const { projectsDir } = board();
  const other = audit(projectsDir, ["--fail-on", "duplicate-status"]);
  assert.equal(other.status, 0, "a hard finding of ANOTHER kind does not fail a --fail-on run");
  assert.match(other.stdout, /fail-on duplicate-status: 0 finding\(s\)/);
  assert.match(other.stdout, /ok=false/, "the report still says what it found");
  const soft = audit(projectsDir, ["--fail-on", "duplicate-status,empty-body"]);
  assert.equal(soft.status, 1, "a soft kind can gate when it is named");
  assert.match(soft.stdout, /fail-on duplicate-status,empty-body: 1 finding\(s\)/);
  const json = JSON.parse(audit(projectsDir, ["--json", "--fail-on", "terminal-parent-open-child"]).stdout);
  assert.deepEqual([json.failOn, json.failing], [["terminal-parent-open-child"], 1]);
});

test("--fail-on refuses a name that is not a kind (exit 2), so a typo is never a gate that cannot fail", () => {
  const { projectsDir } = board();
  const r = audit(projectsDir, ["--fail-on", "duplicate-statsu"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--fail-on names no such kind: duplicate-statsu/);
  const none = audit(projectsDir, ["--fail-on", ""]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--fail-on needs at least one kind/);
});

test("under BLAZE_WRITE_PORT=db the kinds come from the DATABASE, not the files", async () => {
  const roots = board();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  // Changed on disk only: the FILE now has prose and no parent; the ROW is as it was loaded.
  writeFileSync(join(roots.projectsDir, "ENG", "defined", "ENG-2-t.md"),
    doc({ id: "ENG-2", title: "T", type: "task", project: "ENG", estimate: 30 }, "Now it has prose."));
  const r = audit(roots.projectsDir, ["--json"], { BLAZE_WRITE_PORT: "db" });
  assert.equal(r.status, 1, r.stderr);
  const kinds = JSON.parse(r.stdout).findings.map((f) => `${f.ticket} ${f.kind}`);
  assert.ok(kinds.includes("ENG-1 terminal-parent-open-child"), kinds.join("; "));
  assert.ok(kinds.includes("ENG-2 empty-body"), kinds.join("; "));
  assert.ok(kinds.includes("OPS config-project-drift"), kinds.join("; "));
});

test("--projects scopes what is JUDGED, never what RESOLVES: a cross-project link or parent is not dangling", () => {
  // The defect: audit-runner filtered the corpus to --projects BEFORE auditCorpus built its id
  // set, so `blaze audit --projects BLZ` called BLZ-134 → INF-750 a hard dangling-target while
  // the unscoped audit called the same board clean.
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz681-scope-")));
  const projectsDir = join(dataRoot, "projects");
  for (const p of ["ENG", "OPS"]) mkdirSync(join(projectsDir, p, "defined"), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"), JSON.stringify({ projects: ["ENG", "OPS"] }));
  const flow = (target) => `\nlinks:\n  - { type: Relates, target: ${target} }`;
  const file = (p, id, extra) => writeFileSync(join(projectsDir, p, "defined", `${id}-x.md`),
    `---\nid: ${id}\ntitle: ${id}\ntype: ${extra.type}\nproject: ${p}\nparent: ${extra.parent ?? ""}`
    + `\nestimate: 30\ncomponents: [a]\nlabels: [b]${extra.links ?? ""}\n---\n\nProse.\n`);
  file("OPS", "OPS-1", { type: "feature" });
  file("ENG", "ENG-1", { type: "task", parent: "OPS-1", links: flow("OPS-1") });
  file("ENG", "ENG-2", { type: "task", parent: "OPS-1", links: flow("OPS-99") });
  const r = audit(projectsDir, ["--json", "--projects", "ENG"]);
  const found = JSON.parse(r.stdout).findings.map((f) => `${f.ticket} ${f.kind} ${f.detail}`);
  assert.deepEqual(found.filter((f) => /dangling/.test(f)), ["ENG-2 dangling-target OPS-99"],
    "only the truly missing target is dangling; OPS-1 exists, out of scope");
  assert.ok(!found.some((f) => f.startsWith("OPS-1 ")), "an out-of-scope ticket is resolved, never judged");
  assert.equal(r.status, 1, "the one real dangling target is still hard");
});
```

In `tests/audit-terminal-goal-unverified.test.mjs`, replace:

```js
test("R48: a soft finding does not fail the run", () => {
  const report = audit(board("implemented"));
  assert.equal(report.ok, true, "a fill-queue finding must never fail the gate");
```

with:

```js
test("R48: a soft finding does not fail the run", () => {
  // BLZ-681: under an `achieved` goal, an `implemented` requirement is ALSO an open child of a
  // terminal parent — the hard `terminal-parent-open-child` (`implemented` is not in the
  // re-homed script's terminal set). `canceled` is terminal for R48 and not for that kind, so
  // this board still holds the soft finding and only the soft finding, which is what this
  // test is about.
  const report = audit(board("implemented", { goalStatus: "canceled" }));
  assert.equal(report.findings.filter((f) => f.kind === KIND).length, 1, "the soft finding is still raised");
  assert.equal(report.ok, true, "a fill-queue finding must never fail the gate");
```


- [ ] **Step 2: Run them to verify they fail.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/audit-governance.test.mjs tests/audit-terminal-goal-unverified.test.mjs
```

Expected: `tests/audit-governance.test.mjs` fails to load (`does not provide an export named 'governanceFindings'`); the R48 file still passes (its fixture change is behaviour-neutral until Step 3).

- [ ] **Step 3: Implement.**

In `scripts/audit-runner.mjs`, replace (1/11):

```js
// scripts/audit-runner.mjs — `blaze audit`: corpus hygiene over the whole board.
// Run: node scripts/audit-runner.mjs [--projects A,B] [--kind k] [--json] [projectsDir]
//
```

with:

```js
// scripts/audit-runner.mjs — `blaze audit`: corpus hygiene over the whole board.
// Run: node scripts/audit-runner.mjs [--projects A,B] [--kind k] [--fail-on k1,k2] [--json] [projectsDir]
//
```

In `scripts/audit-runner.mjs`, replace (2/11):

```js
import { join, dirname, resolve as resolvePath } from "node:path";
import { auditCorpus, summarise, HARD_KINDS, SOFT_KINDS, scheduleFindings } from "./model/audit.mjs";
import { scheduleModel } from "./model/schedule.mjs";
```

with:

```js
import { join, dirname, resolve as resolvePath } from "node:path";
import { auditCorpus, summarise, HARD_KINDS, SOFT_KINDS, scheduleFindings, governanceFindings } from "./model/audit.mjs";
import { scheduleModel } from "./model/schedule.mjs";
```

In `scripts/audit-runner.mjs`, replace (3/11):

```js
const positional = [];
const opts = { projects: null, kind: null, json: false };
for (let i = 2; i < process.argv.length; i++) {
```

with:

```js
const positional = [];
const opts = { projects: null, kind: null, json: false, failOn: null };
for (let i = 2; i < process.argv.length; i++) {
```

In `scripts/audit-runner.mjs`, replace (4/11):

```js
  if (a === "--kind") { opts.kind = process.argv[++i]; continue; }
  if (a === "--help" || a === "-h") { usage(); process.exit(0); }
```

with:

```js
  if (a === "--kind") { opts.kind = process.argv[++i]; continue; }
  if (a === "--fail-on") { opts.failOn = (process.argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean); continue; }
  if (a === "--help" || a === "-h") { usage(); process.exit(0); }
```

In `scripts/audit-runner.mjs`, replace (5/11):

```js
function usage() {
  console.error("usage: blaze audit [--projects A,B] [--kind <kind>] [--json] [projectsDir]");
  console.error("  Reports corpus hygiene. Exits non-zero on a HARD finding only.");
  console.error(`  hard: ${[...HARD_KINDS].sort().join(", ")}`);
  // Hardcoded, and it went stale twice — the hard line beside it is derived from HARD_KINDS
  // and cannot. Kept in one place with the kinds that actually exist.
  console.error(`  soft: ${SOFT_KINDS.join(", ")}`);
}
```

with:

```js
function usage() {
  console.error("usage: blaze audit [--projects A,B] [--kind <kind>] [--fail-on <kind,…>] [--json] [projectsDir]");
  console.error("  Reports corpus hygiene. Exits non-zero on a HARD finding only — or, with --fail-on,");
  console.error("  on a finding of one of the named kinds only (hard or soft), whatever else it found.");
  console.error(`  hard: ${[...HARD_KINDS].sort().join(", ")}`);
  // Hardcoded, and it went stale twice — the hard line beside it is derived from HARD_KINDS
  // and cannot. Kept in one place with the kinds that actually exist.
  console.error(`  soft: ${SOFT_KINDS.join(", ")}`);
}

// BLZ-681: `--fail-on` turns ONE kind (or a few) into the gate, so a board that already carries
// other hard findings can still gate on, say, `duplicate-status` — which is what blaze-pm's
// `duplicate_id_check.py` existed for. A name that is not a kind is REFUSED rather than ignored:
// a typo would otherwise be a gate that can never fail. Exit 2, like an empty corpus — a run
// that could not measure what it was asked to.
if (opts.failOn !== null) {
  const known = new Set([...HARD_KINDS, ...SOFT_KINDS]);
  const unknown = opts.failOn.filter((k) => !known.has(k));
  if (!opts.failOn.length || unknown.length) {
    console.error(opts.failOn.length
      ? `blaze audit: --fail-on names no such kind: ${unknown.join(", ")}`
      : "blaze audit: --fail-on needs at least one kind");
    usage();
    process.exit(2);
  }
}
```

In `scripts/audit-runner.mjs`, replace (6/11):

```js

const report = auditCorpus({ tickets, projects, config });

```

with:

```js

// BLZ-681: `universe` — links and parents RESOLVE against everything the store holds, while
// only the in-scope `tickets` are judged. See auditCorpus.
const report = auditCorpus({ tickets, projects, config, universe: allTickets });

```

In `scripts/audit-runner.mjs`, replace (7/11):

```js
const unreadable = await rs.readStorage.unreadableTicketDirs(projectsDir);
await rs.close();
```

with:

```js
const unreadable = await rs.readStorage.unreadableTicketDirs(projectsDir);
// BLZ-681: the projects the READ STORE holds — directories under fs/dual, project keys with
// tickets under db — for `config-project-drift`. Asked before the reader closes.
const storeProjects = await rs.readStorage.listProjects(projectsDir);
await rs.close();
```

In `scripts/audit-runner.mjs`, replace (8/11):

```js

// auditCorpus computed `ok` before the walk-level findings existed, so recompute it — a gate
```

with:

```js

// BLZ-681 (spec §5.6): the three governance kinds re-homed from blaze-pm. Raised HERE because
// two of them need the walk (status) and one needs the store's project list; the rules live in
// `governanceFindings` in model/audit.mjs, where the coverage gate sees them.
// An EMPTY or absent `projects` is no list to drift from: the audit itself falls back to the
// store's own listing for it (`nonEmpty` above), and a directory audited outside any board has
// no config at all.
report.findings.push(...governanceFindings({
  tickets, configProjects: nonEmpty(config?.projects), storeProjects,
}));

// auditCorpus computed `ok` before the walk-level findings existed, so recompute it — a gate
```

In `scripts/audit-runner.mjs`, replace (9/11):

```js
const findings = opts.kind ? report.findings.filter((f) => f.kind === opts.kind) : report.findings;

if (opts.json) {
  console.log(JSON.stringify({ ...report, findings }, null, 2));
} else {
```

with:

```js
const findings = opts.kind ? report.findings.filter((f) => f.kind === opts.kind) : report.findings;
// BLZ-681: with --fail-on the exit code answers "is there a finding of THESE kinds", and only that.
const failOn = opts.failOn ? new Set(opts.failOn) : null;
const failing = failOn ? report.findings.filter((f) => failOn.has(f.kind)).length : null;

if (opts.json) {
  console.log(JSON.stringify({ ...report, findings,
    ...(failOn ? { failOn: [...failOn], failing } : {}) }, null, 2));
} else {
```

In `scripts/audit-runner.mjs`, replace (10/11):

```js
  console.log(`  ok=${report.ok}${report.ok ? "" : "  (hard findings present)"}`);
}
```

with:

```js
  console.log(`  ok=${report.ok}${report.ok ? "" : "  (hard findings present)"}`);
  if (failOn) console.log(`  fail-on ${[...failOn].join(",")}: ${failing} finding(s)`);
}
```

In `scripts/audit-runner.mjs`, replace (11/11):

```js
// at 64KB the first time it was piped.
process.exitCode = report.ok ? 0 : 1;
```

with:

```js
// at 64KB the first time it was piped.
process.exitCode = failOn ? (failing ? 1 : 0) : (report.ok ? 0 : 1);
```

In `scripts/model/audit.mjs`, replace (1/4):

```js
  "deadline-unreachable", "dependency-cycle", "schedule-stale", "schedule-empty",
];
```

with:

```js
  "deadline-unreachable", "dependency-cycle", "schedule-stale", "schedule-empty",
  // BLZ-681: re-homed from blaze-pm's `empty_body_scan.py` and `config_drift_check.py` —
  // `governanceFindings` below says why each is soft.
  "empty-body", "config-project-drift",
];
```

In `scripts/model/audit.mjs`, replace (2/4):

```js
  "unreadable-ticket-directory",
]);
```

with:

```js
  "unreadable-ticket-directory",
  // BLZ-681 (spec §5.6): re-homed from blaze-pm's `terminal_parent_scan.py`. A terminal ticket
  // with a non-terminal child asserts the work is finished while the child says it is not, and
  // both cannot be true — the corpus is WRONG, so HARD, as the spec decides. MEASURED before
  // shipping (the BLZ-353 lesson): blaze-pm's BLZ-305-v4-spine at 8bd7fd3d holds 66 such parents
  // with 279 open children, so `blaze audit` on that board fails on this kind until INF-733's
  // remedy runs. `blaze audit --fail-on <kinds>` is how a gate checks other kinds meanwhile.
  "terminal-parent-open-child",
]);
```

In `scripts/model/audit.mjs`, replace (3/4):

```js
/**
 * @param tickets   [{ frontmatter, body }] — the whole corpus
 * @param projects  { KEY: projectJson } — taxonomy and optional per-project schema block
 * @param config    the board config, for the top-level schema override
 * @returns { findings: [{ ticket, kind, detail }], ok }
 */
export function auditCorpus({ tickets = [], projects = {}, config = null } = {}) {
  const findings = [];
  const add = (ticket, kind, detail = "") => findings.push({ ticket, kind, detail });

  const ids = new Set();
  const typeById = new Map();
  for (const t of tickets) {
    const fm = t?.frontmatter ?? {};
```

with:

```js
/**
 * @param tickets   [{ frontmatter, body }] — the tickets to JUDGE (the audited scope)
 * @param projects  { KEY: projectJson } — taxonomy and optional per-project schema block
 * @param config    the board config, for the top-level schema override
 * @param universe  every ticket the store holds, to RESOLVE against — a link target or parent
 *                  in a project outside `--projects` still exists. Defaults to `tickets`.
 * @returns { findings: [{ ticket, kind, detail }], ok }
 */
export function auditCorpus({ tickets = [], projects = {}, config = null, universe = null } = {}) {
  const findings = [];
  const add = (ticket, kind, detail = "") => findings.push({ ticket, kind, detail });

  // BLZ-681: ids and parent types come from the WHOLE store, not the audited scope. Built from
  // `tickets` alone, `blaze audit --projects BLZ` reported a hard `dangling-target` for every
  // legitimate cross-project link (BLZ-134 → INF-750) and `dangling-parent` for a cross-project
  // parent — targets that exist, in a project the run was not asked to judge. Unscoped, the same
  // board reported none. Findings are still raised only on the tickets in scope.
  const ids = new Set();
  const typeById = new Map();
  for (const t of universe ?? tickets) {
    const fm = t?.frontmatter ?? {};
```

In `scripts/model/audit.mjs`, replace (4/4):

```js
/** Counts by kind, for a runner that prints a summary rather than every finding. */
export function summarise(findings) {
```

with:

```js
/** Counts by kind, for a runner that prints a summary rather than every finding. */
// ---------------------------------------------------------------------------------------
// governanceFindings — BLZ-681 (spec §5.6). Three of blaze-pm's governance scripts, re-homed as
// `blaze audit` kinds so they read through `resolveReadStorage` and work under fs, dual and db.
// Each RULE is ported exactly — the sets and patterns below are the scripts' own — so the
// finding count on a board is the count the script reported for it.

/** `terminal_parent_scan.py`'s TERMINAL: the terminal statuses of the delivery, goal and risk
 *  workflows. Deliberately the script's fixed set, not the resolved schema's terminals: an
 *  `implemented` requirement with an open delivery child is the normal state of a requirement
 *  being built, and the script never flagged it. */
export const TERMINAL_PARENT_STATUSES = new Set(["done", "achieved", "mitigated", "accepted", "obsolete"]);

/** `empty_body_scan.py`'s TERMINAL_STATUSES: a terminal ticket with no body is a weaker
 *  historical record, not an active breach, so it is not reported. */
export const EMPTY_BODY_TERMINAL = new Set(["done", "achieved", "implemented", "accepted",
                                            "mitigated", "obsolete", "rejected"]);

/** `is_scaffold_line`: blank, a heading, an empty checkbox, a bare bullet, an HTML comment. */
export function isScaffoldLine(line) {
  const stripped = line.trim();
  return stripped === "" || stripped.startsWith("#")
    || /^\s*[-*]\s*\[[ xX]\]\s*$/.test(line)
    || /^\s*[-*]\s*$/.test(line)
    || /^\s*<!--.*-->\s*$/.test(line);
}

/** `body_is_empty`: every line is scaffold — the shape `blaze new` leaves for a title-only ticket. */
export const bodyIsEmpty = (body) => String(body ?? "").split(/\r\n|\r|\n/).every(isScaffoldLine);

const idOrder = (a, b) => {
  const [ka, na] = [a.slice(0, a.lastIndexOf("-")), Number(a.slice(a.lastIndexOf("-") + 1))];
  const [kb, nb] = [b.slice(0, b.lastIndexOf("-")), Number(b.slice(b.lastIndexOf("-") + 1))];
  return ka < kb ? -1 : ka > kb ? 1 : na - nb;
};

/**
 * @param tickets         [{ frontmatter, body, status }] — the audited corpus, from the read store
 * @param configProjects  blaze.config.json's `projects`, or null when the config did not load
 * @param storeProjects   the project keys the read store holds (`readStorage.listProjects`)
 * @returns findings, `{ ticket, kind, detail }`
 */
export function governanceFindings({ tickets = [], configProjects = null, storeProjects = [] } = {}) {
  const findings = [];

  // terminal-parent-open-child — HARD. Children are found across the whole audited set, so a
  // cross-project parent is still caught; a dangling parent is `dangling-parent`'s job.
  const byId = new Map();
  for (const t of tickets) {
    const id = t?.frontmatter?.id;
    if (id) byId.set(String(id), { status: t.status, type: t.frontmatter.type, parent: t.frontmatter.parent || null });
  }
  const children = new Map();
  for (const [id, t] of byId) {
    if (!t.parent) continue;
    if (!children.has(t.parent)) children.set(t.parent, []);
    children.get(t.parent).push(id);
  }
  for (const parent of [...children.keys()].filter((p) => byId.has(p)).sort(idOrder)) {
    const p = byId.get(parent);
    if (!TERMINAL_PARENT_STATUSES.has(p.status)) continue;
    const kids = children.get(parent);
    const open = kids.filter((k) => !TERMINAL_PARENT_STATUSES.has(byId.get(k).status)).sort(idOrder);
    if (!open.length) continue;
    findings.push({ ticket: parent, kind: "terminal-parent-open-child",
      detail: `${p.type} ${p.status} with ${open.length}/${kids.length} children open: ${open.join(", ")}` });
  }

  // empty-body — SOFT. A fill queue: the ticket is valid, its description is simply not written.
  for (const t of tickets) {
    const id = t?.frontmatter?.id;
    if (!id || EMPTY_BODY_TERMINAL.has(t.status) || !bodyIsEmpty(t.body)) continue;
    findings.push({ ticket: id, kind: "empty-body", detail: String(t.status) });
  }

  // config-project-drift — SOFT. The configured `projects` and the projects the read store
  // holds disagree. Soft because nothing is wrong with any ticket: a project missing from the
  // config is simply not audited or served, and the fix is a config line. Skipped when the
  // config did not load — `config-unloadable` already says so.
  if (Array.isArray(configProjects)) {
    const configured = new Set(configProjects), held = new Set(storeProjects);
    for (const k of [...held].filter((x) => !configured.has(x)).sort()) {
      findings.push({ ticket: k, kind: "config-project-drift",
        detail: "the store holds this project but blaze.config.json's projects does not list it" });
    }
    for (const k of [...configured].filter((x) => !held.has(x)).sort()) {
      findings.push({ ticket: k, kind: "config-project-drift",
        detail: "blaze.config.json's projects lists this project but the store holds none of it" });
    }
  }
  return findings;
}

export function summarise(findings) {
```


- [ ] **Step 4: Run them to verify they pass**, then the neighbours this task touches.

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/audit-governance.test.mjs tests/audit-terminal-goal-unverified.test.mjs
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/audit*.test.mjs tests/model/link-type-overrides.test.mjs tests/board-gate.test.mjs tests/model/schedule-findings.test.mjs tests/blz-407-audit-load-agreement.test.mjs tests/schema-audit-load-agreement-oracle.test.mjs tests/temp-cleanup-guard.test.mjs tests/quoted-sources.test.mjs
```

Expected: 11/11 pass in `tests/audit-governance.test.mjs` and every neighbour green (`link-type-overrides`' "every kind the audit emits is registered" scan finds the three new literals). Discrimination: with `universe: allTickets` changed to `universe: null` in the runner, `--projects scopes what is JUDGED…` fails.

- [ ] **Step 5: Docs, in the same commit.**

In `docs/guide/commands.md`, replace (1/3):

````markdown
```
blaze audit [--projects A,B] [--kind <kind>] [--json] [projectsDir]
```
````

with:

````markdown
```
blaze audit [--projects A,B] [--kind <kind>] [--fail-on <kind,…>] [--json] [projectsDir]
```
````

In `docs/guide/commands.md`, replace (2/3):

```markdown
|---|---|
| hard | `duplicate-status`, `off-taxonomy-component`, `off-taxonomy-label`, `bad-link-key`, `unknown-link-type`, `dangling-target`, `dangling-parent`, `invalid-parent-type`, `parse-error`, `config-unloadable`, `schema-malformed`, `project-mismatch` |
| soft | `empty-components`, `empty-labels`, `missing-parent`, `terminal-goal-unverified-requirement`, `schema-invalid`, `deadline-unreachable`, `dependency-cycle`, `schedule-stale`, `schedule-empty` |

```

with:

```markdown
|---|---|
| hard | `duplicate-status`, `off-taxonomy-component`, `off-taxonomy-label`, `bad-link-key`, `unknown-link-type`, `dangling-target`, `dangling-parent`, `invalid-parent-type`, `parse-error`, `config-unloadable`, `schema-malformed`, `project-mismatch`, `terminal-parent-open-child` |
| soft | `empty-components`, `empty-labels`, `missing-parent`, `terminal-goal-unverified-requirement`, `schema-invalid`, `deadline-unreachable`, `dependency-cycle`, `schedule-stale`, `schedule-empty`, `empty-body`, `config-project-drift` |

```

In `docs/guide/commands.md`, replace (3/3):

```markdown
| `--kind <kind>` | List every finding of one kind, with its detail, instead of the summary. |
| `--json` | Emit the full report as JSON. |
| `projectsDir` | Audit a `projects/` tree outside the current board. |

Exit code is `0` when clean or soft-only, `1` on any hard finding, and `2` when
the corpus is empty — a run that measured nothing is never reported as a pass.

```

with:

```markdown
| `--kind <kind>` | List every finding of one kind, with its detail, instead of the summary. |
| `--fail-on <kind,…>` | Decide the exit code by these kinds only, hard or soft: `1` if any finding of one of them, else `0` — whatever else the run found. An unknown kind is refused (exit `2`). |
| `--json` | Emit the full report as JSON. |
| `projectsDir` | Audit a `projects/` tree outside the current board. |

Exit code is `0` when clean or soft-only, `1` on any hard finding, and `2` when
the corpus is empty — a run that measured nothing is never reported as a pass. With
`--fail-on`, `1` means a finding of a named kind and nothing else.

**Three kinds re-homed from blaze-pm's governance scripts** (BLZ-681). Each reads through the
resolved store, so it works under `fs`, `dual` and `db`, and each rule is the script's own:

- **`terminal-parent-open-child`** (hard, was `terminal_parent_scan.py`): a ticket in `done`,
  `achieved`, `mitigated`, `accepted` or `obsolete` with a child that is not — any type pair,
  across projects. The parent asserts the work is finished while the child says it is not.
  Measured before shipping: blaze-pm's `BLZ-305-v4-spine` holds 66 such parents (279 open
  children), so a whole-board `blaze audit` there exits `1` until they are resolved; gate on
  another kind meanwhile with `--fail-on`.
- **`empty-body`** (soft, was `empty_body_scan.py`): a non-terminal ticket whose body is only
  headings, blank lines, empty checkboxes, bare bullets and HTML comments — what `blaze new`
  leaves for a title-only ticket.
- **`config-project-drift`** (soft, was `config_drift_check.py`): `blaze.config.json`'s
  `projects` and the projects the store holds disagree, in either direction. Not raised when the
  config lists no projects at all.

`blaze audit --fail-on duplicate-status` is the gate `duplicate_id_check.py` was: it fails on a
duplicated id alone, on a board that already carries other hard findings.

**`--projects` scopes what is judged, never what resolves** (BLZ-681). A link target or parent in
a project outside the list still exists, so `blaze audit --projects BLZ` does not call
`BLZ-134 → INF-750` a `dangling-target`; only the listed projects' tickets are judged.

```


- [ ] **Step 6: Fence check, commit, prove the committed tree.**

```bash
git add tests/audit-governance.test.mjs tests/audit-terminal-goal-unverified.test.mjs scripts/audit-runner.mjs scripts/model/audit.mjs docs/guide/commands.md
git diff --cached | grep -c '^+```'      # must print 0
git commit -m "BLZ-681: blaze audit --fail-on, three governance kinds, and --projects resolving across projects" -m "audit.mjs gains terminal-parent-open-child (hard), empty-body and config-project-drift (soft) via governanceFindings, and auditCorpus resolves against the whole store (universe); audit-runner adds --fail-on and wires both. New tests/audit-governance.test.mjs; the R48 fixture moves its goal to canceled; commands.md." -- tests/audit-governance.test.mjs tests/audit-terminal-goal-unverified.test.mjs scripts/audit-runner.mjs scripts/model/audit.mjs docs/guide/commands.md
git status --short                        # must print nothing
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/audit-governance.test.mjs tests/audit-terminal-goal-unverified.test.mjs   # green on the COMMITTED tree
```


---

### Task 7: `blaze matrices` replaces `build_matrices.py` (BLZ-682)

**Files:**
- Create: `tests/fixtures/matrices-board/blaze.config.json`
- Create: `tests/fixtures/matrices-board/docs/matrices/eng-architecture-matrix.md`
- Create: `tests/fixtures/matrices-board/docs/matrices/eng-requirements-matrix.md`
- Create: `tests/fixtures/matrices-board/projects/ENG/accepted/ENG-6-files-are-the-store.md`
- Create: `tests/fixtures/matrices-board/projects/ENG/accepted/ENG-8-another-without-a-ref.md`
- Create: `tests/fixtures/matrices-board/projects/ENG/achieved/ENG-1-ship-the-board.md`
- Create: `tests/fixtures/matrices-board/projects/ENG/defined/ENG-2-keep-it-honest.md`
- Create: `tests/fixtures/matrices-board/projects/ENG/done/ENG-10-build-the-renderer.md`
- Create: `tests/fixtures/matrices-board/projects/ENG/implemented/ENG-3-render-the-board.md`
- Create: `tests/fixtures/matrices-board/projects/ENG/implemented/ENG-5-no-trace-yet.md`
- Create: `tests/fixtures/matrices-board/projects/ENG/in-progress/ENG-9-renderer-feature.md`
- Create: `tests/fixtures/matrices-board/projects/ENG/proposed/ENG-4-reads-are-fast.md`
- Create: `tests/fixtures/matrices-board/projects/ENG/proposed/ENG-7-no-ref-yet.md`
- Create: `tests/matrices.test.mjs`
- Create: `scripts/matrices-runner.mjs`
- Create: `scripts/model/matrices.mjs`
- Modify: `tests/model/seam-closure.test.mjs`
- Modify: `scripts/cli.mjs`
- Modify: `scripts/model/schema-version.mjs`
- Modify: `AGENTS.md`
- Modify: `docs/guide/commands.md`

**Interfaces:**
- Produces (`scripts/model/matrices.mjs`): `requirementsMatrix(tickets, project, pathOf) → string`, `architectureMatrix(tickets, project, pathOf) → string`, `matrixFiles(tickets, project, pathOf) → { "<key>-requirements-matrix.md": string, "<key>-architecture-matrix.md": string }` — `tickets` are reader records (`{ frontmatter, body, project, status, file }`), `pathOf(ticket) → "projects/<KEY>/<status>/<file>.md"` relative to the data root.
- Produces: `blaze matrices [--project KEY] [--check] [--out DIR]` — exit 0 / 1 (drift) / 2 (no projects).

The fixture board's `docs/matrices/*.md` are the output of blaze-pm's `scripts/build_matrices.py --project ENG` run on that board (the prototype ran it; it is reproduced below byte for byte). Create every fixture file with EXACTLY the content shown — each ends with a single newline.

- [ ] **Step 1: Write the failing tests.**

Create `tests/fixtures/matrices-board/blaze.config.json`:

```json
{ "projects": ["ENG"] }
```

Create `tests/fixtures/matrices-board/docs/matrices/eng-architecture-matrix.md`:

```markdown
# ENG architecture decision matrix

> **Derived view — do not edit.** Regenerate with `python3 scripts/build_matrices.py`.

- **3** decisions
- by status: **2** accepted, **1** proposed
- **2** answering no stated requirement (parented to a goal — legal, and counted rather than hidden)

| Ref | Decision | Status | Answers | Ticket |
|---|---|---|---|---|
| `?` | [Another without a ref](../../projects/ENG/accepted/ENG-8-another-without-a-ref.md) | accepted | — *(untraced; under ENG-1)* | ENG-8 |
| `?` | [No ref yet](../../projects/ENG/proposed/ENG-7-no-ref-yet.md) | proposed | — *(untraced; under ENG-2)* | ENG-7 |
| `ADR-0001` | [Files are the store](../../projects/ENG/accepted/ENG-6-files-are-the-store.md) | accepted | `REQ-002` Render the board | ENG-6 |

Reference a decision by its **designator** (`ADR-0011`), never by path — an architecture ticket's path changes with its status (ADR-0017).
```

Create `tests/fixtures/matrices-board/docs/matrices/eng-requirements-matrix.md`:

```markdown
# ENG requirements traceability matrix

> **Derived view — do not edit.** Regenerate with `python3 scripts/build_matrices.py`. The tickets are the source of truth (ADR-0015). A hand-edit here will be overwritten and, worse, believed in the meantime.

- **3** requirements — 2 implemented, 1 proposed
- **3** traced delivery tickets
- **1** implemented requirements with no delivery ticket recorded

## ENG-1 — Ship the board

| Ref | Requirement | Cat | Verify | Status | Implemented by | Addresses |
|---|---|---|---|---|---|---|
| `REQ-001` | [Reads are fast](../../projects/ENG/proposed/ENG-4-reads-are-fast.md) | perf | analy | proposed | ENG-9 | engine ADR-0009, ADR-0012 |
| `REQ-002` | [Render the board](../../projects/ENG/implemented/ENG-3-render-the-board.md) | func | test | implemented | ENG-9, ENG-10 | ADR-0001 |

## ENG-2 — Keep it honest

| Ref | Requirement | Cat | Verify | Status | Implemented by | Addresses |
|---|---|---|---|---|---|---|
| `REQ-003` | [No trace yet](../../projects/ENG/implemented/ENG-5-no-trace-yet.md) | secu | inspe | implemented | — | a decision recorded outside this board |

```

Create `tests/fixtures/matrices-board/projects/ENG/accepted/ENG-6-files-are-the-store.md`:

```markdown
---
id: ENG-6
title: Files are the store
type: architecture
project: ENG
parent: ENG-3
ref: ADR-0001
links:
  - { type: Addresses, target: ENG-3 }
---

Decision.
```

Create `tests/fixtures/matrices-board/projects/ENG/accepted/ENG-8-another-without-a-ref.md`:

```markdown
---
id: ENG-8
title: Another without a ref
type: architecture
project: ENG
parent: ENG-1
---

A tie with ENG-7 on the empty ref.
```

Create `tests/fixtures/matrices-board/projects/ENG/achieved/ENG-1-ship-the-board.md`:

```markdown
---
id: ENG-1
title: Ship the board
type: goal
project: ENG
---

The goal.
```

Create `tests/fixtures/matrices-board/projects/ENG/defined/ENG-2-keep-it-honest.md`:

```markdown
---
id: ENG-2
title: Keep it honest
type: goal
project: ENG
---

A second goal.
```

Create `tests/fixtures/matrices-board/projects/ENG/done/ENG-10-build-the-renderer.md`:

```markdown
---
id: ENG-10
title: Build the renderer
type: task
project: ENG
parent: ENG-9
estimate: 30
links:
  - { type: Implements, target: ENG-3 }
---

Work.
```

Create `tests/fixtures/matrices-board/projects/ENG/implemented/ENG-3-render-the-board.md`:

```markdown
---
id: ENG-3
title: Render the board
type: requirement
project: ENG
parent: ENG-1
ref: REQ-002
category: functional
verification: test
---

**Addresses:** a prose-only decision
```

Create `tests/fixtures/matrices-board/projects/ENG/implemented/ENG-5-no-trace-yet.md`:

```markdown
---
id: ENG-5
title: No trace yet
type: requirement
project: ENG
parent: ENG-2
ref: REQ-003
category: security
verification: inspection
---

Nothing implements this.

**Addresses:** a decision recorded outside this board
```

Create `tests/fixtures/matrices-board/projects/ENG/in-progress/ENG-9-renderer-feature.md`:

```markdown
---
id: ENG-9
title: Renderer feature
type: feature
project: ENG
parent: ENG-3
links:
  - { type: Implements, target: ENG-3 }
  - { type: Implements, target: ENG-4 }
---

Feature.
```

Create `tests/fixtures/matrices-board/projects/ENG/proposed/ENG-4-reads-are-fast.md`:

```markdown
---
id: ENG-4
title: Reads are fast
type: requirement
project: ENG
parent: ENG-1
ref: REQ-001
category: performance
verification: analysis
---

Cites engine ADR-0012 and engine ADR-0009 in prose.
```

Create `tests/fixtures/matrices-board/projects/ENG/proposed/ENG-7-no-ref-yet.md`:

```markdown
---
id: ENG-7
title: No ref yet
type: architecture
project: ENG
parent: ENG-2
---

Untraced: parented to a goal, and no designator.
```

Create `tests/matrices.test.mjs`:

```js
// tests/matrices.test.mjs — BLZ-682: `blaze matrices`, replacing blaze-pm's build_matrices.py.
//
// GENERATOR-ORACLE, IN MINIATURE. tests/fixtures/matrices-board/docs/matrices/ is the output
// `python3 scripts/build_matrices.py --project ENG` wrote for that fixture board, committed
// byte for byte, so every assertion below compares against the script's own output rather than
// a hand-derived expectation. The board exercises each rule: goals sorted as strings, `ref`
// ordering with a TIE (ENG-7/ENG-8 have no ref — path order, not id order), Implements
// tracing, Addresses by link, by `engine ADR-n` prose and by the `**Addresses:**` fallback, the
// `[:4]`/`[:5]` truncations, an untraced decision, and `?` for a missing ref.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fsReadStorage } from "../scripts/model/read-storage.mjs";
import { matrixFiles } from "../scripts/model/matrices.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";
import { QUIET } from "./helpers/db-board.mjs";

const scratch = scratchRegistry();
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "matrices-board");
const CLI = join(HERE, "..", "scripts", "cli.mjs");
const NAMES = ["eng-requirements-matrix.md", "eng-architecture-matrix.md"];
const expected = (name) => readFileSync(join(FIXTURE, "docs", "matrices", name), "utf8");

/** A private copy of the fixture board, so a run may write into it. */
function copy() {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz682-matrices-")));
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}
function matrices(root, args = [], env = {}) {
  const base = { ...process.env };
  delete base.BLAZE_WRITE_PORT;
  delete base.BLAZE_READONLY;
  return spawnSync(process.execPath, [CLI, "matrices", ...args],
    { encoding: "utf8", env: { ...base, BLAZE_PROJECTS_DIR: join(root, "projects"), ...env } });
}

test("matrixFiles reproduces the script's two files byte for byte", () => {
  const tickets = [...fsReadStorage.listTickets(join(FIXTURE, "projects"))];
  const files = matrixFiles(tickets, "ENG", (t) => relative(FIXTURE, t.file));
  assert.deepEqual(Object.keys(files), NAMES);
  for (const n of NAMES) assert.equal(files[n], expected(n), n);
});

test("a tie on ref is broken by PATH, as a sorted glob would — not by id, not by walk order", () => {
  const tickets = [...fsReadStorage.listTickets(join(FIXTURE, "projects"))].reverse();
  const arch = matrixFiles(tickets, "ENG", (t) => relative(FIXTURE, t.file))["eng-architecture-matrix.md"];
  assert.ok(arch.indexOf("ENG-8 |") < arch.indexOf("ENG-7 |"),
    "accepted/ENG-8 sorts before proposed/ENG-7 whatever order the tickets arrive in");
  assert.equal(arch, expected("eng-architecture-matrix.md"));
});

test("only the named project's tickets are rendered", () => {
  const tickets = [...fsReadStorage.listTickets(join(FIXTURE, "projects"))];
  const other = matrixFiles(tickets, "OPS", () => "x")["ops-requirements-matrix.md"];
  assert.match(other, /^# OPS requirements traceability matrix/);
  assert.match(other, /\*\*0\*\* requirements — 0 implemented, 0 proposed/);
});

test("blaze matrices --check: in sync exits 0; a drifted file exits 1 and is named", () => {
  const root = copy();
  const ok = matrices(root, ["--check"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /matrices are in sync with the tickets/);
  writeFileSync(join(root, "docs", "matrices", NAMES[0]), "hand-edited\n");
  const drift = matrices(root, ["--check"]);
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /MATRIX DRIFT — regenerate: eng-requirements-matrix\.md$/m);
  assert.equal(readFileSync(join(root, "docs", "matrices", NAMES[0]), "utf8"), "hand-edited\n",
    "--check writes nothing");
});

test("blaze matrices --out writes the two files, and they are the script's", () => {
  const root = copy();
  const out = join(root, "elsewhere");
  const r = matrices(root, ["--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out).sort(), [...NAMES].sort());
  for (const n of NAMES) assert.equal(readFileSync(join(out, n), "utf8"), expected(n), n);
  assert.match(r.stdout, /wrote elsewhere\/eng-requirements-matrix\.md/);
});

test("BLAZE_READONLY refuses a write — even run directly — but allows --check", () => {
  const root = copy();
  const out = join(root, "ro");
  const viaCli = matrices(root, ["--out", out], { BLAZE_READONLY: "1" });
  assert.notEqual(viaCli.status, 0);
  assert.match(viaCli.stderr, /read-only mode \(BLAZE_READONLY=1\)/);
  const direct = spawnSync(process.execPath, [join(HERE, "..", "scripts", "matrices-runner.mjs"), "--out", out],
    { encoding: "utf8", env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects"), BLAZE_READONLY: "1" } });
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /refusing to run blaze matrices/);
  assert.equal(existsSync(out), false, "nothing written");
  assert.equal(matrices(root, ["--check"], { BLAZE_READONLY: "1" }).status, 0);
});

test("under BLAZE_WRITE_PORT=db the matrices come from the database, and match", async () => {
  const root = copy();
  assert.equal(await runDb(["init"], { ...QUIET, roots: { dataRoot: root, projectsDir: join(root, "projects") } }), 0);
  writeFileSync(join(root, "projects", "ENG", "implemented", "ENG-5-no-trace-yet.md"),
    "---\nid: ENG-5\ntitle: CHANGED ON DISK ONLY\ntype: requirement\nproject: ENG\n---\n\nx\n");
  const out = join(root, "from-db");
  const r = matrices(root, ["--out", out], { BLAZE_WRITE_PORT: "db" });
  assert.equal(r.status, 0, r.stderr);
  for (const n of NAMES) assert.equal(readFileSync(join(out, n), "utf8"), expected(n), n);
});

test("an empty board is refused (exit 2), never reported as in sync", () => {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz682-empty-")));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: [] }));
  const r = matrices(root, ["--check"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no projects found/);
});

test("an unknown argument, or --out with no value, is refused with the usage", () => {
  const root = copy();
  for (const args of [["--bogus"], ["--out"]]) {
    const r = matrices(root, args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /usage: blaze matrices/);
  }
});
```

In `tests/model/seam-closure.test.mjs`, replace (1/2):

```js
  ["sprint-runner.mjs", { writes: [], sanctioned: [], inert: [] }],
  // BLZ-670: `stageFor` returns commitOrQueue (or a filter that calls it) — a write, not inert.
```

with:

```js
  ["sprint-runner.mjs", { writes: [], sanctioned: [], inert: [] }],
  ["matrices-runner.mjs", { writes: [], sanctioned: [], inert: [] }],   // BLZ-682: a CLI verb, no exports
  // BLZ-670: `stageFor` returns commitOrQueue (or a filter that calls it) — a write, not inert.
```

In `tests/model/seam-closure.test.mjs`, replace (2/2):

```js
  ["sprint-runner.mjs", ["saveSprints", "commitOrQueue"]],
  // BLZ-535 round 7, Finding 2. Fifteen more, and they are the cost of deleting a false
```

with:

```js
  ["sprint-runner.mjs", ["saveSprints", "commitOrQueue"]],
  // BLZ-682: `blaze matrices` writes the two derived matrix files per project into --out —
  // generated docs, never a ticket — through the FIFO-safe primitive, after creating the dir.
  ["matrices-runner.mjs", ["mkdirSync", "writeRegularFileSync"]],
  // BLZ-535 round 7, Finding 2. Fifteen more, and they are the cost of deleting a false
```


- [ ] **Step 2: Run them to verify they fail.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/matrices.test.mjs tests/model/seam-closure.test.mjs tests/schema-version-fixture-census.test.mjs
```

Expected: `tests/matrices.test.mjs` fails to load (`Cannot find module '…/scripts/model/matrices.mjs'`); `seam-closure` fails "the write-seam scan OBSERVED the corpus, and its allowlist is all load-bearing" (`matrices-runner.mjs` is named but does not exist yet); `schema-version-fixture-census` fails `5 !== 6` (the new fixture board) until Step 3's comment change.

- [ ] **Step 3: Implement.**

In `scripts/cli.mjs`, replace (1/2):

```js
  rollup: { file: "rollup-runner.mjs", desc: "print rolled-up estimate/worklog totals", mutates: false },
  migrate: { file: "migrate-runner.mjs", desc: "import tickets from a Jira export", mutates: true },
```

with:

```js
  rollup: { file: "rollup-runner.mjs", desc: "print rolled-up estimate/worklog totals", mutates: false },
  // BLZ-682: replaces blaze-pm's build_matrices.py. It writes files, so it mutates; `--check`
  // writes nothing and is that verb's read-only invocation (BLZ-499's mechanism).
  matrices: { file: "matrices-runner.mjs", desc: "regenerate the requirements/architecture matrices (--check: report drift only)", mutates: true, readOnlyFlags: ["--check"] },
  migrate: { file: "migrate-runner.mjs", desc: "import tickets from a Jira export", mutates: true },
```

In `scripts/cli.mjs`, replace (2/2):

```js
//
// That leaves 20 of the 23 subcommands in `SUBCOMMANDS` running this check.
//
```

with:

```js
//
// That leaves 21 of the 24 subcommands in `SUBCOMMANDS` running this check.
//
```

Create `scripts/matrices-runner.mjs`:

```js
// scripts/matrices-runner.mjs — `blaze matrices [--project KEY] [--check] [--out DIR]` (BLZ-682).
//
// Replaces blaze-pm's `scripts/build_matrices.py` (spec §5.6). The I/O half only: the tickets
// come through `resolveReadStorage` (fs, dual and db alike) and every byte of every file comes
// from `model/matrices.mjs`, where the coverage gate sees it (`.c8rc.json` excludes runners).
//
//   default   write `<KEY>-requirements-matrix.md` and `<KEY>-architecture-matrix.md` for each
//             project into --out (default `<data root>/docs/matrices`)
//   --check   write nothing; exit 1 naming every file that differs from what would be written —
//             the script's CI gate, `matrices-in-sync`
import { mkdirSync } from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";
import { readRegularFileSync, writeRegularFileSync } from "./model/regular-file.mjs";
import { resolveRoots, loadConfig } from "./config.mjs";
import { resolveReadStorage } from "./model/write-port-resolve.mjs";
import { ticketPath } from "./model/storage.mjs";
import { matrixFiles } from "./model/matrices.mjs";
import { assertWritable } from "./readonly.mjs";

const USAGE = `usage: blaze matrices [--project KEY] [--check] [--out DIR]

  Regenerate the requirements and architecture matrices — derived views of the tickets.
  --project KEY   one project only (default: every configured project)
  --check         write nothing; exit 1 if a committed matrix differs from the tickets
  --out DIR       where the files live (default: <data root>/docs/matrices)`;

const opts = { project: null, check: false, out: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--check") { opts.check = true; continue; }
  if (a === "--project" || a === "--out") {
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) { console.error(`blaze matrices: ${a} needs a value\n\n${USAGE}`); process.exit(1); }
    opts[a.slice(2)] = v;
    continue;
  }
  if (a === "--help" || a === "-h") { console.log(USAGE); process.exit(0); }
  console.error(`blaze matrices: unknown argument ${a}\n\n${USAGE}`);
  process.exit(1);
}

const { dataRoot, projectsDir } = resolveRoots();
const out = opts.out ? resolvePath(opts.out) : join(dataRoot, "docs", "matrices");

// The per-runner BLAZE_READONLY guard every mutating runner carries (AGENTS.md), before anything
// is written. `--check` writes nothing and is allowed, exactly as cli.mjs's readOnlyFlags says.
if (!opts.check) {
  try { assertWritable("run blaze matrices"); }
  catch (e) { console.error(e.message); process.exit(1); }
}

const rs = await resolveReadStorage({ dataRoot, projectsDir }).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
let tickets, keys;
try {
  tickets = [...(await rs.readStorage.listTickets(projectsDir))];
  const configured = loadConfig({ root: dataRoot }).projects ?? [];
  keys = opts.project ? [opts.project]
    : (configured.length ? configured : await rs.readStorage.listProjects(projectsDir));
} finally { await rs.close(); }
if (!keys.length) {
  // A run that rendered nothing must not report that everything is in sync.
  console.error(`blaze matrices: no projects found under ${projectsDir}`);
  process.exit(2);
}

// The link column. Under fs and dual a ticket's record carries its real path. Under db there
// is no file, so the link is the canonical path `ticketPath` gives — what the file would be
// called if it were written today.
const pathOf = rs.mode === "db"
  ? (t) => relative(dataRoot, ticketPath(projectsDir, t.project, t.status, t.frontmatter.id, t.frontmatter.title))
  : (t) => relative(dataRoot, t.file);

const drift = [];
if (!opts.check) mkdirSync(out, { recursive: true });
for (const key of keys) {
  for (const [name, content] of Object.entries(matrixFiles(tickets, key, pathOf))) {
    const path = join(out, name);
    if (opts.check) {
      let existing = null;
      try { existing = readRegularFileSync(path); } catch (e) { if (e?.code !== "ENOENT") throw e; }
      if (existing !== content) drift.push(name);
    } else {
      writeRegularFileSync(path, content);
      console.log(`wrote ${relative(dataRoot, path)}`);
    }
  }
}
if (opts.check) {
  if (drift.length) {
    console.error(`MATRIX DRIFT — regenerate: ${drift.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("matrices are in sync with the tickets");
  }
}
```

Create `scripts/model/matrices.mjs`:

```js
// scripts/model/matrices.mjs — the requirements and architecture matrices (BLZ-682).
//
// A PORT of blaze-pm's `scripts/build_matrices.py`, kept byte-for-byte compatible with its
// output: the 22 files it generates are the acceptance oracle (generator-oracle — a zero
// `diff -r` against what the script writes for the same tree). That is why some choices below
// look odd for JavaScript — `None` printed for a parent with no `ref`, `cat[:4]` truncation,
// goals sorted as strings. Each mirrors a line of the script; "fixing" one breaks the oracle.
//
// Pure: it takes tickets the CALLER read (through `resolveReadStorage`, so fs, dual and db all
// work) and a `pathOf(ticket)` for the link column, and returns `{ fileName: text }`.

/** The script's frontmatter values are raw strings; the engine's are parsed. Normalise. */
const s = (v) => (v === null || v === undefined ? "" : Array.isArray(v) ? v.join(", ") : String(v));
/** Python's `d.get(k, dflt)`: the default only when the key is ABSENT. A key written with no
 *  value (`ref:`) is present and empty — the engine's parser reads it as `[]`. The database
 *  readers return `""` for a NULL column, which is the database's spelling of ABSENT, so `""`
 *  takes the default too; that keeps a db-mode matrix equal to the fs-mode one. */
const get = (fm, k, dflt) => (fm && Object.hasOwn(fm, k) && fm[k] !== null && fm[k] !== undefined
  && fm[k] !== "" ? s(fm[k]) : dflt);

const ID_HEAD = /^([A-Z]+-\d+)/;

/** `_links`: typed links whose type is letters and whose target STARTS with `[A-Z]+-\d+`. */
function linksOf(t) {
  const out = [];
  for (const l of Array.isArray(t.frontmatter?.links) ? t.frontmatter.links : []) {
    const ty = /^([A-Za-z]+)/.exec(s(l?.type));
    const tg = ID_HEAD.exec(s(l?.target));
    if (ty && tg) out.push([ty[1], tg[1]]);
  }
  return out;
}

const idKey = (id) => { const [p, n] = id.split("-"); return [p, Number(n)]; };
const byIdNumeric = (a, b) => {
  const [pa, na] = idKey(a), [pb, nb] = idKey(b);
  return pa < pb ? -1 : pa > pb ? 1 : na - nb;
};
// Python's default string ordering is by code point; so is `<` on JS strings for BMP text.
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function implementers(req, tickets) {
  const rid = s(req.frontmatter.id);
  return tickets.filter((t) => linksOf(t).some(([ty, tg]) => ty === "Implements" && tg === rid))
    .map((t) => s(t.frontmatter.id)).sort(byIdNumeric);
}

function addresses(req, tickets) {
  const rid = s(req.frontmatter.id);
  const refs = tickets.filter((t) => s(t.frontmatter.type) === "architecture"
      && linksOf(t).some(([ty, tg]) => ty === "Addresses" && tg === rid))
    .map((t) => get(t.frontmatter, "ref", "")).sort(byStr);
  const linked = refs.filter(Boolean).join(", ");
  const external = [...new Set([...s(req.body).matchAll(/\bengine (ADR-\d+)/g)].map((m) => m[1]))].sort(byStr);
  if (linked || external.length) {
    const parts = linked ? [linked] : [];
    if (external.length) parts.push("engine " + external.join(", "));
    return parts.join("; ");
  }
  const m = /\*\*Addresses:\*\*\s*(.+)/.exec(s(req.body));
  return m ? m[1].trim() : "";
}

/** `list.sort(key=…)` by `ref`, ties broken by the ticket's PATH. The script's ties fall in
 *  `glob.glob` order, which is the filesystem's directory order — arbitrary, and different on
 *  two machines. Path order is what a sorted glob gives, so it is the one deterministic order
 *  the script's output can be checked against (`sorted(glob.glob(…))`, a no-op on its rules). */
const sortedBy = (arr, key, pathOf) => arr.map((v) => [key(v), pathOf(v), v])
  .sort((a, b) => byStr(a[0], b[0]) || byStr(a[1], b[1])).map((x) => x[2]);

export function requirementsMatrix(tickets, project, pathOf) {
  const reqs = sortedBy(tickets.filter((t) => s(t.frontmatter.type) === "requirement"),
    (t) => get(t.frontmatter, "ref", ""), pathOf);
  const goals = new Map(tickets.filter((t) => s(t.frontmatter.type) === "goal")
    .map((t) => [s(t.frontmatter.id), s(t.frontmatter.title)]));
  const met = reqs.filter((r) => r.status === "implemented");
  const future = reqs.filter((r) => r.status !== "implemented");
  const untraced = met.filter((r) => implementers(r, tickets).length === 0);
  const L = [];
  L.push(`# ${project} requirements traceability matrix`, "");
  L.push("> **Derived view — do not edit.** Regenerate with "
    + "`python3 scripts/build_matrices.py`. The tickets are the source of "
    + "truth (ADR-0015). A hand-edit here will be overwritten and, worse, "
    + "believed in the meantime.", "");
  L.push(`- **${reqs.length}** requirements — ${met.length} implemented, ${future.length} proposed`);
  L.push(`- **${reqs.reduce((n, r) => n + implementers(r, tickets).length, 0)}** traced delivery tickets`);
  L.push(`- **${untraced.length}** implemented requirements with no delivery ticket recorded`, "");
  for (const [gid, gtitle] of [...goals].sort((a, b) => byStr(a[0], b[0]))) {
    const rows = reqs.filter((r) => get(r.frontmatter, "parent", null) === gid);
    if (!rows.length) continue;
    L.push(`## ${gid} — ${gtitle}`, "");
    L.push("| Ref | Requirement | Cat | Verify | Status | Implemented by | Addresses |");
    L.push("|---|---|---|---|---|---|---|");
    for (const r of rows) {
      const fm = r.frontmatter;
      const impl = implementers(r, tickets).join(", ") || "—";
      L.push(`| \`${get(fm, "ref", "?")}\` | [${get(fm, "title", "")}](../../${pathOf(r)}) | `
        + `${get(fm, "category", "").slice(0, 4)} | ${get(fm, "verification", "").slice(0, 5)} | `
        + `${r.status} | ${impl} | ${addresses(r, tickets) || "—"} |`);
    }
    L.push("");
  }
  return L.join("\n") + "\n";
}

export function architectureMatrix(tickets, project, pathOf) {
  const adrs = sortedBy(tickets.filter((t) => s(t.frontmatter.type) === "architecture"),
    (t) => get(t.frontmatter, "ref", ""), pathOf);
  const reqs = new Map(tickets.filter((t) => s(t.frontmatter.type) === "requirement")
    .map((t) => [s(t.frontmatter.id), t]));
  const L = [];
  L.push(`# ${project} architecture decision matrix`, "");
  L.push("> **Derived view — do not edit.** Regenerate with "
    + "`python3 scripts/build_matrices.py`.", "");
  L.push(`- **${adrs.length}** decisions`);
  const byStatus = new Map();
  for (const a of adrs) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
  L.push("- by status: " + [...byStatus].sort((a, b) => byStr(a[0], b[0]))
    .map(([k, v]) => `**${v}** ${k}`).join(", "));
  const parentOf = (a) => get(a.frontmatter, "parent", null);
  const untraced = adrs.filter((a) => !reqs.has(parentOf(a)));
  L.push(`- **${untraced.length}** answering no stated requirement `
    + "(parented to a goal — legal, and counted rather than hidden)", "");
  L.push("| Ref | Decision | Status | Answers | Ticket |");
  L.push("|---|---|---|---|---|");
  for (const a of adrs) {
    const par = reqs.get(parentOf(a));
    // Python formats a missing value as `None` — reproduced, not corrected.
    const answers = par
      ? `\`${get(par.frontmatter, "ref", "None")}\` ${get(par.frontmatter, "title", "None")}`
      : `— *(untraced; under ${parentOf(a) ?? "None"})*`;
    L.push(`| \`${get(a.frontmatter, "ref", "?")}\` | [${get(a.frontmatter, "title", "")}](../../${pathOf(a)}) | `
      + `${a.status} | ${answers} | ${get(a.frontmatter, "id", "None")} |`);
  }
  L.push("");
  L.push("Reference a decision by its **designator** (`ADR-0011`), never by path — "
    + "an architecture ticket's path changes with its status (ADR-0017).");
  return L.join("\n") + "\n";
}

/** Both files for one project, keyed by the script's own file names. */
export function matrixFiles(tickets, project, pathOf) {
  const mine = tickets.filter((t) => t.project === project);
  return {
    [`${project.toLowerCase()}-requirements-matrix.md`]: requirementsMatrix(mine, project, pathOf),
    [`${project.toLowerCase()}-architecture-matrix.md`]: architectureMatrix(mine, project, pathOf),
  };
}
```

In `scripts/model/schema-version.mjs`, replace:

```js
  //   tests/schema-version-fixture-census.test.mjs, which fails if this sentence and the
  //   files disagree: 5 fixture boards, of which 1 sets a removed key
  //   (`board-gate-removed-key`, `provider: "github"` — a string) and 0 set one to null.
```

with:

```js
  //   tests/schema-version-fixture-census.test.mjs, which fails if this sentence and the
  //   files disagree: 6 fixture boards, of which 1 sets a removed key
  //   (`board-gate-removed-key`, `provider: "github"` — a string) and 0 set one to null.
```


- [ ] **Step 4: Run them to verify they pass**, then the neighbours this task touches.

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/matrices.test.mjs tests/model/seam-closure.test.mjs tests/schema-version-fixture-census.test.mjs
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/cli.test.mjs tests/readonly.test.mjs tests/tmp-scratch-attribution.test.mjs tests/temp-cleanup-guard.test.mjs
```

Expected: 9/9 pass in `tests/matrices.test.mjs`; `seam-closure` 21/21; census green; `cli.test.mjs` green (the "21 of the 24 subcommands" comment).

- [ ] **Step 5: Docs, in the same commit.**

In `AGENTS.md`, replace:

```markdown
(`new`/`move`/`edit`/`link`/`resolve`/`log`/`commit`/`reindex`/`sprint`/
`reconcile`/`groom`/`start`) at dispatch — it exits non-zero naming the
command and the env var, and never spawns the runner, so nothing is written.
```

with:

```markdown
(`new`/`move`/`edit`/`link`/`resolve`/`log`/`commit`/`reindex`/`sprint`/
`reconcile`/`groom`/`start`, and `matrices` unless `--check`) at dispatch — it exits non-zero naming the
command and the env var, and never spawns the runner, so nothing is written.
```

In `docs/guide/commands.md`, replace (1/2):

```markdown
| [`rollup`](#rollup) | Print rolled-up time for a node or every goal/epic | no |
| [`migrate`](#migrate) | Import tickets from an external tracker | with `--live` |
```

with:

```markdown
| [`rollup`](#rollup) | Print rolled-up time for a node or every goal/epic | no |
| [`matrices`](#matrices) | Regenerate the requirements and architecture matrices | yes; no with `--check` |
| [`migrate`](#migrate) | Import tickets from an external tracker | with `--live` |
```

In `docs/guide/commands.md`, replace (2/2):

```markdown

## migrate
```

with:

````markdown

## matrices

```
blaze matrices [--project <KEY>] [--check] [--out <dir>]
```

Regenerates the two **derived** traceability views per project — `<key>-requirements-matrix.md`
(each requirement, the delivery tickets that `Implements` it, the decisions that `Addresses` it)
and `<key>-architecture-matrix.md` (each decision and the requirement it answers) — from the
tickets, through the resolved store, so it works under `fs`, `dual` and `db`. It replaces
blaze-pm's `scripts/build_matrices.py` (BLZ-682) and writes the same bytes: the acceptance test
was a zero `diff -r` against that script's output for the live board.

| Flag | Meaning | Default |
|---|---|---|
| `--project <KEY>` | One project only. | every project in `blaze.config.json` |
| `--check` | Write nothing; exit `1` naming each file that differs from the tickets. Allowed under `BLAZE_READONLY`. | off |
| `--out <dir>` | Where the files live. | `<data root>/docs/matrices` |

Exit `2` when there are no projects to render — a run that rendered nothing never reports
"in sync". Two rows that share a `ref` (or have none) are ordered by the ticket's path, which is
what the script produced when its `glob` happened to return paths sorted; on a filesystem that
returned them in another order the script's ties came out differently, so the first
`blaze matrices` run on such a board may reorder those rows once. Under `db` a ticket has no
file, so its link is the path the file would have today (`<KEY>/<status>/<id>-<slug>.md`).

## migrate
````


- [ ] **Step 6: Fence check, commit, prove the committed tree.**

```bash
git add tests/fixtures/matrices-board/blaze.config.json tests/fixtures/matrices-board/docs/matrices/eng-architecture-matrix.md tests/fixtures/matrices-board/docs/matrices/eng-requirements-matrix.md tests/fixtures/matrices-board/projects/ENG/accepted/ENG-6-files-are-the-store.md tests/fixtures/matrices-board/projects/ENG/accepted/ENG-8-another-without-a-ref.md tests/fixtures/matrices-board/projects/ENG/achieved/ENG-1-ship-the-board.md tests/fixtures/matrices-board/projects/ENG/defined/ENG-2-keep-it-honest.md tests/fixtures/matrices-board/projects/ENG/done/ENG-10-build-the-renderer.md tests/fixtures/matrices-board/projects/ENG/implemented/ENG-3-render-the-board.md tests/fixtures/matrices-board/projects/ENG/implemented/ENG-5-no-trace-yet.md tests/fixtures/matrices-board/projects/ENG/in-progress/ENG-9-renderer-feature.md tests/fixtures/matrices-board/projects/ENG/proposed/ENG-4-reads-are-fast.md tests/fixtures/matrices-board/projects/ENG/proposed/ENG-7-no-ref-yet.md tests/matrices.test.mjs tests/model/seam-closure.test.mjs scripts/cli.mjs scripts/matrices-runner.mjs scripts/model/matrices.mjs scripts/model/schema-version.mjs AGENTS.md docs/guide/commands.md
git diff --cached | grep -c '^+```'      # must print 2   (the `## matrices` usage block in docs/guide/commands.md — nothing else)
git commit -m "BLZ-682: blaze matrices replaces build_matrices.py" -m "New scripts/model/matrices.mjs (pure renderer, byte-compatible with the script) and scripts/matrices-runner.mjs (resolveReadStorage, --check/--out/--project, readonly guard); cli.mjs entry (readOnlyFlags --check); seam-closure WRITE_ALLOWED entry and pin; schema-version.mjs census comment 5 -> 6 fixture boards. New tests/matrices.test.mjs and tests/fixtures/matrices-board/; commands.md, AGENTS.md." -- tests/fixtures/matrices-board/blaze.config.json tests/fixtures/matrices-board/docs/matrices/eng-architecture-matrix.md tests/fixtures/matrices-board/docs/matrices/eng-requirements-matrix.md tests/fixtures/matrices-board/projects/ENG/accepted/ENG-6-files-are-the-store.md tests/fixtures/matrices-board/projects/ENG/accepted/ENG-8-another-without-a-ref.md tests/fixtures/matrices-board/projects/ENG/achieved/ENG-1-ship-the-board.md tests/fixtures/matrices-board/projects/ENG/defined/ENG-2-keep-it-honest.md tests/fixtures/matrices-board/projects/ENG/done/ENG-10-build-the-renderer.md tests/fixtures/matrices-board/projects/ENG/implemented/ENG-3-render-the-board.md tests/fixtures/matrices-board/projects/ENG/implemented/ENG-5-no-trace-yet.md tests/fixtures/matrices-board/projects/ENG/in-progress/ENG-9-renderer-feature.md tests/fixtures/matrices-board/projects/ENG/proposed/ENG-4-reads-are-fast.md tests/fixtures/matrices-board/projects/ENG/proposed/ENG-7-no-ref-yet.md tests/matrices.test.mjs tests/model/seam-closure.test.mjs scripts/cli.mjs scripts/matrices-runner.mjs scripts/model/matrices.mjs scripts/model/schema-version.mjs AGENTS.md docs/guide/commands.md
git status --short                        # must print nothing
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/matrices.test.mjs tests/model/seam-closure.test.mjs tests/schema-version-fixture-census.test.mjs   # green on the COMMITTED tree
```


---

### Task 8: §5.8 residuals — readonly guards on four runners; a create never overwrites (BLZ-683)

**Files:**
- Create: `tests/readonly-runners.test.mjs`
- Create: `tests/reserve-window.test.mjs`
- Modify: `scripts/init-runner.mjs`
- Modify: `scripts/migrate-runner.mjs`
- Modify: `scripts/model/import-apply.mjs`
- Modify: `scripts/model/write-port.mjs`
- Modify: `scripts/new.mjs`
- Modify: `scripts/schedule-runner.mjs`
- Modify: `scripts/user-runner.mjs`
- Modify: `docs/decisions/0019-the-groomers-guard-is-advisory.md`
- Modify: `docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md`

**Interfaces:**
- Consumes: `assertWritable(what, env)` (`scripts/readonly.mjs`).
- Produces: `dbWritePort(...).write(t, { create: true })` — refuses an existing row (`write: <id> already exists in the database … NOT written …`) and inserts without `ON CONFLICT`; `applyNew` and `applyImport`'s create rows pass `{ create: true }`. Runner refusal text: `blaze: read-only mode (BLAZE_READONLY=1) — refusing to run blaze user add|user passwd|init|migrate|schedule migrate-dates --write`.

- [ ] **Step 1: Write the failing tests.**

Create `tests/readonly-runners.test.mjs`:

```js
// tests/readonly-runners.test.mjs — BLZ-683 (spec §5.8). Four runners had no per-runner
// BLAZE_READONLY guard (ADR-0019's addendum named them): user, init, migrate and schedule. A
// direct `node scripts/<x>-runner.mjs` bypassed cli.mjs's dispatch gate and wrote. Each test runs
// the runner DIRECTLY under BLAZE_READONLY=1 and proves the refusal names the mode and that
// nothing was written — the positive invariant, not just a non-zero exit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../scripts/init-runner.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const TICKET = "---\nid: ENG-1\ntitle: One\ntype: task\nproject: ENG\nestimate: 30\ndue: 2026-12-01\n---\n\nbody\n";

function board() {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz683-readonly-")));
  mkdirSync(join(dataRoot, "projects", "ENG", "defined"), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"), JSON.stringify({ projects: ["ENG"] }));
  writeFileSync(join(dataRoot, "projects", "ENG", "defined", "ENG-1-one.md"), TICKET);
  return dataRoot;
}
function direct(dataRoot, script, args, extra = {}) {
  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(dataRoot, "projects"), BLAZE_READONLY: "1", ...extra };
  delete env.BLAZE_WRITE_PORT;
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args],
    { cwd: dataRoot, encoding: "utf8", input: "a-password-long-enough\n", env });
}
const refused = (r, what) => {
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`blaze: read-only mode \\(BLAZE_READONLY=1\\) — refusing to ${what}`));
};

test("user-runner add and passwd refuse, and no identity store is created", () => {
  const root = board();
  refused(direct(root, "user-runner.mjs", ["add", "--email", "a@example.com"]), "run blaze user add");
  refused(direct(root, "user-runner.mjs", ["passwd", "--email", "a@example.com"]), "run blaze user passwd");
  assert.equal(existsSync(join(root, ".blaze", "identity.db")), false);
  assert.equal(existsSync(join(root, ".gitignore")), false, "not even the .gitignore line");
});

test("user-runner still names a usage error first", () => {
  const r = direct(board(), "user-runner.mjs", ["add"]);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /read-only mode/);
});

test("init-runner refuses before writing a board; --help still answers", async () => {
  const dir = scratch(mkdtempSync(join(tmpdir(), "blz683-init-")));
  const out = [];
  const io = { log: (s) => out.push(String(s)), err: (s) => out.push(String(s)), isTTY: false,
               env: { BLAZE_READONLY: "1" } };
  assert.equal(await runInit(["--yes", `--dir=${dir}`, "--project=ENG", "--no-git"], io), 1);
  assert.match(out.join("\n"), /read-only mode \(BLAZE_READONLY=1\) — refusing to run blaze init/);
  assert.equal(existsSync(join(dir, "blaze.config.json")), false);
  assert.equal(existsSync(join(dir, "projects")), false);
  assert.equal(await runInit(["--help"], io), 0);
});

test("migrate-runner refuses both modes before writing migration/ or a ticket", () => {
  const root = board();
  refused(direct(root, "migrate-runner.mjs", ["--dry-run"]), "run blaze migrate");
  refused(direct(root, "migrate-runner.mjs", ["--live"]), "run blaze migrate");
  assert.equal(existsSync(join(root, "migration")), false);
});

test("schedule-runner refuses --write and leaves the ticket as it was; the dry run still runs", () => {
  const root = board();
  const file = join(root, "projects", "ENG", "defined", "ENG-1-one.md");
  refused(direct(root, "schedule-runner.mjs", ["migrate-dates", "--write"]), "run blaze schedule migrate-dates --write");
  assert.equal(readFileSync(file, "utf8"), TICKET);
  const dry = direct(root, "schedule-runner.mjs", ["migrate-dates"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(readFileSync(file, "utf8"), TICKET);
});
```

Create `tests/reserve-window.test.mjs`:

```js
// tests/reserve-window.test.mjs — BLZ-683 (spec §5.8). The db `reserve` check-then-upsert window
// is ACCEPTED (import is single-operator and refused in remote mode), on one condition the spec
// states: the losing writer fails LOUDLY and never overwrites. Before this, a ticket created by
// another writer after `reserve` (or after `new`'s `exists`) was silently upserted over by the
// create that followed. These tests put a second writer in exactly that window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDb } from "../scripts/db-runner.mjs";
import { resolvePorts, pgExec } from "../scripts/model/write-port-resolve.mjs";
import { dbWritePort } from "../scripts/model/write-port.mjs";
import { createDbSchema } from "../scripts/model/db-schema-version.mjs";
import { applyNew } from "../scripts/new.mjs";
import { runImport } from "../scripts/model/import-apply.mjs";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { writeCsv } from "../scripts/model/csv.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";

const theirs = (id) => ({ project: "ENG", status: "defined", body: "theirs",
  frontmatter: { id, title: "written by the other writer", type: "task", project: "ENG",
                 estimate: 30, created: "2026-10-05", updated: "2026-10-05" } });

test("import: a ticket created AFTER reserve, before the write — exit 4, the other writer's ticket survives",
     async () => {
  const roots = dbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    // reserve finds ENG-50 free and raises the counter; THEN the other writer lands.
    const racing = { ...ports.writePort, async reserve(id, opts) {
      const r = await ports.writePort.reserve(id, opts);
      await ports.writePort.write(theirs(id));
      return r;
    } };
    const csv = join(roots.dataRoot, "race.csv");
    const base = { schema_version: "1", project: "ENG", type: "task", status: "defined",
                   description: "body", estimate: "30", id: "ENG-50", title: "from the csv" };
    writeFileSync(csv, writeCsv([COLUMN_NAMES.slice(), COLUMN_NAMES.map((n) => base[n] ?? "")]));
    const r = await runImport({ projectsDir: roots.projectsDir, dataRoot: roots.dataRoot, apply: true,
      writePort: racing, readStorage: ports.readStorage, stage: () => ({ ok: true, queued: true }), file: csv });
    assert.equal(r.exitCode, 4, r.report);
    assert.match(r.report, /ENG-50 already exists in the database/);
    assert.match(r.report, /NOT written/);
    const back = (await ports.readStorage.getTicket(roots.projectsDir, "ENG-50")).found;
    assert.equal(back.frontmatter.title, "written by the other writer", "never overwritten");
  } finally { await ports.close(); }
});

test("new: a ticket created after the exists-check, before the write — refused, never overwritten",
     async () => {
  const roots = dbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    const racing = { ...ports.writePort, async exists(t) {
      const there = await ports.writePort.exists(t);
      await ports.writePort.write(theirs(t.frontmatter.id));
      return there;
    } };
    await assert.rejects(applyNew(roots.projectsDir, {
      project: "ENG", type: "task", title: "mine", today: "2026-10-05", extra: { estimate: 15 },
      writePort: racing, readStorage: ports.readStorage,
    }), /ENG-2 already exists in the database.*NOT written/);
    const back = (await ports.readStorage.getTicket(roots.projectsDir, "ENG-2")).found;
    assert.equal(back.frontmatter.title, "written by the other writer");
  } finally { await ports.close(); }
});

test("an edit or a move is still an upsert — only a create refuses an existing row", async () => {
  const roots = dbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    await ports.writePort.write(theirs("ENG-7"), { create: true });
    await ports.writePort.write({ ...theirs("ENG-7"), status: "in-progress" });
    assert.equal((await ports.readStorage.getTicket(roots.projectsDir, "ENG-7")).found.status, "in-progress");
  } finally { await ports.close(); }
});

test("Postgres, two connections: the loser's INSERT meets the primary key inside its own transaction",
     PG_SKIP, async () => {
  const db = await scratchPgDb("window");
  const a = await pgClient(db.url), b = await pgClient(db.url);
  try {
    await createDbSchema(pgExec(a), { dialect: "postgres" });
    // B pauses right after reading "no such row", exactly where a concurrent create can land.
    let release, paused;
    const gate = new Promise((r) => { release = r; });
    const reached = new Promise((r) => { paused = r; });
    const base = pgExec(b);
    const execB = { run: base.run, async all(sql, params) {
      const rows = await base.all(sql, params);
      if (/SELECT status FROM ticket WHERE id/.test(sql)) { paused(); await gate; }
      return rows;
    } };
    const loser = dbWritePort(execB, { dialect: "postgres" }).write({ ...theirs("ENG-9"),
      frontmatter: { ...theirs("ENG-9").frontmatter, title: "the loser" } }, { create: true });
    await reached;
    await dbWritePort(pgExec(a), { dialect: "postgres" }).write(theirs("ENG-9"), { create: true });
    release();
    await assert.rejects(loser, /duplicate key value violates unique constraint "ticket_pkey"/);
    const rows = (await a.query("SELECT title FROM ticket WHERE id = 'ENG-9'")).rows;
    assert.deepEqual(rows, [{ title: "written by the other writer" }]);
    const events = Number((await a.query("SELECT count(*) AS n FROM ticket_event WHERE ticket_id = 'ENG-9'")).rows[0].n);
    assert.equal(events, 1, "the loser's transaction — its event included — rolled back");
  } finally { await a.end(); await b.end(); await db.drop(); }
});
```


- [ ] **Step 2: Run them to verify they fail.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/readonly-runners.test.mjs tests/reserve-window.test.mjs
```

Expected: 4 failures in `readonly-runners` (user/init/migrate/schedule each wrote or ran) and 3 in `reserve-window` (`import: …` exit 0 with the CSV title over the other writer's, `new: …` no rejection, `Postgres, two connections: …` no rejection — the loser upserted). `an edit or a move is still an upsert` passes before and after (it guards the change from over-reaching).

- [ ] **Step 3: Implement.**

In `scripts/init-runner.mjs`, replace (1/2):

```js
import { addUser } from "./model/user-admin.mjs";

```

with:

```js
import { addUser } from "./model/user-admin.mjs";
import { assertWritable } from "./readonly.mjs";

```

In `scripts/init-runner.mjs`, replace (2/2):

```js
    return 1;
  }

  const interactive = Boolean(isTTY) && !args.yes;
```

with:

```js
    return 1;
  }
  // BLZ-683: the per-runner BLAZE_READONLY guard, before a prompt is shown, a connection is
  // tested or a file is written — `--help` and an unknown option are still answered first.
  try { assertWritable("run blaze init", env); }
  catch (e) { err(e.message); return 1; }

  const interactive = Boolean(isTTY) && !args.yes;
```

In `scripts/migrate-runner.mjs`, replace (1/2):

```js
import { resolveRoots, loadConfig, InvalidProjectKeyError } from "./config.mjs";

```

with:

```js
import { resolveRoots, loadConfig, InvalidProjectKeyError } from "./config.mjs";
import { assertWritable } from "./readonly.mjs";

```

In `scripts/migrate-runner.mjs`, replace (2/2):

```js

if (mode === "dry-run") {
```

with:

```js

// BLZ-683: the per-runner BLAZE_READONLY guard. BOTH modes write — the dry run writes
// migration/MIGRATION-AUDIT.md and the ledger, `--live` writes tickets and commits — so it sits
// before either, after the arguments and the project keys are judged.
try { assertWritable("run blaze migrate"); }
catch (e) { console.error(e.message); process.exit(1); }

if (mode === "dry-run") {
```

In `scripts/model/import-apply.mjs`, replace:

```js
      // `updated` stamps per imported row (ADR-0037 §1).
      const { file } = await writePort.write({ ...ticket, frontmatter });
      files.push(file);
```

with:

```js
      // `updated` stamps per imported row (ADR-0037 §1).
      // BLZ-683: `create` — if another writer took this id after `reserve`, this write fails
      // loudly (exit 4, the row is named) rather than upserting over that writer's ticket.
      const { file } = await writePort.write({ ...ticket, frontmatter }, { create: true });
      files.push(file);
```

In `scripts/model/write-port.mjs`, replace (1/2):

```js
    const prior = priorRows?.length ? priorRows[0].status : null;

```

with:

```js
    const prior = priorRows?.length ? priorRows[0].status : null;
    // BLZ-683 (spec §5.8): a CREATE never writes over a row. `ctx.create` comes from the two
    // verbs that mint a ticket — `applyNew` and import's create rows — and each checked the id
    // was free (`exists`, `reserve`) a moment BEFORE this write. That check-then-write window
    // is accepted, not locked (ADR-0038's addendum); what closes the damage is that the LOSING
    // writer fails loudly here, or on the ticket's primary key below if the winner's row
    // commits between this read and that insert, and never upserts over the winner's ticket.
    if (ctx?.create && prior !== null) {
      throw new Error(`write: ${id} already exists in the database — another writer created it `
        + "first, so this create was NOT written (nothing is overwritten).");
    }

```

In `scripts/model/write-port.mjs`, replace (2/2):

```js
    const set = cols.slice(1).map((c) => `${c} = excluded.${c}`).join(", ");
    await exec.run(
      `INSERT INTO ticket (${cols.join(", ")}) VALUES (${cols.map((_, i) => ph(i)).join(", ")})
       ON CONFLICT (id) DO UPDATE SET ${set}`, vals);

```

with:

```js
    const set = cols.slice(1).map((c) => `${c} = excluded.${c}`).join(", ");
    // A create is a plain INSERT, so a row that appeared after the read above is refused by
    // the primary key (BLZ-683); an edit or a move stays the upsert it has always been.
    await exec.run(
      `INSERT INTO ticket (${cols.join(", ")}) VALUES (${cols.map((_, i) => ph(i)).join(", ")})`
      + (ctx?.create ? "" : `\n       ON CONFLICT (id) DO UPDATE SET ${set}`), vals);

```

In `scripts/new.mjs`, replace:

```js
  }
  const { file } = await writePort.write(target);
  const warnings = warnMissingRequired(frontmatter, project_cfg, { reason: extra.reason ?? null });
```

with:

```js
  }
  // BLZ-683: `create` — a row that appears between the check above and this write is refused,
  // never overwritten (the db port's rule; the fs port ignores the context).
  const { file } = await writePort.write(target, { create: true });
  const warnings = warnMissingRequired(frontmatter, project_cfg, { reason: extra.reason ?? null });
```

In `scripts/schedule-runner.mjs`, replace (1/2):

```js
import { resolveReadStorage } from "./model/write-port-resolve.mjs";

```

with:

```js
import { resolveReadStorage } from "./model/write-port-resolve.mjs";
import { assertWritable } from "./readonly.mjs";

```

In `scripts/schedule-runner.mjs`, replace (2/2):

```js
    + "The tool reports; you decide.");
  process.exit(1);
}

```

with:

```js
    + "The tool reports; you decide.");
  process.exit(1);
}

// BLZ-683: the per-runner BLAZE_READONLY guard. Only `--write` writes; the dry run stays
// available under BLAZE_READONLY, because a plan is a read.
if (write) {
  try { assertWritable("run blaze schedule migrate-dates --write"); }
  catch (e) { console.error(e.message); process.exit(1); }
}

```

In `scripts/user-runner.mjs`, replace (1/2):

```js
import { identityDbPath } from "./model/identity-db.mjs";

```

with:

```js
import { identityDbPath } from "./model/identity-db.mjs";
import { assertWritable } from "./readonly.mjs";

```

In `scripts/user-runner.mjs`, replace (2/2):

```js
const { dataRoot } = resolveRoots();

```

with:

```js
const { dataRoot } = resolveRoots();

// BLZ-683: the per-runner BLAZE_READONLY guard (AGENTS.md "Read-only mode"), for a direct
// `node scripts/user-runner.mjs` that bypasses cli.mjs's dispatch gate. After the arguments
// are judged (a usage error is still named first) and before a password is read or a user,
// token or .gitignore line is written.
try { assertWritable(`run blaze user ${parsed.verb}`); }
catch (e) { console.error(e.message); process.exit(1); }

```


- [ ] **Step 4: Run them to verify they pass**, then the neighbours this task touches.

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/readonly-runners.test.mjs tests/reserve-window.test.mjs
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/readonly.test.mjs tests/init.test.mjs tests/init-first-admin.test.mjs tests/user-add.test.mjs tests/user-passwd.test.mjs tests/schedule-runner.test.mjs tests/import-db-mode.test.mjs tests/import-runner.test.mjs tests/model/write-port.test.mjs tests/model/import-apply.test.mjs tests/new.test.mjs tests/new-runner.test.mjs tests/verbs-dual-write.test.mjs tests/model/seam-closure.test.mjs
```

Expected: 5/5 and 4/4 pass (1 skips without Postgres); every neighbour green.

- [ ] **Step 5: Docs, in the same commit.**

In `docs/decisions/0019-the-groomers-guard-is-advisory.md`, replace:

```markdown
  BLZ-254 owns the concurrency proofs.
```

with:

```markdown
  BLZ-254 owns the concurrency proofs.

## Addendum (2026-10-05, BLZ-683) — every mutating runner now carries the guard

The residual above — "Runners with no per-runner readonly guard" — is closed for the four it
named. `user-runner.mjs`, `init-runner.mjs`, `migrate-runner.mjs` and `schedule-runner.mjs` each
call `assertWritable` before their first write, matching the other runners: after their
arguments are judged (a usage error is still named first), before a prompt, a connection test or
any file. `migrate` is refused in both modes, because its dry run writes `migration/` too;
`schedule` only under `--write`, because its dry run is a read. `tests/readonly-runners.test.mjs`
runs each one directly under `BLAZE_READONLY=1` and proves nothing was written. This ADR's
decision is unchanged: the guard is advisory, not a boundary.
```

In `docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md`, replace:

```markdown
  BLZ-254 either way.
```

with:

```markdown
  BLZ-254 either way.
- **The groomer's check-then-write window, and Postgres identity values committing out of order
  — accepted.** The groomer loop is off in the cluster (`loops.*` disabled), and a ticket id comes
  from `project_counter`'s row lock, never from identity order.
- **db `reserve`'s check-then-upsert window — accepted, and the loser now fails (BLZ-683).**
  `reserve` runs only inside `import`, which is single-operator and refused in remote mode. A
  create (`applyNew`, import's create rows) now writes with `{ create: true }`, so a ticket another
  writer created after the check is refused — `already exists … NOT written`, or the ticket's
  primary key if it commits mid-write — and never upserted over. An edit or move is unchanged.
  `tests/reserve-window.test.mjs` puts a second writer in the window, on SQLite and on Postgres
  over two connections.
- **A db groom has no undo — accepted.** Recovery is the `ticket_event` history plus the
  database's backup and point-in-time restore.
```


- [ ] **Step 6: Fence check, commit, prove the committed tree.**

```bash
git add tests/readonly-runners.test.mjs tests/reserve-window.test.mjs scripts/init-runner.mjs scripts/migrate-runner.mjs scripts/model/import-apply.mjs scripts/model/write-port.mjs scripts/new.mjs scripts/schedule-runner.mjs scripts/user-runner.mjs docs/decisions/0019-the-groomers-guard-is-advisory.md docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md
git diff --cached | grep -c '^+```'      # must print 0
git commit -m "BLZ-683: BLAZE_READONLY guards on four runners; a db create never overwrites" -m "user-, init-, migrate- and schedule-runner call assertWritable before their first write; dbWritePort honours { create: true } (refuse a visible row, plain INSERT) and applyNew and import create rows pass it. New tests/readonly-runners.test.mjs and tests/reserve-window.test.mjs; ADR-0019 addendum and ADR-0038 addendum bullets." -- tests/readonly-runners.test.mjs tests/reserve-window.test.mjs scripts/init-runner.mjs scripts/migrate-runner.mjs scripts/model/import-apply.mjs scripts/model/write-port.mjs scripts/new.mjs scripts/schedule-runner.mjs scripts/user-runner.mjs docs/decisions/0019-the-groomers-guard-is-advisory.md docs/decisions/0038-reads-resolve-from-the-write-mode-at-the-entry-point.md
git status --short                        # must print nothing
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test   # the Global Constraints container
node --test --test-concurrency=1 --import=./tests/setup/hang-watchdog.mjs tests/readonly-runners.test.mjs tests/reserve-window.test.mjs   # green on the COMMITTED tree
```


---

### Task 9: Verification before the PR (no commit)

- [ ] **Step 1: Kickoff §9, on the branch.**

```bash
cd /home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-254-live-board-cutover
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
git fetch origin
npm test 2>&1 | tail -12                                   # fail 0
node scripts/ci/hygiene-check.mjs origin/main              # hygiene: clean
git log origin/main..HEAD --format=%B | grep -ci 'co-authored-by\|signed-off-by'   # 0
git log origin/main..HEAD --format=%s | grep -vc '^BLZ-'  # 0
git status --short                                         # empty
[ "$(git merge-base HEAD origin/main)" = "$(git rev-parse origin/main)" ] && echo base-ok
```

- [ ] **Step 2: The local Postgres run, with coverage.**

```bash
docker run -d --rm --name blz-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=blaze_test -p 127.0.0.1:55432:5432 postgres:17-alpine
until docker exec blz-pg pg_isready -U postgres -d blaze_test; do sleep 1; done
BOX=$(mktemp -d /tmp/blz254-box-XXXX)
TMPDIR=$BOX BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:55432/blaze_test npm run test:coverage > "$BOX.log" 2>&1; tail -12 "$BOX.log"
grep -c "already executing" "$BOX.log"                    # 0 — BLZ-675's AC over the whole run
node scripts/ci/tmp-scratch-attribution.mjs --tmp "$BOX" --max 0
docker stop blz-pg
```

Expected: `fail 0`, the c8 thresholds pass (91/77/93/91), no deprecation line, no attributable scratch directory left. (`npm run test:coverage` already passes `--test-concurrency=1`.)

- [ ] **Step 3: `gh pr checks <PR>` after opening the PR** — every row pass; re-read it before merging (`--watch` can exit 0 on a failure). PR title: `BLZ-674 + BLZ-675 + BLZ-678 + BLZ-679 + BLZ-680 + BLZ-681 + BLZ-682 + BLZ-683: db readiness for the live-board cutover`, with one `* BLZ-n: …` bullet per child in the body (BLZ-131's squash-body reconcile reads them).

## Operator acceptance (read-only against blaze-pm; never writes into it)

Both steps work on a COPY. Nothing here writes to `blaze-pm` or its worktrees.

**A. The matrices generator-oracle (spec §5.6, Finding 15).**

```bash
cd /home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-254-live-board-cutover
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
SRC=/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine
COPY=$(mktemp -d /tmp/blz682-oracle-XXXX)
cp -r "$SRC/projects" "$SRC/blaze.config.json" "$COPY/" && mkdir -p "$COPY/scripts" "$COPY/docs"
cp "$SRC/scripts/build_matrices.py" "$COPY/scripts/" && cp -r "$SRC/docs/matrices" "$COPY/docs/"
# the script's ties follow glob order, which is filesystem order; sort it (a no-op on its rules)
sed -i 's|for path in glob.glob(os.path.join(ROOT, "projects", project, "\*", "\*.md")):|for path in sorted(glob.glob(os.path.join(ROOT, "projects", project, "*", "*.md"))):|' "$COPY/scripts/build_matrices.py"
grep -c 'sorted(glob.glob' "$COPY/scripts/build_matrices.py"          # 1
for k in $(node -e 'console.log(require(process.argv[1]).projects.join(" "))' "$COPY/blaze.config.json"); do
  (cd "$COPY" && python3 scripts/build_matrices.py --project "$k" >/dev/null); done
BLAZE_PROJECTS_DIR="$COPY/projects" node scripts/cli.mjs matrices --out "$COPY/blaze-out"
diff -r "$COPY/docs/matrices" "$COPY/blaze-out" && echo ZERO-DIFF        # prototype: ZERO-DIFF, 22 files
diff -rq "$SRC/docs/matrices" "$COPY/blaze-out"   # vs COMMITTED: blz-requirements (BLZ-676), nca (BLZ-555), blz-architecture (tie order)
```

**B. Load + verify preview on a scratch database** (spec §7 step 3's rehearsal does this for real on CNPG):

```bash
docker run -d --rm --name blz-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=blaze_test -p 127.0.0.1:55432:5432 postgres:17-alpine
until docker exec blz-pg pg_isready -U postgres -d blaze_test; do sleep 1; done
docker exec blz-pg psql -U postgres -d blaze_test -c "CREATE DATABASE preview_v4"
node -e 'const f=process.argv[1],fs=require("fs"),c=JSON.parse(fs.readFileSync(f));c.database={driver:"postgres"};fs.writeFileSync(f,JSON.stringify(c,null,2))' "$COPY/blaze.config.json"
export BLAZE_PROJECTS_DIR="$COPY/projects" BLAZE_DB_HOST=127.0.0.1 BLAZE_DB_PORT=55432 BLAZE_DB_NAME=preview_v4 BLAZE_DB_USER=postgres BLAZE_DB_PASSWORD_ENV=PREVIEW_PW PREVIEW_PW=postgres
node scripts/cli.mjs db init && node scripts/cli.mjs db load && node scripts/cli.mjs db verify; echo "verify exit=$?"   # prototype: PASS, 0
node scripts/cli.mjs audit --fail-on duplicate-status; echo "exit=$?"       # 0; a plain `blaze audit` exits 1 on the 66 terminal parents (Finding 10)
docker stop blz-pg
```

(The copy has no `.git`, so its load imports 0 transitions; the real tree imports git's history — 914 on `BLZ-305-v4-spine` at `8bd7fd3d`.)

## Self-review

- **Spec coverage:** §5.2 → Task 3 (+ Findings 3–6); §5.3 → Task 4 (all four conditions, each pinned alone; exit 0/1/2); §5.6 → Tasks 6 and 7 (`duplicate_id_check.py` by `--fail-on`; `parent_rules.mjs` already deleted, nothing to do); §5.7 → Task 5 (transitions) and the ADR-0038 addendum (sprints, pool); §5.8 → Task 8 and the ADR-0038/0019 addenda; §8 row A's BLZ-674/675 → Tasks 2 and 1. `fs`/`dual` unchanged: the fs port ignores `{ create }`, `dbTransitions` answers only db, the SQLite shadow's rows are unchanged (Finding 6).
- **Placeholders:** none — every code step is the prototype's literal content.
- **Type consistency:** `loadCorpusAsync`'s `typeById` (Task 3) is what Task 5's `importTransitions` takes as `new Set(tally.typeById.keys())`; `corpusRows`/`relationRows` (Task 3) are what `expectedCounts` (Task 4) reuses; `governanceFindings`' `configProjects` is `nonEmpty(config?.projects)` (Finding 12).
- **Review Focus:** each of the five lines is pinned by a named test in its task.
