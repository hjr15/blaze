#!/usr/bin/env node
// cli.mjs — the `blaze` command. Dispatches to the scripts.
import { spawnSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isReadonly } from "./readonly.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const node = (file, args = []) => spawnSync(process.execPath, [join(here, file), ...args], { stdio: "inherit" });

// One line per subcommand: which script runs it, a one-line description used
// for both the full usage listing and `blaze <cmd> --help`, and whether it
// mutates the board (BLZ-121: gates BLAZE_READONLY below). --help/-h is
// intercepted below BEFORE this map is used to spawn anything, so a new
// subcommand added here can never ship without help by omission (BLZ-119) —
// there is no separate per-runner help path to forget. This map is now also
// the ONLY dispatch table (the switch below it was collapsed away) — a new
// entry here is automatically routed, described, help-guarded, and
// BLAZE_READONLY-gated with no second place to update.
//
// mutates classification: `reconcile` defaults to a dry-run but `--apply`
// commits — classified true unconditionally (simpler and safer than
// flag-dependent classification). `start` runs the supervisor, which drives
// the groomer loop (git-commits), so it's true too. `board` (serve.mjs, the
// read/write web viewer — its own mutating `/api/*` handlers are gated
// separately, see readonly.mjs) and `rollup` (a report) are the only false.
const SUBCOMMANDS = {
  db: { file: "db-runner.mjs", desc: "create/inspect the database and the dual-write soak", mutates: true },
  init: { file: "init-runner.mjs", desc: "set up a new board (first-run wizard)", mutates: true },
  start: { file: "supervisor.mjs", desc: "run the reconcile/groomer loops (default)", mutates: true, noArgs: true },
  board: { file: "serve.mjs", desc: "serve the board viewer", mutates: false, noArgs: true },
  reconcile: { file: "reconcile.mjs", desc: "sync board status to git/PR state", mutates: true },
  groom: { file: "loops/groomer.mjs", desc: "run one groomer pass", mutates: true },
  new: { file: "new-runner.mjs", desc: "create a ticket", mutates: true },
  sprint: { file: "sprint-runner.mjs", desc: "create/list/activate sprints", mutates: true },
  audit: { file: "audit-runner.mjs", desc: "report corpus hygiene (read-only; non-zero on a hard finding)", mutates: false },
  // `mutates: true` because `migrate-dates --write` rewrites tickets. Dry-run is the default
  // for both subcommands and `import-deps` has no --write at all, but the CLI gate is per-verb
  // and BLZ-121 refuses to even SPAWN a mutating runner under BLAZE_READONLY — declaring this
  // read-only because the common path is a dry run would defeat that.
  schedule: { file: "schedule-runner.mjs", desc: "migrate dates to constraints, or propose Precedes edges from Blocks", mutates: true },
  reindex: { file: "reindex.mjs", desc: "rebuild the derived index + transitions cache", mutates: true },
  move: { file: "move-runner.mjs", desc: "move a ticket to a new status", mutates: true },
  edit: { file: "edit-runner.mjs", desc: "edit a ticket field", mutates: true },
  link: { file: "link-runner.mjs", desc: "add/remove a link between tickets", mutates: true },
  resolve: { file: "resolve-runner.mjs", desc: "set a ticket's resolution", mutates: true },
  log: { file: "log-runner.mjs", desc: "log worked minutes against a ticket", mutates: true },
  commit: { file: "commit-runner.mjs", desc: "flush the pending queue into a commit", mutates: true },
  rollup: { file: "rollup-runner.mjs", desc: "print rolled-up estimate/worklog totals", mutates: false },
  migrate: { file: "migrate-runner.mjs", desc: "import tickets from a Jira export", mutates: true },
  publish: { file: "publish-runner.mjs", desc: "sweep local queues and trigger the flush", mutates: true },
  // BLZ-348: the command serve-auth.mjs's bind refusal has named since BLZ-304, and
  // which did not exist. Adding the first user turns authentication on for the board
  // (ADR-0013 §5 — the bootstrap admin is a user, not an exception), so it mutates.
  user: { file: "user-runner.mjs", desc: "add a user and issue its API token", mutates: true },
};

