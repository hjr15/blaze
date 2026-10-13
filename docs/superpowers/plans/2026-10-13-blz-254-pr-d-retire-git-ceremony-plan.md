# BLZ-254 PR D — retire the git ceremony — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete every git-era write mechanism the live board needed (spec §5.5): `blaze commit`, `blaze publish`, the commit lock, the pending ledgers, `commit-or-queue`/`stageFor`, `serve-commit`, and `missingClaimErrors`. Board verbs, the board server, reconcile and `blaze import` then write files (fs) or rows (db) and never commit, while fs mode keeps its single-machine allocator (`ids.mjs`, `claims.mjs`, D1).

**Architecture:** Consumers are cut first and modules deleted last, so the suite is green at every commit. Task 1 removes the two verbs, and a removed verb gets a named refusal at dispatch. Tasks 2–5 stop each caller staging: the server (its 200 body becomes `{ ok, db, … }`), the six ticket verbs and `sprint`, reconcile and the supervisor feed, and import. Task 6 deletes the now-unreferenced modules. The one primitive that survives (`acquireDirLock`/`releaseDirLock`, which `model/import-lock.mjs` needs) moves to `scripts/dir-lock.mjs`. Tasks 7 and 8 retire `commitMode` and `missingClaimErrors`. Task 9 carries the ADRs, the spec amendment and the version, and Task 10 is the conditional matrices header. `tests/model/seam-closure.test.mjs` changes only by exact name swaps or removals, each marked `// BLZ-254:`, in the same task as the code that makes it necessary.

**Tech Stack:** Node 24 ESM, `node:test`, `node:sqlite`, `pg` 8 (Postgres tests gated `PG_SKIP`), git.

**Spec:** `docs/superpowers/specs/2026-10-05-blz-254-live-board-cutover-design.md`. Read §2 (D1–D4), §5.5 (the deletion table, binding), §5.6, §6 ("Deletion"), §7 (the runbook) and §8 row D first. This plan argues from it. Recon: `/home/rnamwoh/Documents/Code/blaze/.superpowers/sdd/blz-254/recon/A-git-write-path.md` (written at `0f2f2a1`; every path and line below was re-verified at `3a0ac78`).

**Ticket:** BLZ-687 (parent BLZ-254). Branch `BLZ-687-retire-git-ceremony`, worktree `/home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-687-retire-git-ceremony`, forked from `origin/main` `3a0ac78`.

**Baseline (recorded 2026-10-13 at `3a0ac78`, Node 24.19.0, `npm test`, `BLAZE_TEST_PG_URL` unset):** `tests 5432 · suites 480 · pass 5393 · fail 0 · skipped 39 · duration 142 s`.

## MERGE GATE — read before anything else

PR D is built and reviewed now. It **merges only after cutover step 6 (§7), and only on the operator's explicit go-ahead.** Pushing the branch and opening the PR as a draft is fine. `gh pr merge` is not, whoever asks, until every line below holds and the operator has said "merge PR D":

