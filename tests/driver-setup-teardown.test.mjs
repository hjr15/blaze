// tests/driver-setup-teardown.test.mjs — BLZ-534.
//
// THE LEAK ON THE PATH THAT LEAKS IT.
//
// BLZ-534's unchecked acceptance criterion is "the leaked `pg` connection is closed on the
// path that leaks it". Moving each test's teardown into `t.after()` closed the ASSERTION
// path. It did not close the SETUP path: `openDriver` registered `t.after` only once the
// seed had RETURNED, and `seedPg` opens the Postgres client and then runs TRUNCATE and
// several INSERTs. A throw from any of those — a permissions change, a schema drift, a
// trigger — happens with the socket already open and nothing registered to close it.
//
// REPRODUCED, not reasoned about. With a real Postgres and a `BEFORE TRUNCATE` trigger that
// raises, the shipped tests/model/driver-conformance.test.mjs ran past a 45-second bound and
// was killed: exit 124. That is BLZ-534's exact shape, on the file the ticket names.
//
// The scanner cannot see this one either: `scripts/ci/temp-cleanup-guard.mjs` is a line
// scanner that does not follow cleanup into a helper, which is the blind spot it documents.
// So this file is the check that the helper itself holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDriver } from "./helpers/open-driver.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "tests", "fixtures", "hang-watchdog", "setup-throws-after-connecting.mjs");

/** `NODE_TEST_CONTEXT` is set in this process by the runner executing this file, and an
 *  inherited copy makes the child print "run() is being called recursively" and run nothing
 *  at all — silently, exit 0. */
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test("BLZ-534: a seed that throws after connecting still lets the file EXIT", async (t) => {
  // `detached` and a NEGATIVE pid on the kill: `node --test` spawns a further child per test
  // file, and killing only the runner orphans that grandchild — which is the very thing a
  // leaked handle makes unkillable-by-exit.
  const child = spawn(process.execPath, ["--test", FIXTURE],
    { cwd: REPO, stdio: "ignore", env: childEnv(), detached: true });
  const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
  t.after(killGroup);

  const code = await new Promise((resolve) => {
    child.once("exit", (c) => resolve(c));
    setTimeout(() => resolve("TIMED OUT"), 20_000).unref();
  });
  killGroup();

  assert.notEqual(code, "TIMED OUT",
    "the file never exited. A seed that throws between opening the connection and returning "
    + "is still leaking it, which is BLZ-534's hang on the path the ticket names");
  assert.notEqual(code, 0, "the seed threw, so the file must report a failure, not a pass");
});

test("BLZ-534: teardown registered mid-seed runs even though the seed never returned", async (t) => {
  // The unit form of the same property, and the one that says WHICH guarantee holds:
  // everything handed to `release` runs, in reverse, whether the seed returned or threw.
  const order = [];
  await t.test("inner: a seed that registers twice and then throws", async (inner) => {
    await assert.rejects(
      () => openDriver(async (release) => {
        release(() => order.push("first"));
        release(() => order.push("second"));
        throw new Error("seed failed");
      }, inner),
      /seed failed/,
      "the seed's error must still reach the test — teardown must not swallow the failure");
  });
  assert.deepEqual(order, ["second", "first"],
    "both teardowns must run, innermost first, after a seed that threw");
});

test("BLZ-534: a seed that returns normally still has its teardown run", async (t) => {
  const order = [];
  await t.test("inner: an ordinary successful seed", async (inner) => {
    const { s } = await openDriver(async (release) => {
      release(() => order.push("closed"));
      return { s: "driver", root: null };
    }, inner);
    assert.equal(s, "driver", "openDriver must return what the seed returned");
    assert.deepEqual(order, [], "teardown must not run before the test body does");
  });
  assert.deepEqual(order, ["closed"]);
});

test("BLZ-534: one failing teardown does not skip the rest, and the failure still surfaces", async () => {
  // Driven through a FAKE test context, because a real teardown that throws fails its own
  // test by design — which would mask the assertion this test is actually making.
  const order = [];
  let hook;
  await openDriver(async (release) => {
    release(() => order.push("released first, so torn down last"));
    release(() => { throw new Error("teardown failed"); });
    return { s: {}, root: null };
  }, { after: (fn) => { hook = fn; } });

  assert.deepEqual(order, [], "nothing may be torn down before the hook runs");
  await assert.rejects(() => hook(), /teardown failed/,
    "a teardown that threw must still fail the test — a silently swallowed close is exactly "
    + "how a leaked connection goes unnoticed");
  assert.deepEqual(order, ["released first, so torn down last"],
    "a teardown that throws must not strand the resources released before it");
});
