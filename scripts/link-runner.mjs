// scripts/link-runner.mjs — CLI for `blaze link [--rm] <id> <TYPE> <target>`.
import { applyLink } from "./link.mjs";
import { loadConfig, resolveRoots } from "./config.mjs";
import { commitOrQueue } from "./commit-or-queue.mjs";

const { dataRoot, projectsDir } = resolveRoots();
// Config-schema version guard (ADR-0002), hoisted before the mutation below:
// a guard meant to stop the engine driving a board it may misread must not
// half-drive it first. loadConfig throws `blaze: …` on a bad stamp.
const cfg = loadConfig({ root: dataRoot });
const argv = process.argv.slice(2);
const remove = argv[0] === "--rm";
const [id, type, target] = remove ? argv.slice(1) : argv;
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
