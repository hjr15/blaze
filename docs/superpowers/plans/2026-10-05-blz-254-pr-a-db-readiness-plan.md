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

> **WIP:** Tasks 5–8 and the verification task follow in the next commit.
