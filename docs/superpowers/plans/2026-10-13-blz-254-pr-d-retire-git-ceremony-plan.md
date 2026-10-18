# BLZ-254 PR D — retire the git ceremony — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete every git-era write mechanism the live board needed (spec §5.5): `blaze commit`, `blaze publish`, the commit lock, the pending ledgers, `commit-or-queue`/`stageFor`, `serve-commit`, and `missingClaimErrors`. Board verbs, the board server, reconcile and `blaze import` then write files (fs) or rows (db) and never commit, while fs mode keeps its single-machine allocator (`ids.mjs`, `claims.mjs`, D1).

**Architecture:** Consumers are cut first and modules deleted last, so the suite is green at every commit. Tasks 1–4 stop each caller staging: reconcile and the supervisor feed (Task 1), the server (Task 2, its 200 body becomes `{ ok, db, … }`), the six ticket verbs and `sprint` (Task 3), and import (Task 4). Task 5 removes the two verbs, and a removed verb gets a named refusal at dispatch. Task 6 deletes the now-unreferenced modules. The one primitive that survives (`acquireDirLock`/`releaseDirLock`, which `model/import-lock.mjs` needs) moves to `scripts/dir-lock.mjs`. Task 7 makes `commitMode` ignored with a one-time warning, and Task 8 retires `missingClaimErrors`. Task 9 carries the ADRs, the spec amendment and the version, and Task 10 is the conditional matrices header. `tests/model/seam-closure.test.mjs` changes only by exact name swaps or removals, each marked `// BLZ-254:`, in the same task as the code that makes it necessary.

**Tech Stack:** Node 24 ESM, `node:test`, `node:sqlite`, `pg` 8 (Postgres tests gated `PG_SKIP`), git.

**Spec:** `docs/superpowers/specs/2026-10-05-blz-254-live-board-cutover-design.md`. Read §2 (D1–D4), §5.5 (the deletion table, binding), §5.6, §6 ("Deletion"), §7 (the runbook) and §8 row D first. This plan argues from it. Recon: `/home/rnamwoh/Documents/Code/blaze/.superpowers/sdd/blz-254/recon/A-git-write-path.md` (written at `0f2f2a1`; every path and line below was re-verified at `3a0ac78`).

**Ticket:** BLZ-687 (parent BLZ-254). Branch `BLZ-687-retire-git-ceremony`, worktree `/home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-687-retire-git-ceremony`, forked from `origin/main` `3a0ac78`.

**Baseline (recorded 2026-10-13 at `3a0ac78`, Node 24.19.0, `npm test`, `BLAZE_TEST_PG_URL` unset):** `tests 5432 · suites 480 · pass 5393 · fail 0 · skipped 39 · duration 142 s`.

## MERGE GATE — read before anything else

PR D is built and reviewed now. It **merges only after cutover step 6 (§7), and only on the operator's explicit go-ahead.** Pushing the branch and opening the PR as a draft is fine. `gh pr merge` is not, whoever asks, until every line below holds and the operator has said "merge PR D":

