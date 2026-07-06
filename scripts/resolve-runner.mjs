// scripts/resolve-runner.mjs — CLI entry for `blaze resolve <id> <resolution>`.
import { applyResolve } from "./resolve.mjs";
import { loadConfig, resolveRoots } from "./config.mjs";
import { commitOrQueue } from "./commit-or-queue.mjs";

const { dataRoot, projectsDir } = resolveRoots();
const [id, resolution] = process.argv.slice(2);
if (!id || !resolution) { console.error("usage: blaze resolve <id> <resolution>"); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);
const r = applyResolve(projectsDir, id, resolution, { today });
if (!r.ok) { console.error(`blaze resolve failed:\n  ${r.errors.join("\n  ")}`); process.exit(1); }

const cfg = loadConfig({ root: dataRoot });
const c = commitOrQueue({ root: dataRoot, mode: cfg.commitMode, op: "resolve", id, message: `${id}: resolution → ${resolution}`, files: [r.file] });
if (!c.ok) { console.error(`blaze resolve: file updated but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
console.log(`${id}: resolution → ${resolution}${c.queued ? " (queued for blaze commit)" : ""}`);
