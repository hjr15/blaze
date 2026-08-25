// tests/audit-malformed-linktypes.test.mjs — BLZ-392.
//
// A SUBPROCESS test, deliberately, because the defect it pins was invisible to every unit.
//
// BLZ-392's first fix made a malformed `schema.linkTypes` entry THROW from `mergeLinkTypes`.
// The whole suite stayed green — and `blaze audit` died with a raw Node stack trace and no
// report at all, because the throw escaped `audit-runner.mjs`'s deliberate config tolerance
// (`catch { config = null }`) from inside `auditCorpus`, so the entire hygiene report was lost
// rather than just the schedule block. `audit-runner.mjs`'s own comment records that exact
// regression class from an earlier ticket.
//
// The tolerance was inverted too: a totally unparseable `blaze.config.json` still audited fine,
// while a valid one carrying a single bad field was fatal.
//
// Nothing short of running the real runner catches that, which is why this file exists.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../scripts/audit-runner.mjs", import.meta.url));
const scheduleRunner = fileURLToPath(new URL("../scripts/schedule-runner.mjs", import.meta.url));

/** The widening an installation writes to make its own delivery type schedulable. */
const SPIKE_SCHEMA = {
  types: { spike: { level: 0, workflow: "delivery", parentTypes: ["feature"],
                    required: ["title", "description", "estimate"] } },
  linkTypes: { Precedes: {
    source_kinds: ["feature", "story", "task", "bug", "subtask", "spike"],
    target_kinds: ["feature", "story", "task", "bug", "subtask", "spike"],
    inverse_name: "Follows", min_card: 0, max_card: null } },
};

/** A one-ticket board whose config carries the given `schema` block. */
function board(schema) {
  const root = mkdtempSync(join(tmpdir(), "blz392-audit-"));
  mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "ENG", projects: ["ENG"], ...(schema ? { schema } : {}) }, null, 2));
  writeFileSync(join(root, "projects", "ENG", "defined", "ENG-1-x.md"),
    ["---", "id: ENG-1", 'title: "x"', "type: task", "project: ENG", "status: defined",
     "estimate: 480", "deadline: 2026-08-01", "---", ""].join("\n"));
  return root;
}

const audit = (root) => spawnSync(process.execPath, [runner],
  { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });

const importDeps = (root) => spawnSync(process.execPath, [scheduleRunner, "import-deps"],
  { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });

/** A board of two `spike` tickets, the second blocked by the first. */
function spikeBoard(schema) {
  const root = mkdtempSync(join(tmpdir(), "blz392-spike-"));
  mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "ENG", projects: ["ENG"], ...(schema ? { schema } : {}) }, null, 2));
  const t = (id, extra = []) => writeFileSync(
    join(root, "projects", "ENG", "defined", `ENG-${id}-s.md`),
    ["---", `id: ENG-${id}`, 'title: "s"', "type: spike", "project: ENG", "status: defined",
     "estimate: 4800", "deadline: 2026-08-26", ...extra, "---", ""].join("\n"));
  t(1);
  t(2, ["links:", "  - type: Blocks", "    target: ENG-1"]);
  return root;
}

describe("BLZ-392: a malformed schema.linkTypes never takes `blaze audit` down", () => {
  const MALFORMED = {
    "a non-array source_kinds": { linkTypes: { Precedes: { source_kinds: "spike", target_kinds: ["task"] } } },
    "an empty object": { linkTypes: { Precedes: {} } },
    "null": { linkTypes: { Precedes: null } },
  };

  for (const [label, schema] of Object.entries(MALFORMED)) {
    test(`${label} still produces a full report`, () => {
      const root = board(schema);
      try {
        const r = audit(root);
        assert.doesNotMatch(r.stderr ?? "", /at normalizeLinkType|at resolveSchema|at auditCorpus/,
          `blaze audit died with a stack trace:\n${r.stderr}`);
        assert.match(r.stdout, /ok=true/,
          `no report was produced.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        // The report must still be a REAL audit, not an empty shell that happens to say ok.
        assert.match(r.stdout, /deadline-unreachable/,
          "the shipped endpoint kinds are supposed to stay in force, so this board's deadline "
          + "finding must still fire — a report with the schedule silently switched off is the "
          + "other half of the bug");
        assert.match(r.stdout, /schema-invalid/,
          "the operator wrote a block that did nothing and was never told");
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test("a healthy board reports no schema-invalid — the finding is not always-on", () => {
    // Without this, a `schema-invalid` that fired unconditionally would satisfy every
    // assertion above.
    const root = board(null);
    try {
      const r = audit(root);
      assert.match(r.stdout, /ok=true/);
      assert.doesNotMatch(r.stdout, /schema-invalid/,
        `schema-invalid fired on a board with no schema block at all:\n${r.stdout}`);
      assert.match(r.stdout, /deadline-unreachable/, "the control board should still audit normally");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("an unparseable config still audits — the tolerance is not inverted", () => {
    // The comparison that made the first fix obviously wrong: a config too broken to parse was
    // tolerated while a valid one with a single bad field was fatal.
    const root = board(null);
    try {
      writeFileSync(join(root, "blaze.config.json"), "{ this is not json");
      const r = audit(root);
      assert.match(r.stdout, /ok=true/, `an unparseable config took the audit down:\n${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// This replaces a source-grep guard that leaked in all four review rounds — most damningly,
// `resolveSchema({})` reinstated the defect without naming the banned constant, and one regex
// literal hid 94% of a runner from the scan. The property is about what the runner DOES, so it
// is asserted by running it.
describe("BLZ-392: the override actually reaches both production paths", () => {
  test("blaze audit schedules a custom delivery type the config declares schedulable", () => {
    const root = spikeBoard(SPIKE_SCHEMA);
    try {
      const r = audit(root);
      assert.match(r.stdout, /deadline-unreachable/,
        "the spikes were not scheduled, so the config's linkTypes never reached scheduleModel — "
        + `passing the shipped constant, or resolveSchema({}), looks exactly like this.\n${r.stdout}`);
      assert.doesNotMatch(r.stdout, /schedule-empty/, `unexpected schedule-empty:\n${r.stdout}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("without the linkTypes half the same board is NOT scheduled — the control", () => {
    // Proves the assertion above is about the override and not about the board.
    const root = spikeBoard({ types: SPIKE_SCHEMA.types });
    try {
      const r = audit(root);
      assert.doesNotMatch(r.stdout, /deadline-unreachable/,
        "a spike was scheduled without being a declared Precedes endpoint");
      assert.match(r.stdout, /schedule-empty/,
        `an entirely unschedulable board reported nothing:\n${r.stdout}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("blaze schedule import-deps PROPOSES an edge between two custom-typed tickets", () => {
    // The other production path. It was a third reader of the constant for a whole round: the
    // type was schedulable and undependable at the same time.
    const root = spikeBoard(SPIKE_SCHEMA);
    try {
      const r = importDeps(root);
      assert.match(r.stdout, /PROPOSED/,
        `the planner refused the edge, so the override did not reach it:\n${r.stdout}`);
      assert.doesNotMatch(r.stdout, /declares no such endpoint/,
        `the planner is still reading the shipped kinds:\n${r.stdout}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("without the override import-deps REFUSES it — the control", () => {
    const root = spikeBoard({ types: SPIKE_SCHEMA.types });
    try {
      const r = importDeps(root);
      assert.match(r.stdout, /declares no such endpoint/,
        `the planner accepted a spike edge with no override:\n${r.stdout}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
