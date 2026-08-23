// tests/supervisor-bind.test.mjs — BLZ-359 AC 3: where `blaze start` may bind.
//
// The supervisor is loopback-BY-CONSTRUCTION: unlike serve.mjs it does not read HOST,
// and no configuration widens it. That property is the reason the ungated `/control/*`
// hole this ticket fixes was local-only rather than remote, so it is now PINNED by test
// rather than left as a line of prose that a one-word edit could quietly falsify.
//
// `checkBindSafety` is also genuinely called — on `startSupervisor`'s `host` argument.
// Called on a hardcoded constant it could only ever return ok, which is a check that
// cannot fail and therefore proves nothing; the argument exists so the refusal is
// reachable and provable. Nothing in the shipped path supplies it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../scripts/config.mjs";
import { startSupervisor, SUPERVISOR_HOST } from "../scripts/supervisor.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";

function board() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-sup-bind-"));
  mkdirSync(join(dir, "projects"), { recursive: true });
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({ key: "TASK" }));
  for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                   ["add", "-A"], ["commit", "-q", "-m", "seed"]])
    execFileSync("git", ["-C", dir, ...a]);
  return dir;
}

async function boot(dir, opts = {}) {
  const app = startSupervisor({ root: dir, cfg: loadConfig({ root: dir, env: {} }), port: 0, ...opts });
  await new Promise((r) => app.server.once("listening", r));
  return app;
}

/** Set HOST for one boot and put the environment back, whatever happens. */
async function withHostEnv(value, fn) {
  const had = Object.hasOwn(process.env, "HOST");
  const before = process.env.HOST;
  process.env.HOST = value;
  try { return await fn(); }
  finally { if (had) process.env.HOST = before; else delete process.env.HOST; }
}

describe("BLZ-359: `blaze start` binds loopback, and nothing in the environment moves it", () => {
  test("it binds 127.0.0.1 by default", async () => {
    const dir = board();
    const app = await boot(dir);
    // The LITERAL, not SUPERVISOR_HOST: comparing the bound address to the constant it
    // came from moves both sides of the assertion together, and widening the constant
    // would keep this test green. Caught by mutation.
    try {
      assert.equal(app.server.address().address, "127.0.0.1");
      assert.equal(SUPERVISOR_HOST, "127.0.0.1");
    }
    finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("HOST=0.0.0.0 in the environment is IGNORED on a board with no identities", async () => {
    // Two ways a future edit could widen this bind, both caught here. If someone wrote
    // `host = process.env.HOST || SUPERVISOR_HOST`, this board has no users, so
    // checkBindSafety would throw the refusal and this test fails loudly rather than
    // serving 0.0.0.0. If the refusal were also removed, the address assertion fails.
    const dir = board();
    await withHostEnv("0.0.0.0", async () => {
      const app = await boot(dir);
      try { assert.equal(app.server.address().address, "127.0.0.1"); }
      finally { app.server.close(); }
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("HOST=0.0.0.0 is ignored on a board WITH identities too", async () => {
    // The identities board is the case the bind refusal would wave through, so the pin
    // has to be asserted here as well — otherwise "honours HOST once you have users"
    // would slip in unnoticed.
    const dir = board();
    await addUser(dir, { email: "a@b.c", role: "admin" });
    await withHostEnv("0.0.0.0", async () => {
      const app = await boot(dir);
      try { assert.equal(app.server.address().address, "127.0.0.1"); }
      finally { app.server.close(); }
    });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("BLZ-359: checkBindSafety is live here, not decoration", () => {
  test("an explicit non-loopback host with NO identities is REFUSED, and nothing listens", () => {
    const dir = board();
    try {
      assert.throws(
        () => startSupervisor({ root: dir, cfg: loadConfig({ root: dir, env: {} }),
                                port: 0, host: "0.0.0.0" }),
        /refusing to serve on 0\.0\.0\.0 with no users configured/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("...and the same host is allowed once an identity exists — the check reads hasIdentity",
    async () => {
      // The discriminating half. Without it the refusal above would be satisfied by a
      // check that refuses unconditionally, which would prove nothing about the rule.
      const dir = board();
      await addUser(dir, { email: "a@b.c", role: "admin" });
      const app = await boot(dir, { host: "0.0.0.0" });
      try { assert.equal(app.server.address().address, "0.0.0.0"); }
      finally { app.server.close(); rmSync(dir, { recursive: true, force: true }); }
    });
});
