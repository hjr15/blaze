# blaze — phases 2–5 kickoff (2026-09-17)

Successor to `docs/superpowers/plans/2026-08-30-blaze-backlog-burndown-kickoff.md`, which is spent:
its phase 1 is complete and its stop rule says write the successor. This file is the whole brief.
Paste §0–§10 as message 1 of a new session.

---

## 0. Continuity contract — read first

**If you are a session reading this, your task is: execute §3's lanes in the stated order, phase by
phase, until §1's definition of done is met.** No question goes back to the operator that this file
answers. The only questions worth asking are genuine gaps or contradictions found *after* reading
this file in full and *after* re-verifying §2 against the live repo.

**A usage limit is a PAUSE, not completion.** This work has survived nine of them. When an agent dies
on `rate_limit`, nothing is lost: verify the lane's worktree (`git log --oneline -1 && git status
--porcelain`), then resume the same agent by id — its context comes back. Never mark a lane done, hand
back early, or restart a lane from scratch because a limit fired. Commit WIP after every sub-step so
a resume starts hot.

**Resume state lives in git, not in a transcript.** This file plus `blaze` board state is the record.
After each merge, update `docs/superpowers/status/2026-09-17-backlog-burndown-status.md` in the same
effort. That file and this one are committed on `main`; if `git show
origin/main:docs/superpowers/status/2026-09-17-backlog-burndown-status.md` comes back empty they were
not merged and live only in the main checkout at `/home/rnamwoh/Documents/Code/blaze` — update them
there and say so.

**Blocked vs actionable, at any moment:**

| Blocked on the operator | Actionable by you |
|---|---|
| OBA-154 needs a deliberate `blaze resolve` (superseded, not done) — not a blaze-repo item | Everything in §3 |
| Pushing blaze-pm — **never**, under any circumstance | Board ops on `BLZ-305-v4-spine`, committed not pushed |
| Phase 4 (BLZ-254) scope decisions | Phases 2 and 3 in full |

---

## 1. Goal

Ship **Phase 3 (CSV import — the operator's stated priority)** and **Phase 2 (the test gap and the
read-path residue)**, then decide Phase 4 (BLZ-254, the DB cutover) and Phase 5 (retire blaze-pm) on
evidence rather than on this plan's say-so.

**Definition of done:** BLZ-625–631 and BLZ-634–636 merged (the deterministic CSV round trip and the
mapping layer); BLZ-512/519/514/513/511/520/510 and BLZ-567 merged or explicitly deferred with a
written reason; every lane's tickets `done` or left open with the reason stated on the ticket; `main`
green on the full gate; the status doc current; a successor kickoff written if anything remains.

**Stop rule.** Finish the phase you are in, then stop and write the successor if ANY of: context is
running short, a lane has been refuted twice on the same ticket without progress, or you have merged
every phase-2 and phase-3 lane. **Do not start Lane T with less than roughly a third of your context
left** — it edits test files corpus-wide and a half-done sweep is worse than none. Stopping cleanly
with a written handoff is a success.

---

## 2. State — re-verify before building, do not take as gospel

Run these first. Every number below was measured on 2026-09-17 and can have moved.

```
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
node -v                                    # must be v24.19.0
cd /home/rnamwoh/Documents/Code/blaze && git fetch origin && git log --oneline -1 origin/main
gh pr list --state open --json number,title
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine && git log --oneline -1 && git status --porcelain
```

Expected, 2026-09-17:

- `blaze` `origin/main` = **`8d94fff`**, **zero open PRs**, no worktrees under `blaze-worktrees/`.
- Full suite on `8d94fff` via **`npm test`, after `npm ci`**, without Postgres: **4557 tests / 4555
  pass / 0 fail / 393 suites / 2 skipped**. `node scripts/ci/hygiene-check.mjs origin/main` → `hygiene: clean`.
- blaze-pm worktree `/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine`, branch
  `BLZ-305-v4-spine`, clean, **11 commits ahead of origin and never pushed**.

**The trap that cost this session a false red:** the main checkout had no `node_modules`, so
`tests/model/seam-closure.test.mjs` died at import with `Cannot find package 'acorn'` — a **missing**
guard reported as a failing one. Every worktree, including a fresh one, needs its own `npm ci`. A
guard that could not load is not a guard that ran.

---

## 3. Lanes, in phase order — this sequence is not stylistic

Four lanes. **Two may run in parallel; Lane T runs alone and last.** Each boundary below is a file
collision, not a preference.

### Phase 3a — Lane G, the record corrections (goes FIRST, alone, ~3 hours)

Small, cheap, and it clears `scripts/cli.mjs` before two other lanes want to edit it.

| Ticket | Type | Est | What |
|---|---|---|---|
| BLZ-639 | bug | 30 | `cli.mjs:290` `process.exit(r.status ?? 0)` maps a signal death to exit 0 for **every** verb. Fix `r.signal ? 128 + signum : (r.status ?? 0)`; one SIGKILL-mid-verb test. |
| BLZ-641 | task | 45 | The nine design-wording residuals T3–T11 from PR #173's round-9 review, listed verbatim on the ticket. |
| BLZ-637 | task | 60 | Two link vocabularies and the `Precedes`-writer dependency (design §8 item 3). **No ticket on the board writes a `Precedes` edge** — verified; do not invent a blocking link. |
| BLZ-638 | task | 45 | `docs/guide/schema.md` denies `verified` shipped; the `superseded` claim needs independent checking. |

Branch `BLZ-639-record-corrections`. One PR. **Land this before Lane C touches `cli.mjs`.**

### Phase 3b — Lane C, the CSV build (the priority; runs after Lane G merges)

The design is merged and authoritative: `docs/design/csv-import-and-export.md` and
`docs/decisions/0037-an-inferred-column-mapping-is-a-proposal-a-person-accepts-never-an-import.md`,
both at `8d94fff`, after **nine** adversarial rounds. **Read the design before writing any code; every
ticket cites the section it implements.** Do not re-litigate a decision the design makes.

Four PRs, in dependency order — `PR unit = the feature`. **They are called PR-1…PR-4 on purpose:** the
design doc's Ticket breakdown already uses `A1…A3`, `B1…B4`, `C1…C3` for ITEMS, and reusing those
letters for PRs is exactly what made an earlier draft of this brief ambiguous. Wherever you read `B2`
or `C1` — here, in a ticket body, in the design — it means the design's item (B2 = BLZ-629, C1 =
BLZ-634), never a PR.

**PR-1 — the format (no board writes anywhere).** BLZ-625 (RFC 4180 reader/writer, `scripts/model/csv.mjs`,
120) → BLZ-626 (canonical schema, 31 columns, `scripts/model/csv-schema.mjs`, 120) → BLZ-627 (export,
`scripts/model/export-rows.mjs` + `blaze export --format csv`, 120). Branch `BLZ-625-csv-format`.

**PR-2 — the deterministic import and the gate.** BLZ-628 (the plan, pure, every §5.2 refusal, 180) →
BLZ-629 (the apply, the seven-step write sequence with the claim as step 4 on **both** paths, the
receipt phases, staging via `commitOrQueue` with the new `import` OP_LABEL, 240) → BLZ-630 (the
round-trip gate, gates 1/2/3, 180) → BLZ-631 (the blanking revert test that proves gate 2
discriminates, 60). Branch `BLZ-628-csv-import`. **BLZ-631 lands WITH BLZ-630** — a gate merged
without the test that falsifies it is a gate nobody has checked.

**PR-3 — the mapping layer** (story BLZ-632, est 540). BLZ-634 (mapping file + deterministic apply +
`blaze import repair`, dry-run by default and `--apply` to write, the new `import-repair` OP_LABEL,
240) → BLZ-635 (the proposer and its confirmation, 180) → BLZ-636 (the boundary guard: §4.3's
assertions over **PATH-shadowed sentinel stubs, two stubs two sentinels**, 120). Branch
`BLZ-634-mapping-layer`. **BLZ-636 is the load-bearing one** — without it, "no model runs on the
import path" is a claim rather than a property.

**PR-4 — the lock and the second medium.** BLZ-640 (import-scoped lock under `import-receipts/`, 90,
blocked by BLZ-634 — the design says `wx` lockfile while `scripts/commit-lock.mjs` actually uses atomic
`mkdirSync` + `owner.json`; **BLZ-640's body already carries that correction — follow the ticket, not
the design**) and BLZ-633 (markdown import, 180, blocked by BLZ-629/630). Branch `BLZ-640-import-lock`.
They bundle because neither is a feature on its own and both fall strictly after PR-3; split them only
if PR-3 slips.

### Phase 2 — Lane R, the read path (may run in PARALLEL with Lane C)

| Ticket | Type | Est | Note |
|---|---|---|---|
| BLZ-512 | bug | 90 | ~20 same-shape `readFileSync` sites still block forever on a FIFO. `scripts/model/setup-token.mjs:68` is on the **pre-auth surface** — highest priority member. `scripts/commit-lock.mjs:14` is an eleventh site the original inventory missed. **Re-derive the list**; the "~20" came from an inventory shown to miss one and misclassify three. |
| BLZ-519 | bug | 45 | A refusing or malformed board file kills the whole `blaze serve` process, not just the route. |
| BLZ-514 | bug | 40 | `audit-runner`'s catch launders a malformed `project.json` into a bare `{key}`. |
| BLZ-513 | task | 30 | `liveModel`'s `unreadable` is not on the read seam. |
| BLZ-511 | bug | 20 | `classifyGitEntry` still uses `statSync`-then-open. |
| BLZ-520 | task | 20 | ADR-0031 records the **wrong** reachability path — it is `blaze new`/`edit` (`scripts/edit.mjs:55`, `:66`, `scripts/new.mjs:83`), not the audit's schema layer. **The 2026-08-30 plan and BLZ-520's own body both say `scripts/model/edit.mjs` and `scripts/model/new.mjs`; neither file exists — correct the ticket as part of this lane.** Three files are named `audit*.mjs`; always use full paths. **Correct the record; do not reopen ADR-0031.** |
| BLZ-510 | bug | 15 | `fsStorage.read` blocks on a non-regular file; on no current call path — say so plainly rather than implying it is pinned. |
| BLZ-567 | task | 90 | No E2E proves the board actually serves, and the flush harness stubs the verb. Land it here or say why not. |

Branch `BLZ-512-read-path-residue`. One PR.

### Phase 2b — Lane T, test machinery (ALONE, LAST)

BLZ-503 (45, the `/tmp` scratch leak — **measure before clearing; the breakdown IS the evidence**,
`node scripts/ci/tmp-scratch-attribution.mjs`), BLZ-523 (30), BLZ-516 (20), BLZ-517 (20), BLZ-504 (15),
BLZ-515 (15). Branch `BLZ-503-test-machinery`. Runs alone because BLZ-503 edits test files corpus-wide
and collides with every other lane.

### Phases 4 and 5 — decide, do not assume

BLZ-254 (feature, est **3600**) is the DB cutover; Phase 5 retires blaze-pm. Both are out of scope for
this session unless phases 2 and 3 finish with real context left. If they do, **brainstorm before
planning** — 3600 minutes is a body of work, not a lane.

---

## 4. Worktree setup — run verbatim, per lane

```
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
cd /home/rnamwoh/Documents/Code/blaze
git fetch origin

