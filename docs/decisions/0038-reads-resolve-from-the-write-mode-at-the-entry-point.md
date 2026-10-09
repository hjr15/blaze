# 38. Reads resolve from the write mode, at the entry point

Date: 2026-09-29

## Status

Accepted (BLZ-670)

## Context

BLZ-670 started as five named `buildIndex` call sites. Inventorying the read path
(`docs/superpowers/specs/2026-09-29-db-mode-reads-design.md` §2, verified against `5d3476c`)
found those five are a symptom of a much larger defect: with `BLAZE_WRITE_PORT=db`, **every**
production read — every verb, every CLI runner, both HTTP servers — still comes from the
filesystem, while every write goes to the database. `blaze new` → `blaze move <id> in-progress`
→ `blaze move <id> in-review` split-brains: the second move reads the ticket's stale status from
its (unwritten) file and fails, even though the first move succeeded in the database. No
production code even constructs a non-filesystem reader; `openSqliteRead` and `openPostgresRead`
were reached only from tests and migration tooling.

This is the same split ADR-0010 anticipated and left open: ADR-0010 settled that the v3 storage
port is async while the transitional filesystem seam stays synchronous, but it did not say where
a *reader* comes from on each request. That gap is what let every entry point default to the
synchronous filesystem seam regardless of `BLAZE_WRITE_PORT`.

## Decision

**Resolve the reader at the entry point, await the seam, keep the core pure.** Two new exports in
`scripts/model/write-port-resolve.mjs`, beside `resolveWritePort`:

- `resolveReadStorage({ dataRoot, projectsDir, env, ... }) → { readStorage, mode, close }` — the
  mode comes from `resolveWriteMode(env)` **only**, never independently from `database.driver`
  (BLZ-667 Task 9 settled that). `fs` and `dual` both return `fsReadStorage` (in `dual` mode the
  filesystem decides every outcome, so it also answers the reads); `db` opens the SQLite shadow or
  the Postgres connection per `resolveDbConfig`, with no path ever passing `create: true` — a
  missing shadow or an empty Postgres schema is refused with the same message `openShadow`/
  `resolveWritePort` already give.
- `resolvePorts({ dataRoot, projectsDir, env, ... }) → { writePort, readStorage, mode, close }` —
  resolves the mode once and returns both ports from that single resolution, which makes
  read/write drift impossible by construction. On Postgres the two ports share one `pg.Client`
  (the write port is built over `pgExec(reader.client)`); on SQLite they are two handles on the
  same shadow file, which is safe because `node:sqlite` commits synchronously before a write
  returns. Every verb entry point uses `resolvePorts`; read-only entry points (`reindex`,
  `rollup`, `audit`, `schedule`, `export`, the reconcile preview, board/panel/live rendering) use
  `resolveReadStorage`.

Every entry point was already async, or can become async at its own top level: the runners are
ESM and take top-level `await`, both servers' handlers are async, and every verb is already async.
The functions that are genuinely synchronous are pure transforms over a ticket list —
`buildIndex` already accepts `{ tickets, sprints }` (BLZ-274) and `boardModel` already accepts
`index` — so the async boundary goes where the I/O is, at the edge, and the pure core does not
change. Consumers now `await` every seam call; awaiting the synchronous filesystem seam's and the
synchronous SQLite driver's plain values is a no-op, which the conformance suite already relied
on (see the ADR-0010 addendum below).

### Alternatives rejected

- **Full async cascade.** Make `boardModel`, `graphModel`, `pageHtml` and the other builders
  async and have them call the reader themselves. Rejected: it touches more code, puts I/O inside
  the view layer (which ADR-0009 and ADR-0010 keep out), and buys nothing over resolving once at
  the entry point and threading `tickets` through.
- **Synchronous SQLite-only path that refuses Postgres.** Rejected: it makes BLZ-254's acceptance
  criterion unreachable — two agents on two machines need a shared Postgres served through the
  verbs and `serve`.
- **A blocking shim** (`worker_threads` + `SharedArrayBuffer` + `Atomics.wait`, blocking the main
  thread on an async call). Already rejected by ADR-0010 for any HTTP server, and this design adds
  nothing that reopens it.

