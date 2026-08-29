# blaze — backlog burn-down kickoff (2026-08-30)

**If you are a session reading this, your task is §3 — run the four lanes in the stated phase order.**
You need no further instruction to begin.

Successor to `2026-08-30-blaze-post-blz-497-successor.md`, which is **fully discharged** (all four PRs
merged, all ten tickets `done`). **This document is the work order.** Where it contradicts a chat
instruction, follow this.

**It supersedes nothing else.** `docs/superpowers/plans/` holds **five** `*-next-session-kickoff.md`
files (08-23, 08-27, 08-29, 08-30, 08-31) from an **older, unrelated chain** — the 08-30 and 08-31
ones say "written 2026-08-26" in their own first line. **Do not read them as current and do not write over them**; a kickoff has
already been destroyed that way once. Descriptive filenames, never date-only.

---

## 0. Continuity contract

A usage, context or API limit is a **PAUSE, not completion.** Do not stop, do not mark anything done,
do not hand back early. **Commit WIP freely on your lane branch while work is in flight** — this
overrides §8's one-commit-per-body-of-work rule, which governs what you SHIP, not what you checkpoint.
Before opening the PR, squash your checkpoints so the branch carries one commit per ticket. Resume from the branch plus the ticket's own
acceptance-criteria checkboxes. The previous session lost two lanes to a rate limit mid-flight and
recovered both by reading the worktrees rather than the agents' last words — **verify tree state, never
trust a report.**

## 1. Goal

Burn down the backlog left by the BLZ-489..497 lane — **26 tickets, 760 minutes, 2 high / 9 medium /
15 low** (24 handed over, plus **BLZ-124** which collides with Lane L and **BLZ-524** found while
verifying this brief) — starting with the two `high` items, which share one theme: **a figure nobody can reproduce
is not a figure.**

**Definition of done:** BLZ-505 and BLZ-500 closed or consciously deferred with a written reason;
every lane's tickets `done` or explicitly left with the reason; `main` green on the full gate; a
successor kickoff written if anything remains.

**Stop rule.** Finish the phase you are in, then stop and write the successor kickoff if ANY of:
context is running short, a lane has been refuted twice on the same ticket, or you have merged every
phase-1 and phase-2 lane. **Do not start phase 3 with less than roughly a third of your context left**
— it edits test files corpus-wide and a half-done sweep is worse than none. Stopping cleanly with a
written handoff is a success, not a shortfall.

## 2. State — re-verify before building, do not take as gospel

`main` at **`e67dc0f`**. Suite **4,261 pass / 0 fail**, 367 suites. Coverage 98.60 / 88.11 / 97.23.
Zero open PRs, zero worktrees. Board audit `ok=true` over 2,772 tickets.

`blaze-pm` is **47 commits unpushed** on `BLZ-305-v4-spine` and **that is correct** — see §6.

Confirm before you build:
```
cd /home/rnamwoh/Documents/Code/blaze && git fetch origin && git log --oneline -1 origin/main
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55481/postgres   # see §4 first
npm ci && node --test 2>&1 | tail -9
```
`tail -9` is deliberate — `tail -5` shows only `fail/cancelled/skipped/todo/duration_ms` and **cannot
show `tests`, `pass` or `suites`**, which are the three figures you are told to compare.

## 3. Lanes, in phase order

**The phase order is not stylistic — each boundary is a verified file collision.** The last session
called two lanes disjoint that shared two test files, and separately hit a semantic conflict between
two branches that shared *no* file. Both cost a rebuild.

### Phase 1 — two lanes, in parallel

#### Lane C — reconcile and its figures (115 min) · **sole owner of `scripts/reconcile.mjs`**

