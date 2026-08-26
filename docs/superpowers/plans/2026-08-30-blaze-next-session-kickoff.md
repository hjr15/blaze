# Blaze — next session kickoff (written 2026-08-26)

**If you are a session reading this, your task is §3 — Lane 1, then Lanes 2–4 in order.**
You need no further instruction to begin. Supersedes
`2026-08-29-blaze-next-session-kickoff.md`, whose lane (reviewing and merging #123, #124,
#125) is **complete**: all three merged, all four tickets `done`.

---

## 0. Continuity contract

A usage, context or API limit is a **pause, not completion.** Do not stop, do not mark
anything Done, do not hand back early. Commit after every sub-step, keep a running
checklist in the ticket you are on, and resume from branch + checklist. A session limit
killed four agents mid-flight last lane; the recovery was to re-verify every worktree was
clean and re-dispatch. **Check for a left-applied mutation before trusting any tree.**

**Do not narrow the lane on your own.** If you run out of room, leave the next lane
untouched and say which one it is.

---

## 1. First ten minutes — verify, do not trust

**This document asserts repo and board state. Re-verify before building.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH   # Node 20 lacks node:sqlite — mandatory
cd /home/rnamwoh/Documents/Code/blaze
git fetch origin && git status --short && git log origin/main --oneline -4
```

Expect `origin/main` at **`6ce5c3a`** or later, with these three above `7a5ddb0`:

```
6ce5c3a BLZ-56: validate the resolved schema on load, and fail loud on the load path only (#125)
6188a28 BLZ-358: serve first-run setup over HTTP instead of refusing to start (#124)
6307ae3 BLZ-130 + BLZ-131: reconcile stops saying shipped when it is not (#123)
```

Baseline suite — **one fresh container, and wait on a real query**:

```bash
docker rm -f blzpg 2>/dev/null
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55455:5432 --name blzpg postgres:17-alpine
for i in $(seq 1 60); do docker exec blzpg psql -U postgres -c 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
rm -rf coverage
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55455/postgres npm run test:coverage
```

Expected on `6ce5c3a`: **2,518 pass / 0 fail**, coverage **≈98.27 / ≈87.20 / ≈97.12 /
≈98.27** against gates 91 / 77 / 93 / 91. **If the tests do not reproduce, stop and say so.**

> **Coverage is nondeterministic — quote it loosely.** Functions moved 692–709/714–730
> across runs of identical trees last lane. Do not "correct" a last-decimal difference and
> do not call a 0.14pp move a regression.

**Postgres traps, each of which cost real time:**

- **Wait on a real query, never `pg_isready`** — it returns while the server still answers
  *"the database system is starting up"*.
- **A stale container is the most likely false failure you will hit.** Recreate before
  believing any Postgres failure.
- **`rm -rf coverage` before every coverage run.**
- **Never run a mutation sweep against the same database as your measurement run.** That
  corrupted one reviewer's figures last lane — a `npm test` stalled 17 minutes on an idle
  `INSERT INTO blaze_meta` because a sweep was hitting the same port.

Board, read-only:

```bash
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine
git status -sb && node /home/rnamwoh/Documents/Code/blaze/scripts/cli.mjs audit | tail -2
```

Expect `BLZ-305-v4-spine`, **132 or more commits unpushed — correct, do not push**, and
`ok=true`.

---

## 2. What landed, so you do not redo it

| Merged | Commit | Closed |
|---|---|---|
| Reconcile stops reporting an epic shipped when it is not | `6307ae3` (#123) | BLZ-130, BLZ-131 |
| First-run setup served over HTTP instead of refusing to start | `6188a28` (#124) | BLZ-358 |
| The resolved schema is validated on load, loud on the load path only | `6ce5c3a` (#125) | BLZ-56 |

**Facts that change what you can assume:**

- **Reconcile now reads a squash commit's BODY, not just its subject.** `idsFromCommitMessage`
  recovers `<KEY>-<n>` from a `* <KEY>-<n>: …` bullet **when the commit's own subject opens
  with a ticket-id list** (`KEY-n:`, `KEY-a/b/c:`, `KEY-a + KEY-b:`). Both conditions are
  load-bearing: the `* ` marker rejects `commit-runner.mjs`'s `- KEY-n: <board op>` ledger
  lines (without it, **426** bogus ids on `blaze-pm` and ~130 tickets moved `defined → done`),
  and the subject gate stops any bulleted commit claiming work.
- **A terminal ticket's delivery record is ONE UNIT, written once.** `hadRecord` is
  snapshotted from `t.frontmatter` before either field is written and governs both: a
  terminal ticket with *either* `branch` or `pr` keeps *both*. It must stay **eager** —
  making it lazy inside `keep()` re-creates the write-nothing direction.
- **`PR_RANK` is `OPEN 3 > MERGED 2 > CLOSED 1`** — a *selection precedence*, not a progress
  ordering. An open PR vetoes `done`.
- **`assertSchemaValid` throws only on HARD problems.** `validateSchema` returns a tagged
  list; advisories (BLZ-361 narrowing, link-type override notes, per-project `linkTypes`
  inertness, endpoint-kind) are **soft** and never refuse a verb. There are **22 hard** and
  **5 soft** call sites, and a test asserts the CLASSIFICATION table covers every one **by
  identity, not count**.
- **A partial `workflows` record is now invalid**, exactly like a partial `types` record —
  `terminal`, `transitions` and `resolutionOnTerminal` are required; `reopenTo` is not.
- **Setup fails CLOSED.** A failed identity adoption keeps `setupPending === true`, clears
  the token, logs to stderr and returns 500. It does **not** fall open.
- **`ADR-0023` is on `main`** and records BLZ-130/BLZ-131's decisions, including the
  four shapes the delivery record has been wrong in.

---

## 3. The lane — four bundles, in this order

**Run the `feature-pr-bundling` skill before starting.** It was updated on 2026-08-26 and
now describes the squash-body mechanism above — including that **children ARE auto-moved**
when the bullets survive, which reverses what it used to say.

### Lane 1 — BLZ-395 + BLZ-398 + BLZ-399, as ONE feature PR (270 min) — START HERE

All three are the delivery record's remaining truth problems, all in `scripts/reconcile.mjs`,
all children of BLZ-43. One integration branch, one PR; tickets stay 1:1 with commits.

- **BLZ-395** (bug, medium, 120) — terminal-stickiness keeps a wrongly-`done` ticket `done`,
  so BLZ-130's veto narrows the window without closing it. **Read ADR-0023 §1 first** — it
  states the options and recommends *"report, don't move"* over un-sticking.
- **BLZ-398** (bug, medium, 90) — a record-less `done` ticket carrying two merged PRs
  acquires the **latest** merge, not the deliverer, and write-once makes it permanent.
  **Read the ticket's tradeoff section before implementing**: "earliest merge" is a
  heuristic, and this record has already been wrong in four directions.
- **BLZ-399** (task, medium, 60) — three load-bearing conditions pinned by no test: the
  bullet rule's colon, two of four subject separators (`,` and `&`), and `buildBranchMap`'s
  single-id corroboration. Shipped code is correct; the tests are missing. **Do this one
  first inside the bundle** — it is pure test work and it protects the other two.

**Both failures bias in the dangerous direction — the board says shipped when it is not.**
Whatever you build, make the safe direction the default.

### Lane 2 — BLZ-394 (bug, medium, 90)

`reconcile --apply` has no `--project` filter, so a session commits ticket moves it does not
own. **ADR-0023 §3 already ruled OUT session-scoping — do not re-propose it.** Only the
`--project` filter is left.

**Kept out of Lane 1 deliberately**, on BLZ-394's own stated boundary: it changes the
**WRITE** path, where BLZ-130/131 and Lane 1 change only how git and PR state are READ.

### Lane 3 — BLZ-397 + BLZ-400, as ONE feature PR (105 min)

Both are first-run-setup residuals in `scripts/serve.mjs` / `scripts/model/setup-token.mjs`.

- **BLZ-400** (bug, medium, 45) — after a failed identity adoption the operator holds an
  admin account whose credential was never issued, and the diagnostic says only "Restart
  blaze". Not a brick (`blaze user add` recovers it); the product never says so. Two guards
  on that path are also unpinned — narrowing `!== "healthy"` to `=== "broken"` survives all
  tests and would fall **open** on `absent` or `empty`.
- **BLZ-397** (bug, low, 60) — `ensureSetupTokenIgnored` reports `added` without verifying
  the rule took, and accretes a duplicate `.gitignore` line every boot on a board whose
  `.blaze/.gitignore` negates the token.

### Lane 4 — BLZ-396 (bug, medium, 90)

A wrong-shaped `types`/`workflows` **container** (`{"types":"notanobject"}`,
`{"workflows":42}`, or a whole `"schema"` that is a string) produces **zero** findings and
`blaze audit` reports `ok=true`. Inside BLZ-56's stated territory, but it predates that
branch **and** `origin/main`. The engine already has the right shape of answer for this
class — `linkTypeOverrideErrors` says "the whole block was IGNORED" — so mirror it.

### Housekeeping — do this in Lane 1's session, it is minutes

1. **PR #126 is open** and carries `2026-08-29-blaze-next-session-kickoff.md`, whose lane is
   complete. `main` already keeps `2026-08-23` and `2026-08-28`, so the pattern is to keep
   them: **merge #126**, then merge the PR carrying this document. If you disagree, close
   #126 with a reason — but do not leave it open and unexplained.
2. **ADR-0002's alternative (c) premise is factually stale.**
   `docs/decisions/0002-config-schema-versioning.md:124` says `resolveSchema` *"is not wired
   into runtime; its only callers are tests"*. It has **five** runtime callers today
   (`audit-runner.mjs`, `cli.mjs`, `schedule-runner.mjs`, `model/link-schema.mjs`,
   `model/audit.mjs`). Add a dated "premise superseded" note. **Do not touch (c)'s ruling.**
3. **`.gitignore:10` is `node_modules/`** — the trailing slash matches a directory, not the
   symlink each worktree gets, so `git check-ignore` says not-ignored and a `git add -A`
   would commit it. Every reviewer last lane had to explain the stray `?? node_modules`.
   Dropping the slash closes it repo-wide.

---

## 4. What remains after this lane

Lower-priority bugs once the four lanes land: **BLZ-128**, **BLZ-248**, **BLZ-250**
(medium); **BLZ-23**, **BLZ-124** (low).

---

## 5. Blocked vs actionable — so a bare "continue" needs no questions back

| Item | State | Why |
|---|---|---|
| **BLZ-395 + BLZ-398 + BLZ-399** | **ACTIONABLE — start here**, bundled | Same subsystem, same file; BLZ-399 protects the other two |
| **BLZ-394** | **ACTIONABLE** after Lane 1 | Decision recorded; only the `--project` filter is left |
| **BLZ-397 + BLZ-400** | **ACTIONABLE**, bundled | Both first-run-setup residuals |
| **BLZ-396** | **ACTIONABLE** | Predates the branch it was found on |
| BLZ-324 | **BLOCKED** | Needs a week of dual-write soak. Elapsed time, not agent work |
| BLZ-309 | **BLOCKED** | Cannot start until BLZ-254's db-primary cutover lands |
| BLZ-355 | **BLOCKED — needs the operator interactively** | Do not queue it for an agent session |
| BLZ-253, BLZ-282, BLZ-305, BLZ-345 | containers | Parent goals; nothing to do directly |

---

## 6. Out of scope

- **There are no parallel sessions and no sibling lanes to fence.** If that changes, fence
  them here by ticket key before starting.
- **Do not push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole
  merger. Work there ends at a local commit. **132 unpushed is correct.**
- **Do not "fix" `provider` in `blaze-pm/blaze.config.json`.** `loadConfig` throws on it at
  `blaze-pm`'s `origin/main`, which means BLZ-56's new preflight is a **silent no-op on the
  live board until the flush lands** — but the deletion is **already committed** on
  `BLZ-305-v4-spine` as `c097535a` and is one of the 132 unpushed. It self-resolves. Verify
  before assuming; do not re-fix.
- **Do not run `blaze schedule migrate-dates --write` against the live board.** The real
  write is the operator's to run.
- **Do not touch the NCA project.** Parked by the operator on 2026-08-23.
- **Do not build the Gantt view.** Spec 3 specifies it; separate lane.
- **Do not reopen** ADR-0001, ADR-0014's *ruling*, ADR-0021, ADR-0022's decision, or
  **ADR-0023** — including its §1 options and its §3 ruling against session-scoping.
- **Do not re-attack the test machinery accepted last lane**: the `CLASSIFICATION` table,
  the call-site source scanner (its lexical residual gap is documented and accepted), and
  `tests/cli.test.mjs`'s comment-arithmetic guard.
- **Do not implement `activeByProject`.** Unticketed, not this lane.
- **Do not chase line-number citations through `docs/superpowers/specs/` and `plans/`.**
  Many drifted when BLZ-386 landed. **Cite by symbol.**

---

## 7. Process

- **PR unit = the feature, not the ticket.** Decide the bundle first via the
  `feature-pr-bundling` skill; one PR per feature integration branch.
- Branch `KEY-n-slug`; every commit `KEY-n: description`; PR title `KEY-n: description` or
  `KEY-a + KEY-b: description`.
- **`hygiene.yml` rejects `Co-Authored-By` trailers** and runs only on `pull_request`.
  Check with `node scripts/ci/hygiene-check.mjs origin/main`.
- **Write commit bodies to a file and use `git commit -F`.** A backtick inside a
  double-quoted shell string gets command-substituted. Same rule for `python3 -c` — use a
  heredoc.
- **Commit with an EXPLICIT pathspec, always.** A bare `git commit` swept a half-move once:
  the `defined/` deletions were left behind because the pathspec named only `in-review/`.
- **Splitting one change into per-ticket commits is where a fix gets silently reverted.**
  If you rebuild an intermediate tree to split a commit, **`diff` each file against a saved
  copy before pushing.** This cost round 6 on #123 and is the reason that PR needed ten.
- **`gh pr merge --delete-branch` fails while a worktree holds the branch** — run
  `git worktree remove <path> --force` first.
- **Keep the squash SUBJECT in `KEY-n:` form.** BLZ-131 reads a squash body's `* KEY-n:`
  bullets **only** when the subject opens with a ticket-id list, and GitHub's
  *Default commit message for squash merges* must stay **"Default message"**
  (`gh api repos/hjr15/blaze --jq .squash_merge_commit_message` → `COMMIT_MESSAGES`).
- `blaze commit` takes **no message flag** — stage explicit pathspecs and `git commit -F`.
  Run `blaze` commands **from the board directory**.
- `blaze log` before any terminal move. Delivery is `defined → in-progress → in-review →
  done` and you cannot jump. **Reconcile is disabled** — move tickets by hand.
- **Move tickets with `blaze move`, re-parent with `blaze edit parent`**, never by editing
  frontmatter. **A ticket's status comes from its DIRECTORY.**
- **Never edit a worklog note to correct a figure.** Add the correction beside it. A worklog
  is a record of what was believed that day, and rewriting a figure in place is the exact
  failure this lane spent ten rounds fixing.
- **Set `model` explicitly on every subagent dispatch; never inherit:**

  | Job | Model |
  |---|---|
  | Read-only recon / codebase fan-out | `haiku` (`sonnet` across many files) |
  | Mechanical, already-designed implementation | `sonnet` |
  | Complex or subtle implementation | `opus` |
  | Judgement-heavy review, adversarial verify | `opus` |
  | Design / brainstorm / architecture decision | `fable`, `opus` fallback |

- **Never let a reviewer and a fix agent share a worktree.** Six commits landed under a
  reviewer mid-review last lane; its conclusions survived only by luck and a timestamp
  check. One agent per worktree at a time.
- **Give each concurrent agent its own Postgres container and port.** Three reviewers
  sharing one database is a collision the doc used to not cover.

---

## 8. Verification before merge

Run in the PR's worktree after any rebase:

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

**`test.yml` runs only `npm run test:coverage` (`--test-concurrency=1`).** `npm test` runs
files concurrently and catches things coverage does not. **Run both.**

`strict: true` means each merge invalidates the others' branch-up-to-date status. After each
merge, rebase the next and **re-run the full gate** — `strict` exists to catch the semantic
conflict a clean textual merge hides.

---

## 9. The review bar — updated with this lane's data

**Every agent PR gets an adversarial review before merge, and the reviewer must try to make
the check FAIL.** Across **24 rounds on three PRs**, the great majority returned REFUTED and
**CI caught none of it**.

**Scope each review to PRODUCT BEHAVIOUR.** That single change found two defects that eight
broader rounds had walked past — because the broader rounds kept being drawn into prose.
Record wording, figures and test-machinery findings in the PR body and ticket them; do not
fix-and-re-review them.

What the rounds actually found, because the pattern is not the one you would guess:

1. **A fix can be described and not shipped.** Commit-splitting reverted a hunk; the message,
   the ADR and the guide all asserted a behaviour the code did not have.
2. **The next defect comes from the previous round's fix.** On #123, rounds 6, 7 and 8 were
   each a surviving mutant on the guard the round before had just added.
3. **A correction can fix one instance and not its twin.** A figure conflation was corrected
   in an ADR and left standing 20 lines above the comment that commit was editing.
4. **A figure can be mislabelled rather than stale.** `426`/`49` were the `INF` key alone,
   never board-wide — both numbers were right, for different populations, and the table
   named neither. **Name the population AND a ref anyone can resolve.**
5. **A new check can be worse than the bug**, twice: a preflight refused every verb on a
   board `blaze audit` calls clean.
6. **A security fix can open a bigger hole.** A failed identity adoption served the whole
   board unauthenticated on `0.0.0.0`.
7. **A guard can be unobservable rather than untested** — the 409 in-flight latch never fires
   in any shipped configuration, so removing it changed nothing.
8. **A harness can hide tests.** Stubbing `process.stdout.write` swallowed the runner's own
   result lines: **ten tests and five suites vanished with nothing failing.**

Practices, all cheap:

1. **Grep, don't reason, about blast radius.**
2. **Measure, don't transcribe** — and re-measure after your own correction.
3. **After any correction, grep the *unchanged* body for the claim's negation.**
4. **Prove every regression test discriminates** by reverting the fix and watching it go red.
5. **Do not guard a runtime property by scanning source text.**
6. **A check on the output of a command that did not run proves nothing** — assert your
   mutation actually applied before believing the green.
7. **Say plainly when a mutation is equivalent.** Claiming a test kills something it cannot
   is worse than not having the test.
8. **When a fix makes a key mandatory, prove it false-refuses nothing** against the real
   board before shipping it.

---

## 10. The one lesson worth more than the rest

**A test that passes for a different reason than its name claims is worth less than no test.**

Every expensive round last lane was this: the 409 guard whose nine "losers" were refused by
a race rather than the guard; the gitignore test that called its helper instead of booting
the server; `spawnSync` that cannot reproduce piped truncation; the outer-catch test whose
injection silently started hitting a different branch; the legal-narrowing fixture that
would not have survived the check it was measuring.

So: **revert the production hunk and watch the named test go red — every time.** If it stays
green, you have learned something more important than whatever you were about to commit.
