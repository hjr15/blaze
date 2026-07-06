// scripts/model/ticket.mjs — parse/serialize a Blaze ticket: a YAML-subset
// frontmatter block + a markdown body. Zero-dependency; handles exactly the
// field shapes Blaze uses (scalars, flow arrays [a,b], block lists of inline
// {k: v} objects). Not a general YAML parser — round-trip safe for our schema.

const DELIM = "---";

function coerceScalar(raw) {
  const s = raw.trim();
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s.startsWith('"') && s.endsWith('"')) {
    // Double-quoted: decode JSON escape sequences (dumpScalar uses JSON.stringify to
    // quote strings containing commas, so we must reverse that here).
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  return s;
}

function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0, quote = null, cur = "";
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

function parseFlowArray(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === "") return [];
  return splitTopLevel(inner, ",").map(coerceScalar);
}

// Note: inline-object values containing a comma must be quoted in the source file
// (e.g. `{ k: "a, b" }`). The serializer (dumpScalar) always quotes such values;
// hand-written files must do the same — an unquoted comma splits the value.
function parseInlineObject(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  const obj = {};
  for (const part of splitTopLevel(inner, ",")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    obj[part.slice(0, idx).trim()] = coerceScalar(part.slice(idx + 1));
  }
  return obj;
}

export function parseTicket(text) {
  const lines = text.split("\n");
  if (lines[0].trim() !== DELIM) throw new Error("ticket: missing frontmatter (--- on line 1)");
  const fm = {};
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === DELIM) { i++; break; }
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    // Only identifier-style keys (alphanumeric + underscore) are matched.
    // Hyphenated YAML keys (e.g. "some-key") are intentionally ignored — they
    // are not part of the Blaze schema.
    const m = /^([A-Za-z0-9_]+):(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    if (rest === "") {
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        const itemRaw = lines[j].replace(/^\s+-\s+/, "").trim();
        items.push(itemRaw.startsWith("{") ? parseInlineObject(itemRaw) : coerceScalar(itemRaw));
        j++;
      }
      if (items.length > 0) { fm[key] = items; i = j - 1; } else fm[key] = null;
    } else if (rest.startsWith("[")) {
      fm[key] = parseFlowArray(rest);
    } else {
      fm[key] = coerceScalar(rest);
    }
  }
  const body = lines.slice(i).join("\n").replace(/^\n+/, "");
  return { frontmatter: fm, body };
}

const FIELD_ORDER = [
  "id", "title", "type", "project", "priority", "resolution", "parent",
  "assignee", "labels", "components", "estimate", "worklog", "links",
  "likelihood", "impact", "branch", "pr", "created", "updated",
];

function dumpScalar(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  // Quote strings containing a comma — an unquoted comma would break re-parse of a
  // flow array [a, b] or an inline object { k: v, ... }. Colons in values are fine.
  return s.includes(",") ? JSON.stringify(s) : s;
}

function dumpInlineObject(obj) {
  return `{ ${Object.entries(obj).map(([k, v]) => `${k}: ${dumpScalar(v)}`).join(", ")} }`;
}

export function serializeTicket({ frontmatter, body }) {
  const keys = [
    ...FIELD_ORDER.filter((k) => k in frontmatter),
    ...Object.keys(frontmatter).filter((k) => !FIELD_ORDER.includes(k)),
  ];
  const out = [DELIM];
  for (const key of keys) {
    const v = frontmatter[key];
    if (Array.isArray(v)) {
      if (v.length === 0) { out.push(`${key}: []`); continue; }
      if (typeof v[0] === "object" && v[0] !== null) {
        out.push(`${key}:`);
        for (const item of v) out.push(`  - ${dumpInlineObject(item)}`);
      } else {
        out.push(`${key}: [${v.map(dumpScalar).join(", ")}]`);
      }
    } else {
      out.push(`${key}: ${dumpScalar(v)}`);
    }
  }
  out.push(DELIM, "", body.replace(/\n+$/, ""), "");
  return out.join("\n");
}
