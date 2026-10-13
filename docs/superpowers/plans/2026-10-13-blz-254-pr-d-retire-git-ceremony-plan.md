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
## Task order and routing

Consumers first and modules last, so every commit is green:

| # | Task | Implementer | Reviewer |
|---|---|---|---|
| 1 | reconcile and the supervisor feed stop committing | **opus** (two 1,000-line oracles are reworked) | opus |
| 2 | the board server stops committing; the page drops its git sentence | **opus** (security-adjacent POST handler, page golden) | opus |
| 3 | the CLI ticket verbs and `blaze sprint` stop committing | sonnet | opus |
| 4 | `blaze import` stops staging | sonnet | opus |
| 5 | `blaze commit` and `blaze publish` are removed, with a named refusal | sonnet | opus |
| 6 | delete the ceremony modules; `commit-lock.mjs` → `dir-lock.mjs` | **opus** (seam-closure) | opus |
| 7 | `commitMode` is a removed config key (`SCHEMA_VERSION` 3) | sonnet | opus |
| 8 | delete `missingClaimErrors` | sonnet | opus |
| 9 | ADR-0006/0008 addenda, superseded ADRs, the spec amendment, 0.9.0, the docs sweep | sonnet (all text is given here) | opus |
| 10 | matrices header — **conditional** on blaze-pm retiring `build_matrices.py` | sonnet | opus |
| 11 | whole-branch verification and the merge-gate record | haiku runs the read-only checks; **opus** does the whole-branch review | — |

Tasks 1–4 are independent of one another in code, but all four edit `tests/model/seam-closure.test.mjs` and two edit `tests/board-overstatement-guards.test.mjs`, so they run **sequentially**. Task 5 needs Task 1 (the oracle no longer spawns `commit-runner.mjs`). Task 6 needs 1–5. Tasks 7–10 need 6. Task 11 is last.

---

### Task 1: reconcile and the supervisor feed stop committing

**Files:**
- Rename + rewrite: `scripts/reconcile-commit-report.mjs` → `scripts/reconcile-apply-report.mjs` (`git mv`)
- Modify: `scripts/reconcile.mjs`, `scripts/supervisor.mjs`
- Modify tests: `tests/board-overstatement-oracle.test.mjs`, `tests/board-overstatement-guards.test.mjs`, `tests/reconcile-change-report-oracle.test.mjs`, `tests/reconcile-feed-truth-oracle.test.mjs`, `tests/reconcile-unfinished-pass.test.mjs`, `tests/reconcile.test.mjs`, `tests/reconcile-project-filter.test.mjs`, `tests/reconcile-pertype.test.mjs`, `tests/reconcile-db-mode.test.mjs`, `tests/model/seam-closure.test.mjs` (ledger rows 2030-2032, 2147-2149)
- Delete tests: `tests/reconcile-commit-routing.test.mjs` (every test pins how reconcile routed its commit: lock, batch queue, per-op commit, hook failure); `tests/commit-step-attribution.test.mjs` (pins `commitFile`'s `step` field as read by `commitOutcomeFrom`, both deleted)
- Docs: `docs/guide/commands.md` `## reconcile` (the `--apply` paragraph)

**Interfaces:**
- Produces: `appliedLine({ mode, movedCount, nonMovedCount }) → string` in `scripts/reconcile-apply-report.mjs`. `reconcile(opts)` takes no `commit`/`stage`/`mode`. It returns `{ ok, changes, pushed, missingRepos, scannedRepos, configuredRepos, forgeErrors, gitErrors, findings, scannedProjects, scopedTickets, dryRun }` (refusals: `+ error`; standalone: `+ standalone: true`), with no `committed`/`commitOutcome`/`commitError`.

- [ ] **Step 1: Write the failing tests.**

In `tests/reconcile-db-mode.test.mjs`, replace the import line `import { stageFor } from "../scripts/commit-or-queue.mjs";` with nothing (delete it), and replace

```js
  const r = await reconcile({ fetch: false, commit: true, dryRun: false, root: board,
    writePort, stage: stageFor("db"), mode: "db" });
```

with

```js
  const r = await reconcile({ fetch: false, dryRun: false, root: board, writePort });
```

and replace `  assert.equal(r.commitOutcome, "db");` with

```js
  // BLZ-254 (spec §5.5): reconcile never commits, so its result carries no commit outcome.
  for (const k of ["committed", "commitOutcome", "commitError"]) {
    assert.equal(Object.hasOwn(r, k), false, `reconcile's result still carries \`${k}\``);
  }
