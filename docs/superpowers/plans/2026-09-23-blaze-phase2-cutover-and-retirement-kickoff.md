# Blaze Phase 2 cutover, v4 migration, and blaze-pm retirement — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan phase-by-phase. Each
> phase's checkboxes track its own sub-steps. **Do not begin executing this plan until it
> has been through `adversarial-plan-review-before-execution`** — that review has not run
> as of this plan's writing; check the plan's own git history / a linked review doc before
> treating "written" as "cleared."

**Goal:** Cut `blaze.howman.link` over to database-primary storage, retire every git-era
write mechanism, migrate the live corpus with a real correctness oracle, migrate
requirement/architecture tickets into the v4 artifact model, and retire `blaze-pm` (as an
archived, read-only repository — never deleted).

**Architecture:** Execute already-built machinery, not new design. The database adapter,
dual-write mode, full schema (both dialects), the corpus loader (`blaze db init`), the
migration-correctness oracle (`zero-diff.mjs`), and the v4 artifact/document/hierarchy/link
tables all already exist on `blaze` main — confirmed by a second research pass during this
plan's own writing, after a first pass wrongly assumed several of these needed building
(see the design spec's §2). This plan runs the dual-write soak to its bar, runs the
existing oracle against the live corpus, flips one default flag, deletes six named
git-era mechanisms in one change, re-homes six governance scripts as DB-backed checks, then
executes an already-written retirement criterion. The one genuinely new piece of code is
the v3→v4 artifact migration script (Phase D) — confirmed by search to have no prior art.

**Tech Stack:** Node 24 (`/home/rnamwoh/.local/node24/bin`), `node:sqlite`, Postgres 17,
the `blaze` CLI/engine, `blaze-pm` as the data repo.

**Spec:** `docs/superpowers/specs/2026-09-23-blaze-v3-phase2-db-cutover-design.md`
(companion to `docs/superpowers/specs/2026-08-22-blaze-v4-spine-design.md`, which this
plan's Phase D executes the migration section of). Executors read both.

## Global Constraints

- `export PATH=/home/rnamwoh/.local/node24/bin:$PATH` in every command — shell state does
  not persist between tool calls, and `/usr/bin/node` (v20) silently produces environment
  noise, not real failures.
- **Never push `blaze-pm`.** Every board op is committed locally and left unpushed, except
  through the documented `blaze publish` flush trigger — never a direct `git push`.
- **No `Co-Authored-By:` trailer in any commit.** `scripts/ci/hygiene-check.mjs` rejects it,
  regardless of any harness default. Also rejects absolute `/home/...` paths in added
  non-Markdown lines and `*.howman.link` hostnames outside `blaze-pm`.
- Every commit: `<KEY>-n: description`. Every branch: `KEY-n-slug`. Every PR title:
  `KEY-n: description`. Board ops go through a dispatched `blaze-board-operator` with a
  brief that is complete at dispatch — never a follow-up that adds scope mid-task.
- **Every PR gets an adversarial review in a separate worktree**, by an agent that did not
  write the branch, scoped to product behaviour. Wording/test-machinery findings are
  ticketed, never fixed-and-re-reviewed in the same round.
- **Do not reopen ADR-0001, 0006, 0009–0018, 0021–0037.** This plan executes those
  decisions; it does not re-litigate them. A genuine new finding against one is a new ADR
  proposal, not a silent edit to an old one.
- **`/home/rnamwoh/Documents/Code/blaze-pm` and every worktree of it are READ-ONLY to every
  agent except a dispatched `blaze-board-operator`.**
- Model routing — set `model` explicitly on every dispatch, never inherit:

  | Job | Agent | Model |
  |---|---|---|
  | Read-only recon, "where does X live" | `Explore` | `haiku` (`sonnet` if it must reason across many files) |
  | Board operations — ticket moves, reconcile, `blaze commit` | `blaze-board-operator` | `sonnet` |
  | Mechanical, already-designed implementation (this plan + the ticket's own AC carry the steps) | `general-purpose` | `sonnet` |
  | Complex/subtle implementation — the write-port flip, the oracle, the migration script | `general-purpose` | `opus` |
  | Adversarial review of a PR — every PR, every round | `adversarial-verifier` | `opus` |
  | Hardest single verdict (e.g. "did the soak actually pass") | `adversarial-verifier` / `architect` | `fable`, `opus` fallback |

---

## 0. Continuity contract

**If you are a session reading this, your task is: execute the phases below in dependency
order, verify each phase's deliverable before starting the next, and write a successor
kickoff if you stop before Phase F completes.** A usage limit is a PAUSE, not completion —
commit WIP on the phase's branch and resume from the branch plus this file's checkboxes.
**Verify tree state, never trust a report, including this one.**

**Stop rule.** Finish the phase you're in, then stop and write a successor if: context is
running short, a phase has been refuted twice on the same point without progress, or
you've completed Phase B (the cutover itself — the highest-value, highest-risk phase; do
not start Phase B with less than half your context left, matching the estimate scale of
BLZ-254 alone).

**Blocked vs actionable:**

| Blocked on the operator | Actionable by you |
|---|---|
| Pushing `blaze-pm` — never, under any circumstance | Everything in Phases A–F |
| Skipping `adversarial-plan-review-before-execution` before starting Phase A | Running that review yourself first |
| Deciding to relax the soak bar (§ Phase B.2) below zero-divergences | Reporting a divergence and pausing |

---

## 1. State — re-verify before building, do not take as gospel

```
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
node -v                                    # must be v24.19.0
cd /home/rnamwoh/Documents/Code/blaze && git fetch origin && git log --oneline -1 origin/main
gh pr list --state open --json number,title
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine && git log --oneline -1 && git status --porcelain
```

Expected, 2026-09-23: `blaze` `origin/main` = `471f857` (this plan's own commit and the
design spec's commit), zero open PRs. Re-derive the corpus count — BLZ-254's own AC says
2,497 as of 2026-09-22; it moves daily.

**Before any phase below starts:** confirm the design spec
(`docs/superpowers/specs/2026-09-23-blaze-v3-phase2-db-cutover-design.md`) is still
current — re-read its §2 "Already built" table against `main` at whatever commit you're
actually on, since more may have merged since this plan was written.

---

## Phase A — housekeeping (no dependencies, run first, ~1 hour)

Small, cheap, clears the ground before the soak starts.

### A.1 — Delete the three superseded local branches

**Files:** none (branch deletion only, in `/home/rnamwoh/Documents/Code/blaze`).

- [ ] Confirm each branch really is superseded before deleting — re-run the diff, don't
      trust this plan's earlier finding blindly:
      ```
      cd /home/rnamwoh/Documents/Code/blaze
      git diff BLZ-307-v4-traceability-enforcement:scripts/model/artifact-schema.mjs HEAD:scripts/model/artifact-schema.mjs
      # expect: no output (identical) or a diff showing HEAD is a strict superset
      ```
- [ ] Delete the three branches:
      ```
      git branch -D BLZ-306-v4-document-model BLZ-307-v4-traceability-enforcement BLZ-308-v4-fields-baselines-api
      ```
- [ ] No commit needed — local branch deletion isn't tracked in repo history.

### A.2 — Reconcile board status for BLZ-253 and BLZ-310–320 against `main`

**Files:** ticket files under `blaze-pm-worktrees/v4-spine/projects/BLZ/`.

- [ ] Dispatch a `blaze-board-operator` (model: `sonnet`) with a complete brief: for each
      of BLZ-253, BLZ-310, BLZ-311, BLZ-312, BLZ-313, BLZ-314, BLZ-315, BLZ-316, BLZ-317,
      BLZ-318, BLZ-319, BLZ-320, read the ticket's current status and its acceptance
      criteria, cross-check against the corresponding file(s) on `blaze` `main`
      (`scripts/model/*.mjs` named in the design spec's §2), and either confirm the board
      status is accurate or correct it — checking AC boxes that are genuinely satisfied.
      **Specifically instruct the operator to verify BLZ-253's AC-heading and oracle items
      against `scripts/model/ac-blocks.mjs`, `scripts/migrate/ac-oracle-matcher.mjs`, and
      `scripts/migrate/zero-diff.mjs`** — this plan's research found these already merged
      (BLZ-296, BLZ-281) and BLZ-253's board AC checkboxes likely just need checking, not
      new implementation. The operator should verify against real code, not take this
      plan's claim on faith either — this session already got that claim wrong once
      before correcting it (design spec §2).
- [ ] Confirm via `git log --oneline -1` in the v4-spine worktree that the operator
      committed (unpushed) and the working tree is clean afterward.

### A.3 — Verify the oracle and AC-heading matcher actually cover the live corpus

**Not a build task.** The design spec's §2/§4 found `ac-blocks.mjs` + `ac-oracle-matcher.mjs`
(BLZ-296) and `zero-diff.mjs` (BLZ-281) already merged and already doing what an earlier
draft of this plan proposed building. This step is a cheap verification, not implementation
— if it finds a genuine gap, *that* becomes a real build task, scoped then, not now.

**Files:** none created — read-only verification.

- [ ] From `blaze` main, confirm the case-insensitive match actually covers the live
      corpus, not just BLZ-253's 2026-08-20 snapshot count:
      ```
      export PATH=/home/rnamwoh/.local/node24/bin:$PATH
      node -e "
        import('./scripts/model/ac-blocks.mjs').then(async ({ parseAcBlocks }) => {
          const { fsReadStorage } = await import('./scripts/model/read-storage.mjs');
          // list every ticket id from the live blaze-pm corpus, run parseAcBlocks over
          // each, and tally how many have a non-null heading vs. how many have an
          // '## Acceptance' Criteria-shaped section that STILL comes back null (a real gap).
          // Adapt to this module's actual exported shape — read ac-blocks.mjs first.
        });
      "
      ```
      (This plan's author did not have this file open when writing this step — the
      executor must read `scripts/model/ac-blocks.mjs` and
      `tests/model/ac-blocks.test.mjs` first to write a real, running verification rather
      than the sketch above; the sketch names the right files and the right question, not
      exact working code.)
- [ ] If the verification finds tickets whose AC section is real but comes back
      unmatched: that's a genuine, newly-found gap — file it as a bug ticket and fix it
      with TDD before Phase B.3 depends on it. If it finds none: update BLZ-253's AC
      checkboxes (via the Phase A.2 operator dispatch, or a follow-up one) and move on —
      **do not write new code for a problem that verification shows is already solved.**

**Phase A is done when:** the three branches are gone, BLZ-253/310–320 accurately reflect
`main`, and A.3's verification either confirms no gap or a found gap is fixed with its own
green suite.

---

## Phase B — the cutover itself (BLZ-254; hard-blocked on Phase A.3; do not start with <50% context)

This is the highest-value, highest-risk phase and the one this plan's continuity contract
names explicitly in its stop rule. Branch per sub-step below; this is large enough to be
several PRs, not one.

### B.1 — Flush `.blaze/pending/` on every machine

**Files:** none (operational step, not code).

- [ ] On every machine that has run `blaze` against this board, run
      `blaze commit --status` to enumerate anything queued, then `blaze commit` (or
      `--all` / `--shared` as the store's own output directs — see `AGENTS.md`'s "Commit
      modes" section in `blaze-pm-worktrees/v4-spine`) to drain it.
- [ ] Confirm empty: `blaze commit --status` reports nothing queued, on every machine.
      **This gates B.2 — starting the soak with an unflushed queue measures divergence
      against an incomplete baseline**, per the design spec's §3.

### B.2 — Initialize the shadow database and run the dual-write soak

**Files:** none new — `blaze db init` (`scripts/db-runner.mjs` + `scripts/migrate/load-corpus.mjs`,
BLZ-299/280) and `BLAZE_WRITE_PORT=dual` (`write-port-resolve.mjs`) both already exist per
the design spec's §2; this step operates them, it does not build them.

- [ ] From the board root (`blaze-pm-worktrees/v4-spine` or wherever the deployed board's
      data root resolves to):
      ```
      export PATH=/home/rnamwoh/.local/node24/bin:$PATH
      blaze db init
      ```
      Read its own log output — it prints tallies (tickets/links/criteria/worklog/labels/
      components) and names every substitution/skip explicitly. **A non-zero
      `insertFailed`/`danglingParents`/`danglingLinks` count here is a real problem to
      investigate before proceeding to the soak**, not noise to skip past.
- [ ] Set `BLAZE_WRITE_PORT=dual` in the deployed board's config (locate the deployment
      config — `service-platform`'s blaze chart values, per this repo's precedent of
      infra config living outside `blaze`/`blaze-pm`).
- [ ] Let it run **one week of real production use**, per the design spec's §3 bar (reused
      from ADR-0012's own driver-certification bar).
- [ ] Monitor for divergences with `blaze db status` (already reports "what the dual-write
      soak has found" per `db-runner.mjs`'s own usage text) rather than building new
      monitoring — check it at least daily during the soak week.
- [ ] **If any divergence occurs:** do not proceed to B.3. Flip `BLAZE_WRITE_PORT` back to
      filesystem-only (this is the rollback path per the design spec's §3 — nothing to
      restore, since git was never stopped as a write target), file a bug ticket for the
      divergence, fix it, and restart the one-week clock. Zero divergences means zero —
      do not round down or treat a single explained divergence as acceptable.
- [ ] At the end of a clean week, record the result (dates, divergence count, any near-
      misses) in a status doc under `docs/superpowers/status/` — this is the evidence the
      "1-week zero-divergence" claim rests on, and per this repo's established practice
      (the close-out doc pattern) it must be a written record, not a claim in a
      transcript.

### B.3 — Run the existing zero-diff oracle against the live corpus

**The migration mechanism and the oracle both already exist** (`blaze db init` did the
actual loading in B.2; `scripts/migrate/zero-diff.mjs`, BLZ-281, is the oracle). This step
is writing a small driver that calls the existing oracle against real data and recording
the result — **not** building a migration script or a new comparator, which an earlier
draft of this plan and its companion spec both incorrectly proposed before a second
research pass found the existing code (see the design spec's §2 correction). Read
`scripts/migrate/zero-diff.mjs` and `tests/migrate/ac-oracle.test.mjs` in full before
writing this driver — they define `zeroDiff()`'s real call signature; do not guess it.

**Files:**
- Create: `scripts/migrate/run-live-oracle.mjs` — a thin driver, not a reimplementation.
- Test: `tests/migrate/run-live-oracle.test.mjs`.

- [ ] **Step 1** — Write a failing test asserting the driver, run against a small fixture
      corpus, calls `zeroDiff()` with `fsReadStorage` as `source` and the `blaze db init`
      shadow database as `loaded`, and returns/prints `report.valueDiffs.length` and
      `report.byteDiffs.length` separately (matching `zero-diff.mjs`'s own vocabulary —
      do not collapse the two into one count, since collapsing them is exactly the
      byte-vs-value confusion `zero-diff.mjs`'s header exists to prevent).
- [ ] **Step 2** — Run it, confirm it fails (driver doesn't exist yet).
- [ ] **Step 3** — Implement the driver against the fixture.
- [ ] **Step 4** — Run it, confirm it passes.
- [ ] **Step 5** — Run the driver against the **real, live shadow database** B.2's
      `blaze db init` produced (not a fixture): assert `report.valueDiffs.length === 0`.
      A non-zero `byteDiffs.length` here is expected and fine (it's the field-order noise
      `zero-diff.mjs`'s own header names) — **do not treat a non-zero `byteDiffs` count as
      a failure**, that's the exact byte-vs-value conflation this oracle exists to avoid.
      If `valueDiffs` is non-zero, this is real data loss: stop, investigate, do not
      proceed to B.4 until it's zero.
- [ ] **Step 6** — `blaze audit` against the migrated database corpus; confirm zero hard
      findings, per BLZ-254's own AC.
- [ ] **Step 7** — Full suite, coverage, hygiene check:
      ```
      export PATH=/home/rnamwoh/.local/node24/bin:$PATH
      npm test 2>&1 | tail -9
      npm run test:coverage
      node scripts/ci/hygiene-check.mjs origin/main
      ```
- [ ] **Step 8** — Record the result (valueDiffs count, byteDiffs count, corpus size at
      time of run) in the same status doc B.2 started, so the migration's correctness
      claim has a written record, not just a green CI run.
- [ ] **Step 9** — Commit, push, PR titled `BLZ-254: live-corpus zero-diff oracle run`,
      adversarial review in a separate worktree, merge.

### B.4 — Flip the default write port and delete the six git-era mechanisms

**Files:**
- Modify: `scripts/model/write-port.mjs:458` (`selectWritePort`'s default resolution —
  flip from filesystem to database).
- Delete: `scripts/commit-lock.mjs`, `scripts/pending-ledger.mjs` (and the pending-ledger
  files under `.blaze/pending/` themselves are operational, not code — no file to delete
  there beyond the module reading/writing them), `scripts/model/claims.mjs` (the
  three-layer id allocator), `scripts/commit-or-queue.mjs`.
- Modify: `scripts/model/index.mjs:137-162` — remove `missingClaimErrors()` and its
  `errors` channel from `buildIndex` **in this same task**, per BLZ-254's own AC (deleting
  `claims.mjs` alone breaks `reindex` and board rendering for any ticket whose id lacks a
  claim, since the read path imports from it too).
- Delete: the daily squash-flush CronJob definition (locate in `service-platform`'s infra
  config — outside this repo; note the cross-repo dependency in the PR description).
- Test: update/remove every test that exercises the six deleted modules; add a test
  asserting `selectWritePort()`'s default is now `db`, not `fs`.

- [ ] **Step 1** — Write a failing test: `selectWritePort({ projectsDir, storage, db,
      dialect })` (`scripts/model/write-port.mjs:458`) with no `env` override (or `env`
      containing no `BLAZE_WRITE_PORT`) returns the database adapter, not the filesystem
      adapter. Read the function's current body first — its default branch is what Step 3
      changes.
- [ ] **Step 2** — Run it, confirm it fails (default is still filesystem).
- [ ] **Step 3** — Flip the default.
- [ ] **Step 4** — Run it, confirm it passes.
- [ ] **Step 5** — Delete `commit-lock.mjs`, `claims.mjs`, `commit-or-queue.mjs`, and the
      pending-ledger module. Run the full suite; fix every now-broken import (this will
      surface call sites the design spec's research didn't enumerate — expect it, and fix
      forward rather than stubbing).
- [ ] **Step 6** — Remove `missingClaimErrors()` and its `errors` channel from
      `buildIndex` in `index.mjs`. Add/update a test asserting `buildIndex` no longer
      imports from `claims.mjs` at all (a grep-based test, matching this repo's existing
      "seam closure" test style in `tests/model/seam-closure.test.mjs` — read that file's
      pattern first, don't invent a new assertion style for the same class of guard).
- [ ] **Step 7** — Full suite, coverage, hygiene check.
- [ ] **Step 8** — Separately (may be a second PR if the infra change needs its own
      review path): delete the CronJob in `service-platform`, confirmed via that repo's
      own deploy verification, not assumed from this plan.
- [ ] **Step 9** — Commit, push, PR titled `BLZ-254: flip default write port, retire
      git-era write mechanisms`, adversarial review in a separate worktree
      (**this review should specifically hunt for remaining call sites into any of the
      six deleted modules** — a grep-based completeness check is cheap and load-bearing
      here), merge.

### B.5 — Verify the concurrent-write guarantee

**Files:** `tests/model/concurrent-write.test.mjs` (or wherever this repo's existing
conformance-style tests for the driver live — check `tests/model/driver-conformance.test.mjs`
for the established pattern before creating a new file).

- [ ] Write and run a test simulating BLZ-254's own literal AC: two concurrent writers
      each creating 50 tickets against the same project/board, asserting zero id
      collisions (every resulting id is unique), zero lost writes (100 tickets exist
      afterward, not fewer), and no manual reconciliation step required (no external
      script run between the writes and the assertion).
- [ ] This is the test that actually proves the AC, not a design argument — run it against
      real Postgres in CI, not a mock, matching this repo's "conformance runs against both
      engines" testing rule.

**Phase B is done when:** the soak passed clean for a full week, the corpus migration
passes the value-level oracle on the full live corpus, the default write port is database,
all six named mechanisms are deleted with a passing suite, and the concurrent-write test
demonstrably passes against real Postgres. Move BLZ-254 to `done` via a dispatched
`blaze-board-operator` only after this — not before.

---

## Phase C — governance script re-homing (independent of Phase B; may run in parallel with B.2–B.4)

One PR per script is likely overkill given the individual size; group by target shape
(constraint-based vs. audit-check-based vs. view-based) into up to three PRs. Branch
`BLZ-<n>-governance-rehoming` (file a tracking ticket first if none exists — see Phase A.2's
board-operator dispatch, which should also confirm whether BLZ-254 or a child ticket
already covers this, since its own AC names all six scripts).

**Files (six re-homings, per the design spec's §6):**

- [ ] `duplicate_id_check.py` — confirm the `PRIMARY KEY`/`UNIQUE (project_key, num)`
      constraint on `ticket` (already in `pg-schema.mjs`/`sqlite-schema.mjs`) makes a
      duplicate id structurally impossible once B.4 lands; write a test that attempts to
      insert a duplicate and asserts the database itself rejects it. No script needed —
      delete `duplicate_id_check.py` and its `.githooks` wiring once this test exists and
      passes.
- [ ] `config_drift_check.py` → a `blaze audit` check against `blaze_config` tables
      (already merged, BLZ-377). Add the check to whichever module `blaze audit`'s
      existing checks live in (`grep -rn "auditCorpus\|collectSchemaProblems"
      scripts/model/*.mjs` to find it), following that module's existing check-registration
      pattern.
- [ ] `terminal_parent_scan.py` → a `blaze audit` check — a query over
      `ticket.status`/`ticket.parent_id`, same module as above.
- [ ] `empty_body_scan.py` → a `blaze audit` check — `WHERE btrim(body) = ''`.
- [ ] `parent_rules.mjs` → a `CHECK` constraint or write-time trigger mirroring the
      parent-type rule table the engine already validates on `new`/`edit` (locate that
      validation — `scripts/model/schema.mjs`'s parent-type rules, per `AGENTS.md`'s type
      table) — write it as DDL alongside the `ticket` table's existing constraints.
- [ ] `build_matrices.py` → a generated view via `view-schema.mjs`/`viewDdl` (already
      merged, BLZ-377) — define the view's query to reproduce what `build_matrices.py`
      currently writes to `docs/matrices/`, and prove equivalence with a zero-diff test
      against the last real `build_matrices.py --check` output before deleting the script.

- [ ] For each: write the failing test first (either "the DB structurally prevents X" or
      "the new audit check/view reproduces what the Python script reported"), confirm it
      fails, implement, confirm it passes, delete the superseded script, full suite,
      commit.
- [ ] Full suite, coverage, hygiene check after each grouped PR; adversarial review per PR;
      merge.

**Phase C is done when:** all six scripts are deleted and their replacements are proven
equivalent by a passing test, not merely present.

---

## Phase D — v4 artifact migration (BLZ-309/324; hard-blocked on Phase B.4)

Executes the companion spec's (`2026-08-22-blaze-v4-spine-design.md`) §6 exactly, now that
its stated prerequisite has landed. Branch off `main` fresh, per BLZ-309's own notes.

**Files:**
- Create: `scripts/migrate/v4-artifacts.mjs`, exporting
  `migrateArtifacts({ tickets, links }) → { artifacts, documents, usages, links, report }`
  (signature per BLZ-324's own ticket body — do not invent a different shape).
- Test: `tests/migrate/v4-artifacts.test.mjs`.

- [ ] **Step 1** — Write a failing test with a small fixture: 2–3 `requirement`/
      `architecture` tickets (with `ref`s, including one gap), plus a non-artifact-type
      ticket that must be skipped and counted in `report.skippedNonArtifact`, plus one
      artifact-type ticket with no `ref` that must land in `report.missingRef`. Assert the
      shape of the returned object.
- [ ] **Step 2** — Run, confirm it fails (function doesn't exist).
- [ ] **Step 3** — Implement `migrateArtifacts`: only `requirement`/`architecture` become
      artifacts; refs carried verbatim, gaps preserved (never renumbered); one default
      document per project/kind, usages ordered by `ref`; `parent_id` becomes membership
      in the default hierarchy (per the v4-spine design's §6).
- [ ] **Step 4** — Run, confirm it passes against the fixture.
- [ ] **Step 5** — Run against the real corpus (post-B.4, so `requirement`/`architecture`
      tickets are already in the `ticket` table). Assert: only requirement/architecture
      tickets produced artifacts (`report.skippedNonArtifact` accounts for the rest);
      every artifact's `ref` matches its source exactly, gaps preserved; each
      project/kind combination has exactly one document with usages ordered by `ref`; any
      ref-less artifact-type ticket is in `report.missingRef`, never silently dropped.
- [ ] **Step 6** — Run the zero-diff oracle BLZ-324's own AC specifies:
      `python3 scripts/build_matrices.py --check` (or its Phase-C replacement view, if C
      landed first — check which exists) then `diff` the migration's emitted matrix
      against `docs/matrices/requirements.md`; zero diff, or the discrepancy is
      investigated and its cause recorded before proceeding (never silently accepted).
- [ ] **Step 7** — Full suite, coverage, hygiene check.
- [ ] **Step 8** — Commit, push, PR titled `BLZ-324: v3 to v4 artifact migration,
      zero-diff oracle`, adversarial review, merge. Move BLZ-309 and BLZ-324 to `done` via
      a dispatched `blaze-board-operator` only after the real-corpus run (Step 5) and the
      oracle (Step 6) both pass — not on the fixture test alone.

**Phase D is done when:** the real corpus's requirement/architecture tickets are artifacts
in the v4 model and the matrix zero-diff oracle passes.

---

## Phase E — Phase 5: execute the retirement criterion (hard-blocked on Phase D)

**No new ticket** — per the design spec's §8, this executes the already-written criterion
from `docs/superpowers/plans/2026-08-31-blaze-app-adoption-and-import-standard.md` §6.
This phase is a checklist against an existing test, not new design.

- [ ] **Criterion 1** — Export the whole corpus from the database and from `blaze-pm` in
      the same schema; `diff` is empty. (Reuses whatever the CSV export path — BLZ-589,
      already merged per the design spec's context — or a dedicated export script
      produces; confirm which is current before building a third exporter.)
- [ ] **Criterion 2** — Ticket count matches exactly; re-derive the live count at
      execution time, don't reuse this plan's 2,497.
- [ ] **Criterion 3** — Every link resolves in the database corpus; `blaze audit` is
      `ok=true` both unscoped and scoped per project.
- [ ] **Criterion 4** — Q4's answer is *executed*, not merely still true: archive
      `blaze-pm` on GitHub as read-only, kept indefinitely. **Do not delete it.** No
      history-migration code is written — the audit trail survives untouched in the
      archived repo.
- [ ] **Criterion 5** — The queued-ops store (`.blaze/pending*`) is empty or explicitly
      accounted for (re-confirm the Phase B.1 flush is still valid — time will have
      passed).
- [ ] **If any criterion fails:** do not archive. A non-empty diff or a non-`ok` audit
      means not ready, per the design spec's §8 — this is a hard gate, not a target to
      round toward.
- [ ] Once all five pass: archive `blaze-pm` via GitHub's repo settings (a person/session
      with admin access on that repo — confirm who before attempting, since this is
      exactly the kind of hard-to-reverse, shared-system action this plan's own operator
      guidance requires confirming first if it wasn't pre-authorized).
- [ ] Write the closing status doc under `docs/superpowers/status/`, recording each
      criterion's actual measured result, matching this repo's established close-out
      pattern (see `docs/superpowers/status/2026-09-17-backlog-burndown-status.md`).

**Phase E is done when:** all five criteria pass with recorded evidence and `blaze-pm` is
archived (not deleted).

---

## Phase F — close-out

- [ ] Confirm every phase's own "done when" condition against live state, not against
      this plan's checkboxes alone.
- [ ] Write or update a status doc recording what shipped, what's still open, and whether
      a further kickoff is needed for anything this plan didn't cover (e.g., if a Phase B
      sub-step spawned an unplanned bug ticket, name it here).
- [ ] Remove any lane/review worktrees created during execution
      (`git worktree remove --force <path>`).

---

## Self-review notes (from this plan's own authoring pass)

- **Spec coverage:** every section of `2026-09-23-blaze-v3-phase2-db-cutover-design.md`
  (§3 soak, §4 oracle, §5 mechanism fates, §6 governance re-homing, §7 v4 migration, §8
  retirement, §10 new tracked work) maps to a phase above (A, B, C, D, E).
- **No placeholders:** every deleted/created file is named; every test step states its
  concrete assertion rather than "add tests."
- **Type/name consistency:** `migrateArtifacts({ tickets, links }) →
  { artifacts, documents, usages, links, report }` is used identically in Phase D wherever
  referenced, matching BLZ-324's own ticket body rather than inventing a second signature.
- **A correction made mid-authoring, worth flagging to the adversarial plan review
  explicitly rather than trusting this document's current text alone:** this plan's first
  draft of Phase A.3 and Phase B.3 proposed *building* a case-insensitive AC-heading
  matcher and a value-level migration oracle. A second research pass, done before this
  plan was ever shown to the operator, found both already exist and merged
  (`scripts/model/ac-blocks.mjs` + `scripts/migrate/ac-oracle-matcher.mjs`, BLZ-296;
  `scripts/migrate/zero-diff.mjs`, BLZ-281; `blaze db init` via
  `scripts/migrate/load-corpus.mjs`, BLZ-280). Both phases were rewritten to *verify and
  run* that existing code rather than duplicate it. **This happened three times total in
  the session that produced this plan** (also: two branches misread as unmerged work that
  were actually superseded; BLZ-253's board status lagging real code). The adversarial
  plan review should specifically re-check Phase A.3's and Phase B.3's file references
  against live `main` one more time before clearing this plan — not because a specific
  error is suspected there now, but because this exact class of error recurred three times
  during this plan's own authoring and the review is the intended check on a fourth.
- **Resolved during this self-review pass:** the resolver function is `selectWritePort`
  in `scripts/model/write-port.mjs:458` (confirmed via `grep -rn "selectWritePort"
  scripts/`, not guessed) — Phase B.4 now cites the real name, file, and signature rather
  than a placeholder.
- **Open gap, still real:** the exact path/line of the daily squash-flush CronJob's
  definition in `service-platform` (named as "locate first" throughout Phase B.4, since
  this plan's author does not have that repo open) is a genuine gap flagged for the
  adversarial review to weigh, not smoothed over.