function printUsage() {
  console.log("usage: blaze <command> [args]");
  console.log();
  console.log("commands:");
  for (const [name, { desc }] of Object.entries(SUBCOMMANDS)) console.log(`  ${name.padEnd(10)} ${desc}`);
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "--help" || cmd === "-h") { printUsage(); process.exit(0); }
// A subcommand's OWN --help/-h is handled here, at dispatch, not by the
// runner: this fires before the runner ever spawns, so discovering the CLI
// (`blaze commit --help`) can never fall through to a real mutation.
if (cmd !== undefined && (rest.includes("--help") || rest.includes("-h"))) {
  // Object.hasOwn, not a plain lookup: SUBCOMMANDS[cmd] would otherwise
  // resolve an inherited Object.prototype key ("constructor", "toString",
  // "__proto__", ...) to a truthy value, skipping the usage-fallback below
  // for a command name that collides with a prototype property.
  const sub = Object.hasOwn(SUBCOMMANDS, cmd) ? SUBCOMMANDS[cmd] : undefined;
  if (!sub) { printUsage(); process.exit(1); }
  console.log(`usage: blaze ${cmd} — ${sub.desc}`);
  process.exit(0);
}

// No args behaves exactly like `start` (unchanged): same table entry, same
// no-args forwarding — there's just no literal "undefined" key to look up.
const key = cmd === undefined ? "start" : cmd;
// Same Object.hasOwn guard as the --help lookup above.
const sub = Object.hasOwn(SUBCOMMANDS, key) ? SUBCOMMANDS[key] : undefined;
if (!sub) { printUsage(); process.exit(1); }

// BLZ-121: refuse to even spawn a mutating runner under BLAZE_READONLY — the
// one genuine write choke point (every verb dispatches through here). Gating
// later (e.g. at commitOrQueue) is too late: move.mjs and friends write/rename
// the ticket file before they ever reach a commit decision, so declining only
// the commit would leave a relocated-but-uncommitted file in a shared tree.
if (isReadonly() && sub.mutates) {
  console.error(`blaze: read-only mode (BLAZE_READONLY=1) — refusing to run a mutating command: ${key}`);
  process.exit(1);
}

