// scripts/audit-runner.mjs — `blaze audit`: corpus hygiene over the whole board.
// Run: node scripts/audit-runner.mjs [--projects A,B] [--kind k] [--json] [projectsDir]
//
// Read-only. Exits non-zero only on a HARD finding — a soft finding is a fill queue and
// must never fail a run (blaze-pm ADR-0011). BLZ-137.
import { readFileSync } from "node:fs";
import { join, dirname, basename, resolve as resolvePath } from "node:path";
import { fsReadStorage } from "./model/read-storage.mjs";
import { auditCorpus, summarise, HARD_KINDS, SOFT_KINDS, scheduleFindings } from "./model/audit.mjs";
import { scheduleModel } from "./model/schedule.mjs";
import { resolveSchema } from "./model/schema-config.mjs";
import { resolveRoots, loadConfig, ConfigParseError, IncompatibleSchemaVersionError } from "./config.mjs";

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
  // Hardcoded, and it went stale twice — the hard line beside it is derived from HARD_KINDS
  // and cannot. Kept in one place with the kinds that actually exist.
  console.error(`  soft: ${SOFT_KINDS.join(", ")}`);
}

// BLZ-133's pattern: an explicit projectsDir is self-sufficient, so resolve it BEFORE
// touching the ambient roots — otherwise `blaze audit /path/to/projects` throws from a cwd
// that has no board, which is exactly the invocation that does not need one.
const explicit = positional[0] ? resolvePath(positional[0]) : null;
const roots = explicit ? null : resolveRoots();
const projectsDir = explicit || roots.projectsDir;
const dataRoot = explicit ? dirname(explicit) : roots.dataRoot;
// BLZ-392 established a NARROW tolerance: a `loadConfig` throw for one of exactly two
// reasons — the file cannot even PARSE, or its `schemaVersion` stamp is outside the
// engine's supported window — is treated as absent, `config = null`, the disk-listing
// fallback below stands in for `config.projects`, and the run still reports `ok=true` if
// the corpus itself is clean. That is deliberate: there is nothing to salvage from a file
// that could not be parsed, or that was written against a contract this engine does not
// speak, so tolerating either is no different from auditing a board with no config file.
//
// BLZ-402 review finding 1, and round-2 finding 3, are DIFFERENT cases, and must not be
// folded into that tolerance. `assertValidKey` (BLZ-402) makes `loadConfig` throw
// `InvalidProjectKeyError` on a board it USED to accept and finish loading — the exact
// board BLZ-396 shipped a `schema-invalid` finding for — and a malformed `schedule` block
// (wrong shape, an unknown key, a bad `minutes_per_day`/`working_days`) is a genuine load
// failure of the same kind: not a parse failure, not a version mismatch, but the config
// failing to produce a usable value. Round 2's own review measured that the first cut of
// this fix caught ONLY the key case and left every schedule-shape failure reporting
// `ok=true` — the very defect this lane exists to close, in a new place. Round 3 found a
// THIRD instance of the same shape: a config that sets a REMOVED key (`provider`,
// `terminal`, `codeRepo`; BLZ-298) is also neither a parse failure nor a version mismatch
// — it says nothing about the `schemaVersion` stamp at all — yet `checkSchemaVersion` used
// to file it under the same `{ok:false}` shape as a version-window failure, so `loadConfig`
// wrapped it in `IncompatibleSchemaVersionError` and this runner tolerated it wholesale
// (`tests/fixtures/board-gate-removed-key`: audit `ok=true`, reconcile exit 1 on the same
// board). `scripts/model/schema-version.mjs` now discriminates the two reasons at the
// source, so a removed key throws a plain `Error`, same as a malformed `schedule` block.
// So: every `loadConfig` throw that is NOT a `ConfigParseError` and NOT an
// `IncompatibleSchemaVersionError` is its own case below: named, HARD, `ok=false` — never
// merged into "config is absent". `config` itself still ends up `null` on ANY throw
// (line 40 above / the schedule guard below), because nothing downstream can safely use a
// config that failed to load for whatever reason — only whether `ok` is allowed to stay
// `true` depends on WHICH reason.
let config = null;
let configLoadError = null;
try { config = loadConfig({ root: dataRoot }); }
catch (e) {
  if (!(e instanceof ConfigParseError) && !(e instanceof IncompatibleSchemaVersionError)) {
    configLoadError = e;
  }
}

