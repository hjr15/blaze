// scripts/new-runner.mjs — CLI entry for `blaze new`. Parses flags, calls
// applyNew against the resolved data tree, then commits (or queues) the ticket.
import { applyNew } from "./new.mjs";
import { loadConfig, resolveRoots } from "./config.mjs";
import { commitOrQueue } from "./commit-or-queue.mjs";

const { dataRoot, projectsDir } = resolveRoots();
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
    default:
      if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); process.exit(1); }
      positional.push(a);
  }
}
opts.title = positional.join(" ");
opts.today = new Date().toISOString().slice(0, 10);

if (!opts.project || !opts.type || !opts.title) {
  console.error('usage: blaze new --project <KEY> --type <type> "<title>" [--priority p] [--labels a,b] [--components a,b] [--estimate m] [--parent ID]');
  process.exit(1);
}

const r = applyNew(projectsDir, opts);
if (!r.ok) { console.error(`blaze new failed:\n  ${r.errors.join("\n  ")}`); process.exit(1); }

const cfg = loadConfig({ root: dataRoot });
const c = commitOrQueue({ root: dataRoot, mode: cfg.commitMode, op: "new", id: r.id, message: `${r.id}: create ${r.type}`, files: [r.file] });
if (!c.ok) { console.error(`blaze new: file written but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
console.log(`created ${r.id} → ${r.file}${c.queued ? " (queued for blaze commit)" : ""}`);
