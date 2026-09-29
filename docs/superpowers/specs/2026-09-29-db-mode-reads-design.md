# Database-mode reads: every read comes from the source the writes go to

**BLZ-670.** Re-scoped at design time, 2026-09-29, with the operator's approval: the ticket names
five `buildIndex` call sites, and a full inventory of the read path showed they are a subset of
a larger defect. Under `BLAZE_WRITE_PORT=db` today, **every** production read comes from the
filesystem while every write goes to the database. This spec closes the whole read path, not
five sites of it.

## 1. Goal

When `BLAZE_WRITE_PORT=db`, every production read of the ticket corpus (verbs, CLI runners,
both HTTP servers) is answered by the database the writes go to, SQLite or Postgres per
`database.driver`. When the mode is `fs` or `dual`, behaviour is byte-for-byte what it is today.

Success is observable: with `BLAZE_WRITE_PORT=db`, `blaze new` → `blaze move <id> in-progress`
→ `blaze move <id> in-review` succeeds (the second move sees the first), and `blaze reindex`,
`blaze rollup`, `blaze audit`, `GET /`, `GET /api/panel` and `GET /api/live` all report the
database's state. Today the second move reads the ticket's stale status from its file.

## 2. Current state, verified against `5d3476c` (2026-09-29)

- **No production code constructs a non-filesystem reader.** `openSqliteRead` and
  `openPostgresRead` are reached only from tests and the migration tooling.
- **Verbs.** `applyMove`, `applyEdit`, `applyToggleAc`, `applyLog`, `applyResolve` and `applyLink`
  resolve their ticket with the synchronous `locateTicket` (`scripts/model/index.mjs:315`), which
  defaults to `fsReadStorage`. `applyMove` calls `readStorage.blockersOf` synchronously.
  `applyNew` and `applyEdit` iterate `readStorage.listTickets` synchronously. Every `apply*`
  function is already `async`.
- **Import.** `loadBoard` (`scripts/model/import-apply.mjs:309`) is synchronous and is called from
  three async functions: `runImport`, `runMappedImport` and `runRepair`.
- **Reconcile.** `reconcile` (async) spreads `readStorage.listTickets` synchronously
  (`scripts/reconcile.mjs:2008`) and calls `unreadableTicketDirs` (`:2046`). Its entry points are
  `blaze reconcile`, `supervisor.mjs`'s `runReconcile`, and `serve.mjs`'s
  `GET /api/reconcile-preview`. All three are async.
- **Fully synchronous scripts, with zero `await`:** `reindex.mjs` (`buildIndex`, `:67`),
  `rollup-runner.mjs` (`buildIndex`, `:60`), `audit-runner.mjs` (`fsReadStorage.listTickets`
  `:181`, `listProjects` `:120`, `unreadableTicketDirs` `:199`), `schedule-runner.mjs`
  (`fsReadStorage.listTickets`, `:67`) and `export-runner.mjs` (via `exportRows`,
  `scripts/model/export-rows.mjs:111`).
- **Views (all sync).** `boardModel` (`scripts/views/data.mjs:25`, `[...readStorage.listTickets()]`),
  `contentHash` (`:115`), `liveModel` (`:143` `activityFeed`, `:146` `buildIndex`), `graphModel`
  (`scripts/model/graph.mjs:139`), `panelHtml` (`scripts/views/panel-content.mjs:81`), and
  `pageHtml`/`viewEnvelope`/`renderView` (`scripts/views/page.mjs:82,85,143,189`), which call
  `boardModel` and `graphModel`.
- **Servers.** `serve.mjs`'s `handle` is `async`. It calls the sync view functions from
  `GET /` (`:761`), `/view/:name`, `/api/hash` (`:684`), `/api/live` (`:698`, inside a
  try/catch that reports 500 with `unreadable`) and `/api/panel` (`:712`, inside a try/catch).
  `supervisor.mjs` (`blaze start`) has its own async handler with `GET /` (`:579`) and
  `/api/hash` (`:524`). Mutating routes already resolve a write port on each request and close
  it afterwards (`serve.mjs:812-827`); an out-of-range schema returns 503.
