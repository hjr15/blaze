import { test } from "node:test";
import { SCHEMA_VERSION, MIN_SCHEMA_VERSION } from "../scripts/model/schema-version.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { loadConfig, loadProject, ambientSchemaOverride } from "../scripts/config.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = REPO;

function withConfig(json) {
  const dir = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  if (json !== null) writeFileSync(join(dir, "blaze.config.json"), JSON.stringify(json));
  return dir;
}

test("applies defaults when no config file exists", () => {
  const dir = withConfig(null);
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.key, "TASK");
  assert.equal(cfg.boardTitle, "Blaze");
  // BLZ-298 removed codeRepo/codeRepoPath/terminal/provider: each was accepted and
  // read by nothing. They must now be ABSENT, not defaulted.
  for (const gone of ["codeRepo", "codeRepoPath", "terminal", "provider"]) {
    assert.equal(cfg[gone], undefined, `${gone} was removed and must not reappear`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("file overrides defaults; loops deep-merge", () => {
  const dir = withConfig({ key: "PROJ", loops: { groomer: { intervalSec: 99 } } });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.key, "PROJ");
  assert.equal(cfg.loops.groomer.intervalSec, 99);
  assert.equal(cfg.loops.groomer.enabled, false); // default preserved
  assert.equal(cfg.loops.reconcile.intervalSec, 60); // default branch intact
  rmSync(dir, { recursive: true, force: true });
});

// BLZ-347: the groomer spawns the configured `agentCommand` on a timer with the full
// inherited environment, and the supervisor auto-starts every enabled loop. Shipping it
// on meant every default install ran that without asking. Reconcile stays on — it only
// runs git and moves files. Pinned so a default flip has to be a deliberate edit here.
test("BLZ-347: the groomer ships disabled; reconcile ships enabled", () => {
  const dir = withConfig({ key: "PROJ" });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.loops.groomer.enabled, false,
    "an agent-spawning loop is opt-in, never a shipped default");
  assert.equal(cfg.loops.reconcile.enabled, true);
  rmSync(dir, { recursive: true, force: true });
});

// BLZ-347: both spawnSync bounds must have a shipped default. Without maxBuffer, Node's
// 1 MB stdout cap silently kills a chatty agent and misreports it as a non-zero exit;
// without timeout, a hung agent wedges the loop and (spawnSync being synchronous) the
// whole supervisor process with it.
test("BLZ-347: groomer subprocess bounds have defaults and are overridable", () => {
  const dir = withConfig({ key: "PROJ" });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.loops.groomer.timeoutSec, 900);
  assert.equal(cfg.loops.groomer.maxBufferMb, 16);

  const dir2 = withConfig({ key: "PROJ", loops: { groomer: { timeoutSec: 60, maxBufferMb: 4 } } });
  const cfg2 = loadConfig({ root: dir2, env: {} });
  assert.equal(cfg2.loops.groomer.timeoutSec, 60);
  assert.equal(cfg2.loops.groomer.maxBufferMb, 4);
  assert.equal(cfg2.loops.groomer.columns.length, 1, "unrelated defaults survive the merge");
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});

test("env overrides win over file", () => {
  const dir = withConfig({ key: "PROJ", port: 4321 });
  const cfg = loadConfig({ root: dir, env: { BLAZE_KEY: "OPS", BLAZE_PORT: "8080" } });
  assert.equal(cfg.key, "OPS");
  assert.equal(cfg.port, 8080);
  rmSync(dir, { recursive: true, force: true });
});

