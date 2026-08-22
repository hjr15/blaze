// scripts/model/artifact-api.mjs — the v4 API surface. Enforcement lives HERE, below
// HTTP, so an import, a script and an agent are governed identically to the UI.
//
// ADR-0015 §4.5: enforcement lives BELOW HTTP, and is proven by exercising every rule
// through the API. CS-018 is the anti-pattern -- Polarion's own docs concede their
// suspect links "are implemented on the UI level only. They do not work for
// server-side use cases like imports or API calls." For agent-driven teams the API IS
// the primary interface, so a rule the API cannot see does not exist.
import { randomUUID } from "node:crypto";
import { checkLink } from "./link-rules.mjs";
import { checkGate } from "./gates.mjs";
import { promotionPlan, TARGET_TABLE } from "./field-promotion.mjs";
import { fieldBudget } from "./field-budget.mjs";
import { evaluateCoverage, validateCoverageRule, DEFAULT_COVERAGE_RULES } from "./coverage.mjs";
import { buildMatrix } from "./matrix.mjs";
import { artifactHealth } from "./artifact-health.mjs";
import { filterByField } from "./matrix-filter.mjs";
import { parseRef, nextRef } from "./ref-allocator.mjs";
import { isTerminal } from "./workflows.mjs";
import { lintStatement } from "./wording-lint.mjs";
import { validateFieldValues, splitCustomFields } from "./field-validation.mjs";
import { ARTIFACT_KINDS } from "./artifact-schema.mjs";

/**
 * The model is polymorphic across `artifact` and `ticket` (design §3.1/§3.3):
 * `Implements`/`Verifies` start at a feature or story, and `goal:achieved` only ever
 * exists on a ticket -- no artifact `kind` is ever "goal". A resolver that only checks
 * `state.artifacts` therefore treats every ticket endpoint as absent, which is exactly
 * the C1 defect (every trace link refused, `sourceKind`/`targetKind` resolving to the
 * literal string "unknown"). This is the one seam both endpoint resolution (createLink)
 * and gate-subject resolution (transition) must share, so they cannot silently diverge
 * on which ids exist.
 *
 * A ticket has no `kind` column -- its `type` (feature/story/task/bug/goal/...) IS its
 * kind in this vocabulary (schema.mjs's TYPES registry governs both), so it is exposed
 * under the same `kind` key an artifact already carries. Checks artifacts first: an id
 * collision between the two id spaces is not a case this branch needs to arbitrate.
 */
export function resolveEndpoint(state, id) {
  const artifact = state.artifacts.find((a) => a.id === id);
  if (artifact) return artifact;
  const ticket = (state.tickets ?? []).find((t) => t.id === id);
  if (ticket) return { ...ticket, kind: ticket.type };
  return null;
}

/**
 * The denormalising join, written once. `checkLink`, `evaluateCoverage` and
 * `buildMatrix` all read link rows shaped { type_name, source_id, target_id }, but the
 * database (link-schema.mjs) stores link_type_id — an FK to link_type. Every call site
 * in this file goes through here rather than re-deriving the join inline, so the three
 * consumers cannot silently disagree about how the join is done.
 */
export function denormaliseLinks({ links = [], linkTypes = [] }) {
  const typeById = new Map(linkTypes.map((t) => [t.id, t]));
  return links.map((l) => ({ ...l, type_name: typeById.get(l.link_type_id)?.name ?? null }));
}

/**
 * @param state  the in-memory record set the pure decision functions (checkLink,
 *   checkGate, evaluateCoverage, buildMatrix) read from and this API keeps current —
 *   unchanged from before BLZ-325.
 * @param store  OPTIONAL — an `artifactStore(exec, {dialect})` (artifact-store.mjs),
 *   the I/O half of this API, following the identity.mjs/identity-store.mjs split.
 *   When given, every mutating method ALSO persists to the real schema the other
 *   thirteen modules define, instead of stopping at `state`'s in-memory arrays — the
 *   defect BLZ-325 exists to close (in-memory-only behaviour when `store` is omitted
 *   is preserved for the existing pure-decision test suite, which never wires one).
 */
