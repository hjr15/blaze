# Blaze v4 — next session brief

**Written:** 2026-08-22, at the end of the session that designed and built the v4 spine.
**Read this whole file before running anything.** Every command is literal and can be pasted.

---

## Where the work is

| What | Where |
|---|---|
| Engine code | `/home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-306-document-model`, branch **`BLZ-308-v4-fields-baselines-api`** — 29 commits ahead of `main`, clean tree |
| Engine docs (ADRs 0014–0018, spec, plan, ledger, review) | `/home/rnamwoh/Documents/Code/blaze` on **`main`** — 14 commits, **unpushed** |
| Board tickets | `/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine`, branch **`BLZ-305-v4-spine`** — BLZ-305..326, **unpushed** |
| Competitive register + audits | same board worktree, `docs/competitive/` and `docs/audits/` |

**Nothing has been pushed or merged.** That is deliberate — `blaze-pm` is published only by the
`blaze-flush` CronJob, and the engine branch was left for the operator to review.

## State in one line

**Fourteen of fifteen planned tasks are built. 1,489 tests, 1,489 pass, 0 fail, 0 skipped with
Postgres enabled** (baseline before this work: 1,267). Task 14 — the migration — is the only one
outstanding and is genuinely blocked.

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
2. **`docs/superpowers/plans/2026-08-22-blaze-v4-spine-execution-ledger.md`** — **16 rulings** made
   during execution, several reversing the plan's own text, plus every parked finding and accepted
   residual. If you are about to "fix" something that looks wrong, check here first — it may be a
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

## Known spec gaps with no code behind them

Found by the final review; **not yet ticketed**:

- **§4.4 — applying a coverage rule to existing data must report every current violation.** No
  rule-creation path exists at all. This is the fix for Jama's silent grandfathering (CS-013), which
  the operator named directly as the drift that must not happen. `coverage()` is a standing read,
  which is a different obligation — an endpoint nobody opens is exactly the failure.
- §4.1 required-field / enum / range validation — entirely absent.
- §3.4's JSON tail column and the budget reporting the 200-field cap needs to be visible rather than
  sprung.
- §5's missing-downstream indicator and API-surfaced staleness.

## Recommended follow-up, already reasoned through

**Extract the dialect helper.** Seven modules each define a private `dialect(name)`. This is not
tidiness: `boolean NOT NULL DEFAULT 0` shipped **three separate times** because Postgres rejects an
integer default and SQLite tolerates it, and ` STRICT` is retyped seven times where omission fails
silently. Coupling cost is near zero. **Leave `config-schema.mjs` alone.** Follow-up ticket, not a
merge blocker.

## Out of scope for the next session

- **Do not push `blaze-pm` to `origin/main` and do not merge its PRs.** The `blaze-flush` CronJob
  (23:50 Australia/Sydney) is the sole merger. Work ends at a local commit.
- Do not start specs 2–6 (agile execution, Gantt/critical path, hierarchy reporting and Excel export,
  diagrams, configuration UI) until the spine's open items are closed. They are all consumers of it.
- Do not run the dual-write soak on the operator's behalf.

## If you are continuing rather than starting fresh

Nothing is half-finished. The tree is clean, every commit is complete, and the ledger records every
decision. You can pick up at any of: BLZ-325/326 close-out, the four spec gaps above, the dialect
extraction, or waiting on the soak for Task 14.