| Ticket | Pri | Est | What |
|---|---|---|---|
| **BLZ-505** | **high** | 40 | `tests/reconcile-finding-surfaces.test.mjs` points `origin` at a **live GitHub URL** at four sites (lines 123, 269, 323, 412 — line 191's `gitlab.com` is a decoy, and `grep -- '--fetch'` in this file returns NOTHING, so do not conclude the ticket is wrong: three of the four fetch because `scripts/supervisor.mjs:286` hardcodes `reconcile({ fetch: true, … })`, and the CLI site at 137 spawns with no args and does not fetch). **BLZ-492's headline "52 occurrences" is 26 live branches × 2 fixtures** — quoted in the ticket, a merged PR body and two work orders as if reproducible. Make the fixture hermetic, then **re-derive 52 and correct it wherever it is quoted.** |
| BLZ-506 | medium | 25 | `%(refname:short)` renders `refs/heads/origin/x` and `refs/remotes/origin/x` identically. BLZ-492 fixed the *ordering* symptom; this is the namespace split (`%(refname)`). **Measure the corroboration delta before shipping** (BLZ-353). |
| BLZ-507 | medium | 25 | ADR-0026's third write path is pinned only at unit level — no end-to-end write test. |
| BLZ-508 | low | 15 | `inspect`'s `rev-parse` `exitIsAnAnswer` is unreachable and unpinnable. Decide keep-vs-remove. **Its sibling site IS load-bearing — do not conflate them.** |
| BLZ-509 | low | 10 | **THREE** occurrences quote "the 330 reconcile tests" — `reconcile.mjs:584`, `:1150` and `:1176`. It is 371+. Fixing only the two an earlier draft named leaves a live stale figure, in the exact class BLZ-523 guards. |

**Files:** `scripts/reconcile.mjs`, `tests/reconcile-*.test.mjs`.

#### Lane L — the ledger and the flush (180 min)

| Ticket | Pri | Est | What |
|---|---|---|---|
| **BLZ-500** | **high** | 30 | The `blaze-flush` CronJob appears not to drain every queue — **185 ops across 8 of 14 queues, five nightly runs passed over them.** Undiagnosed; the CronJob definition is not in this repo. **DO NOT drain the queues before diagnosing** — they are the only evidence and 67 of 185 are un-characterised. Capture the ledger to a file first. This refusal is recorded on the ticket. |
| BLZ-498 | medium | 45 | `blaze commit` drains only the caller's own session queue; every abandoned session leaks one forever. |
| BLZ-518 | medium | 45 | `blaze commit --status` crashes on a malformed ledger, and **one bad path aborts the whole report including healthy queues.** The out-of-board refusal is CORRECT (BLZ-394) — keep it, stop it taking the report down. |
| BLZ-502 | low | 15 | A failed `git add` is reported as `git commit failed`, sending the operator to look at hooks. |
| **BLZ-124** | low | 45 | **Read this BEFORE BLZ-498 — the two appear to contradict each other.** BLZ-124 (filed 2026-07-17) says *"a subagent running `blaze commit` flushes its sibling subagents' in-flight ops"*; BLZ-498 (filed 2026-08-29) says it *"drains only the caller's own session queue"*. Opposite claims about one mechanism. Either the behaviour changed, or one is wrong. **Establish which by construction before writing any fix**, and correct whichever ticket is stale. Do not work them independently. |

**Files:** `scripts/pending-ledger.mjs`, `scripts/commit-runner.mjs`, `scripts/commit-or-queue.mjs`,
`scripts/serve-commit.mjs`, `scripts/reconcile-commit-report.mjs`, `tests/commit-status.test.mjs`.

### Phase 2 — after Lane L merges

#### Lane R — the read path finishes what BLZ-493 started (260 min)

**Runs after Lane L for ONE verified reason: BLZ-512's sites include `scripts/pending-ledger.mjs`,
which Lane L owns.** (`commit-lock.mjs:14` is also a BLZ-512 site but no Lane L ticket touches it, so
it is not a cross-lane collision — do not cite it as one.) **Re-derive the ledger line numbers:** live
HEAD has `readFileSync` at `:58`, `:70` and `:86`, while BLZ-512's own table says `:69` and `:85`.
Three sources, no two agreeing — trust the file.

| Ticket | Pri | Est | What |
|---|---|---|---|
| **BLZ-512** | medium | 90 | ~20 same-shape `readFileSync` sites still block forever on a FIFO. **`scripts/model/setup-token.mjs:68` is on the PRE-AUTH surface — treat it as the highest-priority member.** `scripts/commit-lock.mjs:14` is an **eleventh site** the original inventory missed (verified: a FIFO `owner.json` hangs `acquireLock`). **Re-derive the list — the "~20" came from an inventory since shown to miss one site and misclassify three.** |
| BLZ-519 | medium | 45 | A refusing or malformed board file **kills the whole `blaze serve` process**, not just the route. Pre-existing crash class; ADR-0031 §5 understates it. |
| BLZ-514 | medium | 40 | `audit-runner`'s catch launders a malformed `project.json` into a bare `{key}` — BLZ-470's class, one step down. |
| BLZ-513 | low | 30 | `liveModel`'s `unreadable` is not on the read seam. |
| BLZ-511 | low | 20 | `classifyGitEntry` still uses `statSync`-then-open, keeping the race BLZ-493 removed elsewhere. |
| BLZ-520 | low | 20 | **ADR-0031 records the WRONG reachability path** for the schema-config site — it is `blaze new`/`edit` (`scripts/model/edit.mjs:55`, also `:66`, and `scripts/model/new.mjs:83`), not the audit's schema layer; **`scripts/model/audit.mjs`** never calls `loadProjectSchema`. (Note there are three `audit*.mjs` files — `scripts/model/audit.mjs`, `scripts/migrate/audit.mjs`, `scripts/audit-runner.mjs`. Always use full paths.) Also its line 201 says "4,201 tests" (now 4,261). **Correct the record; the decision stands — do not reopen ADR-0031.** |
| BLZ-510 | low | 15 | `fsStorage.read` blocks on a non-regular file; on no current call path. |

**Files:** `scripts/model/**`, `scripts/views/**`, `scripts/serve.mjs`, `scripts/audit-runner.mjs`,
`scripts/config.mjs`, `scripts/commit-lock.mjs`, **`scripts/pending-ledger.mjs` (inherited from Lane L
once it merges — this is why the phase boundary exists)**, `docs/decisions/0031-*.md`.

### Phase 3 — alone, last

#### Lane T — test machinery and the `/tmp` corpus (205 min)

**Runs alone and last because BLZ-503 edits test files corpus-wide and will collide with every lane
that adds one.** This is exactly how PR #158 went red after #155 merged.

| Ticket | Pri | Est | What |
|---|---|---|---|
| BLZ-503 | medium | 45 | The suite leaks `/tmp` scratch dirs: **53,933 → 65,490 in one session, +11,557.** Worst prefixes: `seam-` 5,569, `ofc-` 4,439, `blaze-readseam-` 4,224, `blaze-init-` 4,062. `node scripts/ci/tmp-scratch-attribution.mjs` prints the breakdown. **Do not clear them before measuring — the breakdown IS the evidence.** |
| BLZ-523 | low | 30 | No general guard binds a doc-quoted product string to its source. **Do BLZ-509 and BLZ-520 first** (Lanes C and R) — doing them by hand tells you whether a mechanism is warranted. Consider an opt-in registry over a corpus grep; a noisy guard gets excepted until it means nothing. |
| BLZ-516 | low | 20 | The attribution scan's **static** property is CI-gated; its **run-level** scan is not. |
| BLZ-517 | low | 20 | The no-leak proof is ~10 lines of boilerplate per suite and pins only the guards suite. |
| BLZ-504 | low | 15 | The mutation runner's teardown guard counts the **string** `rmSync(` including comments — a docstring fails it. **Cost two round-trips in one ticket already.** |
| BLZ-515 | low | 15 | The finding-kind extractor silently drops an inline `kind:` on any line containing `//` earlier (e.g. a URL). **The exact fail-open BLZ-496 exists to close, surviving in one form.** |
| BLZ-521 | low | 15 | The fd-guard test pins the spelling `statSync(` — `lstatSync(` or an alias evades it. |
| BLZ-522 | low | 15 | The FIFO child-process wall-clock cap SIGTERMs a healthy child under multi-agent load. **Do not fix the flake by removing the protection.** |
| **BLZ-524** | medium | 30 | The Postgres suite is wrapped in a bare `if (process.env.BLAZE_TEST_PG_URL)`, so with the variable unset it is **never registered** — no skip, no warning, a quarter of the suite silently gone and the run reads as a pass. ADR-0030's thesis applied to the harness that verifies everything else. |

**Files:** `tests/**`, `scripts/ci/**`.

## 4. Worktree setup — per lane, run verbatim

```
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
cd /home/rnamwoh/Documents/Code/blaze
git fetch origin
# Phase 1
git worktree add /home/rnamwoh/Documents/Code/blaze-worktrees/lane-c -b BLZ-505-reconcile-figures origin/main
git worktree add /home/rnamwoh/Documents/Code/blaze-worktrees/lane-l -b BLZ-500-ledger-and-flush origin/main
# Phase 2 (cut AFTER Lane L merges, off the advanced main)
git worktree add /home/rnamwoh/Documents/Code/blaze-worktrees/lane-r -b BLZ-512-read-path-residue origin/main
# Phase 3 (cut AFTER phase 2 merges)
git worktree add /home/rnamwoh/Documents/Code/blaze-worktrees/lane-t -b BLZ-503-test-machinery origin/main
# each worktree needs its own deps — a fresh worktree has NO node_modules
cd /home/rnamwoh/Documents/Code/blaze-worktrees/lane-c && npm ci
cd /home/rnamwoh/Documents/Code/blaze-worktrees/lane-l && npm ci
```
Branch names are `KEY-n-slug` keyed to each lane's **lead** ticket (its `high` one where it has one,
otherwise its largest): `BLZ-505`, `BLZ-500`, `BLZ-512`, `BLZ-503`. PR titles then take the
`KEY-a + N more: description` form, which BLZ-469 reads as a squash manifest.

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
starts. Use a distinct port per concurrent agent (55481, 55482, …).

