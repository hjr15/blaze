# Adversarial review: BLZ-254 PR D plan (retire the git ceremony)

- **Plan:** `docs/superpowers/plans/2026-10-13-blz-254-pr-d-retire-git-ceremony-plan.md` at `919c327`
- **Method:** I applied Tasks 1–9 literally, in plan order, in a detached scratch worktree (`/tmp/claude-1000/blz687-scratch`, since removed), the way an implementer subagent would. I ran each task's own commands and then `npm test` after every task. Task 9's docs I applied only in part (AGENTS.md section, ADR status lines, version). Task 10 is conditional and I checked its symbols only. Task 11 is read-only.
- **Environment:** Node 24.19.0, `npm ci --ignore-scripts`, `BLAZE_TEST_PG_URL` unset. `origin/main` = `3a0ac78` (nothing incoming).
- **Baseline reproduced:** `tests 5432 · pass 5393 · fail 0 · skipped 39` (matches the plan).
- **Verdict: NEEDS-FIXES.** The design is sound, and every module deletion works once the defects below are fixed. As written, though, three of the nine tasks leave the suite red at their own commit, one TDD step crashes in setup, and the "no assertion weakened" proof does not prove what it claims.

## Per-task suite results (literal application)

| After | `npm test` | Cause of red (fixed in scratch to continue) |
|---|---|---|
| Task 1 | 5373 / **fail 4** + quoted-source fail | C1, I1 |
| Task 2 | 5358 / fail 0 (after the I1 quote fix) | — |
| Task 3 | 5358 / **fail 4** | C2 |
| Task 4 | 5329 / **fail 1** (+ the new import-runner test cannot run, C3) | C3, C4 |
| Task 5 | 5177 / fail 0 (after the debt and quote fixes) | — |
| Task 6 | 5167 / fail 0 (after the debt and quote fixes) | — |
| Task 7 | **fail 2** until the debt is regenerated | I1, I2 |
| Task 8 | **fail 2** until the debt is regenerated | I1, I2 |
| Task 9 (part) | 5168 / fail 0 | — |

`node scripts/ci/hygiene-check.mjs 3a0ac78` → `hygiene: clean` on the scratch branch. The new test files leave nothing behind under a fresh `TMPDIR` box: `tmp-scratch-attribution.mjs --max 0` → 0 leftovers, exit 0.

---

## Critical

### C1. Task 1 misses four reconcile tests that pin a commit. Its commit is red.

Evidence (Task 1 Step 10):
```
node --test … tests/reconcile*.test.mjs tests/board-overstatement-*.test.mjs tests/model/seam-closure.test.mjs tests/supervisor*.test.mjs
✖ BLZ-394: scope follows the DIRECTORY, not just the frontmatter
✖ BLZ-394: the --apply commit subject carries the scope
✖ BLZ-436: … AC-5: a scoped --apply commit files only the ticket the pass decided
✖ BLZ-451: --ticket scopes the run finer than --project
ℹ tests 538  ℹ pass 534  ℹ fail 4
  AssertionError: a commit scoped to INF must not touch projects/OBA …
    actual: 'blaze.config.json\nprojects/INF/…'   (git show HEAD = the seed commit)
```
All four are in `tests/reconcile-project-filter.test.mjs`, and none of them is in Task 1's edit list:
- `:557` uses `git show --name-only HEAD`;
- `:571-589` asserts the commit subject `(INF)`;
- `:698` uses `git show HEAD`;
- `:848` (AC-5) uses `git show HEAD`.

**Fix:** add the following to Task 1 Step 1, as exact edits:
- (a) `:561-564`: replace `git show --name-only --format= HEAD` with `git status --porcelain --untracked-files=all`, and reword the message to "must not write projects/OBA".
- (b) Delete `"BLZ-394: the --apply commit subject carries the scope"`. The subject is a deleted behaviour. Leave a `// BLZ-254:` line in its place.
- (c) `:698-700`: same swap to `git status`.
- (d) AC-5 `:855-858`: same swap, and add `files.length > 0 &&` so that an empty tree cannot pass vacuously.

I applied exactly these, and the file went 62/62.

### C2. Task 3 breaks `tests/commit-status.test.mjs`, which Task 5 only deletes later.