test("BLAZE_CODE_REPO is no longer honoured — it set a value nothing read", () => {
  const dir = withConfig({ key: "PROJ" });
  const cfg = loadConfig({ root: dir, env: { BLAZE_CODE_REPO: "../app" } });
  assert.equal(cfg.codeRepo, undefined);
  assert.equal(cfg.codeRepoPath, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("a config still carrying a removed key fails LOUD, naming it and the fix", () => {
  // Silently ignoring it is the behaviour being fixed: the next person to set
  // provider: "gitlab" reasonably expects something to happen.
  const dir = withConfig({ key: "PROJ", provider: "gitlab" });
  assert.throws(() => loadConfig({ root: dir, env: {} }),
    /no longer reads:[\s\S]*provider —/);
  rmSync(dir, { recursive: true, force: true });
});

test("idFromRef extracts the key id case-insensitively", () => {
  const dir = withConfig({ key: "DEV" });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.idFromRef("jordan/DEV-12-foo"), "DEV-12");
  assert.equal(cfg.idFromRef("epic/dev-9-bar"), "DEV-9");
  assert.equal(cfg.idFromRef("main"), null);
  rmSync(dir, { recursive: true, force: true });
});

test("fileRegex matches ticket files only", () => {
  const dir = withConfig({ key: "TASK" });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.ok(cfg.fileRegex.test("TASK-1-fix-thing.md"));
  assert.ok(!cfg.fileRegex.test("README.md"));
  assert.ok(!cfg.fileRegex.test("TASK-.md"));
  rmSync(dir, { recursive: true, force: true });
});

test("throws a clear error on malformed JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  writeFileSync(join(dir, "blaze.config.json"), "{ not json");
  assert.throws(() => loadConfig({ root: dir, env: {} }), /cannot parse/);
  rmSync(dir, { recursive: true, force: true });
});

test("commitMode defaults to per-op", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  const cfg = loadConfig({ root, env: {} });
  assert.equal(cfg.commitMode, "per-op");
  rmSync(root, { recursive: true, force: true });
});

test("commitMode is read from blaze.config.json", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ commitMode: "batch" }));
  const cfg = loadConfig({ root, env: {} });
  assert.equal(cfg.commitMode, "batch");
  rmSync(root, { recursive: true, force: true });
});

test("BLAZE_COMMIT_MODE env overrides the file", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ commitMode: "batch" }));
  const cfg = loadConfig({ root, env: { BLAZE_COMMIT_MODE: "per-op" } });
  assert.equal(cfg.commitMode, "per-op");
  rmSync(root, { recursive: true, force: true });
});

test("--get CLI reads the resolved data root's config, not the engine tree's own", () => {
  const data = mkdtempSync(join(tmpdir(), "blaze-get-"));
  const projectsDir = join(data, "projects");
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(join(data, "blaze.config.json"), JSON.stringify({ boardTitle: "Distinctive Board Title" }));
  const out = execFileSync(process.execPath, [join(REPO, "scripts", "config.mjs"), "--get", "boardTitle"], {
    cwd: REPO,
    env: { ...process.env, BLAZE_PROJECTS_DIR: projectsDir },
    encoding: "utf8",
  });
  assert.equal(out.trim(), "Distinctive Board Title");
  rmSync(data, { recursive: true, force: true });
});

test("loadConfig exposes schema:null when no schema block is present", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-schemacfg-"));
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({ key: "X" }));
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.schema, null);
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig passes through a schema override block", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-schemacfg-"));
  const schema = { types: { feature: { level: 0, workflow: "delivery", parentTypes: ["epic"], required: ["title"] } } };
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({ key: "X", schema }));
  const cfg = loadConfig({ root: dir, env: {} });
  assert.deepEqual(cfg.schema, schema);
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig normalizes a non-object schema to null", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-schemacfg-"));
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({ key: "X", schema: "nope" }));
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.schema, null);
  rmSync(dir, { recursive: true, force: true });
});

test("views config merges over all-on defaults and cannot disable board", () => {
  const dir = withConfig({ views: { map: false, board: false } });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.deepEqual(cfg.views, { board: true, list: true, live: true, metrics: true, map: false, gantt: true });
  // board: false in the file is overridden — the shell always needs its default view
  rmSync(dir, { recursive: true, force: true });
});

test("views defaults to all-on when no config file exists", () => {
  const dir = withConfig(null);
  const cfg = loadConfig({ root: dir, env: {} });
  assert.deepEqual(cfg.views, { board: true, list: true, live: true, metrics: true, map: true, gantt: true });
  rmSync(dir, { recursive: true, force: true });
});

test("loadProject exposes a per-project schema override (schema:null by default)", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-projschema-"));
  const projectsDir = join(root, "projects");
  mkdirSync(join(projectsDir, "ENG"), { recursive: true });
  let proj = loadProject("ENG", { root, projectsDir });
  assert.equal(proj.schema, null);
  const schema = { workflows: { kanban: { statuses: ["todo", "doing", "done"], terminal: ["done"], transitions: [["todo", "doing"], ["doing", "done"]], reopenTo: "todo", resolutionOnTerminal: { done: "done" } } } };
  writeFileSync(join(projectsDir, "ENG", "project.json"), JSON.stringify({ schema }));
  proj = loadProject("ENG", { root, projectsDir });
  assert.deepEqual(proj.schema, schema);
  rmSync(root, { recursive: true, force: true });
});

