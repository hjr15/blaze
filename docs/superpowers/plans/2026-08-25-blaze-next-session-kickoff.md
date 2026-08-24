# Blaze — next session kickoff (written 2026-08-24)

**If you are a session reading this, your task is §3.** The operator chose the lane on 2026-08-24.
Supersedes `2026-08-24-blaze-next-session-kickoff.md`, whose sequence (specs 3 → 2 → 4) is
**complete and merged** — and which is **deleted from `main` by the same commit that added this
file**, because it had become actively misleading rather than merely stale.

**Worth knowing, because it cost this session a wrong claim.** That filename carried **two
different documents.** On `main` it held the *2026-08-23* plan — BLZ-349's capability probe and five
defect tickets, all seven of which are now `done` — under a `2026-08-24` name. The 2026-08-24
content, the version that actually set the spec 3 → 2 → 4 sequence, was only ever committed to the
local branch `docs-kickoff-2026-08-24` and never merged. So a session that checked out `main` and
opened the obvious file got a plan a week out of date whose filename said otherwise. An earlier
draft of *this* paragraph asserted the file lived "only on the unmerged branch", which was wrong in
the same way. `git show docs-kickoff-2026-08-24:docs/superpowers/plans/2026-08-24-blaze-next-session-kickoff.md`
retains the version this session worked from; nothing durable in either is lost, because §5–§7
below carry it.

---

## 0. Continuity contract

A usage, context or API limit is a **pause, not completion**. Do not stop, do not mark anything
Done, do not hand back early. Commit after every sub-step, keep a checklist in the ticket you are
on, and resume from branch + checklist. This session hit three consecutive `529 Overloaded`
failures dispatching a reviewer and a session-limit reset mid-review; both were worked around by
committing and continuing, not by stopping.

---

## 1. First five minutes — verify, don't trust

