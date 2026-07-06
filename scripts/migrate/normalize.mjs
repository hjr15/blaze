// scripts/migrate/normalize.mjs — pure: raw Jira-Cloud issue JSON → NormalizedIssue.
// Quarantines the raw payload shape so the downstream cores work on a stable shape.
// CUSTOM_FIELDS holds Risk custom-field IDs — real IDs discovered from a live
// payload at build time and edited here (placeholders until then).
export const CUSTOM_FIELDS = { likelihood: "customfield_10040", impact: "customfield_10004" };

// Best-effort ADF → text. A string passes through; null → "".
export function adfToText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  let out = "";
  if (node.text) out += node.text;
  if (Array.isArray(node.content)) {
    for (const child of node.content) out += adfToText(child);
    if (node.type === "paragraph" || node.type === "heading") out += "\n";
  }
  return out;
}

function dateOnly(s) { return s ? String(s).slice(0, 10) : null; }
function fieldVal(v) { return v == null ? null : (typeof v === "object" ? (v.value ?? v.name ?? null) : v); }
// Worklog notes are stored as a single-line frontmatter inline-object value, so
// collapse any newlines (a multi-line value would break the YAML-subset re-parse).
function cleanNote(s) { if (!s) return null; const t = String(s).replace(/\s*\n\s*/g, " ").trim(); return t || null; }

export function normalizeIssue(raw, fields = CUSTOM_FIELDS) {
  const f = raw.fields || {};
  const worklogs = (f.worklog && f.worklog.worklogs) || [];
  const links = [];
  for (const l of f.issuelinks || []) {
    const other = l.outwardIssue || l.inwardIssue;
    if (l.type && l.type.name && other && other.key) links.push({ type: l.type.name, target: other.key });
  }
  return {
    key: raw.key,
    project: (f.project && f.project.key) || (raw.key ? String(raw.key).split("-")[0] : null),
    type: (f.issuetype && f.issuetype.name) || null,
    summary: f.summary || "",
    description: adfToText(f.description),
    status: (f.status && f.status.name) || null,
    statusCategory: (f.status && f.status.statusCategory && f.status.statusCategory.key) || null,
    resolution: (f.resolution && f.resolution.name) || null,
    priority: (f.priority && f.priority.name) || null,
    assignee: (f.assignee && f.assignee.displayName) || null,
    labels: f.labels || [],
    components: (f.components || []).map((c) => c.name),
    parent: (f.parent && f.parent.key) || null,
    estimateSeconds: typeof f.timeoriginalestimate === "number" ? f.timeoriginalestimate : null,
    worklog: worklogs.map((w) => ({
      date: dateOnly(w.started), seconds: w.timeSpentSeconds || 0,
      author: (w.author && w.author.displayName) || null,
      note: cleanNote(typeof w.comment === "string" ? w.comment : adfToText(w.comment)),
    })),
    links,
    likelihood: fieldVal(f[fields.likelihood]),
    impact: fieldVal(f[fields.impact]),
    created: dateOnly(f.created),
    updated: dateOnly(f.updated),
  };
}
