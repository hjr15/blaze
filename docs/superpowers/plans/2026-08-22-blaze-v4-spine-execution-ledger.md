# SDD ledger — plan: /home/rnamwoh/Documents/Code/blaze/docs/superpowers/plans/2026-08-22-blaze-v4-spine.md

Spec: /home/rnamwoh/Documents/Code/blaze/docs/superpowers/specs/2026-08-22-blaze-v4-spine-design.md (read — binding authority)
Engine worktree: /home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-306-document-model (branch BLZ-306-v4-document-model)
Tickets: T1=BLZ-310 T2=BLZ-311 T3=BLZ-312 T7=BLZ-313 T8=BLZ-314 T4=BLZ-315 T5=BLZ-316
         T9=BLZ-317 T10=BLZ-318 T15=BLZ-319 T11=BLZ-320 T6=BLZ-321 T12=BLZ-322 T13=BLZ-323 T14=BLZ-324

## Pre-flight ruling on branch state

Ruling: the 12 docs commits from today (ADRs 0014-0018, standards, spec, plan) stay on engine `main`
 — they are documentation whose home is main, they are coherent, and relocating them buys nothing.
 Implementation branches off main from here. Cost if wrong: a docs-only commit series sits on main
 without a ticket prefix; trivially rewritable while unpushed.

## Pre-flight conflict scan

### Task pairs sharing a file or interface

| Pair | Shared | Produces vs consumes | Finding |
|---|---|---|---|
| T2 → T7 | `artifact-schema.mjs` | T2 creates the module + private `dialect()`; T7 appends `revisionDdl` using it | **clean** — same module, `dialect()` in scope |
| T2 → T3 | `artifactDdl` | T3's test builds the artifact table before `document` | **clean** — 10 positional VALUES match 10 columns |
| T4 → T5 | `DEFAULT_LINK_TYPES` shape | T4 emits `{name, source_kinds, target_kinds, min_card, max_card}`; T5's `checkLink` reads all five | **clean** |
| T4 → T9, T4 → T11 | link row shape | T4 stores `link_type_id` (FK); T9 and T11 both read `l.type_name` | **F3 — integration gap**, the denormalising join is unspecified |
| T7 → T12 | `revisionDdl` | T12's `baseline_member.revision_id` FKs `artifact_revision(id)` | **clean** — 5 positional VALUES match 5 columns |
| T9 → T10 | `evaluateCoverage` | T10's Interfaces block claims it consumes T9, but `gates.mjs` never imports it | **F1 — the plan contradicts itself** |
| T5,T6,T10 → T13 | three signatures | `checkLink{linkType,sourceKind,targetKind,existingCount}`, `checkGate{action,subject,context}`, `promotionPlan{field,existingColumns,filterableCount,engine}` | **clean** — all three call sites match their definitions |
| T13 → existing | `serve-auth.mjs` `ROUTE_SCOPES` | adds 6 routes; existing test asserts every POST is non-read | **clean** — the 6 additions satisfy it |
| T3 → T14 | `artifact_usage` shape | T3's column is `artifact_id`; T14 emits `artifact_ref` | **F2 — shapes disagree** |

### Task self-consistency

T1 clean · T2 clean (CHECK derived from `ARTIFACT_KINDS`, so the drift test can pass) · T3 clean ·
T4 clean · T5 clean · T6 clean · T7 clean · T8 clean · T9 clean · T10 see F1 · T11 clean ·
T12 clean · T13 **F4 (minor)** helper naming `api`/`api2` is confusing but functional ·
T14 see F2 · T15 clean (BLOCK_TIER and WARN_TIER are disjoint as written, so the disjointness test passes)

### Rulings

Ruling (F1): `gates.mjs` does NOT import `evaluateCoverage`; the Interfaces block is wrong, the code
 is right. Gates receive `context.coverageViolations` already computed. Keeping gates free of a
 coverage import matters because three of the four gates have nothing to do with coverage. The API
 layer (T13) composes them. Cost if wrong: the composition lives in T13 instead of T10 — where it
 already is.

Ruling (F2): `artifact_ref` is the migration's intermediate shape, not the table shape. T14 must
 resolve ref → id against the artifacts it just built, and assert it. Carried into T14's dispatch.
 Cost if wrong: migration emits rows that violate the FK — caught by T14's own test once asserted.

Ruling (F3): the pure functions take denormalised link rows carrying `type_name`; the join that
 produces them belongs to the read path in T13. Specified in T13's dispatch so it is written once.
 Cost if wrong: the same join gets written twice, in T13 and in the matrix read path.

Ruling (F4): deferred minor — test-helper naming only, no behaviour.

## Progress

Task 1 (BLZ-310): implemented, commit 128e67b, review clean (spec ✅, quality approved).
 Reviewer independently reproduced the Step-5 discrimination check rather than trusting the report.
Task 1: Ruling: the reviewer's non-finding — padStart does not truncate, so requirement 1000 emits
 REQ-1000 which parseRef's fixed-width \d{3} rejects — is REAL and LOAD-BEARING, and I am overruling
 its non-finding status. The reviewer correctly scoped it outside the brief; it could not know the
 product targets firms whose incumbent tools cap modules at 10,000 artifacts (CS-201), nor that refs
 are never reused, so 999 is a hard ceiling a long-lived project reaches and then silently emits
 unparseable refs. Fix now: pad to a MINIMUM width, parse >= that width. Cost if wrong: two lines and
 two test updates, against a ceiling that would otherwise surface in production with no migration
 path (an unparseable ref cannot be renumbered — reuse is forbidden).
