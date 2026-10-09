// scripts/model/matrices.mjs — the requirements and architecture matrices (BLZ-682).
//
// A PORT of blaze-pm's `scripts/build_matrices.py`, kept byte-for-byte compatible with its
// output: the 22 files it generates are the acceptance oracle (generator-oracle — a zero
// `diff -r` against what the script writes for the same tree). That is why some choices below
// look odd for JavaScript — `None` printed for a parent with no `ref`, `cat[:4]` truncation,
// goals sorted as strings. Each mirrors a line of the script; "fixing" one breaks the oracle.
//
// Pure: it takes tickets the CALLER read (through `resolveReadStorage`, so fs, dual and db all
// work) and a `pathOf(ticket)` for the link column, and returns `{ fileName: text }`.

/** The script's frontmatter values are raw strings; the engine's are parsed. Normalise. */
const s = (v) => (v === null || v === undefined ? "" : Array.isArray(v) ? v.join(", ") : String(v));
/** Python's `d.get(k, dflt)`: the default only when the key is ABSENT. A key written with no
 *  value (`ref:`) is present and empty — the engine's parser reads it as `[]`. The database
 *  readers return `""` for a NULL column, which is the database's spelling of ABSENT, so `""`
 *  takes the default too; that keeps a db-mode matrix equal to the fs-mode one. */
const get = (fm, k, dflt) => (fm && Object.hasOwn(fm, k) && fm[k] !== null && fm[k] !== undefined
  && fm[k] !== "" ? s(fm[k]) : dflt);

const ID_HEAD = /^([A-Z]+-\d+)/;

/** `_links`: typed links whose type is letters and whose target STARTS with `[A-Z]+-\d+`. */
function linksOf(t) {
  const out = [];
  for (const l of Array.isArray(t.frontmatter?.links) ? t.frontmatter.links : []) {
    const ty = /^([A-Za-z]+)/.exec(s(l?.type));
    const tg = ID_HEAD.exec(s(l?.target));
    if (ty && tg) out.push([ty[1], tg[1]]);
  }
  return out;
}

const idKey = (id) => { const [p, n] = id.split("-"); return [p, Number(n)]; };
const byIdNumeric = (a, b) => {
  const [pa, na] = idKey(a), [pb, nb] = idKey(b);
  return pa < pb ? -1 : pa > pb ? 1 : na - nb;
};
// Python's default string ordering is by code point; so is `<` on JS strings for BMP text.
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function implementers(req, tickets) {
  const rid = s(req.frontmatter.id);
  return tickets.filter((t) => linksOf(t).some(([ty, tg]) => ty === "Implements" && tg === rid))
    .map((t) => s(t.frontmatter.id)).sort(byIdNumeric);
}

function addresses(req, tickets) {
  const rid = s(req.frontmatter.id);
  const refs = tickets.filter((t) => s(t.frontmatter.type) === "architecture"
      && linksOf(t).some(([ty, tg]) => ty === "Addresses" && tg === rid))
    .map((t) => get(t.frontmatter, "ref", "")).sort(byStr);
  const linked = refs.filter(Boolean).join(", ");
  const external = [...new Set([...s(req.body).matchAll(/\bengine (ADR-\d+)/g)].map((m) => m[1]))].sort(byStr);
  if (linked || external.length) {
    const parts = linked ? [linked] : [];
    if (external.length) parts.push("engine " + external.join(", "));
    return parts.join("; ");
  }
  const m = /\*\*Addresses:\*\*\s*(.+)/.exec(s(req.body));
  return m ? m[1].trim() : "";
}

/** `list.sort(key=…)` by `ref`, ties broken by the ticket's PATH. The script's ties fall in
 *  `glob.glob` order, which is the filesystem's directory order — arbitrary, and different on
 *  two machines. Path order is what a sorted glob gives, so it is the one deterministic order
 *  the script's output can be checked against (`sorted(glob.glob(…))`, a no-op on its rules). */
const sortedBy = (arr, key, pathOf) => arr.map((v) => [key(v), pathOf(v), v])
  .sort((a, b) => byStr(a[0], b[0]) || byStr(a[1], b[1])).map((x) => x[2]);

