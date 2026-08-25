// tests/schema-fail-loud-on-load.test.mjs — BLZ-56, the load path.
//
// A SUBPROCESS test, for the same reason tests/audit-malformed-linktypes.test.mjs is
// one: the behaviour that matters is what the real CLI does with a real board, and
// every unit was green while `blaze audit` was dying with a stack trace.
//
// THE TWO PATHS, WHICH ARE THE WHOLE POINT (AC-4):
//   a mutating verb  -> FAILS LOUD, naming the file, the type and the field.
//   `blaze audit`    -> still REPORTS, because reporting this class is its entire job
//                       and killing it deletes the report. BLZ-392 closed that defect
//                       and this ticket must not reopen it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

/** A one-ticket board whose config carries the given `schema` block. */
function board(schema) {
  const root = mkdtempSync(join(tmpdir(), "blz56-"));
  mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "ENG", projects: ["ENG"], ...(schema ? { schema } : {}) }, null, 2));
  writeFileSync(join(root, "projects", "ENG", "project.json"), JSON.stringify({ key: "ENG", name: "Eng" }));
  writeFileSync(join(root, "projects", "ENG", "defined", "ENG-1-t.md"),
    ["---", "id: ENG-1", "title: t", "type: task", "project: ENG", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  return root;
}

const run = (root, args) => spawnSync(process.execPath, [CLI, ...args],
  { cwd: root, encoding: "utf8", env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") } });

/** A valid-JSON, wrong-shape override: level is a string, workflow does not exist. */
const MALFORMED = { types: { spike: { level: "0", workflow: "ghost", parentTypes: ["nope"], required: [] } } };
/** A legal widening — this must keep working, or the check is a wall not a gate. */
const GOOD = { types: { spike: { level: 0, workflow: "delivery", parentTypes: ["feature"], required: ["title"] } } };

describe("BLZ-56: a malformed override fails loud on the load path", () => {
  test("a mutating verb refuses, naming the file, the type and the fields", () => {
    const root = board(MALFORMED);
    try {
      const r = run(root, ["new", "--project", "ENG", "--type", "task", "x", "--estimate", "30"]);
      assert.notEqual(r.status, 0, `expected a refusal\n${r.stdout}\n${r.stderr}`);
      const out = r.stderr + r.stdout;
      assert.match(out, /blaze\.config\.json/, "the operator must be told which file to fix");
      assert.match(out, /spike/, "and which type");
      assert.match(out, /level/, "and which field");
      assert.match(out, /ghost/);
      assert.doesNotMatch(out, /at assertSchemaValid|node:internal/,
        "a stack trace is not an actionable error");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a legal override is untouched — non-breaking must hold", () => {
    const root = board(GOOD);
    try {
      const r = run(root, ["audit"]);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.doesNotMatch(r.stdout + r.stderr, /not valid/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a board with NO schema block is untouched", () => {
    const root = board(null);
    try {
      const r = run(root, ["audit"]);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.doesNotMatch(r.stdout + r.stderr, /not valid/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("BLZ-56: `blaze audit` still REPORTS — the BLZ-392 regression stays closed", () => {
  test("it produces a full report on the same malformed board, and does not die", () => {
    const root = board(MALFORMED);
    try {
      const r = run(root, ["audit"]);
      const out = r.stdout + r.stderr;
      // The precise exit code is audit's own business; what must not happen is a crash
      // with no report. Assert the REPORT exists, not merely that something was printed.
      assert.match(out, /schema-invalid/,
        "the malformed override must be REPORTED as a finding, which is what audit is for");
      assert.doesNotMatch(out, /at assertSchemaValid/,
        "audit must never take the loud path — a throw there loses the whole report");
      assert.doesNotMatch(out, /node:internal\/modules/,
        "and must never die at import");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("`blaze audit --json` is still parseable on a malformed board", () => {
    // The strongest form of "it still reports": a caller can still consume it.
    const root = board(MALFORMED);
    try {
      const r = run(root, ["audit", "--json"]);
      const parsed = JSON.parse(r.stdout);
      assert.ok(parsed, "audit --json must still emit JSON when the override is malformed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
