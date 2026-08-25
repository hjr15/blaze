# Blaze — next session kickoff (written 2026-08-25)

**If you are a session reading this, your task is §3 — all three items, in order.** You need no
further instruction to begin. Supersedes `2026-08-27-blaze-next-session-kickoff.md`, whose lane
(BLZ-369) is **complete and merged** as `bbe3d67` (#121).

---

## 0. Continuity contract

A usage, context or API limit is a **pause, not completion.** Do not stop, do not mark anything
Done, do not hand back early. Commit after every sub-step, keep a running checklist in the ticket
you are on, and resume from branch + checklist.

**This lane is three PRs and roughly 690 minutes of estimate.** Finishing one and stopping is a
pause, not a failure — but do not narrow the lane on your own. If you run out of room, leave the
next item untouched and say which one it is.

---

## 1. First ten minutes — verify, do not trust

**This document asserts repo state. Re-verify before building.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH   # Node 20 lacks node:sqlite — mandatory
cd /home/rnamwoh/Documents/Code/blaze
git fetch origin && git status --short && git log --oneline -1 HEAD && git log origin/main --oneline -3
```

Expect `main` at or after `bbe3d67 BLZ-369: stop loadSprints discarding what it does not
understand (#121)`, and **check `HEAD` as well as `origin/main`** — the main checkout has been
found parked on a stale branch before, and a baseline run there silently reported 1,991 tests
instead of 2,203.

```bash
docker rm -f blzchk 2>/dev/null
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55455:5432 --name blzchk postgres:17-alpine
until docker exec blzchk psql -U postgres -c 'SELECT 1' >/dev/null 2>&1; do :; done
rm -rf coverage
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55455/postgres npm run test:coverage
```

Expected on `bbe3d67`: **2,336 pass / 0 fail**, coverage **≈98.3 / ≈86.9 / ≈97.0 / ≈98.3** against
gates 91 / 77 / 93 / 91. **If the tests do not reproduce, stop and say so.**

> **Coverage is nondeterministic — quote it loosely.** Measured three times on `bbe3d67`:
> functions came back **690/711 once and 689/711 twice**, so 97.04% and 96.90% are both real
> readings of the same commit. One function is covered on some runs and not others. Do not
> "correct" a figure that differs in the last decimal, and do not treat a 0.14pp move as a
> regression — I wasted a correction on exactly that.

**Three Postgres traps, each of which cost real time:**

- **Wait on a real query, never `pg_isready`.** It returns while the server still answers *"the
  database system is starting up"*.
- **A stale container is the most likely false failure you will hit.** The version floor is **4**,
  so an older container fails nine driver-conformance tests with *"database schema version 3 is
  older than this engine supports"*. That is the guard working.
- **`rm -rf coverage` before every coverage run.**

Board, read-only:

```bash
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine
git status -sb && node /home/rnamwoh/Documents/Code/blaze/scripts/cli.mjs audit | tail -2
```

Expect `BLZ-305-v4-spine`, **121 or more commits unpushed — correct, do not push**, and `ok=true`.

---

## 2. What landed, so you do not redo it

| Merged | Commit | Closed |
|---|---|---|
| ADR-0014's Context corrected and pinned to the emitted DDL | `4024390` (#118) | BLZ-362 |
| `blaze_config` + `viewDdl` installed as DB schema version 4 | `68c8137` (#119) | BLZ-377 |
| Link-type endpoint kinds made overridable | `d8549b5` (#120) | BLZ-392 |
| `loadSprints` stopped discarding unknown keys | `bbe3d67` (#121) | BLZ-369 |
| Batch-mode bypass verified closed (shipped earlier in `e6a505b`) | — | BLZ-97 |

**Facts that change what you can assume:**

- **`DB_SCHEMA_VERSION` and `MIN_DB_SCHEMA_VERSION` are both `4`**, and the whole `blaze_config`
  install is **idempotent** — the one statement that was not hung the CI gate for 59 minutes.
  Anything you add to that DDL or its seeds must survive running twice.
- **`validateSchema` HAS a production caller now** (`auditCorpus`), so ADR-0002's *"a well-tested
  no-op: green in CI, absent in production"* no longer applies to it. **Do not re-cite it as if it
  did** — and see §3.3, which turns on this.
- **`scheduleModel` is PURE and takes three registries** — `linkTypes`, `types`, `workflows`. A
  test asserts it does not import `workflowFor`, `isTerminal`, `TYPES` or `WORKFLOWS`. Reading any
  of them makes it answer differently in different directories; that is how two defects got in.
- **`loadSprints` preserves unknown keys and `saveSprints` stamps `registryVersion`.** A stamp is
  an integer ≥ 1 and is never downgraded.
- **Two new soft finding kinds** — `schema-invalid`, `schedule-empty`. `SOFT_KINDS` is exported and
  a test asserts it stays complete.

---

## 3. The lane — three items, in this order

### 3.1 BLZ-130 + BLZ-131 FIRST (bugs, both high, 120 + 150 min) — as ONE feature PR

Both are children of BLZ-43, both `Implements` BLZ-189, and both are the same failure: **reconcile
reporting an epic as shipped when it is not.**

- **BLZ-130** — reconcile marks an epic done from *any* merged PR carrying its key. Found live:
  epic INF-645 was marked done because an early docs-only PR #80 merged, while the actual work sat
  in PR #81, still open.
- **BLZ-131** — these repos are **squash-only**, so per-ticket commits inside an epic's PR do not
  survive the merge, and bundled epic-children therefore never reconcile to done. Two documented
  mechanisms are mutually incompatible and nothing surfaces the conflict.

**Run the `feature-pr-bundling` skill before starting, not after.** One feature, one integration
branch, one PR; tickets stay 1:1 with commits.

**Both failures bias in the dangerous direction — the board says shipped when it is not.** Whatever
you build, make the safe direction the default: when reconcile cannot tell, it must not move a
ticket to done.

### 3.2 BLZ-358 (feature, high, 240 min) — first-run setup

**The shipped Docker image currently refuses to start out of the box.** `Dockerfile` sets
`HOST=0.0.0.0`, and `checkBindSafety` refuses a non-loopback bind with no identities configured.
Refusing is right *given no alternative*; the alternative is what Jira does — serve a setup flow.

**The operator decided the mechanism on 2026-08-23:** a one-time token written to a file under the
board, `<board>/.blaze/setup-token`, mode `0600`, **path logged but never the value**.

> **Never print, echo, `cat`, or `base64 -d` that token's value** — not into a log, a test fixture,
> an assertion message, or a commit message. The path is the thing you surface. A token that
> reaches a transcript is a token that must be rotated.

**A terminal wizard is not sufficient.** `scripts/init.mjs` already has one, and the failing case
is a container with no TTY — `docker run -p 4321:4321` cannot prompt anyone. The flow has to be
reachable over HTTP, because HTTP is the only channel that deployment has.

Detection is already available: `loadIdentity`'s `hasIdentity:false`, and BLZ-348 added the
zero-user case explicitly (`n === 0`).

### 3.3 BLZ-56 (task, medium, 180 min) — validate the schema override on load

**Re-scope it against the code before you estimate.** BLZ-392 built part of this: `validateSchema`
gained an `endpointTypes` parameter and, for the first time, a production caller.

> **READ THIS BEFORE WRITING ANY CODE.** BLZ-56's AC says a malformed override must **fail loud**.
> BLZ-392 deliberately made `validateSchema` **report rather than throw**, because throwing killed
> `blaze audit` outright — a stack trace and *no report at all*, from inside `auditCorpus`, losing
> the whole hygiene report. It also inverted the tolerance: an unparseable config still audited
> while a valid one with one bad field was fatal.
>
> **These are not in conflict, but only if you keep the paths separate.** BLZ-56 is about
> `loadConfig` / `ambientSchemaOverride` — the *load* path, where failing loud is right and where
> ADR-0002's precedent is a hard, named error. `auditCorpus` is the *reporting* path, where a throw
> is a regression with a test guarding it. **If your change makes `blaze audit` throw on a bad
> config, you have reintroduced the defect** — `tests/audit-malformed-linktypes.test.mjs` exists
> precisely to catch that, so run it early.
>
> BLZ-56's AC-4 asks you to record this decision deliberately. That is the decision.

---

## 4. Blocked vs actionable — so a bare "continue" needs no questions back

| Ticket | State | Why |
|---|---|---|
| **BLZ-130 + BLZ-131** | **ACTIONABLE — start here**, bundled | Both high; same failure mode |
| **BLZ-358** | **ACTIONABLE** | Mechanism decided; the token is a secret, its path is not |
| **BLZ-56** | **ACTIONABLE** | Partly built by BLZ-392 — re-scope first, and read §3.3 |
| BLZ-355 | **BLOCKED — needs the operator interactively** | Do not queue it for an agent session. |
| BLZ-324 | **BLOCKED** | Needs a week of dual-write soak. Elapsed time, not agent work. |
| BLZ-309 | **BLOCKED** | Cannot start until BLZ-254's db-primary cutover lands. |
| BLZ-253, BLZ-282 | in-progress containers | Phase-1 parents; nothing to do directly. |
| BLZ-305, BLZ-345 | containers | Parent goals; nothing to do directly. |

Lower-priority bugs if the lane finishes: BLZ-128, BLZ-248, BLZ-250 (medium); BLZ-23, BLZ-124 (low).

---

## 5. Out of scope

- **There are no parallel sessions and no sibling lanes to fence.** If that changes, fence them
  here by ticket key before starting.
- **Do not push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole
  merger. Work there ends at a local commit. 121 unpushed is correct.
- **Do not run `blaze schedule migrate-dates --write` against the live board.** Built, tested and
  proven on a copy. **The real write is the operator's to run.**
- **Do not touch the NCA project.** Parked by the operator on 2026-08-23.
- **Do not build the Gantt view.** Spec 3 specifies it; separate lane.
- **Do not reopen** ADR-0001, ADR-0014's *ruling*, ADR-0021, or ADR-0022's decision.
- **Do not implement `activeByProject`.** BLZ-369 built the guard that has to precede it; the
  implementation itself is unticketed and is not this lane.
- **Do not chase line-number citations through `docs/superpowers/specs/` and `plans/`.** Many
  drifted when BLZ-386 landed and nothing checks them. Only ADR-0014's table is test-enforced.
  Cite by symbol.

---

## 6. Process

- One PR per ticket — **except BLZ-130 + BLZ-131, which are one PR** (§3.1).
- Branch `KEY-n-slug`; every commit `KEY-n: description`; PR title `KEY-n: description`.
- **`hygiene.yml` rejects `Co-Authored-By` trailers** and runs only on `pull_request`. Omit the
  trailer, open a PR rather than pushing to `main`, and check first with
  `node scripts/ci/hygiene-check.mjs origin/main`.
- **Write commit bodies to a file and use `git commit -F`.** A backtick inside a double-quoted
  shell string gets command-substituted — it has eaten a commit SHA out of a doc in this repo, and
  once actually invoked `sprint-runner.mjs`. That applies to `python3 -c` one-liners too; use a
  heredoc.
- `blaze commit` takes **no message flag** — stage explicit pathspecs and `git commit -m` directly.
  Run `blaze` commands **from the board directory**.
- `blaze log` before any terminal move (`requireWorklogBeforeTerminal`). Delivery is
  `defined → in-progress → in-review → done` and you cannot jump. **Reconcile is disabled** — move
  tickets by hand. A ticket can therefore sit in `in-review` for weeks unnoticed; BLZ-97's work
  shipped in `e6a505b` and its ticket was still open. **Check for an existing ticket before
  touching a surface** — and note that §3.1 is about making reconcile trustworthy enough to
  re-enable.
- **Move tickets with `blaze move`, re-parent with `blaze edit parent`**, never by editing
  frontmatter. **Features do not nest.**
- **A ticket's status comes from its DIRECTORY**, not a `status:` frontmatter field. A fixture
  writing `status: done` into `defined/` is a *defined* ticket — that mistake made three
  reproductions read as still-broken.
- **`gh pr merge --delete-branch` fails** when another worktree holds `main`; delete separately.
- **Use a worktree**, and symlink `node_modules` or ~108 tests fail on a missing `pg`:
  ```bash
  git worktree add -b <branch> /home/rnamwoh/Documents/Code/blaze-worktrees/<slug> origin/main
  ln -sfn /home/rnamwoh/Documents/Code/blaze/node_modules /home/rnamwoh/Documents/Code/blaze-worktrees/<slug>/node_modules
  ```
- **Set `model` explicitly on every subagent dispatch; never inherit:**

  | Job | Model |
  |---|---|
  | Read-only recon / codebase fan-out | `haiku` (`sonnet` across many files) |
  | Mechanical, already-designed implementation | `sonnet` |
  | Complex or subtle implementation | `opus` |
  | Judgement-heavy review, adversarial verify | `opus` |
  | Design / brainstorm / architecture decision | `fable`, `opus` fallback |

---

## 7. Verification before merge

```bash
cd /home/rnamwoh/Documents/Code/blaze-worktrees/<slug>
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
node scripts/ci/hygiene-check.mjs origin/main
docker rm -f blzpg 2>/dev/null
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55455:5432 --name blzpg postgres:17-alpine
until docker exec blzpg psql -U postgres -c 'SELECT 1' >/dev/null 2>&1; do :; done
rm -rf coverage
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55455/postgres npm run test:coverage
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55455/postgres npm test
node scripts/ci/mutate-schedule.mjs        # must print "All mutations killed" and exit 0
docker rm -f blzpg
```

**`test.yml` runs only `npm run test:coverage` (`--test-concurrency=1`).** `npm test` runs files
concurrently and catches things coverage does not. Run both. And run at least one decisive gate on
a **fresh** container — see §9.

---

## 8. The review bar — the instruction that earned its keep

**Every agent PR gets an adversarial review before merge, and the reviewer must try to make the
check FAIL, not confirm it passes.** Across twelve rounds on four PRs, reviewers found roughly
**seventy defects, and CI caught none of them.**

The pattern is not the one you would guess:

- **Every corpus measurement reproduced, every time.** Measurement discipline held.
- **In nearly every round, the previous round's FIXES introduced new defects.** Two fixes were
  worse than the bug they closed — one killed `blaze audit`, one made a pure model CWD-dependent.
- **The last three blocking findings were all corrections that stopped one line short**, or claims
  a commit made that the same commit falsified.

Practices, all cheap:

1. **Grep, don't reason, about blast radius.**
2. **Measure, don't transcribe** — and re-measure after your own correction.
3. **After any correction, grep the *unchanged* body for the claim's negation**, and re-read the
   lines either side of the one you changed.
4. **Prove every regression test discriminates by reverting the fix and watching it go red.**
5. **Do not guard a runtime property by scanning source text.** A grep guard was defeated in four
   consecutive rounds and was replaced by subprocess tests that run the real runners.
6. **A `doesNotMatch` on the output of a command that failed proves nothing.** Assert the exit
   status *and* a side effect, or the control is vacuous. Two of mine were.
7. **Say plainly when a mutation is equivalent.** Claiming a test kills something it cannot is
   worse than not having the test.

And keep in every implementation dispatch: *if a mutation does not break a test, say so plainly.*

---

## 9. The one lesson worth more than the rest

**A warm Postgres hides idempotency bugs, and CI is always cold.**

BLZ-377's config install was not idempotent. Every local run was green because the namespace
already existed from a previous run. CI provisions a fresh `postgres:17-alpine` on every run, so
**every CI run is the cold path** — it hung there for 59 minutes, could not be cancelled, and was
initially misdiagnosed as a wedged runner.

If you touch schema creation, seeds, or anything writing to `blaze_config`:

```bash
docker rm -f blzcold 2>/dev/null
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55456:5432 --name blzcold postgres:17-alpine
until docker exec blzcold psql -U postgres -c 'SELECT 1' >/dev/null 2>&1; do :; done
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55456/postgres \
  node --test --test-concurrency=1 tests/model/config-schema.test.mjs tests/model/driver-conformance.test.mjs
```

That pairing is the cheapest reproduction of the whole class.