1. **Cutover §7 steps 1–5 are done.** The live board serves and writes from Postgres (`BLAZE_WRITE_PORT=db` on the Deployment, smoke test passed). Step 6's unfreeze is the moment PR D merges.
2. **`.blaze/pending/` and `.blaze/pending-commit.jsonl` are empty on every machine** (§7 step 2's last `blaze publish` ran). After this PR, no engine can drain them.
3. **The `blaze-flush` CronJob is gone, or its deletion merges in the same window** (the C2 PR, §8). service-platform pins the blaze image to every `main` merge automatically (`chore(deploy): pin blaze to <sha>`), so the next nightly flush after PR D's image lands would run `blaze commit --all` and get the removed-verb refusal (exit 1, `CronJobLastRunFailed`). Check: `kubectl get cronjob -n blaze` lists no `blaze-flush`.
4. **(Not a gate any more — operator ruling 2026-10-18.)** `commitMode` is ignored with a one-time warning (Task 7), so a ConfigMap or blaze-pm config that still carries it cannot crash-loop the pod. Dropping the key is a post-merge cleanup (see "Post-merge checklist").
5. **0.8.0 published (BLZ-674).** The operator publishes `@hjr15/blaze-board@0.8.0` from `main` before PR D merges (operator ruling 2026-10-18). Check: `npm view @hjr15/blaze-board version` prints `0.8.0`. It was `0.7.0` on 2026-10-13. PR D's tree is 0.9.0 (Task 9), so no later publish can ship the breaking tree as 0.8.0.
6. CI is green on the PR's head, and the whole-branch review (Task 11) is upheld.

## Global Constraints

- **Scope is spec §5.5's table, and nothing beyond it** (spec §10: "Any change to fs or dual behaviour beyond §5.5's deletions" is out of scope). **Kept:** `scripts/model/claims.mjs`, `scripts/model/ids.mjs`, `fsAllocators`, and `seed-counter.mjs`'s `.ids/` source (D1). **Out of scope:** `scripts/model/import-lock.mjs`, `ref-claim.mjs` and `ref-allocator.mjs` are not deleted. Also out of scope is the service-platform side (deleting `blaze-flush`, `flush-configmap.yaml`, the chart's `flush:` values, superseding service-platform ADR 0017), which belongs to the C2 PR. The fs groomer's own `git commit` (`scripts/loops/groomer.mjs:712-713`) and `blaze migrate`'s (`scripts/migrate-runner.mjs:77-85`) are not in §5.5's table, so they stay (see Finding 6).
- **`tests/model/seam-closure.test.mjs`: only exact name swaps or removals of deleted modules' entries, each with a `// BLZ-254:` comment, and no assertion weakened.** No new map entry, no new member, no relaxed comparison. Every line touched is listed in the owning task, and the full list is in "Seam-closure ledger" below.
- **A test file is deleted only when every test in it covers a deleted module or a deleted behaviour.** A file that also covers surviving behaviour is edited instead. Each deletion is listed with its reason in the owning task.
- **TDD where behaviour changes:** the server's 200 body, the CLI's removed-verb refusal, a verb that writes and creates no commit, reconcile's applied line, `commitMode` ignored with one warning, and `blaze reindex` no longer refusing an unclaimed id. Each gets a failing test first.
- **No plan step may reach the live cluster (I8).** `scripts/publish-runner.mjs` runs `kubectl create job -n blaze --from=cronjob/blaze-flush …` against the ambient kube context (on the operator's machine, `k3d-service-platform`). Until Task 5 deletes it, any command that could reach `blaze publish` runs with `KUBECONFIG=/dev/null` and a `PATH` whose first entry is a stub `kubectl` that exits 1. That covers every red run, and every `npm test` before Task 5 lands. Set it up once per shell:
  ```bash
  STUB=$(mktemp -d "${TMPDIR:-/tmp}/blz687-nokube-XXXXXX") && printf '#!/bin/sh\necho "kubectl disabled for BLZ-687" >&2; exit 1\n' > "$STUB/kubectl" && chmod +x "$STUB/kubectl"
  export KUBECONFIG=/dev/null PATH="$STUB:$PATH"
  ```
  `tests/cli-removed-commands.test.mjs` also builds its own stub in `run()` (Task 5). No step runs `kubectl` against a real context.
- **New test files use `tests/helpers/scratch.mjs` (I9):** `import { scratchRegistry } from "./helpers/scratch.mjs"; const scratch = scratchRegistry();` at module scope, and `scratch(mkdtempSync(join(tmpdir(), "<literal-prefix>-")))` for every scratch directory. Keep the literal prefix inside `mkdtempSync` for the attribution scan. No per-test `t.after(() => rmSync(…))`.
- **Mode comes only from `resolveWriteMode(env)`** (or the `mode` the resolvers return). Nothing sniffs `writePort.name`.
- **Test hygiene the suite enforces:** scratch dirs via `mkdtempSync(join(tmpdir(), "<literal-prefix>-"))` with cleanup in `t.after`/`finally`. No `rmSync` reached only after an assertion (the `temp-cleanup-guard` ratchet). A spawned process gets an env with `BLAZE_WRITE_PORT`/`BLAZE_READONLY`/`BLAZE_REMOTE_URL`/`BLAZE_TOKEN` DELETED, never set to `""`.
- **THE DEBT STEP.** `scripts/ci/temp-cleanup-debt.json` is held to equality by `tests/temp-cleanup-guard.test.mjs`, and its size is quoted in `docs/ci.md` ("454 sites across 65 files" at baseline). That quote is registered in `scripts/ci/quoted-sources.mjs` and pinned by `tests/quoted-sources.test.mjs`. Every task that deletes or edits a test file (Tasks 1–8) runs this exact block before its commit, and stages all three files:
  ```bash
  node scripts/ci/temp-cleanup-guard.mjs --write \
    && OLD=$(grep -o '[0-9]* sites across [0-9]* files' scripts/ci/quoted-sources.mjs | head -1) \
    && NEW=$(node -e 'const f=JSON.parse(require("fs").readFileSync("scripts/ci/temp-cleanup-debt.json","utf8")).files;const v=Object.values(f);console.log(`${v.reduce((a,b)=>a+b,0)} sites across ${v.length} files`)') \
    && sed -i "s/$OLD/$NEW/" scripts/ci/quoted-sources.mjs docs/ci.md \
    && git diff scripts/ci/temp-cleanup-debt.json && echo "quote: $OLD -> $NEW"
  # stage: scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md
  ```
  The debt diff must show **only removed lines or lowered counts**. A raised count is a new leak and is fixed in the test, not recorded. The one exception is Task 6's rename, `"dir-lock.test.mjs": 6` replacing `"commit-lock.test.mjs": 6`, which is the same file. The review measured this sequence (sites/files) after each task: 453/65, 446/63, 438/61, 438/61, 386/56, 379/54, 376/54, 375/54. A different figure is not wrong in itself, but read the diff before accepting it.
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
5. **`commitMode` is ignored with a one-time warning (operator ruling 2026-10-18), not refused** (Task 7). Nothing reads it after Task 3. A hard refusal (BLZ-298's rule for removed keys) would crash-loop the deployed board while its ConfigMap still sets `"commitMode": "batch"`. So `loadConfig` warns once per process and drops the key, and `BLAZE_COMMIT_MODE` is treated the same. `SCHEMA_VERSION` stays 2: no config that loaded before fails now.
6. **The fs groomer and `blaze migrate` still commit.** `scripts/loops/groomer.mjs:712-713` commits a groom in fs mode, behind BLZ-347's containment (a db groom, `groomOnceDb`, never does). `scripts/migrate-runner.mjs:77-85` commits a one-shot Jira import. Neither is in §5.5's table, Recon A §7 missed the groomer, and spec §10 puts fs behaviour beyond the table out of scope. Both stay, and the docs say so rather than claim "Blaze never commits". They are a follow-up ticket under BLZ-254 (see "Out of scope / follow-ups").
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
4. **A deployed board whose ConfigMap still says `commitMode: "batch"`, restarted on the new image** → it loads, serves `GET /` with 200, warns exactly once, and has no `commitMode` on its config. Pinned in Task 7 (`tests/config-commitmode-ignored.test.mjs`: file key ×3 values incl. `null`, `BLAZE_COMMIT_MODE`, and a real server start).
5. **`blaze import --apply` on a git-backed board** → tickets (or rows), receipt and source-id map are written. Nothing is staged, `HEAD` is unmoved, exit 0, and the trailer names the receipt and claims no commit. Pinned in Task 5 (`import --apply stages nothing`).

---

## File Structure

| File | Task | Change |
|---|---|---|
| `scripts/cli.mjs` | 5 | `commit`/`publish` out of `SUBCOMMANDS`; `REMOVED_COMMANDS` refusal; `SCHEMA_PREFLIGHT_EXEMPT` loses `commit` |
| `scripts/commit-runner.mjs`, `scripts/publish-runner.mjs` | 5 | **deleted** |
| `scripts/serve.mjs` | 2 | no staging; 200 body `{ ok, db, … }`; no 503 lock arm |
| `scripts/views/write-outcome.mjs` | 2 | **deleted**; `scripts/views/page.mjs` stops injecting it |
| `scripts/{new,move,edit,link,log,resolve,sprint}-runner.mjs` | 3 | no staging, no commit suffix |
| `scripts/reconcile.mjs`, `scripts/supervisor.mjs` | 1 | no commit block; result fields; applied line; feed |
| `scripts/reconcile-commit-report.mjs` → `scripts/reconcile-apply-report.mjs` | 1 | `git mv`; only `appliedLine` remains |
| `scripts/model/import-apply.mjs`, `scripts/model/import-mapping.mjs`, `scripts/import-runner.mjs` | 4 | no staging |
| `scripts/commit-or-queue.mjs`, `scripts/serve-commit.mjs`, `scripts/pending-ledger.mjs`, `scripts/commit-summary.mjs`, `scripts/branch-guard.mjs` | 6 | **deleted** |
| `scripts/commit-lock.mjs` → `scripts/dir-lock.mjs` | 6 | `git mv`; policy half deleted |
| `scripts/model/import-lock.mjs`, `scripts/readonly.mjs` | 6 | import path; comments |
| `scripts/config.mjs`, `scripts/model/schema-version.mjs` | 7 | `commitMode`/`BLAZE_COMMIT_MODE` ignored with a one-time warning; `SCHEMA_VERSION` stays 2 |
| `scripts/model/index.mjs`, `scripts/reindex.mjs` | 8 | `missingClaimErrors` and its call deleted |
| `tests/model/seam-closure.test.mjs` | 1–6 | name swaps/removals only (ledger below) |
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
| 956 | `["commit-runner.mjs", { writes: [], sanctioned: [], inert: [] }],   // a CLI verb, no exports` | deleted, replaced by `// BLZ-254: commit-runner.mjs (blaze commit) deleted.` | removal | 5 |
| 960-963 | `commit-or-queue.mjs` and `serve-commit.mjs` WRITE_MAP entries (+ the BLZ-670 comment on 960) | deleted, replaced by `// BLZ-254: commit-or-queue.mjs and serve-commit.mjs deleted (spec §5.5).` | removal | 6 |
| 1952 | `["pending-ledger.mjs", "*"], ["commit-lock.mjs", "*"],` | `["dir-lock.mjs", "*"],  // BLZ-254: pending-ledger.mjs deleted; commit-lock.mjs → dir-lock.mjs` | removal + name swap | 6 |
| 2030-2032 | `["reconcile.mjs", ["appendRegularFileSync", "commitOrQueue", "fsStorage", "resolvePorts", "stageFor"]]` | `["reconcile.mjs", ["appendRegularFileSync", "fsStorage", "resolvePorts"]],  // BLZ-254: commitOrQueue/stageFor deleted` (the BLZ-670 comment's second sentence, "`commitOrQueue` stays as reconcile()'s default stage", is deleted with them) | removal of deleted members | 1 |
| 2040-2046 | the `commit-runner`/`commit-or-queue`/`serve-commit` sentences of the comment, and the three WRITE_SITES entries 2044-2046 | the three entries deleted. The comment's second paragraph ("`blaze commit` owns the commit lock … the same lock.") is replaced by `// BLZ-254: commit-runner.mjs, commit-or-queue.mjs and serve-commit.mjs deleted (spec §5.5).` | removal | 5 (2044 and its sentence), 6 (2045-2046) |
| 2051-2053 | `serve.mjs` WRITE_SITES `… "addUser", "stageFor", "loadIdentity", …` | `"stageFor"` removed; the BLZ-670 comment gains `// BLZ-254: stageFor deleted — the server stages nothing.` | removal of a deleted member | 2 |
| 2062 | `["sprint-runner.mjs", ["saveSprints", "commitOrQueue"]]` | `["sprint-runner.mjs", ["saveSprints"]],  // BLZ-254: commitOrQueue deleted` | removal | 3 |
| 2083-2088 | six runners, each `["stageFor", "resolvePorts"]` (new-runner `["applyNew", "stageFor", "resolvePorts"]`) | `"stageFor"` removed from each; `// BLZ-254: stageFor deleted — the verbs stage nothing.` above the six | removal | 3 |
| 2107-2108 | `["model/import-apply.mjs", ["fsAllocators", "commitOrQueue", …]]` | `"commitOrQueue"` removed; `// BLZ-254` trailing | removal | 4 |
| 2121-2122 | `["model/import-mapping.mjs", [… "commitOrQueue", "applyImport", "pruneReceipts"]]` | `"commitOrQueue"` removed; `// BLZ-254` trailing | removal | 4 |
| 2129-2134 | import-lock's comment "through `commit-lock.mjs`'s primitive" | `commit-lock.mjs` → `dir-lock.mjs` in the comment, `// BLZ-254: renamed` | name swap (comment) | 6 |
| 2142-2143 | `["import-runner.mjs", ["resolvePorts", "stageFor", "runImport", …]]` | `"stageFor"` removed; `// BLZ-254` above | removal | 4 |
| 2147-2149 | `["supervisor.mjs", [… "resolvePorts", "stageFor"]]` | `"stageFor"` removed; `// BLZ-254` above | removal | 1 |
| 2093, 2116-2117 | prose: "`commitOrQueue` is the staging front door" (twice, import-apply's and import-mapping's justifications) | sentence kept, `(removed by BLZ-254)` appended | comment-only | 4 |
| 2140-2141 | `// BLZ-670: the apply path resolves both ports (resolvePorts) and hands \`stageFor(mode)\` in as` / `// the stage; repair resolves a reader only (resolveReadStorage, inert) and stages the same way.` | `// BLZ-670: the apply path resolves both ports (resolvePorts); repair resolves a reader only (resolveReadStorage, inert).` + `// BLZ-254: stageFor removed — nothing is staged.` | comment-only | 4 |
| 2530 | `["pending-ledger.mjs", "{ appendEntry }", "appendEntry"],` | deleted; `// BLZ-254: pending-ledger.mjs deleted` | removal | 6 |
| 2531 | `["commit-lock.mjs", "{ acquireLock }", "acquireLock"],` | `["dir-lock.mjs", "{ acquireDirLock }", "acquireDirLock"],  // BLZ-254: commit-lock.mjs → dir-lock.mjs` | name swap (the module and its surviving member) | 6 |
| 2567 | `["pending-ledger.mjs", "{ readForDrain, listQueues }"],` | deleted; `// BLZ-254: pending-ledger.mjs deleted` | removal | 6 |

**Comment lines that stay, by name (I5 ruling).** Three prose comments name a deleted member as part of a review's *history*, and they are **not** edited: line 273 (round 5's examples, `appendEntry`, `acquireLock`), line 2034 (round 5, D3: "`saveState`, `appendEntry`, `acquireLock` and their kin") and line 2067 (round 7, Finding 2's list: "`fsStorage`, `resolveWritePort`, `commitOrQueue`, …"). Rewriting history prose would make the guard's own record lie about what the reviewers found. Every other line that names a deleted module or member is either a ledger row above or fails Task 6 Step 6, whose allowance lists exactly these three lines. Line numbers shift as earlier tasks land. Each task finds its entries by the quoted text, not the number.

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
| 7 | `commitMode` is ignored with a one-time warning | sonnet | opus |
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
# THE DEBT STEP (Global Constraints) — run its block here
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
  tests/model/seam-closure.test.mjs scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md docs/guide/commands.md
git status --short   # the git mv and git rm are already staged; nothing else may be listed
git commit -m "BLZ-687: reconcile and the supervisor feed stop committing (spec §5.5)"
```

---
### Task 2: the board server stops committing; the page drops its git sentence

**Files:**
- Modify: `scripts/serve.mjs` (`:26` import, `:840-870` the response helpers, `:888-953` the route bodies)
- Delete: `scripts/views/write-outcome.mjs`
- Modify: `scripts/views/page.mjs` (`:11` import, `:52-58` `writeOutcomeSource`, `:423-440` `blazePost`)
- Regenerate: `tests/views/page-golden.html`
- Modify tests: `tests/serve-endpoints.test.mjs`, `tests/serve-db-mode.test.mjs`, `tests/serve-api-new.test.mjs`, `tests/board-overstatement-guards.test.mjs` (the BLZ-449 describe), `tests/model/seam-closure.test.mjs` (ledger row 2051-2053)
- Delete tests: `tests/serve-batch.test.mjs` (every test pins `commitMode: "batch"` queueing through the server), `tests/serve-batch-per-op.test.mjs` (every test pins "per-op mode adds exactly one commit")
- Docs: `docs/guide/commands.md` `## board` (the write paragraph), `docs/architecture.md` (HTTP table: the 200 body)

**Interfaces:**
- Produces: every `POST /api/{move,edit,resolve,log,ac,link}` 200 body is exactly `{ ok: true, db: <mode === "db">, …extra }` (`extra` = `{ resolution }` for `/api/move`, nothing for the others). `POST /api/new`'s is `{ ok: true, id, warnings, db: true }`. There is no `committed`, no `queued`, and no 503 for a held lock.

- [ ] **Step 1: Write the failing tests.**

In `tests/serve-endpoints.test.mjs`:
1. Delete the import `import { acquireLock, releaseLock } from "../scripts/commit-lock.mjs";` (`:27`) and the test `"POST /api/log responds 503 when the commit lock is held (not a generic 500)"` (`:178-191`). No lock exists on the write path.
2. Add, after `const post = …` (`:99`):

   ```js
   const headOf = (root) => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
   // BLZ-254 (spec §5.5): the board server never commits. A write changes the file and leaves
   // HEAD where it was; the body names the store and says nothing about git.
   async function assertWroteNoCommit(fx, res, extra = {}) {
     const body = await res.json();
     assert.equal(res.status, 200, JSON.stringify(body));
     assert.deepEqual(body, { ok: true, db: false, ...extra }, "the 200 body is { ok, db, …extra } and nothing else");
     assert.notEqual(execFileSync("git", ["-C", fx.root, "status", "--porcelain"], { encoding: "utf8" }).trim(), "",
       "the write must be on disk");
     return body;
   }
   ```
3. Replace the five "…and commits" tests (`:101-113`, `:147-154`, `:156-164`, `:166-176`, `:193-199`) with:

   ```js
   test("POST /api/move moves the file and creates no commit", async () => {
     const fx = repo();
     const { server, base } = await boot(fx);
     const before = headOf(fx.root);
     await assertWroteNoCommit(fx, await post(base, "/api/move", { id: "OBA-1", to: "done" }), { resolution: "done" });
     assert.ok(existsSync(join(fx.projects, "OBA", "done", "OBA-1.md")), "the file moved to done/");
     assert.equal(existsSync(join(fx.projects, "OBA", "in-review", "OBA-1.md")), false, "and left in-review/");
     assert.equal(headOf(fx.root), before, "the board server must not commit");
     server.close(); rmSync(fx.root, { recursive: true, force: true });
   });

   test("POST /api/edit patches a field and creates no commit", async () => {
     const fx = repo();
     const { server, base } = await boot(fx);
     const before = headOf(fx.root);
     await assertWroteNoCommit(fx, await post(base, "/api/edit", { id: "OBA-1", patch: { assignee: "ryan" } }));
     assert.match(readFileSync(join(fx.projects, "OBA", "in-review", "OBA-1.md"), "utf8"), /assignee: ryan/);
     assert.equal(headOf(fx.root), before, "the board server must not commit");
     server.close(); rmSync(fx.root, { recursive: true, force: true });
   });

   test("POST /api/ac toggles an AC checkbox and creates no commit", async () => {
     const fx = repo();
     const { server, base } = await boot(fx);
     const before = headOf(fx.root);
     await assertWroteNoCommit(fx, await post(base, "/api/ac", { id: "OBA-1", index: 0, checked: true }));
     assert.match(readFileSync(join(fx.projects, "OBA", "in-review", "OBA-1.md"), "utf8"), /- \[x\] one/);
     assert.equal(headOf(fx.root), before, "the board server must not commit");
     server.close(); rmSync(fx.root, { recursive: true, force: true });
   });

   test("POST /api/log appends a worklog entry and creates no commit", async () => {
     const fx = repo();
     const { server, base } = await boot(fx);
     const before = headOf(fx.root);
     await assertWroteNoCommit(fx, await post(base, "/api/log", { id: "OBA-1", minutes: 15, note: "review" }));
     assert.match(readFileSync(join(fx.projects, "OBA", "in-review", "OBA-1.md"), "utf8"), /minutes: 15/);
     assert.equal(headOf(fx.root), before, "the board server must not commit");
     server.close(); rmSync(fx.root, { recursive: true, force: true });
   });

   test("POST /api/resolve overrides resolution and creates no commit", async () => {
     const fx = repo();
     const { server, base } = await boot(fx);
     const before = headOf(fx.root);
     await assertWroteNoCommit(fx, await post(base, "/api/resolve", { id: "OBA-1", resolution: "wont-do" }));
     assert.match(readFileSync(join(fx.projects, "OBA", "in-review", "OBA-1.md"), "utf8"), /resolution: wont-do/);
     assert.equal(headOf(fx.root), before, "the board server must not commit");
     server.close(); rmSync(fx.root, { recursive: true, force: true });
   });
   ```

   Add `existsSync` to the file's `node:fs` import if it is missing. Keep the BLZ-121 comment on the readonly test (`:125-129`) and replace its words "not just inside commitOrQueue" with "before any verb runs".
4. In `tests/serve-db-mode.test.mjs:49`, replace

   ```js
         assert.deepEqual(body, { ok: true, committed: false, queued: false, db: true, resolution: body.resolution });
   ```

   with

   ```js
         // BLZ-254: the body names the store and nothing about git — the commit path is gone.
         assert.deepEqual(body, { ok: true, db: true, resolution: body.resolution });
   ```

   and replace the two comment lines above it ("Final review: the body names the store, …") with that one comment.
5. In `tests/serve-api-new.test.mjs:142`, replace

   ```js
         assert.deepEqual([body.id, body.db, body.committed], ["ENG-2", true, false]);
   ```

   with

   ```js
         assert.deepEqual(body, { ok: true, id: "ENG-2", warnings: body.warnings, db: true },
           "BLZ-254: no committed/queued — the server never commits");
   ```
6. In `tests/board-overstatement-guards.test.mjs`, replace `describe("BLZ-449: the dashboard surfaces the git outcome of a write", …)` (`:482-572`) whole with:

   ```js
   // BLZ-254 (spec §5.5): BLZ-449 gave the page a sentence for the server's `committed`/`queued`
   // fields. The server no longer commits and no longer sends them, so the sentence and its
   // module (scripts/views/write-outcome.mjs) are deleted — and the page must not keep any of
   // its git vocabulary, which would now describe nothing.
   describe("BLZ-254: the dashboard says nothing about git after a write", () => {
     test("the served page carries no write-outcome function and no git-outcome sentence", () => {
       const html = pageHtml({ project: "all", projectsDir: tinyBoard(), now: 1751932800000, transitions: [] });
       assert.doesNotMatch(html, /BLAZE_WRITE_OUTCOME/, "the injected write-outcome function is gone");
       assert.doesNotMatch(html, /queued for blaze commit|already matched HEAD|nothing was added to git log/,
         "no sentence about a commit the board no longer makes");
     });
   });
   ```

   Delete the `writeOutcome, WRITE_OUTCOME_FN_BEGIN, WRITE_OUTCOME_FN_END` import line.

- [ ] **Step 2: Run them and watch them fail.**

```bash
node --test --test-timeout=120000 --import=./tests/setup/hang-watchdog.mjs tests/serve-endpoints.test.mjs tests/serve-db-mode.test.mjs tests/serve-api-new.test.mjs tests/board-overstatement-guards.test.mjs
```

Expected: FAIL. The deepEqual sees `committed`/`queued`, "the board server must not commit" fails, and the page still matches `/BLAZE_WRITE_OUTCOME/`.

- [ ] **Step 3: The server (`scripts/serve.mjs`).**

1. Delete `import { stageFor } from "./commit-or-queue.mjs";` (`:26`).
2. Replace from the comment `      // in-place ops only — use the inline path for ops that rename (see /api/move)` (`:840`) through the end of the `done` arrow (`:870`, the line `      };` after `return json(200, { ok: true, ...gitOutcome(c), ...extra });`) with:

   ```js
         // BLZ-254 (spec §5.5): the board never commits. A 200 body names the STORE and nothing
         // about git: `db` says whether the write landed in the database or in the files. The git
         // fields (`committed`/`queued`, BLZ-422) went with the commit path, and so did the 503 a
         // held commit lock used to earn — nothing on this path takes a lock any more.
         // BLZ-670: resolved below, inside the try, but declared here because `done` reports by
         // the resolved mode.
         let writePort, readStorage, mode, closeWritePort;
         const done = (r, extra = {}) => {
           if (!r.ok) return json(422, { errors: r.errors });
           return json(200, { ok: true, db: mode === "db", ...extra });
         };
   ```
3. `/api/move` (`:888-894`). Replace

   ```js
           if (!r.ok) return json(422, { errors: r.errors });
           const extraFiles = (r.fromFile && r.fromFile !== r.file) ? [r.fromFile] : [];
           const c = stageFor(mode)({ root, mode: cfgFor(root).commitMode, op: "move", id: payload.id, message: `${payload.id}: ${r.from ?? "?"} → ${payload.to}`, files: [r.file, ...extraFiles], lockOpts: LOCK_OPTS });
           if (commitFailed(c)) return;
           return json(200, { ok: true, ...gitOutcome(c), resolution: r.resolution });
   ```

   with `        return done(r, { resolution: r.resolution });`.
4. `/api/edit`, `/api/resolve`, `/api/log`, `/api/ac`. Replace each `return done(r, <message>, "<op>");` with `return done(r);` (four sites; `rg -n 'return done\(r, `' scripts/serve.mjs` must print nothing afterwards).
5. `/api/new` (`:942-945`). Replace

   ```js
           const c = stageFor(mode)({ root, mode: cfgFor(root).commitMode, op: "new", id: r.id,
             message: `${r.id}: create ${r.type}`, files: [r.file, r.claimFile].filter(Boolean), lockOpts: LOCK_OPTS });
           if (commitFailed(c)) return;
           return json(200, { ok: true, id: r.id, warnings: r.warnings, ...gitOutcome(c) });
   ```

   with `        return json(200, { ok: true, id: r.id, warnings: r.warnings, db: mode === "db" });`.
6. `/api/link` (`:957`). Replace `return done(r, \`${p.id}: ${p.remove === true ? "unlink" : "link"} ${p.type} ${p.target}\`, "link");` with `return done(r);`.
7. Fix the comment above the read-only check (`:830`): "checked here (before any apply* call below, not just inside commitOrQueue)" → "checked here, before any apply* call below". Fix the BLZ-133 comment at `:48` ("reading commitMode from the engine root was already wrong") to say "reading config from the engine root …".
8. `rg -n 'stageFor|commitFailed|gitOutcome|LOCK_OPTS|commitMode' scripts/serve.mjs` must print nothing.

- [ ] **Step 4: The page (`scripts/views/page.mjs`), and the module.**

1. Delete `import { writeOutcome, WRITE_OUTCOME_FN_BEGIN, WRITE_OUTCOME_FN_END } from "./write-outcome.mjs";` (`:11`).
2. Delete the `// BLZ-449: the same construction …` comment and the `writeOutcomeSource()` function (`:52-58`).
3. In the client template (`:423-440`), delete the four-line `// BLZ-449: the sentence a WRITE gets. …` comment and the `${writeOutcomeSource()}` line. Then replace

   ```js
           if (res.ok) {
             // BLZ-449: the 200 body carries committed/queued (serve.mjs's gitOutcome,
             // added by BLZ-422) and this consumer used to discard it. A queued write and an
             // idempotent re-write that git had nothing to commit both looked identical to a
             // real commit from here — on a board whose model is one op, one commit.
             const j = await res.json().catch(() => null);
             const note = writeOutcome(j);
             if (note) toast(note);
             window.blazeSwapView(document.documentElement.dataset.view);
             return true;
           }
   ```

   with

   ```js
           if (res.ok) {
             // BLZ-254: a successful write says nothing — the board no longer commits, so there
             // is no git outcome to report (BLZ-449's sentence is deleted with the commit path).
             window.blazeSwapView(document.documentElement.dataset.view);
             return true;
           }
   ```
4. `git rm scripts/views/write-outcome.mjs`
5. Regenerate the golden page: `rm tests/views/page-golden.html && node --test --import=./tests/setup/hang-watchdog.mjs tests/views/page-golden.test.mjs && node --test --import=./tests/setup/hang-watchdog.mjs tests/views/page-golden.test.mjs`. The first run writes it and the second compares. Then `git diff --stat tests/views/page-golden.html` must show **only deletions**: the injected function, its comment and the three removed lines in `blazePost`. Read the diff. Any added line other than the BLZ-254 comment means something else drifted, so stop and investigate.

- [ ] **Step 5: Seam-closure (ledger row 2051-2053).** Replace

```js
  // BLZ-670: the mutating block resolves both ports per request (resolvePorts) and stages by mode (stageFor).
  ["serve.mjs", ["issueSetupToken", "clearSetupToken", "ensureSetupTokenIgnored",
    "ensureIdentityIgnored", "addUser", "stageFor", "loadIdentity", "reconcile",
```

with

```js
  // BLZ-670: the mutating block resolves both ports per request (resolvePorts).
  // BLZ-254: stageFor removed — the server stages nothing (spec §5.5).
  ["serve.mjs", ["issueSetupToken", "clearSetupToken", "ensureSetupTokenIgnored",
    "ensureIdentityIgnored", "addUser", "loadIdentity", "reconcile",
```

- [ ] **Step 6: Delete the two batch-mode server tests.**

```bash
git rm tests/serve-batch.test.mjs tests/serve-batch-per-op.test.mjs
```

- [ ] **Step 7: Docs.**
- `docs/guide/commands.md` `## board`: the paragraph on what a dashboard write does now reads "A write from the page (or `POST /api/*`) changes the ticket file (`fs`, `dual`) or row (`db`) and **makes no commit** (BLZ-254). The 200 body is `{ ok: true, db }` plus the route's own fields."
- `docs/architecture.md` HTTP table: replace any mention of `committed`/`queued` in the POST rows with `db`.

- [ ] **Step 8: Run, then commit.**

```bash
node --test --test-timeout=120000 --import=./tests/setup/hang-watchdog.mjs tests/serve*.test.mjs tests/views/*.test.mjs tests/board-overstatement-guards.test.mjs tests/model/seam-closure.test.mjs tests/remote-mode.test.mjs tests/setup-flow.test.mjs tests/signin-flow.test.mjs
# THE DEBT STEP (Global Constraints) — run its block here
npm test 2>&1 | tail -9
git add scripts/serve.mjs scripts/views/page.mjs tests/views/page-golden.html tests/serve-endpoints.test.mjs \
  tests/serve-db-mode.test.mjs tests/serve-api-new.test.mjs tests/board-overstatement-guards.test.mjs \
  tests/model/seam-closure.test.mjs scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md docs/guide/commands.md docs/architecture.md
git commit -m "BLZ-687: the board server stops committing; its 200 body is { ok, db } (spec §5.5)"
```

Expected: all green. `rg -n "write-outcome|writeOutcome|gitOutcome" scripts tests` prints nothing.

---
### Task 3: the CLI ticket verbs and `blaze sprint` stop committing

**Files:**
- Modify: `scripts/new-runner.mjs`, `scripts/move-runner.mjs`, `scripts/edit-runner.mjs`, `scripts/link-runner.mjs`, `scripts/log-runner.mjs`, `scripts/resolve-runner.mjs`, `scripts/sprint-runner.mjs`
- Create: `tests/verbs-make-no-commit.test.mjs`
- Modify tests: `tests/runner-dataroot.test.mjs`, `tests/board-overstatement-guards.test.mjs` (one test), `tests/sprint-runner-stamp-warning.test.mjs` (comment), `tests/model/seam-closure.test.mjs` (ledger rows 2062, 2083-2088)
- Delete tests: `tests/runner-batch.test.mjs` (every test pins a runner queueing in `commitMode: "batch"`), `tests/edit-runner-batch.test.mjs` (the same, for `blaze edit`)
- Docs: `docs/guide/commands.md` (`## new`, `## move`, `## edit`, `## link`, `## resolve`, `## log`, `## sprint`: drop "commits"/"queues" from each), `docs/guide/getting-started.md:156-160`

**Interfaces:**
- Consumes: nothing new.
- Produces: each verb's success line without a commit suffix (`created OBA-3 → <path>`, `OBA-1: in-progress → in-review`, `OBA-1: priority = high`, `OBA-1: added Relates → OBA-2`, `logged 30m to OBA-1 (total …)`, `OBA-1: resolution → wont-do`, `created S1`, `active sprint: S1`), exit 0, nothing staged, `HEAD` unmoved.

- [ ] **Step 1: Write the failing test.** Create `tests/verbs-make-no-commit.test.mjs`:

```js
// tests/verbs-make-no-commit.test.mjs — BLZ-687 (BLZ-254 PR D, spec §5.5).
//
// "The board never commits. In fs mode the user versions the files themselves." Every CLI
// verb that used to commit (per-op) or queue (batch) its write is driven here, end to end
// through cli.mjs, against an fs board that IS a git repo — so a commit, a staged path or a
// leftover "(queued for blaze commit)" suffix would all be visible. Each must change the
// working tree, stage nothing, leave HEAD where it was, and print no git vocabulary.
//
// D1 keeps fs mode's single-machine allocator: the last test pins that `blaze new` still
// allocates through the claim ledger (`.ids/<n>`), one number after the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(REPO, "scripts", "cli.mjs");
const git = (root, ...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();

function board(t) {
  const root = mkdtempSync(join(tmpdir(), "blz687-verbs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "OBA", projects: ["OBA"] }));
  mkdirSync(join(root, "projects", "OBA", "in-progress"), { recursive: true });
  for (const n of [1, 2]) {
    writeFileSync(join(root, "projects", "OBA", "in-progress", `OBA-${n}.md`),
      `---\nid: OBA-${n}\ntype: task\nproject: OBA\ntitle: OBA-${n}\npriority: medium\nestimate: 30\n---\n\nbody\n`);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  return root;
}

function run(root, args) {
  const env = { ...process.env };
  for (const k of ["BLAZE_WRITE_PORT", "BLAZE_READONLY", "BLAZE_REMOTE_URL", "BLAZE_TOKEN",
                   "BLAZE_PROJECTS_DIR", "BLAZE_COMMIT_MODE", "BLAZE_SESSION"]) delete env[k];
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
}

const GIT_WORDS = /queued for blaze commit|no commit created|commit failed|commit manually/;

const VERBS = [
  ["new", ["new", "--project", "OBA", "--type", "task", "--estimate", "30", "a new ticket"]],
  ["move", ["move", "OBA-1", "in-review"]],
  ["edit", ["edit", "OBA-1", "priority", "high"]],
  ["link", ["link", "OBA-1", "Relates", "OBA-2"]],
  ["log", ["log", "OBA-1", "30"]],
  ["resolve", ["resolve", "OBA-2", "wont-do"]],
  ["sprint new", ["sprint", "new", "Sprint 1", "--start", "2026-01-01", "--end", "2026-01-14"]],
];

for (const [name, args] of VERBS) {
  test(`blaze ${name} writes, stages nothing, creates no commit, and says nothing about git`, (t) => {
    const root = board(t);
    const before = git(root, "rev-parse", "HEAD");
    const r = run(root, args);
    assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
    assert.notEqual(git(root, "status", "--porcelain", "--untracked-files=all"), "",
      `${name} must change the working tree`);
    assert.equal(git(root, "diff", "--cached", "--name-only"), "", `${name} must stage nothing`);
    assert.equal(git(root, "rev-parse", "HEAD"), before, `${name} must not commit`);
    assert.doesNotMatch(r.stdout + r.stderr, GIT_WORDS, `${name} printed git vocabulary`);
  });
}

test("fs-mode blaze new still allocates through the claim ledger (D1)", (t) => {
  const root = board(t);
  const a = run(root, ["new", "--project", "OBA", "--type", "task", "--estimate", "30", "first"]);
  const b = run(root, ["new", "--project", "OBA", "--type", "task", "--estimate", "30", "second"]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.match(a.stdout, /^created OBA-3 → /m);
  assert.match(b.stdout, /^created OBA-4 → /m, "the second create must take the next number");
  for (const n of [3, 4]) {
    assert.ok(existsSync(join(root, "projects", "OBA", ".ids", String(n))), `the claim .ids/${n} must be written`);
  }
});
```

- [ ] **Step 2: Run it and watch it fail.**

```bash
node --test --test-timeout=120000 --import=./tests/setup/hang-watchdog.mjs tests/verbs-make-no-commit.test.mjs
```

Expected: the seven verb tests FAIL with "must not commit" (the default `commitMode` is `per-op`). The allocator test PASSES already; it is a guard, not a red step.

- [ ] **Step 3: The six ticket runners.** In each of `new-runner.mjs`, `move-runner.mjs`, `edit-runner.mjs`, `link-runner.mjs`, `log-runner.mjs` and `resolve-runner.mjs`:
1. Delete the line `import { stageFor, commitSuffix } from "./commit-or-queue.mjs";`.
2. Replace

   ```js
   let cfg;
   try { cfg = loadConfig({ root: dataRoot }); }
   ```

   with

   ```js
   // The call IS the config-schema guard (ADR-0002); its value was read only for `commitMode`,
   // which BLZ-254 removed.
   try { loadConfig({ root: dataRoot }); }
   ```
3. Replace the tail. The `// BLZ-670: db mode stages only files …` comment, the `const c = stageFor(mode)(…)` line and the `if (!c.ok) { … commit manually …}` line all go, and the `console.log` loses `${commitSuffix(c)}`:

   | Runner | Final line |
   |---|---|
   | new | ``console.log(`created ${r.id}${mode === "db" ? "" : ` → ${r.file}`}`);`` (keep its BLZ-670 comment about `r.file` being an id handle) |
   | move | ``console.log(`${id}: ${r.from} → ${r.to}${r.resolution ? ` (resolution: ${r.resolution})` : ""}`);`` |
   | edit | ``console.log(`${id}: ${field} = ${value}`);`` |
   | link | ``console.log(`${id}: ${remove ? "removed" : "added"} ${type} → ${target}`);`` (also delete `const verb = remove ? "unlink" : "link";`, now unused) |
   | log | ``console.log(`logged ${r.minutes}m to ${r.id} (total ${formatMinutes(r.total_worklog_minutes)})`);`` |
   | resolve | ``console.log(`${id}: resolution → ${resolution}`);`` |

   Precede each with `// BLZ-254 (spec §5.5): the verb writes and stops — the board never commits.`
4. In move/edit/link/log/resolve, drop `mode, ` from `const { writePort, readStorage, mode, close: closePorts } = __wp;` (now unused). new-runner keeps it.
5. Headers and the BLZ-121 comments. Each runner's header says "then commit (or queue)" or "then commits (or queues)". Replace that with "and writes; it makes no commit (BLZ-254)". In each `BLZ-121 defence-in-depth` comment, replace the explanation that names `commitOrQueue` with: "`apply*` writes the ticket file via direct node:fs calls, so the guard must run before it; cli.mjs is still the primary gate." Do the same in `log-runner`, `link-runner`, `resolve-runner` and `new-runner`. `rg -n "commitOrQueue|commitSuffix|stageFor|commitMode" scripts/*-runner.mjs` prints nothing for these six.

- [ ] **Step 4: `scripts/sprint-runner.mjs`.**
1. Delete `import { commitOrQueue, commitSuffix } from "./commit-or-queue.mjs";`.
2. Apply the same `let cfg; try { cfg = loadConfig(…) }` → `try { loadConfig(…) }` change (`:25-26`).
3. Replace

   ```js
       const c = commitOrQueue({ root: dataRoot, mode: cfg.commitMode, op: "sprint", id, message: `sprint: create ${id}`, files: ["sprints.json"] });
       if (!c.ok) { console.error(`blaze sprint: file written but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
       console.log(`created ${id}${commitSuffix(c)}`);
   ```

   with `    console.log(\`created ${id}\`);   // BLZ-254: no commit`, and the `active` twin (`:84-86`) with `    console.log(\`active sprint: ${id}\`);   // BLZ-254: no commit`.
4. Fix the BLZ-121 comment (`:36-40`) the same way as Step 3.5.

- [ ] **Step 5: The other tests.**
- `tests/runner-dataroot.test.mjs`:
  - In `dataRepo()`, drop `, commitMode: "per-op"` from the config.
  - Test 1: replace the two lines after `// …the DATA repo committed (per-op mode)…` with:

    ```js
      // …the DATA repo holds it uncommitted — BLZ-254: the board never commits…
      assert.match(execFileSync("git", ["-C", data, "status", "--porcelain", "--untracked-files=all"],
        { encoding: "utf8" }), /ZZZ-2-dataroot-proof/);
    ```
  - Test 2 (`"cwd inside a data repo works with no env (ladder rung 2)"`): replace its body between `const data = dataRepo();` and the first `rmSync` with

    ```js
      const before = head(data);
      execFileSync(process.execPath, [join(eng, "scripts", "log-runner.mjs"), "ZZZ-1", "30"],
        { cwd: data, env: { ...process.env, BLAZE_PROJECTS_DIR: "" } });
      assert.match(readFileSync(join(data, "projects", "ZZZ", "in-progress", "ZZZ-1.md"), "utf8"), /minutes: 30/);
      assert.equal(head(data), before, "BLZ-254: the log is written, not committed");
    ```

    and add `readFileSync` to the file's `node:fs` import.
  - Delete test 3, `"batch mode queues into the DATA repo's .blaze ledger"` (pins a batch queue).
- `tests/board-overstatement-guards.test.mjs`: delete the test `"each per-ticket verb says so when no commit was created"` (it pinned `commitSuffix`, whose callers are now gone). Then delete `commitSuffix` from the `commit-or-queue.mjs` import line, leaving `import { commitOrQueue } from "../scripts/commit-or-queue.mjs";`.
- `tests/sprint-runner-stamp-warning.test.mjs:34-40`: drop `, commitMode: "per-op"`. Replace the comment "A real git repo: `commitOrQueue` runs on the write path, and without one the runner exits 1 …" with "A real git repo, as a board usually is; since BLZ-254 the runner never touches git, so the assertions below do not depend on it."
- `tests/new-runner.test.mjs:1-5` and `tests/link-runner.test.mjs:1-5`: replace the header sentences about "makes a REAL git commit … commitMode: \"batch\" (no commits)" with "Runner spawn-test isolation is mandatory: a spawned runner with no BLAZE_PROJECTS_DIR writes into the REAL worktree." (The `commitMode` keys in their configs are removed in Task 7.)

- [ ] **Step 6: Seam-closure (ledger rows 2062 and 2083-2088).**

```js
  ["sprint-runner.mjs", ["saveSprints", "commitOrQueue"]],
```

→

```js
  ["sprint-runner.mjs", ["saveSprints"]],   // BLZ-254: commitOrQueue removed — no commit
```

and

```js
  // ...their six CLI runners resolve the write port and hand the result to the commit queue.
  // BLZ-670: each resolves BOTH ports once (resolvePorts) and stages by mode (stageFor), so a
  // db-mode verb reads the database and never stages a ticket that is only a row.
  ["edit-runner.mjs", ["stageFor", "resolvePorts"]],
  ["link-runner.mjs", ["stageFor", "resolvePorts"]],
  ["log-runner.mjs", ["stageFor", "resolvePorts"]],
  ["move-runner.mjs", ["stageFor", "resolvePorts"]],
  ["new-runner.mjs", ["applyNew", "stageFor", "resolvePorts"]],
  ["resolve-runner.mjs", ["stageFor", "resolvePorts"]],
```

→

```js
  // ...their six CLI runners resolve the write port.
  // BLZ-670: each resolves BOTH ports once (resolvePorts), so a db-mode verb reads the database.
  // BLZ-254: stageFor removed from all six — the verbs stage nothing (spec §5.5).
  ["edit-runner.mjs", ["resolvePorts"]],
  ["link-runner.mjs", ["resolvePorts"]],
  ["log-runner.mjs", ["resolvePorts"]],
  ["move-runner.mjs", ["resolvePorts"]],
  ["new-runner.mjs", ["applyNew", "resolvePorts"]],
  ["resolve-runner.mjs", ["resolvePorts"]],
```

- [ ] **Step 7: Delete the batch-runner tests, update the docs, run, commit.**

```bash
git rm tests/runner-batch.test.mjs tests/edit-runner-batch.test.mjs
node --test --test-timeout=120000 --import=./tests/setup/hang-watchdog.mjs tests/verbs-make-no-commit.test.mjs tests/runner-*.test.mjs tests/new-runner.test.mjs tests/link-runner.test.mjs tests/sprint-runner-stamp-warning.test.mjs tests/readonly.test.mjs tests/board-overstatement-guards.test.mjs tests/model/seam-closure.test.mjs
# THE DEBT STEP (Global Constraints) — run its block here
npm test 2>&1 | tail -9
git add scripts/new-runner.mjs scripts/move-runner.mjs scripts/edit-runner.mjs scripts/link-runner.mjs \
  scripts/log-runner.mjs scripts/resolve-runner.mjs scripts/sprint-runner.mjs tests/verbs-make-no-commit.test.mjs \
  tests/runner-dataroot.test.mjs tests/board-overstatement-guards.test.mjs tests/sprint-runner-stamp-warning.test.mjs \
  tests/new-runner.test.mjs tests/link-runner.test.mjs tests/model/seam-closure.test.mjs \
  scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md docs/guide/commands.md docs/guide/getting-started.md
git commit -m "BLZ-687: the CLI ticket verbs and blaze sprint stop committing (spec §5.5)"
```

Doc text for `getting-started.md:156-160`: "Blaze does not commit. Every mutating command above changes the ticket files (or, under `BLAZE_WRITE_PORT=db`, the database) and stops. On a file board, version the files with git yourself, as often as suits you. A board with more than one writer belongs in db mode (see [ADR-0006](../decisions/0006-database-is-the-sole-source-of-truth.md))." In `commands.md`, every verb section loses the clause that says the verb commits or queues.

`readonly.test.mjs` is in the run list on purpose. Its "bypassing cli.mjs refuses BEFORE writing" tests must stay green now that the runners never reach a commit. Its queue snapshots still work, because `pending-ledger.mjs` exists until Task 6.

---
### Task 4: `blaze import` stops staging

**Files:**
- Modify: `scripts/model/import-apply.mjs` (`:58` import, `:355-385` `applyImport`'s docblock and context, `:389`, `:480-516` the returns and the staging block, `:554-556` `runImport`'s options, `:653-665` the call and trailer)
- Modify: `scripts/model/import-mapping.mjs` (`:48` import, `:536-538`, `:711-736` `runMappedImport`, `:786-808` and `:1003-1033` `runRepair`)
- Modify: `scripts/import-runner.mjs` (`:32` import, `:159-160` `cfg`, `:206-209`, `:233-237`)
- Modify tests: `tests/model/import-apply.test.mjs`, `tests/model/import-mapping-repair.test.mjs`, `tests/import-runner.test.mjs`, `tests/db-mode-reads.test.mjs`, `tests/import-db-mode.test.mjs`, `tests/reserve-window.test.mjs`, `tests/markdown-round-trip.test.mjs`, `tests/helpers/csv-round-trip.mjs`, `tests/model/seam-closure.test.mjs` (ledger rows 2107-2108, 2121-2122, 2142-2143)
- Docs: `docs/design/csv-import-and-export.md` (§5.1 exit-4 row and "Exit 0 does not mean committed", §5.2's repair exit-4 row and the precedence paragraph, §5.4), `docs/guide/commands.md` `## import`

**Interfaces:**
- Produces:
  - `applyImport(plan, { projectsDir, dataRoot, receiptPath, writePort?, onPair?, appendReceipt? }) → { exitCode, written, notWritten, files, errors }`, with no `stage`, `commitMode`, `message`, `staged` or `commit`.
  - `runImport`/`runMappedImport`/`runRepair` lose the `stage` and `commitMode` options.
  - Exit 4 means "the board changed and the run did not finish cleanly" for write failures only.
  - The trailer reads `imported N ticket(s)` / `repaired N row(s)`, followed by the receipt (and map) path.

- [ ] **Step 1: Write the failing tests.**

In `tests/import-runner.test.mjs`, replace the test `"staging goes through commitOrQueue under the \`import\` op — scoped to what it wrote, never git add -A"` (`:142-149`) with:

```js
test("BLZ-254: import --apply writes tickets, claims and its receipt, stages nothing and makes no commit", (t) => {
  const root = board(t);
  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"],
                   ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
    execFileSync("git", ["-C", root, ...a]);
  }
  const before = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const r = run(root, ["--apply", csvAt(root, row())]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ticketExists(root), true, "the ticket is written");
  assert.equal(execFileSync("git", ["-C", root, "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim(), "",
    "an import stages nothing (spec §5.5)");
  assert.equal(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), before,
    "an import makes no commit");
  assert.match(r.stdout, /^imported 1 ticket\(s\)$/m);
  assert.match(r.stdout, /receipt: import-receipts\//, "the receipt is still the run's record");
  assert.doesNotMatch(r.stdout + r.stderr, /queued|commit/i, "the trailer claims nothing about git");
});
```

Use the file's own helpers (`board`, `run`, `csvAt`, `row`, `ticketExists`). If `execFileSync` is not imported, add it to the `node:child_process` import. If `board(t)` already git-inits the root, drop the init loop and keep the `before`/`after` assertions.

In `tests/model/import-apply.test.mjs`:
1. Replace `describe("BLZ-629: staging", …)` (`:565-596`) whole with:

   ```js
   // BLZ-254 (spec §5.5): an import no longer stages. Its tickets (or rows), claims, receipt and
   // map are written as files; in fs mode the operator versions them, in db mode only the record
   // files are files at all. `applyImport` no longer takes a `stage` and no longer reports one.
   describe("BLZ-254: an import stages nothing", () => {
     test("the result reports what was written and carries no staging fields", async (t) => {
       const root = boardRoot(t);
       const plan = await planFor(root, cells({ id: "BLZ-1" }), cells({ id: "BLZ-2" }));
       const r = await applyImport(plan, ctxFor(root));
       assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
       assert.deepEqual(r.written, ["BLZ-1", "BLZ-2"]);
       assert.equal(r.files.filter((f) => f.endsWith(".md")).length, 2);
       for (const k of ["staged", "commit"]) {
         assert.equal(Object.hasOwn(r, k), false, `applyImport's result still carries \`${k}\``);
       }
     });

     test("on a git board the run leaves HEAD and the index untouched", async (t) => {
       const root = boardRoot(t, { git: true });
       for (const a of [["config", "user.email", "t@t.t"], ["config", "user.name", "t"],
                        ["commit", "-q", "--allow-empty", "-m", "seed"]]) {
         spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
       }
       const head = () => spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
       const before = head();
       const r = await applyImport(await planFor(root, cells({ id: "BLZ-1" })), ctxFor(root));
       assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
       assert.equal(head(), before, "no commit");
       assert.equal(spawnSync("git", ["-C", root, "diff", "--cached", "--name-only"], { encoding: "utf8" }).stdout.trim(), "",
         "nothing staged");
     });
   });
   ```
2. Delete `"exit 4 — every write landed and STAGING failed"` (`:347-356`). That condition no longer exists.
3. In `"exit 0 — a clean apply, with the trailer naming the port and whether the commit actually happened"` (`:376-386`), rename it to `"exit 0 — a clean apply, with a trailer that claims nothing about git"`. Replace its `runImport` call's second line `commitMode: "batch", stage: () => ({ ok: true, committed: false, queued: true }),` with nothing, and replace its last assertion with

   ```js
       assert.match(r.report, /imported 1 ticket\(s\)/);
       assert.doesNotMatch(r.report, /queued|commit/i,
         "BLZ-254: the board never commits, so the trailer must not talk about a commit");
   ```
4. Delete the `OP_LABEL` import (`:28`). Remove every `stage: …` key from the remaining calls (`:88`, `:224`, `:269`, `:284`, `:301`, `:315`), which are dead arguments once the parameter is gone. Then `rg -n "stage[:=]|OP_LABEL|commitMode" tests/model/import-apply.test.mjs` prints nothing.
5. The comment at `:124` ("the reverse order's residue is a missingClaimErrors ERROR on the operator's board") stays until Task 8.

In `tests/model/import-mapping-repair.test.mjs`:
- Delete the tests `"staging goes through commitOrQueue under a NEW \`import-repair\` op"` (`:452-466`) and `"every record written and staging failed is exit 4, not 0"` (`:468-476`).
- Add in their place:

  ```js
    test("BLZ-254: repair --apply writes its records and stages nothing", async (t) => {
      const { root } = await crashedAtRowTwo(t);
      const r = await runRepair({
        receipt: receiptPath(root), projectsDir: join(root, "projects"), dataRoot: root, apply: true,
      });
      assert.equal(r.exitCode, 0, r.report);
      assert.equal(mapLines(root).length, 2, "the writes landed");
      assert.match(r.report, /^repaired \d+ row\(s\)$/m);
      assert.doesNotMatch(r.report, /queued|commit|STAGING/i, "the trailer claims nothing about git");
    });
  ```

  If the old staging test's `exitCode` for this fixture was not 0 (check what `crashedAtRowTwo` + `apply: true` returned before, by reading the test above it), assert that same code.
- Delete the `OP_LABEL` import (`:24`), the `noStage` helper (`:84`) and every `stage: noStage` argument.

In `tests/db-mode-reads.test.mjs:32-56`, rename the test to `"import --apply writes through the db, writes (and never commits) its receipt, and a move can read the row"`. Replace the comment above it ("stageFor's POSITIVE half …") with `// BLZ-254: the tickets are rows; the receipt is a real file, written and NOT committed (spec §5.5).`, and replace

```js
    const committed = git("log", "-1", "--name-only", "--format=");
    assert.match(committed, new RegExp(`^${RECEIPT_DIR}/\\S+\\.jsonl$`, "m"),
      `the receipt is committed:\n${committed}`);
    assert.doesNotMatch(committed, /\.md$/m, `no ticket file is committed in db mode:\n${committed}`);
```

with

```js
    assert.equal(git("rev-list", "--count", "HEAD").trim(), "1", "the import makes no commit");
    const untracked = git("status", "--porcelain", "--untracked-files=all");
    assert.match(untracked, new RegExp(`^\\?\\? ${RECEIPT_DIR}/\\S+\\.jsonl$`, "m"),
      `the receipt is written, untracked:\n${untracked}`);
    assert.doesNotMatch(untracked, /\.md$/m, `no ticket file exists in db mode:\n${untracked}`);
```

In `tests/import-db-mode.test.mjs` (`:41`, `:73`, `:142`, `:163`), `tests/reserve-window.test.mjs:43`, `tests/markdown-round-trip.test.mjs:85` and `tests/helpers/csv-round-trip.mjs:55`, delete the `stage: () => (…)` argument (and `commitMode` where present). These are dead arguments.

- [ ] **Step 2: Run and watch them fail.**

```bash
node --test --test-timeout=120000 --import=./tests/setup/hang-watchdog.mjs tests/import-runner.test.mjs tests/model/import-apply.test.mjs tests/model/import-mapping-repair.test.mjs tests/db-mode-reads.test.mjs
```

Expected: FAIL. The new import-runner test sees a commit (default `per-op`). `applyImport`'s result still carries `staged`. The db-mode receipt is committed. The trailer matches `/commit/`.

- [ ] **Step 3: `scripts/model/import-apply.mjs`.**
1. Delete `import { commitOrQueue, commitSuffix } from "../commit-or-queue.mjs";` (`:58`).
2. In `applyImport`'s docblock (`:355-370`), delete the `@param ctx.stage …` lines (two) and change `@returns { exitCode, written, notWritten, files, staged, commit, errors }` to `@returns { exitCode, written, notWritten, files, errors } — BLZ-254: no staging (spec §5.5)`.
3. In its context destructuring (`:373-381`), delete `    stage = commitOrQueue,`, `    commitMode = "per-op",` and `    message = null,`.
4. Delete `  let commit = null;` (`:389`).
5. In every `return { … }` from `applyImport` (`:485-492`), delete `staged: false, commit: null, `.
6. Replace from `  // --- staging (§5.4). Scoped to exactly the files it wrote, never` (`:495`) through `  return { exitCode: 0, written, notWritten, files, staged: true, commit, errors: [] };` (`:516`) with:

   ```js
     // BLZ-254 (spec §5.5): staging is gone. Until then the run ended by handing exactly the files it
     // wrote (tickets, claims, receipt) to commitOrQueue under the `import` op, and a staging
     // failure was a third route to exit 4. The board never commits now: the files are written,
     // and in fs mode the operator versions them.
     return { exitCode: 0, written, notWritten, files, errors: [] };
   ```

   (The `if (files.length === 0) { return … }` just above it now returns the same shape; keep it.)
7. In `runImport`'s options (`:554-556`), delete `commitMode = "per-op",` from the `now = new Date(), commitMode = "per-op",` line (it becomes `now = new Date(),`), and `stage = commitOrQueue, ` from the next line (it becomes `appendReceipt = appendRegularFileSync,`).
8. In the call (`:653-655`), drop `stage, ` and `commitMode` from `projectsDir, dataRoot, receiptPath, writePort, onPair, stage, appendReceipt, commitMode,`.
9. In the trailer (`:665`), replace `` say("", `imported ${r.written.length} ticket(s)${r.commit ? commitSuffix(r.commit) : ""}`); `` with `` say("", `imported ${r.written.length} ticket(s)`); ``.
10. `rg -n "stage|commitMode|commitSuffix|staged" scripts/model/import-apply.mjs` prints only comments. Edit the `§5.4` comments that still describe staging to past tense with "(removed by BLZ-254)".

- [ ] **Step 4: `scripts/model/import-mapping.mjs`.**
1. Delete `import { commitOrQueue, commitSuffix } from "../commit-or-queue.mjs";` (`:48`).
2. In `runMappedImport`'s options (`:536-538`), delete `commitMode = "per-op"` and `stage = commitOrQueue`.
3. In its `applyImport` call (`:711-723`), drop `commitMode` from the first line. Delete the `// The map is a committed record (§6), so it is staged …` comment and the whole `stage: mapping.sourceIdColumn ? … : stage,` property.
4. Trailer (`:736`): `` say("", `imported ${r.written.length} ticket(s)`); ``.
5. `runRepair`'s docblock (`:788`): "staged through `commitOrQueue` under the `import-repair` op (§5.4)" becomes "written as files and never staged (BLZ-254, spec §5.5)". Delete `commitMode = "per-op"` and `stage = commitOrQueue` from its options (`:806-807`).
6. Replace the staging block (`:1004-1031`, from `  let commit = null;` through the closing `}` of `if (files.length) { … }`) with nothing, and the trailer (`:1033`) with `` say("", `repaired ${states.size - people.length} row(s)`); ``. Also edit the §5.2 precedence comment that explained "Staging failure wins", noting the case is gone (BLZ-254).

- [ ] **Step 5: `scripts/import-runner.mjs`.**
1. Delete `import { stageFor } from "./commit-or-queue.mjs";` (`:32`).
2. Delete `        commitMode: cfg.commitMode,` (`:208`) and `      commitMode: cfg.commitMode,` (`:235`). Replace `readStorage: rs.readStorage, stage: stageFor(rs.mode),` with `readStorage: rs.readStorage,`, and `readStorage: wp.readStorage, stage: stageFor(wp.mode),` with `readStorage: wp.readStorage,`.
3. If `cfg` now has no reads (`grep -n "cfg\." scripts/import-runner.mjs`), change `let cfg; try { cfg = loadConfig(…) }` to `try { loadConfig(…) }`, with the same comment as Task 3.
4. Fix the comments that say "staging keeps only the record files" or "staging goes by mode" (`:197-198`, `:229`): "BLZ-254: nothing is staged".

- [ ] **Step 6: Seam-closure (ledger rows 2107-2108, 2121-2122, 2142-2143).**

```js
  ["model/import-apply.mjs", ["fsAllocators", "commitOrQueue",
    "appendRegularFileSync", "mkdirSync", "unlinkSync"]],
```

→

```js
  ["model/import-apply.mjs", ["fsAllocators",   // BLZ-254: commitOrQueue removed — no staging
    "appendRegularFileSync", "mkdirSync", "unlinkSync"]],
```

```js
  ["model/import-mapping.mjs", ["appendRegularFileSync", "mkdirSync", "truncateSync",
    "commitOrQueue", "applyImport", "pruneReceipts"]],
```

→

```js
  ["model/import-mapping.mjs", ["appendRegularFileSync", "mkdirSync", "truncateSync",
    "applyImport", "pruneReceipts"]],   // BLZ-254: commitOrQueue removed — no staging
```

```js
  ["import-runner.mjs",
    ["resolvePorts", "stageFor", "runImport", "runMappedImport", "runRepair", "withImportLock"]],
```

→

```js
  // BLZ-254: stageFor removed — import stages nothing (spec §5.5).
  ["import-runner.mjs",
    ["resolvePorts", "runImport", "runMappedImport", "runRepair", "withImportLock"]],
```

The prose comments above these entries that justify `commitOrQueue` ("`commitOrQueue` is the staging front door", twice) each get a trailing `(removed by BLZ-254)`. Do **not** delete those sentences. A comment change that keeps the history readable is not an assertion change.

- [ ] **Step 7: Docs, run, commit.**

`docs/design/csv-import-and-export.md`:
- At the top of §5.4 "Staging", add:
  > **Amended 2026-10-13 (BLZ-254, spec §5.5): there is no staging.** The board never commits. An import writes its tickets (or, under db, rows), claims, receipt and map, and stops. In fs mode the operator versions them. The rest of this section is the historical design.
- In §5.1's exit-code table, delete ", **or** every write landed and staging failed" from the exit-4 row.
- Replace the paragraph starting "**Exit 0 does not mean "committed".**" with: "**Exit 0 means the writes finished.** Since BLZ-254 no import commits, on any board. The trailer names the receipt (and the map), which are the run's record."
- In §5.2, delete the `repair --apply: every write landed and staging failed` row and the "Staging failure wins" paragraph, leaving one line: "(The staging-failure precedence rule that stood here was removed with staging, BLZ-254.)"

`docs/guide/commands.md` `## import`: drop every sentence about staging or commits, and say once: "`--apply` writes and makes no commit (BLZ-254)."

```bash
node --test --test-timeout=120000 --import=./tests/setup/hang-watchdog.mjs tests/import*.test.mjs tests/model/import-*.test.mjs tests/db-mode-reads.test.mjs tests/reserve-window.test.mjs tests/markdown-round-trip.test.mjs tests/csv-round-trip.test.mjs tests/model/seam-closure.test.mjs
# THE DEBT STEP (Global Constraints) — run its block here
npm test 2>&1 | tail -9
git add scripts/model/import-apply.mjs scripts/model/import-mapping.mjs scripts/import-runner.mjs \
  tests/model/import-apply.test.mjs tests/model/import-mapping-repair.test.mjs tests/import-runner.test.mjs \
  tests/db-mode-reads.test.mjs tests/import-db-mode.test.mjs tests/reserve-window.test.mjs \
  tests/markdown-round-trip.test.mjs tests/helpers/csv-round-trip.mjs tests/model/seam-closure.test.mjs \
  scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md docs/design/csv-import-and-export.md docs/guide/commands.md
git commit -m "BLZ-687: blaze import stops staging; its records are written, not committed (spec §5.5)"
```

---
### Task 5: `blaze commit` and `blaze publish` are removed, with a named refusal

**Files:**
- Modify: `scripts/cli.mjs` (`:21-27` mutates comment, `:84-90` and `:96` table entries, `:110-132` dispatch, `:178-207` the schema-preflight comment and Set)
- Delete: `scripts/commit-runner.mjs`, `scripts/publish-runner.mjs`, `docs/operations/queue-store-migration.md`, `docs/operations/migrate-queue-store.sh`
- Create: `tests/cli-removed-commands.test.mjs`
- Modify tests: `tests/cli.test.mjs`, `tests/readonly.test.mjs`, `tests/schema-fail-loud-on-load.test.mjs`, `tests/temp-cleanup-guard.test.mjs`, `tests/model/seam-closure.test.mjs` (ledger row 956, and row 2044 with its comment sentence)
- Delete tests (every test in each spawns `commit-runner.mjs`/`publish-runner.mjs`, or pins the pending ledger only those runners drain):
  - `tests/commit-runner.test.mjs`, `tests/commit-runner-branch-guard.test.mjs`
  - `tests/commit-status.test.mjs`, `tests/commit-status-provenance.test.mjs`
  - `tests/commit-drain-concurrent-clear.test.mjs`, `tests/commit-drain-quarantine.test.mjs`, `tests/commit-settled-drain.test.mjs`
  - `tests/commit-four-working-copies.test.mjs`, `tests/commit-queueops-count.test.mjs`, `tests/commit-session-queue-scope.test.mjs`, `tests/commit-worktree-provenance.test.mjs`
  - `tests/flush-real-blaze-commit.test.mjs`, `tests/publish.test.mjs`, `tests/queue-store-migration-provenance.test.mjs` (runs the deleted `.sh`)
  - `tests/pending-ledger.test.mjs`, `tests/pending-ledger-queue-root.test.mjs` (both spawn `commit-runner.mjs`; their module goes in Task 6)
- Docs: `docs/guide/commands.md` (`## commit` → `## Removed commands`; `## Help`; `## Commit modes`), `README.md:129`, `docs/schema-customization.md:362-366`, `docs/schema-versioning.md:44-48`

**Interfaces:**
- Produces: `REMOVED_COMMANDS` in `cli.mjs` (`{ commit: "…", publish: "…" }`). `blaze commit …` / `blaze publish …` write one stderr line, `blaze: \`<cmd>\` was removed in 0.9.0 (BLZ-254) — <reason>`, and exit 1. `SUBCOMMANDS` holds 22 entries; `SCHEMA_PREFLIGHT_EXEMPT` is `["audit", "init"]`.

- [ ] **Step 1: Write the failing test.** Create `tests/cli-removed-commands.test.mjs`:

```js
// tests/cli-removed-commands.test.mjs — BLZ-687 (BLZ-254 PR D, spec §5.5).
//
// `blaze commit` and `blaze publish` are deleted. A removed verb gets a NAMED refusal, not the
// unknown-command fallback (a usage dump on stdout and exit 1 with no sentence): its callers
// — the nightly flush Job until C2 deletes it, and every agent whose instructions still say
// "run blaze commit" — must learn what changed and what to do, not that they mistyped.
// The refusal fires before --help, before the read-only gate and before remote mode, so
// every spelling gets the same sentence, and nothing on disk moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(REPO, "scripts", "cli.mjs");

function board(t) {
  const root = mkdtempSync(join(tmpdir(), "blz687-removed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"]]) {
    execFileSync("git", ["-C", root, ...a]);
  }
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "OBA", projects: ["OBA"] }));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

function run(root, args, extraEnv = {}) {
  const env = { ...process.env };
  for (const k of ["BLAZE_WRITE_PORT", "BLAZE_READONLY", "BLAZE_REMOTE_URL", "BLAZE_TOKEN", "BLAZE_PROJECTS_DIR"]) delete env[k];
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8" });
}

const SPELLINGS = [
  ["commit", [], {}], ["commit", ["--all"], {}], ["commit", ["--status"], {}], ["commit", ["--help"], {}],
  ["commit", [], { BLAZE_READONLY: "1" }],
  ["commit", [], { BLAZE_REMOTE_URL: "http://127.0.0.1:9", BLAZE_TOKEN: "t" }],
  ["publish", [], {}], ["publish", ["--help"], {}], ["publish", [], { BLAZE_READONLY: "1" }],
  ["publish", [], { BLAZE_REMOTE_URL: "http://127.0.0.1:9", BLAZE_TOKEN: "t" }],
];

for (const [cmd, args, env] of SPELLINGS) {
  test(`blaze ${[cmd, ...args].join(" ")} ${Object.keys(env).join("+") || ""} is refused by name`, (t) => {
    const root = board(t);
    const head = () => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const before = head();
    const r = run(root, [cmd, ...args], env);
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`^blaze: \`${cmd}\` was removed in 0\\.9\\.0 \\(BLZ-254\\)`, "m"));
    assert.match(r.stderr, /BLAZE_WRITE_PORT=db/, "the refusal names the replacement for concurrent writers");
    assert.doesNotMatch(r.stdout, /usage: blaze/, "a removed verb is not the unknown-command fallback");
    assert.equal(head(), before, "nothing moved");
  });
}