1. **Cutover §7 steps 1–5 are done.** The live board serves and writes from Postgres (`BLAZE_WRITE_PORT=db` on the Deployment, smoke test passed). Step 6's unfreeze is the moment PR D merges.
2. **`.blaze/pending/` and `.blaze/pending-commit.jsonl` are empty on every machine** (§7 step 2's last `blaze publish` ran). After this PR, no engine can drain them.
3. **The `blaze-flush` CronJob is gone, or its deletion merges in the same window** (the C2 PR, §8). service-platform pins the blaze image to every `main` merge automatically (`chore(deploy): pin blaze to <sha>`), so the next nightly flush after PR D's image lands would run `blaze commit --all` and get the removed-verb refusal (exit 1, `CronJobLastRunFailed`). Check: `kubectl get cronjob -n blaze` lists no `blaze-flush`.
4. **No config the deployed pod loads sets `commitMode`** (Task 7 makes it a removed key, which is a hard refusal). The pod reads the service-platform ConfigMap, `deploy/apps/blaze/chart/templates/configmap.yaml`, which sets `"commitMode": "batch"` today. A refusal there crash-loops the board: the socket binds, then `cfgFor(root)` throws, which is exactly the `provider` outage that ConfigMap's own comment records. Check: `git -C <service-platform> show origin/main:deploy/apps/blaze/chart/templates/configmap.yaml | grep -c commitMode` prints `0`. blaze-pm's own `blaze.config.json` (on `BLZ-305-v4-spine`) also sets it, so the board operator deletes it there too (a data-repo step, never pushed).
5. **`@hjr15/blaze-board@0.8.0` is published from a tree that still has `blaze commit`** (BLZ-674's operator-gated publish, from `3a0ac78` or any earlier post-PR-A `main`), or the operator has decided not to publish 0.8.0. npm holds 0.7.0 as the latest today (checked 2026-10-13). ADR-0008's addendum promises 0.8.0 as the last file-based release "keeps working exactly as this page describes", and PR D's tree is 0.9.0 (Task 9), so a publish after the merge cannot accidentally ship the breaking tree as 0.8.0.
6. CI is green on the PR's head, and the whole-branch review (Task 11) is upheld.

## Global Constraints

- **Scope is spec §5.5's table, and nothing beyond it** (spec §10: "Any change to fs or dual behaviour beyond §5.5's deletions" is out of scope). **Kept:** `scripts/model/claims.mjs`, `scripts/model/ids.mjs`, `fsAllocators`, and `seed-counter.mjs`'s `.ids/` source (D1). **Out of scope:** `scripts/model/import-lock.mjs`, `ref-claim.mjs` and `ref-allocator.mjs` are not deleted. Also out of scope is the service-platform side (deleting `blaze-flush`, `flush-configmap.yaml`, the chart's `flush:` values, superseding service-platform ADR 0017), which belongs to the C2 PR. The fs groomer's own `git commit` (`scripts/loops/groomer.mjs:712-713`) and `blaze migrate`'s (`scripts/migrate-runner.mjs:77-85`) are not in §5.5's table, so they stay (see Finding 6).
- **`tests/model/seam-closure.test.mjs`: only exact name swaps or removals of deleted modules' entries, each with a `// BLZ-254:` comment, and no assertion weakened.** No new map entry, no new member, no relaxed comparison. Every line touched is listed in the owning task, and the full list is in "Seam-closure ledger" below.
- **A test file is deleted only when every test in it covers a deleted module or a deleted behaviour.** A file that also covers surviving behaviour is edited instead. Each deletion is listed with its reason in the owning task.
- **TDD where behaviour changes:** the server's 200 body, the CLI's removed-verb refusal, a verb that writes and creates no commit, reconcile's applied line, `commitMode` refused, and `blaze reindex` no longer refusing an unclaimed id. Each gets a failing test first.
- **Mode comes only from `resolveWriteMode(env)`** (or the `mode` the resolvers return). Nothing sniffs `writePort.name`.
- **Test hygiene the suite enforces:** scratch dirs via `mkdtempSync(join(tmpdir(), "<literal-prefix>-"))` with cleanup in `t.after`/`finally`. No `rmSync` reached only after an assertion (the `temp-cleanup-guard` ratchet). A spawned process gets an env with `BLAZE_WRITE_PORT`/`BLAZE_READONLY`/`BLAZE_REMOTE_URL`/`BLAZE_TOKEN` DELETED, never set to `""`.
- **`scripts/ci/temp-cleanup-debt.json` is held to equality** by `tests/temp-cleanup-guard.test.mjs`. Every task that deletes or edits a test file regenerates it with `node scripts/ci/temp-cleanup-guard.mjs --write` and checks `git diff scripts/ci/temp-cleanup-debt.json` shows **only removed lines or lowered counts**. A raised count is a new leak and is fixed in the test, not recorded.
- **Commits:** one per task (two where a task says so), subject `BLZ-687: …`. Stage with an explicit pathspec (`git add <paths>`; `git rm` for deletions), never `git add -A`. **No `Co-Authored-By` or `Signed-off-by` trailer** (hjr15/blaze hygiene CI). No `/home/` path or `*.howman.link` hostname in an added non-Markdown line. Never run `git config`. Never push from a task.
- **Every task ends:** the task's named tests pass; `npm test` is green (fail 0); `git status --short` prints nothing; and `rg -n '<the task's deleted names>' scripts tests` prints only what the task says may remain.
- **Environment for every command** (`npm ci --ignore-scripts` once if `node_modules/` is absent):
  ```bash
  cd /home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-687-retire-git-ceremony
  export PATH=/home/rnamwoh/.local/node24/bin:$PATH
  ```
  Postgres-backed tests are not needed by any task here. The two db-mode server tests this plan edits (`tests/serve-db-mode.test.mjs`, `tests/serve-api-new.test.mjs`) run on SQLite.

## Findings that refine the spec (decided here, from the code at `3a0ac78`)

1. **`commit-lock.mjs` cannot be deleted whole. Its mechanism half moves to `scripts/dir-lock.mjs`.** `scripts/model/import-lock.mjs:38` imports `acquireDirLock`/`releaseDirLock` from it. import-lock is out of scope (§5.5, last row) and guards `blaze import --apply` in every mode. The commit lock's *policy* (`acquireLock`, `releaseLock`, `lockPath`, `.blaze/commit.lock/`) is deleted. The *mechanism* (atomic `mkdirSync` + `owner.json` + dead-PID theft, BLZ-640) is renamed to `scripts/dir-lock.mjs` with `git mv`, so its history follows, and its two exports are unchanged. In seam-closure this is the name swap `commit-lock.mjs` → `dir-lock.mjs` plus removal of the deleted members (Task 6).
2. **Four more modules die with §5.5's, because their only callers are deleted:** `scripts/branch-guard.mjs` (INF-673's flush-branch check: callers `commit-or-queue.mjs`, `commit-runner.mjs`), `scripts/commit-summary.mjs` (the `blaze commit` subject and `OP_LABEL`: callers `commit-or-queue.mjs`, `commit-runner.mjs`), `scripts/views/write-outcome.mjs` (the page's sentence about `committed`/`queued`, which the server no longer sends), and `docs/operations/queue-store-migration.md` + `migrate-queue-store.sh` (the operator procedure for the pending store). `scripts/reconcile-commit-report.mjs` is **replaced** by `scripts/reconcile-apply-report.mjs`: the classifier goes, and one function remains, the line `reconcile --apply` prints. None of these is in seam-closure's allowlists, so none needs a seam edit.
3. **"The board never commits" (§5.5, row 5) reaches four callers the table does not name:**
   - **reconcile's own commit block** (`reconcile.mjs:2457-2522`). `reconcile()` loses its `commit` and `stage` parameters and its `committed`/`commitOutcome`/`commitError` result fields. `pushed: false` stays, because `tests/reconcile-pertype.test.mjs` pins the "reconcile never pushes" contract.
   - **the supervisor's feed** (`supervisor.mjs:325-372`). Its `locked`/`failed`/`queued` events had nothing left to report.
   - **import's staging** (§5.4 of `docs/design/csv-import-and-export.md`). `applyImport`, `runImport`, `runMappedImport` and `runRepair` lose `stage`/`commitMode` and the `staged`/`commit` result fields. Exit 4 keeps its meaning ("the board changed and the run did not finish cleanly") for write failures only.
   - **`blaze sprint`'s registry commit.**

   The spec's own sentence, "the import receipt and map are written as files and not committed", is what Task 5 implements.
4. **The removed verbs get a named refusal, not the unknown-command fallback.** For an unknown command `cli.mjs` prints the usage listing to **stdout** and exits 1 with no sentence (`cli.mjs:131`). Two callers would meet that silently: the nightly `blaze-flush` Job (`blaze commit --all`, until C2 deletes it) and every agent session whose instructions still say "run `blaze commit`" or "run `blaze publish`" (blaze-pm's AGENTS.md, other repos' skills). A usage dump reads as "you typed it wrong" and invites a retry. So `cli.mjs` gains `REMOVED_COMMANDS`, the same shape as config's `REMOVED_KEYS` (BLZ-298). The refusal goes to stderr, exits 1, and says what to do instead:
   ```
   blaze: `commit` was removed in 0.9.0 (BLZ-254) — the board no longer commits. In fs mode, version the board's files yourself with git; for more than one writer, use db mode (BLAZE_WRITE_PORT=db).
   ```
   It applies before `--help`, before the read-only gate and before remote mode, so `blaze commit --help`, `BLAZE_READONLY=1 blaze commit` and a remote-mode `blaze publish` all get the same sentence. A removed verb never appears in the usage listing.
5. **`commitMode` becomes a removed config key, with `SCHEMA_VERSION` 2 → 3** (Task 7). Nothing reads it after Task 3. BLZ-298's rule (`schema-version.mjs:20-28`) is that a key nothing reads is a hard error rather than a silent drop, and that removal bumped `SCHEMA_VERSION` (docs/schema-versioning.md, "Version 2 shipped with its migration path"). `BLAZE_COMMIT_MODE` is refused the same way. **This is what makes merge-gate line 4 load-bearing** (open question 2 offers the alternative).
6. **The fs groomer and `blaze migrate` still commit.** `scripts/loops/groomer.mjs:712-713` commits a groom in fs mode, behind BLZ-347's containment (a db groom, `groomOnceDb`, never does). `scripts/migrate-runner.mjs:77-85` commits a one-shot Jira import. Neither is in §5.5's table, Recon A §7 missed the groomer, and spec §10 puts fs behaviour beyond the table out of scope. Both stay, and the docs say so rather than claim "Blaze never commits" (open question 3).
7. **`missingClaimErrors` deletion is a behaviour change in fs mode, and that is the spec's decision (§3, §5.5).** `blaze reindex` no longer refuses an id above a project's `.cutover` that has no `.ids/` claim (BLZ-136's check). Duplicate ids still block (`idx.errors`). Under D1 a single-machine fs board has no second writer whose claim could be missing, and the live board is db (where the check was already skipped, `reindex.mjs:85`).
8. **The board server's 503 "commit lock held" response is gone.** Nothing takes a lock on the write path any more (Task 2).
9. **Spec conflicts, amended in Task 9:**
   - §5.1 names "a scheduled `Backup` (daily, retained 14 days)". The operator replaced it on 2026-10-11 with a daily `pg_dump --format=custom` CronJob (`blaze-pg-backup`) to a host directory, 14 days kept (service-platform ADR-0024, merged in hjr15/service-platform#112).
   - §5.8 ("CNPG backup and point-in-time restore") and §7's rollback ("restore from CNPG if needed") both assume CNPG's backups. A `pg_dump` gives restore-to-last-dump, not point-in-time.
   - §5.5 does not name `commitMode` or the four dependent modules (Findings 2, 5).

   All three are recorded as a dated amendment.
10. **The matrices header is conditional (Task 10).** `blaze matrices` writes "Regenerate with `python3 scripts/build_matrices.py`" because it is byte-compatible with that script (PR A, Finding 15). The script is still in blaze-pm (`scripts/build_matrices.py` on `BLZ-305-v4-spine`, checked 2026-10-13), and no engine PR can retire it. Retiring it is **a blaze-pm data-repo step the board operator does after cutover** (delete the script and its test, regenerate the 22 matrix files with `blaze matrices`). The engine's header change is planned conditional on that step having happened.

## Review Focus

1. **An agent, script or the flush Job runs `blaze commit` / `blaze publish` (any flags, `--help`, under `BLAZE_READONLY`, in remote mode)** → one stderr sentence naming the removal and the replacement, exit 1, nothing touched. Pinned in Task 1 (`tests/cli-removed-commands.test.mjs`, all five spellings).
2. **A browser click on the dashboard after the upgrade** → the 200 body is exactly `{ ok: true, db: <bool>, …extra }` with no `committed`/`queued`, the file (fs) or row (db) changes, `HEAD` does not move, and the page shows no git sentence. Pinned in Task 2 (`POST /api/<verb> writes the file and creates no commit`, ×5 routes; `serve-db-mode`'s exact body).
3. **An fs board in a git repo, driven by every CLI verb and `reconcile --apply`** → the files change, nothing is staged, `HEAD` is unmoved, no output line mentions a commit or a queue, and `blaze new` still allocates through the claim ledger (n, then n+1, `.ids/<n>` written). Pinned in Task 3 (`tests/verbs-make-no-commit.test.mjs`) and Task 4 (the change-report oracle's `HEAD unchanged` clause per apply mode).
4. **A board whose config (or environment) still says `commitMode`** → loading it refuses with the removed-key message naming `commitMode` and what to do. It never silently ignores it. Pinned in Task 7, which covers the file key, the null spelling and `BLAZE_COMMIT_MODE`.
5. **`blaze import --apply` on a git-backed board** → tickets (or rows), receipt and source-id map are written. Nothing is staged, `HEAD` is unmoved, exit 0, and the trailer names the receipt and claims no commit. Pinned in Task 5 (`import --apply stages nothing`).

---

## File Structure

| File | Task | Change |
|---|---|---|
| `scripts/cli.mjs` | 1 | `commit`/`publish` out of `SUBCOMMANDS`; `REMOVED_COMMANDS` refusal; `SCHEMA_PREFLIGHT_EXEMPT` loses `commit` |
| `scripts/commit-runner.mjs`, `scripts/publish-runner.mjs` | 1 | **deleted** |
| `scripts/serve.mjs` | 2 | no staging; 200 body `{ ok, db, … }`; no 503 lock arm |
| `scripts/views/write-outcome.mjs` | 2 | **deleted**; `scripts/views/page.mjs` stops injecting it |
| `scripts/{new,move,edit,link,log,resolve,sprint}-runner.mjs` | 3 | no staging, no commit suffix |
| `scripts/reconcile.mjs`, `scripts/supervisor.mjs` | 4 | no commit block; result fields; applied line; feed |
| `scripts/reconcile-commit-report.mjs` → `scripts/reconcile-apply-report.mjs` | 4 | `git mv`; only `appliedLine` remains |
| `scripts/model/import-apply.mjs`, `scripts/model/import-mapping.mjs`, `scripts/import-runner.mjs` | 5 | no staging |
| `scripts/commit-or-queue.mjs`, `scripts/serve-commit.mjs`, `scripts/pending-ledger.mjs`, `scripts/commit-summary.mjs`, `scripts/branch-guard.mjs` | 6 | **deleted** |
| `scripts/commit-lock.mjs` → `scripts/dir-lock.mjs` | 6 | `git mv`; policy half deleted |
| `scripts/model/import-lock.mjs`, `scripts/readonly.mjs` | 6 | import path; comments |
| `scripts/config.mjs`, `scripts/model/schema-version.mjs` | 7 | `commitMode` removed key; `BLAZE_COMMIT_MODE` refused; `SCHEMA_VERSION` 3 |
| `scripts/model/index.mjs`, `scripts/reindex.mjs` | 8 | `missingClaimErrors` and its call deleted |
| `tests/model/seam-closure.test.mjs` | 2–6 | name swaps/removals only (ledger below) |
| `package.json`, `package-lock.json`, `tests/package.test.mjs` | 9 | 0.9.0 |
| ADR-0006 (addendum), ADR-0008 (addendum), ADR-0032/0033/0035 (superseded), the spec (amendment), README, AGENTS.md, `docs/guide/*`, `docs/architecture.md`, `docs/diagrams/architecture.md`, `docs/design/csv-import-and-export.md`, `docs/schema-versioning.md`, `docs/schema-customization.md` | 1–9 | docs, in the task that changes the behaviour, plus Task 9's sweep |
| `scripts/model/matrices.mjs`, `tests/fixtures/matrices-board/docs/matrices/*.md` | 10 | conditional header |

## Seam-closure ledger (every line of `tests/model/seam-closure.test.mjs` this PR touches, at `3a0ac78`)

Each edit carries `// BLZ-254:` on the line above it, or as a trailing comment when the entry is one line. **No other line of the file changes.**

| Line(s) | Today | After | Kind | Task |
|---|---|---|---|---|
| 94 | `"model/ids.mjs", "model/claims.mjs",  // the allocator, deleted at Phase 2` | entry unchanged; trailing comment → `// the fs allocator — kept, BLZ-254 D1` | comment correction only (the claim it made is now false) | 6 |
| 99 | `"pending-ledger.mjs", "commit-lock.mjs", "reindex.mjs", "supervisor.mjs",` | `"dir-lock.mjs", "reindex.mjs", "supervisor.mjs",  // BLZ-254: pending-ledger.mjs deleted; commit-lock.mjs → dir-lock.mjs` | removal + name swap | 6 |
| 875-879 | `["pending-ledger.mjs", { writes: [...], … }]` and its comment line 875 | deleted, replaced by `// BLZ-254: pending-ledger.mjs deleted (spec §5.5).` | removal | 6 |
| 880-887 | `["commit-lock.mjs", { writes: ["acquireLock", "releaseLock", "acquireDirLock", "releaseDirLock"], sanctioned: [], inert: ["lockPath"] }]` | `["dir-lock.mjs", { writes: ["acquireDirLock", "releaseDirLock"], sanctioned: [], inert: [] }]` with the comment block kept and `// BLZ-254: commit-lock.mjs → dir-lock.mjs; the commit-lock policy (acquireLock, releaseLock, lockPath) is deleted.` added | name swap + removal of deleted members | 6 |
| 956 | `["commit-runner.mjs", { writes: [], sanctioned: [], inert: [] }],   // a CLI verb, no exports` | deleted, replaced by `// BLZ-254: commit-runner.mjs (blaze commit) deleted.` | removal | 1 |
| 960-963 | `commit-or-queue.mjs` and `serve-commit.mjs` WRITE_MAP entries (+ the BLZ-670 comment on 960) | deleted, replaced by `// BLZ-254: commit-or-queue.mjs and serve-commit.mjs deleted (spec §5.5).` | removal | 6 |
| 1952 | `["pending-ledger.mjs", "*"], ["commit-lock.mjs", "*"],` | `["dir-lock.mjs", "*"],  // BLZ-254: pending-ledger.mjs deleted; commit-lock.mjs → dir-lock.mjs` | removal + name swap | 6 |
| 2030-2032 | `["reconcile.mjs", ["appendRegularFileSync", "commitOrQueue", "fsStorage", "resolvePorts", "stageFor"]]` | `["reconcile.mjs", ["appendRegularFileSync", "fsStorage", "resolvePorts"]],  // BLZ-254: commitOrQueue/stageFor deleted` (the BLZ-670 comment's second sentence, "`commitOrQueue` stays as reconcile()'s default stage", is deleted with them) | removal of deleted members | 4 |
| 2040-2046 | the `commit-runner`/`commit-or-queue`/`serve-commit` sentences of the comment, and the three WRITE_SITES entries 2044-2046 | the three entries deleted. The comment's second paragraph ("`blaze commit` owns the commit lock … the same lock.") is replaced by `// BLZ-254: commit-runner.mjs, commit-or-queue.mjs and serve-commit.mjs deleted (spec §5.5).` | removal | 1 (2044 and its sentence), 6 (2045-2046) |
| 2051-2053 | `serve.mjs` WRITE_SITES `… "addUser", "stageFor", "loadIdentity", …` | `"stageFor"` removed; the BLZ-670 comment gains `// BLZ-254: stageFor deleted — the server stages nothing.` | removal of a deleted member | 2 |
| 2062 | `["sprint-runner.mjs", ["saveSprints", "commitOrQueue"]]` | `["sprint-runner.mjs", ["saveSprints"]],  // BLZ-254: commitOrQueue deleted` | removal | 3 |
| 2083-2088 | six runners, each `["stageFor", "resolvePorts"]` (new-runner `["applyNew", "stageFor", "resolvePorts"]`) | `"stageFor"` removed from each; `// BLZ-254: stageFor deleted — the verbs stage nothing.` above the six | removal | 3 |
| 2107-2108 | `["model/import-apply.mjs", ["fsAllocators", "commitOrQueue", …]]` | `"commitOrQueue"` removed; `// BLZ-254` trailing | removal | 5 |
| 2121-2122 | `["model/import-mapping.mjs", [… "commitOrQueue", "applyImport", "pruneReceipts"]]` | `"commitOrQueue"` removed; `// BLZ-254` trailing | removal | 5 |
| 2129-2134 | import-lock's comment "through `commit-lock.mjs`'s primitive" | `commit-lock.mjs` → `dir-lock.mjs` in the comment, `// BLZ-254: renamed` | name swap (comment) | 6 |
| 2142-2143 | `["import-runner.mjs", ["resolvePorts", "stageFor", "runImport", …]]` | `"stageFor"` removed; `// BLZ-254` above | removal | 5 |
| 2147-2149 | `["supervisor.mjs", [… "resolvePorts", "stageFor"]]` | `"stageFor"` removed; `// BLZ-254` above | removal | 4 |
| 2530 | `["pending-ledger.mjs", "{ appendEntry }", "appendEntry"],` | deleted; `// BLZ-254: pending-ledger.mjs deleted` | removal | 6 |
| 2531 | `["commit-lock.mjs", "{ acquireLock }", "acquireLock"],` | `["dir-lock.mjs", "{ acquireDirLock }", "acquireDirLock"],  // BLZ-254: commit-lock.mjs → dir-lock.mjs` | name swap (the module and its surviving member) | 6 |
| 2567 | `["pending-ledger.mjs", "{ readForDrain, listQueues }"],` | deleted; `// BLZ-254: pending-ledger.mjs deleted` | removal | 6 |

Line 273's prose (`appendEntry`, `acquireLock` named as round-5 examples) is a historical record of a past review and is **not** edited. Line numbers shift as earlier tasks land. Each task finds its entries by the quoted text, not the number.

Why none of this weakens the guard:
- The surviving allowlist entries are unchanged.
- The dead-entry checks ("an exemption nobody needs", the WRITE_SITES reachability walk) are what *force* each removal: a stale entry fails them.
- The fixture swap at 2531 still proves that a write member of an allowlisted lock module is an offence in a consumer.
- The two removed fixtures named a module that no longer exists, so they can prove nothing.

---
