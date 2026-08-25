# Blaze — next session kickoff (written 2026-08-25)

**If you are a session reading this, your task is §3.** You need no further instruction to
begin. Supersedes `2026-08-26-blaze-next-session-kickoff.md`, whose lane — BLZ-362, BLZ-377,
BLZ-392 — is **complete and merged** across PRs #118, #119 and #120.

---

## 0. Continuity contract

A usage, context or API limit is a **pause, not completion.** Do not stop, do not mark anything
Done, do not hand back early. Commit after every sub-step, keep a running checklist in the ticket
you are on, and resume from branch + checklist.

---

## 1. First ten minutes — verify, do not trust

**This document asserts repo state. Re-verify before building.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH   # Node 20 lacks node:sqlite — mandatory
cd /home/rnamwoh/Documents/Code/blaze
git fetch origin && git status --short && git log origin/main --oneline -4
```

Expect `main` at or after `d8549b5 BLZ-392: link-type endpoint kinds are overridable (#120)`.

> **The main checkout may be parked on a stale branch.** It was on `docs-cpm-solve-prompt`
> (4 PRs behind) at the start of the last session, and a baseline run there silently produced
> 1,991 tests instead of 2,203. **Check `git log --oneline -1 HEAD`, not just `origin/main`.**
> Work in a worktree cut from `origin/main`.

```bash
docker rm -f blzchk 2>/dev/null
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55450:5432 --name blzchk postgres:17-alpine
until docker exec blzchk psql -U postgres -c 'SELECT 1' >/dev/null 2>&1; do :; done
rm -rf coverage
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55450/postgres npm run test:coverage
```

Expected on `d8549b5`: **2,315 pass / 0 fail**, coverage **98.32 / 86.82 / 97.03 / 98.32**
against gates 91 / 77 / 93 / 91. **If the baseline does not reproduce, stop and say so.**

**Three Postgres traps, all of which cost real time last session:**

- **Wait on a real query, never `pg_isready`.** It returns while the server still answers *"the
  database system is starting up"*, which produced a false failure.
- **A stale container is the most likely false failure you will hit.** The version floor is now
  **4**, so a container left from an older run holds a v3 schema and **nine** driver-conformance
  tests fail with *"database schema version 3 is older than this engine supports"*. That is the
  guard working. `docker rm -f` and start a fresh one.
- **`rm -rf coverage` before every coverage run** — a stale directory produces wrong figures.

Board, read-only:

```bash
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine
git status -sb && node /home/rnamwoh/Documents/Code/blaze/scripts/cli.mjs audit | tail -2
```

Expect `BLZ-305-v4-spine`, **119 or more commits unpushed — correct, do not push**, and
`ok=true`. The unpushed count only ever rises; a *lower* number means the CronJob flushed.

---

## 2. What landed, so you do not redo it

| Merged | Commit | Closed |
|---|---|---|
| ADR-0014's Context corrected and pinned to the emitted DDL | `4024390` (#118) | BLZ-362 |
| `blaze_config` + `viewDdl` installed as DB schema version 4 | `68c8137` (#119) | BLZ-377 |
| Link-type endpoint kinds made overridable | `d8549b5` (#120) | BLZ-392 |
| Batch-mode bypass verified closed (shipped earlier in `e6a505b`) | — | BLZ-97 |

**Six facts that change what you can assume:**

- **`DB_SCHEMA_VERSION` and `MIN_DB_SCHEMA_VERSION` are both `4`.** Version 4 installs the
  `blaze_config` namespace — a second SQLite file at `.blaze/config.db`, ATTACHed by the opener,
  or a Postgres schema — plus `view` and `view_type` in it.
- **The whole config install is IDEMPOTENT, and that is load-bearing, not tidiness.**
  `blaze_config` is a Postgres *schema*, so it outlives the `public` tables the create guard
  inspects. The one non-idempotent statement (`ADD CONSTRAINT`, which Postgres cannot write as
  `IF NOT EXISTS`) **hung the CI gate for 59 minutes**. If you add anything to that DDL or its
  seeds, it must survive being run twice.
- **`validateSchema` now HAS a production caller** — `auditCorpus`. For years it had none, and
  ADR-0002 warns that leaning on it buys *"a well-tested no-op: green in CI, absent in
  production."* That warning no longer applies; **do not re-cite it as if it did.**
- **Two new soft finding kinds: `schema-invalid` and `schedule-empty`.** `SOFT_KINDS` is exported
  from `audit.mjs` and a test asserts it stays complete, so adding a kind without registering it
  fails.
- **`scheduleModel` is PURE and takes three registries** — `linkTypes`, `types`, `workflows`.
  A test asserts it does not import `workflowFor`, `isTerminal`, `TYPES` or `WORKFLOWS`. Reading
  any of them makes the model answer differently in different working directories, which is
  exactly how two defects got in. **Pass the value; never reach for the ambient registry.**
- **`blaze db init` rebuilds BOTH files on every create**, not only under `--force`, and a read
  never creates a config namespace.

---

## 3. The lane — pick up the two high-priority features

Both were marked *actionable, not this lane* by the previous kickoff, and both already carry an
**operator decision**, so neither needs a question answered before you start.

### 3.1 BLZ-369 first (feature, high, 180 min) — the old-engine window that destroys `activeByProject`

**The operator decided this on 2026-08-24: accept now, remove later.** Candidates were named,
neither was designed. Read the ticket for what "accept now" means concretely before choosing a
mechanism, and record the choice where it is enforced, not only in the PR.

### 3.2 BLZ-358 (feature, high, 240 min) — first-run setup

**The mechanism is already decided by the operator:** a one-time token at
`<board>/.blaze/setup-token`, mode `0600`, **path logged but never the value**. Prompt for the
first sysadmin account instead of refusing.

> **Never print, echo, or `base64 -d` that token's value** — not into a log, a test fixture, or a
> commit message. The path is the thing you surface.

### 3.3 If you finish both, the two high-priority bugs are the next natural pair

`BLZ-130` and `BLZ-131` are both `high`, both about reconcile/squash-merge losing per-ticket
truth. They are related enough to bundle as one feature PR — run the `feature-pr-bundling` skill
before starting, not after.

---

## 4. Blocked vs actionable — so a bare "continue" needs no questions back

| Ticket | State | Why |
|---|---|---|
| **BLZ-369** | **ACTIONABLE — start here** | Operator decision recorded 2026-08-24. |
| **BLZ-358** | **ACTIONABLE** | Mechanism decided; the token is a secret, the path is not. |
| BLZ-130, BLZ-131 | actionable | High-priority bugs; bundle them. |
| BLZ-56 | actionable, and newly cheaper | *Validate schema override config on load.* BLZ-392 gave `validateSchema` a production caller and an `endpointTypes` param, so part of this is already built — **re-scope it against the code before estimating.** |
| BLZ-355 | **BLOCKED — needs the operator interactively** | Do not queue it for an agent session. |
| BLZ-324 | **BLOCKED** | Needs a week of dual-write soak. Elapsed time, not agent work. |
| BLZ-309 | **BLOCKED** | Cannot start until BLZ-254's db-primary cutover lands. |
| BLZ-253, BLZ-282 | in-progress containers | Phase-1 parents; nothing to do directly. |
| BLZ-305, BLZ-345 | containers | Parent goals; nothing to do directly. |

---

## 5. Out of scope

- **There are no parallel sessions and no sibling lanes to fence.** If that changes, fence them
  here by ticket key before starting.
- **Do not push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole
  merger. Work there ends at a local commit. 119 unpushed is correct.
- **Do not run `blaze schedule migrate-dates --write` against the live board.** The tool is
  built, tested and proven on a copy. **The real write is the operator's to run.**
- **Do not touch the NCA project.** Parked by the operator on 2026-08-23.
- **Do not build the Gantt view.** Spec 3 specifies it; it is a separate lane.
- **Do not reopen** ADR-0001, ADR-0014's *ruling*, ADR-0021, or ADR-0022's decision.
- **Do not chase line-number citations through `docs/superpowers/specs/` and `plans/`.** Thirteen
  are stale and nothing checks them; only ADR-0014's table is test-enforced, and it is correct.
  Fixing them by hand is unbounded and goes stale on the next edit.

---

## 6. Process

- One PR per ticket. Branch `KEY-n-slug`; every commit `KEY-n: description`; PR title
  `KEY-n: description`.
- **`hygiene.yml` rejects `Co-Authored-By` trailers** and runs only on `pull_request`. Omit the
  trailer, open a PR rather than pushing to `main`, and check first with
  `node scripts/ci/hygiene-check.mjs origin/main`.
- **Write commit bodies to a file and use `git commit -F`.** A body containing backticks was
  shell-expanded in an earlier session and actually invoked `sprint-runner.mjs`.
- `blaze commit` takes **no message flag** — stage explicit pathspecs and `git commit -m`
  directly. Run `blaze` commands **from the board directory**.
- `blaze log` before any terminal move (BLZ has `requireWorklogBeforeTerminal`). Delivery is
  `defined → in-progress → in-review → done` and you cannot jump. **Reconcile is disabled** —
  move tickets by hand. **A ticket can sit in `in-review` for weeks unnoticed because of that**;
  BLZ-97's work shipped in `e6a505b` and the ticket was still open. If you touch a surface, check
  whether an old ticket already covers it.
- **Move tickets with `blaze move`, and re-parent with `blaze edit parent`, never by editing
  frontmatter directly.** **Features do not nest.**
- **A ticket's status comes from its DIRECTORY**, not a `status:` frontmatter field. A fixture
  that writes `status: done` into `projects/X/defined/` is a *defined* ticket, and three
  reproductions read as still-broken because of it last session.
- **`gh pr merge --delete-branch` fails** when another worktree holds `main`; delete the branch
  separately.
- **Use a worktree**, and symlink `node_modules` or ~108 tests fail on a missing `pg`:
  ```bash
  git worktree add -b <branch> /home/rnamwoh/Documents/Code/blaze-worktrees/<slug> origin/main
  ln -sfn /home/rnamwoh/Documents/Code/blaze/node_modules /home/rnamwoh/Documents/Code/blaze-worktrees/<slug>/node_modules
  ```
- **Set `model` explicitly on every subagent dispatch; never inherit:**

  | Job | Model |
  |---|---|
  | Read-only recon / codebase fan-out | `haiku` (`sonnet` if it must reason across many files) |
  | Mechanical, already-designed implementation | `sonnet` |
  | Complex or subtle implementation | `opus` |
  | Judgement-heavy review, adversarial verify | `opus` |
  | Design / brainstorm / architecture decision | `fable`, with `opus` as fallback |

---

## 7. Verification before merge

```bash
cd /home/rnamwoh/Documents/Code/blaze-worktrees/<slug>
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
node scripts/ci/hygiene-check.mjs origin/main
docker rm -f blzpg 2>/dev/null
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55450:5432 --name blzpg postgres:17-alpine
until docker exec blzpg psql -U postgres -c 'SELECT 1' >/dev/null 2>&1; do :; done
rm -rf coverage
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55450/postgres npm run test:coverage
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55450/postgres npm test
node scripts/ci/mutate-schedule.mjs        # must print "All mutations killed" and exit 0
docker rm -f blzpg
```

**`test.yml` runs only `npm run test:coverage`, which is `--test-concurrency=1`.** `npm test` runs
files concurrently and catches things coverage does not. Run both.

**And run at least one decisive gate on a FRESH container.** See §9 — this is the single most
expensive lesson of the last session.

---

## 8. The review bar — the instruction that earned its keep

**Every agent PR gets an adversarial review before merge, and the reviewer must try to make the
check FAIL, not confirm it passes.** Across ten rounds on three PRs last session, reviewers found
roughly **sixty defects, and CI caught none of them.**

The pattern, which is not the one you would guess:

- **Every corpus measurement reproduced, every time.** Measurement discipline held completely.
- **In EVERY round, the previous round's FIXES introduced new defects.** Not once was a fix round
  clean. Two fixes were worse than the bug they closed: one killed `blaze audit` outright, one
  made a pure model CWD-dependent.
- **The last blocking defect was a correction that stopped one line short** — the line above the
  one that had just been fixed, in the same function.

Practices that came out of it, all cheap:

1. **Grep, don't reason, about blast radius.**
2. **Measure, don't transcribe** — and re-measure after your own correction.
3. **After any correction, grep the *unchanged* body for the claim's negation**, and re-read the
   lines either side of the one you changed.
4. **Prove every regression test discriminates by reverting the fix and watching it go red.**
5. **Do not guard a runtime property by scanning source text.** A grep guard was defeated in four
   consecutive rounds — a bare match, a `//` comment, a `/*` inside a `//` comment that hid 39
   lines, and finally an argument-less call that named nothing bannable. Each fix was a better
   lexer; the mistake was lexing. It was replaced by subprocess tests that run the real runners,
   which are both simpler and strictly stronger.

And keep in every implementation dispatch: *if a mutation does not break a test, say so plainly.*

---

## 9. The one lesson worth more than the rest

**A warm Postgres hides idempotency bugs, and CI is always cold.**

BLZ-377's config install was not idempotent. Every local run was green because the namespace
already existed from a previous run, so the second create never re-entered. CI provisions a fresh
`postgres:17-alpine` service on every run, so **every CI run is the cold path** — and it hung
there for 59 minutes, could not be cancelled, and was initially misdiagnosed as a wedged runner.

If you touch schema creation, seeds, or anything that writes to `blaze_config`:

```bash
docker rm -f blzcold 2>/dev/null
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55450:5432 --name blzcold postgres:17-alpine
until docker exec blzcold psql -U postgres -c 'SELECT 1' >/dev/null 2>&1; do :; done
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55450/postgres \
  node --test --test-concurrency=1 tests/model/config-schema.test.mjs tests/model/driver-conformance.test.mjs
```

That pairing is the cheapest reproduction of the whole class. It passes **51/51** on `d8549b5`.
