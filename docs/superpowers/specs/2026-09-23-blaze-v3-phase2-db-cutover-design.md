# Blaze v3 Phase 2 — the DB cutover, corpus migration, and blaze-pm retirement

**Specifies BLZ-254** (cut the live board over to the database, retire the git write
path), the execution of BLZ-309/324 (migrate v3 requirement/architecture tickets into the
v4 artifact model), and Phase 5 (retire blaze-pm). Companion to
`docs/superpowers/specs/2026-08-22-blaze-v4-spine-design.md` ("the spine"), which names
this cutover as its own §6 prerequisite but doesn't specify it — this document is that
missing specification, not a second one.

## 1. Goal

Cut `blaze.howman.link` over to database-primary storage, retire every git-era write
mechanism, migrate the live 2,497-ticket corpus with a real correctness oracle, then
execute the spine design's migration of requirement/architecture tickets into the v4
artifact/document model. Decide Phase 5's scope. Produce a plan a future session can
execute directly — this document does not implement anything.

## 2. Current state — this is mostly execution, not design

Re-verified against `blaze` main (`5bc6ca9`) and the `blaze-pm-worktrees/v4-spine`
worktree, 2026-09-23. **The architecture is already decided and largely already built.**
What follows is what exists today, so the rest of this document can focus on what's
actually missing.

**Already decided (ADRs, accepted, on main):**

| ADR | Decision |
|---|---|
| 0006 | Database is the sole source of truth; the three-layer id allocator "approximates one UNIQUE constraint" |
| 0009 | The read seam is query-shaped |
| 0010 | The v3 storage port is async; the fs seam is not |
| 0011 | Database clients are optional peer dependencies |
| 0012 | SQLite and Postgres are both certified drivers — conformance suite + dual-write soak + zero divergences is the bar for certifying a driver |
| 0014–0018 | Tenancy deferred; gate mechanics; Node stays; requirement quality enforced; custom fields are hybrid typed-columns-plus-JSON-tail |

**Already built (real files on `main`, not drafts):**

- `scripts/model/write-port.mjs` (BLZ-293) — a filesystem adapter, a database adapter,
  and a **dual-write mode that already proves the two agree on every operation**. Its own
  header states the plan this document formalizes: "flipping the default then becomes a
  one-line decision backed by evidence, taken deliberately in Phase 2 (BLZ-254)." This is
  not a design choice this document makes — it's already implemented, unused.
- `scripts/model/pg-schema.mjs` / `sqlite-schema.mjs` — the full `ticket` table (both
  dialects, `DB_SCHEMA_VERSION` 4), plus `ticket_link`, `acceptance_criterion`,
  `ticket_label`, `ticket_component`, `worklog_entry`, `ticket_event`. Informed by a real
  prior dual-write soak (BLZ-295) that found 926 of 2,561 tickets (36.2%) carrying at
  least one of eight fields with no column at the time — all eight are columns now.
- The entire v4 spine schema layer the companion design specifies —
  `artifact-schema.mjs`, `document-schema.mjs`, `hierarchy-schema.mjs`, `link-schema.mjs`,
  `coverage.mjs`, `gates.mjs`, `wording-lint.mjs`, `matrix.mjs`, `ref-allocator.mjs`,
  `staleness.mjs` — all merged (BLZ-310–320, 330–337).
- `ticketValue()` / `canonical()` in `write-port.mjs` — a value-level ticket comparator,
  already built for **ongoing dual-write divergence detection** (ticket-by-ticket, live).
- **`blaze db init`** (BLZ-299/BLZ-280, `scripts/db-runner.mjs` + `scripts/migrate/load-corpus.mjs`)
  — a shipped, tested CLI command that loads the entire live corpus into a shadow SQLite
  database, tallies tickets/links/criteria/worklog/labels/components, names every
  substitution and skip explicitly, and its own log output already instructs "Now run the
  board with `BLAZE_WRITE_PORT=dual` to soak it." §3 and §4 execute this, not build it.
- **`scripts/migrate/zero-diff.mjs`** (BLZ-281) — the **one-time migration-correctness
  oracle**, already built and already doing exactly what §4 originally proposed building:
  it separates `valueDiffs` (data loss — must be zero) from `byteDiffs` (field-order noise
  — informational), citing the same 137-of-2,534 field-order finding BLZ-254's AC names.
  It is not wired to a CLI command yet — see §4.
- **`scripts/model/ac-blocks.mjs` + `scripts/migrate/ac-oracle-matcher.mjs`** (BLZ-296,
  merged `fdefca0`) — the case-insensitive AC-heading matcher this document's first draft
  called "still needed." It is not: `HEADING_EXACT` already matches any casing and 1–3
  heading levels, and `ac-oracle-matcher.mjs` is a **second, independent** matcher
  instance the importer doesn't share — satisfying BLZ-253's own "different matcher on
  each side" requirement already.

