// scripts/new-runner.mjs — CLI entry for `blaze new`. Parses flags, calls
// applyNew against the resolved data tree, then commits (or queues) the ticket.
import { applyNew } from "./new.mjs";
import { derivedFieldRefusal } from "./model/fields.mjs";
import { resolveWritePort } from "./model/write-port-resolve.mjs";
import { loadConfig, resolveRoots } from "./config.mjs";
import { commitOrQueue } from "./commit-or-queue.mjs";
import { assertWritable } from "./readonly.mjs";

const { dataRoot, projectsDir } = resolveRoots();
// Config-schema version guard (ADR-0002), hoisted before the mutation below:
// a guard meant to stop the engine driving a board it may misread must not
// half-drive it first. loadConfig throws `blaze: …` on a bad stamp.
const cfg = loadConfig({ root: dataRoot });
// BLZ-121 defence-in-depth, hoisted before applyNew below for the same
// reason as move-runner.mjs: commitOrQueue's own guard fires too late here —
// applyNew writes the new ticket file via direct node:fs calls before
// commitOrQueue is ever reached, so a guard only there would create the
// ticket and merely decline the commit (a dirty-tree failure, not a clean
// refusal). cli.mjs is still the primary gate for the normal `blaze new`
// path; this only matters for a direct `node new-runner.mjs`. Caught locally
// so a direct invocation prints a clean `blaze: …` line, not a raw stack trace.
try {
  assertWritable("create a ticket");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const argv = process.argv.slice(2);

const opts = { priority: "medium", labels: [], extra: {} };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case "--project":  opts.project = argv[++i]; break;
    case "--type":     opts.type = argv[++i]; break;
    case "--priority": opts.priority = argv[++i]; break;
    case "--labels":   opts.labels = argv[++i].split(",").map((s) => s.trim()).filter(Boolean); break;
    case "--components": opts.extra.components = argv[++i].split(",").map((s) => s.trim()).filter(Boolean); break;
    case "--estimate": opts.extra.estimate = Number(argv[++i]); break;
    case "--parent":   opts.extra.parent = argv[++i]; break;
    case "--assignee": opts.extra.assignee = argv[++i]; break;
    case "--likelihood": opts.extra.likelihood = argv[++i]; break;
    case "--impact":   opts.extra.impact = argv[++i]; break;
    case "--reason":   opts.extra.reason = argv[++i]; break;
    case "--sprint":   opts.extra.sprint = argv[++i]; break;
    // BLZ-386 / BLZ-360 §4.2: `start` and `due` are the scheduler's outputs under ADR-0022, so
    // they leave the create path with the edit path. The two constraints that drive them take
    // their place, and the refusal below names the replacement rather than just rejecting.
    case "--not-before": opts.extra.not_before = argv[++i]; break;
    case "--deadline":   opts.extra.deadline = argv[++i]; break;
    default:
      // `--start`/`--due` are refused HERE rather than in their own switch branch, and the
      // placement is load-bearing: tests/new-usage-risk-flags.test.mjs greps this file for
      // switch branches on a flag literal and requires every one to appear in the usage line.
      // A refused flag must not be documented as supported, so it belongs with unknown-flag
      // handling — which is what it now is.
      //
      // The comment above deliberately does NOT spell that pattern out: an earlier version did,
      // and the grep matched the COMMENT, reporting a flag named "--flag" that does not exist.
      if (a === "--start" || a === "--due") {
        console.error(`blaze new: ${derivedFieldRefusal(a.slice(2))}`);
        process.exit(1);
      }
      if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); process.exit(1); }
      positional.push(a);
  }
}
opts.title = positional.join(" ");
opts.today = new Date().toISOString().slice(0, 10);

if (!opts.project || !opts.type || !opts.title) {
  // BLZ-232: --likelihood/--impact were parsed and undocumented, so the one type that
  // REQUIRES them could not be created from the documented invocation.
  console.error('usage: blaze new --project <KEY> --type <type> "<title>"');
  console.error('  [--parent ID] [--priority p] [--assignee who] [--labels a,b] [--components a,b]');
  console.error('  [--estimate m] [--likelihood l] [--impact i] [--sprint s]');
  console.error('  [--not-before YYYY-MM-DD] [--deadline YYYY-MM-DD]');
  console.error('  [--reason "<why a required field is blank>"]');
  console.error('  --likelihood and --impact are REQUIRED for --type risk; --estimate for story/task/bug.');
  process.exit(1);
}

// BLZ-299: the port comes from BLAZE_WRITE_PORT, so a dual-write soak reaches the
// real verbs. Unset means the filesystem, exactly as before.
const { port: writePort, close: closeWritePort } =
  await resolveWritePort({ dataRoot, projectsDir });
const r = await applyNew(projectsDir, { ...opts, writePort });
closeWritePort();
if (!r.ok) { console.error(`blaze new failed:\n  ${r.errors.join("\n  ")}`); process.exit(1); }
for (const w of r.warnings) console.error(`warning: ${w}`);

const c = commitOrQueue({ root: dataRoot, mode: cfg.commitMode, op: "new", id: r.id, message: `${r.id}: create ${r.type}`, files: [r.file, r.claimFile] });
if (!c.ok) { console.error(`blaze new: file written but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
console.log(`created ${r.id} → ${r.file}${c.queued ? " (queued for blaze commit)" : ""}`);