// The project set comes from the config, never from a hardcoded list — the stale-default
// bug the Python original carried (it audited 2 of 11 projects for months).
//
// Each source must be non-EMPTY to win, not merely non-null. `loadConfig` returns
// `projects: []` when there is no config file, and `??` accepts an empty array happily —
// which made `blaze audit <dir>` report "0 tickets, clean, ok=true" over a corpus it had
// never looked at. A gate that passes because it measured nothing is worse than no gate.
const nonEmpty = (a) => (Array.isArray(a) && a.length ? a : null);
// BLZ-402 round-2 review finding 2: an earlier revision of this fix zeroed `keys` to `[]`
// whenever `configLoadError` was set, on the theory that a board whose config failed to
// load has "nothing safe to keep running against". That was wrong, and the runner itself
// disproves it two ways: `tickets` a few lines below comes from `fsReadStorage.listTickets`,
// and `schema-invalid` is read from each project's `project.json` on disk by `auditCorpus`'s
// own loop — NEITHER touches `config.projects`, so both are exactly as safe to compute with
// a bad key or a malformed schedule block as with none at all. `--projects <name>` already
// proved this empirically: it reported the full corpus (tickets, `schema-invalid`,
// everything) on a board whose config load had failed, while the flag-less path reported
// "0 tickets across 0 project(s)" on the SAME board — a false measurement statement in the
// grammar of a real count. The distinction that actually matters is not "report nothing vs
// report something", it is `ok=true` vs `ok=false` — and `ok` is decided below by the
// `config-unloadable` HARD finding, not by zeroing the denominator. So a config load failure
// falls back to the disk listing exactly like a config that failed to PARSE already does
// (BLZ-392's tolerance, untouched) — the disk-listing fallback can still silently include a
// stray directory the config never named, but that same risk exists, unremarked, for every
// other reason `config` can come back empty or null, and singling out this one reason to
// instead report a false zero was the actual defect.
const keys = nonEmpty(opts.projects)
  ?? nonEmpty(config?.projects)
  ?? fsReadStorage.listProjects(projectsDir);

// And having resolved them, refuse to report success over an empty corpus — UNLESS the
// reason nothing resolved is a config load failure, in which case that failure IS the
// report (the config-unloadable finding pushed below turns `ok` false and exits 1); a bare
// stderr line here would just be a second, incompatible way of saying it.
if (!keys.length && !configLoadError) { console.error(`no projects found under ${projectsDir}`); process.exit(2); }

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
for (const t of fsReadStorage.listTickets(projectsDir)) {
  const id = t.frontmatter?.id;
  if (!id || !wanted.has(String(id).split("-")[0])) continue;
  tickets.push(t);
  if (!filesById.has(id)) filesById.set(id, []);
  filesById.get(id).push(t.file);
}

const report = auditCorpus({ tickets, projects, config });

// BLZ-402 review finding 1: name the config-load failure as a first-class, HARD finding —
// not a swallowed exception. `report.ok` is recomputed below from `report.findings`
// against `HARD_KINDS`, so pushing this here (rather than a bespoke early exit) is what
// makes `ok=false` fall out of the same mechanism every other hard finding uses, and what
// makes it visible under both the plain report and `--json`.
if (configLoadError) {
  report.findings.push({ ticket: null, kind: "config-unloadable", detail: configLoadError.message });
}

