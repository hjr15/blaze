// Control fixture for tests/hang-watchdog.test.mjs: the watchdog must be invisible on a
// file that closes what it opens. If this one ever trips the watchdog, the watchdog is
// worse than the hang it bounds.
import { test } from "node:test";
import net from "node:net";

test("closes what it opens", async () => {
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const socket = net.connect(server.address().port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.destroy();
  await new Promise((resolve) => server.close(resolve));
});
