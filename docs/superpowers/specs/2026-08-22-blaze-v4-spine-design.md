# Blaze v4 — the spine: requirements and architecture as documents

**Status:** draft for review · **Date:** 2026-08-22 · **Spec 1 of 6**

This specifies the foundation of Blaze v4: requirements and architecture as **documents**,
a **typed link meta-model** with enforced endpoints, **user-defined custom fields**,
**coverage gates**, **baselines**, and the **traceability matrix**.

It deliberately excludes agile execution, Gantt and critical path, hierarchy reporting and
Excel export, diagram authoring, and the configuration UI. All five are **consumers** of
this model and cannot be specified coherently until it exists.

Every decision here traces to an ADR or to measured evidence. Where something is a judgement
call with no evidence behind it, it says so.

---

## 1. Goal

Today a firm buys Jira **and** a requirements tool, then pays to integrate them — and the
integration is where traceability dies (CS-041). This spec is the part that makes one model
span both.

**Done means:** a requirement can be written in a document by someone who never opens a
work-item form; the architecture that answers it is linked by a rule the database enforces;
the matrix showing that relationship is a query, not a maintained artefact; and a goal
cannot be declared achieved while any of it is unfinished.

## 2. The central modelling decision

**A document is an ordered container of *usages*, not of artifacts.**

This is DOORS Next's separation of the base artifact from its module usage, which the
research called *"the highest-value idea in either product, and it costs almost nothing to
design in from the start."*

```
artifact  ──< artifact_usage >──  document
(the requirement)   (ordered,      (the register,
 REQ-014,            per-document   the spec,
 owns its fields)    position)      the submission)
```

**Why it matters concretely:** a safety requirement belongs in the safety case *and* the
subsystem spec *and* the customer submission. Under a one-document-per-requirement model
that is three copies that drift. Here it is one artifact with three usages, and editing it
once is correct everywhere.

**The cost, stated honestly:** every read of "the document" is a join, and deleting a usage
is not deleting the artifact — a distinction users will get wrong at first, so the UI must
say which one it is doing.

**Ordering and hierarchy come from the usage, not the artifact.** Polarion's model: the
document's indent structure *is* the hierarchy. `artifact_usage` carries `ord` and
`depth`, so the same requirement can sit at top level in one document and nested in
another.

## 3. Entities

### 3.1 `artifact` — the base entity

A requirement or an architecture decision. **Not a ticket.** Tickets (`feature`, `task`,
`bug`) remain as they are and link *to* artifacts.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | internal identity, never displayed |
| `project_key` | text NOT NULL | |
| `kind` | text NOT NULL | `requirement` \| `architecture` — CHECK-constrained |
| `ref` | text NOT NULL | **`REQ-nnn` / `ADR-nnnn` — the citation.** Stable, monotonic, **never reused**. Unique per project. |
| `title` | text NOT NULL | |
| `statement` | text | the one-line requirement statement — the thing RQ-4a lints |
| `body` | text | the full text |
| `status` | text NOT NULL | workflow status; type-scoped |
| `created_at`, `updated_at` | timestamp | |

**`ref` allocation needs an engine change** — today it is hand-managed. It gets the same
treatment as ticket ids: an append-only claim file per allocated ref, never deleted, so a
rejected requirement leaves a gap rather than freeing its number for reuse. Reuse is a bug
(CS-216: links break silently on rename and move; a stable never-reused id is the defence).

### 3.2 `document` and `artifact_usage`

| `document` | |
|---|---|
| `id`, `project_key`, `title`, `kind`, `status`, timestamps | `kind` distinguishes a requirements register from an architecture description |

| `artifact_usage` | |
|---|---|
| `document_id`, `artifact_id`, `ord`, `depth` | PK `(document_id, artifact_id)`; unique `(document_id, ord)` |

Deleting a document deletes its usages, **never its artifacts**.

### 3.3 `hierarchy` and `hierarchy_membership`

**Replaces the single `parent_id`.** A single parent forecloses multiple named hierarchies,
which is the core Structure use case the operator explicitly asked for.

```
hierarchy             (id, project_key, name, is_default)
hierarchy_membership  (hierarchy_id, item_id, parent_id, ord)
```

