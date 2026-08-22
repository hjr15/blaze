// scripts/model/ref-allocator.mjs — REQ-nnn / ADR-nnnn allocation.
//
// The ref is the CITATION and the ticket id is the identity. A ref appears in commit
// messages, code comments and audit submissions, so reusing one silently redirects
// every existing citation. Gaps are correct; contiguity is not a goal.
export const REF_PATTERNS = {
  requirement:  { prefix: "REQ", pad: 3 },
  architecture: { prefix: "ADR", pad: 4 },
};

export function parseRef(ref) {
  const s = String(ref ?? "");
  for (const [kind, { prefix, pad }] of Object.entries(REF_PATTERNS)) {
    const m = s.match(new RegExp(`^${prefix}-(\\d{${pad},})$`));
    if (m) return { kind, num: Number(m[1]) };
  }
  return null;
}

export function nextRef({ kind, existing = [] }) {
  const spec = REF_PATTERNS[kind];
  if (!spec) throw new Error(`no ref scheme for kind ${JSON.stringify(kind)}`);
  let max = 0;
  for (const r of existing) {
    const p = parseRef(r);
    if (p?.kind === kind && p.num > max) max = p.num;
  }
  return `${spec.prefix}-${String(max + 1).padStart(spec.pad, "0")}`;
}
