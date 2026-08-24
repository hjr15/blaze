# Blaze — next session kickoff (written 2026-08-25)

**If you are a session reading this, your task is §3 — start with BLZ-362, then BLZ-377, then
BLZ-392, in that order.** You need no further instruction to begin. Supersedes
`2026-08-25-blaze-next-session-kickoff.md`, whose lane (the scheduling kernel) is **complete and
merged** across PRs #113, #114, #115 and #116.

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
git fetch origin && git status --short && git log origin/main --oneline -5
```

Expect `main` at or after `c0eec71 BLZ-393: the storage layer's two measured gaps (#116)`.

```bash
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55443:5432 --name v4chk postgres:17-alpine
until docker exec v4chk pg_isready -q 2>/dev/null; do sleep 2; done
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55443/postgres npm run test:coverage
docker rm -f v4chk
```

Expected on `c0eec71`: **2,203 pass / 0 fail**, coverage **98.03 / 86.44 / 96.55 / 98.03** against
gates 91 / 77 / 93 / 91. **If the baseline does not reproduce, stop and say so** rather than
building on it.

Two things about that command. **Postgres needs ~10 seconds to accept connections and the harness
refuses a foreground `sleep`** — the `until` loop above is the way, or run the `docker run` and the
test as two separate tool calls. And **a stale Postgres is the single most likely false failure you
will hit**: the version floor is now 3, so a container left over from an older run holds a v2 schema
and nine driver-conformance tests fail with *"database schema version 2 is older than this engine
supports"*. That is the guard working. `docker rm -f` and start a fresh one.

Board, read-only:

```bash
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine
git status -sb && node /home/rnamwoh/Documents/Code/blaze/scripts/cli.mjs audit | tail -3
```

Expect `BLZ-305-v4-spine`, **112 or more commits unpushed — correct, do not push**, and `ok=true`.
The unpushed count only ever rises; a *lower* number means the CronJob flushed.

---

## 2. What landed, so you do not redo it

