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
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_WATCHDOG_MS, activeBounds, descendantPids, installHangWatchdog, reapDescendants,
  resolveWatchdogMs, watchdogReport,
} from "./setup/hang-watchdog.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const WATCHDOG = join(REPO, "tests", "setup", "hang-watchdog.mjs");
const LEAKY = join(REPO, "tests", "fixtures", "hang-watchdog", "leaks-a-socket.mjs");
const CLEAN = join(REPO, "tests", "fixtures", "hang-watchdog", "exits-cleanly.mjs");
const SLOW = join(REPO, "tests", "fixtures", "hang-watchdog", "slow-but-honest.mjs");
const SPAWNER = join(REPO, "tests", "fixtures", "hang-watchdog", "spawns-a-helper-then-leaks.mjs");
const BUSY_LEAK = join(REPO, "tests", "fixtures", "hang-watchdog", "busy-then-leaks.mjs");

/** A child that runs its OWN `node --test`. `NODE_TEST_CONTEXT` is set in this process by
 *  the runner that is executing this file, and an inherited copy makes the child print
 *  "run() is being called recursively" and run nothing at all — silently, exit 0. `CI` is
 *  cleared because the conformance suite's CI guard is not what is under test here. */
function childEnv(extra = {}) {
  const env = { ...process.env, CI: "", ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** How long a fixture child in THIS file is given before `spawnSync` kills it. Named because
 *  it is also a LOWER BOUND on the suite's per-test timeout: a `--test-timeout` below this
 *  would end the tests below before their own children ever hit it, so the two are asserted
 *  against each other rather than each against a literal. */
const CHILD_SPAWN_TIMEOUT_MS = 60_000;

/** Run `node --test <file>` with the watchdog preloaded, at the given deadline. */
function runWithWatchdog(file, ms) {
  return spawnSync(process.execPath, ["--test", `--import=${WATCHDOG}`, file], {
    cwd: REPO, encoding: "utf8", timeout: CHILD_SPAWN_TIMEOUT_MS,
    env: childEnv({ BLAZE_TEST_WATCHDOG_MS: String(ms) }),
  });
}

/** The npm scripts, which are the only place the per-test bound is declared. */
function npmScripts() {
  return JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts;
}

/** The `--test-timeout` a script declares, as a NUMBER rather than as a flag string.
 *  `null` when it declares none — which is NOT the same as `0`, the value Node itself
 *  defaults to and the value BLZ-534 reported as the absence of any bound at all. */
function declaredTestTimeoutMs(cmd) {
  const m = /--test-timeout=(\d+)/.exec(cmd ?? "");
  return m ? Number(m[1]) : null;
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

test("BLZ-534: the deadline that was exceeded is stated, and the file counts as a failure", () => {
  // Renamed from "a hang is reported as a hang, not as a slow run". Both assertions are
  // unchanged and still the right ones; the TITLE claimed the distinction the watchdog was
  // separately found unable to make, and a test name is a claim like any other.
  const r = runWithWatchdog(LEAKY, 1_500);
  const out = `${r.stdout}${r.stderr}`;
  // Without the number, a bound being hit and a job merely running long look identical in CI.
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
  const scripts = npmScripts();
  for (const name of ["test", "test:coverage"]) {
    const cmd = scripts[name];
    assert.match(cmd, /--import=\.\/tests\/setup\/hang-watchdog\.mjs/,
      `npm run ${name} must preload the hang watchdog`);
    assert.match(cmd, /--test-timeout=\d+/,
      `npm run ${name} must bound an individual test too — Node's default is no timeout `
      + "at all, which is what BLZ-534 reported as `--test-timeout=0`");
  }
});

// ── THE TWO BOUNDS, AS NUMBERS ─────────────────────────────────────────────────────────
// The test above pins that a flag is PRESENT. Present is not the same as sound: the two
// scripts can drift apart, a bound can be set below the run it is meant to survive, or above
// the watchdog that is meant to outlive it, and every assertion in this file would still
// pass. So both bounds are read as numbers and checked against each other and against the
// constants they have to sit between — never against a literal copy of themselves, which
// would only pin the spelling and would have to be edited in lockstep with the thing it
// claims to guard.

test("BLZ-534: no CI step runs the test runner outside the two bounds", () => {
  // REVIEW FINDING. `.github/workflows/board-gate.yml` ran `node --test tests/board-gate.test.mjs`
  // — no `--import`, and therefore Node's own `--test-timeout=0`. A whole CI job was running
  // the runner unbounded, and nothing said so: measured,
  // `node --test tests/board-gate.test.mjs | grep -c "UNBOUNDED TEST RUN"` gave 0 against 2
  // for tests/hang-watchdog.test.mjs. The notice lives INSIDE that file, so it only ever
  // fires when that file is in the selected set — a run of any other file is silent. The
  // notice is for a human at a terminal; this is the check that covers CI, where nobody is
  // reading. The fix in board-gate.yml is `npm test --`, which carries the bounds already
  // declared once in package.json rather than a third copy of them that can drift.
  const dir = join(REPO, ".github", "workflows");
  const steps = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (/^\s*#/.test(line)) continue;                       // a comment ABOUT a command is not one
      if (/(^|[^\w-])node\s+--test\b|(^|[^\w-])npm\s+(run\s+)?test\b/.test(line)) steps.push({ f, line: line.trim() });
    }
  }
  // ASSERT THE OBSERVATION HAPPENED. A regex that silently stopped matching would report a
  // clean sweep of nothing, which is the failure mode this whole file is about.
  assert.ok(steps.length >= 2,
    `only ${steps.length} test-running workflow step(s) were found; the scan is broken, and a `
    + "sweep that found nothing is not a sweep that found nothing wrong");

  for (const { f, line } of steps) {
    // `npm test` / `npm run test:coverage` carry both bounds by definition — that is what the
    // tests above pin. Anything invoking the runner directly must carry them itself.
    if (/(^|[^\w-])npm\s+(run\s+)?test/.test(line)) continue;
    assert.match(line, /--import=\.\/tests\/setup\/hang-watchdog\.mjs/,
      `${f}: this step runs the test runner with no hang watchdog:\n    ${line}`);
    assert.match(line, /--test-timeout=\d+/,
      `${f}: this step runs the test runner with no per-test timeout, which is Node's `
      + `--test-timeout=0 — BLZ-534's own value:\n    ${line}`);
  }
});

test("BLZ-534: both npm scripts declare the SAME per-test bound", () => {
  const scripts = npmScripts();
  const declared = ["test", "test:coverage"].map((n) => [n, declaredTestTimeoutMs(scripts[n])]);
  for (const [name, ms] of declared) {
    assert.notEqual(ms, null, `npm run ${name} declares no --test-timeout at all`);
  }
  assert.equal(new Set(declared.map(([, ms]) => ms)).size, 1,
    `the two scripts bound a test differently (${JSON.stringify(declared)}). CI runs one and `
    + "a developer usually runs the other, so a drift here means the bound that was measured "
    + "is not the bound that ships");
});

test("BLZ-534: the per-test bound sits between the run it must survive and the watchdog that must outlive it", () => {
  const perTest = declaredTestTimeoutMs(npmScripts().test);
  assert.ok(Number.isFinite(perTest) && perTest > 0,
    `the per-test bound must be a positive number of ms, not ${perTest}`);

  // FLOOR, derived rather than asserted from a literal. The tests in this very file give a
  // fixture child CHILD_SPAWN_TIMEOUT_MS to finish. A per-test bound at or below that ends
  // those tests before their own child bound can, so the failure a reader sees is "test timed
  // out" and never the diagnosis the fixture was built to produce.
  assert.ok(perTest > CHILD_SPAWN_TIMEOUT_MS,
    `--test-timeout=${perTest} is not above this file's own ${CHILD_SPAWN_TIMEOUT_MS}ms child `
    + "deadline, so the tests above would be killed before their fixtures finish");

  // CEILING, likewise. The two bounds answer different failures and must fire in the right
  // order: `--test-timeout` ends a test whose BODY never returns and names THAT TEST; the
  // watchdog ends a PROCESS that cannot exit and can only name the file. A per-test bound at
  // or above the watchdog deadline means the whole-file kill always wins, and every stuck
  // test is reported with the coarser of the two diagnostics.
  assert.ok(perTest < DEFAULT_WATCHDOG_MS,
    `--test-timeout=${perTest} is not below the ${DEFAULT_WATCHDOG_MS}ms watchdog deadline, so `
    + "the watchdog fires first and a stuck TEST is reported only as a stuck FILE");
});

test("BLZ-534: the watchdog's own deadline is observable without waiting for it to fire", () => {
  // The per-test bound can be read off `process.execArgv`. This one is a module constant plus
  // an env override, so it needs a function to ask — otherwise the only observation available
  // is a five-minute wait, and a bound nothing can look at is a bound that can be dropped
  // silently.
  assert.ok(Number.isFinite(DEFAULT_WATCHDOG_MS) && DEFAULT_WATCHDOG_MS > 0,
    `the watchdog's default deadline must be a positive number of ms, not ${DEFAULT_WATCHDOG_MS}`);
  assert.equal(resolveWatchdogMs({}), DEFAULT_WATCHDOG_MS,
    "an unset environment must resolve to the declared default, not to something else");
  assert.equal(resolveWatchdogMs({ BLAZE_TEST_WATCHDOG_MS: "1500" }), 1_500,
    "the documented override must be honoured — every fixture run above depends on it");
  assert.equal(resolveWatchdogMs({ BLAZE_TEST_WATCHDOG_MS: "0" }), 0,
    "`0` is the documented way to switch the watchdog off and must stay so");

  // FAIL CLOSED. A typo in the override is not a request to run unbounded. The previous
  // reading was `Number(env ?? DEFAULT)`, which turned `6oo` into NaN and removed the bound
  // without a word — the same silent-loss shape BLZ-534 exists to end.
  assert.equal(resolveWatchdogMs({ BLAZE_TEST_WATCHDOG_MS: "6oo" }), DEFAULT_WATCHDOG_MS,
    "an unparseable deadline must keep the default, not silently disable the watchdog");
  assert.equal(resolveWatchdogMs({ BLAZE_TEST_WATCHDOG_MS: "" }), DEFAULT_WATCHDOG_MS,
    "an empty override is an unset override, not a request to run unbounded");

  // And the resolved number is the one actually armed: `0` arms nothing, a positive value does.
  assert.equal(installHangWatchdog({ ms: 0 }), null, "a zero deadline must arm no timer");
  const armed = installHangWatchdog({ ms: 10_000, onFire: () => {} });
  assert.notEqual(armed, null, "a positive deadline must arm a timer");
  clearTimeout(armed);
});

// ── REVIEW FINDINGS ────────────────────────────────────────────────────────────────────
// Two defects a review reproduced against the shipped watchdog. Both are about the same
// thing: the watchdog said more than it had measured, and did less than it had claimed.

test("BLZ-534: a file that WORKS and then hangs is not told it is merely slow", () => {
  // REVIEW FINDING, and the same defect as the one below with its sign flipped. The verdict
  // that replaced "This is a HANG, not a slow run" was gated on the idle fraction — and the
  // watchdog's window runs from IMPORT, so a file that does real work and THEN leaks reads
  // as busy. This fixture burns ~1.2s of CPU and then leaks a live referenced socket, so it
  // can never exit; against a 3s deadline it was told it "may simply be SLOW rather than
  // stuck. Give it room with BLAZE_TEST_WATCHDOG_MS", printed directly above its own
  // `Endpoints: socket connected to …`. On a real leak that advice sends the operator the
  // wrong way. No gate on this number can separate the two cases, so none is applied.
  const r = runWithWatchdog(BUSY_LEAK, 3_000);
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /BLAZE TEST HANG WATCHDOG/,
    "the fixture must actually trip the deadline, or this test measures nothing");
  assert.match(out, /Endpoints: .*socket connected to/,
    "and it must really be leaking a socket — otherwise this is not the case under test");
  assert.doesNotMatch(out, /may\s+simply be SLOW/,
    "a file holding a live socket open must not be told it is probably just slow, least of "
    + "all directly above the endpoint list that refutes it");
  assert.doesNotMatch(out, /before\s+hunting for a leaked handle/,
    "nor be advised away from the leak the same report just named");
});

test("BLZ-534: the watchdog does not call a slow file a hang — it cannot tell them apart", () => {
  // REPRODUCED: this fixture does three seconds of honest work and leaks nothing. Against a
  // 1.5s deadline the shipped watchdog killed it and printed "This is a HANG, not a slow
  // run: the event loop had nothing to do", directly above its own contradicting evidence,
  // `Still open: PipeWrap×2, Timeout×1`. The timer starts at IMPORT, not at test completion,
  // so the distinction it asserted is one it never measured.
  const r = runWithWatchdog(SLOW, 1_500);
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /BLAZE TEST HANG WATCHDOG/,
    "the fixture must actually trip the deadline, or this test measures nothing");
  assert.doesNotMatch(out, /is a HANG, not a slow run/,
    "the watchdog must not assert a hang-vs-slow verdict it has no measurement for");
  assert.doesNotMatch(out, /after its tests finished/,
    "nor claim the tests had finished — here they had not, and the watchdog cannot see it");
});

