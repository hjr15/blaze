# Blaze v4 spine — whole-branch final review

**Date:** 2026-08-22 · **Branch:** `BLZ-306-v4-document-model` · **Range:** `dc68415..4ca696f` (24 commits)
**Reviewer scope:** cross-module consistency, seams, spec coverage, maintainability, suite health.
Per-task review is not repeated. Recorded rulings are not re-litigated — only checked for consistent application.

**Suite state as reviewed:** `node --test` → 1398 tests, 1397 pass, 0 fail, 1 skipped (161 new across 16 files).

---

## Verdict

**The architecture is sound.** The document/usage split, computed staleness in place of stored
suspicion, project-scoped baselines, default-deny link endpoints, `GATED_ACTIONS` derived from the
handler map, and the dialect-token discipline are all correct and well argued in the code itself.
The comment density is the best I have seen in this codebase — nearly every non-obvious line carries
its *why*, with the measured number or the competitor failure that motivated it.

**The problem is one seam, not the model.** `artifact-api.mjs` is a façade over three in-memory
arrays that has never been reconciled with the tables the other thirteen modules define. Nothing in
the branch forces the two to agree, and where they disagree the API test was adjusted to accommodate
it rather than the code being fixed. That single gap produces four of the five Critical findings
below. It is fixable in one focused task; it is not an architectural rethink.

A second, smaller theme: **the model is polymorphic across `artifact` and `ticket`, and only half
the code knows it.** Five separate symptoms trace to that one missing concept (C1, I1, M4, M6, and
the uncommented missing FKs).

---

## Critical

### C1 — `Implements` and `Verifies` cannot be created through the API at all

`artifactApi.find()` searches `state.artifacts` only. `Implements` starts at a **feature** and
`Verifies` at a **story|feature** — both tickets, not artifacts. So `find()` returns `undefined`,
`sourceKind` becomes the literal string `"unknown"`, and `checkLink` refuses:

```
1 Implements from a ticket: { ok: false,
  error: 'Implements cannot start at a unknown — declared sources: feature' }
2 Verifies from a story:    { ok: false,
  error: 'Verifies cannot start at a unknown — declared sources: story, feature' }
```

Consequences, in order of severity:

- Spec §1's `Done means` clause — the requirement→delivery trace — is unreachable through the layer
  §4.5 calls the primary interface.
- The `requirement:verified` gate (RQ-6) can never pass: the only link that satisfies it cannot be
  created.
- `every-requirement-verified` is in `DEFAULT_COVERAGE_RULES`, so **`document:baselined` can never
  pass with the shipped defaults** — the primary place coverage is supposed to bite is permanently
  closed.
- The traceability matrix is empty of `Implements`/`Verifies` cells by construction.

`tests/model/artifact-api.test.mjs:182-183` reveals this — it redefines `Verifies` with
`source_kinds: "architecture"` to get the baseline test green. That is the test accommodating the
defect. Delete those two lines and the "baselining succeeds once coverage is clean" test fails.

**Fix:** `find()` must resolve an endpoint across both `artifact` and `ticket`, returning
`{id, kind}` from whichever holds it. That is the one design decision the branch skipped, and it
should be made explicitly (an `resolveEndpoint(id)` seam in the API, documented) rather than patched.

### C2 — The API layer and the schema layer have never been run against each other

Two proven mismatches, both from live execution:

**Artifacts.** `createArtifact` emits `{id, kind, ref, title, status, ...rest}` — no `project_key`,
no `created_at`, no `updated_at`, and no validation that `title` is present. All four are
`NOT NULL` in `artifactDdl`:

```
A createArtifact with no title/project_key:
  {"ok":true,"artifact":{"id":"…","kind":"requirement","ref":"REQ-001","status":"proposed"}}
B API-produced artifact CANNOT be persisted:
  NOT NULL constraint failed: artifact.project_key
```