```

In `tests/reconcile.test.mjs` (the "unrelated dirty file" test, `:265-282`), replace

```js
    const applied = await reconcile({ dryRun: false, commit: true, root });
    assert.equal(applied.ok, true);
    assert.equal(applied.committed, true);

    const files = execFileSync("git", ["-C", root, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" });
    assert.doesNotMatch(files, /UNRELATED\.txt/);
    assert.match(files, /ZZZ-1-.*\.md/);
```

with

```js
    const headBefore = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const applied = await reconcile({ dryRun: false, root });
    assert.equal(applied.ok, true);
    // BLZ-254 (spec §5.5): the board never commits. The move is in the working tree, HEAD is
    // where it was, and the unrelated file is untouched beside it.
    assert.equal(Object.hasOwn(applied, "committed"), false);
    assert.equal(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), headBefore,
      "reconcile --apply must not commit");
    const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
    assert.match(dirty, /ZZZ-1-.*\.md/, "the move itself is on disk");
```

(the existing `assert.match(status, /UNRELATED\.txt/)` after it stays).

In `tests/reconcile-project-filter.test.mjs` ("AC-3: the --apply commit names only the tickets in scope", `:326-349`), rename the test to `"AC-3: an --apply run scoped to INF writes only INF's tickets"` and replace the body between `try {` and `} finally {` with

```js
      const headBefore = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const r = await reconcile({ root, dryRun: false, projects: ["INF"] });
      assert.equal(r.ok, true, r.error);
      // BLZ-254: no commit any more; the scope is read off the working tree instead.
      assert.equal(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), headBefore,
        "reconcile --apply must not commit");
      const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"],
        { encoding: "utf8" });
      assert.match(dirty, /INF/, "the run in scope wrote INF's ticket");
      assert.doesNotMatch(dirty, /OBA/,
        "a session that owns INF must not write OBA — the ticket in one line");
```

In the same file, the BLZ-470 test at `:1280-1296`: replace

```js
      const files = execFileSync("git", ["-C", root, "show", "--name-only", "--format=", "HEAD"],
        { encoding: "utf8" });
      assert.doesNotMatch(files, /projects\/OBA/, "nor committed");
```

with

```js
      const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"],
        { encoding: "utf8" });
      assert.doesNotMatch(dirty, /projects\/OBA/, "nor written");   // BLZ-254: nothing is committed
```

In `tests/reconcile-pertype.test.mjs` (`:93-130`), replace `const r = await reconcile({ fetch: false, commit: true, dryRun: false, root });` with `const r = await reconcile({ fetch: false, dryRun: false, root });`, and replace the block from `  // (2) git log: a commit really exists, …` through `"the applied run must leave the board's tree fully committed");` with

```js
  // (2) git log: BLZ-254 (spec §5.5) — an applied run makes NO commit; the move is in the
  // working tree for the operator to version.
  const commitsAfter = Number(execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"],
    { encoding: "utf8" }).trim());
  assert.equal(commitsAfter, commitsBefore, "an applied run must not commit");
  const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"],
    { encoding: "utf8" });
  assert.match(dirty, /OBA-1/, `the move must be in the working tree, status was ${JSON.stringify(dirty)}`);
```

and change the next message from `"an applied, committing run must still never report a push"` to `"an applied run must still never report a push"`. Also update the BLZ-423 comment above it: its "really committed" sentence becomes "really applied (and, since BLZ-254, made no commit)".

- [ ] **Step 2: Run them and watch them fail.**

```bash
node --test --test-timeout=120000 --import=./tests/setup/hang-watchdog.mjs tests/reconcile-db-mode.test.mjs tests/reconcile.test.mjs tests/reconcile-project-filter.test.mjs tests/reconcile-pertype.test.mjs
```

Expected: FAIL. `reconcile-db-mode` fails with "reconcile's result still carries `committed`"; `reconcile.test`, `reconcile-pertype` and the AC-3 test fail with "must not commit" (HEAD moved).

- [ ] **Step 3: Replace the report module.**

```bash
git mv scripts/reconcile-commit-report.mjs scripts/reconcile-apply-report.mjs
```

Overwrite `scripts/reconcile-apply-report.mjs` with:

```js
// scripts/reconcile-apply-report.mjs — the one line `blaze reconcile --apply` prints for the
// writes it made.
//
// BLZ-254 (spec §5.5): reconcile no longer commits. Until then its writes went through
// `commitOrQueue`, and this module (as reconcile-commit-report.mjs, BLZ-404/BLZ-422)
// classified seven commit outcomes — committed, no-op, queued, locked, failed, db, none —
// each with its own wording and exit code. The board never commits now, so there is one
// outcome per store and nothing to classify: the files changed (fs, dual), or the rows did (db).
//
// The two-quantity rule is unchanged (BLZ-401, BLZ-447). This is a WRITE-RECORD surface, so
// it says "N ticket(s) updated without a status change", never the preview's "other
// update(s)", and a quantity that is zero is not stated at all.
export function appliedLine({ mode, movedCount, nonMovedCount }) {
  const suffix = nonMovedCount
    ? `, ${nonMovedCount} ticket(s) updated without a status change`
    : "";
  if (mode === "db") return `reconcile: ${movedCount} ticket(s) moved${suffix} in the database.`;
  return `reconcile: ${movedCount} ticket(s) moved${suffix} in the board's files — `
    + "reconcile makes no git commit.";
}
```

- [ ] **Step 4: Strip the commit block from `scripts/reconcile.mjs`.**

1. Imports. Delete `import { commitOrQueue, stageFor } from "./commit-or-queue.mjs";` (`:29`), and replace `import { commitOutcomeFrom, applySummary } from "./reconcile-commit-report.mjs";` (`:31`) with `import { appliedLine } from "./reconcile-apply-report.mjs";`.
2. Signature (`:1852-1862`). Replace

   ```js
     fetch = false, commit = false, dryRun = true, root, projectsDir,
   ```

   with `  fetch = false, dryRun = true, root, projectsDir,`. Then replace the whole `// BLZ-670: \`stage\` is how this pass files its writes …` comment and its `  stage = commitOrQueue, mode,` line with:

   ```js
     // BLZ-254 (spec §5.5): `commit`, `stage` and `mode` are gone. They existed only to file this
     // pass's writes into git (BLZ-404, BLZ-670), and the board never commits now.
   ```
3. Every early `return { … }` in `reconcile()` (`:1910-2030`, eight sites). Delete the three keys `committed: false,`, `commitOutcome: "none",` and `commitError: null,` from each object, and re-wrap the line so it stays under the file's ~100-column habit. When done, `rg -n 'committed:|commitOutcome|commitError' scripts/reconcile.mjs` prints only comment lines.
4. `touched`. Delete `  const touched = [];` (`:2037`). In the write branch (`:2414-2421`), replace

   ```js
         if (d.moved) {
           const { file: dest } = await port.move(target);
           touched.push(t.file);
           if (dest !== t.file) touched.push(dest);
         } else {
           const { file } = await port.write(target);
           touched.push(file);
         }
   ```

   with

   ```js
         // BLZ-254: nothing collects the written paths any more — they were the commit's pathspec.
         if (d.moved) await port.move(target);
         else await port.write(target);
   ```
5. The commit block (`:2455-2522`). Delete from `  let committed = false;` through the closing `  }` of `if (commit && !dryRun && touched.length) { … }`, inclusive, and put in its place:

   ```js
     // BLZ-254 (spec §5.5): the commit block that stood here is deleted. Since BLZ-404 it routed
     // this pass's writes through commitOrQueue (a per-op commit, a batch-queue entry, or a lock
     // refusal) and reported which as `commitOutcome`. The board never commits now: in fs mode the
     // files changed and the operator versions them; in db mode the rows did.
   ```
6. The return (`:2552`). Replace `  return { ok: true, changes, committed, commitOutcome, commitError, pushed,` with `  return { ok: true, changes, pushed,`.
7. The CLI (`:2628-2636`). Replace

   ```js
       r = await reconcile({ fetch: fetchFlag, commit: apply, dryRun: !apply,
   ```

   with `    r = await reconcile({ fetch: fetchFlag, dryRun: !apply,`, and replace `      stage: stageFor(ports.mode), mode: ports.mode });` with `      });`. Keep the `readStorage`/`writePort` line above it, so the call becomes `…, readStorage: ports.readStorage, writePort: ports.mode === "db" ? ports.writePort : null,\n      });`.
