// scripts/migrate/merge.mjs — pure: fold approved merges. For each ledger
// `merge-into:A` on B, the survivor A absorbs B's worklog + typed links + any
// unique AC, plus a `Duplicate` breadcrumb pointing at B. B is folded away (logged,
// not written). Survivors excludes dropped + merged-away keys.
const AC_HEADING = "## Acceptance Criteria";

export function extractAC(description) {
  const lines = String(description ?? "").split("\n");
  const out = [];
  let inAC = false;
  for (const line of lines) {
    if (line.trim() === AC_HEADING) { inAC = true; continue; }
    if (inAC && /^##\s/.test(line.trim())) break;
    if (inAC && /^\s*-\s*\[.?\]/.test(line)) out.push(line.trim());
  }
  return out;
}

function appendAC(description, acLines) {
  if (acLines.length === 0) return description;
  const existing = new Set(extractAC(description).map((s) => s.replace(/\[.?\]/, "[ ]")));
  const fresh = acLines.filter((s) => !existing.has(s.replace(/\[.?\]/, "[ ]")));
  if (fresh.length === 0) return description;
  if (!description.includes(AC_HEADING)) return `${description}\n\n${AC_HEADING}\n${fresh.join("\n")}\n`;
  // Insert after the AC heading line.
  const lines = description.split("\n");
  const idx = lines.findIndex((l) => l.trim() === AC_HEADING);
  lines.splice(idx + 1, 0, ...fresh);
  return lines.join("\n");
}

export function foldMerges(byKey, dispositions) {
  const dispById = new Map(dispositions.map((d) => [d.id, d.disposition]));
  const folded = new Set();
  const survivors = new Map();

  // Seed survivors with kept/re-parented items (clone so we can mutate safely).
  for (const [key, issue] of byKey) {
    const d = dispById.get(key) || "keep";
    if (d === "drop" || d.startsWith("merge-into:")) continue;
    survivors.set(key, { ...issue, worklog: [...(issue.worklog || [])], links: [...(issue.links || [])] });
  }

  for (const disp of dispositions) {
    if (!disp.disposition.startsWith("merge-into:")) continue;
    const survivorKey = disp.disposition.slice("merge-into:".length);
    const loser = byKey.get(disp.id);
    const survivor = survivors.get(survivorKey);
    folded.add(disp.id);
    if (!loser || !survivor) continue;
    survivor.worklog.push(...(loser.worklog || []));
    for (const l of loser.links || []) {
      // FIX 1: skip any link from the loser whose target is the survivor itself (self-link guard)
      if (l.target === survivorKey) continue;
      if (!survivor.links.some((x) => x.type === l.type && x.target === l.target)) survivor.links.push(l);
    }
    if (!survivor.links.some((x) => x.type === "Duplicate" && x.target === disp.id)) {
      survivor.links.push({ type: "Duplicate", target: disp.id });
    }
    survivor.description = appendAC(survivor.description, extractAC(loser.description));
  }
  return { survivors, folded };
}

// FIX 2: resolve a survivor set's links against the final written-id set:
//  - rewrite a NON-Duplicate link whose target is a merged-away loser → that loser's survivor
//  - drop a NON-Duplicate link whose (post-rewrite) target is the survivor's own id (self-link)
//  - drop a NON-Duplicate link whose (post-rewrite) target is not in the written-id set (dangling)
//  - dedup links by type+target
// `Duplicate` links are EXEMPT (they are intentional breadcrumbs that may reference a
// merged-away / dropped id). Pure; returns cleaned survivors + an integrity report.
export function resolveLinkIntegrity(survivors, dispositions) {
  const mergeMap = new Map();
  for (const d of dispositions) {
    if (typeof d.disposition === "string" && d.disposition.startsWith("merge-into:")) {
      mergeMap.set(d.id, d.disposition.slice("merge-into:".length));
    }
  }
  const writtenIds = new Set(survivors.keys());
  const rewritten = [], dropped = [];
  const out = new Map();
  for (const [key, issue] of survivors) {
    const seen = new Set();
    const cleaned = [];
    for (const link of issue.links || []) {
      if (link.type === "Duplicate") { // breadcrumb — keep as-is (deduped)
        const sig = `Duplicate::${link.target}`;
        if (!seen.has(sig)) { seen.add(sig); cleaned.push({ type: link.type, target: link.target }); }
        continue;
      }
      let target = link.target;
      if (mergeMap.has(target)) { rewritten.push({ on: key, from: target, to: mergeMap.get(target), type: link.type }); target = mergeMap.get(target); }
      if (target === key) { dropped.push({ on: key, target, type: link.type, reason: "self-link" }); continue; }
      if (!writtenIds.has(target)) { dropped.push({ on: key, target, type: link.type, reason: "target not written" }); continue; }
      const sig = `${link.type}::${target}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      cleaned.push({ type: link.type, target });
    }
    out.set(key, { ...issue, links: cleaned });
  }
  return { survivors: out, integrity: { rewritten, dropped } };
}
