# Blaze — next session kickoff (written 2026-08-29)

**If you are a session reading this, your task is §3 — review, merge and close out three
open PRs, in the stated order.** You need no further instruction to begin. Supersedes
`2026-08-28-blaze-next-session-kickoff.md`, whose lane (BLZ-130+131, BLZ-358, BLZ-56) is
**built and green but NOT merged** — merging it is your job.

---

## 0. Continuity contract

A usage, context or API limit is a **pause, not completion.** Do not stop, do not mark
anything Done, do not hand back early. Commit after every sub-step, keep a running
checklist in the ticket you are on, and resume from branch + checklist.

**Do not narrow the lane on your own.** If you run out of room, leave the next item
untouched and say which one it is.

---

## 1. First ten minutes — verify, do not trust

**This document asserts repo and PR state. Re-verify before acting.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH   # Node 20 lacks node:sqlite — mandatory
cd /home/rnamwoh/Documents/Code/blaze
git fetch origin && git status --short && git log --oneline -1 HEAD && git log origin/main --oneline -2
for n in 123 124 125; do printf "#%s: " "$n"; gh pr checks $n | awk '{printf "%s=%s ", $1,$2}'; echo; done
for n in 123 124 125; do printf "#%s: " "$n"; gh pr view $n --json mergeable,mergeStateStatus -q '.mergeable+" "+.mergeStateStatus'; done
```

Expected on 2026-08-29: `origin/main` at `7a5ddb0`, and **all three PRs `pass` on all four
checks and `MERGEABLE CLEAN`**. If a PR is not clean, `git fetch && git rebase origin/main`
in its worktree — do not force past a red gate.

Baseline suite (worktrees already exist and have `node_modules` symlinked):

```bash
docker rm -f blzpg 2>/dev/null
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55455:5432 --name blzpg postgres:17-alpine
for i in $(seq 1 60); do docker exec blzpg psql -U postgres -c 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
```

**Three Postgres traps, each of which cost real time:**

- **Wait on a real query, never `pg_isready`.** It returns while the server still answers
  *"the database system is starting up"*.
- **A stale container is the most likely false failure you will hit.** One cost a full
  cycle last session: a warm container failed `tests/model/view-schema.test.mjs`
  ("both foreign keys enforce") and a fresh one passed 16/16. Recreate before believing a
  Postgres failure.
- **`rm -rf coverage` before every coverage run.**
- **Do not reuse one container across two worktrees on the same port.** Killing `blzchk`
  and starting `blzpg` on 55455 without removing the first spun a wait loop for 10 minutes.

Board, read-only:

```bash
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine
git status -sb && node /home/rnamwoh/Documents/Code/blaze/scripts/cli.mjs audit | tail -2
```

Expect `BLZ-305-v4-spine`, **129 or more commits unpushed — correct, do not push**, and
`ok=true`.

---

## 2. What is open, and where it lives

| PR | Ticket(s) | Branch | Worktree | Commits |
|---|---|---|---|---|
| [#123](https://github.com/hjr15/blaze/pull/123) | BLZ-130 + BLZ-131 (bundled) | `BLZ-130-131-reconcile-delivery-truth` | `blaze-worktrees/reconcile-delivery-truth` | 10 |
| [#124](https://github.com/hjr15/blaze/pull/124) | BLZ-358 | `BLZ-358-first-run-setup` | `blaze-worktrees/first-run-setup` | 2 |
| [#125](https://github.com/hjr15/blaze/pull/125) | BLZ-56 | `BLZ-56-validate-schema-on-load` | `blaze-worktrees/validate-schema-on-load` | 2 |

All four board tickets are in **`in-review` with worklogs already logged** (120 + 150 +
240 + 180 = 690 min). They need `blaze move <id> done` after merge, nothing else.

**Every PR's most recent round of fixes is UNREVIEWED.** That is the whole reason this
lane is handed over rather than merged: across six adversarial review rounds on these
three PRs, **six returned REFUTED and every one found a real defect**. Merging the last
round on green CI alone is not justified by that record.

---

## 3. The lane — review, merge, close out, in this order

### 3.1 One adversarial review per PR, on the LAST round only

Dispatch three `adversarial-verifier` agents (**`opus`, set explicitly — never inherit**),
one per PR, each scoped to the commits its previous review did not see:

| PR | Review only these commits | The previous round's verdict |
|---|---|---|
| #123 | `ac2734f` | REFUTED — the write-once rule was described but never shipped |
| #124 | `4a31486` | REFUTED — remote process kill + committable token |
| #125 | `b2e509e` | REFUTED — preflight bricked a board class audit calls clean |

**Tell each reviewer the repo's actual pattern, because it has held six times out of six:
the PREVIOUS round's fix is where the next defect comes from.** Point it at the new
commit, not the whole branch.

Setup line every reviewer needs, verbatim:

```
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55455/postgres
```

Without that env var the suite runs **70 fewer tests** and coverage reads ~1pp lower — a
reviewer measured 92.06 once and it did not reproduce, which cost a round to resolve.

**Two specific things to ask for, because both were missed until late:**

1. **Does every construct the commit message and PR body name actually EXIST in the tree?**
   `57f2313` on #123 shipped a comment ending "Hence also the write-once rule below" with
   no rule below — a commit-split reverted the hunk and the branch carried on from the
   reverted tree. Every gate was green. Nothing re-checked the claim against the code.
2. **Which tests are vacuous?** Revert each production hunk and name any test that does
   not go red. Three separate rounds shipped assertions loose enough to match a *different*
   check's message, and one truncation test passed with the bug still present because
   `spawnSync` does not reproduce piped truncation (it needs `sh -c '… | cat'`).

### 3.2 Merge, in this order

Merge **#123 first** (largest, most reviewed, and the other two are disjoint from it),
then **#124**, then **#125**. `strict: true` means each merge invalidates the others'
branch-up-to-date status; after each merge, update the next:

```bash
cd /home/rnamwoh/Documents/Code/blaze-worktrees/<next-worktree>
git fetch origin && git rebase origin/main && git push --force-with-lease
```

Files are disjoint — `reconcile.mjs` vs `serve.mjs` vs `cli.mjs`/`schema-config.mjs` —
so expect no textual conflicts. **Re-run the full gate after each rebase anyway**: `strict`
exists to catch the semantic conflict a clean textual merge hides.

Merge with `gh pr merge <n> --squash --delete-branch`. **`--delete-branch` fails when
another worktree holds the branch** — remove the worktree first
(`git worktree remove <path>`), or delete the branch separately.

> **The squash SUBJECT matters now, because of what this very lane shipped.** BLZ-131
> makes reconcile read a squash body's `* KEY-n:` bullets **only when the commit's own
> subject opens with a ticket-id list**. `BLZ-130 + BLZ-131: …` parses correctly (the
> multi-id form was added in `0e17c15` precisely because this PR's own title would
> otherwise have stranded BLZ-131). Keep each PR title in `KEY-n: description` or
> `KEY-a + KEY-b: description` form when you merge.

### 3.3 Close out

Reconcile is **disabled** on this board; move tickets by hand. Worklogs are already
logged, so each is a single move:

```bash
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine
BLZ="node /home/rnamwoh/Documents/Code/blaze/scripts/cli.mjs"
$BLZ move BLZ-130 done && $BLZ move BLZ-131 done && $BLZ move BLZ-358 done && $BLZ move BLZ-56 done
git add -A -- projects/BLZ/ && git commit -m "BLZ-130, BLZ-131, BLZ-358, BLZ-56: move to done — PRs #123, #124, #125 merged"
$BLZ audit | tail -2      # expect ok=true
```

**Do not push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole
merger. Work there ends at a local commit.

### 3.4 One deferred edit, after #123 merges and not before

`~/.claude/skills/feature-pr-bundling/SKILL.md` says *"Children are never auto-moved"*.
BLZ-131 makes that **false** for a bundled child whose `* KEY-n:` bullet survives in the
squash body of a `KEY-n:`-titled feature PR. Update that section, and add the repository
setting it now depends on: GitHub's *Default commit message for squash merges* must be
**"Default message"** or **"Pull request title and commit details"** — set to "Pull request
title", the bullets are never written and children need a manual move as before.

Deliberately deferred until merge: editing a skill for behaviour that has not landed is
how stale guidance gets written.

---

## 4. What remains after this lane

| Ticket | Type | Est. | Why it exists |
|---|---|---|---|
| **BLZ-395** | bug, medium | 120 | Terminal-stickiness keeps a wrongly-`done` ticket `done`, so BLZ-130's veto narrows the window without closing it. Recommends "report, don't move" over un-sticking. **Read ADR-0023 §1 first.** |
| **BLZ-394** | bug, medium | 90 | `reconcile --apply` has no `--project` filter, so a session commits ticket moves it does not own. ADR-0023 §3 already ruled OUT session-scoping — do not re-propose it. |

Both were spawned from BLZ-130's review rather than bundled into it, and both are
**actionable now**. BLZ-395 is the better next lane: it closes the residual this lane
knowingly left open.

Lower-priority bugs after those: BLZ-128, BLZ-248, BLZ-250 (medium); BLZ-23, BLZ-124 (low).

---

## 5. Blocked vs actionable — so a bare "continue" needs no questions back

| Item | State | Why |
|---|---|---|
| **#123, #124, #125** | **ACTIONABLE — start here**, in that order | Green, clean, last round unreviewed |
| **BLZ-395** | **ACTIONABLE** after the merges | Residual from this lane; ADR-0023 §1 has the options |
| **BLZ-394** | **ACTIONABLE** after the merges | Decision already recorded; only the `--project` filter is left |
| BLZ-355 | **BLOCKED — needs the operator interactively** | Do not queue it for an agent session |
| BLZ-324 | **BLOCKED** | Needs a week of dual-write soak. Elapsed time, not agent work |
| BLZ-309 | **BLOCKED** | Cannot start until BLZ-254's db-primary cutover lands |
| BLZ-253, BLZ-282, BLZ-305, BLZ-345 | containers | Parent goals; nothing to do directly |

---

## 6. Out of scope

- **There are no parallel sessions and no sibling lanes to fence.** If that changes, fence
  them here by ticket key before starting.
- **Do not push `blaze-pm`.** 129 unpushed is correct.
- **Do not run `blaze schedule migrate-dates --write` against the live board.** The real
  write is the operator's to run.
- **Do not touch the NCA project.** Parked by the operator on 2026-08-23.
- **Do not build the Gantt view.** Spec 3 specifies it; separate lane.
- **Do not reopen** ADR-0001, ADR-0014's *ruling*, ADR-0021, ADR-0022's decision, or
  **ADR-0023** (new — BLZ-130/BLZ-131's decisions, including the two the ACs asked for by
  name).
- **Do not implement `activeByProject`.** Unticketed, not this lane.
- **Do not re-litigate terminal-stickiness casually** — BLZ-395 owns that decision.
- **Do not chase line-number citations through `docs/superpowers/specs/` and `plans/`.**
  Many drifted when BLZ-386 landed. Cite by symbol.

---

## 7. Process

- One PR per ticket — the exception, BLZ-130 + BLZ-131 as one PR, is already merged-shaped.
- Branch `KEY-n-slug`; every commit `KEY-n: description`; PR title `KEY-n: description`.
- **`hygiene.yml` rejects `Co-Authored-By` trailers** and runs only on `pull_request`.
  Check with `node scripts/ci/hygiene-check.mjs origin/main`.
- **Write commit bodies to a file and use `git commit -F`.** A backtick inside a
  double-quoted shell string gets command-substituted. It bit again last session inside a
  **template literal** in `init-runner.mjs`'s USAGE string — backticks in help text break
  the parse. Same rule for `python3 -c`; use a heredoc.
- **Commit with an EXPLICIT pathspec, always.** A bare `git commit` swept a half-move: the
  `defined/` deletions were left behind because the pathspec named only `in-review/`.
- **Splitting one change into per-ticket commits is where a fix gets silently reverted.**
  If you rebuild an intermediate tree to split a commit, **re-verify the final tree against
  what you tested** (`diff` each file against a saved copy) before pushing. This is not
  hypothetical — it cost round 6 on #123.
- `blaze commit` takes **no message flag** — stage explicit pathspecs and `git commit -m`.
  Run `blaze` commands **from the board directory**.
- `blaze log` before any terminal move. Delivery is `defined → in-progress → in-review →
  done` and you cannot jump. **Reconcile is disabled** — move tickets by hand.
- **Move tickets with `blaze move`, re-parent with `blaze edit parent`**, never by editing
  frontmatter. **A ticket's status comes from its DIRECTORY.**
- **`gh pr merge --delete-branch` fails** when another worktree holds the branch.
- **Set `model` explicitly on every subagent dispatch; never inherit:**

  | Job | Model |
  |---|---|
  | Read-only recon / codebase fan-out | `haiku` (`sonnet` across many files) |
  | Mechanical, already-designed implementation | `sonnet` |
  | Complex or subtle implementation | `opus` |
  | Judgement-heavy review, adversarial verify | `opus` |
  | Design / brainstorm / architecture decision | `fable`, `opus` fallback |

---

## 8. Verification before merge

Run in each PR's worktree after any rebase:

```bash
cd /home/rnamwoh/Documents/Code/blaze-worktrees/<slug>
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
node scripts/ci/hygiene-check.mjs origin/main
docker rm -f blzpg 2>/dev/null
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55455:5432 --name blzpg postgres:17-alpine
for i in $(seq 1 60); do docker exec blzpg psql -U postgres -c 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
rm -rf coverage
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55455/postgres npm run test:coverage
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55455/postgres npm test
node scripts/ci/mutate-schedule.mjs        # must print "All mutations killed" and exit 0
```

Expected after all three merge: **~2,380 pass / 0 fail** (2,336 on `7a5ddb0`), coverage
comfortably above gates 91 / 77 / 93 / 91.

> **Coverage is nondeterministic — quote it loosely.** Functions came back 690/711,
> 691/713 and 692/714 across runs of the same trees. Do not "correct" a last-decimal
> difference and do not treat a 0.14pp move as a regression.

**`test.yml` runs only `npm run test:coverage` (`--test-concurrency=1`).** `npm test` runs
files concurrently and catches things coverage does not. Run both.

---

## 9. The review bar — updated with this lane's data

**Every agent PR gets an adversarial review before merge, and the reviewer must try to
make the check FAIL.** Across **six rounds on three PRs this lane, six returned REFUTED and
CI caught none of it.**

What the six rounds actually found, because the pattern is not the one you would guess:

1. **A fix can be described and not shipped.** Commit-splitting reverted a hunk; the
   message, the ADR and the guide all asserted a behaviour the code did not have.
2. **A "safety argument" can fail to reproduce.** One was withdrawn outright: re-measured
   under the shipped rule it added **zero** ids, having been measured under an earlier one.
3. **Figures drift by noun and by ref.** "104 commits" meant 104 *lines*; a table was
   quoted without saying which ref it came from; "945 of 1,479" came from a stale checkout
   on an unrelated branch. **Name the ref, and re-derive with the shipped function.**
4. **A fix in one direction over-corrects into the other.** The terminal delivery record
   was wrong three times: overwrite-anything, then write-nothing, then overwrite-with-the-
   latest-merge. Pin **both** directions.
5. **A new check can be worse than the bug.** BLZ-56's first preflight refused every
   non-exempt verb on a board `blaze audit` calls clean.
6. **A security fix can open a bigger hole.** BLZ-358's setup branch was the one place in
   the request handler without a `try`, and `{"token":{"toString":null}}` killed the
   process pre-auth.

Practices, all cheap:

1. **Grep, don't reason, about blast radius.**
2. **Measure, don't transcribe** — and re-measure after your own correction.
3. **After any correction, grep the *unchanged* body for the claim's negation.**
4. **Prove every regression test discriminates by reverting the fix and watching it go red.**
5. **Do not guard a runtime property by scanning source text.**
6. **A `doesNotMatch` on the output of a command that failed proves nothing.**
7. **Say plainly when a mutation is equivalent.** Claiming a test kills something it cannot
   is worse than not having the test.
8. **NEW — assert the wiring, not just the guard.** A gitignore test called its helper
   directly, so deleting the call from `startServer` killed nothing. Boot the real thing.
9. **NEW — a test harness can hide the bug.** `spawnSync` does not reproduce 64 KiB piped
   truncation; `sh -c '… | cat'` does. If a control passes with the fix reverted, the
   harness is wrong, not the finding.

And keep in every implementation dispatch: *if a mutation does not break a test, say so
plainly.*

---

## 10. The one lesson worth more than the rest

**A warm Postgres hides idempotency bugs, and CI is always cold.**

Every CI run provisions a fresh `postgres:17-alpine`. A warm local container hid a
`view-schema` failure last session that a cold one reproduces as passing — the inverse
direction, and just as misleading. If you touch schema creation, seeds, or anything
writing to `blaze_config`:

```bash
docker rm -f blzcold 2>/dev/null
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55456:5432 --name blzcold postgres:17-alpine
for i in $(seq 1 60); do docker exec blzcold psql -U postgres -c 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55456/postgres \
  node --test --test-concurrency=1 tests/model/config-schema.test.mjs tests/model/driver-conformance.test.mjs
```

That pairing (51 tests) is the cheapest reproduction of the whole class.