test("the usage listing no longer offers commit or publish", () => {
  const r = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /^\s+(commit|publish)\s/m);
});
```

- [ ] **Step 2: Run it.** `node --test --import=./tests/setup/hang-watchdog.mjs tests/cli-removed-commands.test.mjs`. Expected: FAIL. `blaze commit` runs the real runner, `--help` exits 0, and the usage lists `commit`.

- [ ] **Step 3: `scripts/cli.mjs`.**
1. Delete the `commit:` entry and its four-line BLZ-499 comment (`:84-90`), and the `publish:` entry (`:96`).
2. After the `SUBCOMMANDS` object, add:

   ```js
   // BLZ-254 (spec §5.5): verbs this engine no longer has, and what to do instead. A removed verb
   // is REFUSED BY NAME rather than falling through to the unknown-command usage dump, the same
   // rule config's REMOVED_KEYS applies to a key (BLZ-298): its callers (a flush Job, an agent
   // whose instructions predate the removal) must learn what changed, not that they mistyped.
   const REMOVED_COMMANDS = {
     commit: "the board no longer commits",
     publish: "there are no pending queues to sweep and no flush to trigger",
   };
   const REMOVED_ADVICE = "In fs mode, version the board's files yourself with git; for more than one "
     + "writer, use db mode (BLAZE_WRITE_PORT=db).";
   ```
3. Directly after `const [cmd, ...rest] = process.argv.slice(2);` (before the `--help` checks), add:

   ```js
   // Before --help, the read-only gate and remote mode, so every spelling gets the same sentence.
   if (cmd !== undefined && Object.hasOwn(REMOVED_COMMANDS, cmd)) {
     console.error(`blaze: \`${cmd}\` was removed in 0.9.0 (BLZ-254) — ${REMOVED_COMMANDS[cmd]}. ${REMOVED_ADVICE}`);
     process.exit(1);
   }
   ```
4. Fix the `--help` comment at `:113-115`: "`blaze commit --help`" becomes "`blaze move --help`".
5. The schema preflight (`:178-207`):
   - "THREE EXEMPTIONS" → "TWO EXEMPTIONS".
   - Delete the `commit —` bullet (three lines).
   - "That leaves 21 of the 24 subcommands" → "That leaves 20 of the 22 subcommands".
   - Change the Set to `new Set(["audit", "init"])`.
   - Add one comment line: `// BLZ-254: \`commit\` was the third exemption; the verb is gone.`
   - Keep the stated-count history sentence ("the list said two while the Set below held three") as it is. It is history, and `tests/cli.test.mjs` pins the arithmetic.
