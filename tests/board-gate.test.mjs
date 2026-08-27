// tests/board-gate.test.mjs — BLZ-351: prove the board-gate CI check
// discriminates in BOTH directions.
//
// Companion to .github/workflows/board-gate.yml, which runs
// `node --test tests/board-gate.test.mjs` (this file) against synthetic fixture
// boards on every PR. Before this ticket, the engine repo had no CI that ran
// against ANY board checkout: a config-schema change (ADR-0002,
// scripts/model/schema-version.mjs) could ship and break every existing board
// with nothing catching it until a human ran a command by hand — exactly what
// happened live when `blaze reconcile` started exiting 1 on the operator's board
// over its stale `provider` key. `blaze audit`'s own `loadConfig` call is wrapped
// in a try/catch that swallows a schema error to `config = null`
// (scripts/audit-runner.mjs) — audit alone does NOT fail loud on a bad schema, so
// this file targets `reconcile`, which is the command that actually throws
// (uncaught) on a bad config, matching the live failure the ticket found.
//
// A gate that only ever passes is worthless (prove-test-discriminates-by-injecting-
// regression), so every fixture pair below is asserted in BOTH directions: the good
// board loads clean, and each bad variant fails loud, naming the offending key/value.
//
// board-gate-good / -removed-key / -bad-schema-version are hand-built minimal
// configs ({key, projects[, schemaVersion]}) — deliberately small so the bad
// direction is easy to read. But a minimal config only exercises the axes it
// happens to set: an adversarial review of the first version of this file proved
// that with a direct counterexample — adding `boardTitle` to REMOVED_KEYS, or
// raising MIN_SCHEMA_VERSION past 1, left all 7 assertions here green, because
// none of the hand-built fixtures set `boardTitle` or omit `schemaVersion` the
// way the REAL board does. board-gate-real-shape closes that gap: its
// blaze.config.json is a verbatim copy of the real blaze-pm board's config
// (11 real project keys, boardTitle, codeRepos, commitMode, defaultLabels, port,
// agentCommand, views, loops, a full schema override — and, faithfully, NO
// top-level `key` and NO `schemaVersion` stamp), taken from the already-fixed
// v4-spine branch so it carries no `provider` key. Tickets under it are still
// synthetic; only the config SHAPE needed to be real, because that's the surface
// this ticket's failure mode lives on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcile } from "../scripts/reconcile.mjs";
import { auditCorpus } from "../scripts/model/audit.mjs";
import { fsReadStorage } from "../scripts/model/read-storage.mjs";
import { loadConfig } from "../scripts/config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "tests", "fixtures");
const GOOD = join(FIXTURES, "board-gate-good");
const REMOVED_KEY = join(FIXTURES, "board-gate-removed-key");
const BAD_SCHEMA_VERSION = join(FIXTURES, "board-gate-bad-schema-version");
const REAL_SHAPE = join(FIXTURES, "board-gate-real-shape");

function auditRoot(root) {
  const projectsDir = join(root, "projects");
  const config = loadConfig({ root });
  const tickets = fsReadStorage.listTickets(projectsDir);
  const projects = Object.fromEntries(config.projects.map((k) => [k, { key: k }]));
  return auditCorpus({ tickets, projects, config });
}

// --- the good direction: a real (synthetic) board must load clean -------------------

test("good fixture board: blaze audit passes", () => {
  const report = auditRoot(GOOD);
  assert.equal(report.ok, true, `expected a clean audit:\n${JSON.stringify(report.findings, null, 2)}`);
});

test("good fixture board: blaze reconcile --dry-run passes", async () => {
  const r = await reconcile({ root: GOOD, dryRun: true });
  assert.equal(r.ok, true, "reconcile must not throw / must report ok on the good fixture");
  assert.deepEqual(r.changes, [], "no git signal configured on the fixture, so nothing should move");
});

test("good fixture board: the `blaze` CLI itself passes audit and reconcile --dry-run", () => {
  const auditOut = execFileSync(process.execPath,
    [join(ROOT, "scripts", "audit-runner.mjs"), join(GOOD, "projects")], { encoding: "utf8" });
  assert.match(auditOut, /ok=true/);

  const reconcileOut = execFileSync(process.execPath, [join(ROOT, "scripts", "reconcile.mjs")], {
    encoding: "utf8",
    env: { ...process.env, BLAZE_PROJECTS_DIR: join(GOOD, "projects") },
  });
  assert.match(reconcileOut, /no code-bound change found/);
});

// --- the good direction, on the REAL board's config shape (not a hand-built one) ----
//
// This is the assertion the first version of this file was missing: that a config
// shaped exactly like the real board's — including the axes the minimal fixtures
// above never touch (`boardTitle`, an absent `schemaVersion`) — actually LOADS.
// Nothing before this asserted the loadable direction on anything but a minimal,
// synthetic config; a break on an axis only the real board exercises could ship
// with every assertion above still green.

