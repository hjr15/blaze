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
  already built for dual-write divergence detection. §4 reuses it as the migration
  oracle rather than building a second comparator.

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

**A pattern worth naming, not just working around:** this is the second time in this
session that board ticket status materially lagged real code state on `main` — first the
three stale branches (initially misread as the opposite: done-on-board, unmerged-in-code;
actually done-on-board, done-and-superseded-in-code, just via different commits), second
BLZ-253 ("Phase 1", board status `in-progress`) whose own worklog and the schema files
above show its storage-adapter deliverables are substantially complete. **Recommend a
board-vs-`main` reconciliation pass for BLZ-253 and BLZ-310–320 as a small tracked item**
(§8) rather than treating this document's read of `main` as the reconciliation itself —
a reconciliation is a board-write action and belongs with `blaze-board-operator`, not with
a design document.

**Not yet built — this is what BLZ-254 actually still requires:**

1. The dual-write soak has not been run against production traffic.
2. No migration script exists to move the live 2,497-ticket corpus into the `ticket`
   table (distinct from BLZ-309/324's requirement/architecture-into-artifact migration).
3. The migration-correctness oracle is broken as specified (empty `git diff`) and unfixed.
4. `missingClaimErrors()` / its `errors` channel in `buildIndex` (`index.mjs:137-162`)
   still exists and is still called from the read path.
5. `commit-lock.mjs`, the pending ledgers, `claims.mjs` (the three-layer id allocator),
   `commit-or-queue.mjs`, and the daily squash-flush CronJob are all still live.
6. The six governance scripts are still bespoke Python/JS with no DB-backed successor.
7. `.blaze/pending/` has not been flushed ahead of a migration.

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

**Replace "empty `git diff`" with value-level comparison via the existing
`ticketValue()`/`canonical()` functions in `write-port.mjs`.** These already normalize
field order and treat `links` as an unordered set of `(type, target)` pairs. They are not
new: BLZ-295's prior soak already exercised this exact comparator against real production
data and found the eight-field gap fixed in §2's schema — it is proven against the live
corpus's actual shape, even though §3's forthcoming soak (using the *current* schema) has
not yet run. Reusing it here means the migration oracle and the soak's own pass/fail check
are the *same* code, not two comparators that can silently disagree with each other.

This resolves the 137-of-2,534-tickets field-order failure named in both BLZ-254's AC and
BLZ-253's AC (`serializeTicket` normalizes to `FIELD_ORDER`; on-disk files preserve
authored order — a byte diff was never going to pass, independent of migration
correctness) and BLZ-253's separate, still-open case-sensitive AC-heading-match defect
(153 tickets spell `## Acceptance criteria` lower-case; a case-sensitive importer drops
their AC content silently, and a byte-diff oracle would not catch it even if the field-
order problem were fixed). **Both defects must be fixed in the shared parser/serializer
before the oracle is trustworthy — fixing only the comparator and not the 153-ticket
parsing gap would make the oracle pass while silently dropping data**, which is the exact
failure mode BLZ-253's AC was written to prevent.

**Migration acceptance, concretely:** for every ticket in the pre-migration tree,
`ticketValue(loadFromFilesystem(id)) === ticketValue(loadFromDatabase(id))`, run over the
full corpus, zero mismatches, re-run after the AC-heading fix lands. `blaze audit` against
the migrated corpus reports zero hard findings (BLZ-254's own AC).

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
write port cannot represent it at all"). Uses the same `ticketValue`-style value
comparison as §4, but against the derived matrix rather than the raw ticket — BLZ-324's
own AC already specifies `diff` against `docs/matrices/requirements.md` as zero, which
this document endorses rather than replaces.

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
2. Fix the 153-ticket case-sensitive AC-heading parser gap (shared by BLZ-253's own AC).
3. Run the dual-write soak, one week, zero divergences (§3).
4. Migrate the corpus using the `ticketValue`-based oracle (§4); `blaze audit` clean.
5. Flip the default write port; delete the six git-era mechanisms in one change (§5).
6. Re-home the six governance scripts (§6) — can run in parallel with steps 3–5, since
   none of them depend on the cutover having landed.
7. Migrate requirement/architecture tickets into the v4 artifact model (§7, BLZ-309/324).
8. Execute the Phase 5 retirement criterion (§8); archive `blaze-pm`.

Steps 1–5 are BLZ-254 itself. Step 6 is independent and may run earlier. Step 7 is
BLZ-309/324, hard-blocked on step 5. Step 8 is Phase 5, hard-blocked on step 7 (the
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
3. **Fix the 153-ticket case-sensitive AC-heading parser gap** — currently an open item
   on BLZ-253's own AC, not new work, but worth calling out here since §4's oracle
   depends on it being fixed before the oracle can be trusted.

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
