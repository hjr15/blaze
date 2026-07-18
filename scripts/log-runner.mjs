// scripts/log-runner.mjs — CLI entry for `blaze log`. Parses the positional
// id + minutes and --date/--note flags, calls applyLog against the resolved
// data tree, then commits (or queues). Mirrors new-runner.mjs's commit pattern.
import { applyLog } from "./log.mjs";
import { formatMinutes } from "./model/time.mjs";
import { loadConfig, resolveRoots } from "./config.mjs";
import { commitOrQueue } from "./commit-or-queue.mjs";
import { assertWritable } from "./readonly.mjs";

const { dataRoot, projectsDir } = resolveRoots();
// Config-schema version guard (ADR-0002), hoisted before the mutation below:
// a guard meant to stop the engine driving a board it may misread must not
// half-drive it first. loadConfig throws `blaze: …` on a bad stamp.
const cfg = loadConfig({ root: dataRoot });
// BLZ-121 defence-in-depth, hoisted before applyLog below for the same
// reason as move-runner.mjs: commitOrQueue's own guard fires too late here —
// applyLog writes the ticket file via direct node:fs calls before
// commitOrQueue is ever reached, so a guard only there would log the time
// and merely decline the commit (a dirty-tree failure, not a clean refusal).
// cli.mjs is still the primary gate for the normal `blaze log` path; this
// only matters for a direct `node log-runner.mjs`. Caught locally so a
// direct invocation prints a clean `blaze: …` line, not a raw stack trace.
try {
  assertWritable("log time against a ticket");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const argv = process.argv.slice(2);

const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case "--date": opts.date = argv[++i]; break;
    case "--note": opts.note = argv[++i]; break;
    default:
      if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); process.exit(1); }
      positional.push(a);
  }
}
const [id, minutesRaw] = positional;
opts.today = new Date().toISOString().slice(0, 10);

if (!id || minutesRaw === undefined) {
  console.error('usage: blaze log <id> <minutes> [--date YYYY-MM-DD] [--note "..."]');
  process.exit(1);
}

const r = applyLog(projectsDir, id, Number(minutesRaw), opts);
if (!r.ok) { console.error(`blaze log failed:\n  ${r.errors.join("\n  ")}`); process.exit(1); }

const c = commitOrQueue({ root: dataRoot, mode: cfg.commitMode, op: "log", id: r.id, message: `${r.id}: log ${r.minutes}m`, files: [r.file] });
if (!c.ok) { console.error(`blaze log: file written but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
console.log(`logged ${r.minutes}m to ${r.id} (total ${formatMinutes(r.total_worklog_minutes)})${c.queued ? " (queued for blaze commit)" : ""}`);
