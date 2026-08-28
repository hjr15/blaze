#!/usr/bin/env node
// scripts/sprint-runner.mjs — CLI entry for `blaze sprint new|list|active`.
// Thin CLI over model/sprints.mjs — logic lives there (covered); this file
// is coverage-excluded (*-runner.mjs), matching new-runner.mjs's pattern.
import { loadConfig, resolveRoots, InvalidProjectKeyError } from "./config.mjs";
import { commitOrQueue, commitSuffix } from "./commit-or-queue.mjs";
import { loadSprints, saveSprints, addSprint, setActive, formatSprintList,
         unstampedRegistryWarning } from "./model/sprints.mjs";

/** BLZ-369: surfaced on the WRITE paths, because that is where the loss would occur — a read
 *  that never saves cannot destroy anything, and warning there would be noise on every render. */
function warnIfUnstamped(registry) {
  const w = unstampedRegistryWarning(registry);
  if (w) console.error(`blaze sprint: ${w}`);
}

import { assertWritable } from "./readonly.mjs";

const { dataRoot } = resolveRoots();
// Config-schema version guard (ADR-0002), hoisted before the mutation below —
// see new-runner.mjs for the rationale. loadConfig throws `blaze: …` on a bad stamp —
// and, since BLZ-402, on a malformed project key too (BLZ-402 review finding 3:
// `cli.mjs`'s preflight already catches this for the normal `blaze sprint` path, but a
// direct `node sprint-runner.mjs` bypasses it entirely).
let cfg;
try { cfg = loadConfig({ root: dataRoot }); }
catch (e) {
  if (e instanceof InvalidProjectKeyError) { console.error(e.message); process.exit(1); }
  throw e;
}

const [sub, ...rest] = process.argv.slice(2);

try {
  // BLZ-121 defence-in-depth, hoisted above the saveSprints() writes below —
  // see move-runner.mjs for the rationale (commitOrQueue's own guard fires
  // too late, after sprints.json is already written). The whole try/catch
  // here already turns a thrown `blaze: …` Error into a clean message, so
  // this doesn't need its own catch.
  assertWritable("create/activate a sprint");
  if (sub === "new") {
    const opts = { name: undefined, start: undefined, end: undefined };
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      switch (a) {
        case "--start": opts.start = rest[++i]; break;
        case "--end":   opts.end = rest[++i]; break;
        default:
          if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); process.exit(1); }
          positional.push(a);
      }
    }
    opts.name = positional.join(" ");
    if (!opts.name || !opts.start || !opts.end) {
      console.error('usage: blaze sprint new "<name>" --start <YYYY-MM-DD> --end <YYYY-MM-DD>');
      process.exit(1);
    }
    const before = loadSprints({ root: dataRoot });
    warnIfUnstamped(before);
    const { registry, id } = addSprint(before, { name: opts.name, start: opts.start, end: opts.end });
    saveSprints({ root: dataRoot }, registry);
    const c = commitOrQueue({ root: dataRoot, mode: cfg.commitMode, op: "sprint", id, message: `sprint: create ${id}`, files: ["sprints.json"] });
    if (!c.ok) { console.error(`blaze sprint: file written but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
    console.log(`created ${id}${commitSuffix(c)}`);
  } else if (sub === "list") {
    for (const a of rest) {
      if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); process.exit(1); }
    }
    const registry = loadSprints({ root: dataRoot });
    console.log(formatSprintList(registry));
  } else if (sub === "active") {
    const positional = [];
    for (const a of rest) {
      if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); process.exit(1); }
      positional.push(a);
    }
    const [id] = positional;
    if (!id) { console.error("usage: blaze sprint active <id>"); process.exit(1); }
    const before = loadSprints({ root: dataRoot });
    warnIfUnstamped(before);
    const registry = setActive(before, id);
    saveSprints({ root: dataRoot }, registry);
    const c = commitOrQueue({ root: dataRoot, mode: cfg.commitMode, op: "sprint", id, message: `sprint: set active ${id}`, files: ["sprints.json"] });
    if (!c.ok) { console.error(`blaze sprint: file written but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
    console.log(`active sprint: ${id}${commitSuffix(c)}`);
  } else {
    console.error("usage: blaze sprint <new|list|active> ...");
    process.exit(1);
  }
} catch (e) {
  console.error(e.message.startsWith("blaze:") ? e.message : `blaze: ${e.message}`);
  process.exit(1);
}