export function artifactApi(state, store) {
  const typeByName = (n) => state.linkTypes.find((t) => t.name === n) ?? null;
  const links = () => denormaliseLinks({ links: state.links, linkTypes: state.linkTypes });

  // The rules in force. DEFAULT_COVERAGE_RULES apply when nobody has defined any --
  // `state.coverageRules` absent means "defaults", `[]` means "deliberately none".
  const allRules = () => state.coverageRules ?? DEFAULT_COVERAGE_RULES;
  // `enabled` exists as a column and is indexed on; a disabled rule that still refuses
  // a baseline, or still shows up in the standing read, makes the flag a lie. A rule
  // record with no `enabled` key at all (the shipped defaults) is enabled.
  const enabledRules = () => allRules().filter((r) => r.enabled !== false);
  // Defining the FIRST rule must not silently drop the defaults -- that would make one
  // addition switch three standing rules off, which is its own silent grandfathering.
  const materialiseRules = () => {
    state.coverageRules = state.coverageRules ?? DEFAULT_COVERAGE_RULES.map((r) => ({ ...r }));
    return state.coverageRules;
  };
  // A rule carrying no project_key (the shipped defaults) is in force in EVERY project,
  // so it collides with a same-named rule in any one of them.
  const findRule = (rules, { project_key, name }) => rules.find(
    (r) => r.name === name && (r.project_key == null || r.project_key === project_key)) ?? null;
  const violationsFor = (rule) => evaluateCoverage(
    { rule, artifacts: state.artifacts, links: links() }).violations;
  // A closure, not `this.fieldBudget` — every other shared read in this file is one, and a
  // destructured `const { defineField } = api` would silently lose a `this`-bound call.
  const budgetFor = (project_key = null) =>
    fieldBudget({ definitions: state.fieldDefinitions ?? [], project_key });

  // A gate subject's children, resolved through the DEFAULT hierarchy's
  // hierarchy_membership rows -- NOT parent_id, the column §3.3 built this table to
  // replace (I1). A child can be an artifact (a goal's requirement) or a ticket, so
  // each is resolved through resolveEndpoint too, and `terminal` is computed from the
  // shared workflow registry rather than trusted as a field on the raw record.
  const childrenOf = (itemId) => {
    const defaultHierarchy = (state.hierarchies ?? []).find((h) => h.is_default);
    if (!defaultHierarchy) return [];
    return (state.hierarchyMemberships ?? [])
      .filter((m) => m.hierarchy_id === defaultHierarchy.id && m.parent_id === itemId)
      .map((m) => resolveEndpoint(state, m.item_id))
      .filter(Boolean)
      .map((c) => ({ ...c, terminal: isTerminal(c.kind, c.status) }));
  };

  return {
    // POST /api/artifact — ref UNIQUENESS is a database constraint (artifact-schema.mjs
    // UNIQUE (project_key, ref)), because it must hold under concurrent writers. Ref
    // FORMAT and MONOTONICITY belong here instead, where the refusal can name the
    // expected shape rather than surfacing a raw constraint-violation error.
    // RQ-4a (ADR-0017, design §4.1): the banned-construction lint is a write-time
    // block, not advisory -- "a rule the API cannot see does not exist" (§4.5), and
    // until this call existed lintStatement was reachable only from its own test.
    // Block tier refuses without a `reason`; a firm transcribing a client's
    // contractual wording verbatim can still record one and proceed (ADR-0017's own
    // justification for the override existing at all). Warn tier never blocks --
    // "the system shall never store plaintext passwords" is a genuine requirement --
    // and is surfaced on the response either way so it is not just silently dropped.
    // BLZ-325 (C2/C3): a createArtifact output that cannot be inserted into the real
    // `artifact` table proves nothing about what the API actually does. `project_key`
    // and a non-empty `title` are both NOT NULL / CHECKed in artifactDdl, so both are
    // validated here rather than left to surface as a raw constraint violation.
    // `created_at`/`updated_at` are stamped here for the same reason.
    //
    // Ref allocation: when `ref` is omitted, allocation goes through the ref_claim
    // LEDGER (claimRef, BLZ-326) rather than `nextRef` over the live artifact set --
    // that live-set read is exactly the C3 defect (a withdrawn artifact's ref gets
    // silently reissued). The ledger read only happens when a `store` is wired; the
    // pure in-memory fixtures the rest of this suite uses never withdraw an artifact
    // mid-test, and keeping the old live-set fallback there avoids requiring every
    // existing test to stand up a database purely to allocate a ref.
    async createArtifact({ kind, title, ref, statement, reason, project_key, fields, ...rest }) {
      if (!project_key) {
        return { ok: false, error: "createArtifact needs a project_key" };
      }
      if (!String(title ?? "").trim()) {
        return { ok: false, error: "createArtifact needs a non-empty title" };
      }

      // §4.1's third write-time block (BLZ-328). Custom field values arrive under an
      // explicit `fields` key rather than being fished out of `...rest`: required-field
      // presence has to know which keys the caller actually supplied, and `rest` conflates
      // them with real artifact columns like `body` and `status`. Validated BEFORE the ref
      // is allocated, so a refused write consumes nothing from the ledger.
      const fieldVerdict = validateFieldValues({
        definitions: state.fieldDefinitions ?? [], values: fields ?? {}, project_key, kind });
      if (!fieldVerdict.ok) {
        return { ok: false, error: fieldVerdict.error, violations: fieldVerdict.violations };
      }

      const lint = lintStatement(statement);
      if (lint.blocked.length && !reason) {
        return { ok: false, error:
          `statement blocked by wording lint: `
          + lint.blocked.map((b) => `"${b.phrase}" (${b.why})`).join("; ")
          + ` — pass a reason to record a deliberate override` };
      }

      const existingRefs = state.artifacts.filter((a) => a.kind === kind).map((a) => a.ref);

      let finalRef = ref;
      if (finalRef == null) {
        finalRef = store
          ? await store.claimRef({ project_key, kind })
          : nextRef({ kind, existing: existingRefs });
      } else {
        const parsed = parseRef(finalRef);
        if (!parsed) {
          return { ok: false, error:
            `${JSON.stringify(finalRef)} is not a valid ref — expected REQ-nnn (requirement) `
            + "or ADR-nnnn (architecture)" };
        }
        if (parsed.kind !== kind) {
          return { ok: false, error:
            `ref ${finalRef} is a ${parsed.kind} ref and cannot be used for a ${kind}` };
        }
        let highest = existingRefs.reduce((max, r) => {
          const p = parseRef(r);
          return p && p.num > max ? p.num : max;
        }, 0);
        // The ledger may remember a claim the live artifact set no longer does (the
        // artifact it named was withdrawn) -- combine both so an explicit ref cannot
        // reuse either one's memory of what was already handed out.
        if (store) {
          const claimed = await store.claimedRefs({ project_key, kind });
          highest = claimed.reduce((max, r) => {
            const p = parseRef(r);
            return p && p.num > max ? p.num : max;
          }, highest);
        }
        if (parsed.num <= highest) {
          return { ok: false, error:
            `ref ${finalRef} does not advance past the highest allocated ${kind} ref `
            + `(currently ${highest}) — refs must increase monotonically` };
        }
        // Register the caller's explicit choice in the ledger too, so a LATER omitted-
        // ref allocation (claimRef) can never hand this same number back out.
        if (store) {
          await store.registerRef({ project_key, kind, num: parsed.num, ref: finalRef });
        }
      }

      const now = new Date().toISOString();
      const artifact = {
        id: randomUUID(), project_key, kind, title, ref: finalRef, statement,
        status: rest.status ?? "proposed", ...rest,
        created_at: now, updated_at: now,
        // Recorded per ADR-0017, not merely accepted -- an override is a deliberate,
        // attributable act, so the reason string travels with the artifact rather
        // than being consumed and discarded at the gate.
        ...(reason != null ? { wording_override_reason: reason } : {}),
        ...(fields != null ? { fields } : {}),
        // BLZ-332, §3.4: the two homes, split HERE because this is where the field
        // definitions are known. A filterable field was promoted to a real cf_ column at
        // definition time; everything else goes to the JSON tail. Never both — promotion
        // is "decided once, at definition", so a value in two places is two answers.
        ...splitCustomFields({ definitions: state.fieldDefinitions ?? [],
                               values: fields ?? {}, project_key, kind }),
      };
      state.artifacts.push(artifact);

      // §3.7: every change to an artifact writes a revision row -- append-only, and
      // this is what a baseline pins (never the live artifact). Recorded in `state`
      // regardless of `store`, so baselineDocument's revision lookup works the same
      // way whether or not a real database is wired.
      const revision = {
        id: randomUUID(), artifact_id: artifact.id, at: now, actor: "api",
        snapshot: JSON.stringify({ title: artifact.title, statement: artifact.statement,
                                    body: artifact.body ?? null, status: artifact.status }),
      };
      state.artifactRevisions = state.artifactRevisions ?? [];
      state.artifactRevisions.push(revision);

      if (store) {
        await store.insertArtifact(artifact);
        await store.insertRevision(revision);
      }

      return { ok: true, error: null, artifact, warnings: lint.warnings };
    },

    async createLink({ typeName, sourceId, targetId }) {
      const lt = typeByName(typeName);
      const existingCount = links().filter(
        (l) => l.type_name === typeName && l.source_id === sourceId).length;
      const verdict = checkLink({
        linkType: lt,
        sourceKind: resolveEndpoint(state, sourceId)?.kind ?? "unknown",
        targetKind: resolveEndpoint(state, targetId)?.kind ?? "unknown",
        existingCount,
      });
      if (!verdict.ok) return verdict;
      const link = {
        id: randomUUID(), link_type_id: lt.id, source_id: sourceId, target_id: targetId,
        created_at: new Date().toISOString(), created_by: "api",
      };
      state.links.push(link);
      if (store) await store.insertLink(link);
      return { ok: true, error: null, link };
    },

    async transition({ id, to }) {
      const subject = resolveEndpoint(state, id);
      if (!subject) return { ok: false, error: `no such item ${id}` };
      const verdict = checkGate({
        action: `${subject.kind}:${to}`,
        subject,
        context: {
          links: links(),
          children: childrenOf(subject.id),
        },
      });
      if (!verdict.ok) return verdict;
      // resolveEndpoint returns the live artifact object by reference, but for a
      // ticket it synthesises a { ...ticket, kind } copy (a ticket has no `kind`
      // column to merge onto) -- write the status through to the real record, not
      // the copy.
      const record = state.artifacts.find((a) => a.id === id)
        ?? (state.tickets ?? []).find((t) => t.id === id);
      record.status = to;

      // Only an `artifact` row exists in the schema this ticket reconciles against --
      // a ticket's own persistence is the pre-existing v3 write port (write-port.mjs),
      // a separate and much larger surface this ticket does not touch. §3.7's "every
      // change writes a revision" applies to artifacts.
      if (ARTIFACT_KINDS.includes(subject.kind)) {
        const now = new Date().toISOString();
        record.updated_at = now;
        const revision = {
          id: randomUUID(), artifact_id: id, at: now, actor: "api",
          snapshot: JSON.stringify({ title: record.title, statement: record.statement,
                                      body: record.body ?? null, status: record.status }),
        };
        state.artifactRevisions = state.artifactRevisions ?? [];
        state.artifactRevisions.push(revision);
        if (store) {
          await store.updateArtifactStatus({ id, status: to, updated_at: now });
          await store.insertRevision(revision);
        }
      }

      return { ok: true, error: null };
    },

    // The Task 13 ruling made this route admin specifically to protect the
    // install-wide column budget (ADR-0018) -- which only matters if the number the
    // cap is checked against is real. `field.filterableCount` and `field.existingColumns`
    // are caller-supplied request fields and are NEVER read: a caller sending
    // `filterableCount: 0` must not be able to skip a cap that exists to protect every
    // OTHER project's headroom (C5). The two counters are also keyed by target table
    // (artifact vs ticket, via the same TARGET_TABLE lookup promotionPlan itself uses)
    // per §3.4's "the two tables carry independent column budgets".
    async defineField(field) {
      if (store && !field.project_key) {
        return { ok: false, error: "defineField needs a project_key" };
      }
      const table = TARGET_TABLE[field.applies_to_kind] ?? "ticket";
      const sameTable = (state.fieldDefinitions ?? [])
        .filter((d) => (TARGET_TABLE[d.applies_to_kind] ?? "ticket") === table);
      const filterable = sameTable.filter((d) => d.is_filterable);

      // The engine a promoted column's SQL type must match is the STORE's dialect,
      // not an unrelated `state.engine` flag -- generating SQLite's `REAL` and running
      // it against a wired Postgres store would fail the ALTER TABLE outright.
      const plan = promotionPlan({
        field,
        existingColumns: filterable.map((d) => `cf_${d.key}`),
        filterableCount: filterable.length,
        engine: store?.dialect ?? state.engine ?? "sqlite",
      });
      if (!plan.ok) return { ok: false, error: plan.error };

      const record = { id: field.id ?? randomUUID(), ...field };
      state.fieldDefinitions = state.fieldDefinitions ?? [];
      state.fieldDefinitions.push(record);

      if (store) {
        await store.insertFieldDefinition(record);
        // promotionPlan returns SQL, it never executes it (its own header says so) --
        // this is the one place that actually runs the ALTER TABLE it returned.
        await store.runDdl(plan.sql);
      }

      // BLZ-329, §3.4: the budget is reported on SUCCESS, not only inside a refusal.
      // Learning the cap at the moment you are denied is what "sprung" means (CS-008);
      // seeing the remaining headroom on every promotion is what "continuously" means.
      // Computed AFTER the push so it reflects the promotion that just happened.
      return { ok: true, error: null, sql: plan.sql,
               budget: budgetFor(field.project_key ?? null) };
    },

    // GET /api/field-budget — the standing surface for §3.4's install-wide budget. Counts
    // PERSISTED definitions and never a caller-supplied number: a request sending
    // `filterableCount: 0` skipping the cap was the C5 defect.
    fieldBudget({ project_key = null } = {}) {
      return budgetFor(project_key);
    },

    // POST /api/baseline — baselining a document is the one deliberate checkpoint where
    // coverage bites (gates.mjs does not import evaluateCoverage on purpose: three of
    // the four gates have nothing to do with coverage). The composition — run every
    // coverage rule over this document's artifacts, then hand the violations to
    // checkGate — belongs here, in the API layer, per the task-13 ruling.
    // BLZ-325 (C2, §3.6): a baseline is scoped to the PROJECT, never the document --
    // `document_id` is not a column `baselineDdl` defines, and baseline.test.mjs:96
    // asserts exactly that shape. The baseline's project_key is the document's own
    // (the document already carries one; nothing new for the caller to supply). Every
    // member is pinned to a specific `revision_id` (§3.7) rather than the live
    // artifact -- an artifact with no revision recorded yet is a caller error the
    // baseline must refuse, never a NULL pin.
    async baselineDocument({ documentId, name, note, createdBy = "api" }) {
      const document = (state.documents ?? []).find((d) => d.id === documentId);
      if (!document) return { ok: false, error: `no such document ${documentId}` };
      if (!document.project_key) {
        return { ok: false, error: `document ${documentId} has no project_key` };
      }

      const memberIds = new Set(
        (state.artifactUsages ?? [])
          .filter((u) => u.document_id === documentId)
          .map((u) => u.artifact_id));
      const artifacts = state.artifacts.filter((a) => memberIds.has(a.id));
      const denormalised = links();

      const coverageViolations = enabledRules().flatMap(
        (rule) => evaluateCoverage({ rule, artifacts, links: denormalised }).violations);

      const verdict = checkGate({
        action: "document:baselined",
        subject: document,
        context: { coverageViolations },
      });
      if (!verdict.ok) return verdict;

      // The LATEST revision per member, by insertion order (artifact_revision is
      // append-only, so the last entry recorded for an id is the current one). Every
      // member must resolve one -- a requirement created before revisions existed, or
      // never re-created through createArtifact/transition, has none, and that is
      // reported by name rather than silently pinning nothing.
      const revisions = state.artifactRevisions ?? [];
      const missing = [];
      const members = [];
      for (const artifactId of memberIds) {
        let latest = null;
        for (const r of revisions) if (r.artifact_id === artifactId) latest = r;
        if (!latest) {
          const a = state.artifacts.find((x) => x.id === artifactId);
          missing.push(a?.ref ?? artifactId);
          continue;
        }
        members.push({ artifact_id: artifactId, revision_id: latest.id });
      }
      if (missing.length) {
        return { ok: false, error:
          `cannot baseline: no revision recorded for ${missing.join(", ")} -- `
          + "a baseline pins a revision, never the live artifact" };
      }

      document.status = "baselined";
      const baseline = {
        id: randomUUID(), project_key: document.project_key, name, note: note ?? null,
        created_at: new Date().toISOString(), created_by: createdBy,
      };
      state.baselines = state.baselines ?? [];
      state.baselines.push(baseline);

      state.baselineMembers = state.baselineMembers ?? [];
      const memberRows = members.map((m) => ({ baseline_id: baseline.id, ...m }));
      state.baselineMembers.push(...memberRows);

      if (store) {
        await store.insertBaseline(baseline);
        for (const m of memberRows) await store.insertBaselineMember(m);
      }

      return { ok: true, error: null, baseline, members: memberRows };
    },

    // GET /api/artifact-health — §5's per-artifact orphan / missing-downstream /
    // stale-since-change, and the first production caller staleness.mjs has ever had.
    // A REPORT, never a verdict: untraced work is legal and counted, and inventing a
    // requirement to close a gap makes the matrix a lie.
    artifactHealth({ project_key } = {}) {
      return artifactHealth({
        project_key,
        artifacts: state.artifacts,
        links: links(),
        revisions: state.artifactRevisions ?? [],
      });
    },

    // POST /api/link/:id/review — the only thing that clears a stale indicator. Not a
    // stored suspicion flag being cleared (§5 stores none); a review DATE recorded, which
    // the computation then compares against the source's latest revision.
    async reviewLink({ id, reviewedAt = new Date().toISOString() }) {
      const link = state.links.find((l) => l.id === id);
      if (!link) return { ok: false, error: `no such link ${id}` };
      link.reviewed_at = reviewedAt;
      if (store) await store.reviewLink({ id, reviewed_at: reviewedAt });
      return { ok: true, error: null, link };
    },

    // GET /api/matrix — §5: "Filterable by custom field on BOTH axes." Each axis filters
    // INDEPENDENTLY: a filter applied to rows only is the common half-implementation, and
    // it makes the column axis a lie. `untraced` is computed by buildMatrix from whatever
    // rows it is handed, so filtering BEFORE the call is what makes the count describe the
    // matrix the person is actually looking at.
    matrix({ rows, cols, rowFilter = null, colFilter = null,
             project_key = "BLZ", rowKind = "requirement", colKind = "architecture" }) {
      const defs = state.fieldDefinitions ?? [];
      const r = filterByField({ items: rows ?? [], definitions: defs, filter: rowFilter,
                                project_key, kind: rowKind });
      if (!r.ok) return { ok: false, error: `row filter: ${r.error}` };
      const c = filterByField({ items: cols ?? [], definitions: defs, filter: colFilter,
                                project_key, kind: colKind });
      if (!c.ok) return { ok: false, error: `column filter: ${c.error}` };

      // Cells are keyed off the SURVIVING columns only (buildMatrix already skips a link
      // whose source is not in `cols`), so a filtered-out item cannot leave a dangling
      // cell behind.
      return buildMatrix({ rows: r.items, cols: c.items, links: links(),
                           linkTypes: state.linkTypes });
    },

    // GET /api/coverage — the STANDING read. Deliberately not the same obligation as
    // defineCoverageRule's report: §4.4 requires the violation list at the moment of
    // APPLYING, because an endpoint nobody opens is exactly the silent grandfathering
    // CS-013 describes.
    coverage() {
      const denormalised = links();
      return enabledRules().map(
        (rule) => evaluateCoverage({ rule, artifacts: state.artifacts, links: denormalised }));
    },

    // POST /api/coverage-rule — §4.4: "Applying a rule to existing data MUST report
    // every current violation. Retroactive *blocking* is not required; retroactive
    // **reporting** is mandatory." So creation SUCCEEDS over violating data and hands
    // back every violation, named by ref — never a count, never a truncated sample.
    // Jama's CS-013 grandfathering is the failure this closes: a rule introduced over
    // a non-compliant corpus that nobody is ever told about.
    //
    // Uniqueness is checked HERE as well as by coverage_rule's UNIQUE (project_key,
    // name), for the same reason ref FORMAT is checked here while ref UNIQUENESS is a
    // constraint: the refusal has to name the rule, not surface a raw constraint error.
    async defineCoverageRule({ id, project_key, name, description, subject_kind,
                               definition, enabled = true }) {
      const rule = {
        id: id ?? randomUUID(), project_key,
        name: typeof name === "string" ? name.trim() : name,
        description: typeof description === "string" ? description.trim() : description,
        subject_kind, definition, enabled: Boolean(enabled),
      };
      const verdict = validateCoverageRule({ rule, linkTypes: state.linkTypes });
      if (!verdict.ok) return { ok: false, error: verdict.error };

      const rules = materialiseRules();
      if (findRule(rules, rule)) {
        return { ok: false, error:
          `a coverage rule named ${JSON.stringify(rule.name)} already applies to project `
          + `${project_key} — rename it or edit the existing rule` };
      }

      rules.push(rule);
      if (store) await store.insertCoverageRule(rule);

      // Reported even when the rule is created DISABLED: the caller asked what this
      // rule would say about the corpus, and answering only for enabled rules would
      // let anyone dodge §4.4 by defining every rule disabled.
      return { ok: true, error: null, rule, currentViolations: violationsFor(rule) };
    },

    // PATCH /api/coverage-rule — enabling a rule is the SAME act of application as
    // creating one, and carries the same §4.4 reporting obligation. Without this,
    // §4.4 is trivially routed around: define disabled, switch on silently.
    // Disabling is a withdrawal, not an application, and reports nothing — `null`
    // rather than `[]`, so "not asked" is distinguishable from "asked, none found".
    async setCoverageRuleEnabled({ project_key, name, enabled }) {
      const rule = findRule(materialiseRules(), { project_key, name });
      if (!rule) {
        return { ok: false, error:
          `no coverage rule named ${JSON.stringify(name)} applies to project ${project_key}` };
      }
      rule.enabled = Boolean(enabled);
      if (store) {
        await store.setCoverageRuleEnabled(
          { project_key: rule.project_key ?? project_key, name: rule.name, enabled: rule.enabled });
      }
      return { ok: true, error: null, rule,
               currentViolations: rule.enabled ? violationsFor(rule) : null };
    },
  };
}