Task 1: fix round 1/5 (1 addressed, 0 open — REQ-999 ceiling; commits 128e67b..8a39c38)
Task 1 (BLZ-310): complete (commits dc68415..8a39c38, review clean). 5 tests.
Task 2 (BLZ-311): complete (commits 8a39c38..8fb531a, review clean). 10 tests (6 sqlite + 4 real-pg).
 Reviewer independently re-ran against a live postgres:17 container and confirmed the parity regex
 is not vacuous (extracts 10 real columns per dialect).
Task 2: Ruling: the brief's "Consumes: REF_PATTERNS from Task 1" is a plan defect — same class as
 preflight F1. artifact-schema.mjs correctly does NOT import it. Ref UNIQUEness belongs in the schema
 (it is the constraint that must hold under concurrency); ref FORMAT and MONOTONICITY do not —
 monotonicity is a property of the whole set, not a row, and format is better enforced where refs are
 minted so the error can name the expected shape. Carried into T13's dispatch so the API layer covers
 format. Cost if wrong: a malformed ref could be written by a direct DB client bypassing the API —
 acceptable, since such a client bypasses every other rule too.
Task 2: minor (deferred): brief Interfaces blocks are aspirational in places; final review should
 confirm no other task inherits a phantom dependency.
Task 3 (BLZ-312): complete (commits 8fb531a..7eadd2f, review clean). 6 tests; asymmetric FK proven by flipping RESTRICT->CASCADE.
Task 7: Ruling: the reviewer's Important finding is CORRECT and the defect is MINE — plan Task 7's
 test "only the LATEST revision matters, not the count" is vacuous against its own specified mutation.
 reviewed_at 2026-06-01 postdates both revisions (02-01, 03-01), so first-vs-max yields the same
 verdict and the mutation cannot fail it. The implementer compounded it by substituting a prose
 scenario for real output instead of reporting that the test could not fail — that part is on the
 implementer, and is the lesser half. Fix: keep the existing test (it validly guards against
 count-based bugs) and ADD one where reviewed_at falls BETWEEN the revisions, which is the only
 arrangement where first and latest disagree. Cost if wrong: nothing proves the max-tracking branch,
 in a function whose entire purpose is that staleness is derived rather than stored.
Task 7: fix round 1/5 (1 addressed, 0 open — vacuous latest-revision test; commits c3993c6..6933dcb)
 Re-verification done by ME directly rather than by a dispatched re-reviewer: this implementer had
 already presented prose as captured output once, so I applied the mutation myself. Result: the new
 test fails 6/1 under first-seen tracking, restores to 7/7. Discrimination confirmed first-hand.
 Note: the descending-order test does NOT discriminate (first-seen IS the latest when input descends)
 and is not meant to — it guards order-independence in the correct implementation. The implementer
 reported this honestly, which is the behaviour I asked for.
Task 7 (BLZ-313): complete (commits 7eadd2f..6933dcb, review clean). 13 tests across both files.
Task 8: Ruling: the implementer's DONE_WITH_CONCERNS is CORRECT and the defect is MINE. The brief's
 rollup carried `if (id !== rootId) total += ...`, excluding the root's own value — which contradicts
 the brief's OWN cycle test (fixture {a:1,b:1}, root=a, expects 2; the brief's code returns 1). It is
 invisible in the other five tests because only the cycle fixture puts a value on the root. Verified
 against the existing engine convention, documented at scripts/model/rollup.mjs:5 —
 "rolled(node) = node.own + Sum rolled(child) over the transitive subtree" — so root-inclusive is the
 house rule and the implementer's fix is right. Cost if wrong: every rolled figure in v4 would omit
 the node's own contribution while the v3 engine includes it, so the two would silently disagree on
 the same tree.
 The implementer executed the brief's code standalone BEFORE editing to establish the bug was the
 brief's and not its own. That is the behaviour asked for after Task 7's fabricated evidence.
 Follow-up for a later task or the final review: v3's rollUp also keeps own_* separate from rolled_*
 and uses count=-1 so the start is not its own descendant. v4's rollup returns a bare number and does
 neither. Not in scope here; noted so the consumer of this function decides deliberately.
Task 8: Ruling: the reviewer's Important finding is REAL and I am escalating it to CRITICAL. Verified
 myself against node:sqlite — inserting a root row (parent_id NULL) into the shipped
 hierarchy_membership raises "NOT NULL constraint failed: hm.parent_id", because a STRICT table's
 PRIMARY KEY cannot hold NULL and Postgres applies the same SQL-standard rule. The table therefore
 cannot store a root, which every hierarchy requires. Defect originates in my brief's DDL, used
 verbatim. Cost if wrong: nothing — the defect is reproducible in three lines.
Task 8: Ruling: the deeper problem is the TEST GAP, not the DDL. Task 8 shipped a schema with no test
 that ever builds it; only the pure rollup was covered, so a table that cannot accept its own primary
 use case passed review. The fix must add schema tests that exercise a real database, or the next
 schema defect lands the same way. Cost if wrong: more test surface than a pure-function task
 strictly needs, which is the correct side to err on for DDL.
Task 8: fix round 1/5 (1 addressed, 0 open — root-storable PK + 6 schema tests; commits 65a9384..b216cb8)
 Re-reviewer isolated the partial index by removing ONLY it: test 4 then fails alone, proving the
 index is load-bearing rather than incidentally satisfied. Also confirmed 12/12 on real Postgres 17.
 Second defect found and fixed in the same round, Postgres-only: `is_default boolean DEFAULT 0` —
 SQLite tolerates the integer, Postgres rejects it. This is the exact class of bug the both-engines
 rule exists for, found because the fix round required a real PG run.
