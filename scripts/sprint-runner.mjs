#!/usr/bin/env node
// scripts/sprint-runner.mjs — CLI entry for `blaze sprint new|list|active`.
// Thin CLI over model/sprints.mjs — logic lives there (covered); this file
// is coverage-excluded (*-runner.mjs), matching new-runner.mjs's pattern.
import { loadConfig, resolveRoots } from "./config.mjs";
import { commitOrQueue } from "./commit-or-queue.mjs";
import { loadSprints, saveSprints, addSprint, setActive, formatSprintList } from "./model/sprints.mjs";

const { dataRoot } = resolveRoots();
// Config-schema version guard (ADR-0002), hoisted before the mutation below —
// see new-runner.mjs for the rationale. loadConfig throws `blaze: …` on a bad stamp.
const cfg = loadConfig({ root: dataRoot });

const [sub, ...rest] = process.argv.slice(2);

try {
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
    const { registry, id } = addSprint(before, { name: opts.name, start: opts.start, end: opts.end });
    saveSprints({ root: dataRoot }, registry);
    const c = commitOrQueue({ root: dataRoot, mode: cfg.commitMode, op: "sprint", id, message: `sprint: create ${id}`, files: ["sprints.json"] });
    if (!c.ok) { console.error(`blaze sprint: file written but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
    console.log(`created ${id}${c.queued ? " (queued for blaze commit)" : ""}`);
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
    const registry = setActive(before, id);
    saveSprints({ root: dataRoot }, registry);
    const c = commitOrQueue({ root: dataRoot, mode: cfg.commitMode, op: "sprint", id, message: `sprint: set active ${id}`, files: ["sprints.json"] });
    if (!c.ok) { console.error(`blaze sprint: file written but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
    console.log(`active sprint: ${id}${c.queued ? " (queued for blaze commit)" : ""}`);
  } else {
    console.error("usage: blaze sprint <new|list|active> ...");
    process.exit(1);
  }
} catch (e) {
  console.error(e.message.startsWith("blaze:") ? e.message : `blaze: ${e.message}`);
  process.exit(1);
}
