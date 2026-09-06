// tests/hang-watchdog.test.mjs — BLZ-534.
//
// The full suite could hang FOREVER on one test file. Observed once on unmodified
// `be4b110`: `tests/model/driver-conformance.test.mjs` was still the only survivor
// after 27+ minutes at 0% CPU, blocked in `ep_poll`, holding a live referenced TCP
// handle to the Postgres port, with `loopIdleTime` at 1678s. Every test in the file
// had already finished; the process simply could not exit.
//
// That shape is why a per-test bound is not enough on its own. `--test-timeout` ends a
// test whose BODY never returns; it has nothing to say about a file whose tests all
// passed and whose process then sits on a leaked handle. The watchdog below covers the
// second case: an UNREF'D timer, so it adds no wall-clock cost to a healthy file and
// still fires when something else is holding the loop open past the deadline.
//
// HONESTY ABOUT WHAT THIS PINS. The original hang is intermittent — reproduced once,
// then not reproduced in ~10 further runs across two reviewers — and nothing here
// claims to have reproduced it. These tests pin the BOUND, not the cause: that a file
// which leaks a live handle is ended, is reported as a failure rather than as a slow
// run, and says what was still open when it was ended. The suspected cause (a Postgres
// client left open when an assertion throws before `s.close()`) is fixed separately in
// tests/model/driver-conformance.test.mjs, and that fix is pinned by
// tests/temp-cleanup-guard.test.mjs, not by this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const WATCHDOG = join(REPO, "tests", "setup", "hang-watchdog.mjs");
const LEAKY = join(REPO, "tests", "fixtures", "hang-watchdog", "leaks-a-socket.mjs");
const CLEAN = join(REPO, "tests", "fixtures", "hang-watchdog", "exits-cleanly.mjs");

/** A child that runs its OWN `node --test`. `NODE_TEST_CONTEXT` is set in this process by
 *  the runner that is executing this file, and an inherited copy makes the child print
 *  "run() is being called recursively" and run nothing at all — silently, exit 0. `CI` is
 *  cleared because the conformance suite's CI guard is not what is under test here. */
