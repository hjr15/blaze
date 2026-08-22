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
import { promotionPlan } from "./field-promotion.mjs";
import { evaluateCoverage, DEFAULT_COVERAGE_RULES } from "./coverage.mjs";
import { buildMatrix } from "./matrix.mjs";
import { parseRef, nextRef } from "./ref-allocator.mjs";

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
  const find = (id) => state.artifacts.find((a) => a.id === id);
  const typeByName = (n) => state.linkTypes.find((t) => t.name === n) ?? null;
  const links = () => denormaliseLinks({ links: state.links, linkTypes: state.linkTypes });

  return {
    // POST /api/artifact — ref UNIQUENESS is a database constraint (artifact-schema.mjs
    // UNIQUE (project_key, ref)), because it must hold under concurrent writers. Ref
    // FORMAT and MONOTONICITY belong here instead, where the refusal can name the
    // expected shape rather than surfacing a raw constraint-violation error.
    async createArtifact({ kind, title, ref, ...rest }) {
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
        id: randomUUID(), kind, title, ref: finalRef, status: rest.status ?? "proposed", ...rest,
      };
      state.artifacts.push(artifact);
      return { ok: true, error: null, artifact };
    },

    async createLink({ typeName, sourceId, targetId }) {
      const lt = typeByName(typeName);
      const existingCount = links().filter(
        (l) => l.type_name === typeName && l.source_id === sourceId).length;
      const verdict = checkLink({
        linkType: lt,
        sourceKind: find(sourceId)?.kind ?? "unknown",
        targetKind: find(targetId)?.kind ?? "unknown",
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
      const subject = find(id);
      if (!subject) return { ok: false, error: `no such artifact ${id}` };
      const verdict = checkGate({
        action: `${subject.kind}:${to}`,
        subject,
        context: {
          links: links(),
          children: state.artifacts.filter((a) => a.parent_id === subject.id),
        },
      });
      if (!verdict.ok) return verdict;
      subject.status = to;
      return { ok: true, error: null };
    },

    async defineField(field) {
      const plan = promotionPlan({
        field,
        existingColumns: state.columns ?? [],
        filterableCount: field.filterableCount ?? 0,
        engine: state.engine ?? "sqlite",
      });
      return plan.ok ? { ok: true, error: null, sql: plan.sql }
                     : { ok: false, error: plan.error };
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
