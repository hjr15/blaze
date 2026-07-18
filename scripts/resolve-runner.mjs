// scripts/resolve-runner.mjs — CLI entry for `blaze resolve <id> <resolution>`.
import { applyResolve } from "./resolve.mjs";
import { loadConfig, resolveRoots } from "./config.mjs";
import { commitOrQueue } from "./commit-or-queue.mjs";
import { assertWritable } from "./readonly.mjs";

const { dataRoot, projectsDir } = resolveRoots();
// Config-schema version guard (ADR-0002), hoisted before the mutation below:
// a guard meant to stop the engine driving a board it may misread must not
// half-drive it first. loadConfig throws `blaze: …` on a bad stamp.
const cfg = loadConfig({ root: dataRoot });
// BLZ-121 defence-in-depth, hoisted before applyResolve below for the same
// reason as move-runner.mjs: commitOrQueue's own guard fires too late here —
// applyResolve writes the ticket file via direct node:fs calls before
// commitOrQueue is ever reached, so a guard only there would set the
// resolution and merely decline the commit (a dirty-tree failure, not a
// clean refusal). cli.mjs is still the primary gate for the normal
// `blaze resolve` path; this only matters for a direct
// `node resolve-runner.mjs`. Caught locally so a direct invocation prints a
// clean `blaze: …` line, not a raw stack trace.
try {
  assertWritable("set a ticket's resolution");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const positional = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); process.exit(1); }
  positional.push(a);
}
const [id, resolution] = positional;
if (!id || !resolution) { console.error("usage: blaze resolve <id> <resolution>"); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);
const r = applyResolve(projectsDir, id, resolution, { today });
if (!r.ok) { console.error(`blaze resolve failed:\n  ${r.errors.join("\n  ")}`); process.exit(1); }

const c = commitOrQueue({ root: dataRoot, mode: cfg.commitMode, op: "resolve", id, message: `${id}: resolution → ${resolution}`, files: [r.file] });
if (!c.ok) { console.error(`blaze resolve: file updated but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
console.log(`${id}: resolution → ${resolution}${c.queued ? " (queued for blaze commit)" : ""}`);
