# Blaze — next session kickoff (written 2026-08-26)

**If you are a session reading this, your task is §3 — finish Lane 1 first (round 4 review,
then merge PR #128), then Lanes 2–4 in order.** You need no further instruction to begin.

Supersedes `2026-08-30-blaze-next-session-kickoff.md`. That document's Lane 1
(BLZ-395 + BLZ-398 + BLZ-399) is **built and green but NOT MERGED** — see §2. Its Lanes 2, 3
and 4 are **untouched** and carried forward here verbatim in intent.

---

## 0. Continuity contract

A usage, context or API limit is a **pause, not completion.** Do not stop, do not mark
anything Done, do not hand back early. Commit after every sub-step, keep a running checklist
in the ticket you are on, and resume from branch + checklist.

**Do not narrow the lane on your own.** If you run out of room, leave the next lane
untouched and say which one it is.

---

## 1. First ten minutes — verify, do not trust

**This document asserts repo and board state. Re-verify before building.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH   # Node 20 lacks node:sqlite — mandatory
cd /home/rnamwoh/Documents/Code/blaze
git fetch origin && git log origin/main --oneline -3
gh pr view 128 --json number,headRefOid,mergeable,mergeStateStatus
```

Expect `origin/main` at **`3cf1509`**, and **PR #128 open** with head **`d9b7836`**,
`MERGEABLE` / `CLEAN`, four green checks.

The Lane 1 worktree already exists and is clean:

```bash
cd /home/rnamwoh/Documents/Code/blaze-worktrees/delivery-record-truth
git status --short && git log origin/main..HEAD --oneline
```

Expect six commits and an empty status. If the worktree is gone, recreate it:

```bash
cd /home/rnamwoh/Documents/Code/blaze
git worktree add /home/rnamwoh/Documents/Code/blaze-worktrees/delivery-record-truth BLZ-395-delivery-record-truth
ln -s /home/rnamwoh/Documents/Code/blaze/node_modules \
      /home/rnamwoh/Documents/Code/blaze-worktrees/delivery-record-truth/node_modules
```

Baseline — **one fresh container, wait on a real query**:

```bash
docker rm -f blzpg 2>/dev/null
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55455:5432 --name blzpg postgres:17-alpine
for i in $(seq 1 60); do docker exec blzpg psql -U postgres -c 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
rm -rf coverage
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55455/postgres npm run test:coverage
```

Expected on `d9b7836`: **2,581 pass / 0 fail**, coverage ≈**98.43 / 87.15 / 97.29 / 98.43**
against gates 91 / 77 / 93 / 91. On `origin/main` (`3cf1509`) the baseline is **2,518 / 0**.
**If the tests do not reproduce, stop and say so.**

> **Coverage is nondeterministic — quote it loosely.** Do not "correct" a last-decimal
> difference and do not call a 0.05pp move a regression.

**Postgres traps, each of which cost real time:**

- **Wait on a real query, never `pg_isready`** — it returns while the server still answers
  *"the database system is starting up"*.
- **A stale container is the most likely false failure you will hit.** Recreate before
  believing any Postgres failure.
- **`rm -rf coverage` before every coverage run.**
- **Never run a mutation sweep against the same database as your measurement run.**

Board, read-only:

```bash
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine
git status -sb && node /home/rnamwoh/Documents/Code/blaze/scripts/cli.mjs audit | tail -2
```

Expect `BLZ-305-v4-spine`, **136 or more commits unpushed — correct, do not push**, and
`ok=true`.

---

## 2. What happened last session, so you do not redo it

**Merged to `main`:** PR #126 and PR #127 (the two kickoff docs). There are now **no other
open PRs** besides #128.

**PR #128 — `BLZ-395 + BLZ-398 + BLZ-399` — is BUILT, GREEN, and DELIBERATELY UNMERGED.**
Six commits on `BLZ-395-delivery-record-truth`:

| Commit | What |
|---|---|
| `36d4d88` | **BLZ-399** — pins the three load-bearing conditions no test held |
| `59e3d12` | **BLZ-395** — "report, don't move"; `findings` on reconcile's result |
| `d4ce96d` | **BLZ-398** — deliverer-or-nothing for the delivery record |
| `b9ccbde` | housekeeping — `.gitignore`, ADR-0002's stale premise |
| `dc40f05` | review round 1 fixes |
| `d9b7836` | review rounds 2 + 3 fixes |

**The §3 housekeeping from the last doc is DONE:** #126 merged; `.gitignore:10` is now
`node_modules` with no trailing slash (verified with `git check-ignore -v node_modules`, exit
1 → match); ADR-0002 carries a dated "premise superseded" note and **(c)'s ruling is
untouched**.

**Decisions taken, recorded, and NOT to be reopened:**

- **BLZ-395 → "report, don't move"** (ADR-0023 §1's second option). Terminal-stickiness is
  **unchanged, deliberately**. Reconcile gained `findings`, surfaced on the CLI (stderr,
  every run, regardless of `--quiet`), the `blaze start` activity feed (deduped `warning`),
  and `/api/reconcile-preview`.
- **BLZ-398 → name the deliverer, or name nothing.** A title leading with the id outranks
  one that merely mentions it; an unresolvable merged set records nothing, **clears** any
  rank-chosen live record, and reports which PRs tied.
- **BLZ-399 → `&` is KEPT.** Dropping a separator does not truncate the list, it makes the
  whole subject fail to match, losing every id *and* every bullet in the body.
- **ADR-0023 now records a third verb: reconcile may DELETE a delivery record.** Its old
  rule read as though acquire and keep were the only directions.

**Three adversarial review rounds ran, and every one found a real defect — each in the
previous round's fix.** Full detail is in PR #128's body; the short version:

1. Round 1 (security scope) — the finding was published and **unreadable** (the feed had no
   `warning` branch); `gh pr list` JSON was trusted verbatim (a newline in `pr.number`
   forged a whole `NEEDS ATTENTION` line).
2. Round 2 (behaviour scope) — **REFUTED the PR's headline claim**: the ambiguity refusal
   *froze* a rank-chosen wrong record into a terminal ticket permanently and then went
   silent. All three surfacing paths were held by nothing.
3. Round 3 (behaviour scope) — four defects introduced by rounds 1–2, including `samePr`
   deciding identity on a field the forge controls and `Number(pr.number)` writing
   `pr: #NaN` onto a terminal ticket.

**Tickets raised from the reviews, all in `defined/`:** **BLZ-401** (reconcile reports a
resolution backfill as a change), **BLZ-402** (project keys interpolated raw into
`new RegExp`), **BLZ-403** (a hand-moved terminal ticket keeps a rank-chosen record —
BLZ-398's stated residual), and **BLZ-404** (`blaze start`'s reconcile loop is a permanent
dry run). **Verify BLZ-404 exists** — it was being created as the session ended; if it is
missing, create it from §4.

---

## 3. The lane — in this order

### Lane 1 (finish) — round 4 review, then merge PR #128 — START HERE

**Round 4 was dispatched against `d9b7836` and killed when the session ended, so the round-3
fixes have NOT been independently reviewed.** Given that rounds 1, 2 and 3 each found their
defect *in the previous round's fix*, do not merge on the strength of a green gate.

Run one behaviour-scoped adversarial review of `d9b7836`, concentrated on what round 3
changed — read `git log -1` on the branch for the exact list:

- `sanitisePr` now **drops** a PR whose number is not a positive integer. New fail-closed
  path: does a drop silently remove a `done` signal, and should it be reported rather than
  silent?
- `samePr` is now `if (a.url || b.url) return Boolean(a.url) && a.url === b.url; return
  a.number === b.number;` — attack every combination of url present/absent/empty × numbers
  same/different.
- `ambiguousDeliverers`/`mergeRefs` carry `{number, url}` refs. Check the sort comparator
  against `undefined` urls, and that `prs` is always JSON-serialisable (it reaches
  `/api/reconcile-preview`).
- The `cleared` flag on every `changes` entry — does any consumer break on the new field?
- The clear guard `if (fm.branch || fm.pr)` — does it agree with `hadRecord` on every value
  the storages produce (`""`, `null`, `undefined`, whitespace)?

Give the reviewer its **own worktree and its own Postgres container and port**. Two review
worktrees already exist and are free:

```bash
cd /home/rnamwoh/Documents/Code/blaze
git worktree list          # review-lane1-1 and review-lane1-2, both detached
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55461:5432 --name blzpg-rev55461 postgres:17-alpine
```

If round 4 comes back clean, **merge**:

```bash
cd /home/rnamwoh/Documents/Code/blaze-worktrees/delivery-record-truth
gh pr merge 128 --squash --delete-branch     # remove the worktree FIRST if it holds the branch
```

**Keep the squash SUBJECT in `KEY-n:` form.** The PR title
`BLZ-395 + BLZ-398 + BLZ-399: …` was verified to parse to all three ids, so the squash body's
`* KEY-n:` bullets will be read. Then close the three tickets out: they are already in
`in-review/` with time logged, so each needs only `blaze move <id> done`.

### Lane 2 — BLZ-394 (bug, medium, 90)

`reconcile --apply` has no `--project` filter, so a session commits ticket moves it does not
own. **ADR-0023 §3 already ruled OUT session-scoping — do not re-propose it.** Only the
`--project` filter is left.

The ACs are unusually concrete; read the ticket. A sketch that fits the current code: add a
`projects` option to `reconcile()`, filter the `keys` list from `listProjects(cfg)`, and let
the existing `const s = sig.get(t.frontmatter.project); if (!s) continue;` do the write-side
restriction for free. An unknown key must be a **loud error naming the configured
projects**, and the dry-run output must state which projects were scanned (the INF-763
lesson). **Note BLZ-401 interacts with AC-3** — the commit's change count is currently
inflated by non-moves.

**Kept out of Lane 1 deliberately**, on BLZ-394's own stated boundary: it changes the
**WRITE** path, where Lane 1 changed only how git and PR state are READ.

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

**Note:** Lane 1 touched `scripts/serve.mjs` (one line, adding `findings` to the preview
payload). Rebase before starting.

### Lane 4 — BLZ-396 (bug, medium, 90)

A wrong-shaped `types`/`workflows` **container** (`{"types":"notanobject"}`,
`{"workflows":42}`, or a whole `"schema"` that is a string) produces **zero** findings and
`blaze audit` reports `ok=true`. Inside BLZ-56's stated territory, but it predates that
branch **and** `origin/main`. The engine already has the right shape of answer for this
class — `linkTypeOverrideErrors` says "the whole block was IGNORED" — so mirror it.

---

## 4. What remains after this lane

From the review backlog: **BLZ-401**, **BLZ-402**, **BLZ-403**, **BLZ-404**. BLZ-404 is
**high** priority and cheap — `runReconcile` in `scripts/supervisor.mjs` calls
`reconcile({ fetch: true, commit: true, push: true, root, projectsDir })` and never passes
`dryRun`, whose default is `true`, so `blaze start`'s reconcile loop **never writes and never
commits** while republishing the same proposed move to the activity feed every tick.
Verified identical on `origin/main`.

Lower-priority bugs already on the board: **BLZ-128**, **BLZ-248**, **BLZ-250** (medium);
**BLZ-23**, **BLZ-124** (low).

---

## 5. Blocked vs actionable — so a bare "continue" needs no questions back

| Item | State | Why |
|---|---|---|
| **PR #128 round 4 + merge** | **ACTIONABLE — start here** | Built, green, unreviewed since `d9b7836` |
| **BLZ-394** | **ACTIONABLE** after #128 merges | Decision recorded; only the `--project` filter is left |
| **BLZ-397 + BLZ-400** | **ACTIONABLE**, bundled | Both first-run-setup residuals |
| **BLZ-396** | **ACTIONABLE** | Predates the branch it was found on |
| BLZ-401 – BLZ-404 | **ACTIONABLE**, not this lane | Raised by #128's reviews; BLZ-404 is the valuable one |
| BLZ-324 | **BLOCKED** | Needs a week of dual-write soak. Elapsed time, not agent work |
| BLZ-309 | **BLOCKED** | Cannot start until BLZ-254's db-primary cutover lands |
| BLZ-355 | **BLOCKED — needs the operator interactively** | Do not queue it for an agent session |
| BLZ-253, BLZ-282, BLZ-305, BLZ-345 | containers | Parent goals; nothing to do directly |

---

## 6. Out of scope

- **There are no parallel sessions and no sibling lanes to fence.** If that changes, fence
  them here by ticket key before starting.
- **Do not push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole
  merger. Work there ends at a local commit. **136+ unpushed is correct.**
- **Do not "fix" `provider` in `blaze-pm/blaze.config.json`.** The deletion is already
  committed on `BLZ-305-v4-spine`; it self-resolves at the flush. Verify before assuming.
- **Do not run `blaze schedule migrate-dates --write` against the live board.**
- **Do not touch the NCA project.** Parked by the operator on 2026-08-23.
- **Do not build the Gantt view.** Spec 3 specifies it; separate lane.
- **Do not reopen** ADR-0001, ADR-0014's *ruling*, ADR-0021, ADR-0022's decision, or
  **ADR-0023** — including its §1 options, its §3 ruling against session-scoping, and its
  **new delete-direction paragraph and stated residual**.
- **Do not re-attack the test machinery accepted in earlier lanes**: the `CLASSIFICATION`
  table, the call-site source scanner, and `tests/cli.test.mjs`'s comment-arithmetic guard.
- **Do not re-litigate what rounds 1–3 confirmed clean** on #128: the tie-break direction
  and its reachability; the activity-feed renderer across every event kind including the
  groom revert button; the pre-auth surface (`/api/reconcile-preview` and `/events` are both
  gated at `read`, proven live); that nothing but reconcile originates `branch`/`pr`; and
  BLZ-399's four mutations at exactly 1 / 2 / 2 / 3.
- **Do not implement `activeByProject`.** Unticketed, not this lane.
- **Do not chase line-number citations through `docs/superpowers/specs/` and `plans/`.**
  **Cite by symbol.**

---

## 7. Process

- **PR unit = the feature, not the ticket.** Run the `feature-pr-bundling` skill.
- Branch `KEY-n-slug`; every commit `KEY-n: description`; PR title `KEY-n: description` or
  `KEY-a + KEY-b: description`.
- **`hygiene.yml` rejects `Co-Authored-By` trailers.** Check with
  `node scripts/ci/hygiene-check.mjs origin/main`.
- **Write commit bodies to a file and use `git commit -F`.** Same rule for `python3 -c` —
  use a heredoc.
- **Commit with an EXPLICIT pathspec, always.**
- **`gh pr merge --delete-branch` fails while a worktree holds the branch** — run
  `git worktree remove <path>` first (drop the `node_modules` symlink to avoid `--force`).
- `blaze commit` takes **no message flag**. Run `blaze` commands **from the board
  directory**. `blaze log` before any terminal move. Delivery is
  `defined → in-progress → in-review → done` and you cannot jump. **Reconcile is disabled** —
  move tickets by hand with `blaze move`; re-parent with `blaze edit parent`. **A ticket's
  status comes from its DIRECTORY.**
- **`bug` cannot be a child of a `requirement`** — `bug.parentTypes` is `["feature","story"]`.
  BLZ-165 is a requirement; a `blaze new --parent BLZ-165` for a bug is rejected. This cost a
  round trip last session.
- **Never edit a worklog note to correct a figure.** Add the correction beside it.
- **Set `model` explicitly on every subagent dispatch; never inherit:**

  | Job | Model |
  |---|---|
  | Read-only recon / codebase fan-out | `haiku` (`sonnet` across many files) |
  | Mechanical, already-designed implementation | `sonnet` |
  | Complex or subtle implementation | `opus` |
  | Judgement-heavy review, adversarial verify | `opus` |
  | Design / brainstorm / architecture decision | `fable`, `opus` fallback |

- **Never let a reviewer and a fix agent share a worktree.** One agent per worktree.
- **Give each concurrent agent its own Postgres container and port.**

### Process traps this session actually hit — read these, they cost real time

- **NEVER run `git checkout -- <file>` while you have uncommitted work in it.** A mutation
  loop that starts each iteration with `git checkout --` destroyed a completed, unpushed
  implementation **twice**. **Commit before any mutation run.** The tree is your only copy.
- **`node --check` EVERY file you edit, not just the one you were thinking about.** A
  backtick inside a comment inside a template literal (`ACTIVITY_SCRIPT` in
  `supervisor.mjs`) silently terminated the string and broke the module.
- **A green `gh pr checks` may be for the PREVIOUS head sha.** Compare
  `gh pr view <n> --json headRefOid` against `git rev-parse HEAD` before believing it.
- **Export your variables into `node --input-type=module -e`.** A measurement script that
  read `process.env.SP` when `SP` was never exported reported "0 PRs scanned" and would have
  been quoted as evidence.
- **A test can target the wrong function and prove nothing.** A `samePr` test that drove
  `ambiguousDeliverers` passed for an unrelated reason; `samePr` only runs in
  `gatherProject`, so only a real repo pair exercises it.

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
merge, rebase the next and **re-run the full gate**.

---

## 9. The review bar — updated with this lane's data

**Every agent PR gets an adversarial review before merge, and the reviewer must try to make
the check FAIL.** **SCOPE EACH REVIEW TO PRODUCT BEHAVIOUR** — correctness, vacuous tests,
the board overstating, the pre-auth surface. Record wording, figures and test-machinery
findings in the PR body and **ticket them; do not fix-and-re-review them.**

Across **27 rounds on four PRs**, CI has caught **none** of the real defects. This lane's
three rounds each found a defect **in the previous round's fix** — that is now the base rate,
not the exception. Plan for at least two rounds on any PR that changes a write path.

What the rounds actually found here, because the pattern is not the one you would guess:

1. **A guard can be UNOBSERVABLE rather than untested.** The finding was correct, deduped,
   published — and rendered as the single word "warning" because the feed had no branch for
   it. Thirty passing tests on the rule caught nothing.
2. **A fix can create the exact failure it prevents.** Refusing to write an ambiguous record
   *froze* a rank-chosen wrong one into a terminal ticket permanently, and silenced its own
   report. The guard was blocking the correction.
3. **A sanitiser can be the delivery mechanism.** Round 1 stripped control characters from
   `pr.url`; round 2 then keyed PR identity off `url` being present. Round 1's own
   empty-string output walked through round 2's hole.
4. **Coercion is not validation.** `Number(pr.number)` wrote `pr: #NaN` onto a terminal
   ticket permanently — through the sanitiser meant to contain the malformed payload.
5. **The mutation that survives is the finding.** Two rounds ended with one surviving mutant
   apiece, and in both cases the first replacement test targeted the wrong function or the
   wrong input and proved nothing.
6. **Name the population with every figure.** "branch-only write → 1 red" and "→ 2 red" were
   both true, for the single test file and for the wider set. Two right numbers, one
   unnamed population.

Practices, all cheap:

1. **Grep, don't reason, about blast radius.**
2. **Measure, don't transcribe** — and re-measure after your own correction.
3. **Prove every regression test discriminates** by reverting the fix and watching it go red.
4. **A check on the output of a command that did not run proves nothing** — assert your
   mutation actually applied, and that CI ran on the sha you think it did.
5. **Say plainly when a mutation is equivalent**, or when it survives and you are pinning it.
6. **Measure a new inference rule against the real board before shipping it.** BLZ-398's rule
   was measured over 1,761 PRs and 2,549 tickets at `blaze-pm` `ff5f36c2` — a ref anyone can
   resolve, not a local-only branch.

---

## 10. The one lesson worth more than the rest

**A test that passes for a different reason than its name claims is worth less than no test.**

So: **revert the production hunk and watch the named test go red — every time.** If it stays
green, you have learned something more important than whatever you were about to commit.