test("BLZ-534: the watchdog reports the idle measurement it actually took", () => {
  // The other half of the rule: having dropped the claim it could not support, it must state
  // the number it can. `performance.nodeTiming.idleTime` was cited in the ticket and never
  // read; it is read now, and printed, so a reader can weigh the evidence themselves.
  const r = runWithWatchdog(LEAKY, 1_500);
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /Loop: +\d+ms idle, \d+ms busy, over the \d+ms actually elapsed/,
    "the deadline report must state how the window it enforced was actually spent");
});

test("BLZ-534: the window reported is the one that ELAPSED, not the one that was asked for", (t) => {
  // REVIEW FINDING. The line used to read `${idle}ms of the last ${ms}ms idle`, where `ms`
  // is the DECLARED deadline. A synchronous block holds the timer past its deadline, so an
  // 8s block against a 1500ms deadline printed `Loop: 0ms of the last 1500ms idle` — a
  // statement about the flag, dressed as a measurement, under a banner reading EVERY LINE IS
  // SOMETHING THAT WAS MEASURED. The fixture below burns ~1.2s of CPU inside a 500ms window.
  const r = runWithWatchdog(BUSY_LEAK, 500);
  const out = `${r.stdout}${r.stderr}`;
  const m = /Loop: +(\d+)ms idle, (\d+)ms busy, over the (\d+)ms actually elapsed/.exec(out);
  assert.ok(m, `the report must state the elapsed window:\n${out}`);
  const [, idle, busy, elapsed] = m.map(Number);
  t.diagnostic(`idle=${idle} busy=${busy} elapsed=${elapsed} against a 500ms deadline`);
  assert.ok(elapsed > 1_000,
    `the window reported (${elapsed}ms) is not the one that elapsed — this file blocked the `
    + "loop for over a second past a 500ms deadline, so anything near 500 is the flag being "
    + "read back rather than the clock");
  assert.equal(idle + busy, elapsed, "the two halves must add up to the window they describe");
});

