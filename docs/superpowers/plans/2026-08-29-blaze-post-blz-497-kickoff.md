# blaze — next-session kickoff (2026-08-29)

Successor to `2026-08-28-blaze-followup-lane-successor.md`, which is now **fully discharged**.

**Not to be confused with `2026-08-29-blaze-next-session-kickoff.md`**, a different document
written the same day for a different lane (BLZ-130/131, BLZ-358, BLZ-56 — three PRs to review and
merge). That one is still live and unrelated to this. This file was briefly written over it by
mistake and is now at its own path; the original is intact.
**This document is the work order.** It is self-contained and authoritative: where it
contradicts a chat instruction, follow this.

`main` is at **`69776b4`**. Suite **4,174 pass / 0 fail** (347 suites), hygiene clean, coverage
~98.7 / 88.0 / 97.4. **Zero open PRs. Zero worktrees.** Board audit `ok=true` over 2,736 tickets.

---

## 1. What happened, in one paragraph

The BLZ-408..439 successor lane closed all 32 of its tickets and, in doing so, generated 58 more
by review. Those were worked too. **12 PRs merged (#141–#152), 73 tickets closed**, the suite grew
from 3,811 to 4,174, and the theme that emerged is worth naming because it is what the remaining
work is about:

> **A run that could not look must not report what a run that looked and found nothing reports.**

That sentence now has an ADR (0030), a production fix (`sh()` no longer launders a git spawn
failure), and a track record of catching itself: the same defect was found in a CI guard I wrote,
in an oracle's own header, in a method doc, and in the operator-facing sentence of the branch whose
subject it was.

## 2. State of the board

**10 tickets open, 345 minutes estimated.** Everything else under BLZ-408..497 is `done`.

| Ticket | Pri | Est | What |
|---|---|---|---|
| **BLZ-493** | **high** | 50 | **Four pre-existing `readFileSync` sites block forever on a FIFO** — plus a sixth that is server-reachable |
| BLZ-432 | medium | 120 | reconcile does not notice a ticket tree left uncommitted by an earlier pass (**the design question**) |
| BLZ-492 | medium | 40 | `inspect()` strips `origin/`, so a remote-only branch corroborates nothing |
| BLZ-495 | medium | 25 | an unreadable out-of-scope directory is a second BLZ-394 exception no test constructs |
| BLZ-490 | medium | 25 | `discardSandbox` refuses ancestors but not descendants; `rmSync` follows a symlink to its target |
| BLZ-494 | medium | 20 | two reconcile guards survive mutation |
| BLZ-489 | medium | 15 | `reconcile.mjs`'s write-path comment enumerates two paths where ADR-0026 documents three |
| BLZ-491 | low | 20 | board-overstatement guards leak `/tmp/blz-guards-board-*` |
| BLZ-496 | low | 15 | the finding-kind roster extractor misses inline declarations |
| BLZ-497 | low | 15 | `classifyGitEntry`'s `git-file-unreadable` is reachable but untested |

**The board is 30 commits unpushed on `BLZ-305-v4-spine` and that is correct** — see §5.

## 3. Lanes, in order

### Lane A — BLZ-493, its own PR: the read path may never block (50 min, **high**)

Five `readFileSync` sites open a path without checking `st.isFile()`, so a FIFO blocks them
forever — no error, no timeout, no exit — on the path `blaze audit`, `buildIndex`, id resolution,
the board view and `reconcile` all share.

| Site | Reached from | Status |
|---|---|---|
| `scripts/model/index.mjs:238` | `walkTickets`'s `.md` read | reproduced |
| `scripts/audit-runner.mjs:121` | `project.json` | reproduced |
| `scripts/views/data.mjs:124` | `liveModel` → `serve.mjs:516` — **the running server**, exit 137 | reproduced |
| `scripts/model/claims.mjs:70`, `scripts/model/sprints.mjs:44` | `buildIndex` / `reindex` | same shape |
| `views/panel-content.mjs:84`, `model/transitions.mjs:80`, `config.mjs:169` | flagged, **not** independently reproduced | verify first |

**This is not a one-line fix, and that is why it was deferred.** Making them skip silently would
reintroduce exactly the drop BLZ-470 exists to close, so **each needs a decision about what it
reports**. `config.mjs:169` is guarded only by `existsSync` — which a FIFO satisfies — on nearly
every entry point.

**Any test for this shape must run in a CHILD PROCESS with a hard wall-clock limit.** `node:test`'s
`timeout` is an event-loop timer and a synchronous `readFileSync` never yields to it: a
`{timeout: 2000}` test had to be SIGTERMed externally, and a mutant wedged the mutation runner for
its full 300 s cap. Verified across six variants. `tests/walk-unreadable-dirs.test.mjs` has the
working harness — copy it.

### Lane B — BLZ-432, its own PR: the uncommitted-tree monitor (120 min, `type: story`)

**A design question, not a fix**, and the largest single item. `reconcile` files only the current
pass's decisions; leftover uncommitted ticket writes from an earlier pass are invisible to it.

**Three designs were tried and rejected. Do not re-propose 1 or 2.**
1. A `dirtyTicketPaths` recovery sweep — swept a human's `NOTES.md` and another project's files
   into a reconcile commit (violating BLZ-394's blast radius) and reintroduced a porcelain path
   parser BLZ-347 deliberately deleted.
2. A detect-and-report boolean — conflated a failed prior commit, a batch-queued-by-design state,
   and a human's own in-flight file; under-fired when `projects/` was a symlink.
3. A cross-pass detector — deleted entirely; only the over-claiming "already in sync" wording was
   corrected, which is why BLZ-433 existed.

Whatever is chosen **must distinguish the three states in design 2** and must not widen the commit's
blast radius. "reconcile should not detect this at all" is a legitimate outcome — but then say what
the operator does instead, and make the product stop implying otherwise.

**Measure first, read-only:** how often does the live board actually carry leftover uncommitted
ticket writes? A monitor for a condition that never occurs is a different proposal from one for a
weekly occurrence. Record the decision in an ADR (next free is **0031**).

### Lane C — BLZ-492 + BLZ-495 + BLZ-489 + BLZ-494, ONE PR: reconcile's remaining honesty gaps (100 min)

All four touch `scripts/reconcile.mjs` or its tests, so they cannot be split across lanes.

- **BLZ-492** — `inspect()` asks about branches by a name with `origin/` **already stripped**, so a
  remote-only branch is queried by a name no local ref answers to: **52 occurrences each** on two
  probes across the reconcile suite, after which `buildBranchMap` reads `own: []` and silently
  declines to corroborate. Reconcile's own bug, not the environment's. **Fixing the ref name changes
  which branches corroborate — measure that before shipping it** (BLZ-353's rule), and re-derive the
  52 afterwards. Note `exitIsAnAnswer: true` at those sites is load-bearing: without it every board
  with remote-only branches exits 1 on all 52.
  **Corrected 2026-08-30 (BLZ-505): 52 is not reproducible — it counted a live GitHub repository's
  branch list. It is 21 and 20 at `be4b110` with the fixtures hermetic; see ADR-0030's correction.**
- **BLZ-495** — a scoped run naming an unreadable out-of-scope directory, and `blaze audit --projects
  INF` returning `ok=false` on it. **The behaviour is right** (a misfiled INF ticket could be under
  that directory; audit filters on id prefix, not directory) — it is a second deliberate BLZ-394
  exception that nothing excepts and no test constructs.
- **BLZ-489** and **BLZ-494** — a comment enumerating two write paths where ADR-0026 documents
  three, and two guards that survive mutation (the failed-`--fetch` warning severity, and
  `model/index.mjs`'s status-directory unreadable route). The fetch severity is load-bearing:
  `fetch --prune` exits 128 four times in the suite today, so flipping it to `error` makes those
  runs exit 1.
  **Corrected 2026-08-30 (BLZ-505): it is SIX of eleven runs, not four. Four of the six were a
  live GitHub URL in a fixture, so the figure was network-dependent as well as stale; re-take
  it with the command in the git-probe census header in `scripts/reconcile.mjs`.**

### Lane D — BLZ-490 + BLZ-491 + BLZ-496 + BLZ-497, ONE PR: the residue (75 min)

Disjoint from Lane C. `discardSandbox`'s descendant gap and symlink-target deletion; the
`/tmp/blz-guards-board-*` leak (300+ present, and it makes a real leak indistinguishable from
noise — which matters now that the mutation runner asserts **0** leftover `/tmp/blz-mutate-*` as
evidence); the roster extractor; the untested `git-file-unreadable` shape.

**Lanes C and D can run concurrently. Lane A can run alongside either.** Lane B must own
`reconcile.mjs` alone, so it runs after Lane C.

## 4. How to work — this is what produced the results above

**Every PR gets an adversarial review before merge, scoped to PRODUCT BEHAVIOUR** — correctness,
vacuous tests, the board overstating, the pre-auth surface. Record wording, figures and
test-machinery findings in the PR body and **ticket them; do not fix-and-re-review**. Of 12 PRs, 5
were REFUTED on the first round, and every refutation was a real defect that would otherwise have
shipped.

**The rule that keeps earning its keep:** *revert the production hunk the test claims to pin, and
watch THAT NAMED test go red for the reason its name gives.* A test that stays green under that
revert is not evidence, whatever it is called. **This caught a catastrophic bug returning silently
in my own fix**: `discardSandbox`'s guard was correct but unpinned, and reinstating the defect left
all ten tests green.

**When a change makes the product ASSERT something, test it against ground truth over a GENERATED
CROSS-PRODUCT**, take ground truth from somewhere the subject cannot reach (filesystem, `git log`,
the fixture's own declaration), **assert the oracle's own size**, and **bind the clause counter to
the assertion** so a deleted clause takes its count with it. Note the binding is one-directional —
it catches a deleted clause, not an added bare `assert.`.

**State reachability plainly.** A guard no current call path can reach cannot be killed by any
mutation, and must be described that way rather than implied to be pinned.

**Measure before any severity or behaviour change** (BLZ-353), and **pin every figure to a SHA**
(ADR-0024) — three different ticket counts were quoted from the same moving branch before that rule
was applied.

**Do not quote `mutate-schedule.mjs` as evidence for anything outside `schedule.mjs`/`audit.mjs`.**
`docs/ci.md` says so and BLZ-441 is why.

Standing rules: `blaze` skill for every tracked item (ticket at create with parent and estimate;
branch `KEY-n-slug`; commits and PR title `KEY-n: description`; `blaze log` before a terminal move —
bare number, not `90m`). One commit per body of work. Docs update in the same effort.

## 5. Constraints — non-negotiable

- **Do NOT push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole merger.
  Work there ends at a **local commit**. **30 unpushed is correct.**
- **The board's working branch is `BLZ-305-v4-spine`**, in the worktree
  `/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine` — not `main`, and not the
  `blaze-pm` checkout itself, which sits on a stale `BLZ-143-…` branch with uncommitted deletions.
  A tree on the wrong branch shows every BLZ-4xx ticket as missing.
- **Do NOT run `blaze schedule migrate-dates --write`** against the live board.
- **Do NOT touch the NCA project** (parked by the operator 2026-08-23).
- **Do NOT "fix" `provider`** in `blaze-pm/blaze.config.json` — it self-resolves at the flush.
  Seven blaze-pm-family checkouts carry it and are refused by `loadConfig` today; that is known.
- **Do NOT reopen** ADR-0001, ADR-0014's ruling, ADR-0021, ADR-0022's decision, ADR-0023,
  ADR-0024, **ADR-0025** (a project key is refused, never normalised), **ADR-0026** (a PR title
  claims with a colon or an em-dash and nothing else), **ADR-0027**, **ADR-0028** (shipped
  documents link out by URL), **ADR-0029**, or **ADR-0030**. Build ON them.
- The setup token's **PATH** may be logged; its **VALUE** never is, anywhere, ever.
- Never accept a secret pasted into chat; never base64-decode a Kubernetes secret value.
- One agent per worktree. **Never let a reviewer and a fix agent share one.** Every concurrent agent
  gets its own Postgres container and port.
- **Never `git stash`** — it is repo-wide and shared across worktrees.

## 6. Environment

- Node 24 is **not** on the default PATH: `export PATH=/home/rnamwoh/.local/node24/bin:$PATH`.
  Omitting it makes every test file fail to load, which a naive runner scores as success.
- Postgres containers are `blzpg-<port>`, password **`x`**:
  `docker run --rm -d -e POSTGRES_PASSWORD=x -p <port>:5432 --name blzpg-<port> postgres:17-alpine`
  then **block until `docker exec blzpg-<port> pg_isready -U postgres` succeeds** before exporting
  `BLAZE_TEST_PG_URL`. `pg_isready` is **not** on the host PATH. A red suite whose total test count
  is unchanged is the signature of an unreachable Postgres — it has cost time twice.
- **CI checkouts are shallow, single-branch and detached.** A guard that resolves a git ref locally
  will pass on every developer machine and fail in CI. A checkout can only prove a ref *absent* if
  its ref set is complete — key on `--is-shallow-repository`.
- Gate before every push: full suite, `node scripts/ci/hygiene-check.mjs origin/main`,
  `npm run test:coverage`. `hygiene-check.mjs` fails on `Co-Authored-By:` trailers and on absolute
  `/home/...` paths in added non-Markdown lines.
- **When merging, assert on the check RESULT, not the absence of `pending`.** I merged #149 over a
  failing check with `until ! gh pr checks | grep -q pending` and `main` was red for ~20 minutes.
- Squash subjects must be a real claim: `KEY-a + KEY-b: desc` works; **`KEY-n + N more: desc` now
  works too** (BLZ-469 reads the squash body's `* KEY-m:` bullets as a manifest), but a RANGE
  (`KEY-408..439`) claims nothing, by design.

## 7. Definition of done

All 10 tickets `done`; the decisions in Lane B (and any in Lane A) recorded in an ADR, not only in
chat; `main` green on the full gate; and a successor kickoff written if anything is left.

**Do not narrow the lane on your own.** If you run out of room, leave the next lane untouched and
say which one it is.

**Expect the count to grow.** Every review round in the last session produced roughly as many
tickets as it closed. That is the process working, not failing — but it means "finished" is a
judgement about the remaining tickets' severity, not about reaching zero.
