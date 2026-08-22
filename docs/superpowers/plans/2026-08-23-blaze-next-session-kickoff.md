# Blaze — next session kickoff (2026-08-23)

**If you are a session reading this, your task is:** run the BLZ-346 grill + brainstorm to
turn the BYO-LLM-key requirement into a spec, and clear the three small operator items in
§1. Do **not** write feature code this session.

Written 2026-08-22 at the end of the session that merged the v4 spine. Every command is
literal and pasteable.

---

## 0. First five minutes — verify, don't trust

This document asserts repo state. Re-verify before building; it may be stale.

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH   # Node 20 lacks node:sqlite — mandatory
cd /home/rnamwoh/Documents/Code/blaze
git fetch origin && git status --short && git log origin/main --oneline -3
```

Expect `main` clean, and `fe4a3c3 docs: brief — the spine is merged` at or near the tip.

Baseline the suite once before touching anything:

```bash
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55443:5432 --name v4chk postgres:17-alpine
sleep 5
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55443/postgres npm run test:coverage
docker rm -f v4chk
```

Expect **1,753 tests, 1,753 pass, 0 fail, 0 skipped**, coverage 97.40 / 85.49 / 95.55 / 97.40
against gates of 91 / 77 / 93 / 91. If that does not reproduce, stop and say so — everything
below assumes it.

Board:

```bash
git status --short && git log --oneline -3
```

Expect clean, on `BLZ-305-v4-spine`, ~20 commits unpushed. **That is correct — do not push it.**

---

## 1. Blocked vs actionable

| Item | State | Who |
|---|---|---|
| BLZ-346 — grill the BYO-key requirement into a spec | **ACTIONABLE — this session's main job** | agent + operator |
| Re-date commit `fe4a3c3` to 22 Aug | **BLOCKED — needs operator** (§1a) | operator |
| `OBA-869` off-taxonomy labels | **BLOCKED — needs operator decision** (§1b) | operator |
| Which of specs 2–6 to start | **BLOCKED — needs operator choice** (§1c) | operator |
| BLZ-324 — v3→v4 migration | **BLOCKED — needs a week of soak** (§1d) | operator |
| Specs 2–6 build work | Unblocked by the merge, but gated on §1c | after choice |

### 1a. Re-date `fe4a3c3` — operator action, one command

One commit crossed midnight and is dated 2026-08-23 00:00 AEST; every other commit and
PR #88 itself are already 22 Aug. Rewriting a pushed commit on `main` was blocked by the
auto-mode classifier, correctly — it force-pushes history. Run it yourself:

```bash
cd /home/rnamwoh/Documents/Code/blaze
GIT_COMMITTER_DATE="2026-08-22T23:59:00+10:00" \
  git commit --amend --no-edit --date="2026-08-22T23:59:00+10:00"