**Baselines.** `baselineDocument` (`artifact-api.mjs:125-155`) builds
`{id, name, note, document_id, member_ids, created_at, created_by}`. `baselineDdl` defines
`baseline(id, project_key, name, created_at, created_by, note)` and
`baseline_member(baseline_id, artifact_id, revision_id)`. The API object has **no `project_key`**,
carries a **`document_id` that no column accepts**, and **pins no revisions** — which is the entire
purpose of a baseline per §3.7. `tests/model/baseline.test.mjs:96-97` asserts
`!("document_id" in cols)`, *"a baseline must not be per-document"* — the schema test explicitly
forbids the shape the API produces. The two halves of the same feature contradict each other and
both are green.

This is also a §3.6 violation on its own: the spec is emphatic that baselining is at project scope
and that DOORS' per-module baselining was the mistake. The API implements the per-module version.

**Fix:** the API must produce persistable rows, and one test must prove it by inserting an
API-produced object into the real DDL. That single test would have caught both.

### C3 — Refs are reused; the append-only claim ledger from §3.1 does not exist

`nextRef` derives the maximum from the *live* artifact set. Withdraw the highest artifact and its
number is handed out again:

```
5 next ref after REQ-002 removed: REQ-002
```

Spec §3.1 is unambiguous: *"Stable, monotonic, **never reused**… an append-only claim file per
allocated ref, never deleted, so a rejected requirement leaves a gap rather than freeing its
number for reuse. Reuse is a bug (CS-216)."* The API's monotonicity check reads the same live set,
so it does not catch it either. Given that a ref appears in commit messages and audit submissions,
silently redirecting an existing citation is the exact failure `ref-allocator.mjs`'s own header
comment says it exists to prevent.

Note the ledger already escalated one ref-ceiling defect to Critical (the REQ-999 pad). Same module,
same class, larger blast radius.

**Fix:** an `artifact_ref_claim(project_key, kind, num, claimed_at)` table with the allocator reading
`max(num)` from it and inserting on allocation. Roughly one DDL block and two functions.

### C4 — The RQ-4a wording lint is not wired into any write path

`wording-lint.mjs` is imported by exactly one file: its own test. `createArtifact` never calls
`lintStatement`, so a banned construction is accepted:

```
6 banned wording accepted: true       // statement: "The system shall be user friendly and fast."
```

Spec §4.1 lists it as a **write-time block** with a `--reason` override that is **recorded**.
Neither the block, the override, nor the recording exists. §4.5 — *"the single most important line
in this spec"* — says a rule the API cannot see does not exist. By the spec's own definition this
rule does not exist. Task 15's careful two-tier work (genuinely the best-verified task on the branch,
per the ledger) is currently dead code.

**Fix:** call `lintStatement(statement)` in `createArtifact`, refuse on a non-empty `blocked`, accept
a `reason` argument that records the override, and surface `warnings` on the response. Plus one API
test per §7.3.

### C5 — The filterable-field cap is enforced against a number the caller supplies

`artifactApi.defineField` reads `field.filterableCount ?? 0` — off the **request payload**. Omit it
and the install-wide 200-field cap never fires:

```
4 cap bypass: { ok: true, sql: 'ALTER TABLE artifact ADD COLUMN cf_x REAL;' }
```

`existingColumns` comes from `state.columns ?? []`, so the Postgres 1,590-column ceiling is equally
inert. This is the budget the Task 13 ruling made `POST /api/field` **admin** to protect, on the
reasoning that *"one project's member could exhaust another's headroom."* The route was hardened;
the check it guards was not. The ruling was applied to the auth tier and not to the enforcement —
an inconsistency in exactly the sense the brief asked me to look for.

Related: `promotionPlan` receives one `filterableCount` and one `existingColumns` regardless of
target table, so §3.4's *"The two tables carry independent column budgets"* is not modelled.

**Fix:** count filterable fields from persisted state, never from the request. Key both counters by
target table.

---

## Important

### I1 — `goal:achieved` is unreachable, not merely untested

The ledger defers *"`goal:achieved` wiring is not exercised through the API"* as an elevated spec
gap. It is worse than that: it **cannot** be exercised. `transition` derives the action as
`${subject.kind}:${to}`, and `subject` comes from `state.artifacts`, whose `kind` is CHECK-constrained
to `requirement|architecture`. No artifact can ever have kind `goal`. The gate is dead code reachable
only by calling `checkGate` directly.