**This document asserts repo state. Re-verify before building.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH   # Node 20 lacks node:sqlite — mandatory
cd /home/rnamwoh/Documents/Code/blaze
git fetch origin && git status --short && git log origin/main --oneline -5
```

Expect `main` clean at or after `01cae45 BLZ-366: write ADR-0021 and ADR-0022 … (#107)`.

```bash
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55443:5432 --name v4chk postgres:17-alpine
sleep 10
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55443/postgres npm run test:coverage
docker rm -f v4chk
```

Last verified on `8b9f93b`: **1,942 pass / 0 fail**, coverage **97.89 / 85.82 / 96.63 / 97.89**
against gates of 91 / 77 / 93 / 91.

**One honest note on that baseline.** The session before this one measured branches at **85.83**
(3968/4623) and this one measured **85.82** (3966/4621) — numerator and denominator both down 2 —
with **nothing under `scripts/` or `tests/` changed** and the figure stable across two consecutive
runs. Treat 85.82 as the number and a ±0.01 branch drift as expected; it is 8.8 points clear of
the gate. If you see a *third* value, that is worth chasing.

Board:

```bash
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine
git status -sb && node /home/rnamwoh/Documents/Code/blaze/scripts/cli.mjs audit | tail -5
```

Expect clean, on `BLZ-305-v4-spine`, **77 commits unpushed — that is correct, do not push**, and
`ok=true` with the four soft categories (`empty-labels` 806, `empty-components` 685,
`missing-parent` 25, `terminal-goal-unverified-requirement` 1).

---

## 2. What landed, so you do not redo it

| Merged | Commit | Ticket |
|---|---|---|
| Spec 3 — Gantt and critical path | `9beb7e8` (#104) | BLZ-363 done |
| Spec 2 — agile execution | `8b9f93b` (#105) | BLZ-364 done |
| Spec 4 — hierarchy reporting + Excel | `7e3002b` (#106) | BLZ-365 done |
| ADR-0021, ADR-0022, two kernel-spec corrections | `01cae45` (#107) | BLZ-366/367/368 done |

**All six v4 subsystem specs bar two now exist.** The spine, agent-driven execution, the two
kernels, and specs 2/3/4. Missing: **spec 5 (diagrams)** and **spec 6 (configuration UI)**.

`docs/decisions/` now runs to **ADR-0022**. Every ADR the merged specs cite exists.

---

## 3. The lane — operator's choice, 2026-08-24

### Implement the kernel. Nothing else is unblocked.

**This is not a preference, it is measured.** Spec 2 §6 records:

```
grep -ric "schedule" scripts/   →  0
```

`schedule.minutes_per_day`, `schedule.working_days`, `project_epoch` and derived ES/EF **do not
exist**. Neither does the view-config registry — `columnSet`, `swimlaneBy`, `cardFields` return 0
hits under `scripts/`. So of everything the three merged specs describe, **exactly one thing is
buildable today**: spec 2 §4's `sprint-overrun` finding, which needs no scheduler and no view
config and has **26 live corpus rows** waiting (S2: 2, S3: 13, S5: 11).

Build order, forced by that:

1. **DB schema version 1 → 2** — ADR-0022 and BLZ-360 §6.4. Installs `linkDdl`, `hierarchyDdl`,
   `viewDdl` and the five `ticket` columns. `createDbSchema` currently installs **no v4 table at
   all**, which is the circularity that put the schema event in the scheduling kernel rather than
   spec 4.
2. **`Precedes` / `Follows`** in the v4 `link` table's `DEFAULT_LINK_TYPES`, plus
   `lag_minutes INTEGER NOT NULL DEFAULT 0` on `link`. ADR-0022 §"Why `Precedes`".
3. **`schedule.*` board config** — `minutes_per_day` (480) and `working_days` (Mon–Fri). One
   number, one definition; spec 2 §3.2's capacity bar is its second consumer.
4. **The CPM solve** — forward/backward pass, float, critical path, over the non-terminal delivery
   graph. BLZ-360 §6.1–§6.2. Determinism is a hard requirement: no `Date.now()`, no
   `Math.random()`, `now` injected, locale-independent `cmp`, ties broken by id.
5. **`scheduleFindings()`** — one function, so `blaze audit` and the views cannot drift.

**TDD, and the mutation list is already written for you.** BLZ-360 §11 names eight mutations that
must each break a test; spec 3 §9 names nine more for the view. **If a mutation does not break a
test, say so plainly in the PR body** — do not quietly add a test that happens to catch it.

**Two things the specs tell you the kernel needs that its own spec understated:**
- `hierarchy-rollup.mjs` needs a **`rollupAll` whole-tree entry point**, not only `combine`
  (BLZ-368; measured 842 ms against 5.2 ms for the naive swap).
- Spec 3 §13.1 proposes the backward pass's horizon is `max(EF)` over the completed forward pass,
  and that its apparent self-reference is not real. That is a **proposal into an open question**,
  not a decision — settle it before you code the backward pass.

---

## 4. Open tickets

| Ticket | State | Notes |
|---|---|---|
| **BLZ-369** | `defined` | **Operator decision 2026-08-24: accept now, remove later.** An old engine's `loadSprints → setActive → saveSprints` destroys `activeByProject`, because `loadSprints` whitelists two keys (`sprints.mjs:14`). It is operator-entered state nothing can reconstruct. Candidates: a `MIN_SCHEMA_VERSION` bump, or a version stamp in `sprints.json` plus a warning. Neither designed. |
| **BLZ-362** | `defined` | ADR-0014's three factual errors. Small, independent, no prerequisites. ADR-0021 already records what is wrong. |
| **BLZ-358** | `defined` | First-run setup. **Operator decided the mechanism:** a one-time token at `<board>/.blaze/setup-token`, mode `0600`, path logged but never the value. |
| **BLZ-355** | `defined` | Grill the Q6 interface half. **Needs the operator interactively** — do not queue it for an agent session. |
| **BLZ-324** | `defined` | **BLOCKED** — needs a week of dual-write soak. Elapsed time, not agent work. |
| **BLZ-309** | `in-progress` | The one open child of BLZ-305 besides the above. |

---

## 5. Out of scope

- **Do not push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole
  merger. Work there ends at a local commit. 77 commits waiting is correct.
- **Do not touch the NCA project.** Parked by the operator on 2026-08-23. NCA-40 is a real false
  green and it will keep.
- **Do not run the BLZ-324 soak** on the operator's behalf.
- **Do not reopen** ADR-0001, ADR-0014's ruling, ADR-0021, ADR-0022, or the two kernel decisions.
  BLZ-367 and BLZ-368 amended *facts* in the kernel specs with the operator's explicit
  agreement — that is the bar for touching them again.
- **`name-clearance-audit#7`** — blocked, needs operator review.
- There are **no parallel sessions** and no sibling lanes to fence.

---

## 6. Process

- **`hygiene.yml` rejects `Co-Authored-By` trailers** and runs only on `pull_request`. Omit the
  trailer; open a PR rather than merging to `main` directly. Check first:
  `node scripts/ci/hygiene-check.mjs origin/main`
- **One ticket per commit subject** — `idFromSubject` anchors on `^KEY-n:`.
- Branch `KEY-n-slug`; commit `KEY-n: description`; PR title `KEY-n: description`; `blaze log`
  before any terminal move (BLZ has `requireWorklogBeforeTerminal`).
- Workflows differ by type: delivery is `defined → in-progress → in-review → done`; a **goal** is
  `defined → in-progress → achieved`; a **requirement** is `proposed → implemented → verified`.
  You cannot jump.
- `blaze reconcile` is **disabled** on this board. Move tickets by hand.
- `blaze commit` takes **no message flag**. To honour a `KEY-n:` subject, stage explicit pathspecs
  and `git commit -m` directly — precedent at `40e704e2`, `6ef43e7b`, `b6bc313b`.
- Run `blaze` commands **from the board directory**, not the engine repo.
- **Worktrees do not inherit `node_modules`.** Symlink it or ~108 tests fail on a missing `pg`:
  `ln -sfn /home/rnamwoh/Documents/Code/blaze/node_modules <worktree>/node_modules`
- **Write commit bodies to a file and use `git commit -F`.** A body containing backticks was
  shell-expanded this session and actually invoked `sprint-runner.mjs`. Nothing was damaged; the
  message was mangled and had to be amended.
- **Use a worktree when a reviewer is reading a branch.** Switching branches in the shared checkout
  changes the file under a running agent.

**Model routing when dispatching subagents — set `model` explicitly, never inherit:**

| Job | Model |
|---|---|
| Read-only recon / codebase fan-out | `haiku` (`sonnet` if it must reason across many files) |
| Mechanical, already-designed implementation | `sonnet` |
| Complex or subtle implementation | `opus` |
| Judgement-heavy review, adversarial verify | `opus` |
| Design / brainstorm / architecture decision | `fable`, with `opus` as fallback |

---

## 7. The instruction that earned its keep, with this session's evidence

**Every agent PR gets an adversarial review before merge, and the reviewer must try to make the
check FAIL — not confirm it passes.**

The previous session's evidence was eight CI-green PRs of which six were refuted. This session ran
**seventeen adversarial rounds across four PRs and they produced roughly 115 findings.** The
pattern is worth internalising because it is not the one you would guess:

- **Every corpus measurement reproduced exactly, in every round, every time.** Not one finding was
  a wrong number from the board. The measurement discipline held completely.
- **Every finding was reasoning, sourcing or counting.** Misattributed sections, quotations trimmed
  of their reason, classifications claimed exhaustive with holes in them, counts produced by
  reasoning instead of grepping.
- **The dominant defect, six times in one spec alone: a correction landing in one section and
  stopping short of another that now contradicts it.** At one point the document's *title* still
  asserted the decision §3 had reversed. Twice, both contradicting rows were added *in the same
  commit*.
- **My own fix passes were about as defect-prone as my first drafts.** Rounds 2–5 on spec 3 each
  found defects created by the previous fix. One "correction" inverted an ADR's actual rule and
  instructed a future reader to edit a merged spec at source.

**Three practices that came out of it, all cheap:**
1. **Grep, don't reason, about blast radius.** Spec 3's test floor was wrong twice by inference; spec
   2's was wrong three times. A rename breaks tests that never mention the thing renamed.
2. **Measure, don't transcribe.** Spec 4's line count was wrong four times, the last because a
   prescribed figure was copied while the same commit changed the file.
3. **After any correction, grep the *unchanged* body for the claim's negation.** Three of four
   defects in one round sat in text the same commit added or left adjacent to what it added.

**And keep in every implementation dispatch:** *if a mutation does not break a test, say so
plainly.* When a review corrects a number, **re-run the measurement yourself** — this session's
reviewers were right about the reasoning every time and were still occasionally wrong about a
figure.

---

## 8. What this session did

Wrote, adversarially reviewed and merged the three consumer specs the sequence called for, then
closed the ADR hole they exposed. Seventeen review rounds; every finding re-measured before being
accepted. Six tickets closed (BLZ-363/364/365/366/367/368), four created, one deliberately left
open (BLZ-369).

Two decisions changed under review rather than merely being polished:
- **Spec 2's capacity decision reversed entirely.** The first draft compared board-wide throughput
  against one sprint's capacity, concluded capacity was wrong by 3.97×, and shipped velocity. On
  the right population every sprint sits at **0.23–0.96** of a one-person capacity — never once
  exceeded. Capacity ships; velocity is deferred because the transitions log records when the board
  was *written*, not when work happened (346 of 402 arrivals share 62 timestamps).
- **Spec 4's ADR-0011 collision dissolved.** A **98-line** zero-dependency `.xlsx` writer, committed
  and runnable at `docs/superpowers/specs/evidence/`, **2.14× faster** than the `exceljs` figure
  ADR-0016 recorded. Three of its bugs were found by review *after* it was committed as proof —
  including a `Date` that rendered the previous day in the exact timezone every measurement was
  taken in.

The most useful single finding for whoever picks this up: **only `sprint-overrun` is buildable
before the kernel lands.** Everything else in three merged specs is gated on `schedule.*` or the
view-config registry, and both return zero grep hits today.