### The `db`-mode staging rule, and why it is a separate decision from `commit-or-queue.mjs`'s fate

In `db` mode `dbWritePort` returns an opaque `{ file: "<id>" }` handle, not a path. Before this
change, every verb runner, `blaze import`, `reconcile --apply` and every mutating `serve.mjs`
route passed that handle to `commitOrQueue`, which tried to `git add` a path that does not exist —
the database write had already succeeded, and the verb then exited 1 with "commit failed" (no
test exercised `db`-mode verbs at CLI level, so this had never been seen). `reconcile --apply`
was worse: with no injected write port it built `fsWritePort` itself, so in `db` mode it wrote
**files**, not the database.

The fix is `stageFor(mode)` in `commit-or-queue.mjs`: for `fs` and `dual` it is `commitOrQueue`
unchanged; for `db` it keeps only the paths that **exist on disk**, commits those through
`commitOrQueue`, and returns `{ ok: true, committed: false, queued: false }` when none are left.
A verb's opaque id handles drop out of staging and nothing is committed for them, while
`blaze import`'s receipt and source-id map — real record files, not caches — are still committed
because they genuinely exist on disk. `reconcile` gains a `stage` parameter (default
`commitOrQueue`) so every entry point can pass it the resolved write port, and `reconcile --apply`
in `db` mode reports a distinct outcome, "moved in the database; db mode makes no git commit",
never the "NO COMMIT CREATED — already matched HEAD" sentence, which would be false there. The
browser gets the same treatment: `serve.mjs`'s mutating routes add `db: true` to their 200 body in
`db` mode, and the page's `writeOutcome` checks it before the `committed === false` arm, so a
board click in `db` mode says nothing rather than "the file already matched HEAD".

**This decides staging, not deletion.** `stageFor(mode)` makes `db`-mode writes stop corrupting
the git tree; it does not decide whether `commit-or-queue.mjs` itself is deleted once the
filesystem seam is gone. That stays BLZ-254's explicit decision — this ADR only makes the current
staging code behave correctly under a mode it was never written for.

One more `db`-mode consequence follows from the same handle problem: `blaze schedule
migrate-dates --write` rewrites ticket files directly through `fsStorage`, so in `db` mode it now
**refuses by name, exit 1**, rather than silently doing nothing or writing files a database
install does not read. The dry run is unaffected — it reads the database like everything else.
Routing `--write` through the write port is left to BLZ-254. Separately, `blaze audit` now takes
a ticket's status from the record's own `status` field, not from `basename(dirname(t.file))`,
which is meaningless once `file` is an id handle instead of a path.

### Named residuals

Four things this design deliberately does not touch, so they are not mistaken for covered:

- **`.blaze/transitions.json`** is still built from git rename history, in every mode, including
  `db`. In `db` mode that history stops growing once moves stop touching files. Deriving it from
  `ticket_event` instead is BLZ-254's scope.
- **`sprints.json`** has no database table in any mode; it stays a plain-text registry read from
  the data root. Its fate is BLZ-254's to decide.