test("real-shape fixture board (verbatim copy of blaze-pm's own config, minus `provider`): loadConfig succeeds", () => {
  const cfg = loadConfig({ root: REAL_SHAPE });
  assert.equal(cfg.boardTitle, "Blaze-PM", "the real board's boardTitle must survive loadConfig");
  assert.deepEqual(cfg.projects, ["ACA", "BLZ", "CRP", "FL", "INF", "KPA", "NCA", "OBA", "OMA", "SN", "STA"]);
});

test("real-shape fixture board: blaze audit passes", () => {
  const report = auditRoot(REAL_SHAPE);
  assert.equal(report.ok, true, `expected a clean audit:\n${JSON.stringify(report.findings, null, 2)}`);
});

test("real-shape fixture board: blaze reconcile --dry-run passes", async () => {
  const r = await reconcile({ root: REAL_SHAPE, dryRun: true });
  assert.equal(r.ok, true, "reconcile must not throw / must report ok on the real-shape fixture");
});

test("real-shape fixture board: the `blaze` CLI itself passes audit and reconcile --dry-run", () => {
  const auditOut = execFileSync(process.execPath,
    [join(ROOT, "scripts", "audit-runner.mjs"), join(REAL_SHAPE, "projects")], { encoding: "utf8" });
  assert.match(auditOut, /ok=true/);

  const reconcileOut = execFileSync(process.execPath, [join(ROOT, "scripts", "reconcile.mjs")], {
    encoding: "utf8",
    env: { ...process.env, BLAZE_PROJECTS_DIR: join(REAL_SHAPE, "projects") },
  });
  assert.match(reconcileOut, /no code-bound change found/);
});

// --- the bad direction: the guard must fail LOUD, not silently ----------------------

test("board carrying a removed config key (provider) FAILS LOUD on reconcile", async () => {
  await assert.rejects(
    () => reconcile({ root: REMOVED_KEY, dryRun: true }),
    /provider/,
    "reconcile must throw when blaze.config.json sets a removed key",
  );
});

test("board carrying a removed config key (provider) FAILS LOUD on the `blaze` CLI", () => {
  assert.throws(() => execFileSync(process.execPath, [join(ROOT, "scripts", "reconcile.mjs")], {
    encoding: "utf8",
    env: { ...process.env, BLAZE_PROJECTS_DIR: join(REMOVED_KEY, "projects") },
    stdio: ["ignore", "pipe", "pipe"],
  }), (e) => {
    assert.notEqual(e.status, 0, "the CLI must exit non-zero");
    assert.match(String(e.stderr), /provider/);
    return true;
  });
});

// BLZ-402 round-3 fix: `blaze audit` and `blaze reconcile` must AGREE on this fixture.
// Before this fix, `checkSchemaVersion` bucketed a removed key (`provider`) under the
// SAME `{ok:false}` shape as a genuinely out-of-window `schemaVersion` stamp, and
// `loadConfig` wrapped both in `IncompatibleSchemaVersionError` — the exact class
// `scripts/audit-runner.mjs` tolerates wholesale (BLZ-392). So this fixture reported
// `blaze audit` -> ok=true, exit 0 while `blaze reconcile` on the identical board threw
// and exited 1 (asserted two tests above) — a check that disagrees with audit on the
// same board is worse than no check at all. A removed key is now a HARD load failure
// like a malformed `schedule` block, so `config-unloadable` fires here too. Driven
// through the real `blaze audit` CLI (not the `auditRoot` helper above, which calls
// `loadConfig` directly with no try/catch and so cannot observe audit-runner's own
// tolerance/HARD-failure split).
test("board carrying a removed config key (provider): the `blaze` CLI's audit AGREES with reconcile — config-unloadable, ok=false, exit 1", () => {
  assert.throws(() => execFileSync(process.execPath,
    [join(ROOT, "scripts", "audit-runner.mjs"), join(REMOVED_KEY, "projects")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
  (e) => {
    assert.notEqual(e.status, 0, "the CLI must exit non-zero");
    assert.match(String(e.stdout), /config-unloadable/);
    assert.match(String(e.stdout), /ok=false/);
    return true;
  });
});

test("board with an out-of-window schemaVersion FAILS LOUD on reconcile", async () => {
  await assert.rejects(
    () => reconcile({ root: BAD_SCHEMA_VERSION, dryRun: true }),
    /schemaVersion/,
    "reconcile must throw when blaze.config.json's schemaVersion is outside the engine's supported window",
  );
});

test("board with an out-of-window schemaVersion FAILS LOUD on the `blaze` CLI", () => {
  assert.throws(() => execFileSync(process.execPath, [join(ROOT, "scripts", "reconcile.mjs")], {
    encoding: "utf8",
    env: { ...process.env, BLAZE_PROJECTS_DIR: join(BAD_SCHEMA_VERSION, "projects") },
    stdio: ["ignore", "pipe", "pipe"],
  }), (e) => {
    assert.notEqual(e.status, 0, "the CLI must exit non-zero");
    assert.match(String(e.stderr), /schemaVersion/);
    return true;
  });
});