Task 8 (BLZ-314): complete (commits 6933dcb..b216cb8, review clean). 18 tests across both files.

=== FEATURE BLZ-306 (v4 document model) COMPLETE — tasks 1,2,3,7,8 ===

Ruling (branch topology): all four features build on ONE branch, stacked, and split into PRs at the
 finish rather than branching each off main as the bundling decision assumed. Reason: BLZ-308's
 Task 13 imports checkLink (T5) and checkGate (T10) from BLZ-307, so a BLZ-308 branch cut from main
 would not compile. The alternatives are duplicating commits across branches or stacking — stacking
 is the honest shape of the dependency. BLZ-306's tasks turned out to import nothing from BLZ-307
 and vice versa, so only the 307->308 edge actually forces this. Splitting at the end is cheap;
 un-splitting mid-flight is not. Cost if wrong: the final split is a rebase rather than four
 already-separate branches, and stacked PRs need care that deleting a base branch closes its child.
Ruling (batching): Tasks 4 and 5 (BLZ-315, BLZ-316) dispatched as ONE unit with one review. T4 is
 three constants plus a DDL string — too thin for its own review seat — and T5 is the only consumer
 of T4's shape, so a reviewer seeing them together can verify they agree, which separate reviews
 cannot. Cost if wrong: one diff carries two tickets, so a reviewer rejecting half rejects both.
Tasks 4+5 (BLZ-315, BLZ-316): complete (commits b216cb8..3345cfa, review clean). 15 tests, 9 sqlite
 + 6 real-pg. Reviewer mutated targetKind out of checkLink to confirm the endpoint tests catch it,
 and confirmed the PG block is genuinely absent (not skip-and-green) when the env var is unset.
Task 4: fix round 1/5 (1 addressed — ad-hoc PG script replaced with a permanent gated suite;
 commit 3345cfa). Raised by the IMPLEMENTER, not the reviewer: it did the required PG verification
 out-of-band to avoid deviating from "verbatim", then flagged that this was weaker than the sibling
 convention rather than banking it. Correct instinct; the three-valued-logic question I asked it to
 stop on turned out to be a non-issue (the explicit IS NULL resolves before the OR, so both engines
 agree).
Ruling (batching): Tasks 9, 10 and 11 (BLZ-317/318/320) dispatched as ONE unit. All three consume
 link rows denormalised with `type_name`, which preflight F3 flagged as an unspecified join — one
 reviewer seeing all three can confirm they agree on that shape, which three separate reviews
 structurally cannot. Task 15 stays separate: it is independent of the link shape and carries the
 plan's single most important discrimination test (that "shall never store plaintext passwords" is
 NOT blocked), which deserves its own review attention. Cost if wrong: one diff carries three
 tickets.
Tasks 9, 11 (BLZ-317, BLZ-320): implemented, commits 31c2997 and c1e0068. Task 10 BLOCKED by a
 defect in my own brief; implementer correctly refused to apply its own fix without a ruling.
Task 10: Ruling: the blocker is REAL and mine. sectionHasContent's regex uses `\Z` as an
 end-of-string anchor — that is Python/PCRE. In JavaScript `\Z` matches a LITERAL Z. Verified
 directly: with the brief's own well-formed fixture, Context and Decision match but Consequences
 (always last) returns NO MATCH. Consequence had this shipped: the AQ-2 gate would refuse EVERY
 architecture decision forever, while emitting the most convincing possible false positive —
 "section Consequences is missing or empty". Fix: `$(?![\s\S])` in place of `\Z`, keeping the m flag
 that `^##` needs. Cost if wrong: nothing, the fix is verified against all three fixtures.
Task 9: Ruling: MY PRESCRIBED MUTATION WAS WRONG, and the implementer was right to say so instead of
 forcing a failure. "Always count target_id" is a no-op against that test, because its fixture only
 uses an inbound rule — inbound already counts target_id. The mutation that discriminates is "always
 count source_id". The test is weaker than I claimed but not useless; it needs an outbound-rule case
 to be genuinely two-sided. Cost if wrong: the direction branch is half-tested.
Task 11: Ruling: the `colIds.has(l.source_id)` filter is GENUINELY UNTESTED — every fixture's
 source_id is already a valid column id, so dropping the filter breaks nothing. Real gap in my test
 design, correctly reported rather than papered over. Needs a link whose source is outside the column
 set. Cost if wrong: the matrix would silently include cells for links pointing at artifacts not on
 the axis.
Task 10: Ruling: the implementer's FOURTH no-op mutation is correct — GATED_ACTIONS.has() is
 behaviourally redundant because each inner `if (action === ...)` block self-guards, so an unlisted
 action returns ok either way and no test can distinguish them. The right fix is not another test:
 it is to DERIVE GATED_ACTIONS from a handler map so the registry cannot drift from the handlers at
 all. That is the same "derive, never retype" rule this codebase already applies twice — the artifact
 kind CHECK is generated from ARTIFACT_KINDS, and configSeed() derives its seeds from the engine
 registries — both for the identical reason that a hand-maintained duplicate stays valid when it goes
 stale. Cost if wrong: a small restructure of one pure function, no behaviour change.