- **Drivers.**
  - `fsReadStorage` and `memReadStorage` are synchronous and have `activityFeed`.
  - `openSqliteRead` returns a synchronous reader with **no `activityFeed` and no `close()`**.
  - `openPostgresRead` returns an async reader with `close()` and **no `activityFeed`**. Its
    `listTickets` hydrates every row with 4 further queries: about 10,000 round trips on the
    live corpus of roughly 2,500 tickets.
- **`unreadableTicketDirs`** (`scripts/model/index.mjs:162`) is a bespoke `readdir` walk outside
  the seam. Its own comment names that as a known gap.
- **`fsWritePort.read`** already honours an injected `readStorage`
  (`scripts/model/write-port.mjs:123-125`). `dbWritePort.read` and `dbWritePort.exists` are async
  SQL.
- **Corrections to the kickoff brief:**
  - `missingClaimErrors` is already out of `buildIndex`; `reindex.mjs` calls it separately.
  - `/api/live` already wraps `liveModel` in a try/catch inside an async handler, so an awaited
    read there cannot crash the process.
  - Both database readers lack `activityFeed`, not only the Postgres one.

## 3. Decision: resolve the reader at the entry point, await the seam, keep the core pure

We chose this over two alternatives:

- **Full async cascade.** This would make `boardModel`, `graphModel`, `pageHtml` and the other
  builders async and have them call the reader themselves. It touches more code and puts I/O
  inside the view layer, which ADR-0009 and ADR-0010 keep out, and it buys nothing over the
  chosen design.
- **Synchronous SQLite-only path that refuses Postgres.** This makes BLZ-254's acceptance
  criterion unreachable: two agents on two machines need a shared Postgres, served through the
  verbs and `serve`. The blocking-shim variant (`Atomics.wait` on a worker) was already rejected
  by ADR-0010 for any HTTP server.

**Rationale.** Every entry point is already async or can become async at its top level. The
runners are ESM and can use top-level await, and both servers' handlers are async. Every verb is
already async. The functions that are genuinely synchronous are pure transforms over a ticket
list: `buildIndex` already accepts `{ tickets, sprints }` (BLZ-274), and `boardModel` already
accepts `index`. So the async boundary goes where the I/O is, at the edge, and the pure core does
not change. ADR-0010's rule stands: the port is async, and the filesystem seam stays synchronous.
Consumers `await` every seam call, and awaiting the synchronous drivers' plain values is a no-op.

## 4. Design

### 4.1 `resolveReadStorage` and `resolvePorts`

Both are new exports in `scripts/model/write-port-resolve.mjs`, beside `resolveWritePort`.

```
resolveReadStorage({ dataRoot, projectsDir, env = process.env,
                     resolveDbConfig, openPostgresRead, openSqliteRead })
  → { readStorage, mode, close }
```

- `mode = resolveWriteMode(env)` is the only source of the mode. It never reads
  `database.driver` independently; BLZ-667 Task 9 settled that.
- `fs` → `{ readStorage: fsReadStorage, mode, close() {} }`.
- `dual` → the same as `fs`. In dual mode the filesystem decides every outcome, so it also
  answers the reads.
- `db` → `resolveDbConfig({ dataRoot, config: loadConfig({ root: dataRoot }) })`:
  - `sqlite` → `openSqliteRead(shadowDbPath(dataRoot))`, with no `create`. A missing shadow gives
    the same "run `blaze db init`" refusal `openShadow` gives.
  - `postgres` → `openPostgresRead(connection)`, with no `create`. An empty schema is refused.
- Any other mode throws the same message `resolveWritePort` throws.
- `close` releases whatever was opened, and is a no-op for `fs`.

```
resolvePorts({ dataRoot, projectsDir, env, ... }) → { writePort, readStorage, mode, close }
```

`resolvePorts` resolves the mode once and returns both ports from that single resolution. This
makes read/write drift impossible by construction. In `db` mode on Postgres the two ports share
one `pg.Client`: the write port is built over `pgExec(reader.client)`. On SQLite the reader
(`openSqliteRead(path)`) and the write port (`openShadow`) open two handles on the same shadow
file. That is consistent because `node:sqlite` commits synchronously before a write returns.
Sharing one handle would need a new handle-accepting opener, which this design does not add.
`close` closes everything that was opened, once. Every verb entry point uses `resolvePorts`; read-only entry points
use `resolveReadStorage`.