8. The CLI's apply tail (`:2777-2799`). Replace from `  // BLZ-404 (review finding 1): the CLI's own commit block is the same code path the` to the end of the `if (apply) { … }` block with:

   ```js
     // BLZ-254: an applied run says what it wrote and where, in the write-record vocabulary
     // (BLZ-447). There is no commit outcome to report and so no non-zero exit for one.
     if (apply) console.log(appliedLine({ mode: ports.mode, movedCount, nonMovedCount }));
   ```
9. Leave the `BLZ-404 round 5` comment above `if (!r.changes.length)` as it is. Edit its last sentence to read: "… nothing about the state of the git tree, which may be dirty for reasons this pass neither caused nor can see — and, since BLZ-254, is dirty after every applied pass, because reconcile no longer commits."

- [ ] **Step 5: Strip the supervisor's commit feed (`scripts/supervisor.mjs`).**

1. Delete `import { stageFor } from "./commit-or-queue.mjs";` (`:15`).
2. In `runReconcile` (`:301-303`), replace

   ```js
         const r = await reconcile({ fetch: true, commit: true, dryRun, root, projectsDir,
           readStorage: ports.readStorage, writePort: ports.mode === "db" ? ports.writePort : null,
           stage: stageFor(ports.mode), mode: ports.mode });
   ```

   with

   ```js
         const r = await reconcile({ fetch: true, dryRun, root, projectsDir,
           readStorage: ports.readStorage, writePort: ports.mode === "db" ? ports.writePort : null });
   ```
3. Delete from the comment `// BLZ-404 (review finding 2): \`grep -n "committed" scripts/supervisor.mjs\` used to` (`:324`) through the closing `}` of `if (r.commitOutcome === "queued") { … }` (`:369`), inclusive. Keep the `BLZ-404 round 5` comment after it. In its place put:

   ```js
           // BLZ-254 (spec §5.5): the `locked`/`failed` ("DIRTY TREE") and `queued` events that stood
           // here reported reconcile's commit outcome. Reconcile no longer commits, so there is no
           // outcome to report: the per-ticket `reconcile` events above are the whole account.
   ```
4. Update the `runReconcile` docblock comment (`:285`), "the alternative here is a loop that is inert while its own config asks it to commit", to "… inert while its own config asks it to apply".

- [ ] **Step 6: Rework the two reconcile oracles and the guards file.**

**`tests/reconcile-change-report-oracle.test.mjs`.** The two `commitMode: "batch"` run modes are deleted, and every `--apply` mode now asserts "no commit" and the applied line.
1. Replace the two constants `COMMITTED_LINE_RE` and `QUEUED_LINE_RE` (`:234-235`) with:

   ```js
   // BLZ-254: the --apply line (scripts/reconcile-apply-report.mjs, fs arm). It replaced the
   // committed/queued pair when reconcile stopped committing (spec §5.5).
   const APPLIED_LINE_RE = /reconcile: (\d+) ticket\(s\) moved(?:, (\d+) ticket\(s\) updated without a status change)? in the board's files — reconcile makes no git commit\./;
   ```
2. Delete `COMMIT_SUBJECT_MOVED_RE`, `COMMIT_SUBJECT_NONMOVED_RE` and the BLZ-477 comment above them (`:236-243`). There is no commit subject left to pin.
3. In `modeBudget` (`:362-376`), replace the last two lines (the `// The commit message's two quantities …` comment through `+ (mode.commit ? (mode.queued ? 0 : 2) + SUMMARY_LINE_CLAUSES : 0);`) with:

   ```js
       // BLZ-254: an applied run makes no commit (1: HEAD unmoved), then states the two
       // quantities in its applied line (SUMMARY_LINE_CLAUSES).
       + (mode.apply ? 1 + SUMMARY_LINE_CLAUSES : 0);
   ```
4. In `modes` (`:400-422`), delete the two `commitMode: "batch"` entries and their comments, and delete the `commit: …` key from the remaining three. They become `{ label: "dry-run (unfiltered)", args: [], groundArgs: ["--apply"], apply: false, dryRunTail: true }`, `{ label: "--apply (unfiltered)", args: ["--apply"], apply: true }` and `{ label: "--apply --project ZZZ", args: ["--project", "ZZZ", "--apply"], apply: true }`.
5. Before the `spawnSync` of each mode, capture `const headBefore = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();`. Then replace the whole `if (mode.commit) { … }` block (`:517-545`) with:

   ```js
           if (mode.apply) {
             // BLZ-254 (spec §5.5): an applied run writes the files and makes NO commit.
             eq(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), headBefore,
               `${mode.label}: reconcile --apply moved HEAD — the board never commits`);
             assertSummaryLine({ label: mode.label, what: "applied line",
               re: APPLIED_LINE_RE, text: res.stdout, movedGT, nonMovedGT });
           }
   ```
6. Fix the header comment's mode list and the BLZ-439/BLZ-477 notes that name the queued modes. Say the queued modes were deleted with `commitMode` (BLZ-254).