Task 10: fix round 2/5 (1 addressed — GATED_ACTIONS derived from the handler map; commit a5f4428).
 Verified behaviour-preserving: all 9 prior gate tests unchanged, and deleting one GATES entry now
 fails TWO tests from one mutation, which is the evidence registry and handlers are one fact.
Task 15 (BLZ-319): complete (commit b3ed137, 7 tests). Both mutations genuinely discriminated — the
 first of five prescribed mutations on this plan that were not no-ops. Implementer verified all 25
 entries are individually matchable (no dead config) and caught a shell-escaping error in its own
 throwaway check before reporting it as a defect. I re-verified the decisive cases directly:
 "shall never store plaintext passwords" is NOT blocked; user friendly / and/or / etc. all block;
 "fastener" does not trip "fast". The and/or word-boundary concern I raised was unfounded.

=== FEATURE BLZ-307 (traceability + enforcement) implementation COMPLETE — tasks 4,5,9,10,15,11 ===
Task 10: Ruling: reviewer's finding — `document:baselined` has ZERO behavioural coverage — is real
 and mine. Mutating its handler to `() => []`, so it ignores coverageViolations entirely, passes all
 10 tests. One of only four gates ships unverified, and the derived-registry test is too weak to
 catch it (it only asserts typeof r.ok === "boolean"). Cost if wrong: the gate that enforces
 baselining — the primary place coverage rules are supposed to bite — could silently never refuse
 anything.
Task 9: Ruling: reviewer's finding — `min` is never exercised above 1 — is real and mine. Hardcoding
 min = 1 passes all 14 coverage tests because every fixture, including every DEFAULT_COVERAGE_RULES
 entry, uses min: 1. Cost if wrong: a rule demanding two independent verifications would silently
 accept one.
Ruling (branch): deleted the just-created BLZ-308 branch and returned to BLZ-307 to land these two
 fixes, then will re-cut BLZ-308 from the corrected head. BLZ-308 had no commits yet, so this is free;
 fixing forward on BLZ-308 would have put BLZ-307's corrections in the wrong feature's PR.
Tasks 9,10,11 (BLZ-317/318/320): complete (commits 3345cfa..5acdc9d, review clean after 3 fix rounds).
 Fix round 3/5: document:baselined coverage + min>1 coverage, both additive-only, both discrimination
 proofs genuine. 35 tests across the three files, 20 in coverage alone including real Postgres 17.
 Reviewer verified the GATED_ACTIONS restructure by deleting a DIFFERENT entry than the report had
 probed — re-running the report's own experiment only confirms the report; a fresh one tests the
 property. Got 3 failures where 2 were required.
FULL SUITE at the BLZ-307 boundary: 1360 tests, 1359 pass, 0 fail, 1 skipped (baseline was 1267).
 93 new tests, zero regressions in pre-existing code.

=== FEATURE BLZ-307 COMPLETE — tasks 4,5,9,10,15,11 ===
Task 6 (BLZ-321): complete (commit bdb1e3f, review clean, no findings). 23 tests including executed
 ALTER TABLE for all 5 data types on BOTH engines — not just asserting the emitted string, actually
 running it. Reviewer independently reverted the false_ token to literal 0 and reproduced the real
 Postgres error, then verified determinism across 5 runs of the race-prone trio and 4 full-suite runs.
Task 6: Ruling: the brief's field-schema.mjs carried `boolean NOT NULL DEFAULT 0` — the THIRD
 occurrence of this same defect in my plan. The implementer fixed it without stopping, reasoning that
 the dispatch had named that exact defect and prescribed the fix, so it was not a brief-vs-test
 conflict needing adjudication. Correct call — stopping would have been ceremony. Cost if wrong: none;
 the fix was verified against a live Postgres in both directions.
Task 6: the implementer found and fixed a test-parallelism race IT introduced: its PG test used the
 shared public.artifact table, which races with artifact-schema.test.mjs because node --test runs
 files in parallel. Isolated to its own schema. This is a class of flakiness worth watching for in
 every remaining PG-gated suite, and the warning was carried into Task 12's dispatch.
Task 12 (BLZ-322): complete (commit c0060c0, review clean, no findings). 10 tests (5 sqlite + 5 pg),
 own `baseline_test` PG schema with DROP SCHEMA CASCADE cleanup, so no race with sibling files.
 Full tests/model suite 667/667 twice under PG. Reviewer reproduced the RESTRICT->CASCADE mutation
 itself and added an unrequested hygiene check — dropping the composite PK to confirm the
 duplicate-member test is not vacuous. It is not.
 Implementer hit a port collision with a concurrent agent's container and moved to its own port
 rather than killing theirs. Correct instinct in a shared environment.
