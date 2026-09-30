# db-mode write and seed fixes — design (BLZ-668, 669, 671, 672, 673)

Date: 2026-09-30 · Parent: BLZ-667 · Feeds: BLZ-254 (live-board cutover)
Branch / PR: `BLZ-668-db-mode-write-seed-fixes`, one feature PR titled
`BLZ-668 + BLZ-669 + BLZ-671 + BLZ-672 + BLZ-673: …`, one commit series per ticket.

## 1. Goal

Remove the five known ways `BLAZE_WRITE_PORT=db` either cannot be set up or writes wrongly,
so BLZ-254 can plan a cutover against a write path with no known defects:

| Ticket | Defect today (verified at `c46ce90`) |
|---|---|
| 668 | `blaze db init` has **no Postgres path**: `db-runner.mjs` hard-codes `openShadow` and the `"sqlite"` dialect, so a Postgres `project_counter` is never seeded |
| 669 | Nothing re-seeds the counter; ids handed out on the file path after `db init` are invisible to it |
| 671 | `applyImport` allocates with `ids.mjs` `allocateId` and writes an `.ids/` claim directly (`import-apply.mjs:431,452`), bypassing `writePort.allocate`; a db-mode import can collide with db-mode `new` |
| 672 | A db-mode import row with no `created` binds `undefined` to `created_on NOT NULL` (`write-port.mjs:294`) |
| 673 | The groomer reads `.md` files with raw `node:fs`, has an external agent edit the file, and `git commit`s it; under db it is refused (`supervisor.mjs:402`) |
| cleanup | The Postgres "no Blaze schema" refusal (`write-port-resolve.mjs:268-271`) says `run blaze db init`, which is false today; the refusal is tested only with a fake `pg.Client` |

**Hard constraints** (from the kickoff, §5): `fs` and `dual` behaviour unchanged; mode comes
from `resolveWriteMode(env)` only; `tests/model/seam-closure.test.mjs` changes are additive or
exact name swaps with a `// BLZ-6xx:` comment, never a weakened assertion.

**Decisions taken in brainstorming (operator-approved 2026-09-30):**
1. Postgres `db init` = schema + counter seed only. Loading the corpus into Postgres stays in
   BLZ-254 (its migration has the zero-diff oracle).
2. A missing `created`/`updated` on a db write is stamped with the write's date by the db port.
3. The db-mode groomer materialises the ticket to a scratch file for the agent and writes the
   result back through the write port. The fs groomer path is untouched.

## 2. BLZ-668 + 669 — counter seeding for both drivers

### 2.1 New module `scripts/model/seed-counter.mjs`

- `counterUpsertSql(dialect)` — the one place the "never lower" rule is spelled:
  SQLite `SET n = max(project_counter.n, excluded.n)`, Postgres
  `SET n = GREATEST(project_counter.n, excluded.n)`. `load-corpus.mjs:186-189` switches to it
  (exact-text refactor; its SQLite behaviour is unchanged).
- `corpusMaxima({ projectsDir, dataRoot, readStorage })` → `Map<prefix, n>`: the highest
  number per prefix across (a) every well-formed ticket id the file corpus holds, including
  unreadable-but-present ones, as `load-corpus.mjs:84-98` counts them, and (b) every `.ids/`
  claim — a claim is a number handed out that may not yet have a ticket. The plan names the
  exact `ids.mjs`/`claims.mjs` reader used for (b).
- `seedCounter(exec, maxima, { dialect })` → for each prefix, also takes
  `MAX(num)` from the database's own `ticket` table, upserts
  `max(corpus, claims, table)`, and returns `[{ project, before, after }]`. Idempotent;
  never lowers; a second run with no new ids reports `before === after` for every row.

### 2.2 CLI

