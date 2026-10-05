# BLZ-254 — cut the live board over to Postgres and retire the git write path

Date: 2026-10-05 · Ticket: BLZ-254 (parent BLZ-195) · Children: BLZ-674, BLZ-675, BLZ-676 + those in §9
Supersedes §3–§6 and §9 of `2026-09-23-blaze-v3-phase2-db-cutover-design.md` for BLZ-254. That
document's §7 (BLZ-309/324) and §8 (Phase 5) are not BLZ-254 and are not revisited here.
Recon evidence (git-ignored, file:line level): `.superpowers/sdd/blz-254/recon/{A,B,C,D}-*.md`.

## 1. Goal and done

`blaze.howman.link` serves and writes from Postgres. A second machine creates tickets over
HTTP. Every git-era write mechanism the live board needed is gone. Done means every BLZ-254
acceptance criterion is answered — met, or amended with the reason recorded on the ticket
(§3) — and a real live cutover has run with the operator's go-ahead.

## 2. Decisions taken by the operator (2026-10-05)

| # | Question | Decision |
|---|---|---|
| D1 | What does BLZ-254 retire? | **Git ceremony only.** fs mode stays a supported *single-machine* product mode with its allocator (`ids.mjs`, `claims.mjs`). The live board moves to db. |
| D2 | How does a second machine write after cutover? | **HTTP through `serve.mjs`**, with a bearer token. Postgres stays cluster-internal. |
| D3 | Where does Postgres run? | **CloudNativePG cluster in `service-platform`**, ArgoCD-managed, with scheduled backups. |

## 3. Corrections to the ticket, verified 2026-10-05

| Ticket says | Actually | Consequence |
|---|---|---|
| 2,497 tickets | **2,918 ticket files** on `BLZ-305-v4-spine` (2,165 on the branch the pod serves) | Re-counted again at cutover (§7 step 4). |
| Re-home `parent_rules.mjs` | Already deleted, with `metadata_audit.py`, in blaze-pm `ec02b625` (BLZ-240) | Fate: **already deleted**. |
| Deleting `claims.mjs` breaks board rendering via `index.mjs:137-162` | Stale. `missingClaimErrors` is outside `buildIndex`'s core, called once (`reindex.mjs:85`) and already a no-op in db mode | Deleting it is cheap. |
| Delete `claims.mjs` and the three-layer allocator | Under D1 they are fs mode's only allocator | AC amended: **kept because fs mode is a supported single-machine mode**. `missingClaimErrors` is still deleted. |
| ADR-0006 "DB is sole source of truth" | Status *Proposed* | Gets an addendum: db is the multi-machine mode; fs is single-machine (§5.5). |
| The live board is one tree | **It is two diverged, unpushed branches** (§4) | New prerequisite: corpus reconciliation. |

## 4. Corpus reconciliation (new prerequisite)

The pod bind-mounts the laptop's `blaze-pm` main checkout. That checkout is on
`BLZ-143-engineering-method-and-work-item-model` (tip 2026-09-10, 2,165 tickets). Every
session since then has written to the `BLZ-305-v4-spine` worktree (tip 2026-10-02, 2,918
tickets). The two forked at `18327cc0` (2026-08-10). Every `BLZ-143` ticket id exists on
`BLZ-305`. However, 84 of `BLZ-143`'s 95 unique commits have no patch-equivalent on
`BLZ-305`, and 82 tickets they touch differ between the two branches. The pod's checkout
being on a feature branch is also why the nightly `blaze-flush` job fails today.

**Decision:** `BLZ-305-v4-spine` is the authoritative tree. A `blaze-board-operator`
works through `BLZ-143`'s 84 non-equivalent commits:
- It carries forward any change missing from `BLZ-305`.
- Where `BLZ-305` is newer, it keeps `BLZ-305`.
- It records each of the 84 commits as carried, superseded or empty, in a ledger committed to blaze-pm.

The migration source is then the reconciled `BLZ-305` tree. blaze-pm is still never pushed.

## 5. Design

### 5.1 Postgres (service-platform)

- A CNPG `Cluster` named `blaze-pg` in namespace `blaze`, with one instance, a PVC and a
  scheduled `Backup` (daily, retained 14 days).
- The engine reads five discrete variables (`database-config.mjs`): `BLAZE_DB_HOST`,
  `BLAZE_DB_PORT`, `BLAZE_DB_NAME`, `BLAZE_DB_USER` and `BLAZE_DB_PASSWORD_ENV`. The chart
  sets them on the Deployment. The password comes from the CNPG-generated `blaze-pg-app`
  Secret, by reference only.