/** Every live pid running the long-lived helper fixture. */
function helperPids() {
  return spawnSync("pgrep", ["-f", "hang-watchdog/helper-that-stays-alive.mjs"], { encoding: "utf8" })
    .stdout.split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0)
    // `pgrep -f` matches this test process's own arguments too when it is named on them.
    .filter((pid) => pid !== process.pid);
}

test("BLZ-534: the watchdog reaps the children of the process it kills", async (t) => {
  // REPRODUCED: `process.exit(87)` does not reap children. A fixture that spawns a helper and
  // then leaks a socket left the helper alive — 0 before, 1 after — and a probe left a real
  // `scripts/serve.mjs` still running fifteen minutes later. The test above kills the process
  // GROUP precisely because of this; the production watchdog must do the same.
  t.after(() => { for (const pid of helperPids()) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } });
  const before = helperPids().length;
  const r = runWithWatchdog(SPAWNER, 1_500);
  assert.notEqual(r.status, 0, `the fixture must trip the watchdog:\n${r.stdout}${r.stderr}`);
  // Reaping is not instantaneous; give the kills a moment before counting.
  for (let i = 0; i < 30 && helperPids().length > before; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(helperPids().length, before,
    "the watchdog killed the test process and left its child running. `process.exit()` does "
    + "not reap children, so every hung file that had spawned one leaks a process per run");
});

