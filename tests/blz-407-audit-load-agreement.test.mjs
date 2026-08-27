// tests/blz-407-audit-load-agreement.test.mjs — BLZ-407 AC-3.
//
// THE TICKET'S OWN REPRODUCTION, END TO END, AS A NAMED REGRESSION. A board whose
// `blaze.config.json` is `{"key":"ENG","projects":["ENG"],"schema":{"types":{"spike":7}}}`,
// with one ordinary ticket, used to give two contradictory answers from the same engine:
//
//   `blaze audit`  -> exit 0, ok=true, [soft] schema-invalid: 1
//   `blaze rollup` -> SchemaOverrideError, exit 1, "type \"spike\" is not an object — a type
//                     is a { level, workflow, parentTypes, required } record"
//
// Same board, same malformation, opposite verdicts, and the two messages were the SAME
// string — the tag was lost, not disputed. This pins the corrected behaviour: `blaze audit`
// now agrees with the load path on this exact board.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
const AUDIT_RUNNER = fileURLToPath(new URL("../scripts/audit-runner.mjs", import.meta.url));

/** The board named in the ticket, verbatim: one project, one ordinary ticket, a
 *  `blaze.config.json` whose `schema.types.spike` is the bare number `7`. */
function board() {
  const root = mkdtempSync(join(tmpdir(), "blz407-"));
  mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "ENG", projects: ["ENG"], schema: { types: { spike: 7 } } }));
  writeFileSync(join(root, "projects", "ENG", "project.json"),
    JSON.stringify({ key: "ENG", name: "Eng" }));
  writeFileSync(join(root, "projects", "ENG", "defined", "ENG-1-t.md"),
    ["---", "id: ENG-1", "title: t", "type: task", "project: ENG", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  return root;
}

const runAudit = (root, ...args) => spawnSync(process.execPath, [AUDIT_RUNNER, ...args],
  { cwd: root, encoding: "utf8", env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") } });
const runCli = (root, args) => spawnSync(process.execPath, [CLI, ...args],
  { cwd: root, encoding: "utf8", env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") } });

describe("BLZ-407 AC-3: the ticket's own board, end to end", () => {
  test("`blaze audit` now reports ok=false and exits 1 on this exact board", () => {
    const root = board();
    try {
      const r = runAudit(root, "--json");
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, false,
        `expected ok=false on the malformed board:\n${JSON.stringify(parsed, null, 2)}`);
      assert.equal(r.status, 1, `expected a non-zero exit:\nstdout:${r.stdout}\nstderr:${r.stderr}`);
      const hard = parsed.findings.filter((f) => f.kind === "schema-malformed");
      assert.ok(hard.some((f) => /type "spike" is not an object/.test(f.detail)),
        `expected the spike malformation under schema-malformed: ${JSON.stringify(parsed.findings)}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the non-exempt verb (`blaze rollup`) still refuses, with the same message", () => {
    const root = board();
    try {
      const r = runCli(root, ["rollup"]);
      assert.notEqual(r.status, 0, `expected a refusal:\n${r.stdout}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert.match(out, /SchemaOverrideError|not valid/,
        `expected the load path's refusal:\n${out}`);
      assert.match(out, /type "spike" is not an object/, out);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the two now AGREE — same board, same reason, same verdict", () => {
    const root = board();
    try {
      const auditReport = JSON.parse(runAudit(root, "--json").stdout);
      const rollup = runCli(root, ["rollup"]);
      assert.equal(auditReport.ok, false);
      assert.notEqual(rollup.status, 0);
      // The exempt verb (`blaze audit` itself) still never dies at the load path — it
      // REPORTS, which is BLZ-392's regression staying closed.
      const auditOwn = runCli(root, ["audit"]);
      assert.notEqual(auditOwn.status, 0, "the exempt verb's OWN exit now reflects the hard finding");
      assert.doesNotMatch(auditOwn.stdout + auditOwn.stderr, /at assertSchemaValid/,
        "blaze audit must still never take the loud path itself");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