### 4.2 Driver changes

- **`activityFeed(dataRoot)` on every driver.** Extract the existing body of
  `fsReadStorage.activityFeed` into one exported helper, `readActivityFeed(dataRoot)` in
  `read-storage.mjs`. `fsReadStorage`, the SQLite reader and the Postgres reader (as `async`) all
  delegate to it. The feed is a local file written by a hook on every board type, as
  `read-storage.mjs`'s own comment says, so the database drivers deliberately implement the same
  filesystem read. The contract `{ text, unreadable }` is unchanged.
- **`unreadableTicketDirs(root)` on every driver.** `fsReadStorage` delegates to the existing
  function in `index.mjs`. The SQLite, Postgres and `mem` drivers return `[]`, because a database
  has no directories. `audit-runner` and `reconcile` call it through the seam.
- **`close()` on the SQLite reader** (`db.close()`), so every reader can be closed unconditionally.
- **Batched Postgres `listTickets`.** One `SELECT` for tickets, plus one each for links, labels,
  components and worklog, over `ticket_id = ANY($1)` (or the whole live set). Rows are grouped in
  JS, ordered exactly as per-ticket hydration orders them. `hydrateAll` stays for
  `listChildren`/`blockersOf`, which return small sets. The same batching goes into the SQLite
  reader if the conformance suite shows its `listTickets` does N+1 queries. Otherwise the SQLite
  reader is left alone.

### 4.3 Seam consumers

| Consumer | Change |
|---|---|
| `locateTicket` | becomes `async`; `return await storage.getTicket(...)` |
| `applyMove`/`applyEdit`/`applyToggleAc`/`applyLog`/`applyResolve`/`applyLink` | `await locateTicket(projectsDir, id, { storage: readStorage })`; `applyMove` does `for (const t of await readStorage.blockersOf(...))` |
| `applyNew`, `applyEdit` corpus loops | `for (const t of await readStorage.listTickets(...))` |
| `loadBoard` | becomes `async`; its three callers `await` it |
| `reconcile` | `[...(await readStorage.listTickets(...))]`; `await readStorage.unreadableTicketDirs(...)` |
| `exportRows`/`exportCsv` | take `tickets` (an array), never a storage object |
| `boardModel` | takes `{ tickets }` (required from server callers); falls back to `fsReadStorage.listTickets` only when absent, so existing tests and library callers are unchanged |
| `graphModel`, `panelHtml`, `pageHtml`/`viewEnvelope`/`renderView` | take `tickets` (and pass it through), used for `buildIndex(projectsDir, { tickets })` |
| `liveModel` | gains optional `{ tickets, feed }`; the servers await both reads and pass them in; without them it keeps today's synchronous `readStorage` path, so existing tests and callers are unchanged |
| `panelHtml` | gains optional `{ tickets }`; when given, it renders the record's own `frontmatter`/`body` instead of re-reading `row.file` from disk, because in `db` mode `row.file` is an id handle, not a path |
| `contentHash` | unchanged signature; the server calls `await readStorage.changeToken(...)` directly |

`exportMarkdownDocs` (`import-markdown.mjs:264`) has no production caller and is left alone.

### 4.4 Entry points

| Entry point | Change |
|---|---|
| `move`/`edit`/`link`/`log`/`resolve`/`new` runners | `resolveWritePort` → `resolvePorts`; pass `readStorage` into `apply*`; `close()` in the existing exit path |
| `import-runner` | `resolvePorts`; pass `readStorage` to `runImport`/`runMappedImport`/`runRepair` |
| `reconcile.mjs` CLI, `supervisor.mjs` `runReconcile`, `serve.mjs` `/api/reconcile-preview` | `resolveReadStorage` (read-only), close in `finally`; `reconcile --apply` uses `resolvePorts` |
| `reindex.mjs`, `rollup-runner.mjs`, `audit-runner.mjs`, `schedule-runner.mjs`, `export-runner.mjs` | top-level `await resolveReadStorage(...)`; `tickets = await readStorage.listTickets(...)`; pass into the unchanged pure functions; close before exit |
| `serve.mjs` `GET /`, `/view/:name`, `/api/panel`, `/api/live`, `/api/hash`; `supervisor.mjs` `GET /`, `/api/hash` | resolve a reader on each request, `await` the reads, pass `tickets`/`feed` to the sync builders, close in `finally` |
| `serve.mjs` mutating routes | `resolveWritePort` → `resolvePorts`; pass `readStorage` to the verb |

