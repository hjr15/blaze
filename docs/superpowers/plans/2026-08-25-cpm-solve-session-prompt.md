# Session prompt — the CPM solve (BLZ-379)

**Role of this file.** It is the copy-paste message-1 for a fresh session. Everything below the
rule is the prompt itself. The durable state document is
`docs/superpowers/plans/2026-08-25-blaze-next-session-kickoff.md`; **that file is authoritative for
repo state, open tickets, process and out-of-scope** — this one only bootstraps a session into it
and names the lane. If the two ever disagree, the kickoff doc wins and this file is stale.

---

Read `/home/rnamwoh/Documents/Code/blaze/docs/superpowers/plans/2026-08-25-blaze-next-session-kickoff.md`
first, in full. It is self-contained and tells you what to do, what is blocked, and what is out of
scope. It is authoritative over anything in this message that contradicts it.

## 0. Continuity

A usage, context or API limit is a **pause, not completion.** Do not stop, do not mark anything
Done, do not hand back early. Commit after every sub-step, keep a running checklist in the ticket
you are on, and resume from branch + checklist. The last two sessions each hit `529 Overloaded`
runs and a session-limit reset mid-review; both were worked around by committing and continuing.

## 1. Goal

Implement **BLZ-379 — the CPM solve and its findings**: a deterministic critical-path solve over
the board's `Precedes` graph, plus the single `scheduleFindings()` function that `blaze audit` and
the view layer both read. **Done means** one merged PR in which all eight of BLZ-360 §11's named
mutations break at least one test, any that survives is named in the PR body as a hole in the
suite, the full suite is green against both engines, and BLZ-379/380/381/382 are all in `done/`.