Compounding it: `transition` finds children via `state.artifacts.filter(a => a.parent_id === subject.id)`.
Spec §3.3 **replaces `parent_id`** with `hierarchy_membership` — *"Replaces the single `parent_id`"* —
and the branch built `hierarchyDdl` to do it. The one place the API needs a parent relationship uses
the field the branch was written to retire, over the wrong table (a goal's children are tickets).

**Recommendation: fix before merge**, together with C1. Writing the missing test as deferred will
just produce a test that cannot be written.

### I2 — `coverage_rule.enabled` is never read

The column exists, is defaulted, and is in the covering index. `evaluateCoverage` does not consult
it and neither do `artifactApi.coverage()` or `baselineDocument`:

```
C disabled rule still evaluated:
  {"rule":"r","violations":[{"ref":"REQ-001","why":"needs at least 1 inbound Addresses link, has 0"}]}
```

Disabling a rule has no effect, and the rule that would surprise a user most is the one blocking
their baseline. One-line fix (`rules.filter(r => r.enabled !== false)`) plus a discriminating test.

### I3 — `project_key` is on every table and honoured by no code path

`artifact`, `document`, `hierarchy`, `link_type`, `field_definition`, `coverage_rule` and `baseline`
all carry `project_key`. Not one function in `coverage.mjs`, `matrix.mjs`, `link-rules.mjs`,
`gates.mjs`, `field-promotion.mjs` or `artifact-api.mjs` filters on it. `typeByName` searches every
link type in the installation; `evaluateCoverage` evaluates every artifact against every rule;
`buildMatrix` accepts whatever it is given.

For a single-project fixture that is invisible. For a product whose stated core value is the
cross-project matrix, and whose §3.4 explicitly worries about one project consuming another's
budget, the absence of project scoping in the entire enforcement layer is a hole that will be
expensive to retrofit once callers exist. Decide now whether scoping is the API's job (pass
pre-scoped collections, and say so in every signature's docstring) or the pure functions' job
(take `projectKey` and filter). Either is fine; silence is not.

### I4 — §4.4's retroactive-violation report has no landing place

Confirmed: the brief's suspicion is correct. §4.4 — *"Applying a rule to existing data MUST report
every current violation. Jama's silent grandfathering (CS-013) is exactly the drift the operator
named. Retroactive blocking is not required; retroactive **reporting** is mandatory."*

There is no rule-creation path at all — no `defineCoverageRule`, no `POST /api/coverage-rule` (only
`GET /api/coverage`). `artifactApi.coverage()` is a generic standing read, which is not the same
obligation: the spec requires the report **at the moment of applying**, so the person adding the rule
sees what they have just made non-compliant. A standing endpoint they may never open is precisely
the silent grandfathering CS-013 describes.

**Fix:** `defineCoverageRule(rule)` that persists the rule and returns
`{ok, rule, currentViolations: evaluateCoverage({rule, ...}).violations}`, with a test asserting the
violations come back non-empty on pre-existing data.

### I5 — §4.1's required-field / enum / type / range validation is entirely absent

`field_definition` stores `is_required`, `enum_values`, `min_value`, `max_value` and `data_type`.
No module reads any of them. §4.1 lists *"Required-field presence; closed-enum validity; type and
range"* as a write-time block. There is no validator and no place a field value is written. This is
a whole spec bullet with zero implementation — the largest uncovered item after C4.

### I6 — The JSON tail of ADR-0018's hybrid does not exist

`promotionPlan` returns `{ok: true, sql: null}` for a non-filterable field with the comment
`// JSON tail`. There is no JSON column on `artifact` or anywhere else, so the tail has nowhere to
land. §3.4 also specifies that this column *"still takes `CHECK` constraints (the benchmark refuted
my assumption that JSON means app-level validation only)"* — a specific, measured finding with no
corresponding code. Half the hybrid shipped.

Also missing from §3.4: *"The budget must therefore be reported install-wide and per project"* and
*"It must be surfaced continuously, never sprung (CS-008)."* `promotionPlan` only hard-refuses at
200. There is no headroom reporting and no warning band.