test("BLZ-534: the watchdog says what it did about children — the COUNT, not a phrase", () => {
  // Asserting "one of these three phrasings appears" does not discriminate: a report hard-
  // wired to "none to reap" satisfies it while the reap has stopped happening. Measured —
  // that mutation passed this test until it was rewritten to name the number. This fixture
  // spawns exactly one helper, so the report has exactly one number it can honestly print.
  const r = runWithWatchdog(SPAWNER, 1_500);
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /Children: +reaped 1 still parented to this process\b/,
    "the report must state how many descendants were actually killed; this fixture leaves "
    + "exactly one, and any other answer means the reap did not happen as reported");
  assert.doesNotMatch(out, /no children|nothing left running|clean exit/i,
    "and must not upgrade a count into a claim that nothing was left behind — `pgrep -P` "
    + "cannot see a grandchild that has already been reparented");
});

test("BLZ-534: a reap that could not look never reads as a clean exit", () => {
  // The `checked: false` branch — no usable `pgrep` on the machine — cannot be produced by
  // running a fixture on a machine that has one, so it is asserted at the unit the report is
  // written by. Three distinct outcomes, three distinct sentences; conflating "I looked and
  // found none" with "I could not look" is how a leaked process gets reported as no process.
  const say = (reap) => watchdogReport({ file: "f.mjs", ms: 1_000, types: [], peers: [], idleMs: 900, reap });
  assert.match(say({ checked: true, killed: 2 }), /Children: +reaped 2 still parented/);
  assert.match(say({ checked: true, killed: 0 }), /Children: +none still parented to this process/);
  const blind = say({ checked: false, killed: 0 });
  assert.match(blind, /Children: +the walk did not complete/,
    "a watchdog whose walk did not finish must say so");
  assert.doesNotMatch(blind, /none still parented|reaped \d/,
    "and must not report an outcome it never observed");

  // And the source of that flag: `null` from the walk, distinct from `[]`.
  assert.equal(descendantPids(1, () => null), null, "an unreadable process table must be null, not empty");
  assert.deepEqual(descendantPids(1, () => []), [], "a readable table with no children is empty, not null");
  assert.deepEqual(reapDescendants(null), { checked: false, killed: 0 },
    "nothing may be claimed killed when nothing could be listed");
});

