// tests/audit-unparseable-project-json.test.mjs — BLZ-514.
//
// `audit-runner.mjs`'s `catch` around the `project.json` read is the deliberate tolerance
// for a project that declares no taxonomy — `projects[k] = { key: k }`. BLZ-493 stopped it
// swallowing "I could not OPEN the file". It still swallowed "I could not PARSE it", and
// that is the same defect by the quieter route:
//
//   `{ key: k }` is the taxonomy of a project that DECLARES NOTHING, and `auditCorpus`
//   measures `off-taxonomy-component`, `off-taxonomy-label` and every schema check against
//   it. A project with a genuinely empty taxonomy and a project whose taxonomy file is junk
//   produced THE SAME REPORT, with `ok` decided by findings computed against a file this
//   run could not read. ADR-0030: a run that could not obtain the answer must not return
//   what a run that obtained the answer "nothing" returns.
//
// THE TREATMENT IS THE ONE ITS NEAREST NEIGHBOUR ALREADY HAS. Three lines up, a
// `project.json` that is a FIFO is named on stderr and exits 2 rather than raising a tenth
// finding kind — ADR-0031 §4, because this file is the taxonomy the ENTIRE report for that
// project is measured against, and there is no partial report left to attach a finding to.
// That argument is about what the run can still honestly say, and it does not care whether
// the file failed at `open` or at `JSON.parse`. So: same exit, same shape, and a message
// that distinguishes the two, because "replace the FIFO" and "fix the JSON" are different
// things to go and do.
//
// A SUBPROCESS test, for the reason `audit-malformed-container.test.mjs` records: the exit
// code and the stderr line ARE the behaviour here, and neither is observable in-process.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runner = join(import.meta.dirname, "..", "scripts", "audit-runner.mjs");

/** A one-ticket board. `projectJson` is written VERBATIM — the shape under test is one
 *  `JSON.stringify` cannot produce. */
function board(projectJson) {
  const root = mkdtempSync(join(tmpdir(), "blz514-audit-"));
  mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "ENG", projects: ["ENG"] }));
  writeFileSync(join(root, "projects", "ENG", "project.json"), projectJson);
  writeFileSync(join(root, "projects", "ENG", "defined", "ENG-1-x.md"),
    ["---", "id: ENG-1", 'title: "x"', "type: task", "project: ENG", "status: defined",
     "---", ""].join("\n"));
  return root;
}

const audit = (root, ...args) => spawnSync(process.execPath, [runner, ...args],
  { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });

describe("BLZ-514: a project.json blaze could not PARSE is not a project that declares nothing", () => {
  test("an unparseable project.json exits 2 and NAMES the file, rather than auditing on `{ key }`", () => {
    const root = board("{ this is not json");
    try {
      const r = audit(root, "--json");
      assert.equal(r.status, 2,
        "an unparseable taxonomy gets the treatment its unreadable sibling already has "
        + `(ADR-0031 §4), not a report measured against a file this run could not read. `
        + `Got status ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /projects[/\\]ENG[/\\]project\.json/,
        `the refusal must NAME the file. Got: ${r.stderr}`);
      assert.match(r.stderr, /pars/i,
        "and say it could not PARSE it — `replace the FIFO` and `fix the JSON` are "
        + `different things to go and do. Got: ${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("it refuses BEFORE a single finding is reported, so no count is measured against it", () => {
    const root = board("{ this is not json");
    try {
      const r = audit(root, "--json");
      assert.doesNotMatch(r.stdout, /"ok"\s*:\s*true/,
        `a run that could not read the taxonomy must never report ok=true. Got: ${r.stdout}`);
      assert.equal(r.stdout.trim(), "",
        "and it must not report AT ALL: every schema finding for this project would be "
        + "measured against a file it never parsed, which is not a partial report, it is a "
        + `wrong one. Got: ${r.stdout}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a project that genuinely declares nothing still audits, unchanged", () => {
    // THE DISCRIMINATOR FOR THE FIX ITSELF. `{}` parses, so the tolerance the `catch` was
    // written for — a project with no taxonomy of its own — must be exactly as tolerated as
    // before. A fix that refuses this too has not distinguished "could not read" from
    // "read, and there is nothing there"; it has just moved the defect.
    const root = board("{}");
    try {
      const r = audit(root, "--json");
      assert.notEqual(r.status, 2,
        `an EMPTY taxonomy is an answer — Blaze looked. Got status ${r.status}: ${r.stderr}`);
      assert.match(r.stdout, /"ok"/,
        `and the report must still be produced. Got: ${r.stdout}\n${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("an ABSENT project.json still audits — ENOENT is an answer, and is untouched", () => {
    // ADR-0031: "ENOENT IS DELIBERATELY UNTOUCHED." Most projects on most boards carry no
    // project.json at all, and folding "there is no file" into "I could not read the file"
    // would turn every such board into a hard failure — the mirror image of the bug.
    const root = board("{}");
    try {
      rmSync(join(root, "projects", "ENG", "project.json"));
      const r = audit(root, "--json");
      assert.notEqual(r.status, 2,
        `no project.json is not an unreadable project.json. Got status ${r.status}: ${r.stderr}`);
      assert.match(r.stdout, /"ok"/, `and the report must still be produced. Got: ${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