`reindex.mjs` also writes `.blaze/index.json`. In `db` mode it writes the database-derived index
to that same path. `missingClaimErrors` stays filesystem-based and runs only in `fs`/`dual` mode:
claims are the filesystem allocator's ledger, and in `db` mode they are not the id authority.
Removing claims entirely is BLZ-254's job. `reindex`'s second cache,
`.blaze/transitions.json`, is still built from git rename history in every mode. In `db` mode
that history stops growing; deriving it from `ticket_event` is BLZ-254's scope and is named here
so it is not mistaken for covered.

**Deliberately filesystem regardless of mode:**
- `blaze db init` / `migrate/load-corpus.mjs` / `migrate/zero-diff.mjs`: they seed or compare
  from the filesystem by definition.
- `cli.mjs`'s preflight `fsReadStorage.listProjects` (`:233`): it validates configuration before
  any runner starts, and in `db` mode the project list comes from config first.
- The `sprints.json` registry: there is no database table for it, and BLZ-254 decides its fate.
- `.blaze/activity.jsonl`: a hook-written local file (§4.2).

### 4.4a No git commit in `db` mode (added 2026-09-29, operator decision)

In `db` mode, `dbWritePort` returns `{ file: "<id>" }`, an opaque handle
(`write-port.mjs:350`). Every verb runner, `blaze import`, `reconcile --apply` and every mutating
`serve.mjs` route then passes that to `commitOrQueue`, which tries to `git add` a path that does
not exist. The database write has already happened, and then the verb exits 1 with "commit
failed". No test covers `db`-mode verbs at CLI level, so this has never been seen. `reconcile`
is worse still: with no injected `writePort` it builds `fsWritePort` itself
(`reconcile.mjs:1870`), so in `db` mode `reconcile --apply` writes **files**, not the database.

