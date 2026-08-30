# blaze — phase 2 and 3: the read path and the test machinery (2026-08-30)

**If you are a session reading this, your task is §3 — Lane R first, then Lane T, in that order.**
You need no further instruction to begin.

Successor to `2026-08-30-blaze-backlog-burndown-kickoff.md`, whose **phase 1 is fully discharged**
(PRs #161 and #162 merged, eleven tickets `done`). **This document is the work order.** Where it
contradicts a chat instruction, follow this.

**It supersedes nothing else.** `docs/superpowers/plans/` holds **five** `*-next-session-kickoff.md`
files (08-23, 08-27, 08-29, 08-30, 08-31) from an **older, unrelated chain** — the 08-30 and 08-31
ones say "written 2026-08-26" in their own first line. **Do not read them as current and do not write
over them**; a kickoff has already been destroyed that way once. Descriptive filenames, never date-only.

---

## 0. Continuity contract

A usage, context or API limit is a **PAUSE, not completion.** Do not stop, do not mark anything done,
do not hand back early. **Commit WIP freely on your lane branch while work is in flight** — this
overrides §8's one-commit-per-body-of-work rule, which governs what you SHIP, not what you checkpoint.
Before opening the PR, squash your checkpoints so the branch carries one commit per ticket. Resume from
the branch plus the ticket's own acceptance-criteria checkboxes. **Verify tree state, never trust a
report** — including this document's. Phase 1 recovered two lanes from a rate limit by reading the
worktrees rather than the agents' last words.

## 1. Goal

Finish the backlog the BLZ-489..497 lane left, plus the 28 tickets phase 1 filed while burning it down.
Phase 1 closed the two `high` items and eight more; **what remains is the read path (Lane R) and the
test machinery (Lane T)**, plus a new high-priority cluster phase 1 discovered.

**Definition of done:** every lane's tickets `done` or explicitly left with a written reason; `main`
green on the full gate; a successor kickoff written if anything remains.

**Stop rule.** Finish the phase you are in, then stop and write the successor kickoff if ANY of:
context is running short, a lane has been refuted twice on the same ticket, or you have merged both
lanes. **Do not start Lane T with less than roughly a third of your context left** — it edits test
files corpus-wide and a half-done sweep is worse than none. Stopping cleanly with a written handoff is
a success, not a shortfall.

Phase 1 hit the twice-refuted rule on **both** lanes. It is not a formality; it fires.

## 2. State — re-verify before building, do not take as gospel

`main` at **`12a59ad`**. Suite **4,289 pass / 0 fail, 371 suites**. Coverage **98.53 / 88.20 / 97.24**
(gates 91/77/93/91). Both re-derived on `12a59ad` by the coordinator, not quoted from a lane. Zero open
PRs. Board audit `ok=true` over 2,800 tickets.

`blaze-pm` is **52 unpushed** on `BLZ-305-v4-spine` and **that is correct** — see §6. Measure against
`origin/BLZ-305-v4-spine` (**52**), **not** `origin/main` (a different base, already misreported once
as evidence the board had drifted).

Confirm before you build:
```
git fetch origin && git log --oneline -1 origin/main
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55481/postgres   # see §4 first
npm ci && node --test 2>&1 | tail -9
```
`tail -9` is deliberate — `tail -5` shows only `fail/cancelled/skipped/todo/duration_ms` and **cannot
show `tests`, `pass` or `suites`**, which are the three figures you are told to compare.

## 3. Lanes, in phase order

### Phase 2 — Lane R, the read path (260 min + inherited)

**`scripts/model/regular-file.mjs` changed under you.** PR #162 added **`appendRegularFileSync`**
(`O_WRONLY | O_CREAT | O_APPEND | O_NONBLOCK`, `fstatSync` + `isFile()`, `NotARegularFileError`) beside
`writeRegularFileSync`. It is nominally your file. **Two tickets against it are already open — do them
with BLZ-512, not separately: BLZ-537 and BLZ-538.**

| Ticket | Pri | Est | What |
|---|---|---|---|
| **BLZ-512** | medium | 90 | ~20 same-shape `readFileSync` sites still block forever on a FIFO. **`scripts/model/setup-token.mjs:68` is on the PRE-AUTH surface — treat it as the highest-priority member.** `scripts/commit-lock.mjs:14` is an **eleventh site** the original inventory missed (verified: a FIFO `owner.json` hangs `acquireLock`). **Re-derive the list — the "~20" came from an inventory since shown to miss one site and misclassify three.** **Re-derive the ledger line numbers too:** BLZ-512's own table says `:69` and `:85`; live HEAD has moved. Trust the file. |
| **BLZ-537** | high | 15 | `appendRegularFileSync`'s `isFile()` comment states a **false** shape claim — "the only shape it changes is a DEVICE NODE". A FIFO **with a reader attached** is refused by it too (measured: 0 bytes drained with the line, 199 without). Fix the sentence. |
| **BLZ-538** | medium | 20 | That same line is called **unpinnable** when it is merely **unpinned**. `tests/read-path-fifo.test.mjs:136` already pins the sibling `writeRegularFileSync` the same way, with a `child()` helper written. Two lines pin this. The new helper has **zero** direct unit tests. |
| BLZ-519 | medium | 45 | A refusing or malformed board file **kills the whole `blaze serve` process**, not just the route. Pre-existing crash class; ADR-0031 §5 understates it. |
| BLZ-514 | medium | 40 | `audit-runner`'s catch launders a malformed `project.json` into a bare `{key}` — BLZ-470's class, one step down. |
| BLZ-513 | low | 30 | `liveModel`'s `unreadable` is not on the read seam. |
| BLZ-511 | low | 20 | `classifyGitEntry` still uses `statSync`-then-open, keeping the race BLZ-493 removed elsewhere. |
| BLZ-520 | low | 20 | **ADR-0031 records the WRONG reachability path** for the schema-config site — it is `blaze new`/`edit` (`scripts/model/edit.mjs:55`, also `:66`, and `scripts/model/new.mjs:83`), not the audit's schema layer; **`scripts/model/audit.mjs`** never calls `loadProjectSchema`. (There are three `audit*.mjs` files — `scripts/model/audit.mjs`, `scripts/migrate/audit.mjs`, `scripts/audit-runner.mjs`. Always use full paths.) Its line 201 says "4,201 tests"; it is now 4,289. **Correct the record; the decision stands — do not reopen ADR-0031.** |
| BLZ-510 | low | 15 | `fsStorage.read` blocks on a non-regular file; on no current call path. |
| BLZ-543 | low | 15 | `rankOf` inverts its own stated rule: `refs/remotes/origin/origin/<n>` (rank 1) beats `refs/heads/origin/<n>` (rank 2), so that branch is read *remotely* though the comment says rank 0 exists so it is read locally. **`scripts/reconcile.mjs` — see §5; this is the one exception and it is yours because no other lane runs after you.** |

**Files:** `scripts/model/**`, `scripts/views/**`, `scripts/serve.mjs`, `scripts/audit-runner.mjs`,
`scripts/config.mjs`, `scripts/commit-lock.mjs`, `scripts/pending-ledger.mjs`, `docs/decisions/0031-*.md`,
and `scripts/reconcile.mjs` **for BLZ-543 only**.

### Phase 3 — Lane T, test machinery and the `/tmp` corpus (205 min + 9 new)

**Runs alone and last because BLZ-503 edits test files corpus-wide and will collide with every lane
that adds one.** This is exactly how PR #158 went red after #155 merged.

**Do the two guard-integrity tickets FIRST — BLZ-535 and BLZ-534.** They are why phase 1's defects
reached review instead of CI.

| Ticket | Pri | Est | What |
|---|---|---|---|
| **BLZ-535** | high | 30 | The **write-seam guard pins a spelling**: `tests/model/seam-closure.test.mjs:100` matches only `writeFileSync(` and `renameSync(`. Injecting a live `appendFileSync(` into non-allowlisted `scripts/reconcile.mjs` leaves it **3 pass / 0 fail**. This is precisely why a FIFO-hang defect shipped in phase 1 and had to be caught by a human-directed review. BLZ-521's class, on the write seam. Its allowlist comment for `regular-file.mjs` is also stale — it still says "its one write caller is the transitions cache". |
| **BLZ-534** | high | 45 | The full suite can hang **forever** on `tests/model/driver-conformance.test.mjs`, with no timeout to end it. Reproduced once on unmodified `be4b110`: 27+ min, that file the only survivor, 0 CPU, blocked in `ep_poll`, a live referenced TCP handle to the Postgres port, `loopIdleTime 1678s`. A leaked pg connection keeps the child alive and `--test-timeout=0` means nothing ends it. **Not reproduced in ~10 further runs across two reviewers — intermittent and load-dependent.** In CI a hang is indistinguishable from a slow run. |
| **BLZ-524** | medium | 30 | The Postgres suite is wrapped in a bare `if (process.env.BLAZE_TEST_PG_URL)`, so with the variable unset it is **never registered** — no skip, no warning, and the run reads as a pass. **Independently reproduced twice**: `tests 4202 / pass 4200 / fail 0`, 70 tests vanishing. ADR-0030's thesis applied to the harness that verifies everything else. |
| **BLZ-536** | medium | 45 | The Postgres suites share **one** database with no isolation, so concurrent test files corrupt each other — `seedPg` TRUNCATEs and `openPostgresRead(create: true)` stamps a database several files share. A second concurrent run produced *"this database holds tables but no Blaze schema stamp"*. Sibling of BLZ-524; do them together. |
| BLZ-503 | medium | 45 | The suite leaks `/tmp` scratch dirs: **53,933 → 65,490 in one session, +11,557.** Worst prefixes: `seam-` 5,569, `ofc-` 4,439, `blaze-readseam-` 4,224, `blaze-init-` 4,062. `node scripts/ci/tmp-scratch-attribution.mjs` prints the breakdown. **Do not clear them before measuring — the breakdown IS the evidence.** |
| BLZ-523 | low | 30 | No general guard binds a doc-quoted product string to its source. **Phase 1 did BLZ-509 and BLZ-520's class by hand and the answer is on the ticket: prefer an opt-in registry over a corpus grep.** Four sites quoted one stale figure while two more quoted it *correctly pinned to a SHA*; a grep cannot tell those apart and gets excepted within a week. What worked was one census block with a SHA and a **named, shipped** instrument. |
| BLZ-539 | medium | 30 | The corpus-wide "no fetch reaches a resolvable host" property is pinned by **nothing in the tree** — phase 1 established it with a one-off reviewer shim, so a live URL added to a fetching fixture in any other file reddens nothing. This is BLZ-505's real guard and it does not exist. |
| BLZ-540 | medium | 20 | BLZ-505's hermeticity guard pins "no network transport", not "no state outside this repository": pointing the oracle fixture's `origin` at a real local repo elsewhere on disk passes it with all five tests green while the oracle's counts move `proposed 90 move(s)` → `72`. |
| BLZ-542 | medium | 15 | The BLZ-509 census discriminates **absent-vs-reachable**, not hermetic-vs-non-hermetic, so it is a *lagging* indicator: pointing the oracle at a non-resolving network URL leaves all eight rows identical and every oracle test green. It was blind to the live `hjr15/orc` reference for exactly as long as that repo did not exist. Record the limitation beside the census. |
| BLZ-541 | medium | 15 | The census FIFO test's child inherits the real PATH and shells to `/usr/bin/gh` rather than the fixture stub, though the file's header calls the fixture hermetic. `board()` returns `{root, bin}`; the test drops `bin` and `spawnSync` passes no `env`. Harmless today only because the fixture's forge remote is `.invalid`. |
| BLZ-516 | low | 20 | The attribution scan's **static** property is CI-gated; its **run-level** scan is not. |
| BLZ-517 | low | 20 | The no-leak proof is ~10 lines of boilerplate per suite and pins only the guards suite. |
| BLZ-504 | low | 15 | The mutation runner's teardown guard counts the **string** `rmSync(` including comments — a docstring fails it. **Cost two round-trips in one ticket already.** |
| BLZ-515 | low | 15 | The finding-kind extractor silently drops an inline `kind:` on any line containing `//` earlier (e.g. a URL). **The exact fail-open BLZ-496 exists to close, surviving in one form.** |
| BLZ-521 | low | 15 | The fd-guard test pins the spelling `statSync(` — `lstatSync(` or an alias evades it. **Do with BLZ-535; same class, two seams.** |
| BLZ-522 | low | 15 | The FIFO child-process wall-clock cap SIGTERMs a healthy child under multi-agent load. **Do not fix the flake by removing the protection.** |
| BLZ-544 | low | 10 | `renderQueueStatus` is only ever driven through a spawned subprocess (c8 ~57–63%); no test imports it despite its doc comment saying it was extracted so the wording is drivable directly. |
| BLZ-545 | low | 10 | The `(yours)` marker on `renderQueueStatus`'s **unreadable** arm is unpinned, and shares its `own` variable with the healthy arm — the only arm any test exercises. |
| BLZ-546 | low | 10 | BLZ-502's commit-step test goes red on the field, not the sentence its name quotes: removing `step: "commit"` leaves `git commit failed` byte-identical via the ternary default. |
| BLZ-548 | low | 10 | `tests/commit-session-queue-scope.test.mjs` T1 is described as observing harness inheritance, but `sessionEnv(HARNESS)` constructs the env itself, so the shared-name half is `sessionId()` evaluated twice. The **flush** half is genuinely observed. Framing only. |

**Files:** `tests/**`, `scripts/ci/**`.

### Not in either lane — the flush cluster, and it is the highest-value work here

**Six tickets whose fix lands in `service-platform` or the cluster, NOT in this repo.** Phase 1
diagnosed them and deliberately did not touch another repo. **Read BLZ-500's close-out and
`docs/reports/2026-08-30-blz-500-ledger-capture.md` before starting.**

| Ticket | Pri | Est | What |
|---|---|---|---|
| **BLZ-525** | high | 30 | The `blaze-flush` CronJob's `/data` mount **omits `.blaze/`**, so `blaze commit --all` can never see a queued op. It mounts only `/data/blaze.config.json`, `/data/projects`, `/data/.git`, `/flush`. Verified across **all three commits in that chart template's entire history** — `.blaze` appears in none. **Root cause of BLZ-500.** |
| **BLZ-526** | high | 20 | The flush's `HEAD === "main"` gate has been taking the `else` arm **every night for weeks** — `blaze-pm`'s HEAD is `BLZ-143-…`. The guard is correct; that its skip is the steady state, and that nothing surfaces it, is the defect. |
| **BLZ-527** | high | 30 | Both blaze-flush alerts key on `kube_cronjob_status_last_successful_time`, so a run that skips the flush **reads green**. A skip plus `NOOP: local main not ahead` exits 0. Assert the flush *happened*, not that the job exited 0. |
| BLZ-528 | medium | 20 | Flush job pods are not retained, so the `SKIP` line is unrecoverable; no night's flush has a durable record. |
| BLZ-529 | medium | 20 | `blaze-pm`'s **main checkout** leaks 28 pending queues holding 19 ops, undrained since 2026-08-11 — an older instance of BLZ-498's condition, on the tree the CronJob actually binds. **Blocked by BLZ-525: do not drain before the mount is fixed.** |
| BLZ-530 | medium | 30 | The `blaze` pod in namespace `blaze` is in CrashLoopBackOff (7 restarts / 10h). Observed in passing; uninvestigated. |

**BLZ-531 (`high`, 90) is separate and lands in THIS repo** — see §5.

## 4. Worktree setup — per lane, run verbatim

```
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
cd /home/rnamwoh/Documents/Code/blaze
git fetch origin
# Phase 2
git worktree add /home/rnamwoh/Documents/Code/blaze-worktrees/lane-r -b BLZ-512-read-path-residue origin/main
# Phase 3 (cut AFTER Lane R merges, off the advanced main)
git worktree add /home/rnamwoh/Documents/Code/blaze-worktrees/lane-t -b BLZ-503-test-machinery origin/main
# each worktree needs its own deps — a fresh worktree has NO node_modules
cd /home/rnamwoh/Documents/Code/blaze-worktrees/lane-r && npm ci
```
Branch names are `KEY-n-slug` keyed to each lane's **lead** ticket: `BLZ-512`, `BLZ-503`. PR titles then
take the `KEY-a + N more: description` form, which BLZ-469 reads as a squash manifest.

Postgres, one container per concurrent agent (`pg_isready` is **not** on the host PATH):
```
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55481:5432 --name blzpg-55481 postgres:17-alpine
for i in $(seq 1 60); do
  docker exec blzpg-55481 pg_isready -U postgres >/dev/null 2>&1 && { echo ready; break; }
  sleep 1
  [ "$i" = 60 ] && { echo "TIMEOUT — do not proceed"; exit 1; }
done
export BLAZE_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55481/postgres
```
Bounded on purpose: an unbounded `until … do :; done` busy-spins a core forever if the container never
starts. Use a distinct port per concurrent agent (55481, 55482, …). **A reviewer needs its own
container AND its own worktree** — see §6, and note BLZ-536: two runs against one container corrupt
each other.

## 5. Out of scope — the negative space

- **`scripts/reconcile.mjs`** — phase 1's Lane C owned it. Lane R may touch it **for BLZ-543 only**,
  because no lane runs after Lane R that would collide. Otherwise report, don't fix.
- **`tests/**` corpus-wide sweeps — Lane T's lane.** Lane R adds its own test files but must not sweep others.
- **BLZ-531 — the split-out ledger-quarantine subsystem.** `high`, 90 min, and it lands in this repo,
  but it is **its own PR and its own review cycle**, not a Lane R or Lane T ticket. A full WIP fix
  exists at **`origin/BLZ-518-partial-ledger-quarantine-wip` (`f803747`)** and was **refused merge after
  two refutations**. Do not merge that branch as-is. Its four landing conditions are on the ticket.
- **The NCA project** — parked by the operator 2026-08-23. Do not touch.
- **`provider` in `blaze-pm/blaze.config.json`** — self-resolves at the flush. Do not "fix".
- **The 185 orphaned ledger ops** — still the evidence for BLZ-529 and BLZ-531. **Do not drain.**
  Phase 1 preserved them byte-identical through five agents and eleven ticket moves.
- **The `/tmp` scratch corpus** — evidence for BLZ-503. Do not clear before measuring.
- **`scripts/metadata_audit.py` does not exist on `BLZ-305-v4-spine`.** The copy at
  `blaze-pm/scripts/metadata_audit.py` reports **409 HARD `unknown-link-type`** — that is the script
  being **stale**, not a corpus defect: its `VALID_LINK_TYPES` predates the v4 spine's traceability
  types, and 322 `Implements` + 87 `Addresses` = exactly 409. Baseline was 409 before phase 1's board
  writes and 409 after. **Do not "fix" the corpus.**
- **`python3 scripts/build_matrices.py --check` reports MATRIX DRIFT** on the requirements and
  architecture matrices — and **already did at `12d143de`, before phase 1 touched anything.** Phase 1
  deliberately did not regenerate, to avoid folding an unknown pre-existing delta into a close-out
  commit. **Decide it deliberately or leave it; do not regenerate incidentally.**

## 6. Constraints — non-negotiable

- **Do NOT push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is nominally the sole
  merger — **but BLZ-525/526 establish it has never actually drained anything**, and the board is in
  practice merged by interactive sessions (128 of 361 commits carry the flush subject, spread across 20
  of 24 hours). Work there still ends at a **local commit**. `origin/BLZ-305-v4-spine` is `3083b9ca`;
  its last push predates 2026-08-27.
- **The board's working branch is `BLZ-305-v4-spine`** in `/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine`.
- **One writer for the board.** With parallel lanes the coordinator owns **all** `blaze` board ops. Lane
  agents must NOT run `blaze new`/`move`/`log`/`link`; they return findings in their final report as a
  list of `title | type | priority | estimate | one-line context`, and the coordinator files them. A
  single dedicated board-operator agent satisfies this; four lane agents writing one worktree does not.
- **The board has no `test-gap` type.** `blaze.config.json` → `schema.types`. Phase 1 filed those as
  `task` with "test gap:" leading the title. `labels` is `[]` in `project.json` — there is no taxonomy,
  so leave labels empty rather than inventing one.
- **`blaze reconcile` is a silent no-op from a worktree** (INF-763): `codeRepos` resolve relative to the
  board root, so from `v4-spine` every path misses and it prints "already in sync" having scanned zero
  repos. Phase 1 hand-moved tickets for this reason. Do not read its "in sync" as evidence.
- **Never run bare `blaze`** — it defaults to `start` and loops forever. Always name a subcommand,
  `</dev/null`, under `timeout`.
- **Never `git stash`** — repo-wide, shared across worktrees.
- **One agent per worktree; never let a reviewer and a fix agent share one.** Each concurrent agent gets
  its own Postgres container and port.
- **Do NOT reopen** ADR-0001, 0014's ruling, 0021, 0022's decision, 0023, 0024, 0025, 0026, 0027, 0028,
  0029, 0030, 0031, 0032. Build ON them. **ADR-0033 is still the next free number** — phase 1 did not
  take it.
- The setup token's **PATH** may be logged; its **VALUE** never is, anywhere, ever. **BLZ-512 touches
  `setup-token.mjs` — keep this true.** Phase 1 verified the BLZ-509 census records no URL- or
  userinfo-shaped argument across 2,612 probe rows; keep that property if you extend it.
- Never accept a secret pasted into chat; never base64-decode a Kubernetes secret value.
- **Do NOT run `blaze schedule migrate-dates --write`** against the live board.
- **Do not quote `mutate-schedule.mjs`** as evidence for anything outside `schedule.mjs`/`audit.mjs`
  (`docs/ci.md`, BLZ-441).
- **Do NOT disable branch protection's `strict: true`.** A file-overlap scan would NOT have predicted
  the #155/#158 conflict — they shared no file. Only the combined-state run catches that class.

## 7. Method — this is what produced phase 1

**Every PR gets an adversarial review before merge, in a SEPARATE worktree with its own Postgres, by an
agent that did not write the branch.** Scope: **PRODUCT BEHAVIOUR** — correctness, vacuous tests, the
board overstating, the pre-auth surface, blast radius. **Wording, figures and test-machinery findings
are recorded in the PR body and TICKETED — never fixed-and-re-reviewed.**

**Phase 1's record: 5 review rounds across 2 PRs, 5 refutations, every one a real silent defect** —
a permanent record-destruction path, an infinite hang, an operator-facing total that contradicted its
own disclaimer, a live remote fetched 4× a run, and a census blind to the very dependency it was
added to catch. **Two of the five were defects in a FIX for an earlier refutation.** Assume your fix
has one too.

**Tell the reviewer: report the verdict FIRST, append coverage after.** Phase 1 had reviewers stall by
backgrounding a coverage run having already reached their verdict — twice, plus two stale poll loops
that reported long after their findings were acted on.

**The revert rule** — revert the production hunk the test claims to pin, and watch **that named test**
go red **for the reason its name gives.** Three refinements, all earned:

1. **Pin the property, not the spelling.** The informative revert row is the one where the **old** test
   stays green under a narrow revert — that green row proves the hole existed. Phase 1's write-seam
   guard (BLZ-535) is this failure in a shipped guard.
2. **Two guards sharing one helper look pinned when only one is exercised.** Revert each separately.
3. **Test the case that passes by accident.**

**A measurement can be structurally blind.** Phase 1 found three: `outstanding` cannot observe a
dropped op because it is computed over records that still exist; the BLZ-509 census cannot observe a
network dependency while the host does not resolve; and a corroboration delta was once taken over a
suite where zero of 259 invocations involved the shape being changed. **When a measurement clears a
change, ask what it was incapable of observing.** That question found the record-destruction bug.

**Measure before any severity or behaviour change** (BLZ-353); **pin every figure to a SHA**
(ADR-0024) — and see BLZ-505 for why a SHA is not always enough when the run depended on another
repository's mutable state.

**State reachability plainly.** A guard no current call path can reach cannot be killed by any mutation
and must be described that way, not implied to be pinned — **and check that "unpinnable" is not merely
"unpinned"** (BLZ-538 is exactly that error, made while applying this rule).

**A demo script with a hardcoded absolute import silently re-tests the same tree.** Repoint per tree and
print which tree you loaded.

## 8. Process

Standing rules: `blaze` skill for every tracked item (ticket at create **with parent and estimate**;
branch `KEY-n-slug`; commits and PR title `KEY-n: description`; `blaze log` before a terminal move —
bare number). One commit per body of work; the message names everything in the diff. Docs update in the
same effort. `KEY-n + N more:` works as a squash manifest (confirmed live); a RANGE claims nothing.

**Inoculation — every lane will hit this.** `tests/tmp-scratch-attribution.test.mjs` asserts every
`mkdtempSync` under `tests/` has a **statically readable** prefix. Any new test file must write the
literal at the call site:
```js
const root = mkdtempSync(join(tmpdir(), "blaze-<yourprefix>-"));   // literal, NOT a variable
```
A variable prefix passes locally and reddens on merge. **Satisfy the guard; never except the suite.**

**`hygiene-check.mjs` fails on `Co-Authored-By:` trailers and on absolute `/home/...` paths in added
non-Markdown lines.** Markdown is exempt, which is why report files may carry paths.

**Model routing — set `model` on every dispatch, never inherit:**

| Job | Model |
|---|---|
| Read-only recon / codebase fan-out | `haiku` (low effort; `sonnet` if it must reason across many files) |
| Mechanical, already-designed implementation | `sonnet` |
| Complex or subtle implementation | `opus` |
| Judgement-heavy review — adversarial review, verify | `opus` |
| Design / architecture decision / hardest single verdict | `fable` — carry `# secondary: opus`, fable can be rate-limited |

## 9. Context — recently merged, adjacent to this work

| PR | What landed |
|---|---|
| `12a59ad` #162 | BLZ-505/506/507/508/509 — hermetic fixtures, the `%(refname)` namespace split, the shipped `BLZ_MEASURE` census, **`appendRegularFileSync`** |
| `5c699fe` #161 | BLZ-500/498/124/518/502 — the flush diagnosis and `docs/reports/2026-08-30-blz-500-ledger-capture.md`, queue attribution, per-queue `--status` degradation |
| `fd8c31d` #157 | BLZ-493 — the shared read path refuses a non-regular file; **ADR-0031**; `scripts/model/regular-file.mjs` (the open-fd guard Lane R must reuse) |
| `2951570` #156 | BLZ-492/495/489/494 — ref name that resolves, two guards now pinned, ADR-0026 comment. **Its "52 occurrences" headline is corrected on BLZ-492** |
| `21ceb42` #155 | BLZ-490/491/496/497 — `discardSandbox` guards, **`scripts/ci/tmp-scratch-attribution.mjs`** (the corpus guard above) |

## 10. Verification before every merge

From the lane's worktree, all three, Postgres confirmed up first:
```
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55481/postgres   # YOUR port — see §4
docker exec blzpg-55481 pg_isready -U postgres
node --test 2>&1 | tail -9
node scripts/ci/hygiene-check.mjs origin/main
npm run test:coverage
```
**Export `BLAZE_TEST_PG_URL` in the SAME shell call as the run.** Shell state does not persist between
tool calls, and an unset variable does not fail the suite — it silently removes the Postgres tests.

Baseline is **4,289 pass / 0 fail across 371 suites**, coverage **98.53 / 88.20 / 97.24**, at `12a59ad`.

**Four distinct red-suite signatures — do not confuse them:**

| Signature | Cause |
|---|---|
| total **unchanged** from baseline, failures present | `BLAZE_TEST_PG_URL` set but Postgres unreachable |
| total **lower**, with load errors | missing `node_modules` — run `npm ci` |
| total **lower**, **no errors, no failures** | **`BLAZE_TEST_PG_URL` UNSET.** Reproduced twice: `tests 4202 / pass 4200 / fail 0`. **BLZ-524.** |
| total **higher**, with failures | a real regression |
| run never terminates | **BLZ-534.** A hang is indistinguishable from a slow run — do not wait indefinitely. |

**When merging, assert on the check RESULT, not the absence of `pending`** — and assert the checks ran
on the **head SHA you are merging**. Verify with `gh pr view <n> --json state,mergedAt`; never treat a
silent `gh pr merge` as confirmed. `--delete-branch` fails harmlessly if a worktree holds the branch —
phase 1 saw this on both merges.

After each merge, any other open PR must be brought up to date (`gh pr update-branch <n>`), which
re-runs CI against the combined state. **Expect that to catch something. It is meant to.**
