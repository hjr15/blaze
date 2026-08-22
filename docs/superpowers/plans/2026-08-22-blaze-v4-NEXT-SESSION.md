# Blaze v4 — next session brief

**Written:** 2026-08-22, at the end of the session that designed and built the v4 spine.
**Read this whole file before running anything.** Every command is literal and can be pasted.

---

## Where the work is

| What | Where |
|---|---|
| Engine code | `/home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-306-document-model`, branch **`BLZ-308-v4-fields-baselines-api`** — 37 commits ahead of `main`, clean tree |
| Engine docs (ADRs 0014–0018, spec, plan, ledger, review) | `/home/rnamwoh/Documents/Code/blaze` on **`main`** — 14 commits, **unpushed** |
| Board tickets | `/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine`, branch **`BLZ-305-v4-spine`** — BLZ-305..334, **unpushed** |
| Competitive register + audits | same board worktree, `docs/competitive/` and `docs/audits/` |

**Nothing has been pushed or merged.** That is deliberate — `blaze-pm` is published only by the
`blaze-flush` CronJob, and the engine branch was left for the operator to review.

## State in one line

**The spine is FULLY IMPLEMENTED. Every requirement in the spec has code behind it except §6, the
migration. 1,695 tests, 1,695 pass, 0 fail, 0 skipped with Postgres enabled** (baseline before this
work: 1,267; end of session 1: 1,489). Task 14 / BLZ-324 — the migration — is the only outstanding
work and is genuinely blocked on the soak.

