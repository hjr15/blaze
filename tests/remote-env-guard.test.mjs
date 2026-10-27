// tests/remote-env-guard.test.mjs — BLZ-684 (adversarial review round 1, M2).
//
// An operator's exported BLAZE_REMOTE_URL + BLAZE_TOKEN must never reach a test, or a process a
// test spawns: with them, an ordinary CLI test would write to the live board with the
// operator's token. This file proves the preload strips them — in a process started exactly as
// `npm test` starts one, and in a `blaze` that process spawns — against a server that records
// every request it receives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

test("this test process itself has none of the three variables, whatever the shell exported", () => {
  assert.equal(process.env.BLAZE_REMOTE_URL, undefined);
  assert.equal(process.env.BLAZE_TOKEN, undefined);
  // BLZ-710 (review M11): an operator's exported token FILE must never reach a test either.
  assert.equal(process.env.BLAZE_TOKEN_FILE, undefined);
});

test("an exported pair does not leak: a preloaded process, and the `blaze` it spawns, stay local", async () => {
  const seen = [];
  const server = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(500); res.end(); });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const cwd = scratch(mkdtempSync(join(tmpdir(), "blz684-guard-")));
  // BLZ-710: the operator's token file, exported beside the pair. Left in place, it alone
  // would put the spawned `blaze` into remote mode's half-set refusal (or, with the URL, remote).
  const tokenFile = join(cwd, "operator-token");
  writeFileSync(tokenFile, "blz_operator_token\n", { mode: 0o600 });
  try {
    // A child started the way `npm test` starts every test file (`--import` the preload), with
    // the pair exported, which then runs `blaze new` the way a CLI test does.
    const script = `
      import { spawnSync } from "node:child_process";
      const r = spawnSync(process.execPath, [${JSON.stringify(join(REPO, "scripts", "cli.mjs"))},
        "new", "--project", "ENG", "--type", "task", "--estimate", "30", "leak"], { encoding: "utf8" });
      console.log(JSON.stringify({ url: process.env.BLAZE_REMOTE_URL ?? null,
                                   token: process.env.BLAZE_TOKEN ?? null,
                                   tokenFile: process.env.BLAZE_TOKEN_FILE ?? null, stderr: r.stderr }));`;
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [`--import=${join(REPO, "tests", "setup", "hang-watchdog.mjs")}`,
                                         "--input-type=module", "-e", script],
        { cwd, env: { ...process.env, BLAZE_REMOTE_URL: `http://127.0.0.1:${server.address().port}`,
                      BLAZE_TOKEN: "blz_operator_token", BLAZE_TOKEN_FILE: tokenFile } });
      let stdout = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.on("close", () => resolve(stdout));
    });
    const r = JSON.parse(out);
    assert.deepEqual([r.url, r.token, r.tokenFile], [null, null, null], "the preload removed all three");
    assert.doesNotMatch(r.stderr, /remote mode|answered \d{3}|no answer from/, "the spawned blaze ran locally (and found no board here)");
    assert.deepEqual(seen, [], "the recording server received nothing");
  } finally { server.close(); }
});
