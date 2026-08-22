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
import { evaluateCoverage, DEFAULT_COVERAGE_RULES } from "./coverage.mjs";
import { buildMatrix } from "./matrix.mjs";
import { parseRef, nextRef } from "./ref-allocator.mjs";
import { isTerminal } from "./workflows.mjs";
import { lintStatement } from "./wording-lint.mjs";

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

export function artifactApi(state) {
  const typeByName = (n) => state.linkTypes.find((t) => t.name === n) ?? null;
  const links = () => denormaliseLinks({ links: state.links, linkTypes: state.linkTypes });

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
    async createArtifact({ kind, title, ref, statement, reason, ...rest }) {
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
        finalRef = nextRef({ kind, existing: existingRefs });
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
        const highest = existingRefs.reduce((max, r) => {
          const p = parseRef(r);
          return p && p.num > max ? p.num : max;
        }, 0);
        if (parsed.num <= highest) {
          return { ok: false, error:
            `ref ${finalRef} does not advance past the highest allocated ${kind} ref `
            + `(currently ${highest}) — refs must increase monotonically` };
        }
      }

      const artifact = {
        id: randomUUID(), kind, title, ref: finalRef, statement,
        status: rest.status ?? "proposed", ...rest,
        // Recorded per ADR-0017, not merely accepted -- an override is a deliberate,
        // attributable act, so the reason string travels with the artifact rather
        // than being consumed and discarded at the gate.
        ...(reason != null ? { wording_override_reason: reason } : {}),
      };
      state.artifacts.push(artifact);
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
      const table = TARGET_TABLE[field.applies_to_kind] ?? "ticket";
      const sameTable = (state.fieldDefinitions ?? [])
        .filter((d) => (TARGET_TABLE[d.applies_to_kind] ?? "ticket") === table);
      const filterable = sameTable.filter((d) => d.is_filterable);

      const plan = promotionPlan({
        field,
        existingColumns: filterable.map((d) => `cf_${d.key}`),
        filterableCount: filterable.length,
        engine: state.engine ?? "sqlite",
      });
      if (!plan.ok) return { ok: false, error: plan.error };

      state.fieldDefinitions = state.fieldDefinitions ?? [];
      state.fieldDefinitions.push({ ...field });
      return { ok: true, error: null, sql: plan.sql };
    },

    // POST /api/baseline — baselining a document is the one deliberate checkpoint where
    // coverage bites (gates.mjs does not import evaluateCoverage on purpose: three of
    // the four gates have nothing to do with coverage). The composition — run every
    // coverage rule over this document's artifacts, then hand the violations to
    // checkGate — belongs here, in the API layer, per the task-13 ruling.
    async baselineDocument({ documentId, name, note, createdBy = "api" }) {
      const document = (state.documents ?? []).find((d) => d.id === documentId);
      if (!document) return { ok: false, error: `no such document ${documentId}` };

      const memberIds = new Set(
        (state.artifactUsages ?? [])
          .filter((u) => u.document_id === documentId)
          .map((u) => u.artifact_id));
      const artifacts = state.artifacts.filter((a) => memberIds.has(a.id));
      const denormalised = links();

      const rules = state.coverageRules ?? DEFAULT_COVERAGE_RULES;
      const coverageViolations = rules.flatMap(
        (rule) => evaluateCoverage({ rule, artifacts, links: denormalised }).violations);

      const verdict = checkGate({
        action: "document:baselined",
        subject: document,
        context: { coverageViolations },
      });
      if (!verdict.ok) return verdict;

      document.status = "baselined";
      const baseline = {
        id: randomUUID(), name, note: note ?? null, document_id: documentId,
        member_ids: [...memberIds], created_at: new Date().toISOString(), created_by: createdBy,
      };
      state.baselines = state.baselines ?? [];
      state.baselines.push(baseline);
      return { ok: true, error: null, baseline };
    },

    // GET /api/matrix
    matrix({ rows, cols }) {
      return buildMatrix({ rows, cols, links: links(), linkTypes: state.linkTypes });
    },

    // GET /api/coverage
    coverage() {
      const rules = state.coverageRules ?? DEFAULT_COVERAGE_RULES;
      const denormalised = links();
      return rules.map((rule) => evaluateCoverage({ rule, artifacts: state.artifacts, links: denormalised }));
    },
  };
}