6. The mutates comment at `:21-27`: "`start` runs the supervisor, which drives the groomer loop (git-commits)" stays true (Finding 6), so leave it. "`reconcile` defaults to a dry-run but `--apply` commits" becomes "… `--apply` writes".
7. The BLZ-499 comment at `:143-146` ("today only `blaze commit --status`") becomes "today `blaze matrices --check`".

- [ ] **Step 4: Delete the runners, their tests and the queue-store procedure.**

```bash
git rm scripts/commit-runner.mjs scripts/publish-runner.mjs \
  docs/operations/queue-store-migration.md docs/operations/migrate-queue-store.sh \
  tests/commit-runner.test.mjs tests/commit-runner-branch-guard.test.mjs tests/commit-status.test.mjs \
  tests/commit-status-provenance.test.mjs tests/commit-drain-concurrent-clear.test.mjs \
  tests/commit-drain-quarantine.test.mjs tests/commit-settled-drain.test.mjs \
  tests/commit-four-working-copies.test.mjs tests/commit-queueops-count.test.mjs \
  tests/commit-session-queue-scope.test.mjs tests/commit-worktree-provenance.test.mjs \
  tests/flush-real-blaze-commit.test.mjs tests/publish.test.mjs \
  tests/queue-store-migration-provenance.test.mjs tests/pending-ledger.test.mjs \
  tests/pending-ledger-queue-root.test.mjs
```

