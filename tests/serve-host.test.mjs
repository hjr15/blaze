import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";

// BLZ-133: startServer no longer falls back to the ambient engine tree when no
// board is given — serving a board that doesn't exist is now a loud failure
// rather than an empty page. These tests only assert bind behaviour, so they
// serve a real, empty board.
const BOARD = (() => {
  const d = mkdtempSync(join(tmpdir(), "blaze-servehost-"));
  mkdirSync(join(d, "projects"), { recursive: true });
  return d;
})();

async function boot(opts) {
  const server = startServer({ port: 0, root: BOARD, projectsDir: join(BOARD, "projects"), ...opts });
  await new Promise((res) => server.once("listening", res));
  return server;
}

test("startServer defaults to loopback (127.0.0.1)", async () => {
  const server = await boot({});
  assert.equal(server.address().address, "127.0.0.1");
  server.close();
});

// BLZ-348: an explicit non-loopback host is still honoured — but only once there is
// something to authenticate against. This test used to bind 0.0.0.0 against a board with
// no users and call that a pass; ADR-0013's bind boundary is now actually enforced, so
// the identity has to exist first. The refusal itself is proven in serve-identity.test.mjs.
test("startServer honours an explicit host arg", async () => {
  await addUser(BOARD, { email: "host-test@example.com", role: "admin" });
  const server = await boot({ host: "0.0.0.0" });
  assert.equal(server.address().address, "0.0.0.0");
  server.close();
});
