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