- **The groomer loop** (`scripts/loops/groomer.mjs`, run by `supervisor.mjs`'s `runGroomer`)
  picks a ticket by reading `projects/<KEY>/<col>/*.md`, has an agent edit that file, and commits
  it. It never reads or writes through the port. In `db` mode it is therefore **refused**: each
  tick publishes a `{ type: "error", loop: "groomer" }` event saying the groomer edits ticket
  files and under `BLAZE_WRITE_PORT=db` the database is the store, and no groom runs. Routing it
  through the port is BLZ-673 (under BLZ-254).
- **Connection pooling.** Each request opens and closes its own reader, mirroring the write port
  — no pool. This is YAGNI for a solo board; it is revisited only on a measured problem, not
  preemptively.

## Consequences

- **The split-brain defect is closed.** Every read a verb, CLI runner, or server makes now comes
  from the same store its writes go to, in every mode — with one named exception at the time of
  writing: the groomer loop still read and edited ticket files, so in `db` mode it was refused
  rather than run (see Named residuals). *BLZ-673 has since closed it — see the Addendum below.*
  `fs` and `dual` behaviour is unchanged byte-for-byte.
- **ADR-0010's rule stands**, and is now stated as an addendum there: the port is async, the
  filesystem seam is unchanged, and consumers await every seam call.
- **A malformed `BLAZE_WRITE_PORT` now surfaces**, uniformly, wherever it previously would not
  have: `resolveReadStorage`/`resolvePorts` throw the same "not a write port — expected 'fs',
  'dual' or 'db'" refusal `resolveWritePort` already threw, and every entry point that now goes
  through them reports it in that entry point's own idiom rather than silently defaulting to `fs`
  — `reconcile`'s CLI and the other read-only CLI scripts (`reindex`, `rollup`, `audit`,
  `schedule`, `export`) print the message and exit 1; `supervisor.mjs`'s reconcile loop surfaces
  it as a run-error feed event; `serve.mjs`'s `/api/reconcile-preview` and the mutating routes
  answer 503 with `{ errors: [message] }`, the same status and shape the write side already used.
  So does every board GET on `serve.mjs` and `supervisor.mjs` — `/`, `/view/*`, `/api/hash`,
  `/api/live`, `/api/panel` — which now resolve a reader per request: a malformed value makes
  them answer 503 where they used to render the filesystem board. Before this change, a bad value could go unnoticed on a read-only path that never resolved a
  port at all.
- **Two known `db`-mode write defects remain, tracked separately, outside this read-path ticket:**
  `blaze import` in `db` mode allocates ids from the filesystem allocator rather than the
  database's `project_counter` (BLZ-671), and it fails on a row with a blank `created` because
  `created_on` binds `undefined` (BLZ-672). Both block BLZ-254's real cutover and are filed under
  BLZ-667.
- **Batched Postgres reads.** `listTickets` moves from per-ticket hydration (about 10,000 round
  trips on the live ~2,500-ticket corpus) to five queries for the whole corpus: the live tickets,
  plus one unfiltered `SELECT` of each of the whole `ticket_link`, `ticket_label`,
  `ticket_component` and `worklog_entry` tables, rows grouped by ticket in JS in the same order
  per-ticket hydration produced. Rows belonging to a deleted ticket are read and simply not
  joined to anything. The same batching
  goes into the SQLite reader only if the conformance suite shows its `listTickets` does N+1
  queries.
- **A read-seam guard** (beside `tests/model/seam-closure.test.mjs`) now fails CI if a production
  module outside a named allowlist imports `fsReadStorage` or calls `walkTickets` directly, so a
  future bypass of `resolveReadStorage`/`resolvePorts` is caught before it reaches production.

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

## Addendum (2026-10-05, BLZ-254 PR A) — the remaining named residuals

BLZ-254 decided each residual this ADR left open ([spec](../superpowers/specs/2026-10-05-blz-254-live-board-cutover-design.md) §5.7 and §5.8):

- **`.blaze/transitions.json` — closed (BLZ-680).** Under `db` the Metrics view reads its
  history from the `ticket_transition` view over `ticket_event` (`dbTransitions`, called by both
  servers for the metrics view only). `blaze db load` imports the git-era history once, through
  BLZ-281's import rules (`import-transitions.mjs`: timestamps verbatim, `source =
  'git-backfill'`, actor `unknown`, unknown and malformed rows counted, coverage reported) and
  says so loudly when the data root has no git history to import; the SQLite `blaze db init`
  does the same for the shadow. `fs` and `dual` still read git, unchanged.
- **`sprints.json` — kept as a data-root config file**, like `blaze.config.json`. It is a small
  operator-edited registry; a ticket's sprint membership is already the `ticket.sprint_id`
  column. It moves with config in Phase 5.
- **Connection pooling — measure first.** The cutover rehearsal times 200 sequential `GET /` and
  100 `POST /api/new` against the cluster database; a `pg.Pool` (max 5) is built only if either
  p95 exceeds 250 ms, or connecting takes more than 20% of p95. The numbers are recorded on
  BLZ-254 either way.