Evidence (after Task 3):
```
ℹ fail 3/4  ✖ T4: on a symlinked `projects/`, an already-filed op is ORPHANED … (+T4b, T4c, outstandingFiles)
Error: ENOENT … '/tmp/blaze-symlinkboard-*/.blaze/pending/sess.jsonl'
    at newTicket (tests/commit-status.test.mjs:98:19)   ← spawns new-runner.mjs in batch mode and expects a queue entry
```
**Fix:** move `git rm tests/commit-status.test.mjs` from Task 5 Step 4 to Task 3 Step 7, with the reason "spawns new-runner and reads the batch queue it no longer writes". Also update Task 11's per-task count (2+2+**3**+15+2). Once moved, Task 3 is green (5358 / fail 0).

### C3. Task 4's new import-runner test crashes in setup, so it can never go red or green.

The plan's test seeds with `["add", "-A"], ["commit", "-q", "-m", "seed"]`. `board(t)` creates only empty directories, so there is nothing to commit:
```
node --test --test-name-pattern="BLZ-254" tests/import-runner.test.mjs
  Error: Command failed: git -C /tmp/blaze-import-cli-uD48Qq commit -q -m seed   status: 1
```
The plan's fallback ("if `board(t)` already git-inits, drop the init loop and keep the before/after assertions") makes it worse. With no commit, `rev-parse HEAD` throws.

**Fix:** seed with `["commit", "-q", "--allow-empty", "-m", "seed"]` and drop `["add", "-A"]`. The plan already does this in its own `import-apply` test. Then it is red for the right reason (`an import makes no commit`, HEAD moved) and green after Step 5.

### C4. Task 4 misses `tests/groomer-db-mode.test.mjs:276`, which asserts that the import committed.

Evidence (after Task 4):
```
✖ groomOnceDb: a concurrent db-mode import during the agent → store-changed; receipt, ref and row are left alone
  AssertionError: the import's commit is not rewound   (notEqual(HEAD, headBefore) — HEAD did not move because import no longer commits)
```
**Fix:** add the following to Task 4 Step 1:
```js
// BLZ-254: the import makes no commit, so HEAD stays put — and the groomer moved it neither way.
assert.equal(execFileSync("git", ["-C", roots.dataRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  headBefore, "neither the import nor the groomer commits or rewinds");
```
The receipt-not-deleted clause at `:274` still guards the "not rewound" property. Add the file to Task 4's `git add`.

---

## Important

### I1. A registered doc quote goes stale on every debt change, and the plan never mentions it.

`scripts/ci/quoted-sources.mjs` registers the `docs/ci.md` quote `"454 sites across 65 files"`, derived from `temp-cleanup-debt.json`. Every task that deletes a test changes the debt, so `tests/quoted-sources.test.mjs` goes red:
```
after Task 1: wrote …/temp-cleanup-debt.json: 65 files, 453 sites
✖ ci-doc-temp-cleanup-debt-size: docs/ci.md still says what temp-cleanup-debt-size derives   actual: 'stale'
✖ BLZ-523: a registered quote that rotted fails, by name
```
**Fix:** add one step to every task that runs `temp-cleanup-guard.mjs --write`. The step updates both `docs/ci.md` and the `quote:` in `scripts/ci/quoted-sources.mjs` to the new `"<sites> sites across <files> files"`, and stages both. The sequence I observed was 453/65, 446/63, 438/61, 438/61, 386/56, 379/54, 376/54, 375/54.

### I2. Tasks 7 and 8 delete tests but never regenerate the cleanup debt.

Task 7 deletes three `config.test.mjs` tests (debt 27→24). Task 8 deletes from `ids-rollback.test.mjs` (debt 5→4). Neither task's Step 5 or Step 4 runs `temp-cleanup-guard.mjs --write`, and neither stages the debt file:
```
after Task 7 impl: ✖ BLZ-603: the recorded debt is exactly what the corpus has — no new site, no stale entry
```
**Fix:** add the guard `--write`, the debt and quote stage (I1), and `scripts/ci/temp-cleanup-debt.json docs/ci.md scripts/ci/quoted-sources.mjs` to both tasks' `git add`.

### I3. The "no seam-closure assertion weakened" proof cannot detect a weakening.

