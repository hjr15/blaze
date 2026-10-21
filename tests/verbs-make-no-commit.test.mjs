// tests/verbs-make-no-commit.test.mjs — BLZ-687 (BLZ-254 PR D, spec §5.5).
//
// "The board never commits. In fs mode the user versions the files themselves." Every CLI
// verb that used to commit (per-op) or queue (batch) its write is driven here, end to end
// through cli.mjs, against an fs board that IS a git repo — so a commit, a staged path or a
// leftover "(queued for blaze commit)" suffix would all be visible. Each must change the
// working tree, stage nothing, leave HEAD where it was, and print no git vocabulary.
//
// D1 keeps fs mode's single-machine allocator: the last test pins that `blaze new` still
// allocates through the claim ledger (`.ids/<n>`), one number after the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(REPO, "scripts", "cli.mjs");
const git = (root, ...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();

function board(t) {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz687-verbs-")));
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "OBA", projects: ["OBA"] }));
  mkdirSync(join(root, "projects", "OBA", "in-progress"), { recursive: true });
  for (const n of [1, 2]) {
    writeFileSync(join(root, "projects", "OBA", "in-progress", `OBA-${n}.md`),
      `---\nid: OBA-${n}\ntype: task\nproject: OBA\ntitle: OBA-${n}\npriority: medium\nestimate: 30\n---\n\nbody\n`);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  return root;
}

function run(root, args) {
  const env = { ...process.env };
  for (const k of ["BLAZE_WRITE_PORT", "BLAZE_READONLY", "BLAZE_REMOTE_URL", "BLAZE_TOKEN",
                   "BLAZE_PROJECTS_DIR", "BLAZE_COMMIT_MODE", "BLAZE_SESSION"]) delete env[k];
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: "utf8" });
}

const GIT_WORDS = /queued for blaze commit|no commit created|commit failed|commit manually/;

const VERBS = [
  ["new", ["new", "--project", "OBA", "--type", "task", "--estimate", "30", "a new ticket"]],
  ["move", ["move", "OBA-1", "in-review"]],
  ["edit", ["edit", "OBA-1", "priority", "high"]],
  ["link", ["link", "OBA-1", "Relates", "OBA-2"]],
  ["log", ["log", "OBA-1", "30"]],
  ["resolve", ["resolve", "OBA-2", "wont-do"]],
  ["sprint new", ["sprint", "new", "Sprint 1", "--start", "2026-01-01", "--end", "2026-01-14"]],
];

for (const [name, args] of VERBS) {
  test(`blaze ${name} writes, stages nothing, creates no commit, and says nothing about git`, (t) => {
    const root = board(t);
    const before = git(root, "rev-parse", "HEAD");
    const r = run(root, args);
    assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
    assert.notEqual(git(root, "status", "--porcelain", "--untracked-files=all"), "",
      `${name} must change the working tree`);
    assert.equal(git(root, "diff", "--cached", "--name-only"), "", `${name} must stage nothing`);
    assert.equal(git(root, "rev-parse", "HEAD"), before, `${name} must not commit`);
    assert.doesNotMatch(r.stdout + r.stderr, GIT_WORDS, `${name} printed git vocabulary`);
  });
}

test("fs-mode blaze new still allocates through the claim ledger (D1)", (t) => {
  const root = board(t);
  const a = run(root, ["new", "--project", "OBA", "--type", "task", "--estimate", "30", "first"]);
  const b = run(root, ["new", "--project", "OBA", "--type", "task", "--estimate", "30", "second"]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.match(a.stdout, /^created OBA-3 → /m);
  assert.match(b.stdout, /^created OBA-4 → /m, "the second create must take the next number");
  for (const n of [3, 4]) {
    assert.ok(existsSync(join(root, "projects", "OBA", ".ids", String(n))), `the claim .ids/${n} must be written`);
  }
});