- `BLAZE_WRITE_PORT` stays unset (fs) until the cutover flips it (§7).

### 5.2 Corpus load into Postgres: `blaze db load`

- Split `load-corpus.mjs` into a pure row builder (`corpusRows(source, projectsDir)`) and
  two executors: the existing sync SQLite one, and a new async one using `exec` with
  `sql-dialect` placeholders. The row builder is shared, so the two dialects cannot drift.
- The load runs in one transaction. It refuses a non-empty `ticket` table unless given
  `--replace`, which truncates the ticket tables in that transaction.
- It ends by calling `seedCounter` from the loaded MAX, so the load and the counter cannot
  disagree.
- `acceptance_criterion` is a derived index. Nothing in db mode reads it (`postgresReader`
  returns `body` verbatim, ACs included), and `dbWritePort` does not maintain it. The
  Postgres executor leaves it empty, and the spec records it as SQLite-shadow-only. Filling
  a table that writes then let go stale would plant a trap.

### 5.3 Correctness oracle: `blaze db verify`

The migration gate is a production caller for `zero-diff.mjs` (BLZ-281):
- **Source:** the fs reader over the reconciled tree.
- **Loaded:** `postgresReader` with every ticket pre-awaited and wrapped synchronously, the
  shape its tests use.

It passes only if all of these hold:
1. `valueDiffs.length === 0`.
2. The id set on each side is identical.
3. Row counts match the loader's tallies for each of `ticket`, `ticket_link`,
   `worklog_entry`, `ticket_label` and `ticket_component`.
4. `criteriaFor` agrees on every ticket, using `ac-oracle-matcher.mjs`, which is
   independent of the importer.

