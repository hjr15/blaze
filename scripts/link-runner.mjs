// scripts/link-runner.mjs — CLI for `blaze link [--rm] <id> <TYPE> <target>`.
import { applyLink } from "./link.mjs";
import { resolvePorts } from "./model/write-port-resolve.mjs";
import { LINK_TYPES } from "./model/links.mjs";
import { loadConfig, resolveRoots, InvalidProjectKeyError } from "./config.mjs";
import { assertWritable } from "./readonly.mjs";

const { dataRoot, projectsDir } = resolveRoots();
// Config-schema version guard (ADR-0002), hoisted before the mutation below:
// a guard meant to stop the engine driving a board it may misread must not
// half-drive it first. loadConfig throws `blaze: …` on a bad stamp — and, since
// BLZ-402, on a malformed project key too (BLZ-402 review finding 3: `cli.mjs`'s
// preflight already catches this for the normal `blaze link` path, but a direct
// `node link-runner.mjs` bypasses it entirely).
// The call IS the config-schema guard (ADR-0002); its value was read only for the commit mode,
// which BLZ-254 removed.
try { loadConfig({ root: dataRoot }); }
catch (e) {
  if (e instanceof InvalidProjectKeyError) { console.error(e.message); process.exit(1); }
  throw e;
}
// BLZ-121 defence-in-depth, hoisted before applyLink below.
// `apply*` writes the ticket file via direct node:fs calls, so the guard must run before
// it; cli.mjs is still the primary gate for the normal `blaze link`
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
  // Derived from the model so the usage line cannot drift from the vocabulary (BLZ-237).
  console.error(`usage: blaze link [--rm] <id> <TYPE> <target>   (TYPE: ${[...LINK_TYPES].join("|")})`);
  console.error("  Implements / Addresses are directional traceability:");
  console.error("    blaze link <feature> Implements <requirement>");
  console.error("    blaze link <architecture> Addresses <requirement>");
  process.exit(1);
}
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
let r;
try { r = await applyLink(projectsDir, id, { type, target, remove }, { today, writePort, readStorage }); }
finally { await closePorts(); }
if (!r.ok) { console.error(`blaze link failed:\n  ${r.errors.join("\n  ")}`); process.exit(1); }

// BLZ-254 (spec §5.5): the verb writes and stops — the board never commits.
console.log(`${id}: ${remove ? "removed" : "added"} ${type} → ${target}`);