export function requirementsMatrix(tickets, project, pathOf) {
  const reqs = sortedBy(tickets.filter((t) => s(t.frontmatter.type) === "requirement"),
    (t) => get(t.frontmatter, "ref", ""), pathOf);
  const goals = new Map(tickets.filter((t) => s(t.frontmatter.type) === "goal")
    .map((t) => [s(t.frontmatter.id), s(t.frontmatter.title)]));
  const met = reqs.filter((r) => r.status === "implemented");
  const future = reqs.filter((r) => r.status !== "implemented");
  const untraced = met.filter((r) => implementers(r, tickets).length === 0);
  const L = [];
  L.push(`# ${project} requirements traceability matrix`, "");
  L.push("> **Derived view — do not edit.** Regenerate with "
    + "`python3 scripts/build_matrices.py`. The tickets are the source of "
    + "truth (ADR-0015). A hand-edit here will be overwritten and, worse, "
    + "believed in the meantime.", "");
  L.push(`- **${reqs.length}** requirements — ${met.length} implemented, ${future.length} proposed`);
  L.push(`- **${reqs.reduce((n, r) => n + implementers(r, tickets).length, 0)}** traced delivery tickets`);
  L.push(`- **${untraced.length}** implemented requirements with no delivery ticket recorded`, "");
  for (const [gid, gtitle] of [...goals].sort((a, b) => byStr(a[0], b[0]))) {
    const rows = reqs.filter((r) => get(r.frontmatter, "parent", null) === gid);
    if (!rows.length) continue;
    L.push(`## ${gid} — ${gtitle}`, "");
    L.push("| Ref | Requirement | Cat | Verify | Status | Implemented by | Addresses |");
    L.push("|---|---|---|---|---|---|---|");
    for (const r of rows) {
      const fm = r.frontmatter;
      const impl = implementers(r, tickets).join(", ") || "—";
      L.push(`| \`${get(fm, "ref", "?")}\` | [${get(fm, "title", "")}](../../${pathOf(r)}) | `
        + `${get(fm, "category", "").slice(0, 4)} | ${get(fm, "verification", "").slice(0, 5)} | `
        + `${r.status} | ${impl} | ${addresses(r, tickets) || "—"} |`);
    }
    L.push("");
  }
  return L.join("\n") + "\n";
}

export function architectureMatrix(tickets, project, pathOf) {
  const adrs = sortedBy(tickets.filter((t) => s(t.frontmatter.type) === "architecture"),
    (t) => get(t.frontmatter, "ref", ""), pathOf);
  const reqs = new Map(tickets.filter((t) => s(t.frontmatter.type) === "requirement")
    .map((t) => [s(t.frontmatter.id), t]));
  const L = [];
  L.push(`# ${project} architecture decision matrix`, "");
  L.push("> **Derived view — do not edit.** Regenerate with "
    + "`python3 scripts/build_matrices.py`.", "");
  L.push(`- **${adrs.length}** decisions`);
  const byStatus = new Map();
  for (const a of adrs) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
  L.push("- by status: " + [...byStatus].sort((a, b) => byStr(a[0], b[0]))
    .map(([k, v]) => `**${v}** ${k}`).join(", "));
  const parentOf = (a) => get(a.frontmatter, "parent", null);
  const untraced = adrs.filter((a) => !reqs.has(parentOf(a)));
  L.push(`- **${untraced.length}** answering no stated requirement `
    + "(parented to a goal — legal, and counted rather than hidden)", "");
  L.push("| Ref | Decision | Status | Answers | Ticket |");
  L.push("|---|---|---|---|---|");
  for (const a of adrs) {
    const par = reqs.get(parentOf(a));
    // Python formats a missing value as `None` — reproduced, not corrected.
    const answers = par
      ? `\`${get(par.frontmatter, "ref", "None")}\` ${get(par.frontmatter, "title", "None")}`
      : `— *(untraced; under ${parentOf(a) ?? "None"})*`;
    L.push(`| \`${get(a.frontmatter, "ref", "?")}\` | [${get(a.frontmatter, "title", "")}](../../${pathOf(a)}) | `
      + `${a.status} | ${answers} | ${get(a.frontmatter, "id", "None")} |`);
  }
  L.push("");
  L.push("Reference a decision by its **designator** (`ADR-0011`), never by path — "
    + "an architecture ticket's path changes with its status (ADR-0017).");
  return L.join("\n") + "\n";
}

/** Both files for one project, keyed by the script's own file names. */
export function matrixFiles(tickets, project, pathOf) {
  const mine = tickets.filter((t) => t.project === project);
  return {
    [`${project.toLowerCase()}-requirements-matrix.md`]: requirementsMatrix(mine, project, pathOf),
    [`${project.toLowerCase()}-architecture-matrix.md`]: architectureMatrix(mine, project, pathOf),
  };
}
