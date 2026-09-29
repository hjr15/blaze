// scripts/edit-runner.mjs — CLI entry for `blaze edit <id> <field> <value>`:
// applyEdit against the resolved data tree, then commit (or queue) the
// touched file. Mirrors move-runner.mjs's commit pattern.
import { applyEdit } from "./edit.mjs";
import { resolvePorts } from "./model/write-port-resolve.mjs";
import { loadConfig, resolveRoots, InvalidProjectKeyError } from "./config.mjs";
import { stageFor, commitSuffix } from "./commit-or-queue.mjs";
import { assertWritable } from "./readonly.mjs";

const { dataRoot, projectsDir } = resolveRoots();
// Config-schema version guard (ADR-0002), hoisted before the mutation below:
// a guard meant to stop the engine driving a board it may misread must not
// half-drive it first. loadConfig throws `blaze: …` on a bad stamp — and, since
// BLZ-402, on a malformed project key too (BLZ-402 review finding 3: `cli.mjs`'s
// preflight already catches this for the normal `blaze edit` path, but a direct
// `node edit-runner.mjs` bypasses it entirely).
let cfg;
try { cfg = loadConfig({ root: dataRoot }); }
catch (e) {
  if (e instanceof InvalidProjectKeyError) { console.error(e.message); process.exit(1); }
  throw e;
}
// BLZ-121 defence-in-depth, hoisted before applyEdit below for the same
// reason as move-runner.mjs: commitOrQueue's own guard fires too late here —
// applyEdit writes the ticket file via direct node:fs calls before
// commitOrQueue is ever reached, so a guard only there would edit the file
// and merely decline the commit (a dirty-tree failure, not a clean refusal).
// cli.mjs is still the primary gate for the normal `blaze edit` path; this
// only matters for a direct `node edit-runner.mjs`. Caught locally so a
// direct invocation prints a clean `blaze: …` line, not a raw stack trace.
try {
  assertWritable("edit a ticket");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const [id, field, ...valueParts] = process.argv.slice(2);
// Only the id/field SELECTOR positions are flag-guarded — valueParts is a
// genuinely freeform value (e.g. a title or note) and must stay unguarded so
// a value that happens to start with "--" still works. This guarantee holds
// only for a DIRECT `node edit-runner.mjs ...` invocation: via the normal
// `blaze edit` CLI, cli.mjs scans ALL args (including value positions) for
// "--help"/"-h" before this runner ever spawns, so e.g.
// `blaze edit X title --help` prints help instead of reaching this file —
// deliberately; safe-by-default at dispatch is the right call, and that
// dispatch-level scan is NOT to be weakened to preserve this file's
// freeform-value guarantee.
if (id && id.startsWith("--")) { console.error(`unknown flag: ${id}`); process.exit(1); }
if (field && field.startsWith("--")) { console.error(`unknown flag: ${field}`); process.exit(1); }
if (!id || !field || valueParts.length === 0) {
  console.error("usage: blaze edit <id> <field> <value>"); process.exit(1);
}
const value = valueParts.join(" ");
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
const { writePort, readStorage, mode, close: closePorts } = __wp;
// BLZ-402 review finding 3: `applyEdit` -> `loadProject(fm.project, ...)` (scripts/edit.mjs)
// can raise the same InvalidProjectKeyError on a ticket whose stored `project` field is
// malformed — a corrupt-file case `cli.mjs`'s preflight cannot see (it only validates the
// board's OWN configured project set, not per-ticket values).
let r;
try { r = await applyEdit(projectsDir, id, { [field]: value }, { today, writePort, readStorage }); }
catch (e) {
  if (e instanceof InvalidProjectKeyError) { await closePorts(); console.error(e.message); process.exit(1); }
  await closePorts(); throw e;
}
await closePorts();
if (!r.ok) { console.error(`blaze edit failed:\n  ${r.errors.join("\n  ")}`); process.exit(1); }

// BLZ-670: db mode stages only files that exist on disk — the ticket is a row, not a file.
const c = stageFor(mode)({ root: dataRoot, mode: cfg.commitMode, op: "edit", id, message: `${id}: edit ${field}`, files: [r.file] });
if (!c.ok) { console.error(`blaze edit: file written but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
console.log(`${id}: ${field} = ${value}${commitSuffix(c)}`);