### I7 — Links fail closed, gates fail open, and the divergence is undocumented

`checkLink` refuses an unknown link type — default deny, argued at length in the header. `checkGate`
returns `{ok: true}` for an unknown action, and `document:baselined` with **no coverage context at
all** passes (`gates.test.mjs:103-106`, deliberately asserted).

Both stances are individually defensible: gates are enumerated, so an unlisted action legitimately
is not a gate. But "the caller forgot to compute coverage" and "this action is not gated" are
different situations that currently produce the same answer, in the one gate whose whole job is to
block. Given that the API is the only composer and C2 shows the composition is not verified,
fail-open here is the wrong default.

**Recommendation:** keep unknown *actions* passing; make `document:baselined` distinguish
`coverageViolations: []` (checked, clean) from `undefined` (not checked) and refuse the latter.
Two lines, and it converts a silent hole into a loud one.

### I8 — `buildMatrix` filters the column axis but not the row axis

`matrix.mjs:13` guards `colIds.has(l.source_id)`. There is no `rowIds` equivalent, so a link whose
**target** is off-axis still creates a `cells[target_id]` entry. The Task 11 ruling that produced the
column filter reasoned: *"the matrix would silently include cells for links pointing at artifacts not
on the axis."* That reasoning applies symmetrically and was applied to one side only — another
ruling applied inconsistently. `matrix.test.mjs:43` covers the column side; there is no row-side twin.

### I9 — Postgres test isolation was applied to 2 of 7 suites

| Suite | PG schema | Tables dropped on `public` |
|---|---|---|
| `field-promotion` | `field_promotion_test` | — |
| `baseline` | `baseline_test` | — |
| `artifact-schema` | *public* | `artifact` |
| `link-schema` | *public* | `link`, `link_type` |
| `hierarchy-schema` | *public* | `hierarchy`, `hierarchy_membership` |
| `field-schema` | *public* | `field_definition` |
| `coverage` | *public* | `coverage_rule` |

`node --test` runs files in parallel. This works today only because the five `public`-schema suites
happen to own disjoint table names. The ledger recorded the lesson — *"a class of flakiness worth
watching for in every remaining PG-gated suite"* — after Task 6, but Tasks 9 and 12+ applied it
selectively. The next PG suite that needs `artifact` (likely: links, coverage, staleness) races
`artifact-schema.test.mjs` immediately, and it will fail intermittently in CI, which is the most
expensive way to find out.

**Fix:** one shared `openPgIn(schemaName, ddl…)` helper, adopted by all seven. Also removes the
duplicated `CREATE SCHEMA / DROP TABLE / connect / DROP SCHEMA CASCADE` boilerplate.

Related, smaller: when `BLAZE_TEST_PG_URL` is unset the PG blocks do not exist — no skip, no
count, no message. CI sets it (`test.yml:31`), so the rule holds today, but a green local run
proves nothing about Postgres and says nothing about that. One `test.skip` in the `else` branch
would make the absence visible.

### I10 — `min_card` is a dead column

Declared in `link_type`, CHECK-constrained, present on all five `DEFAULT_LINK_TYPES`, and read by
nothing. `checkLink` uses only `max_card`. Minimum cardinality genuinely cannot block at write time
(it is unsatisfiable at creation) — by §4's own rule it belongs at a gate, and no gate consumes it.
Either wire it into a gate or delete the column; a stored rule that nothing enforces is the
"stored suspicion" anti-pattern this spec was written to avoid.

### I11 — Extract the dialect helper (recommendation, not just an observation)

Seven of the eleven new modules define a private `dialect(name)`: `artifact-schema`,
`document-schema`, `hierarchy-schema`, `link-schema`, `coverage`, `field-schema`, `baseline-schema`.
Three more predate the branch (`config-schema`, `identity-schema`, `projection-schema`). v4 took the
count from 3 to 10.

**Recommendation: extract.** The argument is empirical, not aesthetic:

1. `boolean NOT NULL DEFAULT 0` — rejected by Postgres, tolerated by SQLite — occurred **three
   separate times** on this plan (ledger: Task 8 fix round, then Task 6, with the Task 6 entry
   noting *"the THIRD occurrence of this same defect in my plan"*). Each was caught only by a live
   Postgres run. A shared helper exposing `true_`/`false_` makes the literal-`0` mistake
   syntactically unavailable after the first time.
2. The ` STRICT` suffix is now retyped in seven places. Omitting it is **silent** — spec §3.4 makes
   STRICT a hard rule precisely because without it a `REAL` column accepts `'oops'`. Nothing tests
   for its presence per-table.
3. `coverage.mjs:39-51` and `field-schema.mjs:5-13` carry near-identical eight-line comments warning
   about these two defects. That comment duplication is the symptom: the knowledge belongs on the
   helper, and there is no helper to put it on.
4. The new modules also drifted the house error message — the three pre-existing helpers say
   `unknown dialect "x" — expected 'sqlite' or 'postgres'`; all seven new ones dropped the second half.

**Cost of the coupling is near zero.** The helper is a pure `string → token bag`; modules destructure
what they need; adding a token is additive. `config-schema.mjs` keeps its own — its tokens
(`projectKeyCheck`, `circularFk`, `ref()`, `namespace`) are genuinely bespoke and folding them would
be the over-abstraction to avoid.

**Shape:** `scripts/model/dialect.mjs` exporting `dialect(name)` → `{ts, txt, int, bool, true_,
false_, tbl, ifNotExists}`. Migrate the seven v4 modules; take `identity-schema` and
`projection-schema` opportunistically.

**Timing:** a follow-up ticket, not a merge blocker — the defect class is currently caught by the
both-engines tests. But it should exist before the branch is called done, because after four PRs land
and consumers arrive, seven becomes twelve.

### I12 — `DEFAULT_LINK_TYPES` retypes what `config-schema.mjs` derives

`config-schema.mjs:8` states the house rule in capitals: *"THE SEEDS ARE DERIVED, NEVER RETYPED…
Retyping them here would create a second source of truth that drifts the first time someone adds a
type — and drifts silently, because a hand-written seed list is still valid SQL when it is wrong."*
It derives its `link_type` seeds from `links.mjs`'s `LINK_TYPES`/`TRACE_LINK_TYPES`.

`link-schema.mjs` hand-writes `Implements` and `Addresses` again, with inverse names that
`config-schema.mjs` also hand-writes in its `INVERSE` map. Two hardcoded copies of the same two
inverse names, plus the `links.mjs` set they should both derive from.

There is also a **table-name collision in spirit**: `blaze_config.link_type` (name PK, `is_directed`,
`is_trace`, `ord`) and the v4 unqualified `link_type` (id PK, `project_key`, kinds, cardinality) are
two differently-shaped tables with one name. They live in different namespaces so nothing breaks
today, but `link-schema.mjs`'s `REFERENCES link_type (id)` is unqualified and resolves through
`search_path` — the exact hazard `config-schema.mjs:52-54` documents. At minimum this needs a comment
in `link-schema.mjs` saying which `link_type` it means and why there are two. Better: derive
`DEFAULT_LINK_TYPES`' names from `links.mjs`, or state in a comment why the v3 vocabulary is
deliberately not the source here.

---

## Minor

1. **`nextRef` throws where every sibling returns `{ok:false}`.** `createArtifact({kind:"ticket"})`
   rejects with `no ref scheme for kind "ticket"` instead of returning an error object — the only
   API method that can reject. An HTTP layer would 500 on user input. The convention the branch
   otherwise follows is coherent (*decision functions return `{ok, error, …}`; query functions
   return data; programmer errors throw*) and this is its one violation, because `kind` is
   caller-supplied.
2. **`staleLinks()` returns `targetRef` holding a target *id*.** Misleading name in the one place a
   consumer will render it to a human.
3. **`hierarchy-rollup.mjs`'s `rollup()` vs the pre-existing `rollup.mjs`'s `rollUp()`.** Two
   functions one capital letter apart, different arguments, different return shapes (a bare number
   vs `{est, log, count}`). A maintainer will import the wrong one. Rename to `subtreeTotal()` or
   `rollupHierarchy()`.
