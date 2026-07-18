// scripts/link-runner.mjs — CLI for `blaze link [--rm] <id> <TYPE> <target>`.
import { applyLink } from "./link.mjs";
import { loadConfig, resolveRoots } from "./config.mjs";
import { commitOrQueue } from "./commit-or-queue.mjs";
import { assertWritable } from "./readonly.mjs";

const { dataRoot, projectsDir } = resolveRoots();
// Config-schema version guard (ADR-0002), hoisted before the mutation below:
// a guard meant to stop the engine driving a board it may misread must not
// half-drive it first. loadConfig throws `blaze: …` on a bad stamp.
const cfg = loadConfig({ root: dataRoot });
// BLZ-121 defence-in-depth, hoisted before applyLink below for the same
// reason as move-runner.mjs: commitOrQueue's own guard fires too late here —
// applyLink writes the ticket file via direct node:fs calls before
// commitOrQueue is ever reached, so a guard only there would add/remove the
// link and merely decline the commit (a dirty-tree failure, not a clean
// refusal). cli.mjs is still the primary gate for the normal `blaze link`
// path; this only matters for a direct `node link-runner.mjs`. Caught
// locally so a direct invocation prints a clean `blaze: …` line, not a raw
// stack trace.
try {
  assertWritable("add/remove a ticket link");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const argv = process.argv.slice(2);
const remove = argv[0] === "--rm";
const [id, type, target] = remove ? argv.slice(1) : argv;
for (const a of [id, type, target]) {
  if (a && a.startsWith("--")) { console.error(`unknown flag: ${a}`); process.exit(1); }
}
if (!id || !type || !target) {
  console.error("usage: blaze link [--rm] <id> <TYPE> <target>   (TYPE: Blocks|Relates|Duplicate|Cloners)");
  process.exit(1);
}
const today = new Date().toISOString().slice(0, 10);
const r = applyLink(projectsDir, id, { type, target, remove }, { today });
if (!r.ok) { console.error(`blaze link failed:\n  ${r.errors.join("\n  ")}`); process.exit(1); }

const verb = remove ? "unlink" : "link";
const c = commitOrQueue({ root: dataRoot, mode: cfg.commitMode, op: "link", id, message: `${id}: ${verb} ${type} ${target}`, files: [r.file] });
if (!c.ok) { console.error(`blaze link: file written but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
console.log(`${id}: ${remove ? "removed" : "added"} ${type} → ${target}${c.queued ? " (queued for blaze commit)" : ""}`);