The plan's proof is `grep -c 'assert'` over the diff, plus "same test count". The guard's real assertions are data rows: `WRITE_MAP`, `WRITE_SITES`, `ALLOWED`, and the `cases` and `quiet` fixture tables. I deleted a **surviving** fixture row, `["model/claims.mjs", "{ writeClaim as put }", "writeClaim"]`:
```
node --test tests/model/seam-closure.test.mjs → ℹ tests 21  pass 21  fail 0
git diff 3a0ac78 -- tests/model/seam-closure.test.mjs | grep '^[-+]' | grep -v '^[-+][-+]' | grep -c assert → 0
test-count heads: base 21, after 21
```
Both of the plan's checks pass on a genuine weakening.

**Fix:** replace the check with a diff audit that every removed code line names a deleted module or member:
```bash
DEL='pending-ledger|commit-lock|commit-or-queue|serve-commit|commit-runner|stageFor|commitOrQueue|commitFile|commitSuffix|acquireLock|releaseLock|lockPath|appendEntry|clearLedger|quarantineDropped|readForDrain|listQueues|sessionId|ledgerPath'
git diff -U0 3a0ac78 -- tests/model/seam-closure.test.mjs | grep '^-[^-]' | sed 's/^-//' | grep -vE '^\s*//' | grep -vE "$DEL"
```
On the legitimate diff this prints only three lines. One is line 94, a comment change. The other two are continuation lines of the multi-line `pending-ledger.mjs` entry. The reviewer signs those off by name. With the injected weakening, the `writeClaim` row also appears. Add a second rule as well: every added non-comment line equals a removed line minus deleted tokens, or is the `commit-lock`→`dir-lock` / `acquireLock`→`acquireDirLock` swap.

### I4. The ledger's task numbers contradict the task bodies.

The header's "Architecture" paragraph, the File Structure table and the Seam-closure ledger use one numbering. In that numbering Task 1 is the verb removal, Task 4 is reconcile and Task 5 is import. The task bodies and the routing table use another: Task 1 is reconcile, Task 4 is import and Task 5 is the verbs. Ledger row 956 and row 2044 say "Task 1". Rows 2030 and 2147 say "Task 4". Row 2107 says "Task 5". An implementer told "apply the ledger rows for your task" applies the wrong rows.

**Fix:** renumber the ledger's Task column, the File Structure table and the Architecture paragraph to match the bodies (1 reconcile, 2 server, 3 verbs, 4 import, 5 removed verbs, 6 modules).

### I5. Task 6 Step 6's residue check flags seam-closure lines the ledger forbids touching.

After the ledger is applied, `rg` still finds prose comments that name deleted members and are not in the ledger:
```
2028: // `saveState`, `appendEntry`, `acquireLock` and their kin …
2056: // … `fsStorage`, `resolveWritePort`, `commitOrQueue`,
2082 / 2105: `commitOrQueue` is the staging front door   (Task 4 says append "(removed by BLZ-254)" — not in the ledger)
2129: // BLZ-670: the apply path resolves both ports (resolvePorts) and hands `stageFor(mode)` in as …
```
The constraint says "No other line of the file changes", while the check says these hits are not allowed. **Fix:** add these five comment lines to the ledger, as comment-only edits, or allow them explicitly in the Step 6 allowance.

### I6. `commitMode` warns twice per CLI command, not "exactly once".

`cli.mjs` loads config for the schema preflight, and the runner it spawns loads it again. These are two processes, so the warning prints twice:
```
blaze new --project OBA … (config with "commitMode": "batch")
blaze: warning: commitMode is ignored since 0.9.0 — the board never commits; remove it
blaze: warning: commitMode is ignored since 0.9.0 — the board never commits; remove it
```
Task 7's tests check only one in-process `loadConfig` and the server, so Review Focus 4 ("warns exactly once") is unverified for every CLI verb. **Fix:** have `cli.mjs` set `BLAZE_COMMIT_MODE_WARNED=1` in the child env, and have `warnCommitModeIgnored` skip when it is set. Then add a test that drives `blaze move` through `cli.mjs` and counts exactly one warning. Separately, `__resetCommitModeWarningForTests` has no caller, so drop it.

### I7. Deploy safety if someone merges early: the flush Job also stops publishing main.

I re-checked service-platform `origin/main` (`633a31e`). The ConfigMap still carries `"commitMode": "batch"`, which Task 7 handles: the server starts and serves 200 with one warning, confirmed by its test. The flush script (`flush-configmap.yaml:212`) runs `execFileSync("node", [ENGINE/scripts/cli.mjs, "commit", "--all"])` before step 2. After PR D that call exits 1 and throws, so the Job fails **and skips step 2 onward**: main's existing ahead-commits stop being published too. Merge gate 3 says only "`CronJobLastRunFailed`".

