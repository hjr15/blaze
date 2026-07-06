// scripts/migrate/audit.mjs — pure: per-item disposition (drop / keep / merge-into
// / re-parent) for the curated migration. Drop = non-Done terminal (Won't Do /
// Duplicate / Cannot Reproduce / abandoned). Merges are PROPOSED here (heuristic);
// the user confirms via the ledger. proposed_status/proposed_parent come from the
// status map + the restructure proposal.
import { mapType, mapStatus } from "./map.mjs";
import { isTerminal } from "../model/workflows.mjs";
import { isType } from "../model/schema.mjs";

export const DROP_RESOLUTIONS = new Set(["won't do", "wont do", "duplicate", "cannot reproduce"]);

function bigrams(s) {
  const t = String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const grams = new Set();
  for (let i = 0; i < t.length - 1; i++) grams.add(t.slice(i, i + 2));
  return grams;
}
export function titleSimilarity(a, b) {
  const ba = bigrams(a), bb = bigrams(b);
  if (ba.size === 0 || bb.size === 0) return 0;
  let inter = 0;
  for (const g of ba) if (bb.has(g)) inter++;
  return (2 * inter) / (ba.size + bb.size);
}

function worklogSeconds(n) { return (n.worklog || []).reduce((s, w) => s + (w.seconds || 0), 0); }
function numId(key) { const m = /-(\d+)$/.exec(key); return m ? Number(m[1]) : Infinity; }

export function detectMerges(norms) {
  const merges = new Map();      // loser → survivor
  const folded = new Set();
  for (let i = 0; i < norms.length; i++) {
    for (let j = i + 1; j < norms.length; j++) {
      const a = norms[i], b = norms[j];
      if (a.project !== b.project) continue;
      if (folded.has(a.key) || folded.has(b.key)) continue;
      const sharedComp = (a.components || []).some((c) => (b.components || []).includes(c));
      const linked = (a.links || []).some((l) => (l.type === "Relates" || l.type === "Duplicate") && l.target === b.key)
                  || (b.links || []).some((l) => (l.type === "Relates" || l.type === "Duplicate") && l.target === a.key);
      if (titleSimilarity(a.summary, b.summary) >= 0.6 && (sharedComp || linked)) {
        // survivor = more worklog, tie → earlier numeric key
        const aw = worklogSeconds(a), bw = worklogSeconds(b);
        const survivor = aw !== bw ? (aw > bw ? a : b) : (numId(a.key) <= numId(b.key) ? a : b);
        const loser = survivor === a ? b : a;
        merges.set(loser.key, survivor.key);
        folded.add(loser.key);
      }
    }
  }
  return merges;
}

export function auditIssues(norms, restructure, opts = {}) {
  const merges = opts.detectMerges === true ? detectMerges(norms) : new Map();
  const dispositions = [];
  let kept = 0, dropped = 0, merged = 0;

  for (const n of norms) {
    const type = mapType(n.type);
    const res = n.resolution ? String(n.resolution).toLowerCase() : null;
    const terminalNoRes = isType(type) && n.status && isTerminal(type, mapStatus(type, n.status, n.statusCategory).status) && !res;

    if (res && DROP_RESOLUTIONS.has(res)) {
      dispositions.push({ id: n.key, type, disposition: "drop", reason: `resolution: ${n.resolution}`,
        proposed_status: null, proposed_parent: null });
      dropped++; continue;
    }
    if (terminalNoRes) {
      dispositions.push({ id: n.key, type, disposition: "drop", reason: "abandoned (terminal status, no resolution)",
        proposed_status: null, proposed_parent: null });
      dropped++; continue;
    }
    if (merges.has(n.key)) {
      const survivor = merges.get(n.key);
      dispositions.push({ id: n.key, type, disposition: `merge-into:${survivor}`,
        reason: `duplicate of ${survivor}`, proposed_status: null, proposed_parent: null });
      merged++; continue;
    }

    const proposedParent = restructure.parents.get(n.key) ?? null;
    const { status } = isType(type) ? mapStatus(type, n.status, n.statusCategory) : { status: null };
    const reParented = proposedParent !== (n.parent ?? null) && proposedParent !== null;
    dispositions.push({
      id: n.key, type,
      disposition: reParented ? `re-parent:${proposedParent}` : "keep",
      reason: reParented ? `parent ${n.parent ?? "∅"} → ${proposedParent}` : (n.resolution ? `resolution: ${n.resolution}` : "in-flight"),
      proposed_status: status, proposed_parent: proposedParent,
    });
    kept++;
  }
  return { dispositions, stats: { source: norms.length, kept, dropped, merged } };
}