| Merged | Commit | Tickets closed |
|---|---|---|
| The CPM solve and its findings | `e3eacbf` (#113) | BLZ-379/380/381/382 |
| The date migration and dependency import | `a906648` (#114) | BLZ-384/385/386/387 |
| The kernel's open questions | `4af9f57` (#115) | BLZ-388/383/378/376/389 |
| The storage layer's two gaps | `c0eec71` (#116) | BLZ-393/391/390 |

**The scheduling kernel is done and it is live-able.** `scripts/model/schedule.mjs` computes a real
critical path; `blaze schedule migrate-dates` turns the board's 40 legacy dates into 28 frozen
actuals plus 12 constraints; `blaze schedule import-deps` proposes `Precedes` edges and never
guesses at a mutual pair.

**Three facts from that work that change what you can assume:**

- **`DB_SCHEMA_VERSION` and `MIN_DB_SCHEMA_VERSION` are both `3`.** Version 3 put `STRICT` on the
  seven `SQLITE_DDL` tables and on `blaze_meta`. **BLZ-377's own acceptance criteria say the view
  table "probably wants version 3" — that is stale. Version 3 is taken. It wants 4.**
- **The read seam projects all 28 frontmatter keys** on both drivers. It projected 15 before.
- **The zero-diff oracle checks 26 fields**, up from 12, and takes an explicit `unsurfaced` list
  (currently empty) for anything a driver cannot show.

---

## 3. The lane — three tickets, in this order

### 3.1 BLZ-362 first (bug, 45 min) — ADR-0014's four factual errors

Small, docs-only, zero code risk. Do it first for a clean start.

**Every claim in the ticket reproduces — I checked all four on 2026-08-25, so you do not have to
re-derive them, only re-confirm if you want:**

| ADR-0014 says | Truth |
|---|---|
| `board_config` is a singleton table | **It has never existed** — `grep -rn 'board_config' scripts/` → 0 |
| (omits `config_version`) | It is a real singleton at `config-schema.mjs:99` |
| "the two write-rules tables" | **One table counted twice** — `write-rules.mjs:69` and `:119` are the SQLite and Postgres dialects of `migration_mode` |
| "One installation is one board" | **`deriveBoards` returns 4** — `delivery` (folding `goal`), `requirement`, `architecture`, `risk` |

The four singletons that *do* exist: `blaze_config.board` (`config-schema.mjs:87`),
`blaze_config.config_version` (`:99`), `projection_meta` (`projection-schema.mjs:28`),
`migration_mode` (`write-rules.mjs:69`/`:119`).

To reproduce the fourth yourself — and note `deriveBoards()` with **no arguments returns 0**, which
is what a careless check reports:

```bash
cd /home/rnamwoh/Documents/Code/blaze && export PATH=/home/rnamwoh/.local/node24/bin:$PATH
node --input-type=module -e '
import { deriveBoards } from "./scripts/model/boards.mjs";
import { DEFAULT_TYPES } from "./scripts/model/schema.mjs";
import { WORKFLOWS } from "./scripts/model/workflows.mjs";
console.log(deriveBoards({ types: DEFAULT_TYPES, workflows: WORKFLOWS }).map(b => b.id));'
```

**The decision in ADR-0014 is sound and is NOT in question** — database-per-tenant, row-level ruled
out, no discriminator columns. What is wrong is the Context section's inventory and one sentence of
framing. Record an amendment note saying what changed and that the decision is unaltered; do not
silently rewrite an accepted ADR's history. The ticket's last AC also asks you to *consider* a check
that an ADR naming a table names one that exists — three of the four errors are mechanically
detectable. Decide it either way, but say which.

### 3.2 BLZ-377 (feature, 240 min) — install `blaze_config`, then `viewDdl`

The substantial one, and it unblocks spec 1's `view` table and therefore spec 4's report view.

`configDdl` is exported from `config-schema.mjs` and called **only from its own test**. `configSeed()`
is used by `db-runner.mjs`, but that is seed *data*, not the DDL. There is also an
`attachConfig`/`sqliteAttachConfig` helper with **no production caller**. So `blaze_config` is a
namespace nothing creates, and `view` cannot exist until it does — BLZ-371 established that `view`
must live there because its FKs to `project` and `view_type` cannot cross a SQLite database file.

**Schema version 4, not 3.** Version 3 shipped under BLZ-390. Adding tables to an already-shipped
version retroactively is a silent schema change, which is the thing the version exists to prevent.
Both constants move together; the shadow is derived and `blaze db init --force` rebuilds it, so
there is no upgrade to write — that is the precedent versions 2 and 3 both set.

**`db-schema-version.test.mjs` pins the current absence with a test that says it should invert when
this ticket lands.** Invert it, carrying the reason. Do not delete it.

**Two traps this codebase has already sprung on this exact surface, both of which cost a full
debugging round in the last session:**

- **`STRICT` is SQLite-only syntax.** Take it from `sql-dialect.mjs`'s `tbl` token, **never** by
  hand-writing `) STRICT;` into a dialect-shared DDL function. Doing that in `metaDdl` emitted it to
  Postgres, which refused the statement, so the meta table was never created and every Postgres path
  then failed with *"holds tables but no Blaze schema stamp"* — and it poisoned the test container,
  so the failures persisted after the fix until it was recreated.
- **In SQLite a qualified FK `REFERENCES blaze_config.project (key)` is a syntax error**, and the
  unqualified form resolves to a non-existent `main.project`. `CREATE INDEX` also takes the schema
  qualifier on the **index** name in SQLite and the **table** name in Postgres. Both are recorded in
  the merged kernel spec's §6.4 corrections.

### 3.3 BLZ-392 (feature, 120 min) — a custom delivery type cannot be made schedulable

Raised by adversarial review of BLZ-388 and recorded in **ADR-0022 §What the scheduler treats as a
node**, whose "one limitation" paragraph is written against this ticket.

`resolveSchema` merges `schema.types` and `schema.workflows` and has **no link-type branch at all**.
The solve's node rule reads `DEFAULT_LINK_TYPES`, a module constant. So an installation that adds
its own delivery type — `spike`, exactly the capability `tests/model/schema.test.mjs` pins — gets a
type that is not a `Precedes` endpoint, is therefore not a node, **and cannot be made one**.

Decide whether link-type endpoint kinds should be overridable (`schema.linkTypes`, merged the way
`types`/`workflows` already are) or whether a custom delivery type is deliberately unschedulable.
Whichever you choose, **update ADR-0022's limitation paragraph** — it is written on the assumption
this is open.

---

## 4. Blocked vs actionable — so a bare "continue" needs no questions back

| Ticket | State | Why |
|---|---|---|
| **BLZ-362** | **ACTIONABLE — start here** | Docs only. All four claims verified 2026-08-25. |
| **BLZ-377** | **ACTIONABLE** | Needs schema version **4**, not the 3 its AC names. |
| **BLZ-392** | **ACTIONABLE** | Decision + implementation; ADR-0022 already frames it. |
| BLZ-358 | actionable, not this lane | First-run setup. Operator decided the mechanism: a one-time token at `<board>/.blaze/setup-token`, mode `0600`, path logged but never the value. |
| BLZ-369 | actionable, not this lane | Operator decision 2026-08-24: **accept now, remove later**. Candidates named, neither designed. |
| BLZ-355 | **BLOCKED — needs the operator interactively** | Do not queue it for an agent session. |
| BLZ-324 | **BLOCKED** | Needs a week of dual-write soak. Elapsed time, not agent work. |
| BLZ-309 | **BLOCKED** | Cannot start until BLZ-254's db-primary cutover lands. |
| BLZ-305, BLZ-345 | containers | Parent goals; nothing to do directly. |

---

## 5. Out of scope

- **There are no parallel sessions and no sibling lanes to fence.** If that changes, fence them here
  by ticket key before starting.
- **Do not push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole merger.
  Work there ends at a local commit. 112 unpushed is correct.
- **Do not run `blaze schedule migrate-dates --write` against the live board.** The tool is built,
  tested and proven on a copy — 12 files, 23+/23−, zero `done/` files touched, `blaze audit` then
  reporting the predicted 11 `deadline-unreachable`. **The real write is the operator's to run.**
- **Do not touch the NCA project.** Parked by the operator on 2026-08-23.
- **Do not build the Gantt view.** Spec 3 specifies it; it is a separate lane.
- **Do not reopen** ADR-0001, ADR-0014's *ruling* (BLZ-362 corrects its Context, not its decision),
  ADR-0021, ADR-0022's decision, or either kernel decision.

---

## 6. Files in scope

- **BLZ-362** — `docs/decisions/0014-tenancy-is-deferred-and-row-level-is-ruled-out.md`, plus a
  sweep: `grep -rn 'one installation is one board' docs/`
- **BLZ-377** — `scripts/model/config-schema.mjs`, `view-schema.mjs`, `db-schema-version.mjs`,
  `sqlite-schema.mjs`, `pg-schema.mjs`, `scripts/db-runner.mjs`, and
  `tests/model/db-schema-version.test.mjs` (invert the pin)
- **BLZ-392** — `scripts/model/schema-config.mjs`, `link-schema.mjs`, `schedule.mjs`,
  `docs/decisions/0022-constraints-are-inputs-dates-are-derived.md`

---

## 7. Process

- One PR per ticket, three PRs, in the §3 order. Branch `KEY-n-slug`; every commit `KEY-n:
  description`; PR title `KEY-n: description`.
- **`hygiene.yml` rejects `Co-Authored-By` trailers** and runs only on `pull_request`. Omit the
  trailer, open a PR rather than pushing to `main`, and check first with
  `node scripts/ci/hygiene-check.mjs origin/main`.
- **Write commit bodies to a file and use `git commit -F`.** A body containing backticks was
  shell-expanded in an earlier session and actually invoked `sprint-runner.mjs`.
- `blaze commit` takes **no message flag** — stage explicit pathspecs and `git commit -m` directly.
  Run `blaze` commands **from the board directory**.
- `blaze log` before any terminal move (BLZ has `requireWorklogBeforeTerminal`). Delivery is
  `defined → in-progress → in-review → done` and you cannot jump. **Reconcile is disabled** — move
  tickets by hand.
- **Move tickets with `blaze move`, and re-parent with `blaze edit parent`, never by editing
  frontmatter directly.** Doing it by hand twice in the last session put three *features* under a
  feature — `blaze audit` went `ok=false` with 3 HARD `invalid-parent-type` findings, which
  `board-gate.yml` would have failed on. **Features do not nest.** The tool validates; a text editor
  does not.
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

## 8. Verification before merge

```bash
cd /home/rnamwoh/Documents/Code/blaze-worktrees/<slug>
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
node scripts/ci/hygiene-check.mjs origin/main
docker rm -f blzpg 2>/dev/null
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55443:5432 --name blzpg postgres:17-alpine
until docker exec blzpg pg_isready -q 2>/dev/null; do sleep 2; done
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55443/postgres npm run test:coverage
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55443/postgres npm test
node scripts/ci/mutate-schedule.mjs        # must print "All mutations killed" and exit 0
docker rm -f blzpg
```

**`test.yml` runs only `npm run test:coverage`, which is `--test-concurrency=1`.** `npm test` runs
files concurrently against one Postgres, and it catches things coverage does not — in the last
session it caught three architectural-guard violations that the coverage run passed. Run both.

---

## 9. The review bar — the instruction that earned its keep

**Every agent PR gets an adversarial review before merge, and the reviewer must try to make the
check FAIL, not confirm it passes.** Across four PRs in the last session, reviewers found **thirty
defects**, and CI caught none of them.

The pattern, which is not the one you would guess:

- **Every corpus measurement reproduced, every time.** Not one defect was a wrong number from the
  board. Measurement discipline held completely.
- **The defects were reasoning, sourcing, vacuous tests, and corrections that stopped short.**
- **Six defects were introduced by fixes for earlier defects.** One PR needed three review rounds
  because each fix pass contained a new defect — including one that shipped a **red oracle on the
  live corpus** while its own suite was green, and one where the fix for a vacuous test was itself
  vacuous.

Four practices that came out of it, all cheap:

1. **Grep, don't reason, about blast radius.** A rename breaks tests that never mention the thing
   renamed.
2. **Measure, don't transcribe** — and re-measure after your own correction. A figure that was true
   when written went stale three tickets later, in the same session.
3. **After any correction, grep the *unchanged* body for the claim's negation.** This caught the
   author four separate times on their own corrections.
4. **Prove every regression test discriminates by reverting the fix and watching it go red.** Three
   separate tests passed against the pre-fix tree and therefore covered nothing. A green suite is
   not evidence; a suite that goes red without the fix is.

And keep in every implementation dispatch: *if a mutation does not break a test, say so plainly.*

---

## 10. What the last session did

Closed **sixteen tickets** across four PRs: the CPM solve, the migration that makes it live, the
kernel's four open questions, and the storage layer's two measured gaps. Opened five tickets with
their evidence and left three of them for this lane.

Two spec defects were found by running the code rather than reading it: **§4.1's expected-delta list
of "those 40 ids" is really 12** — the other 28 are frozen actuals whose bytes do not change, so
listing them would excuse the one accident §4 exists to prevent — and **§5.5's "124 mutual pairs"
and the tool's 102 are both right for different populations**, raw graph versus post-default-deny.

The most useful single finding for whoever picks this up: **a green test suite proved nothing three
separate times.** Every fixture supplied the value whose absence was the bug. Check your fixtures
against the live corpus before trusting a pass.
