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
      await openPostgresRead("postgres://nobody@127.0.0.1:1/none");
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
      await openPostgresRead("postgres://nobody:nobody@127.0.0.1:1/none");
    `, brokenLoader);
    assert.equal(ok, false);
    assert.match(stderr, /simulated corrupt install/,
      "the real load failure must survive verbatim");
    assert.doesNotMatch(stderr, /needs the 'pg' package/,
      "a corrupt install must not be reported as a missing package");
  });
});