// BLZ-56: a malformed schema override fails LOUD, here, before the verb runs.
//
// Every verb dispatches through this file, so it is the one place a load-path check can
// live without being added to a dozen runners and forgotten in the thirteenth.
//
// THREE EXEMPTIONS, ALL DELIBERATE, AND THIS IS AC-4's RECORDED DECISION. The count is
// stated because it was wrong once — the list said two while the Set below held three, the
// `commit` bullet having been appended below the closing paragraph and orphaned from the
// list. Keep the number, the bullets and the Set in step; prose that asserts what the code
// does not is the failure this branch has already paid for twice.
//
//   audit  — reporting exactly this class IS its job. `auditCorpus` calls `validateSchema`
//            and emits `schema-invalid` as a soft finding, so refusing to start it would
//            delete the report that tells the operator what to fix. BLZ-392 closed that
//            defect (a throw from inside `auditCorpus` killed `blaze audit` outright,
//            losing the whole hygiene report) and it stays closed.
//   init   — runs BEFORE a board exists, so there is no config to validate.
//   commit — a git flush of the pending ledger. `commit-runner.mjs` imports nothing from
//            the model, and refusing it would strand ticket files that other verbs have
//            ALREADY relocated but not committed — the same hazard the read-only gate
//            above cites for gating too late.
//
// That leaves 18 of the 21 subcommands in `SUBCOMMANDS` running this check.
//
// The check is NOT in `ambientSchemaOverride`, and must never be: `TYPES` and
// `WORKFLOWS` are module-scope constants resolved through it at IMPORT time, so a throw
// there would kill every verb before it ran, `audit` included, with a raw stack trace.
// See ADR-0002 and the note on `assertSchemaValid`.
const SCHEMA_PREFLIGHT_EXEMPT = new Set(["audit", "init", "commit"]);
if (!SCHEMA_PREFLIGHT_EXEMPT.has(key)) {
  try {
    const { resolveRoots, loadConfig, listProjects, loadProject, InvalidProjectKeyError } = await import("./config.mjs");
    const { resolveSchema, assertSchemaValid } = await import("./model/schema-config.mjs");
    const { fsReadStorage } = await import("./model/read-storage.mjs");
    // BOTH roots, and `projectsDir` is not derivable from `dataRoot`. `resolveRoots` returns
    // an explicit projectsDir and derives dataRoot as its PARENT, while `loadProject`
    // defaults to `join(root, "projects")` — so with BLAZE_PROJECTS_DIR pointing at a
    // directory named anything else, every `loadProject` below threw, was swallowed, and
    // every project resolved to null, so the project layer was never validated at all.
    // scripts/audit-runner.mjs uses `roots.projectsDir` verbatim; this follows it, because
    // the whole design of this preflight is that it judges the board the way audit judges it.
    const { dataRoot: root, projectsDir } = resolveRoots();
    const config = loadConfig({ root });

    // NO `endpointTypes` UNION HERE. `auditCorpus` builds one (scripts/model/audit.mjs) —
    // every type declared anywhere — because a top-level `Precedes` list may legitimately
    // name a type only ONE PROJECT declares. That union feeds exactly one check, BLZ-392's
    // endpoint-kind finding, and that finding is SOFT. `assertSchemaValid` takes the HARD
    // entries only, so the union cannot change any decision this preflight makes: building
    // it here would be a mechanism that RUNS, costs a `resolveSchema` per project, and
    // decides nothing.
    //
    // THAT IS NOT ADR-0002's ALTERNATIVE (c), and an earlier version of this comment cited
    // it anyway. (c) rejected putting a guard inside `resolveSchema`, on the ground that
    // such a guard would be "absent in production" — and it justified that with a factual
    // aside, RECORDED 2026-07-15, that `resolveSchema` had no runtime callers at all, only
    // tests. DO NOT READ THAT ASIDE AS A STATEMENT ABOUT TODAY: `resolveSchema` runs on
    // every non-exempt verb in this very preflight, forty lines below this sentence, and in
    // scripts/audit-runner.mjs, scripts/model/audit.mjs and scripts/schedule-runner.mjs.
    // (c)'s RULING is untouched by that — it is about where a VERSION guard belongs — but
    // the only part of it that could ever have described this union is the SHAPE of the
    // objection, a mechanism that never executes. That shape was never this union's: the
    // union, when it existed here, DID execute, on every non-exempt verb; the finding it
    // fed simply never won a decision, because that finding is soft. INERT, not ABSENT —
    // a different thing, and the analogy overstated what was actually removed.
    //
    // WHETHER THE UNION ITSELF IS PRESENT OR ABSENT IS DELIBERATELY UNPINNED, and this
    // paragraph says so rather than implying a guard that does not exist. Restoring it
    // costs a `resolveSchema` per project and changes nothing the suite can observe — no
    // test fails either way, so this comment could drift from the code in exactly the
    // direction it describes with no gate firing. That gap is accepted, not closed: the
    // union's presence is inert regardless, while the hazard that WOULD matter — the
    // endpoint-kind finding getting RE-TAGGED HARD without the union coming back, which
    // would brick every non-exempt verb on a board `blaze audit` calls clean — is already
    // pinned end to end by two tests, not this comment: "an undeclared endpoint kind never
    // reaches the load path's refusal" (tests/model/schema-validate-on-load.test.mjs, in the
    // describe "BLZ-56: the endpoint-kind finding is SOFT, and cli.mjs's preflight depends
    // on it" — the describe is the CONTEXT, the test is the guard) goes red the moment that
    // tag flips, and "a top-level Precedes naming a PROJECT-declared type does not brick the
    // board" (tests/schema-fail-loud-on-load.test.mjs)
    // spawns `blaze rollup` against exactly such a board and would fail if it ever did. A
    // third guard here could only detect the union's textual presence, which decides
    // nothing — not worth its own upkeep. Everything else here still judges the board
    // exactly the way audit does — a check that disagrees with audit on the same board is
    // worse than no check at all.
    //
    // The project set, with audit-runner.mjs's fallback and for audit-runner.mjs's stated
    // reason: `listProjects` returns [] when `blaze.config.json` carries no `projects` array,
    // so without this the preflight validated NOTHING and passed — "a gate that passes
    // because it measured nothing is worse than no gate". Each source must be non-EMPTY to
    // win, not merely non-null, which is the same trap `??` alone walked into there.
    const nonEmpty = (a) => (Array.isArray(a) && a.length ? a : null);
    const keys = nonEmpty(listProjects(config)) ?? fsReadStorage.listProjects(projectsDir);
    const projects = {};
    for (const k of keys) {
      try { projects[k] = loadProject(k, { root, projectsDir }); }
      catch (e) {
        // BLZ-402 review finding 1's cli.mjs analog: swallowing an InvalidProjectKeyError
        // here — same shape as audit-runner.mjs's `catch { config = null }` — would let this
        // ONE project's schema go unvalidated while the preflight still finishes clean, no
        // different from the silent partial report finding 1 closed there. Every OTHER
        // `loadProject` failure (a project directory that doesn't exist yet, an unreadable
        // project.json) is still swallowed exactly as before: this preflight's whole job is
        // schema validation, and those failures are not this check's business (same
        // rationale as the outer catch below). Re-thrown so the outer catch reports a bad
        // key the same way it reports a SchemaOverrideError, instead of finishing quietly.
        if (e instanceof InvalidProjectKeyError) throw e;
        projects[k] = null;
      }
    }
    const top = resolveSchema({ config });
    assertSchemaValid({ ...top, config });
    // And each project layer, which `new`/`edit` resolve through `loadProjectSchema` and
    // the first cut never looked at — so a malformed project.json passed every verb while
    // audit reported it. The mirror of the same asymmetry.
    for (const k of Object.keys(projects)) {
      const resolved = { ...resolveSchema({ config, project: projects[k] }), linkTypes: top.linkTypes };
      assertSchemaValid({ ...resolved, config, project: projects[k] },
        // The LABEL follows projectsDir too. Hardcoding `projects/` told an operator
        // running BLAZE_PROJECTS_DIR=<root>/boards to "Fix projects/ENG/project.json" —
        // a path they do not have. The whole value of this error is naming the file.
        { source: `${relative(root, join(projectsDir, k))}/project.json` });
    }
  } catch (e) {
    // ONLY these two errors stop the verb. Everything else reaching here — no board, an
    // unreadable or unparseable config, a packaged install with no data dir — is not
    // this check's business, and swallowing it preserves exactly the behaviour those
    // cases had before. A preflight that turned "no board" into a hard failure would be
    // a far bigger regression than the one it was written to close.
    //
    // BLZ-402 review finding 3: an `InvalidProjectKeyError` from the unwrapped
    // `loadConfig({ root })` a few lines above (a malformed `cfg.key` or `cfg.projects`
    // entry), or re-thrown by the loop's own catch above, used to fall through this
    // catch untouched (it is not a SchemaOverrideError) and straight to spawning the
    // runner below — which then re-ran `loadConfig` itself and crashed with a raw Node
    // stack trace. This is the CENTRAL fix for that: every non-exempt verb already
    // routes through this one preflight, so catching it here, before the runner ever
    // spawns, closes the reproduced case (`blaze new` on a board with key "eng") for
    // every verb in `SUBCOMMANDS` at once — the "single top-level handler... covering
    // every verb" the ticket allows as an alternative to N per-runner try/catches. It
    // does NOT cover a bad key that only shows up on a runner's OWN deeper call (e.g.
    // `--project 'A('`, an unconfigured value `loadProject` never sees until `applyNew`
    // runs) — those are fixed at the runner, per-file, because this preflight only ever
    // validates the ALREADY-configured project set, not arbitrary command-line values.
    // Named by STRING, not `instanceof`: `InvalidProjectKeyError` was imported inside the
    // `try` block above (so exempt verbs never pay for loading config.mjs), which makes it
    // out of scope here in `catch` — the same reason the SchemaOverrideError check below
    // already compares `e.name` rather than importing that class too.
    if (e && e.name === "InvalidProjectKeyError") { console.error(e.message); process.exit(1); }
    if (e && e.name === "SchemaOverrideError") {
      // writeSync, not console.error: `process.exit` after a large write TRUNCATES a
      // piped stream at 64 KiB, because pipe writes are async. The whole value of this
      // error is "every problem at once", and a board with enough bad entries lost the
      // tail — including the line telling the operator which file to fix.
      const { writeSync } = await import("node:fs");
      const buf = Buffer.from(e.message.endsWith("\n") ? e.message : `${e.message}\n`, "utf8");
      for (let off = 0; off < buf.length;) off += writeSync(2, buf, off, buf.length - off);
      process.exit(1);
    }
  }
}

const r = node(sub.file, sub.noArgs ? [] : rest);
process.exit(r.status ?? 0);
