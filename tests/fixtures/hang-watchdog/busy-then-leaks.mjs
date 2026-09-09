// Fixture for tests/hang-watchdog.test.mjs. NOT a `.test.mjs` file, so `node --test` with no
// arguments never picks it up.
//
// THE CASE THAT BROKE THE IDLE-FRACTION VERDICT. This file burns real CPU for about a second
// and THEN leaks a live referenced socket, so it can never exit — a genuine hang, and the
// most expensive kind to misdiagnose. The watchdog's window runs from IMPORT, so that CPU
// lands inside it and the loop reads as busy. A verdict gated on the idle fraction therefore
// told this file it "may simply be SLOW rather than stuck. Give it room with
// BLAZE_TEST_WATCHDOG_MS" — directly above its own `Endpoints: socket connected to …`, and
// pointing the operator away from the leak it had just printed.
//
// Any file that does work and then hangs lands here. That is why the report now states busy
// and idle as numbers and draws no conclusion from either.
import { test } from "node:test";
import net from "node:net";

test("burns CPU, then leaks a referenced socket", async () => {
  const end = Date.now() + 1_200;
  // Synchronous on purpose: this must be loop-BUSY time, not a timer wait.
  while (Date.now() < end) { /* spin */ }
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const socket = net.connect(server.address().port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  // Deliberately never closed, and deliberately not unref'd.
});
