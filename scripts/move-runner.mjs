// scripts/move-runner.mjs — CLI entry for `blaze move <id> <status>`: applyMove
// against the resolved data tree, then commit (or queue) the relocation.
import { applyMove } from "./move.mjs";
import { resolveWritePort } from "./model/write-port-resolve.mjs";
import { loadConfig, resolveRoots, InvalidProjectKeyError } from "./config.mjs";
import { commitOrQueue } from "./commit-or-queue.mjs";
import { assertWritable } from "./readonly.mjs";

const { dataRoot, projectsDir } = resolveRoots();
// Config-schema version guard (ADR-0002), hoisted before the mutation below:
// a guard meant to stop the engine driving a board it may misread must not
// half-drive it first. loadConfig throws `blaze: …` on a bad stamp — and, since
// BLZ-402, on a malformed project key too (BLZ-402 review finding 3: `cli.mjs`'s
// preflight already catches this for the normal `blaze move` path, but a direct
// `node move-runner.mjs` bypasses it entirely).
let cfg;
try { cfg = loadConfig({ root: dataRoot }); }
catch (e) {
  if (e instanceof InvalidProjectKeyError) { console.error(e.message); process.exit(1); }
  throw e;
}
// BLZ-121 defence-in-depth, hoisted for the same reason as the guard above:
// commitOrQueue's own BLAZE_READONLY guard fires too late here — applyMove
// below writes/renames the ticket file via direct node:fs calls before
// commitOrQueue is ever reached, so a guard only there would relocate the
// file and merely decline the commit (the exact dirty-tree failure mode this
// ticket exists to avoid). cli.mjs is still the primary gate for the normal
// `blaze move` path; this only matters for a direct `node move-runner.mjs`.
// Caught locally so the refusal reads as a deliberate `blaze: …` line, not a
// raw stack trace an agent may misread as a crash.
try {
  assertWritable("move a ticket");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const positional = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); process.exit(1); }
  positional.push(a);
}
const [id, toStatus] = positional;
if (!id || !toStatus) { console.error("usage: blaze move <id> <status>"); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);
// BLZ-299: the port comes from BLAZE_WRITE_PORT, so a dual-write soak reaches the
// real verbs. Unset means the filesystem, exactly as before.
// A schema-version refusal is a MESSAGE, not a crash: resolveWritePort throws a named
// `blaze: …` error when the shadow is out of range, and an unwrapped top-level throw
// printed it as a stack trace — making the guard read as an engine bug. Same shape as
// the assertWritable catch this file already uses.
let __wp;
try { __wp = await resolveWritePort({ dataRoot, projectsDir }); }
catch (e) { console.error(e.message); process.exit(1); }
const { port: writePort, close: closeWritePort } = __wp;
// BLZ-402 review finding 3: `applyMove` -> `loadProject(found.frontmatter.project, ...)`
// (scripts/move.mjs) can raise the same InvalidProjectKeyError on a ticket whose stored
// `project` field is malformed — a corrupt-file case `cli.mjs`'s preflight cannot see
// (it only validates the board's OWN configured project set, not per-ticket values).
let r;
try { r = await applyMove(projectsDir, id, toStatus, { today, writePort }); }
catch (e) {
  closeWritePort();
  if (e instanceof InvalidProjectKeyError) { console.error(e.message); process.exit(1); }
  throw e;
}
closeWritePort();
if (!r.ok) { console.error(`blaze move failed:\n  ${r.errors.join("\n  ")}`); process.exit(1); }
for (const w of r.warnings) console.error(`warning: ${w}`);

const c = commitOrQueue({ root: dataRoot, mode: cfg.commitMode, op: "move", id, message: `${id}: ${r.from} → ${r.to}`, files: [r.fromFile, r.file] });
if (!c.ok) { console.error(`blaze move: file relocated but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
console.log(`${id}: ${r.from} → ${r.to}${r.resolution ? ` (resolution: ${r.resolution})` : ""}${c.queued ? " (queued for blaze commit)" : ""}`);
