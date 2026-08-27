// tests/audit-config-unloadable.test.mjs — BLZ-402 review finding 1.
//
// `assertValidKey` (BLZ-402) makes `loadConfig` THROW on a board whose key is malformed —
// a board `blaze audit` used to accept. `audit-runner.mjs`'s `try { loadConfig(...) } catch
// { config = null }` swallowed that throw and kept going: the BLZ-396 `schema-invalid`
// finding vanished, the project-count denominator silently fell back to a disk listing
// (`fsReadStorage.listProjects`, which can disagree with `blaze.config.json`'s own
// `projects` array), and the schedule section disappeared — all while the report still
// printed `ok=true`. Audit is exempt from `cli.mjs`'s schema preflight on the stated
// ground that reporting this class of problem IS its job; a report that hides the problem
// and says `ok=true` is the opposite of that job.
//
// This is a SUBPROCESS test, matching tests/audit-malformed-container.test.mjs's own
// rationale: a unit-level check on `auditCorpus` alone cannot see what `audit-runner.mjs`
// does around it (the `config = null` catch, the `keys` fallback, `report.ok`).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../scripts/audit-runner.mjs", import.meta.url));

function board({ configJson, extraProjectDirs = [] }) {
  const root = mkdtempSync(join(tmpdir(), "blz402-audit-unloadable-"));
  mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
  for (const d of extraProjectDirs) mkdirSync(join(root, "projects", d, "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), configJson);
  writeFileSync(join(root, "projects", "ENG", "defined", "ENG-1-x.md"),
    ["---", "id: ENG-1", 'title: "x"', "type: task", "project: ENG", "status: defined",
     "estimate: 480", "---", ""].join("\n"));
  return root;
}

const audit = (root, ...args) => spawnSync(process.execPath, [runner, ...args],
  { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });

describe("BLZ-402 review finding 1: an unloadable config never reports ok=true", () => {
  test("a bad board key (lower-case 'eng') is refused, not swallowed into ok=true", () => {
    const root = board({ configJson: '{"key":"eng","projects":["ENG"]}' });
    try {
      const r = audit(root);
      assert.doesNotMatch(r.stdout, /ok=true/,
        `audit reported ok=true over a board whose config could not load:\n${r.stdout}`);
      const all = `${r.stdout}\n${r.stderr}`;
      assert.match(all, /"eng"/, `the offending key must be NAMED in the report:\n${all}`);
      assert.equal(r.status, 1, `a config load failure must exit 1 (hard finding), got ${r.status}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("--json: a HARD finding names the config-load failure, and ok is false", () => {
    const root = board({ configJson: '{"key":"eng","projects":["ENG"]}' });
    try {
      const r = audit(root, "--json");
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, false, `ok must be false: ${r.stdout}`);
      const f = (parsed.findings ?? []).find((x) => /eng/i.test(x.detail) || /eng/i.test(x.kind));
      assert.ok(f, `no finding names the bad key:\n${JSON.stringify(parsed.findings)}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("does not silently swap in a disk-listing denominator (the BLZ-133 bug, inverted)", () => {
    // A stray project directory on disk ("OLD") that is NOT in blaze.config.json's
    // `projects` array. Before the fix, a config load failure fell back to
    // `fsReadStorage.listProjects(projectsDir)`, which lists EVERY directory under
    // projects/ — silently growing "1 project(s)" into "2 project(s)" the moment the
    // config that was supposed to scope the run failed to load.
    const root = board({
      configJson: '{"key":"eng","projects":["ENG"]}',
      extraProjectDirs: ["OLD"],
    });
    try {
      const r = audit(root);
      assert.doesNotMatch(r.stdout, /2 project\(s\)/,
        `a config load failure silently substituted a disk-listing fallback:\n${r.stdout}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a healthy board is unaffected — still ok=true, still reports its findings", () => {
    const root = board({ configJson: '{"key":"ENG","projects":["ENG"]}' });
    try {
      const r = audit(root);
      assert.match(r.stdout, /ok=true/, r.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