git push --force-with-lease origin main
```

Safe: it is the tip commit, docs-only, nothing is built on top, and no other session shares
the branch. Verify with
`git log -1 --format='%ad' --date=format-local:'%Y-%m-%d'` → `2026-08-22`.

**Nothing else from this session needs re-dating.** PR #88 was created 23:55 and merged
23:57 AEST on the 22nd.

### 1b. `OBA-869` — operator decision

`blaze audit` reports `ok=false` on 3 hard findings, all one ticket, all pre-existing since
`040db61f` (2026-08-17) and unrelated to Blaze:

```bash
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine
grep -n '^labels:' projects/OBA/*/OBA-869-*.md
```

Labels `ops`, `backup`, `verification` are not in OBA's declared taxonomy. Two fixes, and
it is a call about OBA's label vocabulary, not board hygiene an agent should make:

- **Extend the taxonomy** — add the three to `labels` in `projects/OBA/project.json`.
- **Strip them** — `blaze edit OBA-869 labels <comma,separated,keepers>`.

### 1c. Specs 2–6 — operator choice

All five were parked until the spine merged. It has. They are, from the v4 programme index:
agile execution; Gantt / critical path; hierarchy reporting and Excel export; diagrams;
configuration UI. **Ask which one**, then start it with `superpowers:brainstorming` — do not
pick one unprompted.

### 1d. BLZ-324 — the only outstanding spine ticket

Blocked on the db-primary Phase 2 cutover, which is earned by the dual-write soak:

```bash
export BLAZE_WRITE_PORT=dual    # then use the board normally for a week
# divergences land in .blaze/divergences.jsonl — the target is zero across real use
```

**Operator's to run — it needs elapsed time on the live board, not agent work.** Its
acceptance test is already specified: a zero-diff oracle against the existing derived
matrices (`python3 scripts/build_matrices.py --check` in `blaze-pm`). That method caught six
data-loss defects in already-merged v3 code. Do not substitute a weaker check.

---

## 2. The main job — BLZ-346

**Goal:** turn the operator's BYO-LLM-key requirement into a spec a plan can be written from.
**Design only. Write no feature code.**

Read these two tickets first — they carry the operator's verbatim words and the question
list, and this document does not repeat them:

```bash
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine
cat projects/BLZ/defined/BLZ-345-*.md    # the goal, and why it is a goal
cat projects/BLZ/defined/BLZ-346-*.md    # the seven questions, ordered
```

Then read the prior art **before** the session, not during:

| File | Why |
|---|---|
| `scripts/loops/groomer.mjs` | already spawns `agentCommand` (`claude -p`) per ticket — the existing answer to "dispatch a ticket to an LLM" |
| `scripts/model/identity.mjs` | roles, scopes, tokens; note it HASHES and never stores plaintext |
| `scripts/model/serve-auth.mjs` | the bind-address security boundary, and fail-closed route classification |
| `docs/guide/driving-with-an-ai-agent.md` | the contract an agent already has with the board |
| `docs/decisions/0013-*.md` | identity |
| `docs/decisions/0014-*.md` | tenancy deferred, row-level shared-schema ruled out |

**Settle questions 1 and 2 first** (what "work on it" means; where the agent runs). Everything
else follows, and they are what decide whether this is a feature or a different product.

**The hard constraint, stated once:** a usable LLM API key must stay decryptable, which is a
different secret class from anything Blaze holds today. It must never touch the git repo of
markdown. The operator's own standing rule is that a secret pasted into chat is considered
exposed and forces rotation — so the design must make the paste-path the only path, and the
session must never ask for a key.

Use `superpowers:brainstorming`. The operator explicitly offered to hash this out
interactively, including the interface half — ask, don't assume.

---

## 3. Out of scope

- **Do not push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole
  merger. Work there ends at a local commit. ~20 commits are waiting; that is correct.
- **Do not start specs 2–6** until §1c is answered.
- **Do not run the dual-write soak** on the operator's behalf.
- **Do not build anything** under BLZ-345/346 this session — they are design tickets.
- **Do not reopen tenancy.** ADR-0014 defers it deliberately. Per-user keys on one board are
  compatible; per-tenant anything is not, and must not arrive through this door.

There are **no parallel sessions** and no sibling lanes to fence.

---

## 4. Process

Standard bar, plus two things this repo enforces that will bite:

- **`hygiene.yml` rejects `Co-Authored-By` trailers** and runs only on `pull_request`. The
  global instruction to add one is overridden inside this repo — the operator decided this on
  2026-08-22. Omit it, and **open a PR rather than merging to `main` directly**, so the gate
  actually runs. Check locally first: `node scripts/ci/hygiene-check.mjs origin/main`.
- **One ticket per commit subject.** `idFromSubject` anchors on `^KEY-n:`, so a bundled
  subject like `BLZ-335/336/337:` matches nothing and reconcile attributes the work to no
  ticket. That happened this session; don't repeat it.
- Branch `KEY-n-slug`; commit `KEY-n: description`; PR title `KEY-n: description`;
  `blaze log` before any terminal move (BLZ has `requireWorklogBeforeTerminal`).
- Delivery workflow is `defined → in-progress → in-review → done` — you cannot jump.

**Model routing when dispatching subagents — set `model` explicitly, never inherit:**

| Job | Model |
|---|---|
| Read-only recon / codebase fan-out | `haiku` (low effort; `sonnet` if it must reason across many files) |
| Mechanical, already-designed implementation | `sonnet` |
| Complex or subtle implementation | `opus` |
| Judgement-heavy review, adversarial verify | `opus` |
| Design / brainstorm / architecture decision | `fable`, with `opus` as fallback |

---

## 5. What the last session did, in one paragraph

Built and merged the whole v4 spine: every requirement in the design spec now has code except
§6 (migration). Two independent pre-merge reviewers found **seven correctness defects and
nine behaviour-removing mutations the 1,695-test suite accepted silently** — all fixed, plus
six further defects reproduced, deferred, and then shipped as PR #88. 37 of 40 v4 tickets are
done. **51 execution rulings** are in
`docs/superpowers/plans/2026-08-22-blaze-v4-spine-execution-ledger.md`, including several that
reverse earlier decisions. **Read it before "fixing" anything that looks wrong** — it is
probably a recorded decision with a reason.

The one lesson worth carrying: the reviews kept finding the same shape — **a test whose
assertion does not vary with the thing under test.** It fired twelve times. Keep the
instruction *"if a mutation does not break a test, say so plainly"* in every dispatch.

## 6. Open question the last session deliberately did NOT settle

With BLZ-339, `verified` became a declared requirement status, but `implemented` stayed
terminal — so **a goal can still be achieved carrying requirements that were never verified.**
That may be wrong. It is a decision about what the method requires, not about what the defect
was, and settling it silently inside a bug fix would have been the wrong move. Ruling R48 in
the ledger. Raise it with the operator when the method is next in scope.