4. **`promotionPlan` silently promotes an unknown `applies_to_kind` onto `ticket`**
   (`TARGET_TABLE[…] ?? "ticket"`), and `field_definition` has no CHECK on that column — unlike
   `data_type`, which has one. Proven: `applies_to_kind: "banana"` →
   `ALTER TABLE ticket ADD COLUMN cf_sev text;`. Add the CHECK and refuse the unknown kind.
5. **Failure branches omit keys the success branch carries.** `promotionPlan` failures have `sql:
   null` but `defineField` failures drop the key entirely; `createArtifact` failures drop `error:
   null`/`artifact`. Destructuring callers get `undefined` where they expect `null`.
6. **The missing FKs on `link.source_id` / `link.target_id` and `hierarchy_membership.item_id` are
   uncommented.** They are correct — the endpoints are polymorphic across `artifact` and `ticket` —
   but every other non-obvious decision in these files is explained, so their silence reads as an
   oversight. This is the same root cause as C1, and one comment in each file would have made the
   gap visible during Task 13.
7. **`buildMatrix`'s axis orientation is uncommented.** Rows are keyed by `target_id` and columns by
   `source_id`; you must read the loop to learn it. One line in the docblock.
8. **`rollup()` indexes `values[id]` on a plain object** — an item literally named `constructor`
   would pull a function. `Object.create(null)` or a `Map`. Cheap, and this is a pure function
   people will reuse.
9. **`evaluateCoverage` with a malformed `definition` emits
   `needs at least 1 undefined undefined link`.** It fails closed, which is right; the message is
   not actionable, which the module's own header says is the point of naming rules.
10. **The eight-line "two defects already hit this plan" comment is duplicated verbatim** across
    `coverage.mjs` and `field-schema.mjs`. Resolved by I11.
11. **`field_definition` uses `min_value`/`max_value` where §3.4 says `min`/`max`.** Almost certainly
    deliberate (bare `min`/`max` are awkward in SQL) but undocumented, so it reads as drift.

---

## Answers to the five questions asked

**1. Cross-module consistency.** Good, with one real convention violation. The implicit rule —
decision functions return `{ok, error, …}`, derivation functions return their data, programmer
errors throw — is followed by all eleven modules except `nextRef` (Minor 1). Comment density and
style are uniform and high. `checkGate` adds `failures` and `promotionPlan` adds `sql` to the base
shape, which is deliberate enrichment rather than drift. The genuine divergences are the fail-open
vs fail-closed default (I7), the dialect error-message wording (I11.4), and the selective PG
isolation (I9). Everything else that looks like divergence is deliberate.

**2. Duplication.** Extract the dialect helper. See I11 for the full recommendation — the argument
is the three repeats of the `DEFAULT 0` defect and the seven silent retypes of ` STRICT`, not
line-count aesthetics. Do it as a follow-up ticket before the branch is called done. Leave
`config-schema.mjs` alone.

**3. Do the seams hold?** **No — they fit by coincidence, and in two places not even that.** The
link-row shape genuinely holds: `denormaliseLinks` is a single named helper, all five call sites
route through it, and `artifact-api.test.mjs:116-149` proves storage stays `link_type_id`-keyed while
enforcement reads `type_name`. Ruling F3 was applied well. The gate context also holds — the
`coverageViolations` composition is in the right layer and is tested. What does **not** hold: the API
produces artifact and baseline objects that the DDL rejects (C2), and the link *endpoints* do not
compose across the artifact/ticket boundary (C1). Both survived because nothing on this branch ever
runs an API-produced object through a real table. One integration test closes both.

**4. Spec requirements with no implementation.** §4.4's retroactive violation report (I4 — the one
you suspected; confirmed absent). Plus: §4.1's required-field/enum/type/range validation (I5),
§4.1's RQ-4a write-time block and `--reason` override (C4), §3.1's never-reused ref ledger (C3),
§3.4's JSON tail column with CHECK constraints and the install-wide/per-project budget reporting
(I6), §4.3's advisory checks beyond WARN_TIER — singularity, necessity, verification-method
appropriateness, architecture-coverage percentage (all absent), §5's per-artifact
missing-downstream and the API surfacing of stale-since-change (`staleness.mjs` has no consumer),
and §5's "filterable by custom field on both axes". §6 (migration) is correctly and deliberately
absent.