**A correction made during this brainstorm, recorded so it isn't repeated:** the
`blaze` engine repo carries two local, unpushed, never-merged branches
(`BLZ-306-v4-document-model`, `BLZ-307-v4-traceability-enforcement`, both dated
2026-08-22) that were initially read as stranded, unshipped work implementing BLZ-310–320.
They are not. Every file they contain has a corresponding, more advanced version already
on `main` (main's `artifact-schema.mjs` is their version plus a later-extracted shared
`dialect()` helper and the BLZ-332 custom-fields JSON-tail column). These two branches,
plus `BLZ-308-v4-fields-baselines-api` (zero commits beyond what's already on `main`),
are superseded duplicates of already-shipped work. **Delete all three** — there is
nothing in them not already on `main` in a better form.

**A pattern worth naming, not just working around — this happened three times in one
session, not one:** board/ticket status materially lagged real code state on `main`
every time this document's own author checked. (1) The three stale branches — initially
misread as the opposite of their true state: actually done-on-board, done-and-superseded-
in-code via different commits, not unmerged. (2) BLZ-253 ("Phase 1", board status
`in-progress`), whose storage-adapter deliverables are substantially complete. (3) **This
document's own first draft** claimed the migration script, the oracle, and the AC-heading
fix were "not yet built" — all three already exist, merged, tested (BLZ-280/281/296), and
were found only because a second research pass happened to grep for them before the plan
shipped. **Recommend a board-vs-`main` reconciliation pass for BLZ-253 and BLZ-310–320 as
a small tracked item** (§8) rather than treating this document's read of `main` as the
reconciliation itself — a reconciliation is a board-write action and belongs with
`blaze-board-operator`, not with a design document. Anyone executing the plan this
document leads to should independently re-verify §2's tables against `main` before
trusting them, rather than compounding a fourth instance of the same pattern.

**Not yet built — this is what BLZ-254 actually still requires, corrected against the
real inventory above:**

1. The dual-write soak has not been *run* against production traffic — the mechanism
   (`blaze db init`, `BLAZE_WRITE_PORT=dual`) is built; only the operational run and its
   recorded evidence are missing.
2. `zero-diff.mjs`'s oracle is not wired to a CLI command or run against the live corpus
   — the oracle logic itself is built; what's missing is a driver invoking it against
   `blaze db init`'s shadow database and the real corpus, and recording the result.
3. `missingClaimErrors()` / its `errors` channel in `buildIndex` (`index.mjs:137-162`)
   still exists and is still called from the read path.
4. `commit-lock.mjs`, the pending ledgers, `claims.mjs` (the three-layer id allocator),
   `commit-or-queue.mjs`, and the daily squash-flush CronJob are all still live.
5. The six governance scripts are still bespoke Python/JS with no DB-backed successor.
6. `.blaze/pending/` has not been flushed ahead of a migration.
7. BLZ-309/324's artifact-migration script (`migrateArtifacts`) does not exist yet —
   confirmed by search; unlike items 1–2, this one genuinely has no prior art.

## 3. The dual-write soak

**Bar: `BLAZE_WRITE_PORT=dual` against production traffic for one week, zero
divergences**, reusing ADR-0012's own driver-certification bar rather than inventing a
new one — this is re-certifying the *already-certified* Postgres/SQLite drivers' behavior
under the live corpus's actual write shape, not certifying a new driver, but the bar that
already exists is the right one to reuse rather than justify a weaker substitute.

**Rollback path, for the duration of the soak only:** dual-write is itself the rollback
mechanism. If a divergence or defect surfaces, flip back to filesystem-only — nothing to
restore, because git was never stopped as a write target during the soak. **Once the soak
passes and the default flips to database-primary, dual-write ends and git write access is
removed in the same change** (§5) — there is no rollback path after that point, and this
document states that plainly rather than leaving it implied. If a defect surfaces after
cutover, the fix is forward against the database, not a reversion to git.

**Before the soak starts:** flush `.blaze/pending/` (BLZ-254's own AC) — it's gitignored,
exists on one machine, and evaporates on a reimage. A soak that starts with an unflushed
queue is measuring divergence against an incomplete baseline.

## 4. Migration-correctness oracle

**Use the existing `scripts/migrate/zero-diff.mjs` (BLZ-281), not a new comparator.**
This document's first draft proposed building a value-level comparator to replace "empty
`git diff`" — that comparator already exists, already separates `valueDiffs` (data loss,
must be zero) from `byteDiffs` (field-order noise, informational), and already cites the
same 137-of-2,534 finding BLZ-254's own AC names. It also already accepts an optional
`criteriaFor` callback that compares acceptance criteria using
`ac-oracle-matcher.mjs` — a matcher **independently written from the importer's** (per
BLZ-253's AC requirement that the two sides of the oracle not share a blind spot), and
the underlying case-insensitive heading match (BLZ-296, `ac-blocks.mjs`'s `HEADING_EXACT`)
is also already merged. There is no remaining parser defect gating this oracle — §2's
correction on this point stands.

**What's actually missing is operational, not a parser fix:** `zero-diff.mjs` is proven
by its own test suite (`ac-oracle.test.mjs`, `date-migration-oracle.test.mjs`,
`oracle-field-coverage.test.mjs`, `transitions-and-oracle.test.mjs`) but has never been
run as a driver script against the **real, current, full live corpus** loaded via
`blaze db init` — only against fixtures and historical snapshots. §9's plan is: run
`blaze db init` to load the live corpus into the shadow database, then call `zeroDiff()`
with `fsReadStorage` as the source and the shadow database as `loaded`, over every ticket
id, and assert `report.valueDiffs.length === 0`. `blaze audit` against the migrated
corpus separately reports zero hard findings (BLZ-254's own AC).

**`ticketValue()`/`canonical()` in `write-port.mjs` remain relevant, but for a different,
narrower job:** they're the *live* dual-write divergence detector (§3, ongoing, one
ticket at a time as writes happen), not the *one-time* corpus migration oracle (this
section, `zero-diff.mjs`, run once against the whole corpus at migration time). Keeping
these as two separate mechanisms is correct, not an inconsistency to resolve — they check
different things at different times, and `zero-diff.mjs` already existing is exactly why
this document doesn't need to build a second one that does the live-comparison job badly.

## 5. Concurrent-write guarantee and the fate of git-era mechanisms

**The property BLZ-254's AC requires — two agents on two machines each creating 50
tickets concurrently, zero id collisions, zero lost writes, zero manual reconciliation —
is what a database `UNIQUE`/primary-key constraint gives for free**, per ADR-0006's own
framing of the allocator as 250+ lines of machinery approximating one constraint. Once
the database is the sole write target, id assignment is `INSERT ... RETURNING id` (or
equivalent) under the `ticket(project_key, num)` uniqueness the schema already declares —
there is no allocation step to race.

Each git-era mechanism named in BLZ-254's AC, stated individually per this document's own
verification requirement (no "not yet decided" survives to the plan):

| Mechanism | Fate |
|---|---|
| `commit-lock.mjs` | **Deleted.** No write path takes a git lock once git isn't a write target. |
| Pending ledgers (`.blaze/pending/*.jsonl`, `.blaze/pending-commit.jsonl`) | **Deleted**, after the pre-soak flush (§3) drains them for the last time. |
| Three-layer id allocator (`claims.mjs`) | **Deleted**, replaced by the DB's own uniqueness constraint. |
| `missingClaimErrors()` / its `errors` channel in `buildIndex` | **Deleted in the same change**, per BLZ-254's own AC — `index.mjs:137-162` reads the claims ledger on the render path, not just the write path, so deleting the allocator alone breaks board rendering. |
| `commit-or-queue.mjs` | **Deleted.** It exists to decide which files a write should `git add`; once the database is the write target there is nothing to stage. |
| Daily squash-flush CronJob | **Deleted, not suspended** (BLZ-254's own AC) — a suspended job is a live temptation to re-enable it as a workaround the next time something looks wrong. |

## 6. Governance script re-homing

| Script | Re-homing |
|---|---|
| `duplicate_id_check.py` | Made structurally impossible by the DB's own `PRIMARY KEY`/`UNIQUE` constraints — no runtime check needed. |
| `config_drift_check.py` | Becomes a `blaze audit` check against `blaze_config`/config-schema tables (already merged, BLZ-377). |
| `terminal_parent_scan.py` | Becomes a `blaze audit` check — a query over `ticket.status`/`ticket.parent_id`, not a tree walk. |
| `empty_body_scan.py` | Becomes a `blaze audit` check — a `WHERE btrim(body) = ''` query. |
| `parent_rules.mjs` | Becomes a `CHECK` constraint or a write-time trigger, per the parent-type rule table the engine already validates on `new`/`edit` — the DB enforces what the write path already enforces, rather than a third place needing to agree with the other two. |
| `build_matrices.py` | Becomes a generated view, using the `view`/`view_type` machinery BLZ-377 already installed (`view-schema.mjs`, `viewDdl`) rather than new infrastructure. |

(`metadata_audit.py` stays out of scope, per BLZ-254's own AC — retired by `ec02b625`
BLZ-240.)

## 7. BLZ-309/324 — the v4 artifact migration

Executes the companion design's §6 exactly as specified there, now that this document
specifies its stated prerequisite. Sequenced **strictly after** §3's soak passes and the
default flips (BLZ-309's own AC: "a document has no status directory, so the filesystem
write port cannot represent it at all"). Confirmed via search (§2, item 7): unlike §4's
oracle, no `migrateArtifacts`-shaped script exists yet — this is genuinely new work, not
another instance of the pattern in §2. BLZ-324's own AC already specifies `diff` against
`docs/matrices/requirements.md` as zero, which this document endorses rather than
replaces.

## 8. Phase 5 — retirement

**No new ticket.** The 2026-08-31 plan
(`docs/superpowers/plans/2026-08-31-blaze-app-adoption-and-import-standard.md`) already
answers this in full and nothing found during this brainstorm contradicts it:

- **Q4, already answered by the operator:** `blaze-pm` is archived on GitHub as
  read-only and kept indefinitely — never deleted, no history-migration code written.
- **§6's retirement criterion, already written, reused as-is:** corpus export diff
  (database vs. `blaze-pm`) is empty; ticket count matches exactly (re-derive from
  2,497 at cutover time, not from this document); every link resolves, `blaze audit`
  reports `ok=true` both scoped and unscoped; Q4 is executed, not merely decided; the
  queued-ops store is empty or explicitly accounted for.

Phase 5 is therefore a checklist against an already-written test, not a design decision —
executing §6 *is* Phase 5. State this explicitly rather than reopening a question the
operator already settled.

## 9. Sequencing

1. Flush `.blaze/pending/` (all machines).
2. Run `blaze db init` against the live corpus; run the dual-write soak,
   `BLAZE_WRITE_PORT=dual`, one week, zero divergences (§3).
3. Run `zero-diff.mjs`'s oracle against the shadow database and the live corpus (§4);
   zero `valueDiffs`; `blaze audit` clean.
4. Flip the default write port; delete the six git-era mechanisms in one change (§5).
5. Re-home the six governance scripts (§6) — can run in parallel with steps 2–4, since
   none of them depend on the cutover having landed.
6. Build `migrateArtifacts` and migrate requirement/architecture tickets into the v4
   artifact model (§7, BLZ-309/324) — the one step in this sequence with no prior art.
7. Execute the Phase 5 retirement criterion (§8); archive `blaze-pm`.

Steps 1–4 are BLZ-254 itself. Step 5 is independent and may run earlier. Step 6 is
BLZ-309/324, hard-blocked on step 4. Step 7 is Phase 5, hard-blocked on step 6 (the
corpus-diff criterion needs the v4 migration done to be meaningful for
requirement/architecture tickets).

## 10. New tracked work

BLZ-254, BLZ-309 and BLZ-324 already exist with acceptance criteria this document
endorses rather than replaces — **no new feature-level ticket is needed.** Three small
items surfaced during this brainstorm that aren't covered by an existing ticket:

1. **Reconcile board status against `main` for BLZ-253 and BLZ-310–320** (§2) — the board
   shows these as `in-progress`/`done` in a way that undersells or (per the corrected
   finding) doesn't quite match actual code state; a `blaze-board-operator` pass should
   verify and correct, not a design document's read of `git log`.
2. **Delete the three superseded local branches** in the `blaze` engine repo
   (`BLZ-306-v4-document-model`, `BLZ-307-v4-traceability-enforcement`,
   `BLZ-308-v4-fields-baselines-api`) — confirmed superseded, per §2.
3. **Write a small operational driver script that runs `zero-diff.mjs`'s oracle against
   `blaze db init`'s shadow database and the live corpus, and records the result** — the
   oracle itself is built (§4); only this driver and its evidence record are missing.
   Right-sized as a subtask of BLZ-254 rather than its own ticket.

Whether to file (1) as a ticket now, or hand it directly to a `blaze-board-operator`
dispatch without a ticket wrapper, is left to whoever executes this plan — both are
consistent with house convention for a small reconciliation pass. (2) and (3) don't need
tickets: (2) is a local branch deletion, (3) already has a home on BLZ-253.

## 11. Verification this document itself meets its own brief

- Names a concrete oracle (§4), not "empty git diff" — states why it's trustworthy
  (already the dual-write divergence detector, already exercised in production).
- States the fate of every named mechanism individually (§5) — no "not yet decided."
- States Phase 5's ticket status explicitly, with the reason (§8) — deferred to an
  already-answered question, not left open.
- Sequencing is explicit and dependency-ordered (§9), not stylistic.