The delivery hierarchy (goal → feature → task) is the default one. A safety hierarchy, a
subsystem hierarchy and a contractual-deliverable hierarchy can coexist over the same items.

**Rollup must exclude duplicates by default** (CS-038: Structure needs an explicit toggle,
meaning its default is wrong). An item reachable twice in one hierarchy counts once.

### 3.4 Custom fields — per ADR-0018

Three tables plus promoted columns:

```
field_definition  (id, project_key, key, label, data_type, is_filterable,
                   is_required, enum_values, min, max, applies_to_kind)
```

- **`is_filterable` at definition time** promotes the field to a **real, named, typed
  column** on the item table via `ALTER TABLE ADD COLUMN` — the 9.0 ms metadata-only path.
- Everything else lives in a `jsonb` / JSON column, which **still takes `CHECK`
  constraints** (the benchmark refuted my assumption that JSON means app-level validation
  only).

**Hard rules from the benchmark, each with a measured reason:**

| Rule | Because |
|---|---|
| **Never `STORED` generated columns** | 2,002 ms rewrite on Postgres; **impossible on SQLite** |
| **Promote at definition time, never later** | promoting a populated field costs 6.5 s / 2.1 s |
| **`STRICT` on every SQLite table holding custom fields** | without it a `REAL` column silently accepts `'oops'` |
| **Refuse promotion past ~1,590 columns** | Postgres hard-refuses at 1,600; fail with a named error, not a raw `ALTER` failure |
| **Hard cap 200 filterable fields per install** | the indexing knee is 200–400 (insert p95 3.15 → 51.4 ms) |
| **Do not use SQLite `ALTER TABLE ADD CHECK`** | it works, but rides undocumented behaviour |

The 200-field cap ≈ 1,250 total fields at the observed 16.1% filterable ratio — **above
Atlassian's own "exceeding limit" threshold**. It must be **surfaced continuously**, never
sprung (CS-008).

### 3.5 `link` and `link_type` — the meta-model

```
link_type (id, project_key, name, inverse_name,
           source_kinds, target_kinds, min_card, max_card)
link      (id, link_type_id, source_id, target_id, created_at, created_by)
```

Defaults, from the standards document:

| Link | Source → Target |
|---|---|
| `Implements` | feature → requirement |
| `Addresses` | architecture → requirement |
| `Verifies` | story\|feature → requirement |
| `Supersedes` | architecture → architecture |
| `Derives` | requirement → requirement |

**Every link carries an inverse name**, so the matrix reads correctly in both directions
without a second table.

### 3.6 `baseline`

**At project scope, not per document.** DOORS' per-module baselining created a problem that
baseline *sets* then had to be invented to solve — the fix is evidence of the mistake
(CS-019).

```
baseline         (id, project_key, name, created_at, created_by, note)
baseline_member  (baseline_id, artifact_id, revision_id)
```

A baseline is an immutable named snapshot. Creating one is a **gated action**.

### 3.7 `artifact_revision`

Append-only. Every change to an artifact writes a row. This is what baselines pin, and what
makes "N linked artifacts have not been re-reviewed since this changed" a **computed query
rather than stored suspicion state** — IBM retreated from stored suspicion at DNG 7.0.0
(CS-015), and Polarion's is a boolean that the API cannot even see (CS-018).

**We store no suspicion flag. We compute staleness from revisions.**

## 4. Enforcement — three mechanisms, per ADR-0015

> A check blocks at **write time** only if it is **both** decidable from the item alone
> **and** true of a legitimate draft. Fail either test and it belongs at a **gate**.

### 4.1 Write-time blocks

- Link type and endpoint validity — **default deny.** An undeclared combination is refused,
  not warned about (CS-011, CS-012).
- Required-field presence; closed-enum validity; type and range.
- `ref` format, uniqueness, monotonicity.
- **RQ-4a banned-construction lint** — block tier, `--reason` override, recorded.

### 4.2 Gates

Gated actions are **enumerated**. A gate not on this list does not exist.

| Gate | Refused when |
|---|---|
| `document → baselined` | any coverage rule on its artifacts is unmet |
| `requirement → verified` | no resolving `Verifies` link (RQ-6) |
| `goal → achieved` | any child requirement is non-terminal (RQ-7) |
| `architecture → accepted` | body lacks non-empty Context / Decision / Consequences (AQ-2) |

