// scripts/migrate/report.mjs — pure: render the human-readable MIGRATION-AUDIT.md
// and the disposition-ledger object. The report is the reviewable proposal; the
// ledger is the editable, authoritative sign-off artifact.
export function renderLedger(dispositions, source) {
  return { source, items: dispositions };
}

function countByProjectType(norms) {
  const m = {};
  for (const n of norms) {
    m[n.project] ??= {};
    m[n.project][n.type] = (m[n.project][n.type] || 0) + 1;
  }
  return m;
}

export function renderAudit({ norms, dispositions, restructure, warnings = [], integrity = { rewritten: [], dropped: [] } }) {
  const drops = dispositions.filter((d) => d.disposition === "drop");
  const merges = dispositions.filter((d) => d.disposition.startsWith("merge-into:"));
  const keeps = dispositions.filter((d) => d.disposition === "keep" || d.disposition.startsWith("re-parent:"));
  const counts = countByProjectType(norms);

  const out = [];
  out.push("# Migration Audit", "");
  out.push(`**Source:** ${norms.length} issues · **kept:** ${keeps.length} · **dropped:** ${drops.length} · **merged:** ${merges.length}`, "");

  out.push("## Counts (per project × type)", "");
  for (const project of Object.keys(counts).sort()) {
    out.push(`### ${project}`);
    for (const type of Object.keys(counts[project]).sort()) out.push(`- ${type}: ${counts[project][type]}`);
    out.push("");
  }

  out.push("## Dropped (non-Done terminal — NOT written)", "");
  if (drops.length === 0) out.push("_none_", "");
  for (const d of drops) out.push(`- ${d.id} — ${d.reason}`);
  out.push("");

  out.push("## Merge candidates (folded into survivor — NOT written)", "");
  if (merges.length === 0) out.push("_none_", "");
  for (const d of merges) out.push(`- ${d.id} → ${d.disposition.slice("merge-into:".length)} (${d.reason})`);
  out.push("");

  out.push("## Restructure flags", "");
  const f = restructure.flags;
  out.push(`- orphans: ${f.orphans.join(", ") || "_none_"}`);
  out.push(`- mis-levelled: ${f.misLevelled.join(", ") || "_none_"}`);
  out.push(`- ambiguous parent: ${f.ambiguous.join(", ") || "_none_"}`);
  out.push(`- Relates→parent normalised: ${f.relatesNormalised.join(", ") || "_none_"}`, "");

  out.push("## Warnings (unmapped / validation — review)", "");
  if (warnings.length === 0) out.push("_none_", "");
  for (const w of warnings) out.push(`- ${w}`);
  out.push("");

  out.push("## Link integrity", "");
  if (integrity.rewritten.length === 0 && integrity.dropped.length === 0) {
    out.push("_none_", "");
  } else {
    for (const r of integrity.rewritten) out.push(`- ${r.on}: ${r.type} ${r.from} → ${r.to}`);
    for (const d of integrity.dropped) out.push(`- ${d.on}: dropped ${d.type} → ${d.target} (${d.reason})`);
    out.push("");
  }

  out.push("---", "_Edit `migration/disposition-ledger.json` to override any disposition, then run `blaze migrate --live`._");
  return out.join("\n");
}