If the PR merges before step 1 of the gate (the board still in fs mode), two more things happen. Dashboard writes land uncommitted in the bind-mounted blaze-pm working copy. The existing `.blaze/pending/` ops become undrainable, and no message says so. The gate is prose only. **Fix:**
- Reword gate 3 to "the flush Job fails before publishing anything".
- Make the gate mechanical: open the PR as a draft and add a `do-not-merge` label, or add a required check that fails while `deploy/apps/blaze/chart/templates/cronjob.yaml` exists on service-platform `main`.
- Optionally, have `serve.mjs` or `cli.mjs` warn once when `.blaze/pending/*.jsonl` or `.blaze/pending-commit.jsonl` is non-empty: "N queued ops from the git era are stranded; drain with blaze@0.8.0".

### I8. Task 5's red run can fire a real `kubectl create job` against the ambient context.

`publish-runner.mjs` sweeps, then runs `kubectl create job -n blaze --from=cronjob/blaze-flush …` with whatever context is current. On this machine that is `k3d-service-platform`. Step 2 runs `blaze publish` before the refusal exists. It was safe here only because the fixture has no `projects/`, so `publish-runner` exited at its data-root guard:
```
blaze publish --dry-run (same fixture shape) → "no data dir found …" exit 1
kubectl get jobs -n blaze → no blaze-flush-manual-* job (confirmed nothing was created)
```
A fixture tweak that adds `projects/` would trigger a live flush. **Fix:** in `tests/cli-removed-commands.test.mjs`'s `run()`, set `BLAZE_FLUSH_CONTEXT: "blz687-no-such-context"` and prepend a `bin/` holding a `kubectl` stub that exits 1. Or keep the publish spellings out of the red run, and say so in Step 2.

### I9. The new test files skip the scratch helper.

`verbs-make-no-commit`, `cli-removed-commands`, `config-commitmode-ignored` and `reindex-unclaimed-id` use bare `mkdtempSync` with `t.after`. They leak nothing (the box gate measured 0) and their prefixes are unique. But the house rule is `tests/helpers/scratch.mjs`. **Fix:** `const scratch = scratchRegistry();` at module scope, and `scratch(mkdtempSync(join(tmpdir(), "blz687-verbs-")))`, keeping the literal prefix inside `mkdtempSync` for the attribution scan.

---

## Minor

- **M1. Task 1's TDD claim:** `reconcile-pertype` and the AC-3 test do **not** fail at Step 2. Dropping `commit: true` makes the old code skip committing, so only the `Object.hasOwn(…, "committed")` clauses go red. Observed: `fail 2`, not 4. Correct the Step 2 "Expected" text.
- **M2. `scripts/serve.mjs:85`** still calls `reconcile({ …, commit: false, …, mode })`. These are dead arguments, and no task removes them. Add them to Task 2 Step 3.
- **M3. Debt rule vs the rename:** after Task 6 the debt diff shows `+ "dir-lock.test.mjs": 6`, a rename. The rule "only removed lines or lowered counts" reads it as a new leak. Say so in Task 6.
- **M4. `tests/readonly.test.mjs`** seeds `appendEntry` in two helpers (`:62` and `:149`). Task 6 names only `assertRefusedAndUntouched`. Also, `:180`'s regex `/at commitOrQueue|…/` survives the Step 6 executable-reference `rg`.
- **M5. Docs left dangling after Task 5:**
  - `docs/guide/commands.md:22` (`[commit](#commit)` index row).
  - `:165-186` (`#commit` links and the "run `blaze commit`" advice inside `## reconcile`).
  - `:723`: the Help sentence is line-wrapped, so the plan's find text never matches.
  - `docs/decisions/0033-…md:150` links the deleted `queue-store-migration.md`.
  - `Dockerfile:2` says "commit-on-edit shells out to [git]".
  - Comments in `scripts/views/reconcile-summary.mjs:87`. That file's source is injected into the page golden, so editing it means regenerating `tests/views/page-golden.html`.