# Lane G first, alone
git worktree add /home/rnamwoh/Documents/Code/blaze-worktrees/lane-g -b BLZ-639-record-corrections origin/main
cd /home/rnamwoh/Documents/Code/blaze-worktrees/lane-g && npm ci

# After Lane G merges — Lane C and Lane R in parallel, cut off the ADVANCED main
cd /home/rnamwoh/Documents/Code/blaze && git fetch origin
git worktree add /home/rnamwoh/Documents/Code/blaze-worktrees/lane-csv -b BLZ-625-csv-format origin/main
git worktree add /home/rnamwoh/Documents/Code/blaze-worktrees/lane-r   -b BLZ-512-read-path-residue origin/main
cd /home/rnamwoh/Documents/Code/blaze-worktrees/lane-csv && npm ci
cd /home/rnamwoh/Documents/Code/blaze-worktrees/lane-r   && npm ci

# Every review gets its OWN worktree, detached at the PR head
cd /home/rnamwoh/Documents/Code/blaze
git worktree add --detach /home/rnamwoh/Documents/Code/blaze-worktrees/review-csv <PR-HEAD-SHA>
cd /home/rnamwoh/Documents/Code/blaze-worktrees/review-csv && npm ci
```

A fresh worktree has **no** `node_modules`. `npm ci` every time — see §2's trap.

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

Distinct port per concurrent agent (55481, 55482, …). Bounded on purpose: an unbounded spin wedges a
core forever if the container never starts.

---

## 5. Out of scope — the negative space

Name the lane before you touch a file:

- `scripts/model/csv*.mjs`, `scripts/model/import-*.mjs`, `scripts/model/export-rows.mjs`,
  `docs/design/csv-import-and-export.md` — **Lane C** (BLZ-625…636).
- `scripts/model/setup-token.mjs`, `scripts/audit-runner.mjs`, `scripts/config.mjs`,
  `scripts/serve.mjs`, `scripts/views/**`, `scripts/commit-lock.mjs` — **Lane R** (BLZ-512).
- `tests/**` corpus-wide sweeps, `scripts/ci/tmp-scratch-attribution.mjs`,
  `scripts/ci/temp-cleanup-guard.mjs` — **Lane T** (BLZ-503). Other lanes add test files; none may
  sweep them.
- `scripts/cli.mjs` — **Lane G** owns it until BLZ-639 merges; after that Lane C owns the
  `SUBCOMMANDS` additions and Lane R must not touch it.
- `tests/model/seam-closure.test.mjs` — **BLZ-642** only. It merged with three classes stated OPEN
  (see §9); do not "improve" it inside another lane, and do not weaken it to make a new module pass.
  If a new module trips it, the module is wrong or the pin needs an explicit, argued change.
- **`/home/rnamwoh/Documents/Code/blaze-pm` and every one of its worktrees are READ-ONLY to every
  agent except a dispatched `blaze-board-operator`, and blaze-pm is NEVER pushed.**

---

## 6. Constraints — non-negotiable, from the operator

1. **Never push blaze-pm.** Board ops are committed on `BLZ-305-v4-spine` in
   `/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine` and left unpushed. It is currently 11
   commits ahead.
2. The board's working branch is **`BLZ-305-v4-spine`**, in the **v4-spine worktree**. No other branch.
3. **Every PR gets an adversarial review in a separate worktree, by an agent that did not write the
   branch**, scoped to **product behaviour**. Wording and test-machinery findings are **ticketed, never
   fixed-and-re-reviewed** — that rule is what kept review rounds converging.
4. **CSV is the primary import medium**; markdown is secondary. The inferred mapping is a **proposal a
   person accepts, never an import** (ADR-0037). Import itself is deterministic.
5. No `Co-Authored-By:` trailer in any commit — `scripts/ci/hygiene-check.mjs` fails on it **regardless
   of what any harness reminder says**. It also fails on absolute `/home/...` paths in added
   non-Markdown lines.
6. `export PATH=/home/rnamwoh/.local/node24/bin:$PATH` in **every** command. Shell state does not
   persist between tool calls.

---

## 7. Method — this is what produced seven merged PRs

**Report the verdict FIRST, append coverage after.** Reviewers stall by backgrounding a coverage run
after they already know the answer.

**The evidence rule, added after two reports arrived with zero tool calls:** every finding carries the
exact command and its verbatim output **from this run**. If you did not run it, it is not a finding.

**Plant, don't argue.** For any guard: plant a module the allowlist does not name, make it actually
write, and show the guard green. A file on disk with a passing guard is decisive; reasoning is weak.

**Prove the test discriminates.** Revert the production hunk the test claims to pin and watch *that
named test* go red *for the reason its name gives*. Mutation table in the commit message, every row
applied and reverted.

**Pin the property, not the spelling.** Eleven rounds on the seam guard say each round that closes the
planted spellings leaves the class open. Write down the property first, then make the code enforce it
over every shape that can carry it.

**Assert the observation happened.** A scan that skipped every real line still reports "checked". Assert
the count of things actually examined, not the count of lines found.

**A measurement can be structurally blind.** When a measurement clears a change, ask what it was
incapable of observing.

**Watch for the loose assertion.** Four times in one PR, a test asserted an algebraic identity under a
name that claimed it measured something (`idle + busy === elapsed` where `busy = window − idle`). Every
figure needs a bound a fabrication cannot clear.

**Inoculation — every lane hits this.** `tests/tmp-scratch-attribution.test.mjs` requires a
**statically readable** prefix at the `mkdtempSync` call site:

```js
const root = mkdtempSync(join(tmpdir(), "blaze-<yourprefix>-"));   // literal, NOT a variable
```

A variable prefix passes locally and reddens on merge. Satisfy the guard; never except the suite.

---

## 8. Process

Standing rules: the `blaze` skill for every tracked item (ticket at create **with parent and
estimate**; branch `KEY-n-slug`; commits and PR title `KEY-n: description`; `blaze log` a bare number
before any terminal move). One commit per body of work; the message names everything in the diff.
Docs update in the same effort. `KEY-a + N more:` is a squash manifest; a range claims nothing.

**Board ops go through a dispatched `blaze-board-operator` with a brief that is COMPLETE at dispatch.**
A previous operator correctly refused mid-task additions as suspected prompt injection. Never send a
board agent a follow-up that adds scope — dispatch a fresh pass instead.

**Model routing — set `model` on every dispatch, never inherit.** Aligned to
`/home/rnamwoh/Documents/Code/claude-config/docs/model-selection.md`.

| Job | Agent | Model |
|---|---|---|
| Read-only recon, "where does X live" fan-out | `Explore` | `haiku` (`sonnet` if it must reason across many files) |
| Board operations — ticket lifecycle, reconcile, `blaze commit` | `blaze-board-operator` | `sonnet` |
| Mechanical, already-designed implementation (the design carries the steps) | `general-purpose` | `sonnet` |
| Complex or subtle implementation — Lane C's B2/C1, Lane R's read seam | `general-purpose` | `opus` |
| Adversarial review of a PR — **every PR, every round** | `adversarial-verifier` | `opus` |
| Hardest single verdict, architecture decision | `adversarial-verifier` / `architect` | `fable`, carry `opus` as fallback — fable can be rate-limited |

Observed cost, so you can budget: an opus review round runs 120k–170k subagent tokens and 5–20 minutes;
an opus implementation round 200k–330k. A lane averaged **2–4 review rounds**; the seam guard took 11.

---

## 9. Context — what merged, and the one deliberate compromise

`main` at `8d94fff`. Seven PRs merged in this body of work:

| PR | Tickets | Merged as | Rounds |
|---|---|---|---|
| #168 | BLZ-590 | `a1f5fbd` | prior session |
| #172 | BLZ-531 | `13f661c` | 1 |
| #175 | BLZ-608, 597, 558, 602 | `67114bb` | 2 |
| #170 | BLZ-534, 601, 603 | `54a136d` | 4 |
| #174 | BLZ-571, 570, 578, 613 | `af19a91` | 3 |
| #173 | BLZ-587 design + ADR-0037 | `27ba2d0` | 9 |
| #169 | BLZ-535, 521, 537 | `8d94fff` | 11 — **merged with residuals** |

**#169 is the compromise you inherit.** The write-seam guard shipped as a **ratchet, not a proof**:
eleven adversarial rounds, every one of which planted a module that wrote to disk while the guard
reported all-pass. Round 11 closed a great deal; round 12 planted eleven more shapes that still wrote
green. The decision was to merge with the three classes **stated open in the file's own banner** rather
than start round 13. **BLZ-642** (bug, 240) is the successor and carries ten measured escape shapes as
acceptance criteria. The predecessor it replaced sat at 3 pass / 0 fail with a live `appendFileSync` in
a non-allowlisted module, so this is a large net gain — it is simply not a proof, and the banner says so.

Open, unstarted, filed during this work: BLZ-609–612, 614–616, 617–619 (PR-review residuals), BLZ-620–623
(#170 residuals), **BLZ-624** (sign-in limiter has no per-source ceiling — security, high, 90),
BLZ-625–641 (the whole Phase 3 build set), BLZ-642. BLZ-532 and BLZ-587 remain open deliberately.

One item waiting on the operator, not you: **OBA-154** is SUPERSEDED in its own body and reconcile
wants to move it to plain `done` — it needs a deliberate `blaze resolve`.

---

## 10. Verification before every merge

From the lane's worktree, all three, Postgres confirmed up first:

```
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55481/postgres   # YOUR port — see §4
docker exec blzpg-55481 pg_isready -U postgres
npm test 2>&1 | tail -9
node scripts/ci/hygiene-check.mjs origin/main
npm run test:coverage
```

**`npm test`, never a bare `node --test`.** `package.json` defines `test` as `node --test
--test-timeout=120000 --import=./tests/setup/hang-watchdog.mjs` behind a `pretest` engine check. A bare
`node --test` silently drops the 120 s timeout and the hang watchdog — the protections BLZ-534 added in
`54a136d` — so a hung file runs until something else kills it.

Export `BLAZE_TEST_PG_URL` in the **same shell call** as the run — an unset variable does not fail the
suite, it silently removes the Postgres tests.

**Four red-suite signatures — do not confuse them:**

| Signature | Cause |
|---|---|
| total **unchanged**, failures present | `BLAZE_TEST_PG_URL` set but Postgres unreachable |
| total **lower**, load errors | missing `node_modules` — `npm ci` |
| total **lower**, no errors and no failures | `BLAZE_TEST_PG_URL` **unset** — Postgres tests silently gone |
| total **higher**, with failures | a real regression |

Baseline to beat: **4557 tests / 4555 pass / 0 fail / 393 suites / 2 skipped** on `8d94fff`, measured
with `npm test` after `npm ci`, **without** `BLAZE_TEST_PG_URL`. Re-measure with Postgres up before you
trust any delta — that number is higher, and it is the third signature above rather than a bug.

**When merging, assert on the check RESULT, not the absence of `pending`**, and assert the checks ran on
the **head SHA you are merging**: `gh pr checks <n>` then `gh pr view <n> --json headRefOid,state,mergedAt`.
Never treat a silent `gh pr merge` as confirmed. **Never `--admin` over a failing check.** After each
merge, bring every other open PR up to date (`gh pr update-branch <n>`) — expect that to catch
something; it is meant to.

After each merge: remove the lane and review worktrees (`git worktree remove --force <path>`), delete
the branch, dispatch a board pass for the moves and the review residuals, and update the status doc.