function childEnv(extra = {}) {
  const env = { ...process.env, CI: "", ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** Run `node --test <file>` with the watchdog preloaded, at the given deadline. */
function runWithWatchdog(file, ms) {
  return spawnSync(process.execPath, ["--test", `--import=${WATCHDOG}`, file], {
    cwd: REPO, encoding: "utf8", timeout: 60_000,
    env: childEnv({ BLAZE_TEST_WATCHDOG_MS: String(ms) }),
  });
}

test("BLZ-534: without the watchdog the leaky file really does hang — the bound is doing the work", async (t) => {
  // The discrimination test for everything below. If this file exited on its own, the
  // watchdog assertions would prove nothing.
  //
  // `detached` and a NEGATIVE pid on the kill, because `node --test` spawns a further child
  // per test file and killing only the runner orphans that grandchild — which is the very
  // thing this fixture is built to make unkillable-by-exit. Written the obvious way, this
  // test left one hung node process behind on the machine per run; that was observed, not
  // reasoned about.
  const child = spawn(process.execPath, ["--test", LEAKY],
    { cwd: REPO, stdio: "ignore", env: childEnv(), detached: true });
  const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
  t.after(killGroup);
  const exited = await new Promise((resolve) => {
    child.once("exit", () => resolve(true));
    setTimeout(() => resolve(false), 5_000).unref();
  });
  killGroup();
  assert.equal(exited, false,
    "the fixture is supposed to leave a live referenced socket behind and never exit; "
    + "if it now exits on its own, this fixture no longer reproduces BLZ-534's shape");
});

test("BLZ-534: that hang test leaves no orphaned node process behind on the machine", async (t) => {
  // The check on the check. `node --test` hands its child a long flag list ending in the
  // file path, so an orphan is findable by that path. Written after finding two of them
  // alive on the developer's machine, minutes after the runs that made them had finished.
  const alive = () => spawnSync("pgrep", ["-fa", "hang-watchdog/leaks-a-socket.mjs"], { encoding: "utf8" })
    .stdout.split("\n").filter(Boolean)
    // `pgrep -f` matches this test process's own arguments too when it is named on them.
    .filter((l) => !l.includes("pgrep"));
  const before = alive().length;
  const child = spawn(process.execPath, ["--test", LEAKY],
    { cwd: REPO, stdio: "ignore", env: childEnv(), detached: true });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.ok(alive().length > before, "the fixture did not start — nothing was measured");
  process.kill(-child.pid, "SIGKILL");
  // Reaping is not instantaneous; give the group a moment before counting.
  for (let i = 0; i < 20 && alive().length > before; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive().length, before,
    "killing the process GROUP must take the runner and the per-file child with it — "
    + "killing the runner alone leaves a hung node process on the machine forever");
});

test("BLZ-534: a file that cannot exit is ENDED by the watchdog rather than running forever", () => {
  const r = runWithWatchdog(LEAKY, 1_500);
  assert.equal(r.error, undefined, `child did not end: ${r.error?.message}`);
  assert.notEqual(r.status, 0, "a hung file must not report success");
});

test("BLZ-534: the watchdog names what was still open, so a hang is diagnosable", () => {
  const r = runWithWatchdog(LEAKY, 1_500);
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /BLAZE TEST HANG WATCHDOG/,
    "the diagnostic must be greppable in a CI log");
  assert.match(out, /leaks-a-socket\.mjs/,
    "the diagnostic must name the file that could not exit");
  assert.match(out, /TCPSocketWrap|TCPServerWrap|TCPWRAP/i,
    "the diagnostic must name the handle types still holding the loop open");
  assert.match(out, /127\.0\.0\.1:\d+/,
    "a socket must be reported with its peer address — 'a TCP handle' alone does not tell "
    + "you it was the Postgres port");
  assert.match(out, /BLAZE_TEST_WATCHDOG_MS/,
    "the diagnostic must say how to change the deadline it just enforced");
});

test("BLZ-534: a hang is reported as a hang, not as a slow run", () => {
  const r = runWithWatchdog(LEAKY, 1_500);
  const out = `${r.stdout}${r.stderr}`;
  // In CI the two are indistinguishable without this: both look like a long job.
  assert.match(out, /did not exit within 1500ms/,
    "the deadline that was exceeded must be stated, so the reader can tell a bound "
    + "being hit from a test simply being slow");
  assert.match(out, /fail 1/, "the runner must count the file as a failure");
});

test("BLZ-534: the watchdog is invisible on a file that closes what it opens", () => {
  const r = runWithWatchdog(CLEAN, 1_500);
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, `control fixture must pass:\n${out}`);
  assert.doesNotMatch(out, /BLAZE TEST HANG WATCHDOG/,
    "a healthy file must never see the watchdog fire");
});

test("BLZ-534: the watchdog costs a healthy file no wall-clock time — the timer is unref'd", () => {
  // A ref'd timer would hold every child open until its deadline. With a 60s deadline a
  // clean file must still finish in about the time it takes to run, not in 60s.
  const t0 = Date.now();
  const r = runWithWatchdog(CLEAN, 60_000);
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 0);
  assert.ok(elapsed < 20_000,
    `a clean file waited ${elapsed}ms against a 60000ms deadline — the watchdog timer is `
    + "keeping the process alive, which would add its deadline to every file in the suite");
});

test("BLZ-534: the suite is actually run with a bound — the npm scripts carry it", () => {
  // The watchdog only protects files it is preloaded into. If the npm scripts stop
  // passing it, every assertion above still passes and the suite is unbounded again.
  const pkg = JSON.parse(spawnSync("cat", [join(REPO, "package.json")], { encoding: "utf8" }).stdout);
  for (const name of ["test", "test:coverage"]) {
    const cmd = pkg.scripts[name];
    assert.match(cmd, /--import=\.\/tests\/setup\/hang-watchdog\.mjs/,
      `npm run ${name} must preload the hang watchdog`);
    assert.match(cmd, /--test-timeout=\d+/,
      `npm run ${name} must bound an individual test too — Node's default is no timeout `
      + "at all, which is what BLZ-534 reported as `--test-timeout=0`");
  }
});
