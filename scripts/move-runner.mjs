// scripts/move-runner.mjs — CLI entry for `blaze move <id> <status>`: applyMove
// against the resolved data tree, then commit (or queue) the relocation.
import { applyMove } from "./move.mjs";
import { loadConfig, resolveRoots } from "./config.mjs";
import { commitOrQueue } from "./commit-or-queue.mjs";

const { dataRoot, projectsDir } = resolveRoots();
// Config-schema version guard (ADR-0002), hoisted before the mutation below:
// a guard meant to stop the engine driving a board it may misread must not
// half-drive it first. loadConfig throws `blaze: …` on a bad stamp.
const cfg = loadConfig({ root: dataRoot });
const positional = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); process.exit(1); }
  positional.push(a);
}
const [id, toStatus] = positional;
if (!id || !toStatus) { console.error("usage: blaze move <id> <status>"); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);
const r = applyMove(projectsDir, id, toStatus, { today });
if (!r.ok) { console.error(`blaze move failed:\n  ${r.errors.join("\n  ")}`); process.exit(1); }
for (const w of r.warnings) console.error(`warning: ${w}`);

const c = commitOrQueue({ root: dataRoot, mode: cfg.commitMode, op: "move", id, message: `${id}: ${r.from} → ${r.to}`, files: [r.fromFile, r.file] });
if (!c.ok) { console.error(`blaze move: file relocated but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
console.log(`${id}: ${r.from} → ${r.to}${r.resolution ? ` (resolution: ${r.resolution})` : ""}${c.queued ? " (queued for blaze commit)" : ""}`);