Verify before trusting that number:

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH   # Node 20 lacks node:sqlite — this is mandatory
cd /home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-306-document-model
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55443:5432 --name v4chk postgres:17-alpine
sleep 5
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55443/postgres npm test
docker rm -f v4chk
```

## The one blocked task, and what unblocks it

**BLZ-324 / plan Task 14 — migrate v3 requirement and architecture tickets into v4 artifacts.**

It is blocked on the **db-primary Phase 2 cutover**, because a document has no status directory and
the filesystem write port cannot represent the model. The cutover is earned by the dual-write soak:

```bash
export BLAZE_WRITE_PORT=dual     # then use the board normally for a week
# divergences land in .blaze/divergences.jsonl — the target is zero across real use
```

**This is the operator's to run.** It needs elapsed time on the live board, not agent work.

Task 14's acceptance test is already specified: a **zero-diff oracle** against the existing derived
matrices (`python3 scripts/build_matrices.py --check` in `blaze-pm`). That method previously caught
six data-loss defects in already-merged v3 code, every one by running against the real corpus rather
than fixtures. Do not substitute a weaker check.

## Read these three, in this order

1. **`docs/superpowers/specs/2026-08-22-blaze-v4-spine-design.md`** — the spec. Binding authority.
2. **`docs/superpowers/plans/2026-08-22-blaze-v4-spine-execution-ledger.md`** — **41 rulings** made
   during execution (16 in session 1, R17–R41 in session 2), several reversing the plan's own text,
   plus every parked finding and accepted residual. If you are about to "fix" something that looks wrong, check here first — it may be a
   deliberate decision with a recorded reason.
3. **`docs/superpowers/plans/2026-08-22-blaze-v4-spine-final-review.md`** — the whole-branch review
   that found five Criticals. Three fixed in a review round, two under their own tickets.

## The lesson that should shape how you work here

Fourteen per-task reviews passed cleanly and **still let five Criticals through**, for one structural
reason: each task verified its own layer and **no test crossed the API/DDL boundary**. Two layers can
each be internally consistent, both green, and mutually contradictory — `baselineDocument` emitted a
per-document baseline while `baseline.test.mjs:96` asserted baselines have no `document_id`, and both
passed.

The single most productive instruction of the session was: **"if a mutation does not break a test,
say so plainly."** It fired eight times. Every one was a test that looked rigorous and proved nothing
— a review date that postdated both revisions so first-vs-latest could not differ; a filter every
fixture already satisfied; a `min` parameter no fixture varied. Keep that instruction in every
dispatch.

## Accepted residuals — do not "discover" these as new bugs

Recorded in the ledger with reasoning:

- `transition` does not persist a **ticket-kind** subject's status. That is the pre-existing v3
  `write-port.mjs` surface (27+ NOT NULL columns), deliberately untouched.
- Explicit-ref monotonicity is checked against `max(live, ledger)` rather than the ledger alone,
  because `claimRef` only auto-allocates. `UNIQUE(project_key, ref)` backstops it.
- **With no store wired, ref allocation still uses the old live-array path and therefore still
  reuses.** Safe only because production always has a store. If you ever construct an API without
  one, this bites.
- A goal with no hierarchy members vacuously passes `goal:achieved`. Consistent with the house rule
  that untraced work is legal and counted, and the matrix publishes the count.

## The spec is fully implemented — what shipped, and where the reasoning lives

Every requirement in the design spec now has code behind it, **except §6 (migration)**, which is
BLZ-324 and blocked below. Kept as a record, not as outstanding work:

| Spec | Ticket | Commit | Rulings |
|---|---|---|---|
| §4.4 coverage-rule creation reports every violation | BLZ-327 | `ebaab09` | R17–R22 |
| §4.1 required / enum / type / range validation | BLZ-328 | `516600a` | R23–R25 |
| §3.4 field budget, install-wide and per project | BLZ-329 | `b9637d9` | R26–R27 |
| §5 orphan / missing-downstream / stale-since-change | BLZ-330 | `8e82992` | R28–R30 |
| — dialect extraction (follow-up, not a spec item) | BLZ-331 | `f40045c` | R31 |
| §3.4 JSON tail column with CHECK constraints | BLZ-332 | `566e9a8` | R32–R36 |
| §5 matrix filterable by custom field, both axes | BLZ-334 | `c00d485` | R37–R39 |
| §4.3 advisory checks beyond WARN_TIER | BLZ-333 | `6575253` | R40–R41 |

**Nothing from the final review is outstanding.** If you are looking for the next thing to build,
it is not here — it is either BLZ-324 (blocked, below) or specs 2–6, which are out of scope until
the spine merges.

## Recommended follow-up, already reasoned through

~~**Extract the dialect helper.**~~ **DONE** — BLZ-331, `f40045c`. It was ten modules, not seven
(the count predated BLZ-325/326/330). Verified by a zero-diff oracle: all 42 generated DDL
statements byte-identical, including the carved-out `config-schema.mjs`. `config-schema.mjs` stays
out for a recorded reason now, not just a carve-out (R31). The extraction's own new test caught a
real bug it had introduced — returning the shared token object rather than a copy.

## Out of scope for the next session

- **Do not push `blaze-pm` to `origin/main` and do not merge its PRs.** The `blaze-flush` CronJob
  (23:50 Australia/Sydney) is the sole merger. Work ends at a local commit.
- Do not start specs 2–6 (agile execution, Gantt/critical path, hierarchy reporting and Excel export,
  diagrams, configuration UI) until the spine's open items are closed. They are all consumers of it.
- Do not run the dual-write soak on the operator's behalf.

## If you are continuing rather than starting fresh

Nothing is half-finished. The tree is clean, every commit is complete, and the ledger records every
decision. **There is no unblocked engine work left on the spine.** The honest options are:

1. **Review the branch and merge it.** 37 commits, 1,695 green tests. This is the operator's call
   and the reason the branch was never pushed.
2. **Run the dual-write soak** (below), which is the only thing that unblocks BLZ-324.
3. **Start specs 2–6** — but only after the spine merges; they are all consumers of it.

Do not go looking for spec gaps to close. There are none left.

**Board note (session 2):** BLZ-305..327 are now `in-progress`, not `defined` — nothing is merged, so
that is the honest status, and it was set by hand. `blaze reconcile` correctly proposes nothing for
them, and **no config change is needed** — `projects/BLZ/project.json` already sets
`codeRepos: ["../blaze"]`. The children are bundled under one feature integration branch and so have
no branch of their own, and BLZ-308's own branch claim is dropped by the INF-735 fail-closed gate
(a feature branch carries its children's commits, never a `BLZ-308:` one). Both are correct. The
signal appears when the PR is opened, via the house `KEY-n: description` PR title.