- `blaze db init`, `database.driver = postgres`: open with `openPostgresClient` +
  `resolveDatabaseConfig` (the same pair `resolveWritePort` uses), run
  `createDbSchema(pgExec(client), { dialect: "postgres" })` (it already refuses a database that
  holds a schema), then `seedCounter`. Any further DDL `resolveWritePort`/`applyNew` need on
  Postgres (projection, write rules, config tables — SQLite init runs all three) is
  established by the plan against the code; the acceptance test below is the arbiter.
  Re-running `init` on an initialised Postgres refuses and names `blaze db seed-counter`.
  `--force` is **refused** on Postgres (we never drop a real database's tables from a CLI flag).
- `blaze db seed-counter` (BLZ-669): both drivers. Opens the resolved database (SQLite shadow
  via `openShadow`; Postgres via the checked open), runs `seedCounter`, prints
  `project  before → after`, exits 0. Refuses (exit 1, named) if the database has no schema.
  This is the step run immediately before flipping `BLAZE_WRITE_PORT=db`; the runbook line
  goes in the docs in this PR.
- SQLite `db init` keeps its current flow; it gains the claims source (b) by calling
  `seedCounter` after `loadCorpus` — this can only raise a counter, never lower one.

### 2.3 Cleanup item (folded into 668)

Once 2.2 lands, `blaze db init` is true for Postgres, so the refusal text stays correct; it is
extended to say the connection it checked (`host/database`, never the password). Add a
`BLAZE_TEST_PG_URL`-gated test that opens a real empty scratch database through
`resolveWritePort` and asserts the refusal and that the client is closed.

### 2.4 Tests

SQLite always; Postgres gated (`{ skip: PG ? false : "set BLAZE_TEST_PG_URL" }`, scratch
database per test as in `write-port.test.mjs:470`):
- seed from corpus-only, claims-only (claim above every ticket), table-only; never lowers;
  idempotent second run.
- **Acceptance:** Postgres `db init` on an empty database → db-mode `applyNew` → id is
  `max + 1`. `init` again → refused naming `seed-counter`.

## 3. BLZ-671 — import allocates through the port

### 3.1 Port interface: add `reserve(id, { title })`

`allocate` covers "give me the next id". Import's explicit-id path ("this row is `BLZ-900`")
needs "this id is now taken", or a later db-mode `new` hands out 900 again.

| Port | `reserve(id, { title })` |
|---|---|
| fs | injected like `allocate`; the default writes the claim (`writeClaim`) and returns `{ claimFile }` |
| db | `counterUpsertSql` with `n` = the id's number; returns `{}` |
| dual | delegates to the primary (fs), as `allocate` does |

### 3.2 `applyImport`

- Allocated-id create: `const { id, claimFile } = await writePort.allocate(project, { title })`.
- Explicit-id create: `const { claimFile } = await writePort.reserve(id, { title })`.
- `files.push(claimFile)` only when one is returned. Receipt phases are unchanged.
- The default port (`fsWritePort(projectsDir)` at `import-apply.mjs:377`) gets the fs
  `allocate`/`reserve` injected, **with the same options import passes today**
  (`{ dataRoot, remoteMax: 0 }`); the plan checks that the injected closure matches this call
  exactly, so fs import output is byte-identical.
- seam-closure: `allocateId`, `writeClaim` leave `import-apply.mjs`'s `WRITE_ALLOWED` entry
  (exact removal with a `// BLZ-671:` comment); the new port methods join
  `write-port.mjs`'s pins.

### 3.3 Tests

- db (SQLite; Postgres gated): interleave `new`, `import --allocate-ids`, `new`, explicit-id
  import of a high id, `new` → all ids distinct; last `new` = high id + 1; no `.ids/` file
  created.
- fs: existing import tests pass unchanged (the byte-identical guard).

## 4. BLZ-672 — db port stamps a missing date

`dbWritePort({ …, today })` takes an injectable clock (default: local date `YYYY-MM-DD`, the
same form `new-runner.mjs:79` produces). In `persistRows`: `created_on = fm.created || today()`,
`updated_on = fm.updated || fm.created || today()`. Only a missing value is filled; a present
one is written verbatim. The fs path is untouched (a file still omits the key, by import
design §2.6). A dual shadow write that used to fail on such a row now succeeds; that is a
bug fix to the shadow, not a change to dual's observable (fs) behaviour.

Tests: db-mode import of a row with no `created` on SQLite (and Postgres gated) → row lands
with `created_on = today`; a row with a `created` keeps it.

## 5. BLZ-673 — the groomer under db

### 5.1 Shape

`groomOnce` gains a db branch; the fs path is not edited.

1. **Select.** `resolvePorts` (from `supervisor.runGroomer`, which closes it) supplies
   `readStorage`; candidates = `listTickets` filtered to `cfg.loops.groomer.columns`, in
   column order then id order. The ungroomed test is unchanged in kind:
   `state.groomed[id] !== hashContent(serializeTicket(ticket))`.
2. **Materialise.** `mkdtemp` a scratch dir; write `<id>.md` with `serializeTicket`. The agent
   runs with that dir as its working tree and the same prompt, naming that file.
3. **Contain.** Snapshot the scratch dir before and after; anything other than that one file
   changed → refused, as the fs path refuses out-of-bounds edits.
4. **Parse and guard.** Parse the file back. Refuse (named, on the bus) if any frontmatter key
   outside `EDITABLE_FIELDS ∪ {updated}` changed — `id`, `project`,
   `status`, `resolution`, `created`, `branch`, `pr` and derived fields are not the groomer's.
   Body changes are allowed (grooming edits AC and Notes).
5. **Validate and write.** Set `updated = today`; `validateTicket` against the board as
   `edit.mjs:48-56` does; then `writePort.write({ project, status, frontmatter, body },
   { actor: "groomer", source: "groomer" })`. No git commit; nothing to stage in db.
6. Record the new hash in groomer state; remove the scratch dir in a `finally`.

### 5.2 Supervisor

Delete the BLZ-670 refusal in `runGroomer`; resolve ports once per run and close them in a
`finally`. A resolver refusal is published on the bus in the existing groomer-error shape.

### 5.3 seam-closure

`loops/groomer.mjs` is already `WRITE_ALLOWED: "*"`. New `writes`/`inert` members are added
to its `SEAM_WRITE_PROVIDERS` entry; it does not name `fsReadStorage`, so
`FS_READER_ALLOWED` is unchanged. `supervisor.mjs` already lists `resolvePorts`.

### 5.4 Tests

`tests/groomer-db-mode.test.mjs` currently asserts the refusal. That assertion is **replaced**,
not weakened: the behaviour it pinned is deliberately removed. New cases (SQLite shadow,
stub agent): grooms a ticket through the port and the change reads back; out-of-bounds file
refused; identity-field change refused; invalid result refused; the fs-mode groomer tests
pass unchanged.

## 6. Docs (same PR)

- CLI reference: `blaze db init` (Postgres behaviour, `--force` refusal), `blaze db seed-counter`.
- Cutover runbook line: run `blaze db seed-counter` immediately before setting
  `BLAZE_WRITE_PORT=db`.
- ADR-0037 addendum (or a new ADR if the plan finds 0037 closed): the write port's `reserve`
  method and why explicit ids need it.

## 7. Out of scope

Corpus load into Postgres, `claims.mjs` deletion, the commit lock, `transitions.json`, and
sprints — all BLZ-254. This PR keeps `.ids/` claims as a seed *source* because they are still
live until BLZ-254 deletes the file allocator.

## 8. Done

All tests green locally, including the §8 local-Postgres block, and in CI; the five tickets
reach `done/` via reconcile from the squash bullets.
