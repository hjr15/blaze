// tests/new-runner.test.mjs — CLI spawn tests for `blaze new`'s flag parsing.
// Runner spawn-test isolation is mandatory: a spawned new-runner.mjs with no
// BLAZE_PROJECTS_DIR writes into the REAL worktree and makes a REAL git
// commit. dataRepo()/run() below git-init a throwaway data tree with
// commitMode: "batch" (no commits) and point the runner at it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../scripts/new-runner.mjs", import.meta.url));

// throwaway DATA repo: git + blaze.config.json (batch mode → no commits) + projects/<KEY>
function dataRepo({ key = "OBA", project = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "blaze-data-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key, projects: [key], commitMode: "batch" }));
  mkdirSync(join(root, "projects", key), { recursive: true });
  if (project) writeFileSync(join(root, "projects", key, "project.json"), JSON.stringify(project));
  return root;
}
const run = (root, args) => spawnSync(process.execPath, [runner, ...args],
  { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });

test("blaze new --components a,b writes components at create", () => {
  const root = dataRepo();
  const r = run(root, ["--project", "OBA", "--type", "task", "--estimate", "30",
                       "--components", "auth, gateway", "hello"]);
  assert.equal(r.status, 0, r.stderr);
  const created = readdirSync(join(root, "projects", "OBA", "defined"));
  assert.equal(created.length, 1);
  const txt = readFileSync(join(root, "projects", "OBA", "defined", created[0]), "utf8");
  assert.match(txt, /components: \[auth, gateway\]/);
  rmSync(root, { recursive: true, force: true });
});

test("blaze new prints a soft-require warning but still exits 0", () => {
  const root = dataRepo({ project: { components: ["auth"], requireComponents: true } });
  const r = run(root, ["--project", "OBA", "--type", "task", "--estimate", "30", "no-comp"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /warning:.*component/);
  rmSync(root, { recursive: true, force: true });
});

test("blaze new --reason suppresses the soft-require warning", () => {
  const root = dataRepo({ project: { components: ["auth"], requireComponents: true } });
  const r = run(root, ["--project", "OBA", "--type", "task", "--estimate", "30",
                       "--reason", "cross-cutting epic", "no-comp"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /warning:.*component/);
  rmSync(root, { recursive: true, force: true });
});
