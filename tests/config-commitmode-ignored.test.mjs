// tests/config-commitmode-ignored.test.mjs — BLZ-687 (BLZ-254 PR D), operator ruling 2026-10-18.
//
// `commitMode` chose how the board committed; the board no longer commits. A config that still
// carries it (the deployed ConfigMap, blaze-pm's own config, any older board) must keep LOADING —
// a refusal there crash-loops the pod — so the key is ignored with one warning per command (a process and its children).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = pathToFileURL(join(REPO, "scripts", "config.mjs")).href;
const serve = pathToFileURL(join(REPO, "scripts", "serve.mjs")).href;
const WARNING = "blaze: warning: commitMode is ignored since 0.9.0 — the board never commits; remove it";

function board(t, cfg) {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz687-cm-")));
  mkdirSync(join(root, "projects", "OBA", "defined"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "defined", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\n---\n\nbody\n");
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify(cfg));
  return root;
}
// A fresh process per case, with the "already warned" mark cleared, so the once-only rule is observable.
function node(src, env = {}) {
  const e = { ...process.env, ...env };
  for (const k of ["BLAZE_WRITE_PORT", "BLAZE_READONLY", "BLAZE_REMOTE_URL", "BLAZE_TOKEN"]) delete e[k];
  if (!("BLAZE_COMMIT_MODE" in env)) delete e.BLAZE_COMMIT_MODE;
  delete e.BLAZE_COMMIT_MODE_WARNED;   // each case starts unwarned
  return spawnSync(process.execPath, ["--input-type=module", "-e", src], { env: e, encoding: "utf8" });
}
const count = (s) => s.split(WARNING).length - 1;

for (const value of ["batch", "per-op", null]) {
  test(`commitMode: ${JSON.stringify(value)} loads, is ignored, and warns exactly once`, (t) => {
    const root = board(t, { key: "OBA", projects: ["OBA"], commitMode: value });
    const r = node(`import { loadConfig } from ${JSON.stringify(config)};
      const a = loadConfig({ root: ${JSON.stringify(root)}, env: {} });
      const b = loadConfig({ root: ${JSON.stringify(root)}, env: {} });
      console.log(JSON.stringify([Object.hasOwn(a, "commitMode"), Object.hasOwn(b, "commitMode"), a.key]));`);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [false, false, "OBA"]);
    assert.equal(count(r.stderr), 1, `expected the warning exactly once, stderr was ${JSON.stringify(r.stderr)}`);
  });
}

test("BLAZE_COMMIT_MODE is ignored with the same single warning", (t) => {
  const root = board(t, { key: "OBA", projects: ["OBA"] });
  const r = node(`import { loadConfig } from ${JSON.stringify(config)};
    const c = loadConfig({ root: ${JSON.stringify(root)}, env: { BLAZE_COMMIT_MODE: "batch" } });
    console.log(Object.hasOwn(c, "commitMode"));`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "false");
  assert.equal(count(r.stderr), 1);
});

test("a board without commitMode loads silently", (t) => {
  const root = board(t, { key: "OBA", projects: ["OBA"] });
  const r = node(`import { loadConfig } from ${JSON.stringify(config)};
    loadConfig({ root: ${JSON.stringify(root)}, env: {} });`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(r.stderr), 0);
});

test("a blaze verb through cli.mjs warns ONCE — the preflight and the spawned runner share one warning", (t) => {
  const root = board(t, { key: "OBA", projects: ["OBA"], commitMode: "batch" });
  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") };
  for (const k of ["BLAZE_WRITE_PORT", "BLAZE_READONLY", "BLAZE_REMOTE_URL", "BLAZE_TOKEN", "BLAZE_COMMIT_MODE",
                   "BLAZE_COMMIT_MODE_WARNED"]) delete env[k];
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "cli.mjs"), "rollup"], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(r.stderr), 1, `one command, one warning — stderr was ${JSON.stringify(r.stderr)}`);
});

test("the board server STARTS and serves on a config that still says commitMode: batch (no crash-loop)", (t) => {
  const root = board(t, { key: "OBA", projects: ["OBA"], commitMode: "batch" });
  const r = node(`import { startServer } from ${JSON.stringify(serve)};
    const s = startServer({ projectsDir: ${JSON.stringify(join(root, "projects"))}, root: ${JSON.stringify(root)}, port: 0 });
    s.once("listening", async () => {
      const res = await fetch("http://127.0.0.1:" + s.address().port + "/");
      console.log(res.status);
      s.close(); process.exit(0);
    });`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "200", `the board must serve, got ${r.stdout} / ${r.stderr}`);
  assert.equal(count(r.stderr), 1, "and say once that the key is ignored");
});