`package.json`'s `"commit": "node scripts/commit-runner.mjs"` npm script is deleted too (`scripts` block, `:33`).

- [ ] **Step 5: The surviving tests.**
- `tests/cli.test.mjs`:
  - In `"blaze --help prints the full usage listing …"`, the name list becomes `["reconcile", "sprint", "matrices", "migrate", "rollup"]`.
  - Replace `"blaze commit --help prints subcommand help, exits 0, and never spawns the runner"` (`:34-56`) with the same test for `blaze move --help`: same fixture, `appendEntry` seeding, byte-identical queue and unmoved HEAD. `pending-ledger.mjs` still exists here; Task 6 rewrites this test's seed. Name it `"blaze move --help prints subcommand help, exits 0, and never spawns the runner"`.
  - The schema-preflight arithmetic test needs no edit. It re-derives TWO / 20 of 22 from the code.
- `tests/readonly.test.mjs`: delete the three tests `"BLAZE_READONLY=1 blaze commit: …"` (`:108-116`), `"BLAZE_READONLY=1 node scripts/commit-runner.mjs (bypassing cli.mjs) also refuses and commits nothing"` (`:180-215`, with its comment block) and `"BLAZE_READONLY=1 node scripts/commit-runner.mjs --help still works"` (`:217-226`). Removed commands are covered by `tests/cli-removed-commands.test.mjs`, including under `BLAZE_READONLY`.
- `tests/schema-fail-loud-on-load.test.mjs`: replace `"\`blaze commit\` is exempt — it flushes git and reads no schema"` (`:169-178`) with

  ```js
    test("BLZ-254: `blaze commit` is no longer an exemption — it is a removed verb, refused before the preflight", () => {
      const root = board(MALFORMED);
      try {
        const r = run(root, ["commit"]);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /`commit` was removed in 0\.9\.0/);
        assert.doesNotMatch(r.stderr, /is not valid/, "the removal refusal comes first, so the schema is never judged");
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  ```
- `tests/temp-cleanup-guard.test.mjs`: delete `"BLZ-603: tests/commit-settled-drain.test.mjs — the file the ticket names — has none left"` (`:88-93`). Its subject file is deleted. The equality ratchet over every remaining file still holds every leak (`scripts/ci/temp-cleanup-guard.mjs`'s header still names the file as BLZ-603's origin; leave that history).
- `tests/model/seam-closure.test.mjs`:
  - Ledger row 956: replace `  ["commit-runner.mjs", { writes: [], sanctioned: [], inert: [] }],   // a CLI verb, no exports` with `  // BLZ-254: commit-runner.mjs (blaze commit) deleted.`
  - Ledger row 2044: delete `  ["commit-runner.mjs", ["acquireLock", "releaseLock", "clearLedger", "quarantineDropped"]],`, and in the comment above it replace the sentence "`blaze commit` owns the commit lock and drains the ledger it has just committed; the quarantine sidecar is BLZ-531's." with `// BLZ-254: commit-runner.mjs deleted (blaze commit).` (the commit-or-queue and serve-commit sentences stay until Task 6).

- [ ] **Step 6: Docs.**
- `docs/guide/commands.md`: replace the whole `## commit` section (`:514-704`, through the end of "The subject line counts TICKETS…") with:

  ```markdown
  ## Removed commands

  | Command | Removed in | Instead |
  |---|---|---|
  | `blaze commit` | 0.9.0 (BLZ-254) | Nothing to flush: no verb queues or commits any more. On a file board, commit the changed files yourself. |
  | `blaze publish` | 0.9.0 (BLZ-254) | Nothing to sweep and no flush Job to trigger. For more than one writer, run the board in db mode (`BLAZE_WRITE_PORT=db`) and write to it over HTTP ([Remote mode](#remote-mode)). |

  Both are refused by name, on stderr, with exit 1, whatever flags follow. The last release that has them is `@hjr15/blaze-board@0.8.0`.
  ```

  Also: in `## Help`, "`blaze commit --help` describes `commit`, it does not flush" becomes "`blaze move --help` describes `move`, it does not move anything". Replace `## Commit modes` (`:995-1004`) with one sentence: "`commitMode` and `BLAZE_COMMIT_MODE` are ignored since 0.9.0 (a one-time warning); the board never commits." Delete the `BLAZE_SESSION` row and mark the `BLAZE_COMMIT_MODE` row "ignored since 0.9.0" in of the environment-variable table if present (`grep -n "BLAZE_COMMIT_MODE\|BLAZE_SESSION" docs/guide/commands.md`).
- `README.md:129`: delete the `blaze commit` table row.
- `docs/schema-customization.md:362-366`: "There are two more exemptions — **three in all** — **`blaze init`**, …, and **`blaze commit`**, … That leaves **19 of the 22** subcommands" becomes "There is one more exemption — **two in all** — **`blaze init`**, which runs before a board exists. That leaves **20 of the 22** subcommands running the check."
- `docs/schema-versioning.md:46-48`: delete the sentence "`blaze commit` is the one command that is genuinely schema-agnostic … stays uncovered by design."

- [ ] **Step 7: Run, commit.**

```bash
node --test --test-timeout=120000 --import=./tests/setup/hang-watchdog.mjs tests/cli*.test.mjs tests/readonly.test.mjs tests/schema-fail-loud-on-load.test.mjs tests/temp-cleanup-guard.test.mjs tests/model/seam-closure.test.mjs tests/package.test.mjs tests/shipped-doc-links.test.mjs
# THE DEBT STEP (Global Constraints) — run its block here
npm test 2>&1 | tail -9
rg -n "commit-runner|publish-runner" scripts tests README.md AGENTS.md docs/guide   # only BLZ-254 comments
git add scripts/cli.mjs package.json tests/cli-removed-commands.test.mjs tests/cli.test.mjs tests/readonly.test.mjs \
  tests/schema-fail-loud-on-load.test.mjs tests/temp-cleanup-guard.test.mjs tests/model/seam-closure.test.mjs \
  scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md docs/guide/commands.md README.md docs/schema-customization.md docs/schema-versioning.md
git commit -m "BLZ-687: remove blaze commit and blaze publish, refused by name (spec §5.5)"
```

If `tests/shipped-doc-links.test.mjs` fails on a link to the deleted `docs/operations/queue-store-migration.md`, the link is in `AGENTS.md`'s Commit-modes section. Task 9 rewrites that section, so do that one link's removal here: delete the sentence "migrate them with [the queue-store migration procedure](…)".

---

### Task 6: delete the ceremony modules; `commit-lock.mjs` → `dir-lock.mjs`

**Files:**
- Delete: `scripts/commit-or-queue.mjs`, `scripts/serve-commit.mjs`, `scripts/pending-ledger.mjs`, `scripts/commit-summary.mjs`, `scripts/branch-guard.mjs`
- Rename + trim: `scripts/commit-lock.mjs` → `scripts/dir-lock.mjs` (`git mv`)
- Modify: `scripts/model/import-lock.mjs` (`:5-38` comment and import), `scripts/readonly.mjs` (`:1-25` comments)
- Rename + trim test: `tests/commit-lock.test.mjs` → `tests/dir-lock.test.mjs` (`git mv`)
- Modify tests: `tests/read-path-residue-fifo.test.mjs` (the BLZ-512 describe), `tests/model/import-lock.test.mjs` (comments), `tests/board-overstatement-guards.test.mjs` (last BLZ-422 remnant), `tests/cli.test.mjs` (`--help` seed), `tests/readonly.test.mjs` (queue snapshots), `tests/model/seam-closure.test.mjs` (every remaining ledger row)
- Delete tests: `tests/commit-or-queue.test.mjs`, `tests/serve-commit.test.mjs`

**Interfaces:**
- Produces: `scripts/dir-lock.mjs` exports exactly `acquireDirLock(dir, opts) → { ok, owner? }` and `releaseDirLock(dir)`, unchanged in behaviour (BLZ-640). Nothing exports `acquireLock`, `releaseLock`, `lockPath`, `commitOrQueue`, `stageFor`, `commitSuffix`, `commitFile`, `appendEntry`, `OP_LABEL` or `checkBranch` any more.

- [ ] **Step 1: The rename, test first.**

```bash
git mv tests/commit-lock.test.mjs tests/dir-lock.test.mjs
```

In `tests/dir-lock.test.mjs`, change the import to `import { acquireDirLock, releaseDirLock } from "../scripts/dir-lock.mjs";`. Rewrite each of the six tests to take a lock **directory** (`const dir = join(root, ".blaze", "x.lock")`) and call `acquireDirLock(dir, opts)` / `releaseDirLock(dir)` where they called `acquireLock(root, opts)` / `releaseLock(root)`, with paths built from `dir` where they used `lockPath(root)`. Every assertion stays as it is: same retries, same staleness arms (dead pid, aged-out, NaN ts, ownerless grace). Header: `// tests/dir-lock.test.mjs — BLZ-640's lock mechanism, kept by BLZ-254 for model/import-lock.mjs. Was tests/commit-lock.test.mjs; the commit-lock POLICY it also wrapped is deleted (spec §5.5).`

Run `node --test --import=./tests/setup/hang-watchdog.mjs tests/dir-lock.test.mjs`. Expected: FAIL, `Cannot find module '…/scripts/dir-lock.mjs'`.

- [ ] **Step 2: Make it pass.**

```bash
git mv scripts/commit-lock.mjs scripts/dir-lock.mjs
```

In `scripts/dir-lock.mjs`:
- Replace the header (`:1-13`) with:

  ```js
  // scripts/dir-lock.mjs — an advisory lock over a caller-supplied DIRECTORY: an atomically
  // mkdir'ed directory holding owner.json {pid, session, ts}, bounded retry, and theft of a lock
  // whose owner is dead, aged out, or long ownerless. Zero-dependency. (BLZ-640)
  //
  // BLZ-254 (spec §5.5): this was scripts/commit-lock.mjs, which also bound the mechanism to the
  // board's commit lock (`acquireLock`/`releaseLock` over `.blaze/commit.lock/`). The board no
  // longer commits, so that policy is deleted. The mechanism stays because
  // `scripts/model/import-lock.mjs` (out of BLZ-254's scope, guarding `blaze import --apply` in
  // every mode) is built on it, and design §8 item 8 forbids a second copy of the staleness logic.
  ```
- Delete `lockPath` (`:23-25`), and `acquireLock`/`releaseLock` with their docblock (`:131-143`). Fix the BLZ-512 comment (`:17-20`) to name `acquireDirLock`, and drop its "every board write behind the lock" clause.
- Keep the `node:fs` and `node:path` imports the mechanism uses (`mkdirSync, rmSync, writeFileSync, statSync`; `join, dirname, basename`).

In `scripts/model/import-lock.mjs`, change `:38` to `import { acquireDirLock, releaseDirLock } from "../dir-lock.mjs";`. In the header comment (`:5-22`), replace each `commit-lock.mjs` with `dir-lock.mjs`, and delete the sentences that contrast the import lock with "`acquireLock` … taken inside `commitFile`" and with "`commitOrQueue` returns from the ledger". Replace them with: "Since BLZ-254 there is no commit lock to contrast it with; this is the only policy on dir-lock.mjs's mechanism."

Run `tests/dir-lock.test.mjs` and `tests/model/import-lock.test.mjs` (plus `tests/import-lock-contention.test.mjs`). Expected: PASS. In `tests/model/import-lock.test.mjs`, comments only: `commit-lock.mjs` → `dir-lock.mjs`, and "`tests/commit-lock.test.mjs`" → "`tests/dir-lock.test.mjs`". Its sentences contrasting a 60 s commit age-out describe a deleted policy, so mark them `(the commit lock, deleted by BLZ-254)`. Change no assertion.

- [ ] **Step 3: Delete the five modules and their two unit tests.**

```bash
git rm scripts/commit-or-queue.mjs scripts/serve-commit.mjs scripts/pending-ledger.mjs \
  scripts/commit-summary.mjs scripts/branch-guard.mjs \
  tests/commit-or-queue.test.mjs tests/serve-commit.test.mjs
```

`scripts/readonly.mjs`: replace the header's "imported by cli.mjs (the dispatch gate) and commit-or-queue.mjs + pending-ledger.mjs (defence-in-depth …)" with "imported by cli.mjs (the dispatch gate) and by every mutating runner and serve.mjs (defence-in-depth …)". In `assertWritable`'s comment, replace "callers that reach commitOrQueue/appendEntry directly" with "runners and handlers reached without cli.mjs".

- [ ] **Step 4: The surviving tests that still import a deleted module.** `rg -ln "commit-or-queue|serve-commit|pending-ledger|commit-summary|branch-guard|commit-lock" tests` must list only the files below, and each is fixed as shown:
- `tests/board-overstatement-guards.test.mjs`: delete the whole remaining `describe("BLZ-422: a no-op is never reported as a commit", …)`. Its two surviving tests are `commitFile`'s empty-diff no-op (module deleted) and Task 1's `"BLZ-254: an applied reconcile names its store and never claims a commit"`. **Move that second test** into `describe("BLZ-447: …")` before deleting the describe. Delete the `commitFile` and `commitOrQueue` imports and the now-unused `gitRepo`/`head` helpers if nothing else calls them (`grep -n "gitRepo()\|head(" tests/board-overstatement-guards.test.mjs`). Update the header comment's list of tickets (drop BLZ-427 and the BLZ-442 note about `commitOrQueue`).
- `tests/cli.test.mjs` (the `move --help` test from Task 5): delete the `appendEntry`/`ledgerPath` import and the queue seeding. The test keeps "exits 0, prints the usage, HEAD unmoved, and the ticket tree byte-identical" (snapshot `projects/OBA/backlog/OBA-1.md` before and after).
- `tests/readonly.test.mjs`:
  - Delete the `appendEntry, ledgerPath` import.
  - `board()` drops `commitMode: "batch"` from its config. Its comment becomes "A throwaway git-backed board with one ticket, so tree and HEAD assertions are meaningful."
  - In `assertRefusedAndUntouched`, delete the `appendEntry(...)` seed, the `queue`/`beforeQueue` lines and the "queue file must be byte-identical" assertion.
  - Rename each test from "tree/queue/HEAD" to "tree/HEAD".
  - Header: "rather than at commitOrQueue (too late — …)" becomes "rather than in each runner alone (move.mjs and friends write before anything else could refuse)".