**`tests/board-overstatement-oracle.test.mjs`.** The commit-outcome dimension goes, and consumers 3 and 4 go with it (they pinned `commitOutcomeFrom`/`applySummary` and `blaze commit`'s subject, both deleted). What remains is 9 shapes × 2 runs × 2 consumers = **36 cells**.
1. Imports: delete the `commitOutcomeFrom`/`applySummary`, `commitFile`, `commitOrQueue`, `acquireLock`/`releaseLock` and `readEntries`/`sessionId` import lines (`:96-100`). Add `import { isDeepStrictEqual } from "node:util";`.
2. Delete `const COMMIT_BIN = …` (`:146`) and the whole `applyOutcomeEnv` function and its section comment (`:430-454`).
3. Replace `const OUTCOMES = [...]` and `const CONSUMERS = [...]` (`:194-196`) with:

   ```js
   // BLZ-254 (spec §5.5): reconcile no longer commits, so the five commit outcomes this
   // dimension used to range over (committed / no-op / queued / locked / failed) are gone.
   // What still distinguishes two runs of `--apply` is whether the board has ALREADY been
   // applied: a first pass writes what it decides, a second pass on the same tree has
   // nothing left to decide (BLZ-445's reachable "nothing happened", kept).
   const RUNS = ["first-apply", "second-apply"];

   // Consumers 3 (commitOutcomeFrom + applySummary) and 4 (`blaze commit`'s subject) are
   // deleted with the modules they pinned.
   const CONSUMERS = ["dashboard-toast", "reconcile-cli"];
   ```
4. Replace `budgetFor` (`:234-276`) with:

   ```js
   function budgetFor(shape, run, consumer) {
     if (consumer === "dashboard-toast") {
       let n = 1;                                    // (2) git log: a preview never commits
       if (shape.refused) {
         n += 3;                                     // says REFUSED / not in-sync / no move count
       } else {
         n += shape.moves ? 2 : 1;                   // the move count is right, or absent
         n += shape.other ? 2 : 1;                   // ditto the non-moving count
         if (!shape.moves && !shape.other) n += 2;   // BLZ-450: which in-sync wording, and qualified?
         n += 3;                                     // CLEARED count, findings presence, forge presence
       }
       // The wording-invariant clause compares against the FIRST run's text, so it does not
       // run on that first run.
       if (run !== RUNS[0]) n += 1;
       return n;
     }
     // reconcile-cli. 1: HEAD never moves (BLZ-254) — on every cell, refused or not.
     if (shape.refused) return 1 + 3;              // + exit 1 + reason + no applied line
     let n = 1 + 2;                                // + exit 0 + BLZ-468 forge integrity
     if (run === "second-apply") return n + 2;     // the first pass wrote iff the shape changes; nothing left
     return n + (shapeChanges(shape) ? 2 : 1);     // applied line + its moved count, or "nothing to do"
   }
   ```
5. In `assertCellBudget`, rename the `outcome` parameter and messages to `run`. In the main test, replace the three dimension-size assertions and the `CELLS` loop with `RUNS` (size 2), `CONSUMERS` (size 2), `CELLS.length === 36` and the message `"the cross-product must be 9 × 2 × 2 = 36 cells"`. Rename the test to `"BLZ-426 + BLZ-422: no board surface overstates, across the cross-product"` and its sub-tests to `` `${shape.name} × ${run}` ``.
6. Consumer 1 (dashboard-toast). Delete `const teardown = applyOutcomeEnv(root, outcome);` and the `teardown();` call in its `finally`. Replace `outcome` with `run` in every message. Keep the invariant clause, with its message changed to `` `${shape.name}/${run}: the toast changed wording between two fresh boards — a preview must read identically` ``.
7. Consumer 2 (reconcile-cli). Replace everything from `const cliRoot = mkdtempSync(join(tmp, \`cli-${shape.name}-${outcome}-\`));` through the consumer's closing `} finally { cliTeardown(); }` with:

   ```js
             const cliRoot = mkdtempSync(join(tmp, `cli-${shape.name}-${run}-`));
             const cliProjects = materializeBoard(cliRoot, fixture);
             const cliCellStart = clauses;   // BLZ-452: this cell's own budget
             const headBefore = head(cliRoot);
             let firstWrote = null;
             if (run === "second-apply") {
               const snapBefore = snapshotBoard(cliProjects);
               spawnSync(process.execPath, [RECONCILE_BIN, "--apply", ...shape.cliArgs],
                 { cwd: cliRoot, encoding: "utf8", env });
               firstWrote = !isDeepStrictEqual(snapshotBoard(cliProjects), snapBefore);
             }
             const res = spawnSync(process.execPath, [RECONCILE_BIN, "--apply", ...shape.cliArgs],
               { cwd: cliRoot, encoding: "utf8", env });
             const out = `${res.stdout}\n${res.stderr}`;

             // BLZ-254 (spec §5.5): reconcile never commits — not on a first pass, not on a second,
             // not on a refusal. `git log` is the ground truth, never the CLI's own words.
             eq(head(cliRoot), headBefore,
               `${shape.name}/${run}: reconcile moved HEAD — the board never commits; output was ${JSON.stringify(out)}`);

             if (!shape.refused) {
               eq(res.status, 0, `${shape.name}/${run}: expected exit 0, got ${res.status} — output was ${JSON.stringify(out)}`);
               // BLZ-468: the run's own forge account against the fixture's declaration — the clause
               // that catches a transient `gh` failure emptying this shape's only delivery signal.
               eq(/^reconcile: FORGE (UNREADABLE|DATA) —/m.test(res.stderr), Boolean(shape.expectForge),
                 `${shape.name}/${run}: this fixture declares expectForge=${Boolean(shape.expectForge)} but the run ` +
                 `${/^reconcile: FORGE /m.test(res.stderr) ? "reported" : "reported no"} forge problem — output was ${JSON.stringify(out)}`);
             }

             if (shape.refused) {
               eq(res.status, 1, `${shape.name}/${run}: a refused run must exit non-zero`);
               matches(res.stderr, /^reconcile: /m, `${shape.name}/${run}: a refused run must say why`);
               notMatches(res.stdout, /ticket\(s\) moved/,
                 `${shape.name}/${run}: a refused run claimed writes it never made`);
             } else if (run === "second-apply") {
               // BLZ-445, kept: the first pass wrote exactly when this board has something to change,
               // and the second finds nothing at all.
               eq(firstWrote, shapeChanges(shape),
                 `${shape.name}/${run}: the FIRST pass must write exactly when this board has something ` +
                 "to change — otherwise the second pass is not a second pass at all");
               matches(out, /no code-bound change found — nothing to do\./,
                 `${shape.name}/${run}: a second pass must report an empty pass — output was ${JSON.stringify(out)}`);
             } else if (shapeChanges(shape)) {
               const m = /reconcile: (\d+) ticket\(s\) moved/.exec(res.stdout);
               ok(m, `${shape.name}/${run}: ${gt.changedIds.length} ticket(s) changed but the CLI printed no applied line — ` +
                 `output was ${JSON.stringify(out)}`);
               eq(Number(m[1]), gt.moved,
                 `${shape.name}/${run}: the applied line's moved count must equal the real one (${gt.moved})`);
             } else {
               matches(out, /no code-bound change found — nothing to do\./,
                 `${shape.name}/${run}: nothing changes on this board, so the run must say so — output was ${JSON.stringify(out)}`);
             }
             assertCellBudget(clauses - cliCellStart, shape, run, "reconcile-cli");
             cellsEvaluated += 1;
   ```

   Then delete consumers 3 and 4 entirely (from `// CONSUMER 3: commitOutcomeFrom + applySummary …` to just before `rmSync(cliRoot, { recursive: true, force: true });`).