## 2. Setup — exact commands

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH   # Node 20 lacks node:sqlite — mandatory
cd /home/rnamwoh/Documents/Code/blaze
git fetch origin && git status --short && git log origin/main --oneline -3
```

Work in a worktree, because a reviewer will read the branch while you keep working and switching
branches in the shared checkout changes the file under a running agent:

```bash
git worktree add -b feature/BLZ-379 /home/rnamwoh/Documents/Code/blaze-worktrees/blz379 origin/main
ln -sfn /home/rnamwoh/Documents/Code/blaze/node_modules /home/rnamwoh/Documents/Code/blaze-worktrees/blz379/node_modules
cd /home/rnamwoh/Documents/Code/blaze-worktrees/blz379
```

Worktrees do **not** inherit `node_modules`; skip that symlink and ~108 tests fail on a missing
`pg`.

## 3. Verify before building — this prompt asserts state that may be stale

```bash
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55443:5432 --name v4chk postgres:17-alpine
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55443/postgres npm run test:coverage
docker rm -f v4chk
```

Postgres needs ~12 seconds to accept connections and **the Claude Code harness refuses a
foreground `sleep`** — run the `docker run` and the test command as two separate tool calls rather
than pasting the block as one script.

Expected on `3c586d9`: **1,991 pass / 0 fail**, coverage **97.92 / 85.90 / 96.67 / 97.92** against
gates 91 / 77 / 93 / 91. A ±0.01 branch drift is expected and documented; a third distinct value is
worth chasing. **If the baseline does not reproduce, stop and say so** rather than building on it.

Board, read-only:

```bash
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine
git status -sb && node /home/rnamwoh/Documents/Code/blaze/scripts/cli.mjs audit | tail -3
```

Expect `BLZ-305-v4-spine`, **88 or more commits unpushed — correct, do not push**, and `ok=true`.

## 4. What to build, and in what order

Read the four tickets first — they carry the design inline, so you do not need to re-read three
specs to start:

- `projects/BLZ/defined/BLZ-379-the-cpm-solve-and-its-findings.md` (the feature)
- `projects/BLZ/defined/BLZ-380-settle-the-backward-pass-s-horizon-before-coding-it.md`
- `projects/BLZ/defined/BLZ-381-the-cpm-forward-and-backward-passes-float-and-the-critical-path.md`
- `projects/BLZ/defined/BLZ-382-schedulefindings-one-function-so-audit-and-the-views-cannot-drift.md`

The source specs, when a ticket points into them:
`docs/superpowers/specs/2026-08-23-scheduling-kernel-design.md` (BLZ-360 — §6.1–§6.2 the solve, §7
findings, §11 the mutation list) and
`docs/superpowers/specs/2026-08-24-gantt-and-critical-path-design.md` (spec 3 — §13 item 1, the horizon
proposal, §8 finding presentation). `docs/decisions/0022-constraints-are-inputs-dates-are-derived.md`
is the governing ADR.

**Sequence, and it is not optional:**

1. **BLZ-380 first.** Spec 3 §13 item 1 *proposes* the backward pass seeds at `max(EF)` over the
   completed forward pass, arguing the self-reference is apparent rather than real. **That is a
   proposal into an open question, not a decision.** Settle it, record the answer and the rejected
   alternatives, then code against it. The backward pass cannot be tested against an unstated seed.
2. **BLZ-381** — the passes, float, `is_critical`.
3. **BLZ-382** — `scheduleFindings()`.

**The graph-construction filter order is part of the rule, not an implementation detail:** keep a
`Precedes` edge only if both endpoints are declared delivery kinds; then drop every ticket for
which `isTerminal(type, status)` holds — a terminal ticket is never a node, never an SCC member,
and is **never** marked `unscheduled`, because its dates are frozen actuals; then run Tarjan over
what remains.

**Determinism is a hard requirement.** BLZ-360 §5 states it as inherited verbatim from
`gantt.mjs`'s header — read `scripts/model/gantt.mjs`, not `scripts/views/gantt.mjs`. Its header
does carry the first three: no `Date.now()`, no `Math.random()`, an injected `now`, and a
locale-independent `cmp` (never `localeCompare`). **"Ties broken by ticket id" is the spec's own
addition and is not in that header** — the header says "byte-stable". Implement all four; just
don't cite the header for the fourth.

## 5. Files in scope

- `scripts/model/` — the new solve module and its findings function
- `scripts/model/db-schema-version.mjs`, `link-schema.mjs`, `sqlite-schema.mjs`, `pg-schema.mjs` —
  read them; the columns you are filling (`float_minutes`, `is_critical`, `schedule_run_id`,
  `constraint_start_no_earlier_than`, `deadline`) and `link.lag_minutes` already exist from PR #110
- `scripts/model/audit.mjs` — where `auditCorpus`, `summarise` and `HARD_KINDS` live, and where
  `scheduleFindings()` belongs. **Not `scripts/audit-runner.mjs`** (the CLI entry reached from
  `scripts/cli.mjs:36`): `.c8rc.json` excludes `scripts/*-runner.mjs`, so logic put behind the
  runner silently escapes the 91/77/93/91 gate
- `tests/model/` — the new suites
- `docs/decisions/0022-*.md` or a short cited note — where BLZ-380's answer lands

## 6. Out of scope

**There are no parallel sessions and no sibling lanes to fence.** The negative space is:

- **Do not push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole
  merger; work there ends at a local commit. `blaze reconcile` is disabled — move tickets by hand.
- **Do not touch the NCA project.** Parked by the operator on 2026-08-23.
- **Do not run the BLZ-324 soak** on the operator's behalf — it is elapsed time, not agent work.
- **Do not build the Gantt view.** Spec 3 specifies what a view does with the solve's output;
  BLZ-379 is the solve only.
- **Do not do BLZ-376, BLZ-377, BLZ-378 or BLZ-369 in this PR.** They are open, small and
  independent; bundling them into the solve's PR breaks the review boundary.
- **Do not reopen** ADR-0001, ADR-0014's ruling, ADR-0021, ADR-0022, or either kernel decision.

## 7. Acceptance

- All eight of BLZ-360 §11's mutations break at least one test: flip `EF > deadline` to `>=`; drop
  the `+ lag` term; swap the backward pass's `min` for `max`; return float as `ES − LS`; remove the
  terminal-ticket exemption; return SCC members as scheduled; treat a missing estimate as one day;
  drop the `project_epoch` floor. **Any mutation that survives is named in the PR body as a hole in
  the suite, not quietly fixed.**
- Three fixtures come from the real corpus rather than invention: the `INF-275 ↔ INF-276` mutual
  pair, the **22 cross-project `Blocks` edges** (BLZ-360 §1.1 and §6.2 — the population is
  `Blocks`; spec 3 §13's "1 of 36" counts a different, `Precedes`-eligible population, so do not
  reconcile the two), and `OMA-4` (a `defined` task carrying `due: 2026-10-20` with no start).
- A cycle marks every SCC member `unscheduled` with reason `dependency-cycle` while the rest of the
  graph still schedules. **Measured: zero such SCCs exist on the live board**, so this path is
  defensive and must be tested against a synthetic cycle.
- A missing estimate is `duration = 0` — a **milestone**, not an error. A cross-project dependency
  is **allowed and scheduled**; the unit of solve is the board.
- `scheduleFindings()` is consumed by both `blaze audit` and the view layer, so they cannot drift.
  All three kinds ship **soft**: HARD means the corpus is wrong, and a missed deadline is a true
  statement about a correct corpus. Each finding carries the zero-float predecessor **chain**, not
  just the lateness — §7.2's rule is that a finding saying only "deadline missed" is a defect.
- **11 of 12 migrated deadlines are already in the past**, so `deadline-unreachable` fires 11 times
  on day one. Group findings by kind with a count, and say when a kind's every member is a
  migration artefact.

## 8. Process

- Branch `feature/BLZ-379`; child work commits `BLZ-380: …` / `BLZ-381: …` / `BLZ-382: …` onto it;
  **one PR** titled `BLZ-379: the CPM solve and its findings`. One ticket per commit subject —
  `idFromSubject` anchors on `^KEY-n:`.
- **`hygiene.yml` rejects `Co-Authored-By` trailers** and runs only on `pull_request`. Omit the
  trailer, open a PR rather than pushing to `main`, and check first with
  `node scripts/ci/hygiene-check.mjs origin/main`.
- **Write commit bodies to a file and use `git commit -F`.** A body containing backticks was
  shell-expanded in a previous session and actually invoked `sprint-runner.mjs`.
- `blaze commit` takes **no message flag** — stage explicit pathspecs and `git commit -m` directly.
  Run `blaze` commands **from the board directory**.
- `blaze log` before any terminal move (BLZ has `requireWorklogBeforeTerminal`). Delivery workflow
  is `defined → in-progress → in-review → done` and you cannot jump. Reconcile is disabled, so
  **children never auto-move** — close BLZ-380/381/382 by hand before or right after the merge.
- **`gh pr merge --delete-branch` fails** when another worktree holds `main`; delete the branch
  separately.
- **Set `model` explicitly on every subagent dispatch; never inherit:**

  | Job | Model |
  |---|---|
  | Read-only recon / codebase fan-out | `haiku` (`sonnet` if it must reason across many files) |
  | Mechanical, already-designed implementation | `sonnet` |
  | Complex or subtle implementation | `opus` |
  | Judgement-heavy review, adversarial verify | `opus` |
  | Design / brainstorm / architecture decision | `fable`, with `opus` as fallback |

## 9. Context — what landed recently and why it matters here

- **PR #110 (`6d31e54`, BLZ-370)** — the kernel foundation. DB schema version 2, both
  `DB_SCHEMA_VERSION` and `MIN_DB_SCHEMA_VERSION` at 2; `applyCreate` installs `linkDdl` and
  `hierarchyDdl`; `Precedes`/`Follows` with `lag_minutes INTEGER NOT NULL DEFAULT 0` and no CHECK
  on the sign (a negative lag is a lead); the five scheduling columns; `schedule.minutes_per_day`
  (480) and `schedule.working_days` (`[1,2,3,4,5]`, `getUTCDay()` numbering) with a grep test
  enforcing that nothing outside `config.mjs` hardcodes either. **`viewDdl` exists but is
  deliberately NOT installed** — see BLZ-377.
- **PR #111 (`3c586d9`)** — the kickoff doc this prompt points at.
- **`grep -ric "project_epoch" scripts/` returns 0.** Nothing computes a schedule yet; you are
  writing the first thing that does.

## 10. Verification before merge

```bash
cd /home/rnamwoh/Documents/Code/blaze-worktrees/blz379
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
node scripts/ci/hygiene-check.mjs origin/main
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55443:5432 --name blz379pg postgres:17-alpine
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55443/postgres npm run test:coverage
docker rm -f blz379pg
```

**One thing CI does not check.** `test.yml` runs only `npm run test:coverage`, which is
`--test-concurrency=1`. **`npm test` runs files concurrently against one Postgres**, so a suite that
drops a schema another suite owns hangs there while CI stays green — that happened twice in
BLZ-370 and cost two review rounds. A new Postgres test needs its own uniquely-named schema, or its
own database when the DDL hardcodes a namespace. Never truncate shared ground. So also run:

```bash
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55443/postgres npm test
```

## The review bar — the instruction that earned its keep

**Every agent PR gets an adversarial review before merge, and the reviewer must try to make the
check FAIL, not confirm it passes.** On 2026-08-23 eight agent PRs were CI-green and six were
refuted by review; CI caught none of them. The session after ran 22 rounds and produced ~137
findings — and **not one was a wrong corpus measurement.** Every single one was reasoning, sourcing
or counting. The dominant defect, eight times: **a correction landing in one place and stopping
short of another that still contradicts it.**

So: grep, don't reason, about blast radius. Measure, don't transcribe — when a review corrects a
number, **re-run the measurement yourself**; reviewers were right about the reasoning every time
and still occasionally wrong about a figure. After any correction, grep the *unchanged* body for
the claim's negation. And keep **"if a mutation does not break a test, say so plainly"** in every
implementation dispatch.