- **M6. Line references:** Task 2 places `const post` at `:99`, but it is at `:68`. Task 1 Step 4.3 counts "eight sites" of early returns. ADR-0038 `:94`'s sentence continues past "decision" with an em dash, not a period.
- **M7. D1 wording:** fs `blaze new` still **requires a git worktree** (`ids.mjs` reservation: "is not inside a git worktree — cannot reserve ticket ids safely"). This behaviour predates the plan. But the ADR-0006 addendum and the AGENTS text ("version its files with git themselves, when and how they choose") imply git is optional. Say that a file board must be a git working tree.
- **M8. Nothing enforces "0.9.0 is never published".** Consider `"private": true` or a `prepublishOnly` guard until the rename.
- **M9. Task 6 commit list:** it omits `tests/groomer-containment.test.mjs`, whose comment Task 6 tells the implementer to edit.

## Checked and upheld

- **Item 4, `commit-lock.mjs` → `dir-lock.mjs`:** nothing is lost. `acquireLock(root, opts)` was exactly `acquireDirLock(join(root, ".blaze/commit.lock"), opts)`, so all retry and staleness defaults live in the mechanism. The six rewritten tests (dead PID, aged-out, NaN ts, ownerless grace) pass against `acquireDirLock`, and so do the FIFO-owner refusal and `import-lock` (21/21). The only change is the steal-warning text, which now names `basename(dir)`.
- **Deleted-module consumers outside `scripts/` and `tests/`:** none in the Dockerfile, `.github/workflows/*` or the `scripts/ci/*` gates apart from `temp-cleanup-debt.json`, I1 and M5. `package.json` `files: ["scripts/"]` needs no change.
- **D1:** `fs` `blaze new` allocates n then n+1 and writes `.ids/<n>` with no commit (`tests/verbs-make-no-commit.test.mjs` 8/8). The verbs stage nothing and leave HEAD unmoved.
- **Hygiene:** there are no `/home/` or `*.howman.link` strings in added non-Markdown lines, and no trailers. Implementer prompts must still override the harness's default `Co-Authored-By` attribution, as Global Constraints says.
- **Seam-closure ledger:** every quoted line number matched `3a0ac78`. The file passes 21/21 after Task 6.

## Verdict: NEEDS-FIXES

Fix C1–C4 and I1–I4 in the plan before execution. They decide whether "every commit stays green" and "no assertion weakened" are true. I5–I9 are cheap to add in the same edit.

---

## Round 2 (2026-10-19): re-review of `919c327..93803c3`

**Method.** I created a fresh detached worktree at `93803c3` (`/tmp/claude-1000/blz687-r2`, now removed). For each task, I took the round-1 per-task changes from the earlier scratch commits and then applied every round-2 text change literally on top. Every run used `KUBECONFIG=/dev/null` and a stub `kubectl` that exits 1, first on `PATH`. For each task I ran the plan's **THE DEBT STEP** block verbatim, then `npm test`. Task 9 I checked only for the new `prepublishOnly` guard. I did not run `git config`, did not push and did not touch blaze-pm.

### Per-task suite (literal)

| After | `npm test` | Debt step (sites/files) |
|---|---|---|
| Task 1 | 5373, **fail 0** | 453/65 |
| Task 2 | 5358, **fail 0** | 446/63 |
| Task 3 | 5332, **fail 0** | 438/61 |
| Task 4 | 5329, **fail 0** | 438/61 |
| Task 5 | 5177, **fail 0** | 386/56 |
| Task 6 | 5167, **fail 0** | 379/54 |
| Task 7 | 5171, **fail 0** | 376/54 |
| Task 8 | 5169, **fail 0** (see N3) | 375/54 |
| Task 9 (`prepublishOnly` only) | 5169, **fail 0** | — |

Other checks on the result:
- `hygiene-check.mjs 3a0ac78` → `hygiene: clean`.
- `bash scripts/ci/smoke.sh` → `SMOKE OK`.
- `npm publish --dry-run` is blocked by the new `prepublishOnly` guard.
- The `TMPDIR` box gate over the new test files reports 0 leftovers.
- The debt step's deriver reads the real file's `.files` key: `454 sites across 65 files` at baseline.

### The new seam audit catches the `writeClaim` removal

```
== Rule 1 (legit diff): only line 94's entry + the two pending-ledger continuation lines (the three the plan names)
== Rule 1 (writeClaim row deleted):
    …same three…
    ["model/claims.mjs", "{ writeClaim as put }", "writeClaim"],      ← caught
node --test tests/model/seam-closure.test.mjs → 21/21 pass   (the test alone still cannot see it; the audit can)
```

