#!/usr/bin/env node
// scripts/sprint-runner.mjs — CLI entry for `blaze sprint new|list|active`.
// Thin CLI over model/sprints.mjs — logic lives there (covered); this file
// is coverage-excluded (*-runner.mjs), matching new-runner.mjs's pattern.
import { loadConfig, resolveRoots, InvalidProjectKeyError } from "./config.mjs";
import { addSprint, setActive, formatSprintList, unstampedRegistryWarning } from "./model/sprints.mjs";
// BLZ-707: the registry's source — sprints.json, or the sprint tables on a db-mode Postgres board
// at schema v6. Every load and save below goes through it.
import { openSprintSource } from "./model/sprint-store.mjs";

/** BLZ-369: surfaced on the WRITE paths, because that is where the loss would occur — a read
 *  that never saves cannot destroy anything, and warning there would be noise on every render.
 *  BLZ-707: file sources only. The warning is about an older engine rewriting sprints.json, which
 *  no engine does to the sprint tables, and its text names the file. */
function warnIfUnstamped(registry, source) {
  if (source.kind !== "file") return;
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
// The call IS the config-schema guard (ADR-0002); its value was read only for the commit mode,
// which BLZ-254 removed.
try { loadConfig({ root: dataRoot }); }
catch (e) {
  if (e instanceof InvalidProjectKeyError) { console.error(e.message); process.exit(1); }
  throw e;
}

const [sub, ...rest] = process.argv.slice(2);

let source = null;
try {
  // BLZ-121 defence-in-depth, hoisted above the source.save() writes below —
  // a file source writes sprints.json via direct node:fs calls, so the guard must run before
  // it; cli.mjs is still the primary gate. The whole try/catch
  // here already turns a thrown `blaze: …` Error into a clean message, so
  // this doesn't need its own catch.
  assertWritable("create/activate a sprint");
  // After the guard, so a refused run opens no connection.
  source = await openSprintSource({ dataRoot });
  // File-mode output is byte-identical; the database names itself.
  const at = source.kind === "postgres" ? ` (database: ${source.where})` : "";
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
    const before = await source.load();
    warnIfUnstamped(before, source);
    const { registry, id } = addSprint(before, { name: opts.name, start: opts.start, end: opts.end });
    await source.save(registry);
    console.log(`created ${id}${at}`);   // BLZ-254: no commit
  } else if (sub === "list") {
    for (const a of rest) {
      if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); process.exit(1); }
    }
    const registry = await source.load();
    console.log(formatSprintList(registry));
  } else if (sub === "active") {
    const positional = [];
    for (const a of rest) {
      if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); process.exit(1); }
      positional.push(a);
    }
    const [id] = positional;
    if (!id) { console.error("usage: blaze sprint active <id>"); process.exit(1); }
    const before = await source.load();
    warnIfUnstamped(before, source);
    const registry = setActive(before, id);
    await source.save(registry);
    console.log(`active sprint: ${id}${at}`);   // BLZ-254: no commit
  } else {
    console.error("usage: blaze sprint <new|list|active> ...");
    process.exit(1);
  }
} catch (e) {
  console.error(e.message.startsWith("blaze:") ? e.message : `blaze: ${e.message}`);
  process.exitCode = 1;
} finally {
  // process.exit() inside the branches above still ends the run; a held connection cannot keep
  // it alive, and a usage error never reaches a save.
  await source?.close();
}
if (process.exitCode) process.exit(process.exitCode);
