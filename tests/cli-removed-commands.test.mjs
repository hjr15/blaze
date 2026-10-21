// tests/cli-removed-commands.test.mjs — BLZ-687 (BLZ-254 PR D, spec §5.5).
//
// `blaze commit` and `blaze publish` are deleted. A removed verb gets a NAMED refusal, not the
// unknown-command fallback (a usage dump on stdout and exit 1 with no sentence): its callers
// — the nightly flush Job until C2 deletes it, and every agent whose instructions still say
// "run blaze commit" — must learn what changed and what to do, not that they mistyped.
// The refusal fires before --help, before the read-only gate and before remote mode, so
// every spelling gets the same sentence, and nothing on disk moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(REPO, "scripts", "cli.mjs");

function board(t) {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz687-removed-")));
  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"]]) {
    execFileSync("git", ["-C", root, ...a]);
  }
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "OBA", projects: ["OBA"] }));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

// I8: the red run (Step 2) executed the REAL publish-runner (since deleted by BLZ-254), which shelled out to
// `kubectl create job --from=cronjob/blaze-flush` against the ambient context. It must never reach
// a cluster: no kubeconfig, an unknown context, and a `kubectl` on PATH that refuses.
const NOKUBE = scratch(mkdtempSync(join(tmpdir(), "blz687-nokube-")));
writeFileSync(join(NOKUBE, "kubectl"), '#!/bin/sh\necho "kubectl disabled for BLZ-687" >&2\nexit 1\n');
chmodSync(join(NOKUBE, "kubectl"), 0o755);

function run(root, args, extraEnv = {}) {
  const env = { ...process.env };
  for (const k of ["BLAZE_WRITE_PORT", "BLAZE_READONLY", "BLAZE_REMOTE_URL", "BLAZE_TOKEN", "BLAZE_PROJECTS_DIR"]) delete env[k];
  Object.assign(env, { KUBECONFIG: "/dev/null", BLAZE_FLUSH_CONTEXT: "blz687-no-such-context",
    PATH: `${NOKUBE}:${process.env.PATH}` });
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8" });
}

const SPELLINGS = [
  ["commit", [], {}], ["commit", ["--all"], {}], ["commit", ["--status"], {}], ["commit", ["--help"], {}],
  ["commit", [], { BLAZE_READONLY: "1" }],
  ["commit", [], { BLAZE_REMOTE_URL: "http://127.0.0.1:9", BLAZE_TOKEN: "t" }],
  ["publish", [], {}], ["publish", ["--help"], {}], ["publish", [], { BLAZE_READONLY: "1" }],
  ["publish", [], { BLAZE_REMOTE_URL: "http://127.0.0.1:9", BLAZE_TOKEN: "t" }],
];

for (const [cmd, args, env] of SPELLINGS) {
  test(`blaze ${[cmd, ...args].join(" ")} ${Object.keys(env).join("+") || ""} is refused by name`, (t) => {
    const root = board(t);
    const head = () => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const before = head();
    const r = run(root, [cmd, ...args], env);
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`^blaze: \`${cmd}\` was removed in 0\\.9\\.0 \\(BLZ-254\\)`, "m"));
    assert.match(r.stderr, /BLAZE_WRITE_PORT=db/, "the refusal names the replacement for concurrent writers");
    assert.doesNotMatch(r.stdout, /usage: blaze/, "a removed verb is not the unknown-command fallback");
    assert.equal(head(), before, "nothing moved");
  });
}

test("the usage listing no longer offers commit or publish", () => {
  const r = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /^\s+(commit|publish)\s/m);
});
