// scripts/audit-runner.mjs — `blaze audit`: corpus hygiene over the whole board.
// Run: node scripts/audit-runner.mjs [--projects A,B] [--kind k] [--json] [projectsDir]
//
// Read-only. Exits non-zero only on a HARD finding — a soft finding is a fill queue and
// must never fail a run (blaze-pm ADR-0011). BLZ-137.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { walkTickets } from "./model/index.mjs";
import { auditCorpus, summarise, HARD_KINDS } from "./model/audit.mjs";
import { resolveRoots, loadConfig } from "./config.mjs";

const positional = [];
const opts = { projects: null, kind: null, json: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--json") { opts.json = true; continue; }
  if (a === "--projects") { opts.projects = process.argv[++i]?.split(",").map((s) => s.trim()).filter(Boolean); continue; }
  if (a === "--kind") { opts.kind = process.argv[++i]; continue; }
  if (a === "--help" || a === "-h") { usage(); process.exit(0); }
  if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); usage(); process.exit(1); }
  positional.push(a);
}

function usage() {
  console.error("usage: blaze audit [--projects A,B] [--kind <kind>] [--json] [projectsDir]");
  console.error("  Reports corpus hygiene. Exits non-zero on a HARD finding only.");
  console.error(`  hard: ${[...HARD_KINDS].sort().join(", ")}`);
  console.error("  soft: empty-components, empty-labels, missing-parent");
}

// BLZ-133's pattern: an explicit projectsDir is self-sufficient, so resolve it BEFORE
// touching the ambient roots — otherwise `blaze audit /path/to/projects` throws from a cwd
// that has no board, which is exactly the invocation that does not need one.
const explicit = positional[0] ? resolvePath(positional[0]) : null;
const roots = explicit ? null : resolveRoots();
const projectsDir = explicit || roots.projectsDir;
const dataRoot = explicit ? dirname(explicit) : roots.dataRoot;
let config = null;
try { config = loadConfig({ root: dataRoot }); } catch { config = null; }

// The project set comes from the config, never from a hardcoded list — the stale-default
// bug the Python original carried (it audited 2 of 11 projects for months).
//
// Each source must be non-EMPTY to win, not merely non-null. `loadConfig` returns
// `projects: []` when there is no config file, and `??` accepts an empty array happily —
// which made `blaze audit <dir>` report "0 tickets, clean, ok=true" over a corpus it had
// never looked at. A gate that passes because it measured nothing is worse than no gate.
const nonEmpty = (a) => (Array.isArray(a) && a.length ? a : null);
const keys = nonEmpty(opts.projects)
  ?? nonEmpty(config?.projects)
  ?? readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

// And having resolved them, refuse to report success over an empty corpus.
if (!keys.length) { console.error(`no projects found under ${projectsDir}`); process.exit(2); }

const projects = {};
for (const k of keys) {
  try { projects[k] = JSON.parse(readFileSync(join(projectsDir, k, "project.json"), "utf8")); }
  catch { projects[k] = { key: k }; }
}

const wanted = new Set(keys);
const tickets = [];
// Status IS the directory (blaze-pm ADR-0001), so an id resolving to files under two status
// directories carries two contradictory statuses and every derived view silently picks one.
// This has to be caught HERE rather than in `auditCorpus`: ticket identity is a property of
// the WALK — which paths exist — and the pure function is a function of frontmatter, which
// carries no path. BLZ-122 / REQ-035.
const filesById = new Map();
for (const t of walkTickets(projectsDir)) {
  const id = t.frontmatter?.id;
  if (!id || !wanted.has(String(id).split("-")[0])) continue;
  tickets.push(t);
  if (!filesById.has(id)) filesById.set(id, []);
  filesById.get(id).push(t.file);
}

const report = auditCorpus({ tickets, projects, config });

// One finding per id naming EVERY path, not one per surplus copy: an operator told about a
// single path goes hunting for the other, which is the failure mode itself.
for (const [id, files] of filesById) {
  if (files.length > 1) {
    report.findings.push({ ticket: id, kind: "duplicate-status", detail: files.sort().join(", ") });
  }
}
// auditCorpus computed `ok` before the walk-level findings existed, so recompute it — a gate
// that reports a hard finding and still exits 0 is not a gate.
report.ok = !report.findings.some((f) => HARD_KINDS.has(f.kind));

const findings = opts.kind ? report.findings.filter((f) => f.kind === opts.kind) : report.findings;

if (opts.json) {
  console.log(JSON.stringify({ ...report, findings }, null, 2));
} else {
  console.log("=== blaze audit ===");
  console.log(`  ${tickets.length} tickets across ${keys.length} project(s)`);
  if (opts.kind) {
    for (const f of findings) console.log(`  ${f.ticket}  ${f.kind}  ${f.detail}`);
    if (!findings.length) console.log(`  no '${opts.kind}' findings`);
  } else {
    for (const s of summarise(report.findings)) console.log(`  [${s.severity}] ${s.kind}: ${s.count}`);
    if (!report.findings.length) console.log("  clean");
  }
  console.log(`  ok=${report.ok}${report.ok ? "" : "  (hard findings present)"}`);
}

// Set the code rather than calling process.exit(): stdout to a PIPE is asynchronous, and
// exiting immediately after a large console.log truncates it mid-write. The --json payload
// on a real board is well past the pipe buffer, so this is not theoretical — it truncated
// at 64KB the first time it was piped.
process.exitCode = report.ok ? 0 : 1;