## 5. Out of scope — the negative space

- **`scripts/reconcile.mjs` — Lane C's lane.** No other lane edits it. Report, don't fix.
- **`scripts/pending-ledger.mjs`, `commit-runner.mjs`, `commit-or-queue.mjs` — Lane L's lane**, until Lane L merges. Lane R inherits them in phase 2.
- **`tests/**` corpus-wide sweeps — Lane T's lane.** Other lanes add their own test files but must not sweep others.
- **The NCA project** — parked by the operator 2026-08-23. Do not touch.
- **`provider` in `blaze-pm/blaze.config.json`** — self-resolves at the flush. Do not "fix".
- **The 185 orphaned ledger ops** — evidence for BLZ-500. Do not drain.
- **The `/tmp` scratch corpus** — evidence for BLZ-503. Do not clear before measuring.

## 6. Constraints — non-negotiable

- **Do NOT push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole merger. Work there ends at a **local commit**. Measure unpushed against `origin/BLZ-305-v4-spine` (**47**), **not** `origin/main` (**204** — a different base, already misreported once as evidence the board had drifted).
- **The board's working branch is `BLZ-305-v4-spine`** in `/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine`.
- **One writer for the board.** With parallel lanes the coordinator owns **all** `blaze` board ops. Lane agents must NOT run `blaze new`/`move`/`log`/`link`; they return findings in their final report as a list of `title | type | priority | estimate | one-line context`, and the coordinator files them. Four agents writing one board worktree is how index-sweep and branch-collision bugs happen.
- **Never run bare `blaze`** — it defaults to `start` and loops forever. Always name a subcommand, `</dev/null`, under `timeout`.
- **Never `git stash`** — repo-wide, shared across worktrees.
- **One agent per worktree; never let a reviewer and a fix agent share one.** Each concurrent agent gets its own Postgres container and port.
- **Do NOT reopen** ADR-0001, 0014's ruling, 0021, 0022's decision, 0023, 0024, 0025, 0026, 0027, 0028, 0029, 0030, 0031, 0032. Build ON them. **ADR-0033 is the next free number.**
- The setup token's **PATH** may be logged; its **VALUE** never is, anywhere, ever. BLZ-512 touches `setup-token.mjs` — keep this true.
- Never accept a secret pasted into chat; never base64-decode a Kubernetes secret value.
- **Do NOT run `blaze schedule migrate-dates --write`** against the live board.
- **Do not quote `mutate-schedule.mjs`** as evidence for anything outside `schedule.mjs`/`audit.mjs` (`docs/ci.md`, BLZ-441).
- **Do NOT disable branch protection's `strict: true`.** A file-overlap scan would NOT have predicted the #155/#158 conflict — they shared no file. Only the combined-state run catches that class.

