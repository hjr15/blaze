# blaze — phases 4–5 brainstorm kickoff (2026-09-22)

Successor to `docs/superpowers/plans/2026-09-17-blaze-phases-2-to-5-kickoff.md`, which is spent:
its Definition of Done (§1) is met — phases 2 and 3, plus the test-machinery lane, are merged and
board-verified (see `docs/superpowers/status/2026-09-17-backlog-burndown-status.md`, the close-out
record). This file is the whole brief for what's next. Paste it as message 1 of a new session.

**This is a brainstorm-first kickoff, not an implementation kickoff.** Phases 4 and 5 are real, sized
work — BLZ-254 alone is a 3600-minute estimate — and the prior kickoff's own words apply: "3600
minutes is a body of work, not a lane." Do not dispatch parallel implementation lanes from this
brief. The deliverable of this session is a written design/plan, produced via the
`superpowers:brainstorming` skill, not merged code.

---

## 0. Continuity contract — read first

If you are a session reading this, your task is: run `superpowers:brainstorming` on phases 4 and 5,
converge on a design, and write it down (per `superpowers:writing-plans`) — not touch implementation
code. No question goes back to the operator that this file answers. The only questions worth asking
are genuine gaps or contradictions found *after* reading this file in full and *after* re-verifying
§2 against the live repo.

**Blocked vs actionable:**

| Blocked on the operator | Actionable by you |
|---|---|
| Pushing blaze-pm — **never**, under any circumstance | Reading BLZ-254, its blockers, and the write-seam audit doc |
| Any decision that commits real implementation time before a plan exists | Running the brainstorming skill and writing the resulting design/plan |
| Whether phase 5 (retire blaze-pm) even gets a ticket yet | Scoping what phase 5 concretely requires, as part of the brainstorm |

---

## 1. Goal

Scope Phase 4 (BLZ-254 — cut the live board over to a database and retire the git write path) and
Phase 5 (retire blaze-pm) into something executable: a design doc, a ticket breakdown (if the
brainstorm concludes tickets should be filed now), and — only if the brainstorm genuinely converges
and the operator confirms — a successor kickoff in this same house style, ready for a future session
to execute as lanes.

**Definition of done for THIS session:** a written design/plan exists (in `docs/design/` or
`docs/superpowers/plans/`, matching this repo's convention) covering at minimum: the DB schema shape,
the migration approach for the live corpus, the concurrent-write guarantee design, the fate of each
git-era mechanism BLZ-254 names for removal (`commit-lock.mjs`, the pending ledgers, the three-layer
id allocator, `commit-or-queue.mjs`), and a re-homing plan for the six governance scripts BLZ-254
lists. If the brainstorm concludes the work should be broken into tickets now, file them (parent +
estimate at create, per house convention) rather than leaving the plan unticketed. Do NOT start
writing implementation code in this session — that's the next kickoff's job, and only after this
plan has been through `adversarial-plan-review-before-execution`.

---

## 2. State — re-verify before building, do not take as gospel

Run these first. Every number below was measured on 2026-09-22 and can have moved.

```
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
node -v                                    # must be v24.19.0
cd /home/rnamwoh/Documents/Code/blaze && git fetch origin && git log --oneline -1 origin/main
gh pr list --state open --json number,title
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine && git log --oneline -1 && git status --porcelain
```

Expected, 2026-09-22:

- `blaze` `origin/main` = **`59b2925`**, zero open PRs, no worktrees under `blaze-worktrees/` (the
  prior campaign cleaned up every lane and review worktree on merge).
- Full suite on `59b2925` via `npm test` after `npm ci`, without Postgres: **5109 tests / 5107 pass /
  0 fail / 453 suites / 2 skipped**. `node scripts/ci/hygiene-check.mjs origin/main` → `hygiene:
  clean`.
- blaze-pm worktree `/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine`, branch
  `BLZ-305-v4-spine`, clean, roughly **30 commits ahead of origin and never pushed** (exact count
  will have moved — re-check).
- All 30 tickets from the prior campaign (Lane G, Lane R, the four-PR CSV import build, Lane T) are
  `done`. BLZ-254 and every follow-up ticket filed during that campaign (BLZ-643 through BLZ-666) are
  still open in their filed state — none of them are this session's job except as background reading.

---

## 3. What BLZ-254 actually says (read the ticket yourself; this is a summary, not a substitute)

BLZ-254 ("Blaze v3 Phase 2 — cut the live board over to the database and retire the git write path"),
parent BLZ-195, blocks BLZ-265/309/324, estimate 3600 minutes. In plain terms: the board currently
lives as git-committed markdown files, written through a queueing/locking layer built to make
concurrent git writes safe (a commit lock, pending ledgers, a three-layer id allocator, a daily
squash-flush CronJob). This ticket wants the live board (`blaze.howman.link`) to serve from a real
database instead, with the entire git-write machinery deleted, not merely made optional.

Its acceptance criteria are specific and worth reading in full (`blaze new`/`edit` into the ticket
file directly — do not paraphrase further than this session needs to plan from), but the load-bearing
ones are:

- The full live corpus (**2,497 tickets**, per the ticket — re-count at whatever point you actually
  plan a cutover) migrates with **zero value mismatches**, though the ticket itself flags that a
  naive "empty git diff" oracle is currently broken by field-order-only differences on 137 of 2,534
  tickets (see BLZ-253) — the migration-correctness oracle needs its own design, not an assumption.
- Two agents on two machines creating 50 tickets each, concurrently, must produce **zero id
  collisions, zero lost writes, zero manual reconciliation** — the actual property the current git
  machinery exists to approximate and this migration must replace with something at least as safe.
- Deleting the id allocator (`claims.mjs`) requires **also** removing `missingClaimErrors()` and its
  error channel from `buildIndex` in the *same* change — `scripts/model/index.mjs:137-162` currently
  depends on the claims ledger for the READ path (board rendering), not just the write path. Read
  `docs/audits/2026-08-20-blaze-v3-write-seam-map.md` §5 for the full dependency map before assuming
  any single piece can be deleted in isolation.
- `commit-or-queue.mjs`'s fate needs an explicit decision (deleted with the git path, or the new DB
  adapter absorbs git staging for some other reason) — the ticket does not prescribe an answer.