`byteDiffs` (BLZ-253's field-order noise) is printed as information and never gates. This
is the settled definition of the oracle that BLZ-254's "empty git diff" AC asked for. The AC
is amended to "`blaze db verify` exits 0". Exit codes: 0 pass, 1 diffs, 2 could not run.

### 5.4 Remote writes over HTTP (D2)

- **`POST /api/new`** (scope `write`) calls `applyNew` through the resolved write port, so
  under db the id comes from `project_counter`'s transactional allocate. It returns
  `{ ok, id }`.
- **`POST /api/link`** is already listed in `ROUTE_SCOPES`. The plan confirms it reaches the
  ticket-link verb under db and adds it to `serve.mjs`'s POST handler if it doesn't.
- **CSRF applies to cookie-authenticated requests only.** A request that authenticated with
  `Authorization: Bearer` skips the `x-blaze-csrf` check. ADR-0013 §7 already scopes that
  check to the browser flow, and a bearer token isn't ambient. A request that carries both a
  cookie and a bearer token is treated as a cookie request (CSRF still required). An
  ADR-0013 addendum records this.
- **CLI remote mode.** When `BLAZE_REMOTE_URL` and `BLAZE_TOKEN` are both set, `cli.mjs`
  sends `new`, `move`, `edit`, `resolve`, `log`, `ac` and `link` to the matching endpoint and
  prints the server's result. The verb logic and validation run once, on the server. The
  module is `scripts/remote-client.mjs`, using built-in `fetch`.
- In remote mode, every other command (`import`, `groom`, `db`, `reconcile`, `sprint`, …)
  refuses with `blaze: <cmd> is not available in remote mode`. A remote mode set
  half-way (only one of the two variables) is an error, never a silent fallback to local.
- Remote reads (`show`, `list`) are **out of scope**. Agents read the board over
  `GET /api/live` or the page. A follow-up ticket is filed if the cutover shows they're
  needed.

### 5.5 Retiring the git ceremony (D1)

| Mechanism | Fate |
|---|---|
| `commit-lock.mjs` | **Deleted.** |
| Pending ledgers (`pending-ledger.mjs`, `.blaze/pending/`, `.blaze/pending-commit.jsonl`) | **Deleted**, after the final flush in §7 step 2. |
| `commit-runner.mjs` (`blaze commit`), `serve-commit.mjs` | **Deleted.** |
| `publish-runner.mjs` (`blaze publish`: sweep the queues, then trigger `blaze-flush`) | **Deleted.** It has nothing left to sweep or trigger. |
| `commit-or-queue.mjs` / `stageFor(mode)` | **Deleted.** The board never commits. In fs mode the user versions the files themselves. In db mode the import receipt and map are written as files and not committed. `serve.mjs`'s responses drop `committed`/`queued` and keep `db`. |
| `blaze-flush` CronJob, its `flush-configmap.yaml`, the chart's `flush:` values, and service-platform ADR 0017 | **Deleted** (the ADR is marked superseded), in the service-platform PR that follows cutover. |
| `missingClaimErrors` and its call in `reindex.mjs` | **Deleted.** |
| `claims.mjs`, `ids.mjs` (fs allocator) | **Kept**, because fs mode is a supported single-machine mode (D1). ADR-0006 addendum and README: concurrent writers need db mode. |
| `seed-counter`'s `.ids/` source | **Kept.** It is the fs→db seeding path for any fs board that switches over, the live board included. |
| `import-lock.mjs`, `ref-claim.mjs`, `ref-allocator.mjs` | **Out of scope.** Recon A shows they aren't git ceremony. |

Updating `seam-closure.test.mjs` uses only exact name swaps or removals of deleted modules'
entries. Each carries a `// BLZ-254:` comment, and no assertion is weakened. The plan lists
each line (recon A §5).

### 5.6 Governance scripts

| Script | Re-home |
|---|---|
| `duplicate_id_check.py` | Covered by `blaze audit`'s `duplicate-status`, which works under db, plus the `ticket` primary key. Add `blaze audit --fail-on <kind,…>` so one kind can gate on its own. |
| `terminal_parent_scan.py` | New hard `blaze audit` kind, `terminal-parent-open-child`: a terminal ticket with a non-terminal child, any type pair. |
| `empty_body_scan.py` | New soft kind, `empty-body`, using the script's scaffold-only rule. |
| `config_drift_check.py` | New soft kind, `config-project-drift`: the configured `projects` versus the projects the read store holds. |
| `build_matrices.py` | New `blaze matrices [--check] [--out docs/matrices]`, built on `resolveReadStorage`, reproducing the script's files. Acceptance is a zero `git diff` against the 22 files the script generates (generator-oracle). |
| `parent_rules.mjs` | Already deleted (§3). |

All four audit additions read through `resolveReadStorage`, so they work under fs, dual
and db.

### 5.7 BLZ-670 residuals

| Residual | Decision |
|---|---|
| `.blaze/transitions.json` is git-derived and freezes under db | Under db, `loadTransitions` reads the existing `ticket_transition` view. History before cutover is imported once by `blaze db load`, which writes a `transition` event per git-derived transition, from `buildTransitions`. fs mode is unchanged. |
| `sprints.json` has no table | **Kept as a data-root config file**, like `blaze.config.json`. It's a small operator-edited registry. Ticket sprint membership is already a `ticket.sprint_id` column. It moves with config in Phase 5. |
| No Postgres pool | **Measure first.** Time 200 sequential `GET /` and 100 `POST /api/new` against `blaze-pg` (rehearsal, §7 step 3). Build a `pg.Pool` (max 5) only if the p95 of either is above 250 ms, or if connecting takes more than 20% of p95. Record the numbers on BLZ-254 either way. |

### 5.8 Residuals named in PR #194

| Residual | Decision |
|---|---|
| Groomer check-then-write window, and Postgres identity values committing out of order | **Accepted.** The groomer loop is off in the cluster (`loops.*` disabled). The id comes from `project_counter`'s row lock, not identity order. Recorded in an ADR-0038 addendum. |
| db `reserve` check-then-upsert window | **Accepted.** `reserve` runs only inside `import`, which is single-operator and refused in remote mode. The plan adds a test proving the losing writer fails loudly on the unique key and never overwrites. |
| A db groom has no undo | **Accepted.** Recovery is `ticket_event` history plus CNPG backup and point-in-time restore. |
| `user-`, `init-`, `migrate-` and `schedule-runner` lack a `BLAZE_READONLY` guard | **Fixed.** Each calls `assertWritable` before its first write, matching the existing runners. Recon C confirmed the groomer already has the guard. |

## 6. Testing

- TDD throughout. Postgres paths run against `tests/helpers/pg-scratch.mjs`, with the host
  derived from `new URL(PG).hostname`.
- **Load and verify:** a fixture corpus round-trips fs → pg → oracle with zero `valueDiffs`.
  An injected value change (`prove-test-discriminates`) makes `verify` exit 1.
- **Remote writes:** server tests check that bearer skips CSRF, cookie requires it, and
  cookie+bearer requires it. The CLI-to-server test is end to end on an ephemeral port. A
  concurrency test fires 2×50 `POST /api/new` in parallel from two processes against
  Postgres and asserts 100 distinct ids, 100 rows, and no gaps the counter didn't skip.
- **Deletion:** full suite green, `seam-closure` passes, `rg` finds no reference to a
  deleted module, and fs-mode `blaze new` still allocates.
- **Matrices:** zero diff against the 22 committed files.

## 7. Cutover runbook (rehearsed in full before the live run)

| Step | Action | Gate |
|---|---|---|
| 1 | PRs A, B and C merged; image deployed with `BLAZE_WRITE_PORT` unset; BLZ-674 published; BLZ-676 and §4 reconciliation done | CI green; the board serves as before |
| 2 | Freeze: stop every writer on every machine. Run the last `blaze publish` so `.blaze/pending/` drains on each machine (both are non-empty today). Make the pod serve the reconciled tree: change the chart's hostPath to the `v4-spine` worktree. `BLZ-305` is checked out there, so the main checkout can't switch to it. | `.blaze/pending/` empty on every machine |
| 3 | **Rehearsal** on CNPG database `blaze_rehearsal`: init, load, verify, audit; a local `blaze board` with `BLAZE_WRITE_PORT=db` on machine 1; **two-machine proof** (machine 1 and the operator's second machine each run `scripts/ops/concurrency-proof.mjs`, creating 50 tickets in remote mode against it); pool measurements | Verify exits 0; audit has 0 hard findings; 100 distinct ids, 100 rows, 0 errors |
| 4 | **Live** (operator go-ahead required): re-count the corpus; `blaze db init`; `blaze db load`; `blaze db verify`; `blaze audit` (db) | Same gates as step 3 |
| 5 | service-platform PR: set `BLAZE_WRITE_PORT=db` on the Deployment; ArgoCD sync | Smoke test: one remote `blaze new` from each machine shows on the page |
| 6 | Unfreeze. PR D (deletion) merges; the service-platform PR deletes `blaze-flush` | `kubectl get cronjob -n blaze` returns nothing |
| 7 | Drop the `blaze_rehearsal` database | — |

**Rollback:** until the first live db write in step 5, unset `BLAZE_WRITE_PORT`; the git
tree is untouched. After it, roll forward only: fix against the database and restore from
CNPG if needed. There is no db→git export path, and none will be built.

## 8. PR plan (feature-pr-bundling)

BLZ-254 is a single feature, split on purpose at workspace and rollback boundaries:

| PR | Repo | Tickets | Why separate |
|---|---|---|---|
| A — db readiness | blaze | BLZ-675, BLZ-674 (version bump; the publish follows the merge), load, verify, transitions-from-events, governance audit, matrices, readonly guards | Additive; fs and dual behaviour unchanged |
| B — remote writes | blaze | `/api/new`, bearer CSRF exemption, remote CLI, concurrency proof | Touches auth; reviewed on its own |
| C — Postgres | service-platform | CNPG cluster and db env (no write-port flip) | Different repo |
| C2 — flip and flush deletion | service-platform | `BLAZE_WRITE_PORT=db` (step 5); delete `blaze-flush` (step 6) | Runbook-timed |
| D — retire git ceremony | blaze | §5.5 deletions | High blast radius; merges only after cutover |
| — | blaze-pm (board operator, never pushed) | BLZ-676, §4 reconciliation, every board move | Data, not code |

The npm publish for BLZ-674 is outward-facing, so the operator confirms it once before it
runs.

## 9. Child tickets to file (parent BLZ-254, estimates in minutes)

| Title | Est. |
|---|---|
| Reconcile the diverged blaze-pm branches (BLZ-143 into BLZ-305) before migration | 180 |
| `blaze db load`: async Postgres corpus loader sharing load-corpus's row builder | 300 |
| `blaze db verify`: wire the zero-diff oracle as the migration gate | 180 |
| Under db, derive transitions from `ticket_event`; import git history at load | 180 |
| Re-home governance checks into `blaze audit` (`--fail-on` plus 3 kinds) | 240 |
| `blaze matrices`: replace `build_matrices.py` | 300 |
| `BLAZE_READONLY` guards on user/init/migrate/schedule runners | 60 |
| `POST /api/new`, bearer CSRF exemption, `blaze` remote mode | 420 |
| CNPG Postgres and db env for the blaze chart (service-platform) | 180 |
| Rehearse the cutover, run the two-machine proof, measure the pool | 240 |
| Retire the git ceremony (§5.5), with docs and an ADR-0006 addendum | 360 |
| Live cutover and deletion of `blaze-flush` | 120 |

## 10. Out of scope

- Phase 5 (retiring blaze-pm) is handled separately (kickoff §3b).
- BLZ-309/324 (v4 artifact migration).
- Remote `show` and `list`.
- A db→git export.
- Multi-instance Postgres.
- Any change to fs or dual behaviour beyond §5.5's deletions.