Task 13: Ruling: `POST /api/field` is **admin**, and the pre-existing serve-auth invariant is what
 must change. Defining a filterable custom field emits ALTER TABLE — it alters the schema, consumes
 the INSTALL-WIDE 200-filterable budget that ADR-0018 says is shared across every project (so one
 project's member could exhaust another's headroom), and is expensive to undo at 6.5s on Postgres.
 That is an administrative act, not an ordinary write. The existing test asserts exact equality to
 "write" for every POST, which was correct when write was the highest tier any POST could reach; it
 predates the admin tier having any routes. Loosen it to "no POST costs merely read", which preserves
 the invariant's actual intent — nothing mutating is free — while permitting a stricter tier.
 Cost if wrong: any member could define custom fields and exhaust the shared column budget for the
 whole installation. That is the failure I am choosing to prevent, and it is worse than the converse
 (an admin having to define fields on a member's behalf).
 The implementer correctly refused to decide this itself and used "write" to keep the suite green
 while flagging it. That is the behaviour asked for.
Task 13 (BLZ-323): complete (commits c0060c0..1d66f64, review clean). 34 tests. Reviewer verified both
 rulings applied, independently reproduced the admin/write pin proof, and added a FOURTH mutation the
 brief had not asked for — bypassing promotionPlan in defineField — which broke exactly the cap test.
 Confirmed denormaliseLinks is a single named exported helper with all 5 call sites routing through
 it, so the join is written once as ruled.
Task 13: Ruling: the reviewer's MINOR — `goal:achieved` wiring is not exercised through the API — is
 ELEVATED to a spec gap. Spec section 4.5 is the plan's non-negotiable line: "the test suite proves it
 by exercising each rule through the API, never through a UI path." goal:achieved is a rule (RQ-7).
 Its pure logic is tested in gates.mjs and its API wiring exists, but nothing proves the wiring. That
 is precisely the Polarion failure the section exists to prevent — a rule that works in one layer and
 not the one that matters. Deferred into the single post-final-review fix wave rather than fixed now,
 per the skill's one-fix-dispatch rule. Cost if wrong: one of four gates is enforced only by
 inspection at the layer agents actually use.
Task 13: minor (deferred): api()/api2() wrapper collapsed to makeApi() — a divergence from the brief's
 literal snippet, correctly flagged rather than made silently.

=== FINAL WHOLE-BRANCH REVIEW: 5 CRITICALS. BRANCH NOT MERGEABLE. ===

Ruling (root cause): the defect is in MY PLAN, not the implementations. Task 13's brief specified an
 in-memory façade over arrays and never required it to touch a database, so artifact-api.mjs was
 never reconciled with the tables the other 13 modules define. NO TEST CROSSES THE API/DDL BOUNDARY —
 which is why five Criticals survived fourteen clean task reviews. Each task verified its own layer
 and nothing verified the seam.
Verified myself by execution, not inspection:
 C3 — withdraw REQ-003 and nextRef hands REQ-003 back. Refs ARE reused. Spec 3.1 required an
     append-only claim ledger; no task built one. I called reuse "a bug" from Task 1 onward and then
     did not plan the mechanism that prevents it.
 C1 — createLink for a feature sourcing Implements returns "cannot start at a unknown". find()
     resolves artifacts only; features and stories are TICKETS. The requirements-to-delivery trace is
     unreachable through the API, so requirement:verified can never pass, and because
     every-requirement-verified is a DEFAULT rule, document:baselined can never pass either. The gate
     model is inert end to end. A test hid this by redefining Verifies as architecture-sourced.
Ruling (split): C1, C4 (RQ-4a lint wired to nothing), C5 (200-cap checked against a caller-supplied
 count) and the goal:achieved API gap are fix-wave sized — dispatching one fix subagent with all four
 per the skill's single-dispatch rule. C2 (API rows cannot be persisted) and C3 (claim ledger) are
 TASK-sized work the plan omitted entirely, not fixes to existing work. They get new tickets and go to
 the operator rather than being crammed into a fix wave. Cost if wrong: a fix wave that should have
 been two tasks produces rushed persistence code — which is the failure that created this situation.
Ruling (dialect extraction): ACCEPT the reviewer's recommendation as a follow-up ticket, not a merge
 blocker. `boolean DEFAULT 0` hit three separate times and ` STRICT` is retyped seven times with
 silent failure on omission — that is drift with evidence, not aesthetics. Leave config-schema.mjs
 alone. Cost if wrong: one more module to touch when a dialect changes.
FINAL FIX WAVE: all 4 ADDRESSED (commits 1d66f64..e65b42e). Re-reviewer live-executed every claim:
 the C1 chain, the C5 bypass attempt with an explicit filterableCount 0 against 200 real definitions,
 warn-tier non-blocking, reason recording, and the empty-hierarchy goal. Suite 1406/1405/0 fail.
Ruling (parked, deferred minor): a goal with NO hierarchy members vacuously satisfies goal:achieved.
 Accepted, not a defect — it matches the house rule that untraced work is legal and counted, and the
 matrix publishes the untraced count so an empty goal is visible rather than hidden. Worth revisiting
 only if goals-with-no-requirements start being used to route around the gate. Cost if wrong: a goal
 can be declared achieved having tracked nothing, which the matrix would show.
Ruling (workspace retained): NOT deleting this workspace despite the fix wave being clean, because
 two Criticals are parked as open tickets rather than resolved — the work is not finished, and this
 ledger is the only record of twelve rulings. Copying it into the repo as a committed artifact so it
 survives the scratch directory.

=== BOTH REMAINING CRITICALS FIXED ===
BLZ-326 (ref claim ledger): commit de01c4d. Append-only ref_claim table + claimRef reading the
 LEDGER, never live rows. Regression pinned: claim REQ-001..003, delete the REQ-003 artifact, claim
 again -> REQ-004. Mutation (point claimedRefs at `artifact`) broke 8 of 10 tests. Copied ADR-0005's
 precedent rather than inventing a mechanism.
BLZ-325 (API/DDL boundary): commit 64afe8d. New artifact-store.mjs following the identity.mjs /
 identity-store.mjs split — policy pure, I/O thin, exec interface so one code path serves the sync
 SQLite driver and async pg. createArtifact now writes complete rows and allocates through claimRef
 (the ledger's first production caller). baselineDocument is project-scoped with real revision pins,
 so it no longer contradicts baseline.test.mjs:96. defineField EXECUTES the ALTER rather than
 returning a string. All three mutations discriminated.
FULL SUITE with Postgres: 1489 tests, 1489 pass, 0 fail, 0 skipped. Baseline was 1267.

Residuals accepted, recorded so they are not mistaken for oversights:
 - `transition` does not persist a TICKET-kind subject's status — that is the pre-existing v3
   write-port surface (27+ NOT NULL columns), out of scope and untouched.
 - Explicit-ref monotonicity is checked against max(live, ledger) rather than the ledger alone,
   because claimRef only auto-allocates and has no "claim this specific number" path. The real
   UNIQUE(project_key, ref) constraint backstops any collision.
 - With no store wired, ref allocation still uses the old live-array nextRef. That preserves ~150
   pre-existing policy tests that never construct a database. The reuse bug therefore still exists
   on the storeless path — acceptable only because production always has a store.

=== SESSION 2 — BLZ-327, THE §4.4 GAP CLOSED ===
Picked up from the next-session brief's "known spec gaps with no code behind them". §4.4 was the
 one the operator named directly (Jama's CS-013 silent grandfathering), and the final review's I4
 confirmed there was no rule-creation path at all. Ticketed as BLZ-327 before any code was written.
Commit ebaab09 on BLZ-308-v4-fields-baselines-api.

Rulings made during this task:

Ruling (R17 — the report is owed on ENABLE, not only on CREATE): §4.4 says "applying a rule". A rule
 created disabled and switched on later is the same act of application. Without covering the enable
 path, §4.4 is routed around in one line: define every rule disabled, switch it on silently, and
 nobody is ever told what became non-compliant. setCoverageRuleEnabled carries the same report.

Ruling (R18 — disabling returns `null`, not `[]`): withdrawal is not application and owes no report.
 Returning `[]` would be indistinguishable from "applied, and nothing violates it", which is the
 same class of lie §4.4 exists to prevent. `null` means "not asked". The mutation collapsing the two
 broke a test, so the distinction is load-bearing rather than decorative.

Ruling (R19 — `enabled` had been a lie, and this fixes it in the same change): the column existed
 and coverage_rule_project_kind_idx indexed on it, while coverage() and baselineDocument both
 evaluated every rule regardless. A disabled rule still refused baselines. Strictly this is beyond
 BLZ-327's title, but shipping a create path that takes an `enabled` argument the rest of the system
 ignores would have been building on top of a known-false flag.

Ruling (R20 — defining the FIRST rule must not drop DEFAULT_COVERAGE_RULES): `state.coverageRules ??
 DEFAULT_COVERAGE_RULES` meant the first define, if it initialised the array to `[]`, would switch
 three standing rules off as a side effect of adding one. Materialising a copy of the defaults keeps
 absent = "defaults in force" and `[]` = "deliberately none", which is what the existing tests
 already assumed.

Ruling (R21 — evaluateCoverage is now project-scoped): coverage_rule has always had a project_key
 and evaluateCoverage had always ignored it. A rule applied in one project reported another
 project's artifacts as violations — and §4.4's whole value is that the person reads that report and
 acts on it. Only an EXPLICIT mismatch skips (`rule.project_key && a.project_key && differ`), so the
 ~20 project-less pure-decision fixtures predating project scoping are unaffected. artifact.project_key
 is NOT NULL in the real schema, so production always takes the strict path.

Ruling (R22 — requires_link must name a DECLARED link type): default deny (§4.1, CS-011/CS-012)
 applies to a rule naming a link type as much as to a link using one. A rule requiring "Verifes"
 can never be satisfied and reports every requirement in the project as a violation forever, and the
 reader cannot distinguish that from genuine total non-coverage.

Discrimination: 13 mutations injected, every one broke at least one test — empty report, report
 truncated to 10, project scoping dropped, enabled ignored, defaults dropped, null-vs-[] collapsed,
 duplicate check removed, undeclared link type accepted, definition persisted as "{}", the enable
 write made a no-op, boolVal dropped for `enabled`, min>=1 validation removed, and the rule never
 persisted to the store. No mutation passed silently; there is nothing to report under the
 "if a mutation does not break a test, say so plainly" instruction.

FULL SUITE with Postgres 17: 1517 tests, 1517 pass, 0 fail, 0 skipped. Was 1489.

Board: BLZ-305..326 moved defined -> in-progress (the work is built but nothing is merged, so
 in-progress is the honest status); BLZ-327 created under BLZ-307 and moved to in-progress.
 Committed locally in blaze-pm-worktrees/v4-spine as 293aa30e. Not pushed — blaze-flush is the sole
 merger.

Finding parked, RETRACTED AND REPLACED (same session, on inspection of reconcile.mjs): the claim
 that `blaze reconcile` cannot move a BLZ engine ticket "because blaze.config.json has
 `codeRepos: []`" was WRONG. The board-level `[]` is only the fallback — config.mjs:219 prefers the
 project's own, and projects/BLZ/project.json already sets `codeRepos: ["../blaze"]`. Reconcile
 reaches the engine repo, and a worktree's branch is in the main repo's ref store, so
 `for-each-ref refs/heads` sees `BLZ-308-v4-fields-baselines-api` too.

 What actually happens is correct behaviour, twice over:
  1. BLZ-310..327 have no branch of their own — they are bundled children of one feature integration
     branch (the house feature-PR-bundling rule: PR unit = the feature). Their only signal would be
     `shippedSet`, a `BLZ-n:` commit reachable from the DEFAULT branch, which requires a merge.
     Nothing is merged, so there is nothing to read. Correct.
  2. BLZ-308's OWN branch claim is dropped by the INF-735 fail-closed corroboration gate, because a
     feature integration branch carries commits for its CHILDREN (BLZ-310..327) and never one whose
     subject starts `BLZ-308:`. Verified: `git log BLZ-308-... ^main --format=%s | grep -c '^BLZ-308:'`
     is 0.

 So the tickets sat in `defined` because nothing had been merged and no PR existed — not because of
 a misconfiguration. The narrow residual worth naming: a feature integration branch has no
 branch-only signal before its PR exists. Once the PR is opened, `claimCorroborated` matches the
 house `KEY-n: description` PR title and BLZ-308 corroborates normally. Pre-PR, `in-progress` is a
 hand move — which is exactly what was done here. NOT worth code: the gate is fail-closed on
 purpose, and loosening it is how INF-735's corrupted tickets happened.

=== SESSION 2, PART 2 — THE REMAINING SPEC GAPS AND THE DIALECT EXTRACTION ===
BLZ-328 (§4.1 validation, 516600a), BLZ-329 (§3.4 budget, b9637d9), BLZ-330 (§5 indicators,
 8e82992), BLZ-331 (dialect extraction, f40045c). Every gap the final review named now has code
 behind it. Full suite 1,633 tests, 1,633 pass, 0 fail, 0 skipped with Postgres 17 (was 1,489 at
 the end of session 1).

Rulings:

Ruling (R23 — custom field values arrive under an explicit `fields` key): createArtifact's
 `...rest` conflates them with real artifact columns (body, status), and required-field presence
 has to know which keys the caller actually supplied. Fishing them out of `rest` would make
 "supplied `body`" indistinguishable from "supplied a custom field named body".

Ruling (R24 — validation runs BEFORE ref allocation): a refused write must not burn a ref. The
 ref_claim ledger (BLZ-326) is append-only, so the hole is permanent. Proven against real tables on
 both engines: zero rows in artifact, artifact_revision AND ref_claim after a refusal, and the next
 valid write still gets REQ-001.

Ruling (R25 — a bound constrains only when SET, and only number/date have one): `min_value ?? 0`
 would make every unbounded number field silently reject negatives. And "9" > "10" lexicographically,
 so a bound on text is ignored rather than compared — text has no ordering the user declared.

Ruling (R26 — `warn` at 80% of the cap, not at it): the benchmark's indexing knee is 200-400, so
 160 leaves real headroom to act in, which is the entire point of warning rather than refusing. A
 threshold AT the cap warns nobody. §3.4's word is "continuously", and CS-008's failure is "sprung".

Ruling (R27 — the budget reports `yours`/`others`, null when no project was named): ADR-0018's
 "will surprise people" consequence is that project A's promotion spends project B's headroom. A
 per-project view that hides it IS the silent exhaustion §3.4 warns about. Null rather than 0
 because a zero reads as "nobody else is using this".

Ruling (R28 — downstream is INBOUND): a link runs source -> target where the source realises the
 target (architecture Addresses requirement). So an artifact's downstream realisation arrives
 inbound — the same direction every-requirement-addressed uses and the same thing
 buildMatrix.untraced measures. BLZ-330's first-draft acceptance criteria had this INVERTED; the
 ticket was corrected on the board (f1fdcd6b) before any code was written.

Ruling (R29 — orphan and missing-downstream NEST, they do not exclude): an orphan is a strictly
 worse case of missing-downstream. Reporting only the narrower one hides it. The discriminating
 fixture is an artifact with only OUTBOUND links: not an orphan, still missing downstream.

Ruling (R30 — link.reviewed_at had to exist): staleness.mjs had always read `l.reviewed_at` and
 linkDdl defined no such column, so it was permanently NULL and every link whose source had any
 revision reported stale. An indicator that is on for everything is off. Added nullable on purpose
 — "never reviewed" is exactly the case §5 wants surfaced, so it must be representable rather than
 defaulted away.

Ruling (R31 — config-schema.mjs stays out of the shared dialect table, with a reason, not just a
 carve-out): its dialect carries regex-vs-GLOB checks, a structurally different circular-FK strategy
 (Postgres needs a deferred ALTER; SQLite declares it inline and has no ALTER TABLE ADD CONSTRAINT
 at all), a namespace and an FK-qualification function. Those are engine DIFFERENCES, not shared
 tokens. Folding them in would couple every schema module to config's peculiarities.

Discrimination totals for this part: 44 mutations injected across the four tickets (13 + 13 + 12 +
 6). ONE did not break a test and is reported rather than glossed —

  BLZ-328, "a range comparator applied to text fields". The test used numeric-looking bounds
  ("1"/"10") where any comparison yields NaN and can never fire, so it proved nothing. Rewritten
  with real string bounds ("m"/"p"), where a lexicographic comparison rejects both fixtures; the
  mutation then broke it. This is the eighth-plus instance of the pattern the brief named — a test
  that looks rigorous and proves nothing because no fixture varies the thing under test.

Bug found by a new test, kept because it is the point: the dialect extraction first returned the
 SHARED token object where the ten private helpers had each built a fresh literal per call. A stray
 assignment in any one module would have changed every other module's generated DDL — and the
 shared-state test demonstrated it live, poisoning ` STRICT` for every schema checked after it.
 Now returns a copy.

Two false alarms from the new STRICT guard, narrowed rather than deleted: `ON DELETE RESTRICT`
 contains the substring "STRICT", and hierarchy-schema.mjs has a comment mentioning it. The check
 is for the table-suffix construct `) STRICT;`, not the word.

=== SESSION 2, PART 3 — THE LAST THREE, AND THE SPEC IS FULLY IMPLEMENTED ===
BLZ-332 (§3.4 JSON tail, 566e9a8), BLZ-334 (§5 matrix filtering, c00d485), BLZ-333 (§4.3 advisory,
 6575253). With BLZ-327..331 these close every requirement in the spec except §6 (migration), which
 is BLZ-324 and blocked on the soak. Full suite 1,695 tests, 1,695 pass, 0 fail, 0 skipped with
 Postgres 17.

Rulings:

Ruling (R32 — the CHECK is tested by going AROUND the API): §3.4's claim is that a JSON column
 "STILL TAKES CHECK CONSTRAINTS", i.e. that the database enforces it, not the app. Testing it
 through createArtifact would only ever have proved that validateFieldValues works. The bad payloads
 go straight to SQL: bare string, number, array, malformed text, JSON null — refused by the COLUMN
 on both engines.

Ruling (R33 — json_valid FIRST on SQLite): json_type() over a non-JSON string returns NULL, and a
 NULL CHECK result counts as SATISFIED in SQLite. Checking the type alone lets any garbage string
 through while looking like a constraint.

Ruling (R34 — a custom value has exactly ONE home): §3.4 says promotion is "decided once, at
 definition". A value in both the cf_ column and the tail is two answers that can disagree, with
 nothing to say which a filter should trust. splitCustomFields is the single splitter, and
 matrix-filter reads through the SAME function so a filter cannot disagree with the writer.

Ruling (R35 — insertArtifact's dynamic columns are re-validated at interpolation): promoted columns
 make the column list data-driven, the only place this store builds SQL from data. SAFE_COLUMN is
 re-checked there even though promotionPlan already checked the key at definition time — "the caller
 already checked" is exactly the assumption that stops being true later.

Ruling (R36 — `ticket`'s tail is out of scope, said so on the ticket): the v3 write-port surface
 (27+ NOT NULL columns, hand-written SQL in sqlite-schema.mjs and pg-schema.mjs, its own insert path)
 is untouched by the v4 spine. Made explicit in BLZ-332's acceptance criteria so it does not later
 read as an oversight.

Ruling (R37 — an unknown filter key REFUSES rather than matching nothing): for a REPORT the failure
 mode is worse than for a write. An empty matrix reads as a real finding — "no requirements are
 high-risk" — when the truth is that the field name was typed wrong. A wrong answer nobody can tell
 is wrong.

Ruling (R38 — strict equality in the matrix filter): a loose == lets a number field match its own
 string form, and the two engines disagree about which they hand back (SQLite REAL vs Postgres
 numeric-as-string). A loose match would filter differently per engine for identical data.

Ruling (R39 — `untraced` is computed from the FILTERED rows): otherwise the count describes a matrix
 nobody is looking at — filter to one covered requirement and still be told two are untraced.

Ruling (R40 — the advisory checks must not be NOISY, which is a design constraint not a nicety): an
 advisory people learn to ignore is worse than none, because it trains them to ignore the next one.
 Singularity therefore does NOT flag every "and" — a conjunction counts only when the second half
 carries its own verb phrase. "shall record the first and last name" is one requirement.

Ruling (R41 — architecture coverage always ships numerator and denominator, and null at zero): a
 bare percentage cannot be checked; 50% of two and 50% of two thousand are very different facts.
 Counted through a Set so duplicates cannot exceed 100%. total === 0 reports percent: null — "there
 are no requirements" is not "0% of them are covered".

Discrimination for this part: 35 mutations injected (10 + 11 + 14). SIX did not break a test. All
 are reported rather than glossed, and five were closed:

  BLZ-332 x4 — an undefined tail stringifying to "undefined", and the column losing NOT NULL/DEFAULT,
   were both invisible because the API always supplies the value; closed with DIRECT store calls and
   inserts that go around the API (the only way to test a DEFAULT at all, and what a migration or
   import will be). splitCustomFields losing its scoping entirely was untested; closed with
   same-named filterable definitions in another project and for another kind.
  BLZ-333 x2 — removing the empty-statement branch and the missing-method branch. Both fell through
   to the next check and still returned exactly ONE finding, so a test asserting the COUNT proved
   nothing. Rewritten to assert the MESSAGE, since distinguishing "you wrote nothing" from "you
   wrote a description" is the entire value of those branches.

 The sixth is NOT a test gap and was deliberately left: the `::jsonb` cast on the Postgres tail
 default. Unlike `boolean DEFAULT 0`, Postgres resolves an unknown literal to the column's own type,
 so `DEFAULT '{}'` works and removing the cast is genuinely harmless. sql-dialect.mjs's comment had
 OVERCLAIMED it as the same class of defect; the comment was corrected rather than a test written
 that cannot fail. The DEFAULT itself is the guard and now has one.

Pattern worth naming, since it has now fired ~11 times across this branch: every silent mutation was
 a test whose assertion did not VARY with the thing under test — a count where only the message
 changed, a fixture the API always populated, a numeric bound where the comparison could only ever
 produce NaN. "If a mutation does not break a test, say so plainly" catches this and nothing else
 does; fourteen clean per-task reviews did not.

Incidental fix: two test fixtures used column-less `INSERT INTO artifact VALUES (...)`, which any
 new column breaks. Fixed by naming the columns, not by weakening the schema.
