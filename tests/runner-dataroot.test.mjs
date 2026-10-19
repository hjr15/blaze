// tests/runner-dataroot.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const head = (root) => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

// A throwaway ENGINE copy (scripts/ + git seed). The tests run THIS engine,
// never the real repo's, so a failing (pre-rewire) run pollutes only a temp
// dir — a red run of new-runner writes to its engine tree, and that tree must
// be disposable. (Real-tree pollution burned us before; see the board's
// batch-mode ledger.)
function engineCopy() {
  const eng = mkdtempSync(join(tmpdir(), "blaze-engine-"));
  cpSync(join(REPO, "scripts"), join(eng, "scripts"), { recursive: true });
  execFileSync("git", ["-C", eng, "init", "-q"]);
  execFileSync("git", ["-C", eng, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", eng, "config", "user.name", "t"]);
  execFileSync("git", ["-C", eng, "add", "-A"]);
  execFileSync("git", ["-C", eng, "commit", "-q", "-m", "seed"]);
  return eng;
}

// A pure DATA repo: git + blaze.config.json + projects/, NO scripts/ copy —
// the engine runs from the engineCopy, the data lives here. This is the split.
function dataRepo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-dataroot-data-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "ZZZ", projects: ["ZZZ"] }));
  mkdirSync(join(root, "projects", "ZZZ", "in-progress"), { recursive: true });
  writeFileSync(join(root, "projects", "ZZZ", "in-progress", "ZZZ-1.md"),
    "---\nid: ZZZ-1\ntype: task\nstatus: in-progress\nestimate: 60\n---\n\nbody\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

test("engine in one tree drives a data repo in another via BLAZE_PROJECTS_DIR", () => {
  const eng = engineCopy();
  const data = dataRepo();
  const engineHead = head(eng);
  execFileSync(process.execPath, [join(eng, "scripts", "new-runner.mjs"),
    "--project", "ZZZ", "--type", "task", "--estimate", "30", "dataroot proof"],
    { cwd: eng, env: { ...process.env, BLAZE_PROJECTS_DIR: join(data, "projects") } });
  // Ticket landed in the DATA tree (id counter saw ZZZ-1, so this is ZZZ-2)…
  const created = readdirSync(join(data, "projects", "ZZZ", "defined"));
  assert.equal(created.length, 1);
  assert.match(created[0], /^ZZZ-2-dataroot-proof/);
  // …the DATA repo holds it uncommitted — BLZ-254: the board never commits…
  assert.match(execFileSync("git", ["-C", data, "status", "--porcelain", "--untracked-files=all"],
    { encoding: "utf8" }), /ZZZ-2-dataroot-proof/);
  // …and the ENGINE tree did not move (a pre-rewire engine writes here — the
  // whole point of running a disposable copy).
  assert.equal(head(eng), engineHead, "engine tree must be untouched");
  rmSync(data, { recursive: true, force: true });
  rmSync(eng, { recursive: true, force: true });
});

test("cwd inside a data repo works with no env (ladder rung 2)", () => {
  const eng = engineCopy();
  const data = dataRepo();
  const before = head(data);
  execFileSync(process.execPath, [join(eng, "scripts", "log-runner.mjs"), "ZZZ-1", "30"],
    { cwd: data, env: { ...process.env, BLAZE_PROJECTS_DIR: "" } });
  assert.match(readFileSync(join(data, "projects", "ZZZ", "in-progress", "ZZZ-1.md"), "utf8"), /minutes: 30/);
  assert.equal(head(data), before, "BLZ-254: the log is written, not committed");
  rmSync(data, { recursive: true, force: true });
  rmSync(eng, { recursive: true, force: true });
});
