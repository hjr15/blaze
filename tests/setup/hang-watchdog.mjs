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
import { basename } from "node:path";

/** Distinct from 1 so a watchdog kill is not confused with an ordinary test failure. */
export const WATCHDOG_EXIT_CODE = 87;

/** Deadline for one test FILE's process, in ms. Generous on purpose: the whole suite runs
 *  in about a minute, so a single file still running after five is not slow, it is stuck.
 *  Override with `BLAZE_TEST_WATCHDOG_MS`; `0` disables the watchdog entirely. */
export const DEFAULT_WATCHDOG_MS = 300_000;

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
 *  without having to hang a process to read it. */
export function watchdogReport({ file, ms, types, peers }) {
  return [
    "",
    "=== BLAZE TEST HANG WATCHDOG ===============================================",
    `${file} did not exit within ${ms}ms after its tests finished.`,
    "This is a HANG, not a slow run: the event loop had nothing to do and was still",
    "being held open. Reported as a failure so CI can tell the two apart (BLZ-534).",
    `Still open: ${types.length ? types.join(", ") : "nothing reportable"}`,
    ...(peers.length ? [`Endpoints:  ${peers.join("; ")}`] : []),
    "Two PipeWrap handles are this process's own stdout/stderr and are expected.",
    "A leaked database or HTTP client is the usual cause — close it on the failure",
    "path too, not only as the last statement of a passing test.",
    `Raise or disable the deadline with BLAZE_TEST_WATCHDOG_MS (0 = off).`,
    "============================================================================",
    "",
  ].join("\n");
}

/** Arm the watchdog. Returns the timer, or `null` when the watchdog is switched off. */
export function installHangWatchdog({
  ms = Number(process.env.BLAZE_TEST_WATCHDOG_MS ?? DEFAULT_WATCHDOG_MS),
  file = basename(process.argv[1] ?? "test process"),
  onFire = null,
} = {}) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const timer = setTimeout(() => {
    const { types, peers } = describeActiveResources();
    const report = watchdogReport({ file, ms, types, peers });
    if (onFire) return onFire(report);
    process.stderr.write(report);
    process.exit(WATCHDOG_EXIT_CODE);
  }, ms);
  timer.unref();
  return timer;
}

installHangWatchdog();