Every refusal **names the rule and lists every failing item.** A refusal that says only
"coverage incomplete" is a defect.

### 4.3 Advisory

Reported, never blocking: RQ-4b warn tier, singularity, necessity, verification-method
appropriateness, architecture-coverage percentage.

### 4.4 Coverage rules are first-class

```
coverage_rule (id, project_key, name, description, subject_kind, definition, enabled)
```

Not hardcoded queries — a rule has a **name**, so a refusal can cite it.

**Applying a rule to existing data MUST report every current violation.** Jama's silent
grandfathering (CS-013) is exactly the drift the operator named. Retroactive *blocking* is
not required; retroactive **reporting** is mandatory.

### 4.5 Enforcement lives in the API layer

**Non-negotiable, and the single most important line in this spec.** CS-018 is the
anti-pattern: Polarion's own docs concede *"Suspect links are implemented on the UI level
only. They do not work for server-side use cases like imports or API calls."*

For agent-driven teams the API **is** the primary interface. **A rule the API cannot see
does not exist.** Every rule in §4 is enforced below the HTTP layer, and the test suite
proves it by exercising each rule through the API, never through a UI path.

## 5. The traceability matrix

**A query over typed links. Never a maintained artefact.** `build_matrices.py` already
follows this on the v3 board (ADR-0015 on the board side); v4 makes it native.

Requirements on one axis, architecture on the other; cells show the link and its type.
Filterable by custom field on **both** axes.

Alongside it, per artifact: orphan / missing-downstream / stale-since-change, all computed.
**Untraced work is legal and counted** — the existing house rule holds. Inventing a
requirement to close a gap makes the matrix a lie.

## 6. Migration from v3

**Prerequisite: the db-primary Phase 2 cutover must land first.** A document has no status
directory to live in, so the fs write port cannot represent this model. The dual-write soak
(`BLAZE_WRITE_PORT=dual`, a week of real use, zero divergences) is what earns it.

Then: existing `requirement` and `architecture` tickets become `artifact` rows carrying
their `ref`; each project's requirements get one default document with usages ordered by
`ref`; `parent_id` becomes membership in the default hierarchy; the Traceability body
sections that `build_matrices.py` parses today become real `link` rows.

**The migration is proven the way the v3 corpus migration was: a zero-diff oracle against
the existing derived matrices.** That method already caught six data-loss defects in
merged code, every one by running against real data rather than fixtures.

## 7. Testing

TDD throughout. Beyond that, three project-specific rules earned by this codebase:

1. **Every guard is proven to discriminate** by injecting the regression it exists to
   catch. A test written after a fix that has never seen the bug fail is not evidence.
   *(A date test here once asserted `/\d{4}-\d{2}-\d{2}/` and passed against the very
   off-by-one-day bug it was written for.)*
2. **Conformance runs against both engines**, real Postgres in CI. *(32 conformance
   assertions missed the Postgres date bug because not one compared a date value.)*
3. **Every enforcement rule is tested through the API**, per §4.5.

## 8. Risks

| Risk | Mitigation | Honest residual |
|---|---|---|
| Teams route around gates by not baselining | attach gates to things the business needs anyway; **watch baseline rate as the leading indicator** | real, unsolved — ADR-0015 records it |
| Usage-vs-artifact confusion | UI names which one an action affects | users will still delete the wrong thing occasionally |
| The 200-field cap annoys someone | surface it continuously from day one | a cap is a cap |
| Matrix gaming — links added to look complete | none | **unsolved, and the v3 method already names it** |
| Two storage paths for one concept | promotion decided once, at definition | wrong call costs 6.5 s to fix |

## 9. Open — not oversights

1. **Formal review objects.** Jama's Review Center is the most-praised feature in the
   category (CE-002); the DOORS research advised against building review objects because a
   pull request is the small-firm equivalent. **Decide before the approval work.**
2. **Diagrams as entities** — deferred to spec 4.
3. **Whether coverage rules may be defined per project** or ship fixed.
4. **ReqIF import/export** — only if an OEM or supplier demands it.

## 10. Out of scope

Agile execution · Gantt and critical path · hierarchy reporting and Excel export · diagram
authoring · configuration UI · multi-tenancy (ADR-0014) · suspect-link state (we compute
staleness instead).
