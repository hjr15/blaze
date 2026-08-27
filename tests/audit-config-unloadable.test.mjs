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
//
// BLZ-402 round 2 correction: an earlier revision of this fix additionally zeroed `keys`
// to `[]` whenever the key load failed, so as to "never report over an unsafe corpus" — see
// the tests below named "round-2 finding 2". That over-corrected: the fix this file exists
// to pin was `ok=true` hiding the problem, not the disk-listing fallback existing at all.
// `keys` now falls back to the disk listing on a bad key exactly as it already did for a
// config that merely failed to PARSE (BLZ-392) — what changed, and the only thing that
// needed to change, is that `ok` is `false` and the exit code is 1.
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

  test("BLZ-402 round-2 finding 2: DOES fall back to the disk listing on a bad key, "
    + "and still reports ok=false", () => {
    // An earlier revision of this fix asserted the OPPOSITE of what is asserted here: that
    // a config load failure must never fall back to `fsReadStorage.listProjects`, on the
    // theory that "everything downstream depends on the config that failed to load, so
    // there is nothing safe to keep running against". That was wrong. `--projects <name>`
    // proves the corpus IS safely auditable against a failed key load: `tickets` comes from
    // `fsReadStorage.listTickets` and `schema-invalid` is read from each project's
    // `project.json` on disk — neither touches the bad key. Zeroing `keys` to `[]` instead
    // produced "0 tickets across 0 project(s)" — a false measurement statement in the
    // grammar of a real count, understating the corpus rather than overstating it, but
    // still a number the code did not measure. The distinction that actually matters is not
    // "report nothing vs report something", it is `ok=true` vs `ok=false` — and `ok` is
    // still decided by the `config-unloadable` HARD finding below, independent of how
    // `keys` was resolved. So a stray project directory on disk ("OLD") that is NOT in
    // blaze.config.json's `projects` array now DOES surface, exactly as it would for a
    // config that merely failed to PARSE (BLZ-392's existing, tested tolerance) — the run
    // still reports the fuller corpus, and still exits 1 because the key itself was bad.
    const root = board({
      configJson: '{"key":"eng","projects":["ENG"]}',
      extraProjectDirs: ["OLD"],
    });
    try {
      const r = audit(root);
      assert.match(r.stdout, /2 project\(s\)/,
        `a config load failure must still fall back to the disk listing:\n${r.stdout}`);
      assert.match(r.stdout, /ok=false/, `must still report ok=false:\n${r.stdout}`);
      assert.equal(r.status, 1, `must still exit 1:\n${r.stdout}\n${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("BLZ-402 round-2 finding 2: a schema-invalid project surfaces on a bad-key board "
    + "exactly as it does with --projects", () => {
    // The round-2 review's own reproduction: a schema-invalid project.json must not vanish
    // behind a bad top-level key. Compares the flag-less path against `--projects ENG`,
    // which already proved the corpus was safely auditable.
    const root = board({
      configJson: '{"key":"ENG","projects":["ENG","old-eng"]}',
      extraProjectDirs: [],
    });
    writeFileSync(join(root, "projects", "ENG", "project.json"),
      JSON.stringify({ key: "ENG", schema: { types: { task: { bogus_field_xyz: true } } } }));
    // Second ticket so the corpus isn't trivially size-1.
    writeFileSync(join(root, "projects", "ENG", "defined", "ENG-2-y.md"),
      ["---", "id: ENG-2", 'title: "y"', "type: task", "project: ENG", "status: defined",
       "estimate: 30", "---", ""].join("\n"));
    try {
      const flagless = audit(root);
      const flagged = audit(root, "--projects", "ENG");
      assert.match(flagless.stdout, /schema-invalid/,
        `plain audit must report schema-invalid on a bad-key board:\n${flagless.stdout}`);
      assert.match(flagless.stdout, /config-unloadable/, flagless.stdout);
      assert.match(flagless.stdout, /2 tickets/, flagless.stdout);
      assert.match(flagged.stdout, /schema-invalid/, flagged.stdout);
      assert.match(flagless.stdout, /ok=false/, flagless.stdout);
      assert.match(flagged.stdout, /ok=false/, flagged.stdout);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("--json still carries a real denominator, not only the config-unloadable finding", () => {
    const root = board({
      configJson: '{"key":"eng","projects":["ENG"]}',
      extraProjectDirs: ["OLD"],
    });
    try {
      const r = audit(root, "--json");
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, false, `ok must be false: ${r.stdout}`);
      assert.ok(Array.isArray(parsed.findings) && parsed.findings.length > 1,
        `--json must carry more than just config-unloadable:\n${r.stdout}`);
      const kinds = parsed.findings.map((f) => f.kind);
      assert.ok(kinds.includes("config-unloadable"), `--json:\n${r.stdout}`);
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

describe("BLZ-402 round-2 finding 3: config-unloadable fires on ANY loadConfig throw "
  + "except the two BLZ-392 exceptions", () => {
  // The round-2 review measured that the first cut of this fix caught ONLY a bad
  // key/projects[] entry and left every malformed-`schedule` shape reporting `ok=true` —
  // the very defect this lane exists to close, shipped again in a new place.
  test("a malformed schedule (wrong shape: a string instead of an object) is HARD, ok=false", () => {
    const root = board({ configJson: '{"key":"ENG","projects":["ENG"],"schedule":"8h"}' });
    try {
      const r = audit(root);
      assert.match(r.stdout, /config-unloadable/, `must report config-unloadable:\n${r.stdout}`);
      assert.match(r.stdout, /ok=false/, `must report ok=false:\n${r.stdout}`);
      assert.equal(r.status, 1, `must exit 1:\n${r.stdout}\n${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a malformed schedule (unknown key: minutesPerDay instead of minutes_per_day) is HARD, ok=false", () => {
    const root = board({
      configJson: '{"key":"ENG","projects":["ENG"],"schedule":{"minutesPerDay":480}}',
    });
    try {
      const r = audit(root);
      assert.match(r.stdout, /config-unloadable/, `must report config-unloadable:\n${r.stdout}`);
      assert.match(r.stdout, /ok=false/, `must report ok=false:\n${r.stdout}`);
      assert.equal(r.status, 1, `must exit 1:\n${r.stdout}\n${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a malformed schedule (minutes_per_day: 0) is HARD, ok=false", () => {
    const root = board({
      configJson: '{"key":"ENG","projects":["ENG"],"schedule":{"minutes_per_day":0}}',
    });
    try {
      const r = audit(root);
      assert.match(r.stdout, /config-unloadable/, `must report config-unloadable:\n${r.stdout}`);
      assert.match(r.stdout, /ok=false/, `must report ok=false:\n${r.stdout}`);
      assert.equal(r.status, 1, `must exit 1:\n${r.stdout}\n${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("BLZ-392 control: unparseable JSON still reports ok=true — the tolerance is untouched", () => {
    const root = board({ configJson: "{ this is not json" });
    try {
      const r = audit(root);
      assert.match(r.stdout, /ok=true/,
        `an unparseable config must keep BLZ-392's tolerance:\n${r.stdout}\n${r.stderr}`);
      assert.doesNotMatch(r.stdout, /config-unloadable/, r.stdout);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("BLZ-392 control: an incompatible schemaVersion still reports ok=true — the tolerance is untouched", () => {
    const root = board({ configJson: '{"key":"ENG","projects":["ENG"],"schemaVersion":99}' });
    try {
      const r = audit(root);
      assert.match(r.stdout, /ok=true/,
        `an incompatible schemaVersion must keep BLZ-392's tolerance:\n${r.stdout}\n${r.stderr}`);
      assert.doesNotMatch(r.stdout, /config-unloadable/, r.stdout);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
