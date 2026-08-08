import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// BLZ-133 regression: `scripts/serve.mjs`'s standalone entry block referenced
// `root`, which is a destructured PARAMETER of startServer() and not in scope at
// module level. The server bound its port and then threw
// `ReferenceError: root is not defined` from the "listening" handler, so the
// container crash-looped on startup.
//
// Every other serve test IMPORTS startServer, so none of them execute the
// `process.argv[1] === fileURLToPath(import.meta.url)` branch — which is exactly
// why this reached a release. This test spawns the script as a real process,
// the only way to cover that branch.
const SERVE = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "serve.mjs");

const BOARD = (() => {
  const d = mkdtempSync(join(tmpdir(), "blaze-serve-standalone-"));
  mkdirSync(join(d, "projects"), { recursive: true });
  return d;
})();

test("`node scripts/serve.mjs` starts and announces the board without throwing", async () => {
  const child = spawn(process.execPath, [SERVE], {
    cwd: BOARD,
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", BLAZE_PROJECTS_DIR: join(BOARD, "projects") },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b) => { stdout += b; });
  child.stderr.on("data", (b) => { stderr += b; });

  const outcome = await new Promise((resolve) => {
    const done = setTimeout(() => resolve("still-running"), 5000);
    child.on("exit", (code) => { clearTimeout(done); resolve(`exited:${code}`); });
    const poll = setInterval(() => {
      if (/board → http:\/\//.test(stdout)) { clearInterval(poll); clearTimeout(done); resolve("announced"); }
    }, 50);
    child.on("exit", () => clearInterval(poll));
  });

  child.kill("SIGTERM");

  assert.doesNotMatch(stderr, /ReferenceError/, `serve.mjs threw a ReferenceError on startup:\n${stderr}`);
  assert.equal(outcome, "announced", `expected the board banner on stdout; got ${outcome}\nstdout: ${stdout}\nstderr: ${stderr}`);
});
