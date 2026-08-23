# Blaze — next session kickoff (written 2026-08-23)

**If you are a session reading this, your task is:** work the sequence in §2, in order. It was
chosen by the operator on 2026-08-23. Do not reorder it without asking.

Supersedes `2026-08-23-blaze-next-session-kickoff.md`, whose three §1 operator items are all
cleared and whose main job (BLZ-346) is Done.

---

## 0. First five minutes — verify, don't trust

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH   # Node 20 lacks node:sqlite — mandatory
cd /home/rnamwoh/Documents/Code/blaze
git fetch origin && git status --short && git log origin/main --oneline -3
```

Baseline before touching anything:

```bash
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55443:5432 --name v4chk postgres:17-alpine
sleep 5
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55443/postgres npm run test:coverage
docker rm -f v4chk
```

Last verified 2026-08-23: **1,753 tests, 1,753 pass, 0 fail, 0 skipped**; coverage
97.40 / 85.49 / **96.24** / 97.40 against gates of 91 / 77 / 93 / 91. (The previous kickoff
said 95.55 for functions; the real figure is 96.24.)

Board:

```bash
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine
git status --short && git log --oneline -3
```

Expect clean, on `BLZ-305-v4-spine`, ~32 commits unpushed. **That is correct — do not push it.**
The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole merger.

---

## 1. Operator action that blocks the first item

**`claude` is a dangling symlink** — `/home/rnamwoh/.local/bin/claude` points at snap revision
`254`, which no longer exists; `which claude` returns nothing.

```bash
ls -l /home/rnamwoh/.local/bin/claude          # confirm it is still dangling
ls /home/rnamwoh/snap/code/                    # find the current revision
```

Repoint it, or use whatever `claude` binary is current. **BLZ-349 cannot run until this is
fixed**, and BLZ-349 gates the entire BLZ-345 lane.

---

## 2. The sequence — operator's choice, 2026-08-23

### Phase 1 — BLZ-349, the capability probe (~1 hour)

**Do this first. It can invalidate the BLZ-346 spec, and it costs an hour to find out.**

The spec asserts Blaze delegates the runtime to `claude -p`. The adversarial review refuted the
premise: in `-p` the starting permission mode is `default`, where only reads run without asking.
`Edit`, `Write`, `git commit`, `git push` and `gh pr create` all require approval, and
`cfg.agentCommand.split(" ")` (`groomer.mjs:207`) cannot express
`--allowedTools "Bash(git commit *)"` at all.

Run it exactly as BLZ-349 specifies: one ticket, one scratch clone, explicit `--allowedTools`.
Record six binaries — exit 0 / wrote a file / committed / pushed / opened a PR / which flags had
to be discovered. **Set no success rate**; §7.2 of the spec explains why a 20-ticket/40% bar was
refuted.

**If a PR is only reachable via a permissions bypass: STOP.** Q1 reopens, and BLZ-345 scopes
down to advisory output. That is a legitimate outcome. BLZ-352 and BLZ-355 are then rescoped or
resolved `wont-do`.

**BLZ-347 must land before the probe if it runs on a board where `blaze.config.json` is writable
in the agent's cwd** — the escalation loop that ticket describes is exactly what such an
experiment triggers.

### Phase 2 — burn down the five defect tickets

All independent of BLZ-345 and shippable now. Suggested order — security first, then the gate
that would have caught the others:

| Ticket | Why |
|---|---|
| **BLZ-347** | Groomer containment gap, missing timeout, missing `maxBuffer`, event-loop blocking. Also decide whether the shipped `enabled: true` default flips |
| **BLZ-348** | Identity built and imported by nothing. Hard prerequisite for any HTTP dispatch route, independently overdue |
| **BLZ-353** | R48 — `verified` becomes required for a goal to be terminal. **Measured: 83 requirements sit at `implemented` and 0 have a terminal ancestor**, so there is no retroactive migration. Cheapest moment to do it |
| **BLZ-350** | `in-review` silently unreachable off GitHub; the `provider` seam `design.md:49-50` promises was deleted |
| **BLZ-351** | No CI against the board repo. This is the gate that would have caught the `provider` breakage |

### Phase 3 — specs 2–4

**Two kernel questions must be settled BEFORE a word of any of the three specs is written.**
Both were established on 2026-08-23 and neither is optional:

1. **BLZ-354 — a project owns multiple named boards (views).** Operator decision. Specs 2, 3 and
   4 *are* views, so specifying them against the current installation-singleton model and then
   adopting this means respecifying all three.
2. **Are `start_date` / `due_date` inputs or derived outputs?** They are hand-set inputs today
   (`gantt.mjs:67-73`); critical path makes them derived. That one choice decides spec 3's
   scheduler, spec 2's sprint capacity and spec 4's date roll-up.

Then the revised order — **not** agile-first:

**settle the kernel → spec 3 (Gantt / critical path) → spec 2 (agile execution) → spec 4
(hierarchy reporting + Excel).**

Spec 4 last because it is the schema-installation event. **Not one v4 table currently ships** —
`createDbSchema` installs only `PG_DDL`/`SQLITE_DDL` (`db-schema-version.mjs:151`), which contain
only the v3 ticket tables. `artifact`, `link`, `hierarchy`, `baseline` and `field_definition` are
DDL functions exercised by tests only; `hierarchyDdl` has no production caller.

Also live and unreconciled: **two roll-up implementations that disagree** —
`rollup.mjs:10` (over `ticket.parent`) and `hierarchy-rollup.mjs:10` (over
`hierarchy_membership`, deduping by default). Two parent models, two dedup policies.

---

## 3. Out of scope

- **Do not push `blaze-pm`.** Work there ends at a local commit.
- **Do not build under BLZ-345** until BLZ-349 reports.
- **Do not grill BLZ-355** (the Q6 interface half) until BLZ-349 reports — operator's explicit
  decision, on the grounds that a reopened Q1 makes it a different design.
- **Do not start specs 2–4** until BLZ-354 and the date-kernel question are settled.
- **Do not reopen tenancy.** BLZ-354 changes the *word* "board"; ADR-0014's ruling
  (database-per-tenant, row-level permanently ruled out) is untouched and must stay untouched.
- **Do not run the BLZ-324 dual-write soak** on the operator's behalf — it needs elapsed time on
  the live board, not agent work.

---

## 4. Process

Standard bar, plus what this repo enforces:

- **`hygiene.yml` rejects `Co-Authored-By` trailers** and runs only on `pull_request`. Omit the
  trailer, and open a PR rather than merging to `main` directly. Check first with
  `node scripts/ci/hygiene-check.mjs origin/main`.
- **One ticket per commit subject.** `idFromSubject` anchors on `^KEY-n:`.
- Branch `KEY-n-slug`; commit `KEY-n: description`; PR title `KEY-n: description`; `blaze log`
  before any terminal move (BLZ has `requireWorklogBeforeTerminal`).
- Workflow is `defined → in-progress → in-review → done` — you cannot jump.
- `blaze reconcile` is **disabled** on this board and currently **fails** on the main blaze-pm
  checkout (the `provider` key; fix is in the unpushed v4-spine commits). Move tickets by hand
  until BLZ-351 lands.

**Model routing when dispatching subagents — set `model` explicitly, never inherit:**

| Job | Model |
|---|---|
| Read-only recon | `haiku` (`sonnet` if it must reason across many files) |
| Mechanical, already-designed implementation | `sonnet` |
| Complex or subtle implementation | `opus` |
| Judgement-heavy review, adversarial verify | `opus` |
| Design / brainstorm / architecture | `fable`, `opus` fallback |

**Keep this instruction in every implementation dispatch:** *if a mutation does not break a
test, say so plainly.* The v4 spine reviews found nine behaviour-removing mutations a
1,695-test suite accepted silently, and that same shape fired twelve times.

---

## 5. What the last session did

Ran the BLZ-346 grill: a five-lane expert panel answered a shared brief, then an adversarial
reviewer refuted four of the panel's nine consensus points. Q1 and Q2 settled; **Q2's answer
collapsed Q3, Q4 and Q5** — because the agent runs on the user's machine or their runner, Blaze
holds no LLM key, so BLZ-345's self-declared hardest constraint dissolved and `design.md:47-48`
is upheld rather than reversed.

Spec: `docs/superpowers/specs/2026-08-23-agent-driven-execution-design.md`.
Panel record, including every refutation: `docs/superpowers/plans/2026-08-23-blz-346-q2-panel-findings.md`.
**Read the findings document before disputing anything in the spec** — the reasoning that
survived is not the reasoning the panel started with.

Six of the eight tickets raised came from defects found while researching the design, not from
the design itself. The most useful single finding for future work: **the operator's server-side
instinct was not defeated on principle.** The custody argument the panel led with proves too
much — it would rule out every CI provider in existence. What actually rules out server-side
execution is the per-customer build matrix, and build matrices have answers.