test("BLZ-534: a walk that failed BELOW the root is incomplete, not complete-and-small", () => {
  // REVIEW FINDING, and the same rule as above one level down. `null` propagated from the
  // ROOT read only; every nested failure was swallowed by `childrenOf(k) ?? []`. So a walk
  // that listed the first generation and then could not read the second returned that first
  // generation as if it were the whole tree, and the report said `reaped 1` or `none` for a
  // tree it never finished. Reachable in production whenever a nested `pgrep` hits its 5s
  // timeout or cannot fork — exactly when a machine is loaded enough to be leaking processes.
  const rootOnly = (pid) => (pid === 1 ? [2] : null);
  assert.equal(descendantPids(1, rootOnly), null,
    "a lookup that failed below the root must make the WHOLE walk unknown — returning [2] "
    + "here is a partial answer presented as a complete one");
  assert.deepEqual(reapDescendants(descendantPids(1, rootOnly)), { checked: false, killed: 0 },
    "and nothing may be claimed about children of a tree that was never fully walked");

  // The walk still works when every generation answers, and it really does go deeper than one.
  const tree = { 1: [2, 3], 2: [4], 3: [], 4: [] };
  assert.deepEqual(descendantPids(1, (pid) => tree[pid] ?? []).sort(), [2, 3, 4],
    "a complete walk must reach the grandchildren, not stop at the first generation");
});