**5. What a maintainer trips over.** In order: the artifact/ticket polymorphism nobody wrote down
(C1, Minor 6); `rollup()` vs `rollUp()` (Minor 3); which `link_type` table a given file means
(I12); `buildMatrix`'s unstated axis orientation (Minor 7); who is supposed to count
`filterableCount` (C5); and the fact that `parent_id` still appears in new code that the same branch
built `hierarchy_membership` to replace (I1).

---

## Test suite health

**Strong.** 161 new tests, zero regressions in 1,267 pre-existing ones, and the discrimination
discipline is real rather than performed — the ledger records five prescribed mutations that turned
out to be no-ops and were **reported as such** instead of forced into a fake failure, plus reviewers
who probed a *different* entry than the report had, which is the difference between confirming a
report and testing a property. Almost no shape-only assertions (three across sixteen files, and each
is deliberate). Both-engines coverage is genuine and wired into CI.

Four weaknesses, in order:

1. **The API test bends the meta-model to pass** (`artifact-api.test.mjs:182-183` redefines
   `Verifies` as architecture-sourced). This is the suite accommodating C1 rather than catching it,
   and it is the only place on the branch where a test was shaped around a defect.
2. **PG setup is duplicated per file and isolated in only two of seven** (I9). One helper fixes both.
3. **No test crosses the API/DDL boundary.** Every schema test builds tables and inserts literals;
   every API test manipulates arrays. Nothing inserts an API-produced object. That single missing
   test is why C2 shipped.
4. **The PG blocks vanish silently when the env var is unset** — a local green run says nothing about
   Postgres and does not say so.

The SQLite `open()` / `ins()` helpers duplicated across seven files are fine — they are three lines
each and differ per schema; extracting them would couple tests to a shared fixture for no gain.

---

## Deferred-minor triage

| Ledger item | Verdict |
|---|---|
| **T13: `goal:achieved` API wiring not exercised** | **Fix before merge.** Escalated — it is unreachable, not untested (I1). Writing the deferred test would produce a test that cannot pass. |
| **T2: "confirm no other task inherits a phantom dependency"** | **Discharged — none remain.** Verified by import scan: the only real production imports are `coverage → artifact-schema` and `artifact-api → {6 modules}`. Every other cross-module name in the tree is a comment reference. Rulings F1 (gates ↛ coverage) and the T2 ruling (artifact-schema ↛ REF_PATTERNS) are the complete set. |
| **F4 / T13: `api()`/`api2()` helper naming** | **Discharged.** Collapsed to `makeApi()` with the divergence noted in a comment. |
| **T8: v4 `rollup` returns a bare number; v3 keeps `own_*`/`rolled_*` and `count=-1`** | **Can wait, with one action now.** No consumer exists, so the decision genuinely belongs to the first one. But add a comment in `hierarchy-rollup.mjs` pointing at `rollup.mjs:5` and recording that the shape is deliberately deferred — otherwise the deferral is invisible and the divergence gets baked in. Also fold the rename (Minor 3) into that ticket. |

---

## Recommended merge gate

**Before merge:** C1, C2, C3, C4, C5, I1. These are one coherent task — "make the API layer real" —
plus the ref-claim table and wiring the lint. Everything in that list is a spec violation, not a
preference.

**Follow-up tickets in this feature, before the branch is called done:** I2, I4, I7, I8, I9, I11,
I12, and the T8 comment.

**Backlog:** I3, I5, I6, I10, and the Minor list. I3 (project scoping) should be a *decision*
recorded now even if the code waits — it gets more expensive with every consumer.

Per the `backport-review-fix-into-plan-of-record` rule: seven of the nine defects already fixed on
this branch originated in the plan. C1, C2 and C5 also originate in the plan's Task 13 design (an
in-memory façade with no persistence seam). Carry those fixes back into
`2026-08-22-blaze-v4-spine.md` so a re-run does not reinstate them.
