// Fixture for tests/driver-setup-teardown.test.mjs. NOT a `.test.mjs` file, so `node --test`
// with no arguments never picks it up — it is only ever run by being named explicitly.
//
// BLZ-534's SETUP-FAILURE shape, reproduced without needing a Postgres server. `seedPg`
// opens the client and THEN runs TRUNCATE and INSERT, so a throw from any of those
// statements happens with a live referenced socket already open. This fixture does exactly
// that against a local TCP server, and imports the REAL `openDriver` so what is under test
// is the shipped helper rather than a copy of it.
//
// Reproduced against a real Postgres before the fix: a `BEFORE TRUNCATE` trigger that
// raises made the shipped tests/model/driver-conformance.test.mjs run past a 45s bound and
// be killed at exit 124.
import { test } from "node:test";
import net from "node:net";
import { openDriver } from "../../helpers/open-driver.mjs";

/** Opens a live socket, registers its release, and only then fails — the order that
 *  matters. Registering AFTER the throw would prove nothing. */
async function seedThatFailsAfterConnecting(release) {
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const socket = net.connect(server.address().port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  release(async () => {
    socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  throw new Error("seed failed after the connection was open — BLZ-534's shape");
}

test("setup throws once the connection is live", async (t) => {
  await openDriver(seedThatFailsAfterConnecting, t);
});