// One finding per id naming EVERY path, not one per surplus copy: an operator told about a
// single path goes hunting for the other, which is the failure mode itself.
for (const [id, files] of filesById) {
  if (files.length > 1) {
    report.findings.push({ ticket: id, kind: "duplicate-status", detail: files.sort().join(", ") });
  }
}
// BLZ-353 / ruling R48: a goal must not be terminal while a requirement beneath it was only
// ever implemented, never verified. Raised HERE for the same reason `duplicate-status` is —
// status is the directory, so it is a property of the WALK, and `auditCorpus` is a function
// of frontmatter, which carries no path.
//
// The `goal:achieved` gate (gates.mjs) refuses this prospectively. This finding catches the
// states the gate cannot: a ticket moved by a direct file write, which bypasses `blaze`
// entirely, and any board that predates the gate. HARD rather than soft because it is not a
// fill queue — an achieved goal resting on unverified requirements is a corpus that asserts
// something untrue — and because it is affordable: measured across this board's 2,596
// tickets on 2026-08-23, 83 requirements sit at `implemented` and NONE has a terminal
// ancestor, so turning this on fails no existing board.
// This walks `parent` directly and touches NEITHER roll-up, deliberately. BLZ-353's ACs ask
// which is authoritative here; the answer is neither, because they compute different things:
// `model/rollup.mjs` rolls TIME (estimate/worklog) over `ticket.parent`, and
// `model/hierarchy-rollup.mjs` rolls arbitrary values over `hierarchy_membership` with
// duplicate-exclusion. Goal satisfaction is neither a time sum nor a hierarchy value, so
// reconciling those two is a real question (their parent models and dedup policies differ)
// but it is not this ticket's, and resolving it as a side effect here would be exactly the
// silent reconciliation the ACs warn against.
//
// KNOWN LIMITATION: `parent` is the only association this sees, because the markdown corpus
// is the only thing on disk. A requirement associated with a goal ONLY through a v4
// `hierarchy_membership` row would not be found. BLZ-374 made the table SHIP —
// `createDbSchema` now installs `hierarchy` and `hierarchy_membership` at DB schema version
// 2 — so this limitation is now reachable in principle. It is not reachable in practice yet:
// nothing WRITES a membership row (BLZ-360 section 8.3's roll-up and spec 4's seed are both
// unbuilt), and this runner reads the markdown corpus rather than the database. It becomes
// real the moment either lands, which is what BLZ-377 and spec 4's hierarchy seed do.
const statusOf = new Map();
const fmById = new Map();
for (const t of tickets) {
  const id = t.frontmatter?.id;
  if (!id) continue;
  statusOf.set(id, basename(dirname(t.file)));
  fmById.set(id, t.frontmatter);
}
const GOAL_TERMINAL = new Set(["done", "achieved", "accepted", "canceled", "duplicate"]);
const REQUIREMENT_SATISFYING = new Set(["verified", "rejected", "obsolete"]);
for (const [id, fm] of fmById) {
  if (fm.type !== "requirement") continue;
  if (REQUIREMENT_SATISFYING.has(statusOf.get(id))) continue;
  // Walk to the nearest terminal ancestor. Cycle-guarded: a malformed parent chain is
  // already its own finding, and this pass must not hang on one.
  const seen = new Set([id]);
  let parent = fm.parent || null;
  while (parent && fmById.has(parent) && !seen.has(parent)) {
    seen.add(parent);
    if (GOAL_TERMINAL.has(statusOf.get(parent))) {
      report.findings.push({ ticket: parent, kind: "terminal-goal-unverified-requirement",
        detail: `${id} is ${statusOf.get(id)}, not verified` });
      break;
    }
    parent = fmById.get(parent).parent || null;
  }
}

