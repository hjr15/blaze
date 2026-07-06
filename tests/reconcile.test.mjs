import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { decide, reconcile } from "../scripts/reconcile.mjs";

test("merged PR → done and sets resolution via the post-function", () => {
  const d = decide({ pr: { state: "MERGED", number: 5, url: "u", headRefName: "you/OBA-5-x" } }, "in-review", "task");
  assert.equal(d.target, "done");
  assert.equal(d.moved, true);
  assert.equal(d.prVal, "#5 — u");
  assert.equal(d.branchVal, "you/OBA-5-x");
  assert.equal(d.resolution, "done");
});

test("open PR → in-review (no resolution)", () => {
  const d = decide({ pr: { state: "OPEN", number: 6, url: "u", headRefName: "b" } }, "defined", "task");
  assert.equal(d.target, "in-review");
  assert.equal(d.moved, true);
  assert.equal(d.resolution, undefined);
});

test("closed unmerged PR → in-progress", () => {
  const d = decide({ pr: { state: "CLOSED", number: 7, url: "u", headRefName: "b" } }, "in-review", "task");
  assert.equal(d.target, "in-progress");
});

test("branch with no PR → in-progress", () => {
  const d = decide({ branch: "you/OBA-8-y" }, "defined", "task");
  assert.equal(d.target, "in-progress");
  assert.equal(d.branchVal, "you/OBA-8-y");
  assert.equal(d.prVal, null);
});

test("no git signal is skipped and left in place", () => {
  const d = decide({}, "defined", "task");
  assert.equal(d.skip, true);
  assert.equal(d.moved, false);
  assert.equal(d.target, "defined");
});

test("terminal status is sticky — a merged PR on a done ticket does not move it", () => {
  const d = decide({ pr: { state: "MERGED", number: 9, url: "u", headRefName: "b" } }, "done", "task");
  assert.equal(d.target, "done");
  assert.equal(d.moved, false);
});

test("non-delivery types (goal/risk) are never auto-transitioned", () => {
  assert.equal(decide({ pr: { state: "MERGED", number: 1, url: "u", headRefName: "b" } }, "defined", "goal").skip, true);
  assert.equal(decide({ branch: "b" }, "identified", "risk").skip, true);
});

// --- reconcile() must honour a custom-named projectsDir, not just dataRoot ----
// (Review fix.) BLAZE_PROJECTS_DIR is documented (tests/roots.test.mjs)
// to allow a projects dir that isn't literally named "projects". reconcile()'s
// no-args default previously recomputed join(root, "projects") itself instead
// of reusing resolveRoots().projectsDir, so a custom-named dir silently found
// zero tickets. This is a throwaway git fixture (per tests/runner-dataroot.test.mjs's
// isolation pattern) — dryRun so no git/network side effects land anywhere real.
function gitInit(dir) {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
}

test("reconcile() with no explicit root resolves a custom-named projectsDir via BLAZE_PROJECTS_DIR", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "blaze-reconcile-dataroot-"));
  const codeRepo = mkdtempSync(join(tmpdir(), "blaze-reconcile-codereo-"));
  const prevEnv = process.env.BLAZE_PROJECTS_DIR;

  gitInit(codeRepo);
  writeFileSync(join(codeRepo, "README.md"), "x\n");
  execFileSync("git", ["-C", codeRepo, "add", "-A"]);
  execFileSync("git", ["-C", codeRepo, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", codeRepo, "checkout", "-q", "-b", "you/ZZZ-1-fix-thing"]);

  // "tickets" — deliberately NOT named "projects".
  const ticketsDir = join(dataRoot, "tickets");
  mkdirSync(join(ticketsDir, "ZZZ", "defined"), { recursive: true });
  writeFileSync(
    join(ticketsDir, "ZZZ", "defined", "ZZZ-1-fix-thing.md"),
    "---\nid: ZZZ-1\ntype: task\nstatus: defined\nproject: ZZZ\nestimate: 30\n---\n\nbody\n",
  );
  writeFileSync(
    join(dataRoot, "blaze.config.json"),
    JSON.stringify({ key: "ZZZ", projects: ["ZZZ"], codeRepos: [codeRepo] }),
  );

  try {
    process.env.BLAZE_PROJECTS_DIR = ticketsDir;
    const r = reconcile();
    assert.equal(r.ok, true);
    assert.equal(r.changes.length, 1, "reconcile must find the ticket under the custom-named projects dir");
    assert.equal(r.changes[0].id, "ZZZ-1");
    assert.equal(r.changes[0].to, "in-progress");
  } finally {
    if (prevEnv === undefined) delete process.env.BLAZE_PROJECTS_DIR;
    else process.env.BLAZE_PROJECTS_DIR = prevEnv;
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(codeRepo, { recursive: true, force: true });
  }
});