8. The tail: `cellsEvaluated` is compared with 36, with the message `"every one of the 36 cells must be evaluated"`. The `console.log` label becomes `BLZ-426 + BLZ-422 oracle`.
9. The header comment. Rewrite the BLZ-422/BLZ-427 bullets and "THE CROSS-PRODUCT" block to describe 9 × 2 × 2 = 36, and add one paragraph headed `BLZ-254` saying what went and why: reconcile stopped committing, `blaze commit` was deleted, and consumers 3–4 and the outcome dimension went with them. Delete the ground-truth sources (2) "whether a commit actually exists" (it is now "that no commit exists") and (3) "the pending-ledger FILE". Keep the BLZ-446 section and the second top-level test **unchanged**.

**`tests/reconcile-feed-truth-oracle.test.mjs`** (the supervisor's applied run, `:437-540`):
1. Replace the commit-existence block — from the comment `// BLZ-404 (review finding 3): a commit-existence clause, …` through the `eq(boardTreeDirty, "", …);` clause — with:

   ```js
         // BLZ-254 (spec §5.5): the loop applies and NEVER commits. Ground truth is `git` alone:
         // the commit count did not move, and the working tree's changed tickets are exactly the
         // ones the feed published — no move left out of the tree, no write the feed did not name.
         const commitCountAfter = Number(
           execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim());
         eq(commitCountAfter, commitCountBefore, "applied: the reconcile loop must not commit");
         const dirtyIds = new Set(execFileSync("git",
           ["-C", root, "status", "--porcelain", "--untracked-files=all", "--", join(root, "projects", KEY)],
           { encoding: "utf8" }).split("\n").map((l) => (/(ORC-\d+)/.exec(l) || [])[1]).filter(Boolean));
         deepEq([...movedIds].filter((id) => !dirtyIds.has(id)), [],
           "applied: every ticket the filesystem shows as moved must be a working-tree change");
         const eventIds = new Set(reconcileEvents.map((e) => e.id));
         deepEq([...dirtyIds].filter((id) => !eventIds.has(id)).sort(), [],
           "applied: the working tree changed a ticket the feed never published a reconcile event for");
   ```
2. Change the budget line to `const budget = groundTruthBudget(before, movedIds) + 6;` (3 non-vacuity + 1 no-commit + 2 tree/feed agreement). Remove `nonMovedGroundTruth` and its comment.
3. In the header comments (`:29-31`, `:141-142`, `:253-260`), say that `root` is a git repo so that "no commit" can be checked against `git log` (it used to be so that a commit could land).
4. If `deepEq` is not already defined in this file, use `eq(JSON.stringify(…), "[]", …)` instead, so the clause still goes through a counting wrapper (`grep -n "const deepEq" tests/reconcile-feed-truth-oracle.test.mjs`).

**`tests/reconcile-unfinished-pass.test.mjs`:**
1. Delete the two describes `"BLZ-404 round 5: the cross-pass dirty-tree detector is deleted — …"` (`:87-243`) and `"BLZ-404 round 2 (blocking 3): the supervisor feed reports 'queued', …"` (`:245-287`). Every test in them pins a commit outcome (lock, hook, batch queue, the "queued" feed event).
2. Delete the `acquireLock, releaseLock` import (`:34`) and the now-unused `headCount` helper.
3. In the kept describe, replace both occurrences (use `replace_all`) of

   ```js
         assert.equal(porcelain(root), "", "test setup: OBA must be fully in sync before ORC is added");
   ```

   with

   ```js
         // BLZ-254: reconcile no longer commits — in fs mode the operator versions the files.
         execFileSync("git", ["-C", root, "add", "-A"]);
         execFileSync("git", ["-C", root, "commit", "-q", "-m", "operator commits the seed pass"]);
         assert.equal(porcelain(root), "", "test setup: OBA must be fully in sync before ORC is added");
   ```
4. Add a header paragraph: `// BLZ-254: the round-2/round-5 describes are deleted — they pinned reconcile's commit outcomes (locked, failed, queued), and reconcile no longer commits. The --project blast-radius describe is kept; its HEAD clauses now read "reconcile made no commit at all".`

**`tests/board-overstatement-guards.test.mjs`:**
1. Imports: delete the `commitOutcomeFrom, applySummary, COMMIT_OUTCOMES` line and add `import { appliedLine } from "../scripts/reconcile-apply-report.mjs";`.
2. In `describe("BLZ-422: …")`, delete the three tests `"reconcile's commit outcome distinguishes no-op from committed"`, `"the no-op's rendered line does not claim a commit"` and `"BLZ-670: a db-mode apply says the moves are in the database, never 'already matched HEAD'"`, and add in their place:

   ```js
     test("BLZ-254: an applied reconcile names its store and never claims a commit", () => {
       const fs = appliedLine({ mode: "fs", movedCount: 3, nonMovedCount: 1 });
       assert.match(fs, /^reconcile: 3 ticket\(s\) moved, 1 ticket\(s\) updated without a status change in the board's files/);
       assert.match(fs, /makes no git commit/);
       assert.doesNotMatch(fs, /\bcommitted\b|queued|HEAD/, "the board never commits — no line may say it did");
       const db = appliedLine({ mode: "db", movedCount: 2, nonMovedCount: 0 });
       assert.equal(db, "reconcile: 2 ticket(s) moved in the database.");
       assert.equal(appliedLine({ mode: "dual", movedCount: 1, nonMovedCount: 0 }),
         appliedLine({ mode: "fs", movedCount: 1, nonMovedCount: 0 }), "dual writes the files, so it reads as fs");
     });
   ```

   (The remaining tests in this describe — `commitFile`'s empty-diff no-op and `commitSuffix` — are deleted in Tasks 6 and 3.)
3. Delete `describe("BLZ-427: \`blaze commit\`'s subject counts tickets and names every op", …)` whole (`:225-373`). It pins `OP_LABEL`, `summarizeEntries`, `commitOrQueue`'s ledger entry and reconcile's ledger entry, which are all deleted. Delete the `OP_LABEL, entryIds, summarizeEntries` and `readEntries, sessionId` imports with it.
4. In `describe("BLZ-447: …")`:
   - Replace the loop body of `"the write-record surface says 'N ticket(s) updated without a status change'"` with a loop over `["fs", "db"]` that calls `appliedLine({ mode, movedCount: 2, nonMovedCount: 3 })`, keeping both assertions.
   - Delete `"BLZ-481: the locked and failed lines state the SAME two quantities every other arm does"` (no locked/failed arm exists).
   - In `"neither surface states the quantity at all when it is zero"`, replace the `applySummary({ outcome: "committed", … }).text` call with `appliedLine({ mode: "fs", movedCount: 2, nonMovedCount: 0 })`.
   - In the describe's comment, replace `scripts/reconcile-commit-report.mjs` with `scripts/reconcile-apply-report.mjs`, and replace "the dry-run tail and the commit subject … COMMITTED_LINE_RE and QUEUED_LINE_RE" with "the dry-run tail (DRYRUN_TAIL_RE) and the applied line (APPLIED_LINE_RE)".

- [ ] **Step 7: Seam-closure (ledger rows 2030-2032 and 2147-2149).**

Replace

```js
  // BLZ-670: the CLI resolves both ports in db mode (resolvePorts) and hands `stageFor(mode)`
  // in as the stage; `commitOrQueue` stays as reconcile()'s default stage.
  ["reconcile.mjs", ["appendRegularFileSync", "commitOrQueue", "fsStorage", "resolvePorts", "stageFor"]],
```

with

```js
  // BLZ-670: the CLI resolves both ports in db mode (resolvePorts).
  // BLZ-254: commitOrQueue/stageFor removed — reconcile no longer stages its writes (spec §5.5).
  ["reconcile.mjs", ["appendRegularFileSync", "fsStorage", "resolvePorts"]],
```

and replace

```js
  // BLZ-670: runReconcile resolves both ports in db mode (resolvePorts) and stages by mode (stageFor).
```

```js
  ["supervisor.mjs", ["groomOnce", "groomOnceDb", "loadIdentity", "reconcile", "viewEnvelope", "resolvePorts", "stageFor"]],
```

(the two lines, with the BLZ-673 comment between them unchanged) so that the first reads `// BLZ-670: runReconcile resolves both ports in db mode (resolvePorts).`, a new line `// BLZ-254: stageFor removed — reconcile no longer stages (spec §5.5).` is added after the BLZ-673 comment, and the entry ends `…, "viewEnvelope", "resolvePorts"]],`.

- [ ] **Step 8: Delete the two tests whose subjects are gone.**

```bash
git rm tests/reconcile-commit-routing.test.mjs tests/commit-step-attribution.test.mjs
```

- [ ] **Step 9: Docs.** In `docs/guide/commands.md` `## reconcile`, replace every sentence that says `--apply` commits (or queues under `commitMode: batch`) with: "`--apply` writes the moves: to the ticket files on a file board (`fs`, `dual`), or to the database under `BLAZE_WRITE_PORT=db`. **Reconcile never commits** (BLZ-254). On a file board, version the changed files yourself. The last line of an applied run says how many tickets moved and where." Find the sentences with `grep -n "commit" docs/guide/commands.md | sed -n '/^1[4-9][0-9]:/p;/^20[0-9]:/p'`.

- [ ] **Step 10: Run the task's tests, then the suite.**

```bash
node --test --test-timeout=120000 --import=./tests/setup/hang-watchdog.mjs tests/reconcile*.test.mjs tests/board-overstatement-*.test.mjs tests/model/seam-closure.test.mjs tests/supervisor*.test.mjs
node scripts/ci/temp-cleanup-guard.mjs --write && git diff --stat scripts/ci/temp-cleanup-debt.json
npm test 2>&1 | tail -9
```

Expected: all pass. The debt file shows only removals (the two deleted files) or lowered counts. `npm test` reports `fail 0`. `rg -n "reconcile-commit-report|commitOutcome|applySummary" scripts tests` prints nothing except `// BLZ-254` comments.

- [ ] **Step 11: Commit.**

```bash
git add scripts/reconcile.mjs scripts/supervisor.mjs scripts/reconcile-apply-report.mjs \
  tests/reconcile-db-mode.test.mjs tests/reconcile.test.mjs tests/reconcile-project-filter.test.mjs \
  tests/reconcile-pertype.test.mjs tests/reconcile-change-report-oracle.test.mjs \
  tests/board-overstatement-oracle.test.mjs tests/board-overstatement-guards.test.mjs \
  tests/reconcile-feed-truth-oracle.test.mjs tests/reconcile-unfinished-pass.test.mjs \
  tests/model/seam-closure.test.mjs scripts/ci/temp-cleanup-debt.json docs/guide/commands.md
git status --short   # the git mv and git rm are already staged; nothing else may be listed
git commit -m "BLZ-687: reconcile and the supervisor feed stop committing (spec §5.5)"
```

---