test("ambientSchemaOverride reads the top-level override from the data root", () => {
  const data = mkdtempSync(join(tmpdir(), "blaze-ambient-"));
  const projectsDir = join(data, "projects");
  mkdirSync(projectsDir, { recursive: true });
  const schema = { types: { feature: { level: 0, workflow: "delivery", parentTypes: ["epic"], required: ["title"] } } };
  writeFileSync(join(data, "blaze.config.json"), JSON.stringify({ key: "X", schema }));
  const got = ambientSchemaOverride({ env: { BLAZE_PROJECTS_DIR: projectsDir }, cwd: data });
  assert.deepEqual(got, schema);
  rmSync(data, { recursive: true, force: true });
});

test("ambientSchemaOverride returns null (never throws) when root resolution fails", () => {
  const throwing = () => { throw new Error("no data dir"); };
  assert.equal(ambientSchemaOverride({ resolveRoots: throwing }), null);
});

test("ambientSchemaOverride returns null when the data root has no schema block", () => {
  const data = mkdtempSync(join(tmpdir(), "blaze-ambient-none-"));
  const projectsDir = join(data, "projects");
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(join(data, "blaze.config.json"), JSON.stringify({ key: "X" }));
  const got = ambientSchemaOverride({ env: { BLAZE_PROJECTS_DIR: projectsDir }, cwd: data });
  assert.equal(got, null);
  rmSync(data, { recursive: true, force: true });
});

test("loadConfig throws blaze:-prefixed on a board stamped newer than the engine", () => {
  const dir = withConfig({ key: "X", schemaVersion: 99 });
  assert.throws(
    () => loadConfig({ root: dir, env: {} }),
    (e) =>
      e.message.startsWith("blaze: ") &&
      /board schemaVersion 99/.test(e.message) &&    // names the board's version
      new RegExp(`${MIN_SCHEMA_VERSION}\\.\\.${SCHEMA_VERSION}`).test(e.message) &&                    // names the engine's supported range
      /docs\/schema-versioning\.md/.test(e.message), // points at the docs, not a command
  );
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig throws on an invalid schemaVersion stamp", () => {
  const dir = withConfig({ key: "X", schemaVersion: "one" });
  // Quoted: the rendered value must read as a JSON string, not a bare word
  // (see the "1"-vs-1 regression test in tests/model/schema-config.test.mjs).
  assert.throws(() => loadConfig({ root: dir, env: {} }), /^Error: blaze: invalid schemaVersion "one"/);
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig accepts a board stamped with the current schema version", () => {
  const dir = withConfig({ key: "X", schemaVersion: 1 });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.key, "X");
  assert.equal(cfg.schemaVersion, 1); // stamp passes through onto the frozen cfg
  rmSync(dir, { recursive: true, force: true });
});

test("loadConfig accepts an un-versioned (legacy) config unchanged", () => {
  // Mirrors the compat-legacy fixture's exact shape — absent stamp = v1.
  const dir = withConfig({ key: "OBA", projects: ["OBA"], commitMode: "batch" });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.key, "OBA");
  assert.equal(cfg.schemaVersion, undefined);
  rmSync(dir, { recursive: true, force: true });
});

// --- ADR-0022 §2.3: the schedule calendar (BLZ-375) --------------------------
// `minutes_per_day` is the SINGLE conversion between estimate_minutes and calendar
// arithmetic, and it is also spec 2 §3.2's capacity-bar denominator. One number, one
// definition, two consumers — so nothing may hardcode 480 or Mon–Fri anywhere else.
test("schedule defaults to 480 minutes/day and Mon–Fri", () => {
  const cfg = loadConfig({ root: mkdtempSync(join(tmpdir(), "blaze-cfg-")), env: {} });
  assert.equal(cfg.schedule.minutes_per_day, 480);
  assert.deepEqual(cfg.schedule.working_days, [1, 2, 3, 4, 5]);
});

