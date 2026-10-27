# Adversarial review: BLZ-703 Phase 5 Plan A (G0, E1, E2)

- **Plan:** `docs/superpowers/plans/2026-10-22-blz-703-phase5-plan-a.md` (branch `BLZ-703-plan-a`, HEAD `d97b91f`)
- **Spec:** `docs/superpowers/specs/2026-10-22-phase5-retire-blaze-pm-design.md`
- **Date:** 2026-10-22
- **Method:** I applied the plan literally on scratch copies, the way an implementer subagent would. I used detached worktrees of `d97b91f` and of claude-config `origin/main` (`92209f3`), with Node 24.19.0, `npm ci --ignore-scripts`, and a throwaway `postgres:17-alpine` on `127.0.0.1:5544`.
  - **Built and run:** Task 0 (G0) in full, and Tasks 1–5 of E1 in full: code, the plan's tests, the seam-closure ledger and the debt step.
  - **Checked by reading only:** Task 6 (only the version bump was run), Task 7 (I ran an equivalent rehearsal), and E2 (Tasks 8–12), against the live code.
  - **Suite runs:** I ran `npm test` with and without `BLAZE_TEST_PG_URL` after Tasks 1, 3, 4 and 5.
  - **Live cluster:** read-only `kubectl get` on `k3d-service-platform` only (the deploy, the ConfigMap and the CNPG cluster spec). I read no secret values.
  - **Cleanup:** all scratch worktrees, the container and the scratch directories have been removed.

## Verdict: **NEEDS-FIXES**

The design holds up under execution. The core flows behave as the plan says:
- A pre-E1 v5 database still serves unchanged on the E1 code.
- The v5→v6 migrate is atomic and verified.
- Copied tokens authenticate.
- An old engine refuses v6.
- The seam-closure ledger is exactly right for Tasks 3–5.

But four steps, followed literally, leave the suite red or fail their own tests. Two gaps also deserve fixing in the plan before execution: the split identity source, and a migrate that silently drops identity. There are no Critical findings.

## Evidence that held

| Check | Result |
|---|---|
| Baseline at `2ecae26`, no PG / PG | 5178 tests, pass 5139, skip 39 / 5252 tests, pass 5251, skip 1. Matches the plan exactly. |
| `makeV5` vs a real database created by the **pre-E1 engine** (`db init` + `db load` + `user add` on `2ecae26`) | `pg_dump -s` of both are identical apart from the restrict nonce, so `makeV5` is a faithful fixture. |
| **Deploy safety:** E1's `serve.mjs` against a pre-E1 v5 database with the pre-E1 `identity.db`, `BLAZE_WRITE_PORT=db`, `HOST=0.0.0.0` | No token: 401. The old token: 200. `/view/gantt?sprint=S2` renders from `sprints.json`. It serves exactly as before. |
| Live pod (read-only `get`) | Image runs `node scripts/serve.mjs` with `BLAZE_WRITE_PORT=db`. The ConfigMap has `database.driver: "postgres"` and `views.live: false`. G-engine therefore cannot trip in the pod or in `kubectl exec` (which inherits the env). The CNPG cluster is `localeCollate: C`. |
| Migrate on the real v5 database | Malformed `--sprints-from` gives exit 1 with the stamp still 5. The real run gives v5→v6, identity `app_user 1 · … · user_session 0 (row-for-row verified)`, and sprints `2 sprint(s), active S2 (verified)`. A second plain run gives "already current". |
| After migrate | E1 `serve.mjs`: no token 401, the **copied** token 200, gantt S2 from Postgres with no `sprints.json`. Pre-E1 engine: `rollup` fails "schema version 6 is newer … (supported: 5..5)". |
| Postgres killed under a running v6 server | No token: 401. Token: 503 (fails closed). The process survives, because of the pool `error` listener. |
| Atomicity | Injected step failure leaves stamp 5, no `app_user` and no `authoritative`. A one-byte `token_hash` change aborts the whole migration, and the message names the table, id and column, never a value. A tampered sprint aborts with stamp 5. |
| Authoritative refusals | `load --replace` exits 1 with the ticket count unchanged. A non-authoritative `--replace` leaves `app_user` and `sprint` untouched. The `older` text branches correctly. |
| `setupInFlight` proof | The plan's concurrent-setup test passes. With the guard disabled it fails, so it discriminates. |
| G-engine regression injection | With `fsWriteRefusal → null`, 21 of 24 tests go red. |
| Seam-closure ledger | Tasks 3, 4 and 5 produced exactly the offences the ledger predicts, and the ledger rows turn the guard green. Task 1 needs no row. `user-admin.mjs` needs no row change. |
| Debt step | Works as written. It stayed `375 sites across 54 files` throughout. |
| G0 | 16 tests: red before the hook, `OK` after. Every claude-kit unit suite passes, and `export-public.sh --dry-run` exits 0. |

