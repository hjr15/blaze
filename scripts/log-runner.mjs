// scripts/log-runner.mjs — CLI entry for `blaze log`. Parses the positional
// id + minutes and --date/--note flags, calls applyLog against the resolved
// data tree, then commits (or queues). Mirrors new-runner.mjs's commit pattern.
import { applyLog } from "./log.mjs";
import { formatMinutes } from "./model/time.mjs";
import { loadConfig, resolveRoots } from "./config.mjs";
import { commitOrQueue } from "./commit-or-queue.mjs";

const { dataRoot, projectsDir } = resolveRoots();
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

const cfg = loadConfig({ root: dataRoot });
const c = commitOrQueue({ root: dataRoot, mode: cfg.commitMode, op: "log", id: r.id, message: `${r.id}: log ${r.minutes}m`, files: [r.file] });
if (!c.ok) { console.error(`blaze log: file written but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
console.log(`logged ${r.minutes}m to ${r.id} (total ${formatMinutes(r.total_worklog_minutes)})${c.queued ? " (queued for blaze commit)" : ""}`);
