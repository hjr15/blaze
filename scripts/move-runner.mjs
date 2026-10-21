// scripts/move-runner.mjs — CLI entry for `blaze move <id> <status>`: applyMove
// against the resolved data tree and writes; it makes no commit (BLZ-254).
import { applyMove } from "./move.mjs";
import { resolvePorts } from "./model/write-port-resolve.mjs";
import { loadConfig, resolveRoots, InvalidProjectKeyError } from "./config.mjs";
import { assertWritable } from "./readonly.mjs";

const { dataRoot, projectsDir } = resolveRoots();
// Config-schema version guard (ADR-0002), hoisted before the mutation below:
// a guard meant to stop the engine driving a board it may misread must not
// half-drive it first. loadConfig throws `blaze: …` on a bad stamp — and, since
// BLZ-402, on a malformed project key too (BLZ-402 review finding 3: `cli.mjs`'s
// preflight already catches this for the normal `blaze move` path, but a direct
// `node move-runner.mjs` bypasses it entirely).
// The call IS the config-schema guard (ADR-0002); its value was read only for the commit mode,
// which BLZ-254 removed.
try { loadConfig({ root: dataRoot }); }
catch (e) {
  if (e instanceof InvalidProjectKeyError) { console.error(e.message); process.exit(1); }
  throw e;
}
// BLZ-121 defence-in-depth, hoisted for the same reason as the guard above.
// `apply*` writes the ticket file via direct node:fs calls, so the guard must run before
// it; cli.mjs is still the primary gate for the normal
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
// BLZ-670: both ports resolved once — under BLAZE_WRITE_PORT=db the reader is the database
// too, so the verb reads what the previous verb wrote. Other modes: unchanged.
try { __wp = await resolvePorts({ dataRoot, projectsDir }); }
catch (e) { console.error(e.message); process.exit(1); }
const { writePort, readStorage, close: closePorts } = __wp;
// BLZ-402 review finding 3, defence-in-depth: `applyMove`'s own `loadProject
// (found.frontmatter.project, ...)` call (scripts/move.mjs) is already locally
// try/caught there (falls back to `requireWorklogBeforeTerminal: false` on ANY
// failure, including a malformed key) — it is edit.mjs's EQUIVALENT call
// (`applyEdit`, unwrapped there) that is the actually-reproduced crash site for a
// corrupt `project:` value, per scripts/edit-runner.mjs. This wrap costs nothing and
// keeps this file symmetric with that one if move.mjs's internal guard ever changes.
let r;
try { r = await applyMove(projectsDir, id, toStatus, { today, writePort, readStorage }); }
catch (e) {
  if (e instanceof InvalidProjectKeyError) { await closePorts(); console.error(e.message); process.exit(1); }
  await closePorts(); throw e;
}
await closePorts();
if (!r.ok) { console.error(`blaze move failed:\n  ${r.errors.join("\n  ")}`); process.exit(1); }
for (const w of r.warnings) console.error(`warning: ${w}`);

// BLZ-254 (spec §5.5): the verb writes and stops — the board never commits.
console.log(`${id}: ${r.from} → ${r.to}${r.resolution ? ` (resolution: ${r.resolution})` : ""}`);
