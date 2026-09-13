// tests/model/pg-absent.test.mjs — BLZ-282.
//
// `pg` is an OPTIONAL peer dependency, so "not installed" is the DEFAULT state for
// everyone who has not opted into Postgres. The failure they meet must therefore be a
// setup instruction, not an ERR_MODULE_NOT_FOUND trace from inside a dynamic import.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const loader = pathToFileURL(join(repo, "tests", "fixtures", "no-pg-loader.mjs")).href;
const brokenLoader = pathToFileURL(join(repo, "tests", "fixtures", "broken-pg-loader.mjs")).href;

// Run in a child process: the hook has to be registered before the module graph loads,
// and it must not leak into the rest of this suite (which needs a REAL pg).
function runWithLoader(script, hook = loader) {
  try {
    execFileSync(process.execPath, ["--import", `data:text/javascript,
      import { register } from "node:module";
      register(${JSON.stringify(hook)});
    `, "--input-type=module", "-e", script], { cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { ok: true, stderr: "" };
  } catch (e) {
    return { ok: false, stderr: String(e.stderr ?? "") };
  }
}

describe("pg absent — the optional peer dependency is not installed", () => {
  test("explains how to install pg instead of leaking ERR_MODULE_NOT_FOUND", () => {
    const { ok, stderr } = runWithLoader(`
      const { openPostgresRead } = await import("./scripts/model/pg-storage.mjs");
      await openPostgresRead("postgres://nobody@127.0.0.1:1/none", { create: true });
    `);
    assert.equal(ok, false, "opening a Postgres board without pg must fail");
    assert.match(stderr, /needs the 'pg' package/, "must name the missing package");
    assert.match(stderr, /npm install pg/, "must give the exact install command");
    assert.match(stderr, /filesystem and SQLite drivers work without/,
      "must say the other drivers are unaffected");
  });

  test("importing the module is still safe without pg — only opening fails", () => {
    const { ok } = runWithLoader(`
      await import("./scripts/model/pg-storage.mjs");
    `);
    assert.equal(ok, true, "the module must import cleanly; pg is loaded lazily");
  });

  test("a non-resolution failure is re-thrown untouched, not relabelled as missing pg", () => {
    // pg RESOLVES here but explodes while loading. That is a corrupt install, not an
    // absent one. If the guard caught every import failure it would tell the user to
    // run `npm install pg` — which they already did, and which will not fix this.
    const { ok, stderr } = runWithLoader(`
      const { openPostgresRead } = await import("./scripts/model/pg-storage.mjs");
      await openPostgresRead("postgres://nobody:nobody@127.0.0.1:1/none", { create: true });
    `, brokenLoader);
    assert.equal(ok, false);
    assert.match(stderr, /simulated corrupt install/,
      "the real load failure must survive verbatim");
    assert.doesNotMatch(stderr, /needs the 'pg' package/,
      "a corrupt install must not be reported as a missing package");
  });
});

// ── BLZ-534: THE SETUP WINDOW, ONE FRAME DEEPER ────────────────────────────────────────
// `openPostgresRead` connects and THEN runs `checkDbSchema` and, on an empty database,
// `createDbSchema`. Its two explicit refusals called `client.end()`; a THROW from either of
// those calls did not, and both can throw for ordinary reasons — a connection dropped
// mid-query, a permissions error, DDL that collides. What was left behind is a live
// referenced TCP handle, and a Node process holding one of those cannot exit: BLZ-534's
// hang, the same shape as the conformance suite's `seedPg` one frame up.
//
// Asserted here rather than through `openPostgresRead`, which cannot reach that window
// without a real server — this file's whole point is that `pg` may not even be installed.
describe("BLZ-534: a setup failure after connecting closes the connection", () => {
  const fakeClient = () => { const c = { ended: 0 }; c.end = async () => { c.ended++; }; return c; };

  test("a throw from setup closes the client and still surfaces the original failure", async () => {
    const { closeOnSetupFailure } = await import("../../scripts/model/pg-storage.mjs");
    const client = fakeClient();
    await assert.rejects(
      () => closeOnSetupFailure(client, async () => { throw new Error("schema check exploded"); }),
      /schema check exploded/,
      "closing must not swallow or replace the reason it is closing");
    assert.equal(client.ended, 1,
      "the connection was open when setup threw and nothing closed it — that is a live "
      + "referenced socket, and the process holding it cannot exit");
  });

  test("a setup that succeeds hands back its value and leaves the client OPEN", async () => {
    const { closeOnSetupFailure } = await import("../../scripts/model/pg-storage.mjs");
    const client = fakeClient();
    assert.equal(await closeOnSetupFailure(client, async () => "ready"), "ready");
    assert.equal(client.ended, 0,
      "the caller owns the connection once setup succeeds; closing it here would break "
      + "every ordinary open");
  });

  test("a close that itself fails does not mask the failure that caused it", async () => {
    const { closeOnSetupFailure } = await import("../../scripts/model/pg-storage.mjs");
    const client = { end: async () => { throw new Error("end() failed too"); } };
    await assert.rejects(
      () => closeOnSetupFailure(client, async () => { throw new Error("the real problem"); }),
      /the real problem/,
      "the operator must be told what actually went wrong, not how the cleanup went");
  });
});