## 7. Method — this is what produced the last two lanes

**Every PR gets an adversarial review before merge, in a SEPARATE worktree with its own Postgres, by
an agent that did not write the branch.** Scope: **PRODUCT BEHAVIOUR** — correctness, vacuous tests,
the board overstating, the pre-auth surface, blast radius. **Wording, figures and test-machinery
findings are recorded in the PR body and TICKETED — never fixed-and-re-reviewed.** Last lane: **3 of
4 PRs refuted on the first round, every refutation a real silent defect.**

**Tell the reviewer: report the verdict FIRST, append coverage after.** Two of three reviewers stalled
by backgrounding a coverage run having already reached their verdict.

**The revert rule** — revert the production hunk the test claims to pin, and watch **that named test**
go red **for the reason its name gives.** Three refinements, all earned:

1. **Pin the property, not the spelling.** Two refutations were guards whose tests covered one
   spelling. After a fix, the informative revert row is the one where the **old** test stays green
   under a narrow revert — that green row proves the hole existed.
2. **Two guards sharing one helper look pinned when only one is exercised.** Revert each separately.
3. **Test the case that passes by accident.**

**A measurement can be structurally blind.** One corroboration delta was taken over a suite where
**zero of 259 invocations** involved the shape being changed. When a measurement clears a change, ask
what it was incapable of observing.

