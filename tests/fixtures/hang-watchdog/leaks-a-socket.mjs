// Fixture for tests/hang-watchdog.test.mjs. NOT a `.test.mjs` file, so `node --test`
// with no arguments never picks it up — it is only ever run by being named explicitly.
//
// It reproduces BLZ-534's SHAPE, not its cause: every test in the file finishes, and a
// live referenced TCP socket is left behind, so the child process has nothing left to
// do and still cannot exit. That is what was observed on the real hang — 0 CPU, blocked
// in `ep_poll`, a referenced TCP handle to the Postgres port, `loopIdleTime` 1678s.
import { test } from "node:test";
import net from "node:net";

test("finishes, then leaks a referenced socket", async () => {
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const socket = net.connect(server.address().port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  // Deliberately never closed, and deliberately not unref'd.
});