- `tests/read-path-residue-fifo.test.mjs` `describe("BLZ-512: commit-lock's readOwner is the site the inventory missed", …)` (`:162-…`): rename to `"BLZ-512: dir-lock's readOwner is the site the inventory missed"`. Its probe imports `acquireDirLock` from `${mod("dir-lock.mjs")}` and acquires a lock directory whose `owner.json` is a FIFO, where it used `acquireLock(root)` with `.blaze/commit.lock/owner.json`. Keep every assertion (no hang, the named `NotARegularFileError` refusal). In the header (`:13-16`), `scripts/commit-lock.mjs` becomes `scripts/dir-lock.mjs`. Delete the `scripts/pending-ledger.mjs IS ALREADY GUARDED` bullet and replace it with `// (pending-ledger.mjs, the other site here, was deleted by BLZ-254.)`. If a test in that file drives `pending-ledger.mjs` itself, delete that test, because the module is gone.
- `tests/model/import-lock.test.mjs`: comments only (Step 2).
- `tests/reconcile-delivery-truth.test.mjs:252`: comment only. "`scripts/commit-runner.mjs` writes every batch board commit's body as …" becomes "`blaze commit` (deleted by BLZ-254) wrote every batch board commit's body as …". The rule it explains still guards the historical commits on every board.

- [ ] **Step 5: Seam-closure, every remaining ledger row (99, 94, 875-887, 960-963, 1952, 2040-2046, 2129-2134, 2530, 2531, 2567).** Apply exactly the "After" column of the ledger table at the top of this plan. Spelled out:

```js
    "model/ids.mjs", "model/claims.mjs",  // the fs allocator — kept, BLZ-254 D1
```

```js
    "dir-lock.mjs", "reindex.mjs", "supervisor.mjs",  // BLZ-254: pending-ledger.mjs deleted; commit-lock.mjs → dir-lock.mjs
```

```js
  // BLZ-254: pending-ledger.mjs deleted (spec §5.5).
  // The lock mechanism: a lock DIRECTORY under a caller-supplied path, taken and released.
  // BLZ-640 added `acquireDirLock`/`releaseDirLock` — the SAME mkdir +
  // owner.json + dead-PID-theft mechanism over a caller-supplied lock
  // DIRECTORY, which is what design §8 item 8's "this reuses that mechanism
  // rather than a second one" asks for. They create and remove a directory, so
  // they are writes.
  // BLZ-254: commit-lock.mjs → dir-lock.mjs; the commit-lock policy (acquireLock, releaseLock, lockPath) is deleted.
  ["dir-lock.mjs", { writes: ["acquireDirLock", "releaseDirLock"],
    sanctioned: [], inert: [] }],
```

```js
  // BLZ-254: commit-or-queue.mjs and serve-commit.mjs deleted (spec §5.5).
```

(in place of the BLZ-670 comment and the two WRITE_MAP entries at 960-963)

```js
  ["dir-lock.mjs", "*"],  // BLZ-254: pending-ledger.mjs deleted; commit-lock.mjs → dir-lock.mjs
```

```js
  // BLZ-254: commit-runner.mjs, commit-or-queue.mjs and serve-commit.mjs deleted (spec §5.5).
```

