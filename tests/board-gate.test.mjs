// tests/board-gate.test.mjs — BLZ-351: prove the board-gate CI check
// discriminates in BOTH directions.
//
// Companion to .github/workflows/board-gate.yml, which runs `npm test -- board-gate`
// (this file) against synthetic fixture boards on every PR. Before this ticket, the
// engine repo had no CI that ran against ANY board checkout: a config-schema change
// (ADR-0002, scripts/model/schema-version.mjs) could ship and break every existing
// board with nothing catching it until a human ran a command by hand — exactly what
// happened live when `blaze reconcile` started exiting 1 on the operator's board over
// its stale `provider` key. `blaze audit`'s own `loadConfig` call is wrapped in a
// try/catch that swallows a schema error to `config = null` (scripts/audit-runner.mjs)
// — audit alone does NOT fail loud on a bad schema, so this file targets `reconcile`,
// which is the command that actually throws (uncaught) on a bad config, matching the
// live failure the ticket found.
//
// A gate that only ever passes is worthless (prove-test-discriminates-by-injecting-
// regression), so every fixture pair below is asserted in BOTH directions: the good
// board loads clean, and each bad variant fails loud, naming the offending key/value.
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
  assert.match(reconcileOut, /already in sync/);
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