Fix:
- `commit-or-queue.mjs` gains `stageFor(mode)`. It returns `commitOrQueue` for `fs` and `dual`.
  For `db` it returns a stage that keeps only the paths that **exist on disk**, commits those
  through `commitOrQueue`, and returns `{ ok: true, committed: false, queued: false }` when none
  are left. So a verb's id handles drop out and nothing is committed, while `blaze import`'s
  receipt and source-id map, which are real record files (`import-apply.mjs:494`: "a record, not
  a cache"), are still committed.
- `reconcile --apply` in `db` mode reports a distinct `db` commit outcome ("moved in the
  database; db mode makes no git commit"), never the "NO COMMIT CREATED — already matched HEAD"
  sentence, which would be false.
- `blaze schedule migrate-dates --write` rewrites ticket files directly through `fsStorage`, so
  in `db` mode it **refuses** by name (exit 1). Routing it through the write port is left to
  BLZ-254. The dry run still works and reads the database.
- `blaze audit` takes a ticket's status from the record's `status`, not from
  `basename(dirname(t.file))`, which is meaningless for an id handle.
- Every runner, `serve.mjs` mutating route, `import` and `reconcile` stages through
  `stageFor(mode)`. `reconcile` gains a `stage` parameter (default `commitOrQueue`), and its
  entry points pass it the resolved `writePort`.
- The success line carries no commit suffix.
- `fs` and `dual` modes are unchanged.

This does **not** decide whether `commit-or-queue.mjs` is deleted; that stays BLZ-254's explicit
decision.

### 4.5 Errors

- **CLI.** A refusal from the resolver prints its named message on stderr and exits 1, with no
  stack trace. Refusals include a missing or stale schema, `pg` not being installed, an
  incomplete connection, and an unknown mode. This uses the same try/catch pattern the runners
  already use around `resolveWritePort`.
- **Servers.** A resolver refusal returns **503** with `{ errors: [message] }`, the same rule and
  status the write side uses. A board-read failure after resolution keeps each route's existing
  report: `/api/live` returns 500 with `unreadable`, and `/api/panel` and `/` keep their current
  catches. The reader is closed in `finally` on every path.
- **Connection lifecycle.** Each request opens and closes its own reader, mirroring the write
  port. A page load costs one connection and about 5 queries. No pool (YAGNI); revisit only on a
  measured problem.

## 5. Guards and tests (TDD: every unit starts from a failing test)

1. **Driver conformance** (the existing single suite, run against fs, SQLite and Postgres, with
   Postgres gated on `BLAZE_TEST_PG_URL`) gains:
   - `activityFeed`: missing, present, and unreadable feed.
   - `unreadableTicketDirs`.
   - `close()` on every driver.
   - Batched `listTickets` parity: the same records in the same order as `getTicket` per id.
2. **Resolver unit tests.**
   - The full matrix: mode (`fs`/`dual`/`db`) × driver (`sqlite`/`postgres`, using fakes) ×
     outcome (opened / refused).
   - `resolvePorts` returns read and write ports over the same connection (asserted by identity
     on the fake client).
   - No path ever passes `create: true`.
3. **The split-brain regression, end to end.**
   - In a scratch board with `BLAZE_WRITE_PORT=db` on SQLite, run: `new` → `move in-progress` →
     `move in-review` → `reindex` → `rollup` → `audit` → `GET /api/panel`, `/api/live`, `/`.
   - Assert that every read reflects the database, including a case where the database and the
     files deliberately disagree.
   - **Proven discriminating:** run it first against the unfixed tree, where it must fail.
   - A `BLAZE_TEST_PG_URL`-gated Postgres twin covers the verb and server legs.
4. **Read-seam guard.** Add a test beside `seam-closure.test.mjs`, which is extended only by
   addition. It asserts that no production module outside an explicit allowlist imports
   `fsReadStorage` or calls `walkTickets`. The allowlist is the resolver, `read-storage.mjs`,
   `index.mjs`, the migration tooling, the `cli.mjs` preflight, and the `boardModel` library
   fallback. A future bypass then fails in CI instead of in production.
5. **Unchanged behaviour in `fs`/`dual` mode.** The full existing suite passes unmodified except
   where a test called a function whose signature changed (sync → async). Those tests change only
   by adding `await`, and each such change is listed in the PR.

## 6. Delivery

- **One feature PR**, branch `BLZ-670-db-mode-reads`, title
  `BLZ-670: database-mode reads across every entry point`.
- **Ticket.** BLZ-670's title, AC and estimate are updated to this scope through
  `blaze-board-operator`. The plan decides whether units become child tickets; `task` can
  parent only `subtask`s, so the split would use subtasks, or BLZ-670 is retyped to
  `feature`. Either way it is still one PR.
- **Docs in the same PR:**
  - An addendum to ADR-0010: consumers await every seam call, and the synchronous filesystem seam
    is unchanged.
  - A new ADR: *reads resolve from the write mode, at the entry point*, carrying §3's rationale.
  - `docs/` pages that describe `BLAZE_WRITE_PORT` gain the read-side behaviour.
  - `AGENTS.md` only if it states read behaviour.
- **Not in this PR:** BLZ-668/669 (counter seeding), `claims.mjs` removal and the rest of BLZ-254,
  moving the `sprints.json` registry, and connection pooling.

## 7. Risks

| Risk | Mitigation |
|---|---|
| A missed read site keeps reading files in `db` mode | Read-seam guard (§5.4) plus the end-to-end regression (§5.3) |
| A sync → async signature change breaks an untested caller | Every changed export is listed in the plan with all its callers (§2's inventory); the full suite runs per task |
| Batched `listTickets` changes record order or shape | Conformance parity test against per-id `getTicket` (§5.1) |
| A connection leaks on an error path (the BLZ-534 class) | `close` in `finally` at every entry point; `closeOnSetupFailure` already covers setup |
| Per-request Postgres connection latency on the board page | Accepted for a solo board; measured once on the Postgres twin and recorded in the PR |