**Measure before any severity or behaviour change** (BLZ-353); **pin every figure to a SHA**
(ADR-0024) — and see BLZ-505 for why a SHA is not always enough.

**State reachability plainly.** A guard no current call path can reach cannot be killed by any
mutation and must be described that way, not implied to be pinned.

**A demo script with a hardcoded absolute import silently re-tests the same tree.** Repoint per tree
and print which tree you loaded. This produced a false "no regression" reading last session.

## 8. Process

Standing rules: `blaze` skill for every tracked item (ticket at create **with parent and estimate**;
branch `KEY-n-slug`; commits and PR title `KEY-n: description`; `blaze log` before a terminal move —
bare number). One commit per body of work; the message names everything in the diff. Docs update in
the same effort. `KEY-n + N more:` works as a squash manifest (confirmed live); a RANGE claims nothing.

**Inoculation — every lane will hit this.** `tests/tmp-scratch-attribution.test.mjs` asserts every
`mkdtempSync` under `tests/` has a **statically readable** prefix. Any new test file must write the
literal at the call site:
```js
const root = mkdtempSync(join(tmpdir(), "blaze-<yourprefix>-"));   // literal, NOT a variable
```
A variable prefix passes locally and reddens on merge. **Satisfy the guard; never except the suite.**

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
| `fd8c31d` #157 | BLZ-493 — the shared read path refuses a non-regular file; **ADR-0031**; `scripts/model/regular-file.mjs` (the open-fd guard Lane R must reuse) |
| `2951570` #156 | BLZ-492/495/489/494 — ref name that resolves, two guards now pinned, ADR-0026 comment |
| `21ceb42` #155 | BLZ-490/491/496/497 — `discardSandbox` guards, **`scripts/ci/tmp-scratch-attribution.mjs`** (the corpus guard above) |
| `d0f847b` #158 | BLZ-432/499 — `blaze commit --status`; **ADR-0032** |
| `e67dc0f` #159 | The successor kickoff this document replaces |

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
tool calls, and an unset variable does not fail the suite — it silently removes the Postgres tests
(see the signature table below).
Baseline is **4,261 pass / 0 fail across 367 suites** at `e67dc0f`.

**Three distinct red-suite signatures — do not confuse them:**

| Signature | Cause |
|---|---|
| total **unchanged** from baseline, failures present | `BLAZE_TEST_PG_URL` set but Postgres unreachable |
| total **lower**, with load errors | missing `node_modules` — run `npm ci` |
| total **lower**, **no errors, no failures** | **`BLAZE_TEST_PG_URL` UNSET.** The Postgres tests are wrapped in a bare `if (process.env.BLAZE_TEST_PG_URL)` (`tests/model/coverage.test.mjs:148`, `tests/model/scheduling-columns.test.mjs:98`), so they are **never registered** — no skip, no warning. A quarter of the suite silently vanishes and the run reads as a pass. Filed as **BLZ-524**. |
| total **higher**, with failures | a real regression |

`hygiene-check.mjs` fails on `Co-Authored-By:` trailers and on absolute `/home/...` paths in added
**non-Markdown** lines.

**When merging, assert on the check RESULT, not the absence of `pending`** — and assert the checks ran
on the **head SHA you are merging**. Verify with `gh pr view <n> --json state,mergedAt`; never treat a
silent `gh pr merge` as confirmed. `--delete-branch` fails harmlessly if a worktree holds the branch.

After each phase-1 merge, the other open PR must be brought up to date (`gh pr update-branch <n>`),
which re-runs CI against the combined state. **Expect that to catch something. It is meant to.**
