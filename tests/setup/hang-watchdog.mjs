// tests/setup/hang-watchdog.mjs — BLZ-534.
//
// A BOUND ON A TEST FILE THAT CANNOT EXIT, AND A DIAGNOSTIC WHEN IT IS HIT.
//
// Preloaded into every test process by `--import=./tests/setup/hang-watchdog.mjs` in the
// `test` and `test:coverage` npm scripts. `node --test` forwards its own `execArgv` to the
// child process it spawns per test file, so one flag on the runner puts this in all of them.
//
// WHY A WATCHDOG AND NOT JUST `--test-timeout`. The two bound different failures:
//
//   * `--test-timeout` ends a test whose BODY never returns. The npm scripts set it, and
//     that is the right tool for a test that awaits something that never settles.
//   * This watchdog ends a PROCESS that cannot exit after its tests have finished. That is
//     the shape BLZ-534 actually observed: every test in
//     `tests/model/driver-conformance.test.mjs` had passed, and the child then sat at 0%
//     CPU, blocked in `ep_poll`, holding a live referenced TCP handle to the Postgres port,
//     with `loopIdleTime` at 1678s. No per-test timeout can see that; the tests were done.
//
// WHAT IT CANNOT TELL YOU, AND THEREFORE DOES NOT SAY. This timer starts at IMPORT, not at
// test completion, so when it fires it does not know whether the file's tests had finished.
// It reports the deadline it enforced and the measurements it took — the still-open handles
// and how much of the window the event loop spent idle — and leaves the verdict to those.
// An earlier version asserted "This is a HANG, not a slow run"; a fixture doing three
// seconds of honest work and leaking nothing was killed at a 1.5s deadline and given that
// sentence, directly above its own `Still open: PipeWrap x2, Timeout x1`. `idleTime` was
// measured before this wording was chosen, and it does NOT separate the two cases: a leaked
// socket and a timer-driven slow file both sit at ~97% idle. It does separate a file doing
// real CPU or I/O work (~16% idle), and that narrower distinction is the only one claimed.
//
// WHY THE TIMER IS UNREF'D. An unref'd timer does not keep the event loop alive on its own,
// so a healthy file exits the instant its work is done and pays nothing for this file being
// loaded. But it stays in the timer heap, so if something ELSE is holding the loop open when
// the deadline passes, the loop wakes and the callback runs. That is exactly the condition
// worth reporting: the process had nothing to do and still could not leave.
// `tests/hang-watchdog.test.mjs` pins both halves — it fires on a leaked socket, and a clean
// file against a 60s deadline still finishes in seconds.
//
// WHAT THIS DOES NOT CLAIM. BLZ-534's hang was reproduced once and then not reproduced in
// ~10 further runs across two reviewers. Nothing here reproduces it, and a green suite is
// not evidence it is gone. What is verifiable, and what is tested, is that the failure mode
// changed: an unbounded hang became a bounded, attributable failure.
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

/** Distinct from 1 so a watchdog kill is not confused with an ordinary test failure. */
export const WATCHDOG_EXIT_CODE = 87;

/** Deadline for one test FILE's process, in ms. Generous on purpose: the whole suite runs
 *  in about a minute, so a single file still running after five is not slow, it is stuck.
 *  Override with `BLAZE_TEST_WATCHDOG_MS`; `0` disables the watchdog entirely. */
export const DEFAULT_WATCHDOG_MS = 300_000;

/** The deadline THIS process would actually enforce, resolved from the environment.
 *
 *  Exported so the second of the two bounds is OBSERVABLE from inside a test file. The
 *  per-test bound can be read off `process.execArgv` (`activeBounds` below); this one is a
 *  module constant plus an env override, and without a function to ask, the only way to
 *  observe it is to wait five minutes for it to fire. A bound nothing can look at is a bound
 *  that can be dropped silently, which is the failure BLZ-534 is about one level up.
 *
 *  FAIL CLOSED ON A TYPO. `0` — and any non-positive number — is the documented way to switch
 *  the watchdog off, and is honoured. `BLAZE_TEST_WATCHDOG_MS=6oo` is not a request to run
 *  unbounded, it is a mistake, and the previous `Number(...)` reading turned it into `NaN`
 *  and silently removed the bound. An unparseable value now keeps the default. */