### Verdicts on round 1

| # | Verdict | Evidence |
|---|---|---|
| C1 | **ADDRESSED** | With the `dirtyPaths` helper and the four sites rewritten, `reconcile-project-filter` passes 62/62 and Task 1 ends at fail 0. |
| C2 | **ADDRESSED** | `commit-status.test.mjs` is now deleted in Task 3, which ends at fail 0. |
| C3 | **ADDRESSED** | The seed commit uses `--allow-empty`, and the test is red for the right reason. |
| C4 | **ADDRESSED** | The `groomer-db-mode:276` edit is in Task 4, which ends at fail 0. |
| I1 | **ADDRESSED** | THE DEBT STEP runs in Tasks 1–8, and the quote follows the debt every time. |
| I2 | **ADDRESSED** | Tasks 7 and 8 run the debt step and stage it. See N3 for ordering. |
| I3 | **ADDRESSED** | Shown above. The audit is row-based and catches the injected weakening. |
| I4 | **ADDRESSED, partly** | The ledger, the File Structure table and the Architecture paragraph are renumbered. See N1 for what was missed. |
| I5 | **ADDRESSED, one slip** | The comment rule and the allowance are explicit. See N2. |
| I6 | **ADDRESSED** | The new cli test passes. A mutation back to a per-process flag makes it fail with two warnings. A real `blaze new` prints exactly 1 warning. |
| I7 | **ADDRESSED** | Draft plus `do-not-merge` label. C2 must be merged and synced first. Gate 3 now says the flush Job "fails before publishing anything". |
| I8 | **ADDRESSED** | The red run went 0/11 as expected. A `blaze publish` on a board that **has** `projects/` reached the stub (`kubectl disabled for BLZ-687`). Real `kubectl get jobs -n blaze` shows no `blaze-flush-manual-*` job. |
| I9 | **ADDRESSED** | All four new files use `scratchRegistry`. Attribution gate: 0. |

The minors are addressed too: M1 (the Step 2 expectation), M2 (`serve.mjs:85`; the Step 9 `rg` is clean), M4, M5 (docs; Dockerfile; ADR-0033; `reconcile-summary` with the golden regenerated, 1+/1−), M7, M8 and M9.

### New findings (all Minor; none blocks execution)

- **N1. Review Focus still uses the old task numbers (I4 residue).** Item 1 says "Pinned in **Task 1** (`cli-removed-commands`)", which should be Task 5. Item 3 says "**Task 4** (the change-report oracle)", which should be Task 1. Item 5 says "**Task 5** (`import --apply stages nothing`)", which should be Task 4. Task 11 Step 2 still tells the reviewer to "count `assert` lines touched: zero". That is the check I3 replaced; point it at Task 6 Step 5's audit instead.
- **N2. The I5 allowance contradicts the plan's own Task 4 edit.** The ledger row "2093, 2116-2117" appends `(removed by BLZ-254)` to the sentence. At 2116-2117 that sentence wraps, so the line that names `commitOrQueue` does not carry the marker:
  ```
  2105:  // its bytes (§4.2 — park before you clear). `commitOrQueue` is the staging
  ```
  Task 6 Step 6 allows exactly lines 273, 2034 and 2067, so this line fails the plan's own residue check. **Fix:** put `(removed by BLZ-254)` on the same line as `commitOrQueue`, or add that line to the allowance.
- **N3. Task 8 runs `npm test` before the debt step.** Its Step 4 block runs `npm test` and then `rg`, and only then the debt step. Run literally, that `npm test` reports `fail 2` (the debt and the quote), and the task turns green only after the debt step. **Fix:** move the debt step above `npm test`, as Tasks 1–7 have it.
- **N4. An imprecise doc instruction.** Task 5's M5 bullet says the `#commit` links and the advice in `## reconcile` (`:165-186`) "go", but gives no replacement text. Every other doc edit in the plan quotes its target wording. **Fix:** give one sentence, for example: "Reconcile makes no commit (BLZ-254), so after an applied pass `git status` shows its writes under `projects/`; version them yourself."

### Round 2 verdict: **READY**

All of C1–C4 and I1–I9 are fixed. Every task ends at fail 0 when applied literally. N1–N4 are text fixes that can be made inline, or carried into the implementer prompts as known gotchas.
