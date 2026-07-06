import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../scripts/serve.mjs";

async function boot(opts) {
  const server = startServer({ port: 0, ...opts });
  await new Promise((res) => server.once("listening", res));
  return server;
}

test("startServer defaults to loopback (127.0.0.1)", async () => {
  const server = await boot({});
  assert.equal(server.address().address, "127.0.0.1");
  server.close();
});

test("startServer honours an explicit host arg", async () => {
  const server = await boot({ host: "0.0.0.0" });
  assert.equal(server.address().address, "0.0.0.0");
  server.close();
});