export function resolveWatchdogMs(env = process.env) {
  const raw = env.BLAZE_TEST_WATCHDOG_MS;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_WATCHDOG_MS;
  const ms = Number(raw);
  if (!Number.isFinite(ms)) return DEFAULT_WATCHDOG_MS;
  return ms > 0 ? ms : 0;
}

/** Below this share of the window spent idle, the loop was demonstrably still running work,
 *  and the report says so. Above it nothing is claimed either way: measured on this repo, a
 *  leaked socket and a merely-slow timer-driven file are both ~0.97 idle and indistinguishable
 *  here. Only the busy end of the scale carries a signal, so only it is read as one. */
export const BUSY_IDLE_FRACTION = 0.9;

/** Idle time in the loop when the watchdog was armed, so the report describes ITS window
 *  rather than the whole life of the process. */
let idleAtArm = 0;

/** Every descendant pid of `pid`, shallowest first.
 *
 *  `null` — distinct from `[]` — when the process table could not be read at all, so the
 *  report can say "could not be checked" rather than implying a clean exit it never verified.
 *  `pgrep -P` is used rather than a dependency: it is present on Linux and macOS, and its
 *  absence degrades the message instead of throwing. */
export function descendantPids(pid = process.pid, childrenOf = pgrepChildren) {
  const roots = childrenOf(pid);
  if (roots === null) return null;
  const out = [];
  const walk = (kids) => { for (const k of kids) { out.push(k); walk(childrenOf(k) ?? []); } };
  walk(roots);
  return out;
}

