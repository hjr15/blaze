// Fixture for tests/hang-watchdog.test.mjs. NOT a `.test.mjs` file.
//
// A test file that spawns a long-lived child and then leaks a socket. `process.exit(87)`
// does not reap children, so before the fix the watchdog ended this file and left the helper
// running: measured 0 alive before, 1 after, and a real `scripts/serve.mjs` was found still
// running fifteen minutes after a probe. tests/hang-watchdog.test.mjs already kills the
// process GROUP for exactly this reason; the production watchdog has to do it too.
import { test } from "node:test";
import net from "node:net";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "helper-that-stays-alive.mjs");

test("spawns a helper, finishes, then leaks a referenced socket", async () => {
  spawn(process.execPath, [HELPER], { stdio: "ignore" });
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const socket = net.connect(server.address().port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  // Deliberately never closed, and deliberately not unref'd.
});
