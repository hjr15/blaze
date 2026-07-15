// tests/link-runner.test.mjs — CLI spawn tests for `blaze link`.
// Runner spawn-test isolation is mandatory: a spawned link-runner.mjs with no
// BLAZE_PROJECTS_DIR writes into the REAL worktree and makes a REAL git
// commit. dataRepo()/run() below git-init a throwaway data tree with
// commitMode: "batch" (no commits) and point the runner at it, seeded with
// OBA-1 + OBA-2 so the link's source + target both resolve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../scripts/link-runner.mjs", import.meta.url));

// throwaway DATA repo: git + blaze.config.json (batch mode → no commits) +
// projects/OBA/defined/{OBA-1,OBA-2}.md
function dataRepo({ key = "OBA" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "blaze-link-data-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key, projects: [key], commitMode: "batch" }));
  const dir = join(root, "projects", key, "defined");
  mkdirSync(dir, { recursive: true });
  const tk = (id) => `---\nid: ${id}\ntype: task\nproject: ${key}\ntitle: ${id}\npriority: medium\nestimate: 30\n---\n\nbody\n`;
  writeFileSync(join(dir, `${key}-1.md`), tk(`${key}-1`));
  writeFileSync(join(dir, `${key}-2.md`), tk(`${key}-2`));
  return root;
}
const run = (root, args) => spawnSync(process.execPath, [runner, ...args],
  { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });

test("blaze link adds a typed link and exits 0", () => {
  const root = dataRepo();
  const r = run(root, ["OBA-1", "Blocks", "OBA-2"]);
  assert.equal(r.status, 0, r.stderr);
  const txt = readFileSync(join(root, "projects", "OBA", "defined", "OBA-1.md"), "utf8");
  assert.match(txt, /type: Blocks, target: OBA-2/);
  rmSync(root, { recursive: true, force: true });
});

test("blaze link rejects an unknown type (exit 1)", () => {
  const root = dataRepo();
  const r = run(root, ["OBA-1", "Bogus", "OBA-2"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown link type/i);
  rmSync(root, { recursive: true, force: true });
});