function pgrepChildren(pid) {
  let r;
  try { r = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8", timeout: 5_000 }); }
  catch { return null; }
  if (r.error) return null;         // no pgrep on this machine
  if (r.status === 1) return [];    // pgrep ran and found no children
  if (r.status !== 0) return null;
  return r.stdout.split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
}

/** SIGKILL every descendant, deepest first, and report what was actually done.
 *
 *  `process.exit()` DOES NOT REAP CHILDREN. A test file that spawned a helper and then hung
 *  left that helper running after the watchdog ended it — measured 0 alive before, 1 after —
 *  and a probe left a real `scripts/serve.mjs` running fifteen minutes later.
 *  `tests/hang-watchdog.test.mjs` kills the process GROUP for this reason. A group kill is
 *  not available here: this process shares its group with the test runner and with npm, so
 *  killing the group would take the whole run down. The descendants are walked instead. */
export function reapDescendants(pids = descendantPids()) {
  if (pids === null) return { checked: false, killed: 0 };
  let killed = 0;
  for (const pid of [...pids].reverse()) {
    try { process.kill(pid, "SIGKILL"); killed++; } catch { /* already gone */ }
  }
  return { checked: true, killed };
}

/** What is still holding the loop open, in words a CI log reader can act on.
 *
 *  `process.getActiveResourcesInfo()` gives the handle TYPES, which is enough to tell a
 *  leaked socket from a leaked timer but not enough to tell WHICH socket. The peer address
 *  is the part that identifies a leaked database connection, so it is read off the handles
 *  themselves when the runtime exposes them. `process._getActiveHandles` is undocumented,
 *  so its absence degrades the message rather than throwing. */
export function describeActiveResources() {
  const counts = new Map();
  for (const kind of process.getActiveResourcesInfo()) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const types = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}×${n}`);

  const peers = [];
  const handles = typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [];
  for (const h of handles) {
    try {
      if (h && typeof h.remoteAddress === "string" && h.remotePort)
        peers.push(`socket connected to ${h.remoteAddress}:${h.remotePort}`);
      else if (h && typeof h.address === "function") {
        const a = h.address();
        if (a && typeof a === "object" && a.port) peers.push(`listener bound to ${a.address}:${a.port}`);
      }
    } catch { /* a handle that will not describe itself is not worth failing the report over */ }
  }
  return { types, peers };
}

/** The message printed when the deadline is hit. Exported so the wording is testable
 *  without having to hang a process to read it.
 *
 *  EVERY LINE IS SOMETHING THAT WAS MEASURED. The deadline, the handles still open, the
 *  share of the window the loop spent idle, and what the reap actually did. The one
 *  interpretive line is gated on `idleMs`, and it only fires at the end of the scale where
 *  that number means something. */
export function watchdogReport({ file, ms, types, peers, idleMs, reap }) {
  const idle = Math.round(idleMs);
  const busy = Math.max(0, Math.round(ms - idleMs));
  const reading = idleMs / ms < BUSY_IDLE_FRACTION
    ? [`The loop was still running work for about ${busy}ms of that window, so this file may`,
       "simply be SLOW rather than stuck. Give it room with BLAZE_TEST_WATCHDOG_MS before",
       "hunting for a leaked handle."]
    : ["The loop spent almost all of that window with nothing to run. That is what a leaked",
       "handle looks like — and also what waiting on something slow looks like, so the",
       "handles above are what tells them apart, not this deadline being hit."];
  const children = reap.checked
    ? (reap.killed ? `reaped ${reap.killed} — process.exit() does not do this on its own` : "none to reap")
    : "could not be checked (no usable pgrep); anything this file spawned may still be running";
  return [
    "",
    "=== BLAZE TEST HANG WATCHDOG ===============================================",
    `${file} did not exit within ${ms}ms of this watchdog being armed.`,
    "The watchdog is armed at import, so it cannot tell whether the tests had finished:",
    "it reports what it measured and ends the process (BLZ-534).",
    `Still open: ${types.length ? types.join(", ") : "nothing reportable"}`,
    ...(peers.length ? [`Endpoints:  ${peers.join("; ")}`] : []),
    `Loop:       ${idle}ms of the last ${ms}ms idle`,
    `Children:   ${children}`,
    ...reading,
    "Two PipeWrap handles are this process's own stdout/stderr and are expected.",
    "A leaked database or HTTP client is the usual cause of a stuck file — close it on the",
    "failure path too, not only as the last statement of a passing test.",
    "Raise or disable the deadline with BLAZE_TEST_WATCHDOG_MS (0 = off).",
    "============================================================================",
    "",
  ].join("\n");
}

/** Which of the two bounds THIS process is actually running under, read off the flags Node
 *  reports rather than inferred from how the suite was meant to be invoked.
 *
 *  `node --test` run directly gets NEITHER: no `--import` of this file, and Node's own
 *  default of `--test-timeout=0`, which means no per-test timeout at all. Only `npm test`
 *  and `npm run test:coverage` carry them. The engine guard has an in-suite backstop
 *  (tests/engine-precondition.test.mjs); these two cannot have one that fails, because a
 *  bare `node --test` is a legitimate way to run one file — so the backstop SAYS SO instead,
 *  in the run's own output. See tests/hang-watchdog.test.mjs. */
export function activeBounds(execArgv = process.execArgv) {
  const flag = "--test-timeout=";
  const timeouts = execArgv.filter((a) => a.startsWith(flag)).map((a) => Number(a.slice(flag.length)));
  return {
    // Last wins, which is how Node itself resolves a repeated flag.
    testTimeoutMs: timeouts.filter(Number.isFinite).at(-1) ?? 0,
    watchdog: execArgv.some((a) => a.startsWith("--import=") && a.includes("hang-watchdog")),
  };
}

/** Arm the watchdog. Returns the timer, or `null` when the watchdog is switched off. */
export function installHangWatchdog({
  ms = resolveWatchdogMs(),
  file = basename(process.argv[1] ?? "test process"),
  onFire = null,
} = {}) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  idleAtArm = performance.nodeTiming.idleTime;
  const timer = setTimeout(() => {
    const { types, peers } = describeActiveResources();
    const idleMs = performance.nodeTiming.idleTime - idleAtArm;
    // Reaped BEFORE the report is written, so what the report says about children is what
    // actually happened rather than what was about to be attempted.
    const reap = reapDescendants();
    const report = watchdogReport({ file, ms, types, peers, idleMs, reap });
    if (onFire) return onFire(report);
    process.stderr.write(report);
    process.exit(WATCHDOG_EXIT_CODE);
  }, ms);
  timer.unref();
  return timer;
}

installHangWatchdog();