// BLZ-382 / BLZ-360 §7. The schedule's findings land in the SAME report, through the SAME
// function the view layer reads, so `blaze audit` and the Gantt cannot drift. All four kinds
// are soft, so none of them can change `ok`.
//
// `now` is read HERE and nowhere deeper: scheduleModel refuses to read a clock, which is what
// keeps its golden outputs stable. This runner is the boundary where reading one is legitimate.
//
// Two inputs are deliberately empty today and both become live without a code change:
//   * links — `Precedes` lives in the v4 `link` table and `LINK_TYPES` (links.mjs:14) has no
//     entry for it, so the frontmatter path cannot carry one. `blaze schedule import-deps`
//     (BLZ-360 §5.5) is what fills this, and it is operator-driven.
//   * `deadline` / `not_before` — zero tickets carry either key until BLZ-360 §4's migration
//     runs. Reading `due` as a deadline instead would be wrong: §4 splits on terminality, and
//     28 of the 40 dated tickets keep their dates as frozen actuals rather than commitments.
//
// GUARDED ON `config`, because line 40 above deliberately tolerates a config that will not
// load (`catch { config = null }`) and auditCorpus handles null. An unguarded `config.schedule`
// here turned that tolerated case into a crash — `blaze audit` printed a TypeError and no
// report at all on a corpus origin/main audits cleanly. The schedule is skipped rather than
// defaulted: minutes_per_day and working_days live in board config and nothing outside
// config.mjs may invent them (ADR-0022, and tests/config.test.mjs greps scripts/ to enforce
// it), so a board whose config will not load is a board that cannot be scheduled.
const schedule = config === null ? null : scheduleModel({
  tickets: tickets.map((t) => ({
    id: t.frontmatter.id,
    type: t.frontmatter.type ?? null,
    status: t.status,
    estimate_minutes: Number(t.frontmatter.estimate) || null,
    constraint_start_no_earlier_than: t.frontmatter.not_before ?? null,
    deadline: t.frontmatter.deadline ?? null,
    start_date: t.frontmatter.start ?? null,
    due_date: t.frontmatter.due ?? null,
  })),
  links: [],
  schedule: config.schedule,
  // BLZ-392: the RESOLVED endpoint kinds, not the module constant. `resolveSchema` layers
  // `schema.linkTypes` the way it already layers `schema.types` and `schema.workflows`, so a
  // board that declares its own delivery type can declare it schedulable too. Passing the
  // default here instead would silently ignore that override on the only path an operator runs.
  linkTypes: resolveSchema({ config }).linkTypes,
  // The type registry the solve judges "is this a custom DELIVERY type?" against — the UNION of
  // every layer, because one CPM graph spans the whole corpus and a project may declare its own
  // delivery type. Passed rather than read: the model must not consult ambient CWD state.
  types: Object.keys(projects).reduce(
    (acc, k) => Object.assign(acc, resolveSchema({ config, project: projects[k] ?? null }).types),
    { ...resolveSchema({ config }).types }),
  // The workflow registry too, and for the same reason: terminality decides whether a ticket is
  // a node at all, and reading it ambiently replanned finished work onto the critical path.
  workflows: Object.keys(projects).reduce(
    (acc, k) => Object.assign(acc, resolveSchema({ config, project: projects[k] ?? null }).workflows),
    { ...resolveSchema({ config }).workflows }),
  now: Date.now(),
});
if (schedule) report.findings.push(...scheduleFindings(schedule));

// auditCorpus computed `ok` before the walk-level findings existed, so recompute it — a gate
// that reports a hard finding and still exits 0 is not a gate.
report.ok = !report.findings.some((f) => HARD_KINDS.has(f.kind));

const findings = opts.kind ? report.findings.filter((f) => f.kind === opts.kind) : report.findings;

if (opts.json) {
  console.log(JSON.stringify({ ...report, findings }, null, 2));
} else {
  console.log("=== blaze audit ===");
  // Named UNCONDITIONALLY, ahead of any --kind filtering: the plain report's summary line
  // below prints only a per-kind COUNT, never detail text, so without this an operator
  // running `blaze audit --kind schema-invalid` (or any kind that isn't
  // `config-unloadable`) would see the count go up with no way to learn which key caused
  // it short of re-running with --json.
  if (configLoadError) console.log(`  config failed to load: ${configLoadError.message}`);
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