## Critical

None.

## Important

### I1. Task 1's algorithm takes the lock before it can know `blaze_meta` exists, so its own "empty" test fails
- **Evidence.** Step 1 (`LOCK TABLE blaze_meta IN EXCLUSIVE MODE`) runs before the facts are read. On an empty database the plan's test `newer, unstamped and empty databases are refused by name` then fails with the raw `error: relation "blaze_meta" does not exist`, not `/blaze db init/`. This is a defect in the plan's ordering, not in the implementation.
- **Fix.**
  1. `BEGIN`.
  2. Read the facts (`checkDbSchema(exec, { dialect: "postgres", min: 1 })`, so that the plan's own `MIGRATE_FROM` branch, not the `older` message, judges a low stamp; see M1).
  3. If the state is empty or unstamped, throw the named error.
  4. Otherwise `LOCK`, then **re-read** the facts under the lock, so that a concurrent migrate that committed first is seen as v6.

### I2. Task 1 misses a Postgres-only `5` assertion, so the suite is red with PG
- **Evidence.** `tests/model/config-install.test.mjs:211`, `assert.equal(Number(v), 5)`, sits inside the PG-gated `BLZ-377: Postgres installs the same namespace…` block. The Files list names only `:50-60`. It fails only when `BLAZE_TEST_PG_URL` is set: `6 !== 5`.
- **Fix.** Add `:208-211` to Task 1's Modify list, as `assert.equal(Number(v), DB_SCHEMA_VERSION)`. Update its comment.

### I3. `sprint_registry`'s `CHECK (id = 1)` breaks the ADR-0014 singleton inventory guard
- **Evidence.** `tests/adr-0014-singletons.test.mjs` fails with `these modules declare a singleton the ADR-0014 inventory does not read: scripts/model/sprint-store.mjs`, with and without PG.
  - It cannot be fixed by just adding the module. The guard's `"both drivers agree on the singleton inventory"` test asserts that the SQLite and Postgres dialects declare the **same** singletons.
  - `ADR-0014 lists exactly …` derives its list from the SQLite dialect only.
  - A Postgres-only singleton (plan Finding 3) contradicts both. The plan never mentions ADR-0014.
- **Fix.** Pick one and write it into Task 1 (DDL) and Task 6 (docs):
  - (a) Give `sprintDdl(dialect)` a dialect parameter. Add `sprint-store.mjs` to the guard's `DDL` map with an explicit, documented Postgres-only exemption in the "both drivers agree" test. Add a `sprint_registry` row, with a `file:line` citation, to ADR-0014's inventory table, plus a sentence on why it is Postgres-only.
  - (b) Drop the singleton and key `sprint_registry` by `key text PRIMARY KEY CHECK (key = 'board')`. That is a spec D3 change, so it needs a ruling.

### I4. Split identity: at v6, `user add` writes Postgres, but `startServer`'s default and `blaze start` still read SQLite. The suite is red with PG.
- **Evidence.** After Task 3, `tests/concurrency-proof.test.mjs` "2 processes × 50 parallel POST /api/new on Postgres" fails with `403 bad csrf token`. The sequence:
  1. Its `addUser` (db env, postgres driver, and a v6 database from `db init`) now writes Postgres.
  2. `startServer({…})` with no `identity` loads SQLite and gets `absent`, so `store === null`.
  3. With a null store, CSRF is required and the bearer exemption is gone.

  The plan's Step 5 says the suite is green with PG, and it is not.
- **The same split in production.** `supervisor.mjs:232`: `blaze start` on a db-mode Postgres board at v6 reads `identity.db`. Users added with `blaze user add` (which now go to Postgres) are invisible to it, so the board runs **unauthenticated on loopback** while the operator believes auth is on. Finding 11 kept the supervisor on SQLite, and that was safe only while `user add` also wrote SQLite.
- **Fix.**
  - (a) Name `tests/concurrency-proof.test.mjs` in Task 3. Its `serve()` passes `identity: await resolveIdentity({ dataRoot: root })` and closes it.
  - (b) In Task 3, make `createApp`, and `startServer` when no `identity` is passed, **refuse** on a db-mode Postgres board at v6 ("identity lives in Postgres; start through `serve.mjs`/`blaze board`"). Do not serve with SQLite there. Add a test. Then the follow-up ticket for the supervisor is safe to defer.

### I5. `blaze db migrate` without `--identity-from` silently strands every credential
- **Evidence.** On the pre-E1 rehearsal database, a plain `blaze db migrate` succeeds (exit 0, "authoritative yes") while `<dataRoot>/.blaze/identity.db` holds the live roster.
  - On the next restart `resolveIdentity` reads the empty Postgres tables. On `0.0.0.0` the board drops into first-run setup mode, and every token and session stops working.
  - It is recoverable: a re-run with `--identity-from` works while `app_user` is empty. Recovery depends on someone noticing before anyone completes setup.
  - The same applies to `sprints.json` and `--sprints-from`: the gantt silently goes empty. Spec A1 is "no user lost".
- **Fix.** In `migrateCmd`:
  - if `identityDbPath(dataRoot)` exists and the database's `app_user` is empty, **refuse** without `--identity-from`. Print a message naming the file, or accept an explicit `--no-identity` to proceed.
  - do the same for `sprints.json` with `--sprints-from` and `--no-sprints`.

  Add both refusals to Task 2's and Task 4's tests, and to Task 7's rehearsal.

### I6. G0 is not active until someone runs `install.sh`, and nothing in the plan does
- **Evidence.**
  - `~/.claude/hooks/*` are symlinks into `~/.local/share/claude-config/hooks/`, refreshed by `scripts/install.sh` (there is no root `install.sh`).
  - The "PostToolUse auto-deploy" fires only when a session on this machine *edits* `global/settings.json`. A GitHub merge does not trigger it.
  - The plan's merge gate is only "claude-kit CI is green", yet G0's stated purpose is "**First.** It closes today's split-brain window."
- **Fix.** Add a post-merge step for the orchestrator:
  1. `git -C ~/Documents/Code/claude-config pull --ff-only && bash scripts/install.sh`.
  2. `bash scripts/install.sh --check` → exit 0.
  3. `ls -l ~/.claude/hooks/blaze-pm-write-guard.sh`.
  4. A live probe: a `blaze new` from a blaze-pm cwd is denied.

  Fix the wording "the next `install.sh` run" to `scripts/install.sh`.

### I7. G0's command-position regex misses common agent spellings
- **Evidence.** The hook was built exactly per rules 1–4 and probed against blaze-pm's real path. All of these are **allowed**:
  - a newline-separated script (`cd x⏎blaze new …`); bash `[[ =~ ]]` `^` does not match after `\n`, and agents routinely send multi-line commands;
  - `./node_modules/.bin/blaze new`;
  - `node --no-warnings …/cli.mjs new`;
  - `env X=1 blaze new`;
  - `time blaze new`;
  - `npx --yes blaze new`;
  - `bash -c "blaze new"`.

  The interim guard's job is exactly the agent case.
- **Fix.**
  - Split the command on newlines too: use `[;&|(\n]` in both regexes, or loop over `cmd` lines.
  - Allow an optional path prefix and `env`/`time`/`exec` prefixes: `(([^[:space:]]*/)?blaze|…)`, `((env|time|exec|nohup)[[:space:]]+)*`.
  - Allow `npx` flags.
  - Add one test per spelling. A `bash -c` gap can be accepted and stated in the header.

## Minor

- **M1. Which judge to call is unstated.** Calling `checkDbSchema` with the default `min` would turn a below-MIN stamp into the authoritative `older` message, which tells the operator to "run blaze db migrate", which is circular. State `min: 1` (or read the raw facts) explicitly.
- **M2. Task 5's "explicit fs writes the file" test needs a git repository.** It fails as written: `dbBoard()` is not a git work tree, so `blaze new` in fs mode throws `not inside a git worktree — cannot reserve ticket ids safely`. Add `git init -q <dataRoot>` to the fixture.
- **M3. Task 5's per-verb loop can hang during regression injection.** With the guard disabled, `run(["start"])` runs the supervisor until the 120 s test timeout. Pass `timeout: 30000` to `spawnSync`.
- **M4. Direct runners outside `resolvePorts` bypass G-engine.**
  - `schedule-runner.mjs` (`migrate-dates --write` rewrites tickets) and `migrate-runner.mjs` bypass G-engine when invoked directly. Only the `cli.mjs` gate covers them.
  - `reindex.mjs` and `matrices-runner.mjs` do too, but they write derived files only.
  - Either state this as a known gap or add `assertFsWriteAllowed` to the two ticket writers.
- **M5. `blaze reindex` in db mode at v6 warns falsely on every sprint-tagged ticket.** It prints `warning: ENG-1: sprint 'S2' not in registry` (reproduced), because `buildIndex` falls back to the absent `sprints.json`. `validateSprintFields` also still says "(sprints.json)" when the registry is the database.
  - Prefetch through `readStorage.sprintRegistry` in `reindex.mjs` (and `rollup` if it lints).
  - Make the message source-neutral.
- **M6. Doubled prefix in migrate errors.** The output reads `blaze db migrate: blaze: <path>: sprints is not an array`, because `parseSprintRegistry`'s and `readIdentityRows`' errors already begin `blaze:`. Strip one.
- **M7. Task 7 step 2.4 cannot show the `newer` refusal.** `blaze db status` reads only the SQLite shadow ("No shadow database"), so it never meets the Postgres stamp. Use `BLAZE_WRITE_PORT=db blaze rollup` (verified: refused as newer), or start the old `serve.mjs` and request `/api/hash`.
- **M8. The identity verify compares rows positionally after `ORDER BY pk`.**
  - Postgres sorts by the database collation. SQLite sorts bytewise.
  - The live cluster is `C` and the test image's `en_US.utf8` (musl) sorts like `C`, so nothing fails today.
  - On a glibc `en_US` database, `user_identity` (subject = email) could mis-align and abort a correct copy. That failure is safe, but it would block the cutover.
  - Fix: compare by a primary-key-keyed map, or use `ORDER BY … COLLATE "C"`.
- **M9. No conformance case for the new reader method.** `sprintRegistry` has no `tests/model/driver-conformance.test.mjs` case, although ADR-0009 says "the names are the contract". Add one per driver.
- **M10. Unused `loadSprints` imports.** Task 4 leaves `loadSprints` imports in `new.mjs`, `edit.mjs`, `groomer.mjs` and `import-apply.mjs`. Remove them.
- **M11. `BLAZE_TOKEN_FILE` is not in the suite-isolation guard.** `tests/remote-env-guard.test.mjs` pins the preload's isolation for `BLAZE_REMOTE_URL`/`BLAZE_TOKEN` only. Task 9 should extend it to `BLAZE_TOKEN_FILE`.
- **M12. Line drift.** Task 9 cites `cli.mjs:172`, but the remote gate is at `:161`, and E1 inserts *after* it. Cite by anchor text, not line.
- **M13. Review Focus 3 overstates G-engine's reach.** It says G-engine refuses `blaze new` "in a blaze-pm checkout" on engines ≥ 0.10.0. But blaze-pm's `blaze.config.json` has **no** `database` block until G-data (D9), so until the archive only G0 protects it. Reword.
- **M14. Rule 1 also denies read sub-verbs.** G0 denies `blaze db status` and `blaze matrices --check`. That is acceptable for an interim guard, but say so in the header.
- **M15. `checkDbSchema` now costs an extra query.** It reads the `authoritative` row on every Postgres open, and the server opens per request. That adds one query per request. Accept it, or read both rows in one query.
- **M16. Task 5 should also run PG.** The plan requires the PG run for Tasks 1–4 and 7, but G-engine touches `resolveWritePort`, which the PG suites exercise. Add Task 5. It was green here.

## Spec and plan claims confirmed by execution

- Finding 4 holds. A database created by E1's `db init` is v6 and not authoritative. A re-run of migrate on v6 rewrites nothing and reports "already". A re-run with `--identity-from` after a successful copy refuses (exit 1), which the runbook should expect.
- Finding 5 holds. The pool survives a Postgres outage and fails closed.
- Finding 3 holds. The fresh SQLite stamp is 6 and the v6 tables are absent there.
- The plan predicted that some existing tests would need `BLAZE_WRITE_PORT: "fs"`. None did: the suite was green with and without PG after Task 5.

## Suite results on the scratch copy

These runs include the scratch fixes for I2, I3 and I4 and the Task 4 test literals, so they show what a corrected plan reaches.

| After | no PG | with PG |
|---|---|---|
| Task 1 (before the I2/I3 fixes) | fail 1 (ADR-0014) | fail 1 (ADR-0014) |
| Tasks 1–3 (I2, I3 fixed) | 5203 / fail 0 | 5277 / **fail 1** (I4, concurrency-proof) |
| Tasks 1–4 (I4 fixed in the test) | 5212 / fail 0 / skip 66 | 5286 / fail 0 / skip 1 |
| Tasks 1–5 | 5236 / fail 0 / skip 66 | 5310 / fail 0 / skip 1 |

---

## Round 2 (2026-10-23): re-review of `1647403`

- **Method:** the same method and limits as round 1, on fresh scratch.
  - A detached worktree of `1647403`, and claude-config `origin/main`.
  - Node 24 and a throwaway `postgres:17-alpine`.
  - Every changed task applied literally: Task 0, Tasks 1–5, and the I5 parts of Task 2.
  - Each task's named tests run, the seam-closure ledger applied as written, then the full suite with and without PG.
  - All scratch work and the container are removed.
- **Note:** a rate limit interrupted an earlier round-2 pass after Task 4. Its results matched this one: the suite was green after each of Tasks 1–4 once the N1–N3 test fixes below were applied.

### Verdict: **NEEDS-FIXES**

All of I1–I7 are fixed. But three new test-text defects leave the suite red when the plan is followed literally (N1–N3 below). Each is a one-line fix. With them fixed, the whole of E1 Tasks 1–5 is green: no PG gives tests 5250, pass 5176, fail 0, skip 74; with PG gives tests 5325, pass 5324, fail 0, skip 1.

### I1–I7

| | Status | Evidence |
|---|---|---|
| I1 | **ADDRESSED** | The facts are read before the lock and re-read under it. The empty database is refused with `blaze db init`, and the message never says "does not exist". The new test "two concurrent migrates serialise" passes: one run migrates and the other sees v6. |
| I2 | **ADDRESSED** | `config-install.test.mjs:211` now uses `DB_SCHEMA_VERSION`, and it is green with PG. |
| I3 | **ADDRESSED** | The guard stays strict, shown by two injected regressions. `sprintDdl(dialect)` declares the singleton in both dialects, and the ADR row plus the amendment keep `tests/adr-0014-singletons.test.mjs` green. Emitting the CHECK only on Postgres makes `"both drivers agree"` and `"ADR-0014 lists exactly"` fail. Deleting the ADR row makes `"lists exactly"` fail. |
| I4 | **ADDRESSED** | `blaze start` never serves unauthenticated on a v6 Postgres board. The spawned `supervisor.mjs`, run on a v6 board with a 0-byte `identity.db`, gives 401 without a token and 200 with one. With the entry block's `resolveIdentity` removed, it exits 1 with the I4 refusal and never serves. `startServer` and `createApp` with no identity throw on a db-mode Postgres board, and still start on an fs board. `concurrency-proof` is green with PG. The ledger's supervisor row (2140) is exactly what the walk demands. |
| I5 | **ADDRESSED** | `migrate` refuses without its import flags. With `.blaze/identity.db` and no flag it exits 1 and the stamp stays 5. The same holds for `sprints.json`. `--no-identity-import` and `--no-sprints-import` proceed, and `--X-from` together with `--no-X-import` is refused as contradictory. |
| I6 | **ADDRESSED** (as text) | Step 8 deploys through `scripts/install.sh`, runs `--check`, and probes the hook live. `install.sh:578` deploying only `hooks/*.sh` is confirmed, so embedding the logic in the `.sh` file is the right call. Step 8 is an orchestrator step after merge, so it was not run here. |
| I7 | **ADDRESSED** | The argv-token hook was built per the decision procedure, and its 24 tests are OK. All claude-kit unit suites pass, and `export-public --dry-run` exits 0. Probed against the real blaze-pm path, it **allows** `blaze show INF-1`, `blaze list --projects --json`, `BLAZE_REMOTE_URL=… BLAZE_TOKEN_FILE=… blaze new …`, `env BLAZE_REMOTE_URL=… blaze move …`, `blaze audit --json \| jq .` and `git commit -m "blaze new fix"`. It finds no new false positives on reads or remote mode. The remaining over-denial is `blaze new --help` (a write verb followed by `--help`); that is harmless, and is covered by the header's read-sub-verb caveat in spirit. `bash -lc '…'` stays an accepted, stated gap. |

### New findings

- **N1 (Important): M15's one-query read breaks three test fakes, so the suite is red at Task 1, with and without PG.**
  - **Evidence.** `tests/write-port-resolve.test.mjs:225` and `:271`, and `tests/read-storage-resolve.test.mjs:27`, fake every `blaze_meta` query as `{ rows: [{ value: "5" }] }`, with no `key` column. After M15 (`SELECT key, value … WHERE key IN (…)`), the facts reader finds no `schema_version`, so it judges the database `unstamped`. Seven tests fail, plus the no-leak meta-test, including "resolveWritePort opens Postgres when configured" and "a Postgres database stamped below this engine's floor is refused".
  - **Fix.** Add these files to Task 1's Modify list, with the fakes answering `[{ key: "schema_version", value: "5" }]` (and `"4"` at `:271`), then run the debt step.
- **N2 (Minor): Task 4's gantt test contradicts I4.**
  - **Evidence.** `"at v6 the gantt renders the database's sprints"` calls `startServer({ root, projectsDir, port: 0 })` with `BLAZE_WRITE_PORT=db` on a Postgres-driver board, and no identity. Task 3's `loadIdentityDefault` now refuses that by design, so the test throws "must be resolved before the server starts".
  - **Fix.** Pass `identity: await resolveIdentity({ dataRoot })`, and close it in `finally`. That is the rule Task 3 Step 5 already states for existing tests.
- **N3 (Minor): Task 4's `--sprint` test regex contradicts M5.**
  - **Evidence.** M5 changes the message to `sprint 'S9' is not in the sprint registry`, but the test still expects `/sprint 'S9' is not in the registry/`, which does not match.
  - **Fix.** Use `/sprint 'S9' is not in the sprint registry/`.
- **Note: no gap remains in the M4 runner guards.** The guards in `schedule-runner` and `migrate-runner`, and the git-backed fixture with its 30 s timeout, all work as written. Task 5's 24 tests are green. With `fsWriteRefusal` forced to return `null`, 21 tests go red, the injection run completes, and nothing hangs.