(in place of the comment's second paragraph and the two entries left at 2045-2046)

```js
  // BLZ-640. The import lock reaches node:fs through `dir-lock.mjs`'s   // BLZ-254: renamed from commit-lock.mjs
```

```js
    // BLZ-254: pending-ledger.mjs deleted (its `{ appendEntry }` row).
    ["dir-lock.mjs", "{ acquireDirLock }", "acquireDirLock"],  // BLZ-254: commit-lock.mjs → dir-lock.mjs
```

```js
    // BLZ-254: pending-ledger.mjs deleted (its `{ readForDrain, listQueues }` row).
```

Then check that nothing else in the file names a deleted module: `rg -n "commit-or-queue|serve-commit|pending-ledger|commit-runner|commit-lock|commitOrQueue|stageFor|commitFile|acquireLock|releaseLock|appendEntry|clearLedger|quarantineDropped|readForDrain|listQueues" tests/model/seam-closure.test.mjs`. The only hits allowed are `// BLZ-254` lines and the round-5 history prose at `:273`. Then **prove no assertion was weakened**:

```bash
git diff 3a0ac78 -- tests/model/seam-closure.test.mjs | grep '^[-+]' | grep -v '^[-+][-+]' | grep -c 'assert'   # must print 0
```

(no `assert` line was added or removed), and run the file. It must pass with the **same test count** as at baseline: compare `node --test --import=./tests/setup/hang-watchdog.mjs tests/model/seam-closure.test.mjs 2>&1 | grep '^ℹ tests'` with the same command in a throwaway worktree of `3a0ac78` (`git worktree add <scratchpad>/blz687-base 3a0ac78`, then `git worktree remove` it).

- [ ] **Step 6: The tree is clean of the deleted names.**

```bash
rg -n "commit-or-queue|serve-commit|pending-ledger|commit-summary|branch-guard|commit-lock|commit-runner|publish-runner|reconcile-commit-report|write-outcome" scripts tests
rg -n "\b(commitOrQueue|stageFor|commitSuffix|commitFile|acquireLock|releaseLock|appendEntry|OP_LABEL|summarizeEntries|checkBranch|commitOutcomeFrom|applySummary|writeOutcome)\b" scripts tests
```

Both may print only `// BLZ-254` comment lines and prose comments that describe history. Every hit in executable code is a defect. (Spec §6, "Deletion": "`rg` finds no reference to a deleted module.")

- [ ] **Step 7: Run, commit.**

```bash
node --test --test-timeout=120000 --import=./tests/setup/hang-watchdog.mjs tests/dir-lock.test.mjs tests/model/import-lock.test.mjs tests/import-lock-contention.test.mjs tests/read-path-residue-fifo.test.mjs tests/readonly.test.mjs tests/cli.test.mjs tests/board-overstatement-guards.test.mjs tests/model/seam-closure.test.mjs tests/groomer-containment.test.mjs
# THE DEBT STEP (Global Constraints) — run its block here
npm test 2>&1 | tail -9
git add scripts/dir-lock.mjs scripts/model/import-lock.mjs scripts/readonly.mjs tests/dir-lock.test.mjs \
  tests/read-path-residue-fifo.test.mjs tests/model/import-lock.test.mjs tests/board-overstatement-guards.test.mjs \
  tests/cli.test.mjs tests/readonly.test.mjs tests/reconcile-delivery-truth.test.mjs tests/model/seam-closure.test.mjs \
  scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md
git commit -m "BLZ-687: delete the commit ceremony modules; commit-lock.mjs → dir-lock.mjs (spec §5.5)"
```

`tests/groomer-containment.test.mjs` is in the run on purpose. Its "a .blaze/commit.lock directory that wedges every other Blaze write" case still has to be **refused and removed** as an out-of-bounds write by the groomer. That test asserts the groomer's containment, not the lock, so it stays unchanged. Its comment's claim that the lock "wedges every other Blaze write" is now history. Add `(it did, before BLZ-254)`.

---
### Task 7: `commitMode` is ignored with a one-time warning (operator ruling, 2026-10-18)

**Ruling.** Not a hard refusal. A deployed ConfigMap or blaze-pm config that still carries the key must never crash-loop the pod (the `provider` outage shape). When `commitMode` is present, in the file or as `BLAZE_COMMIT_MODE`, `loadConfig` warns **once per process** and ignores it.

**`SCHEMA_VERSION` stays 2.** Warn-and-ignore removes nothing from the set of configs that load, so nothing in the contract breaks. ADR-0002 bumps only for a breaking change. BLZ-298's bump accompanied *refusals*, and this is not one. A bump would also make every board stamped `3` unloadable by the 0.8.0 engine, for no gain. `REMOVED_KEYS` is not touched. This is a deliberate, recorded exception to BLZ-298's "never drop silently" rule: the drop is not silent, it warns.

**Files:**
- Modify: `scripts/config.mjs` (`:30` default, a module-level `let` flag, the warn after `checkSchemaVersion(file)` at `:194`, `:268-276` BLZ-461 comment, `:305` the env override), `scripts/ci/smoke.sh:22`
- Create: `tests/config-commitmode-ignored.test.mjs`
- Modify tests: `tests/config.test.mjs:131-151`, and every test that writes `commitMode` into a config only to choose a commit mode (Step 3)
- Fixtures: **unchanged**. `board-gate-real-shape` and `legacy-board` keep `"commitMode"`, so they now exercise the ignore path, as the real boards do until the post-merge cleanup.
- Docs: `docs/guide/schema.md:110,130`, `docs/schema-versioning.md` (one bullet), `AGENTS.md` (Configuration paragraph, BLZ-461 paragraph; also fix the stale "(currently `1..1`)" → "(currently `1..2`)")

**Interfaces:**
- Produces: `loadConfig` never sets `cfg.commitMode`. If the raw file has the key (any value, `null` included) or `env.BLAZE_COMMIT_MODE !== undefined`, it writes exactly once per process to stderr: `blaze: warning: commitMode is ignored since 0.9.0 — the board never commits; remove it`. `__resetCommitModeWarningForTests()` is exported for tests that need the once-only behaviour per case.

- [ ] **Step 1: Write the failing tests.** Create `tests/config-commitmode-ignored.test.mjs`:

```js
// tests/config-commitmode-ignored.test.mjs — BLZ-687 (BLZ-254 PR D), operator ruling 2026-10-18.
//
// `commitMode` chose how the board committed; the board no longer commits. A config that still
// carries it (the deployed ConfigMap, blaze-pm's own config, any older board) must keep LOADING —
// a refusal there crash-loops the pod — so the key is ignored with ONE warning per process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = pathToFileURL(join(REPO, "scripts", "config.mjs")).href;
const serve = pathToFileURL(join(REPO, "scripts", "serve.mjs")).href;
const WARNING = "blaze: warning: commitMode is ignored since 0.9.0 — the board never commits; remove it";

function board(t, cfg) {
  const root = mkdtempSync(join(tmpdir(), "blz687-cm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "projects", "OBA", "defined"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "defined", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\n---\n\nbody\n");
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify(cfg));
  return root;
}
// A fresh process per case, so "once per process" is observable and no module state leaks.
function node(src, env = {}) {
  const e = { ...process.env, ...env };
  for (const k of ["BLAZE_WRITE_PORT", "BLAZE_READONLY", "BLAZE_REMOTE_URL", "BLAZE_TOKEN"]) delete e[k];
  if (!("BLAZE_COMMIT_MODE" in env)) delete e.BLAZE_COMMIT_MODE;
  return spawnSync(process.execPath, ["--input-type=module", "-e", src], { env: e, encoding: "utf8" });
}
const count = (s) => s.split(WARNING).length - 1;

for (const value of ["batch", "per-op", null]) {
  test(`commitMode: ${JSON.stringify(value)} loads, is ignored, and warns exactly once`, (t) => {
    const root = board(t, { key: "OBA", projects: ["OBA"], commitMode: value });
    const r = node(`import { loadConfig } from ${JSON.stringify(config)};
      const a = loadConfig({ root: ${JSON.stringify(root)}, env: {} });
      const b = loadConfig({ root: ${JSON.stringify(root)}, env: {} });
      console.log(JSON.stringify([Object.hasOwn(a, "commitMode"), Object.hasOwn(b, "commitMode"), a.key]));`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [false, false, "OBA"]);
    assert.equal(count(r.stderr), 1, `expected the warning exactly once, stderr was ${JSON.stringify(r.stderr)}`);
  });
}

test("BLAZE_COMMIT_MODE is ignored with the same single warning", (t) => {
  const root = board(t, { key: "OBA", projects: ["OBA"] });
  const r = node(`import { loadConfig } from ${JSON.stringify(config)};
    const c = loadConfig({ root: ${JSON.stringify(root)}, env: { BLAZE_COMMIT_MODE: "batch" } });
    console.log(Object.hasOwn(c, "commitMode"));`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "false");
  assert.equal(count(r.stderr), 1);
});

test("a board without commitMode loads silently", (t) => {
  const root = board(t, { key: "OBA", projects: ["OBA"] });
  const r = node(`import { loadConfig } from ${JSON.stringify(config)};
    loadConfig({ root: ${JSON.stringify(root)}, env: {} });`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(r.stderr), 0);
});

test("the board server STARTS and serves on a config that still says commitMode: batch (no crash-loop)", (t) => {
  const root = board(t, { key: "OBA", projects: ["OBA"], commitMode: "batch" });
  const r = node(`import { startServer } from ${JSON.stringify(serve)};
    const s = startServer({ projectsDir: ${JSON.stringify(join(root, "projects"))}, root: ${JSON.stringify(root)}, port: 0 });
    s.once("listening", async () => {
      const res = await fetch("http://127.0.0.1:" + s.address().port + "/");
      console.log(res.status);
      s.close(); process.exit(0);
    });`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "200", `the board must serve, got ${r.stdout} / ${r.stderr}`);
  assert.equal(count(r.stderr), 1, "and say once that the key is ignored");
});
```

In `tests/config.test.mjs`, delete the three tests at `:131-151` ("commitMode defaults to per-op", "commitMode is read from blaze.config.json", "BLAZE_COMMIT_MODE env overrides the file"). They pin behaviour the ruling removes, and the new file covers what replaces it. The `withConfig({ …, commitMode: "batch" })` at `:285` stays: it mirrors the legacy fixture, which keeps the key.

Run `node --test --import=./tests/setup/hang-watchdog.mjs tests/config-commitmode-ignored.test.mjs`. Expected: FAIL. `commitMode` is present on the config and no warning is printed. The server test may pass already; it is the guard that the ruling exists for.

- [ ] **Step 2: Implement (`scripts/config.mjs`).**
1. Delete `  commitMode: "per-op",` from `DEFAULTS` (`:30`).
2. Near the top of the module (after the imports), add:

   ```js
   // BLZ-254 (PR D, operator ruling 2026-10-18): `commitMode` chose how the board committed, and the
   // board no longer commits. A config that still carries it — the deployed ConfigMap, blaze-pm's
   // own — must keep LOADING (a refusal crash-loops the pod: the `provider` outage), so the key is
   // ignored and said once per process. Deliberately NOT a REMOVED_KEYS entry: those refuse.
   const COMMIT_MODE_WARNING = "blaze: warning: commitMode is ignored since 0.9.0 — the board never commits; remove it";
   let commitModeWarned = false;
   /** Test seam: lets an in-process test observe the once-only warning per case. */
   export function __resetCommitModeWarningForTests() { commitModeWarned = false; }
   ```
3. Immediately after the `if (!version.ok) { … }` block (`:202-205`), add:

   ```js
     if (file && file.commitMode !== undefined) warnCommitModeIgnored();
   ```

   and after `const cfg = { ...DEFAULTS, ...file };` add `  delete cfg.commitMode;   // BLZ-254: ignored, never carried`.
4. Replace `  if (env.BLAZE_COMMIT_MODE) cfg.commitMode = env.BLAZE_COMMIT_MODE;` (`:305`) with `  if (env.BLAZE_COMMIT_MODE !== undefined) warnCommitModeIgnored();   // BLZ-254: ignored`.
5. Add the helper beside the flag:

   ```js
   function warnCommitModeIgnored() {
     if (commitModeWarned) return;
     commitModeWarned = true;
     process.stderr.write(`${COMMIT_MODE_WARNING}\n`);
   }
   ```
6. BLZ-461 comment (`:273`): "`move-runner.mjs` reads `cfg` only for `cfg.commitMode`" becomes "read `cfg` only for `cfg.commitMode` (ignored since BLZ-254; it now reads no `cfg` field at all)".
7. **Seam check.** `config.mjs` is `*`-allowlisted in seam-closure's `ALLOWED` (a registry, `:96`) and is not in `WRITE_MAP`'s pinned exports. If `tests/model/seam-closure.test.mjs` pins `config.mjs`'s export list anywhere (`grep -n '"config.mjs"' tests/model/seam-closure.test.mjs`), adding the export is an **additive** seam change, which this plan's constraint forbids. In that case, do not export the reset seam: drop `__resetCommitModeWarningForTests`, and rely on the subprocess-per-case tests above, which need no seam.

`scripts/ci/smoke.sh:22`: `printf '{"key":"OBA","projects":["OBA"]}\n' > data/blaze.config.json`, so the smoke run is warning-free.

- [ ] **Step 3: Test configs that set the key only to pick a commit mode.** Run `rg -ln 'commitMode|BLAZE_COMMIT_MODE' tests`. In each file that writes `commitMode` into a scratch config purely to choose a mode, which no longer means anything (expected after Tasks 1–6: `tests/new-runner.test.mjs`, `tests/link-runner.test.mjs`, `tests/runner-flag-guard.test.mjs`, `tests/cli-key-refusal.test.mjs`, `tests/import-runner.test.mjs`, `tests/model/import-lock.test.mjs`, `tests/reconcile-feed-truth-oracle.test.mjs`), delete the key so their runs are warning-free. Any test that asserts an **empty stderr** on such a board would otherwise fail on the warning, and those are found the same way. Leave the two fixtures, `tests/config.test.mjs:285` and `tests/board-gate.test.mjs`'s description untouched: they are deliberately the "real board still carries it" shape.

- [ ] **Step 4: Docs.**
- `docs/guide/schema.md:110`: the `commitMode` row becomes "`commitMode` | **Ignored since 0.9.0** (BLZ-254): the board never commits. Loading warns once; remove it." Delete the `"commitMode": "batch",` line from the example (`:130`).
- `docs/schema-versioning.md`, after the "Version 2 …" bullet: "- **`commitMode` (BLZ-254, 0.9.0) is ignored, not removed.** The board no longer commits, but a config that still sets the key must keep loading (a refusal would crash-loop a deployed board), so `loadConfig` warns once and ignores it. `SCHEMA_VERSION` therefore stays 2: no config that loaded before fails to load now."
- `AGENTS.md`:
  - The Configuration paragraph drops `commitMode` from the key list.
  - The BLZ-461 paragraph's "reads `cfg` only for `cfg.commitMode`" becomes "read … (ignored since BLZ-254)".
  - "(currently `1..1`)" becomes "(currently `1..2`)".

- [ ] **Step 5: Run, commit.**

```bash
node --test --test-timeout=120000 --import=./tests/setup/hang-watchdog.mjs tests/config*.test.mjs tests/model/schema-config.test.mjs tests/schema-version-*.test.mjs tests/board-gate.test.mjs tests/compat-legacy.test.mjs tests/cli-key-refusal.test.mjs tests/model/seam-closure.test.mjs
npm test 2>&1 | tail -9
git add scripts/config.mjs scripts/ci/smoke.sh tests/config-commitmode-ignored.test.mjs tests/config.test.mjs \
  $(git diff --name-only -- tests) docs/guide/schema.md docs/schema-versioning.md AGENTS.md
git commit -m "BLZ-687: commitMode is ignored with a one-time warning — the board never commits (spec §5.5)"
```

---

### Task 8: delete `missingClaimErrors`

**Files:**
- Modify: `scripts/model/index.mjs` (`:13` the claims import, `:355-398` the function and its comment), `scripts/reindex.mjs` (`:8`, `:72-98`)
- Modify tests: `tests/ids-rollback.test.mjs`, `tests/model/index-fs-hatches.test.mjs`, `tests/csv-round-trip.test.mjs`, `tests/model/import-apply.test.mjs:124` (message only), `tests/read-path-fifo.test.mjs:476` (comment only)
- Add a test to: `tests/reindex.test.mjs` (`grep -ln "reindex" tests/*.test.mjs` to find the file that drives `scripts/reindex.mjs` end to end. If none fits, add `tests/reindex-unclaimed-id.test.mjs`)
- Docs: `docs/decisions/0005-three-layer-id-allocator.md` (one addendum line), AGENTS.md "Derived caches" (no change needed: it never mentioned the claim check; verify with `grep -n claim AGENTS.md`)

**Interfaces:**
- Produces: `scripts/model/index.mjs` no longer exports `missingClaimErrors` and no longer imports `claims.mjs`. `blaze reindex` blocks only on `idx.errors` (duplicate ids).

- [ ] **Step 1: Write the failing test.** Create `tests/reindex-unclaimed-id.test.mjs`:

```js
// tests/reindex-unclaimed-id.test.mjs — BLZ-687 (BLZ-254 PR D, spec §3 and §5.5).
//
// `missingClaimErrors` (BLZ-136) made `blaze reindex` refuse an id above a project's `.cutover`
// that had no `.ids/` claim. Spec §5.5 deletes it: under D1 an fs board is single-machine, so
// there is no second writer whose claim could be missing, and in db mode the check was already
// skipped. A duplicate id still refuses — that is `buildIndex`'s own error, not the claim check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const reindex = join(REPO, "scripts", "reindex.mjs");

function board(t, tickets) {
  const root = mkdtempSync(join(tmpdir(), "blz687-reindex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "PROJ", projects: ["PROJ"] }));
  mkdirSync(join(root, "projects", "PROJ", "defined"), { recursive: true });
  mkdirSync(join(root, "projects", "PROJ", ".ids"), { recursive: true });
  writeFileSync(join(root, "projects", "PROJ", ".ids", ".cutover"), "5\n");   // the ledger has allocated
  for (const [file, id] of tickets) {
    writeFileSync(join(root, "projects", "PROJ", "defined", file),
      `---\nid: ${id}\ntitle: t\ntype: task\nproject: PROJ\nestimate: 30\n---\n\nbody\n`);
  }
  return root;
}
const run = (root) => {
  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") };
  delete env.BLAZE_WRITE_PORT; delete env.BLAZE_READONLY;
  return spawnSync(process.execPath, [reindex], { cwd: root, env, encoding: "utf8" });
};

test("an id above the cutover with no claim no longer blocks reindex", (t) => {
  const root = board(t, [["PROJ-6-x.md", "PROJ-6"]]);
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /no claim|unclaimed/);
  assert.ok(existsSync(join(root, ".blaze", "index.json")), "the index is written");
});

test("a duplicate id still blocks reindex", (t) => {
  const root = board(t, [["PROJ-1-a.md", "PROJ-1"], ["PROJ-1-b.md", "PROJ-1"]]);
  const r = run(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /duplicate ticket id/);
  assert.equal(existsSync(join(root, ".blaze", "index.json")), false);
});
```

Check the cutover file's real name and location in `scripts/model/claims.mjs` (`cutoverPath`), and use that path. Run it. Expected: the first test FAILS (exit 1, "1 unclaimed id"), and the second passes. It is a guard, kept so the deletion cannot widen into the duplicate check.

- [ ] **Step 2: Implement.**
- `scripts/model/index.mjs`:
  - Delete `import { claimedNumbers, readCutover, claimPath } from "./claims.mjs";` (`:13`). First check that nothing else in the file uses those three (`grep -n "claimedNumbers\|readCutover\|claimPath" scripts/model/index.mjs`).
  - Delete the `missingClaimErrors` function and its comment block (from the comment's start above `export function missingClaimErrors` through the function's closing `}`).
  - Leave one line: `// BLZ-254 (spec §3, §5.5): missingClaimErrors (BLZ-136) is deleted — fs mode is single-machine (D1), and db mode never ran it.`
- `scripts/reindex.mjs`:
  - `:8` becomes `import { buildIndex } from "./model/index.mjs";`.
  - Replace the block from the comment `// BLZ-274 / ADR-0009: the missing-claim check is path-dependent …` through `for (const e of claimErrors) console.error(\`error: ${e}\`);` with `// BLZ-254 (spec §5.5): the missing-claim check (BLZ-136) is deleted; only duplicate ids block.`
  - Then simplify the blocking section so that it reads:

    ```js
      // BLZ-134: refuse to write an index built over colliding ids. Writing it would
      // bake the collision into every consumer while looking like a clean rebuild —
      // exactly how four duplicate ids sat undetected on the live board. Fail before
      // the write so the on-disk cache keeps its last known-good state.
      if (idx.errors.length) {
        for (const e of idx.errors) console.error(`error: ${e}`);
        if (!allowDuplicateIds) {
          const dupes = idx.errors.length;
          throw new Error(
            `${dupes} duplicate ticket id${dupes === 1 ? "" : "s"} — refusing to write a corrupt index. ` +
            `Renumber one side of each collision, then re-run ` +
            `(or --allow-duplicate-ids to rebuild anyway; the shadowed ticket stays invisible).`
          );
        }
        console.error(`warning: --allow-duplicate-ids — rebuilding anyway; ${idx.errors.length} unresolved finding(s).`);
      }
    ```

    Keep the original message text for the duplicate case **byte-identical** (compare with `git show 3a0ac78:scripts/reindex.mjs`). The tests that pin it must not change.

- [ ] **Step 3: The tests that called it.**
- `tests/ids-rollback.test.mjs`: delete `"BLZ-136 rollback: a ticket issued after cutover with no claim is a MISSING-CLAIM error"` (`:34-46`) and the `missingClaimErrors` import. The other three tests assert `buildIndex(...).errors` (duplicates, the grandfathered cutover, a well-formed board, a ledger-less board) and stay. Their names and comments speak of missing claims as an error, so append `(the missing-claim error itself was deleted by BLZ-254)` to the file's header.
- `tests/model/index-fs-hatches.test.mjs`: delete `"missingClaimErrors is exported and still detects an unclaimed id"` and `"BLZ-274: a missing claim is no longer mislabelled as a duplicate id"`, and drop `missingClaimErrors` from the import. Fix the header ("filesystem three ways: walkTickets, missingClaimErrors … and …") to two ways. Add a one-line test in their place:

  ```js
  test("BLZ-254: missingClaimErrors is gone from the index module", async () => {
    const mod = await import("../../scripts/model/index.mjs");
    assert.equal(Object.hasOwn(mod, "missingClaimErrors"), false);
  });
  ```
- `tests/csv-round-trip.test.mjs`: in `describe("BLZ-630: every imported ticket has a claim", …)`, keep `"a claim file exists for every created ticket, asserted DIRECTLY"`. It pins import writing claims, which fs mode still does (D1). Delete the two tests that call `missingClaimErrors` (`:272-299`), the import at `:42`, and the sentence at `:100` that cites its early return. Replace that sentence with "(BLZ-254 deleted `missingClaimErrors`; the claim's existence is what is pinned)".
- `tests/model/import-apply.test.mjs:124`: in the message "the reverse order's residue is a missingClaimErrors ERROR on the operator's board", replace "a missingClaimErrors ERROR" with "an unclaimed id". The assertion is unchanged, because claim-before-write still matters to the allocator.
- `tests/read-path-fifo.test.mjs:476`: comment only. "`missingClaimErrors` answers it by STAYING SILENT" becomes "`missingClaimErrors` (deleted by BLZ-254) answered it by staying silent".
- `scripts/model/claims.mjs:71`: the comment naming `missingClaimErrors` gets the same "(deleted by BLZ-254)" note. The code is unchanged.

- [ ] **Step 4: Docs, run, commit.** `docs/decisions/0005-three-layer-id-allocator.md`: append

```markdown
## Addendum (2026-10-13, BLZ-254) — fs is single-machine; the read-side claim check is gone

BLZ-254 (D1) keeps this allocator as fs mode's, and fs mode is now a single-machine mode: a board
with more than one writer runs in db mode, where `project_counter`'s row lock allocates. The
read-side backstop BLZ-136 added — `blaze reindex` refusing an id above the cutover with no claim
(`missingClaimErrors`) — is deleted, because on one machine there is no second writer whose claim
could be missing. Layers 1 and 2 (the scan and the `O_EXCL` reservation plus the claim ledger) are
unchanged; layer 2b's remote sweep (`remoteMaxClaim`) still runs, and is harmless with no remote.
```

```bash
node --test --test-timeout=120000 --import=./tests/setup/hang-watchdog.mjs tests/reindex-unclaimed-id.test.mjs tests/ids-*.test.mjs tests/model/index*.test.mjs tests/csv-round-trip.test.mjs tests/model/import-apply.test.mjs tests/read-path-fifo.test.mjs tests/reindex*.test.mjs
npm test 2>&1 | tail -9
rg -n "missingClaimErrors" scripts tests   # comments only
git add scripts/model/index.mjs scripts/reindex.mjs scripts/model/claims.mjs tests/reindex-unclaimed-id.test.mjs \
  tests/ids-rollback.test.mjs tests/model/index-fs-hatches.test.mjs tests/csv-round-trip.test.mjs \
  tests/model/import-apply.test.mjs tests/read-path-fifo.test.mjs docs/decisions/0005-three-layer-id-allocator.md
git commit -m "BLZ-687: delete missingClaimErrors and its reindex call (spec §5.5)"
```

---
### Task 9: ADR addenda, superseded ADRs, the spec amendment, 0.9.0, and the docs sweep

**Files:**
- Modify: `docs/decisions/0006-database-is-the-sole-source-of-truth.md` (addendum), `docs/decisions/0008-v3-ships-as-hjr15-blaze.md` (addendum), `docs/decisions/0032-…md`, `0033-…md`, `0035-…md` (status line), `docs/decisions/0038-…md` (one sentence)
- Modify: `docs/superpowers/specs/2026-10-05-blz-254-live-board-cutover-design.md` (dated amendment)
- Modify: `package.json`, `package-lock.json`, `tests/package.test.mjs`, `docs/guide/why-blaze.md:111-113,165`
- Modify: `README.md`, `AGENTS.md`, `docs/architecture.md`, `docs/diagrams/architecture.md`, `docs/guide/how-it-works.md`, `docs/guide/driving-with-an-ai-agent.md`, `docs/guide/getting-started.md` (if Task 3 left anything), `docs/guide/commands.md` (Remote mode, env table)

**Version decision (recorded in ADR-0008's addendum):** **0.9.0, not published.**
- Removing two commands is a breaking CLI change. In 0.x the repo signals a break with the minor (the 0.7.0 release commit, `09f12a3`, for the Node 24 floor; ADR-0008's own 0.8.0 addendum).
- ADR-0008 freezes the `@hjr15/blaze-board` line at 0.8.0, its last release, and promises that 0.8.0 "keeps working exactly as [why-blaze.md] describes" (with `blaze commit`). So 0.9.0 is the version stamp of the engine tree and image. It is **never published under `@hjr15/blaze-board`**. The next publish is the `@hjr15/blaze` rename, out of scope here.
- Bumping is what keeps a later publish honest. If the tree stayed at 0.8.0, `npm publish` from `main` after this PR would ship the breaking tree as the very version ADR-0008 froze.
- There is no CHANGELOG in this repo. Releases are described in their commit/PR body (precedent: `release: 0.7.0 (#55)`), so the PR body carries the "Breaking" section (Task 11).

- [ ] **Step 1: The version, test first.** In `tests/package.test.mjs`, replace the BLZ-674 test with:

```js
// BLZ-674 cut 0.8.0 as the LAST @hjr15/blaze-board release (ADR-0008's addendum). BLZ-687
// (BLZ-254 PR D) removes `blaze commit` and `blaze publish` — breaking, so the minor moves — and
// the tree becomes 0.9.0, which is NOT published under this name: the line stays frozen at 0.8.0.
test("BLZ-687: this tree is 0.9.0 — the git ceremony is gone, and 0.8.0 stays the frozen release", async () => {
  assert.equal(pkg.version, "0.9.0");
  const lock = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8"));
  assert.equal(lock.version, "0.9.0", "package-lock.json's top-level version must move with it");
  assert.equal(lock.packages[""].version, "0.9.0", "…and its root package entry");
  assert.equal(pkg.scripts.commit, undefined, "the `npm run commit` script ran the deleted commit-runner");
  const { idsFromCommitMessage } = await import("../scripts/reconcile.mjs");
  assert.deepEqual(idsFromCommitMessage("BLZ-675: x (#9)\n\n* BLZ-674: y\n* BLZ-678: z", "BLZ"),
    ["BLZ-675", "BLZ-674", "BLZ-678"], "a bundled squash still recovers every child");
});
```

Run it (FAIL: version 0.8.0). Then set `"version": "0.9.0"` in `package.json` and in both places in `package-lock.json` (`npm version 0.9.0 --no-git-tag-version --ignore-scripts` does both; check `git diff package-lock.json` touches only those two lines). Run it again (PASS).

- [ ] **Step 2: ADR-0006 addendum.** Append to `docs/decisions/0006-database-is-the-sole-source-of-truth.md`:

```markdown
## Addendum (2026-10-13, BLZ-254) — concurrent writers need db mode; fs is single-machine

This ADR is still *Proposed*. BLZ-254 does not accept it whole, and it does not retire files. The
operator's decision D1 (2026-10-05, BLZ-254 spec §2) splits the product in two:

- **db mode (`BLAZE_WRITE_PORT=db`) is the multi-machine mode.** The live board runs it. Ids come
  from `project_counter`'s transactional allocate; a second machine writes over HTTP (`blaze`
  remote mode, `POST /api/*` with a bearer token). This is the only supported way for two
  writers — two sessions, two machines, an agent and a person — to share one board.
- **fs mode is a supported single-machine mode.** It keeps its allocator (`ids.mjs`,
  `claims.mjs`, ADR-0005) and nothing else of the git era: since 0.9.0 the board **never
  commits**. `blaze commit`, `blaze publish`, `commitMode`, the pending ledgers, the commit lock
  and the server's per-click commit are deleted (BLZ-254 §5.5). The person who owns an fs board
  versions its files with git themselves, when and how they choose. (The fs groomer loop and
  the one-shot `blaze migrate` still commit their own changes; they were outside §5.5's table.)

Running an fs board with more than one concurrent writer is unsupported. The failures that
motivated this ADR — a ticket in two status directories, one id minted twice in two trees — are
exactly what such a board can still produce, and nothing in the engine now tries to paper over
them with a queue or a lock.
```

- [ ] **Step 3: ADR-0008 addendum, and why-blaze.** Append to `docs/decisions/0008-v3-ships-as-hjr15-blaze.md`:

```markdown
## Addendum (2026-10-13, BLZ-687) — the tree moves to 0.9.0, unpublished

BLZ-254's PR D removes `blaze commit` and `blaze publish` (and makes the configuration key `commitMode` inert) —
a breaking change, which in 0.x moves the minor. The tree is therefore **0.9.0**. It is **not
published as `@hjr15/blaze-board`**: the freeze at 0.8.0 above stands, and 0.8.0 (cut before
PR D merged) is the last release with the git-commit workflow. 0.9.0 names the engine tree and
the image built from it; the next npm publish is the `@hjr15/blaze` rename this ADR decides.
The bump exists so that a publish from `main` can never ship the breaking tree under the frozen
version's number.
```

In `docs/guide/why-blaze.md`, after "**`@hjr15/blaze-board` is frozen at 0.8.0**, its last release (…)", add: "The engine tree has since moved to 0.9.0, which removed `blaze commit` and `blaze publish`. 0.9.0 is not published under this name."

- [ ] **Step 4: ADRs 0032, 0033, 0035 are superseded; ADR-0038 gets one sentence.** In each of `0032-a-queued-write-is-a-fact-blaze-recorded-not-a-shape-git-reports.md`, `0033-the-queue-store-is-one-per-repository-not-one-per-working-copy.md` and `0035-nothing-to-commit-is-a-settled-drain-not-a-failed-one.md`, change the status line from `- **Status:** Accepted` to `- **Status:** Superseded (2026-10-13, BLZ-254): the pending ledger, \`blaze commit\` and the commit path this decides are deleted — see ADR-0006's BLZ-254 addendum`. Leave the body unchanged; it is the record. (Check each file's status-line spelling first with `sed -n 1,6p`.) In ADR-0038, after the sentence at `:94` ("That stays BLZ-254's explicit decision."), add: "BLZ-254 decided it: `commit-or-queue.mjs` and `stageFor` are deleted, and no write mode stages anything (2026-10-13)."

- [ ] **Step 5: The spec amendment.** Append to `docs/superpowers/specs/2026-10-05-blz-254-live-board-cutover-design.md` (and leave the original sections unedited, so the decision history reads in order):

```markdown
## 11. Amendments

### 2026-10-13 (BLZ-687, PR D plan)

1. **§5.1, backups.** "a scheduled `Backup` (daily, retained 14 days)" was replaced by an operator
   decision on 2026-10-11: a daily `pg_dump --format=custom` CronJob (`blaze-pg-backup`) into the
   host directory `~/cluster-data/blaze-pg-backups`, verified with `pg_restore --list`, 14 days
   kept, never pruned behind a dump under half the size of the largest kept, failing into the
   existing `CronJobLastRunFailed`/`CronJobStale` alerts. PGDATA is on a host PV adopted across
   cluster resets. Recorded in hjr15/service-platform ADR-0024
   (`docs/decisions/0024-cnpg-operator-and-blaze-pg-host-pv-backups.md`, merged in #112). The CNPG
   scheduled `Backup` needs an object store or CSI snapshots, and k3d has neither.
2. **§5.8 and §7's rollback follow from 1.** "CNPG backup and point-in-time restore" (§5.8, the
   groom-undo row) and "restore from CNPG if needed" (§7, Rollback) now mean **restore the most
   recent verified daily `pg_dump`** — there is no point-in-time recovery, so the recovery point
   is up to one day old. `ticket_event` history is unchanged as the first resort.
3. **§5.5, the deletion table, is completed by PR D's plan**
   (`docs/superpowers/plans/2026-10-13-blz-254-pr-d-retire-git-ceremony-plan.md`, Findings 1–7):
   - `commit-lock.mjs`'s policy is deleted but its mechanism is renamed `dir-lock.mjs`, because
     `import-lock.mjs` (out of scope, kept) is built on it;
   - `branch-guard.mjs`, `commit-summary.mjs`, `views/write-outcome.mjs` and the queue-store
     migration procedure are deleted with their only callers, and `reconcile-commit-report.mjs`
     shrinks to `reconcile-apply-report.mjs`;
   - "the board never commits" covers reconcile's own commit, the supervisor's commit-outcome
     feed, import's staging and `blaze sprint`;
   - `commitMode` (and `BLAZE_COMMIT_MODE`) is ignored with a one-time warning rather than refused
     (operator ruling 2026-10-18), so a config that still carries it keeps loading; `SCHEMA_VERSION`
     stays 2;
   - the fs groomer's and `blaze migrate`'s own commits are not in the table, stay in PR D, and are a
     follow-up ticket under BLZ-254;
   - the tree is 0.9.0, unpublished (ADR-0008's addendum).
4. **§5.6, `build_matrices.py`.** Its retirement is a blaze-pm data-repo step, done by the board
   operator after cutover (delete the script and its test, regenerate the matrices with
   `blaze matrices`). The engine's "Regenerate with" header follows it (PR D, Task 10, conditional).
```

- [ ] **Step 6: The docs sweep.** Every sentence that describes the board committing, queueing, flushing or locking is rewritten to say it writes and does not commit. Each file's hits:

```bash
grep -nE 'blaze commit|blaze publish|pending-ledger|\.blaze/pending|commitMode|commit-lock|commit\.lock|blaze-flush|BLAZE_COMMIT_MODE|queued for|commit lock|per-op|commit-on-(edit|mutation)|commits (scoped|immediately)|and commits' \
  README.md AGENTS.md docs/architecture.md docs/diagrams/architecture.md docs/guide/*.md docs/schema-*.md
```

What each must say after the edit:
- `AGENTS.md`:
  - The intro sentence ("…validates every write against the schema below and commits scoped to the files it touched") ends at "…validates every write against the schema below; it does not commit (version the files yourself, or run the board in db mode)".
  - Replace the whole `## Commit modes` section, from its heading through the end of the "Working-tree cross-talk …" paragraph, **keeping** `### Read-only mode` (now its own `##` section), with:

    ```markdown
    ## The board does not commit

    Since 0.9.0 (BLZ-254) no `blaze` verb, no `/api/*` write and no `reconcile --apply` commits,
    stages or queues anything. On a file board the verbs change `projects/` and stop; commit the
    changes yourself, scoped as you like. `blaze commit`, `blaze publish` and the `commitMode`
    key are gone. The verbs are refused by name, the key is ignored with a one-time warning, and the last release
    that has them is `@hjr15/blaze-board@0.8.0`. The fs groomer loop (`blaze start`) still commits
    its own grooms, and `blaze migrate` its one-shot import.

    **One machine, one writer.** A file board is single-machine (ADR-0006's BLZ-254 addendum).
    For parallel sessions or a second machine, run the board in db mode
    (`BLAZE_WRITE_PORT=db`) and write to it over HTTP — see "Remote mode" below. Two sessions
    sharing one file board can still trample each other's working tree; use a worktree per
    session, and expect to reconcile the files by hand.
    ```
  - In `### Read-only mode`'s verb list, drop `commit`.
  - In "Detail panel", "toggle via the existing commit-on-edit `/api/ac` path" becomes "toggle via `/api/ac`".
  - In "Inline field editing", "An edit commits through the same commit-on-mutation path as move/log/resolve" becomes "An edit writes through the same path as move/log/resolve".
  - In "Data-root ladder", "(`blaze.config.json` + `projects/` + the git history tickets commit into)" becomes "(`blaze.config.json` + `projects/`)".
  - In "Remote mode", "so there is no worktree, commit or queue to manage" becomes "so there is no worktree to manage".
- `README.md`:
  - `:16` "every mutation is a small, revertable commit" becomes "every mutation is a plain file change you can review and commit with git (or, for many writers, a row in Postgres)".
  - `:113-114`: `blaze new` "writes the ticket, validates it against the schema" and stops; delete "and commits it — one small commit per ticket, scoped to the files it actually touched".
  - `:147`: the sentence ending "in place and commit." ends "in place.".
- `docs/architecture.md:34,58,77-127`:
  - The runner box loses `commit`.
  - The `.blaze/` box loses `pending/…`, `pending/<session>.corrupt` and `commit.lock/`.
  - The runner paragraph becomes "maps each CLI verb to a `*-runner.mjs` that wraps a pure `apply*`/model core and resolves the write port. Nothing commits (BLZ-254)". Delete the batch/session/lock/branch-guard/commit-summary paragraphs and the `commit-or-queue.mjs, pending-ledger.mjs, and …` sentence at `:127`.
- `docs/diagrams/architecture.md:15,71-73`: drop the pending-ops and commit-lock clauses, and "— in `per-op` mode — commits just that file; in `batch` mode it queues…" becomes "and writes it; nothing is committed (BLZ-254)".
- `docs/guide/how-it-works.md`:
  - `:76`: replace the batch clause with "(the board itself never commits since BLZ-254)".
  - `:359` ("`blaze`'s own batch commits write their ledger as `- <KEY>-<n>: <board op>`, so…") becomes "`blaze commit` (removed by BLZ-254) wrote its ledger as `- <KEY>-<n>: <board op>`, and those commits remain in board histories, so…". Reconcile's rule still guards them.
  - `:402-404`: replace with "No verb commits (BLZ-254); version the board's files yourself."
- `docs/guide/driving-with-an-ai-agent.md:85-115`: replace the batch-mode bullet and the example block that runs `blaze commit` with the AGENTS.md "One machine, one writer" paragraph above, plus `BLAZE_REMOTE_URL=… BLAZE_TOKEN=… blaze new …` as the multi-agent path.
- `docs/guide/commands.md`: the env-variable table loses `BLAZE_COMMIT_MODE` and `BLAZE_SESSION` (only the pending ledger read it; check `grep -rn BLAZE_SESSION scripts` first, and keep the row if anything still reads it).

Afterwards, the grep above prints only lines that are about history (each saying "removed by BLZ-254" or "0.8.0") or about the groomer's/migrate's own commits.

- [ ] **Step 7: Run, commit.**

```bash
node --test --import=./tests/setup/hang-watchdog.mjs tests/package.test.mjs tests/shipped-doc-links.test.mjs tests/commands-doc-quiet-pins.test.mjs tests/config.test.mjs
npm test 2>&1 | tail -9
git add package.json package-lock.json tests/package.test.mjs docs/decisions/0006-*.md docs/decisions/0008-*.md \
  docs/decisions/0032-*.md docs/decisions/0033-*.md docs/decisions/0035-*.md docs/decisions/0038-*.md \
  docs/superpowers/specs/2026-10-05-blz-254-live-board-cutover-design.md docs/guide/why-blaze.md README.md AGENTS.md \
  docs/architecture.md docs/diagrams/architecture.md docs/guide/how-it-works.md docs/guide/driving-with-an-ai-agent.md \
  docs/guide/getting-started.md docs/guide/commands.md
git commit -m "BLZ-687: ADR-0006/0008 addenda, superseded queue ADRs, spec amendment, 0.9.0, docs sweep"
```

If `docs/diagrams/*.md` changes, check whether the repo regenerates embedded diagrams (`scripts/embed_diagrams.py`, `tests/test_embed_diagrams.py`). If a test pins the embedded copy, run `python3 scripts/embed_diagrams.py` as that test's message says, and stage the result.

---

### Task 10 (CONDITIONAL): the matrices header names `blaze matrices`

**Run this task only if the board operator has retired blaze-pm's script.** That is a blaze-pm data-repo step, done after cutover, never pushed:

```bash
test ! -e /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine/scripts/build_matrices.py && echo RETIRED || echo STILL-THERE
```

(Use whichever checkout is authoritative at the time: spec §4 names `BLZ-305-v4-spine`.) On `STILL-THERE`, **skip this task**. Record "Task 10 skipped: build_matrices.py still in blaze-pm" in the PR body, and leave BLZ-687's sibling note: the header change is a one-line follow-up once the operator retires the script. On 2026-10-13 it was STILL-THERE.

**Files:** `scripts/model/matrices.mjs:80-83,113-114`, `tests/fixtures/matrices-board/docs/matrices/*.md` (regenerated), `tests/matrices.test.mjs` (header comment), `docs/guide/commands.md` `## matrices`.

- [ ] **Step 1: Failing test.** Add to `tests/matrices.test.mjs`:

```js
test("BLZ-687: the derived-view header names the engine's own verb, not blaze-pm's retired script", async () => {
  const { requirementsMatrix, architectureMatrix } = await import("../scripts/model/matrices.mjs");
  for (const text of [requirementsMatrix([], "ENG", () => ""), architectureMatrix([], "ENG", () => "")]) {
    assert.match(text, /Regenerate with `blaze matrices`/);
    assert.doesNotMatch(text, /build_matrices\.py/);
  }
});
```

Run it: FAIL.

- [ ] **Step 2: Implement.** In both headers, replace `` "`python3 scripts/build_matrices.py`" `` with `` "`blaze matrices`" ``, keeping the rest of each sentence byte-identical. Regenerate the fixture's committed output with the engine itself: `node scripts/cli.mjs matrices --out tests/fixtures/matrices-board/docs/matrices`, run from `tests/fixtures/matrices-board` with `BLAZE_PROJECTS_DIR` set to its `projects/`, using the exact invocation `tests/matrices.test.mjs` uses for its zero-diff check. The diff must change **only the header line** of each file (`git diff --stat` shows one line each). Update the file's header comment: the oracle now compares against the engine's own committed output, since the script is retired.

- [ ] **Step 3: Run `tests/matrices.test.mjs`, commit** `BLZ-687: matrices header names blaze matrices (build_matrices.py retired in blaze-pm)`. Tell the board operator that blaze-pm's 22 committed matrix files now differ by that one header line, and that `blaze matrices` regenerates them.

---

### Task 11: whole-branch verification and the merge-gate record

- [ ] **Step 1 (haiku, read-only): the numbers.**

```bash
npm test 2>&1 | tail -9                       # fail 0; record tests/pass/skipped
npm run test:coverage 2>&1 | tail -15         # c8 thresholds 91/77/93/91 hold
node scripts/ci/hygiene-check.mjs              # clean (no trailers, no /home paths in non-Markdown)
git log --format='%B' origin/main..HEAD | grep -ciE 'co-authored-by|signed-off-by'   # 0
rg -n "commit-or-queue|serve-commit|pending-ledger|commit-summary|branch-guard|commit-lock|commit-runner|publish-runner|reconcile-commit-report|write-outcome|missingClaimErrors" scripts   # comments only
git diff --stat origin/main...HEAD | tail -1
```

Expected test count: the baseline 5,432, minus the deleted files' tests, plus the new ones. Record the exact before/after in the PR body. The count drops by the tests in the 24 deleted test files (2 + 2 + 2 + 16 + 2 across Tasks 1, 2, 3, 5 and 6; `tests/commit-lock.test.mjs` is renamed, not deleted). That is the deletion, and every file is named in Tasks 1–6 with its reason.

- [ ] **Step 2 (opus): the whole-branch review.** Use `superpowers:requesting-code-review` against the spec's §5.5 table, this plan's Review Focus, and the seam-closure ledger. The reviewer must specifically try to refute:
  - "no seam-closure assertion was weakened" (diff the file against `3a0ac78`, and count `assert` lines touched: zero);
  - "fs-mode `blaze new` still allocates" (`tests/verbs-make-no-commit.test.mjs`);
  - "no executable reference to a deleted module remains".

  Adjudicate the findings with `adjudicate-reviewer-findings-against-ground-truth`.

- [ ] **Step 3: The PR (draft), never merged by this plan.** Push the branch and open a **draft** PR titled `BLZ-687: retire the git ceremony (BLZ-254 PR D)`. The body:
  - a **Breaking** section (`blaze commit`/`blaze publish` removed; `commitMode`/`BLAZE_COMMIT_MODE` ignored with a one-time warning; the server's 200 body drops `committed`/`queued`; reconcile's result drops `committed`/`commitOutcome`/`commitError`; import's result drops `staged`/`commit`; version 0.9.0, unpublished);
  - the baseline and final test counts;
  - the deleted-test list with reasons;
  - the seam-closure ledger;
  - the MERGE GATE checklist from the top of this plan, verbatim, unticked.

  The PR stays draft until the operator reports cutover step 6 and says "merge PR D". At that point re-run the gate's six checks and record each result in a PR comment before `gh pr merge`.

---

## Self-review (run 2026-10-18 against the spec)

**Spec coverage (§5.5, row by row):**
- `commit-lock.mjs` → Task 6 (policy deleted, mechanism renamed; Finding 1).
- Pending ledgers → Tasks 5–6 (the module, `.blaze/pending/` and `pending-commit.jsonl` handling all live in `pending-ledger.mjs`/`commit-runner.mjs`; merge gate 2 is the "after the final flush" condition).
- `commit-runner.mjs`, `serve-commit.mjs` → Tasks 5, 6.
- `publish-runner.mjs` → Task 5.
- `commit-or-queue.mjs`/`stageFor`, "serve.mjs responses drop `committed`/`queued` and keep `db`" → Tasks 1–4 (callers), Task 2 (the response, TDD), Task 6 (the module).
- `blaze-flush` and service-platform ADR 0017 → out of scope (C2), named in merge gate 3.
- `missingClaimErrors` → Task 8.
- `claims.mjs`/`ids.mjs` kept → pinned by Task 3's allocator test.
- `seed-counter`'s `.ids/` source kept → untouched (no task edits `seed-counter.mjs`).
- `import-lock`/`ref-claim`/`ref-allocator` → not deleted (import-lock only re-points its import, Task 6).
- "seam-closure only name swaps or removals, each `// BLZ-254:`, every line listed" → the ledger plus Tasks 1–6, and Task 6 Step 5's zero-`assert`-lines check.
- ADR-0006 addendum and README → Task 9.
- §6 "Deletion" (suite green, seam-closure passes, `rg` clean, fs `blaze new` still allocates) → Task 6 Step 6, Task 3, Task 11.
- §7 "PR D merges after step 6" → the MERGE GATE.
- The spec §5.1 amendment → Task 9 Step 5.
- The matrices header → Task 10 (conditional).

**Placeholder scan:** no TBD/TODO.

Three steps tell the implementer to locate a line by grep before editing:
- Task 1 Step 9's `commands.md` sentences;
- Task 7 Step 3's residual configs;
- Task 9 Step 6's doc sweep.

In each, the target wording is given and the grep is the completeness check, not a substitute for the content. Task 4 Step 1's import-runner test gives its fallback if `board(t)` already git-inits.

**Type consistency:**
- `appliedLine({ mode, movedCount, nonMovedCount })` is defined in Task 1 and used in Tasks 1 and 6.
- `acquireDirLock`/`releaseDirLock` keep their signatures.
- `done(r, extra)` (Task 2) replaces `done(r, msg, op, extra)` at all six call sites.
- `applyImport`'s new return is used consistently in Task 4's tests.

**Ordering risks checked:**
- Task 1 must precede Task 5, because the old oracle spawned `commit-runner.mjs`.
- Every test file that imports a module deleted in Task 6 is listed in Task 6 Step 4, and found by the `rg -ln` there.
- `tests/temp-cleanup-guard.test.mjs` reads `commit-settled-drain.test.mjs` by name, so it is handled in Task 5.

## Post-merge checklist (after PR D merges at cutover step 6)

1. **Drop `commitMode` from the two configs that still carry it.** Until then, the pod logs one warning per process.
   - The service-platform ConfigMap (`deploy/apps/blaze/chart/templates/configmap.yaml`): a service-platform PR, which can ride with C2.
   - blaze-pm's `blaze.config.json` on the authoritative tree: a board-operator data-repo step, never pushed.
   - Check: `git -C <service-platform> show origin/main:deploy/apps/blaze/chart/templates/configmap.yaml | grep -c commitMode` prints `0`, and the pod's log has no `commitMode is ignored` line after its next restart.
2. Task 10 (matrices header) runs once the board operator retires `build_matrices.py` in blaze-pm.

## Out of scope / follow-ups

- **Ticket to file under BLZ-254 (the coordinator files it):** "The fs groomer's and `blaze migrate`'s own git commits". `scripts/loops/groomer.mjs:712-713` commits each fs groom behind BLZ-347's containment, and `scripts/migrate-runner.mjs:77-85` commits a one-shot Jira import. Neither was in spec §5.5's table, so PR D keeps both. The ticket decides whether "the board never commits" extends to them.
- The service-platform side (`blaze-flush`, its ConfigMap and values, ADR 0017 superseded) is the C2 PR.

## Operator rulings (2026-10-18), applied

1. 0.8.0 is published from `main` before PR D merges (BLZ-674). That is merge gate 5.
2. `commitMode` is ignored with a one-time warning, not refused, and `SCHEMA_VERSION` stays 2 (Task 7, Finding 5).
3. The groomer and migrate commits are out of scope for PR D and recorded as a follow-up above.
