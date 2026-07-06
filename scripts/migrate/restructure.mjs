// scripts/migrate/restructure.mjs — pure: propose a coherent Goal/Epic hierarchy.
// Keeps legal native parents; normalises the free-tier Goal↔Epic Relates-link
// workaround (used when a paid Jira tier's native Epic-link isn't available)
// into a native parent; flags orphans / mis-levelled / ambiguous items.
// Output feeds the ledger's proposed_parent (the user signs off).
import { canParent, isType } from "../model/schema.mjs";
import { mapType } from "./map.mjs";

export function proposeStructure(norms) {
  const byKey = new Map(norms.map((n) => [n.key, n]));
  const typeOf = (key) => { const n = byKey.get(key); return n ? mapType(n.type) : null; };

  const parents = new Map();
  const flags = { orphans: [], misLevelled: [], ambiguous: [], relatesNormalised: [] };

  for (const n of norms) {
    const childType = mapType(n.type);
    if (!isType(childType)) { parents.set(n.key, null); continue; }

    // 1) Native parent, if legal.
    if (n.parent) {
      const pt = typeOf(n.parent);
      if (pt && canParent(childType, pt)) { parents.set(n.key, n.parent); continue; }
      if (pt) { parents.set(n.key, null); flags.misLevelled.push(n.key); continue; }
      // unknown native parent key → fall through to Relates / orphan handling
    }

    // 2) Relates-link candidates whose type is a legal parent.
    const candidates = (n.links || [])
      .filter((l) => l.type === "Relates")
      .map((l) => l.target)
      .filter((k) => { const pt = typeOf(k); return pt && canParent(childType, pt); });

    if (candidates.length === 1) {
      parents.set(n.key, candidates[0]);
      flags.relatesNormalised.push(n.key);
      continue;
    }
    if (candidates.length > 1) { parents.set(n.key, null); flags.ambiguous.push(n.key); continue; }

    // 3) No resolved parent. Orphan only if this type expects one. Goals are
    // top-level; Risks may parent to goal/epic but are allowed top-level here →
    // neither is orphaned for "no parent".
    parents.set(n.key, null);
    const needsParent = ["epic", "story", "task", "bug", "subtask"].includes(childType);
    if (needsParent) flags.orphans.push(n.key);
  }
  return { parents, flags };
}