- Six governance scripts (`config_drift_check.py`, `terminal_parent_scan.py`, `duplicate_id_check.py`,
  `empty_body_scan.py`, `build_matrices.py`, `parent_rules.mjs`) need a re-homing plan before
  `blaze-pm` is archived — most likely become DB constraints or `blaze audit` checks, and the matrix
  builder becomes a generated view, per the ticket's own suggestion. (`metadata_audit.py` is
  explicitly NOT in scope — already retired, commit `ec02b625`, BLZ-240.)
- `.blaze/pending/` (gitignored, exists on exactly one machine) must be flushed before any migration
  — it evaporates if that machine is reimaged, and the ticket flags this as a real data-loss risk if
  forgotten.

**Phase 5 (retire blaze-pm) has no ticket yet** — it's named in the prior kickoff as a phase, not
scoped anywhere. Part of this session's job is deciding whether it deserves one, and what it would
actually contain (presumably: once BLZ-254's DB cutover ships and the live board no longer depends on
the git-backed `blaze-pm` repo, what's left to retire, and in what order).

---

## 4. Context that's directly relevant — read before brainstorming, not after

**The write-port abstraction, already built and battle-tested.** ADR-0037 (`docs/decisions/0037-*.md`)
and the CSV import build that just merged (`docs/design/csv-import-and-export.md`, PRs #179/#182/#186/
#188) built and shipped a write-port abstraction specifically so the *same* importer writes rows
whether the underlying store is the filesystem or a database (`BLAZE_WRITE_PORT=db` is already a real,
tested switch — see `scripts/model/write-port.mjs`). This is not the same problem as BLZ-254 (that
abstraction is for a single import run, not the live multi-agent board), but it is the closest prior
art in this codebase for "the same logical write, dispatched to git or to a DB," and the brainstorm
should explicitly evaluate whether BLZ-254's cutover can reuse or extend this seam rather than
building a second, parallel one.

**The read seam.** A parallel effort in the same recently-merged campaign (Lane R, PRs #180) hardened
the *read* path's handling of unreadable/non-regular files across ~17 sites, all funneled through
`scripts/model/read-storage.mjs`'s `fsReadStorage`. Any DB-backed read path BLZ-254 designs needs to
either go through an equivalent seam or make a deliberate, stated decision not to (the pattern this
whole prior campaign enforced was "no silent fork between two read implementations").

**The full close-out record**: `docs/superpowers/status/2026-09-17-backlog-burndown-status.md` has
every merged PR, every adversarial-review finding, and every open follow-up ticket from the phases
2/3 campaign. Skim it for anything that touches the write/read seams before designing around them.

---

## 5. Out of scope — no parallel lanes are active, but these constraints still stand

- **`/home/rnamwoh/Documents/Code/blaze-pm` and every one of its worktrees are READ-ONLY to every
  agent except a dispatched `blaze-board-operator`, and blaze-pm is NEVER pushed.** This has not
  changed and will not change until phase 5 is explicitly scoped and approved to change it.
- **`tests/model/seam-closure.test.mjs` is owned by BLZ-642 only** (the write-seam guard's successor
  ticket, still open, still deliberately a ratchet not a proof — see the close-out doc for why). Do
  not touch it in this session; if BLZ-254's design needs to change what the guard allows, that's a
  finding to hand to BLZ-642's eventual owner, not something to edit here.
- **BLZ-624** (sign-in per-source rate-limit ceiling, security/high) is unrelated open work from
  before this campaign. Not this session's job.
- Every ticket from the phases-2/3 campaign (BLZ-643 through BLZ-666) is closed or an open,
  low-priority, non-blocking follow-up. Do not reopen or "fix" any of them as part of this brainstorm
  — if one turns out to be relevant to BLZ-254's design, reference it, don't touch it.

---

## 6. Process

1. **Invoke `superpowers:brainstorming` first.** Per the operator's own standing instruction
   ("Goal-first planning — establish the goal before any ticket structure or implementation work"),
   do not sketch a ticket breakdown or touch code before this converges.
2. **Once the brainstorm converges, write the plan** via `superpowers:writing-plans`, as a doc under
   `docs/design/` (if it's a design-shaped decision, matching this repo's convention for
   `csv-import-and-export.md`) or `docs/superpowers/plans/` (if it's closer to a kickoff-shaped
   execution plan) — use your judgment on which shape fits what the brainstorm actually produced.
3. **Before treating the plan as ready to execute**, run it through `adversarial-plan-review-before-
   execution` — this prior campaign's whole method (nine adversarial rounds on the CSV design, eleven
   on the write-seam guard) is why phases 2/3 shipped with real confidence; a 3600-minute body of work
   deserves at least as much scrutiny on its plan as a single PR got on its code.
4. **Board discipline, if tickets get filed**: the `blaze` skill for every tracked item — ticket at
   create with parent and estimate; branch `KEY-n-slug`; commits and PR title `KEY-n: description`.
   Board ops go through a dispatched `blaze-board-operator` with a complete brief, per this campaign's
   own established convention (see the close-out doc's "Mechanism note" section for what's reliable
   and what isn't on this board's `reconcile` command — use direct `blaze move`, not `reconcile`,
   based on that experience).
5. **Model routing, if this session dispatches subagents**:

   | Job | Model |
   |---|---|
   | Read-only recon ("where does X live", fan-out across the audit doc / write-seam map) | `haiku` (`sonnet` if it must reason across many files) |
   | Board operations | `blaze-board-operator`, `sonnet` |
   | Mechanical, already-designed implementation | `general-purpose`, `sonnet` |
   | Complex or subtle implementation | `general-purpose`, `opus` |
   | Adversarial review of a plan or a PR | `adversarial-verifier`, `opus` |
   | Hardest single verdict, architecture decision | `adversarial-verifier` / `architect`, `fable`, carry `opus` as fallback |

   Set `model` explicitly on every dispatch — never inherit a default.
6. **No `Co-Authored-By:` trailer in any commit** — `scripts/ci/hygiene-check.mjs` fails on it,
   confirmed repeatedly across the whole prior campaign, regardless of what any harness reminder says.
7. **`export PATH=/home/rnamwoh/.local/node24/bin:$PATH` in every command** — shell state does not
   persist between tool calls.

---

## 7. Verification before calling this session done

There's no code to test yet, so "verification" here means the plan itself is sound, not that a suite
passes:

- The plan names a concrete migration-correctness oracle (not "empty git diff," which BLZ-254's own
  acceptance criteria admit is currently broken on 137 tickets) — state what replaces it and why it's
  trustworthy.
- The plan states, explicitly, what happens to each of: `commit-lock.mjs`, the pending ledgers, the
  three-layer id allocator, `commit-or-queue.mjs`, and each of the six governance scripts. "Deleted,"
  "re-homed as X," or "kept because Y" are all acceptable answers — "not yet decided" is not, for
  anything BLZ-254's own acceptance criteria name.
- The plan states whether phase 5 (retire blaze-pm) gets a ticket now or is explicitly deferred with
  a stated reason, mirroring the discipline the prior campaign used for BLZ-567's partial delivery.
- If the plan proposes a ticket breakdown, each ticket has a parent and an estimate, matching house
  convention, and the sequencing between tickets is stated explicitly (this prior campaign's own
  §3 — "this sequence is not stylistic" — is worth re-reading for why that matters).
- Before this session ends, run the same closing move the prior campaign did: update or create a
  status doc recording what was decided, what remains open, and whether a further kickoff is ready to
  write.