test("BLZ-534: a run that has neither bound says so, in its own output rather than only in docs", (t) => {
  // `node --test` run directly gets neither the watchdog nor `--test-timeout`: Node's own
  // default is `--test-timeout=0`, which is no per-test timeout at all — the very value
  // BLZ-534 reported. The engine guard has an in-suite backstop that FAILS; these two cannot,
  // because running one file with bare `node --test` is legitimate and turning it red would
  // be worse than the gap. So the limit is stated where the person running it will see it.
  //
  // WHICH BRANCH IS WHICH. The watchdog only arrives by `--import=`, and only the two npm
  // scripts pass it — so a process that HAS it is a process that was started by one of them,
  // and the bound it got is checkable against what that script declares. A process that does
  // not have it was started some other way; that is the legitimate case, and it gets the
  // notice. The two are separated on the watchdog alone, not on "is anything missing", so
  // that dropping `--test-timeout` from an npm script lands in the branch that FAILS rather
  // than quietly downgrading the run to the one that only prints.
  const here = activeBounds();
  if (here.watchdog) {
    // THE HALF THAT REDDENS. The per-test bound this process actually received must be the
    // one package.json declares. Everything above checks the declaration; this checks that
    // the declaration REACHED THE RUN. Drop the flag from the script and this names the
    // loss — including the `--test-timeout=0` Node falls back to, BLZ-534's own value.
    assert.equal(here.testTimeoutMs, declaredTestTimeoutMs(npmScripts().test),
      "this process is running under the hang watchdog, so it was started by an npm test "
      + "script — but the per-test bound it actually got is not the one package.json "
      + "declares. A bound that is declared and not delivered is not a bound");
    t.diagnostic(`bounded: --test-timeout=${here.testTimeoutMs}ms, hang watchdog preloaded`);
  }
  const missing = [
    ...(here.watchdog ? [] : ["the hang watchdog (--import=./tests/setup/hang-watchdog.mjs)"]),
    ...(here.testTimeoutMs > 0 ? [] : ["a per-test timeout (--test-timeout=0 means none)"]),
  ];
  if (missing.length) {
    const notice = `\nUNBOUNDED TEST RUN: this process is missing ${missing.join(" and ")}.\n`
      + "Only `npm test` and `npm run test:coverage` carry the two bounds; `node --test` run\n"
      + "directly carries neither, so a file that hangs under it hangs forever (BLZ-534).\n";
    t.diagnostic(notice.trim().replace(/\n/g, " "));
    process.stderr.write(notice);
  }

  // The detector itself is asserted, not just used: a notice that silently stopped being able
  // to see a missing bound would report every run as bounded and no one would notice.
  assert.deepEqual(
    activeBounds(["--test-timeout=120000", "--import=./tests/setup/hang-watchdog.mjs"]),
    { testTimeoutMs: 120_000, watchdog: true }, "the npm invocation must read as bounded");
  assert.deepEqual(activeBounds(["--test-timeout=0"]),
    { testTimeoutMs: 0, watchdog: false }, "a bare `node --test` must read as unbounded");
  assert.deepEqual(activeBounds([]),
    { testTimeoutMs: 0, watchdog: false }, "no flag at all is no bound at all");
  assert.equal(activeBounds(["--test-timeout=0", "--test-timeout=5000"]).testTimeoutMs, 5_000,
    "a repeated flag resolves last-wins, the way Node itself resolves it");
});