test("schedule deep-merges, so setting one key keeps the other's default", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ schema_version: 2, schedule: { minutes_per_day: 300 } }));
  const cfg = loadConfig({ root, env: {} });
  assert.equal(cfg.schedule.minutes_per_day, 300);
  assert.deepEqual(cfg.schedule.working_days, [1, 2, 3, 4, 5],
    "a partial schedule block must not blank the key it does not mention");
});

test("a working week may be redefined, including a six-day one", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ schema_version: 2, schedule: { working_days: [0, 1, 2, 3, 4, 5, 6] } }));
  assert.deepEqual(loadConfig({ root, env: {} }).schedule.working_days, [0, 1, 2, 3, 4, 5, 6]);
});

test("a wrong-SHAPED schedule block is refused, not silently defaulted", () => {
  // The operator most likely to be wrong is the one a silent default leaves with no message
  // and a calendar they did not ask for. Absent is fine; present-and-not-an-object is not.
  // Deleting the shape guard broke NO test before this one existed.
  const root = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  for (const bad of ["8h", [480], 480, null, true]) {
    writeFileSync(join(root, "blaze.config.json"),
      JSON.stringify({ schema_version: 2, schedule: bad }));
    assert.throws(() => loadConfig({ root, env: {} }), /schedule must be an object/,
      `schedule ${JSON.stringify(bad)} must be refused`);
  }
});

test("an unknown schedule key is refused, naming it and the legal ones", () => {
  // REMOVED_KEYS' rule, applied at the same altitude: a config key nothing reads is a
  // promise the software does not keep. `minutesPerDay` is the typo this actually catches.
  const root = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ schema_version: 2, schedule: { minutesPerDay: 300 } }));
  assert.throws(() => loadConfig({ root, env: {} }), /minutesPerDay/);
  assert.throws(() => loadConfig({ root, env: {} }), /minutes_per_day, working_days/);
});

test("an ABSENT schedule block is fine — only a present-and-wrong one is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ schema_version: 2 }));
  assert.equal(loadConfig({ root, env: {} }).schedule.minutes_per_day, 480);
});

test("a non-positive minutes_per_day is refused, naming the key", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  for (const bad of [0, -1, "480", null]) {
    writeFileSync(join(root, "blaze.config.json"),
      JSON.stringify({ schema_version: 2, schedule: { minutes_per_day: bad } }));
    assert.throws(() => loadConfig({ root, env: {} }), /schedule\.minutes_per_day/,
      `minutes_per_day ${JSON.stringify(bad)} must be refused`);
  }
});

test("an empty or malformed working_days is refused — a week with no days is not a calendar", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  for (const bad of [[], [7], [-1], ["mon"], "Mon-Fri", {}]) {
    writeFileSync(join(root, "blaze.config.json"),
      JSON.stringify({ schema_version: 2, schedule: { working_days: bad } }));
    assert.throws(() => loadConfig({ root, env: {} }), /schedule\.working_days/,
      `working_days ${JSON.stringify(bad)} must be refused`);
  }
});

test("NOTHING hardcodes the schedule defaults outside config.mjs", async () => {
  // The second definition ADR-0022 §2.3 forbids. Spec 4's amended §8.3 makes the same point
  // about the roll-up: a value the software could read and instead hardcodes is a second
  // source of truth. A grep test, because the rule is a rule rather than a convention.
  //
  // Two holes an earlier version of this test had, both planted and both green before the
  // fix: `.endsWith("config.mjs")` excused ANY file whose basename ends that way — including
  // `model/schema-config.mjs` — and the title promised to catch a Mon–Fri literal while the
  // body only looked for 480.
  const { readdirSync, readFileSync: rf } = await import("node:fs");
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : (e.name.endsWith(".mjs") ? [join(d, e.name)] : []));
  const ONLY = join(ROOT, "scripts", "config.mjs");   // exact path, not a suffix
  const files = walk(join(ROOT, "scripts")).filter((f) => f !== ONLY);
  const hits = (re) => files.filter((f) => re.test(rf(f, "utf8").replace(/^\s*\/\/.*$/gm, "")));
  assert.deepEqual(hits(/\b480\b/), [],
    "these hardcode 480 instead of reading schedule.minutes_per_day");
  assert.deepEqual(hits(/\[\s*1\s*,\s*2\s*,\s*3\s*,\s*4\s*,\s*5\s*\]/), [],
    "these hardcode a Mon–Fri literal instead of reading schedule.working_days");
});
