// groomer-scope.test.mjs — the groomer may only edit its target ticket in place.
// Any out-of-scope change (another ticket swept in, a stray new file, or the target
// moved/deleted to another column) must be reverted, not committed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { groomWithinScope, groomOnce } from "../scripts/loops/groomer.mjs";
import { loadConfig } from "../scripts/config.mjs";

// --- groomWithinScope: pure scope check ------------------------------------

const T = "backlog/TASK-001-x.md";

test("groomWithinScope: an in-place edit of the target is in scope", () => {
  assert.equal(
    groomWithinScope({ unstaged: [T], staged: [], untracked: [], targetExists: true }, T),
    true,
  );
});

test("groomWithinScope: a second changed ticket is out of scope", () => {
  assert.equal(
    groomWithinScope({ unstaged: [T, "backlog/TASK-002-y.md"], staged: [], untracked: [], targetExists: true }, T),
    false,
  );
});

test("groomWithinScope: a stray untracked file is out of scope", () => {
  assert.equal(
    groomWithinScope({ unstaged: [T], staged: [], untracked: ["backlog/TASK-999-new.md"], targetExists: true }, T),
    false,
  );
});

test("groomWithinScope: a staged change (e.g. git mv) is out of scope", () => {
  assert.equal(
    groomWithinScope({ unstaged: [], staged: ["done/TASK-001-x.md"], untracked: [], targetExists: false }, T),
    false,
  );
});

test("groomWithinScope: a missing target (moved away) is out of scope", () => {
  assert.equal(
    groomWithinScope({ unstaged: [T], staged: [], untracked: [], targetExists: false }, T),
    false,
  );
});

test("groomWithinScope: a change to the wrong single file is out of scope", () => {
  assert.equal(
    groomWithinScope({ unstaged: ["backlog/TASK-002-y.md"], staged: [], untracked: [], targetExists: true }, T),
    false,
  );
});

// --- groomOnce end-to-end: stub agents that misbehave ----------------------

function gitBoard(stubBody) {
  const dir = mkdtempSync(join(tmpdir(), "blaze-groom-scope-"));
  mkdirSync(join(dir, "backlog"), { recursive: true });
  mkdirSync(join(dir, "done"), { recursive: true });
  const stub = join(dir, "stub-agent.sh");
  writeFileSync(stub, `#!/usr/bin/env bash\nset -e\n${stubBody}\n`);
  chmodSync(stub, 0o755);
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({
    key: "TASK",
    agentCommand: `bash ${stub}`,
    loops: { groomer: { columns: ["backlog"] } },
  }));
  const seed = (id, slug, col = "backlog") =>
    writeFileSync(join(dir, col, `${id}-${slug}.md`),
      `---\nid: ${id}\ntitle: ${slug}\ntype: feature\npriority: medium\nlabels: []\n---\nbody\n`);
  seed("TASK-001", "x");
  seed("TASK-002", "y");
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
  return dir;
}

function gitLog(dir) {
  return execFileSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" });
}

test("groomOnce blocks a groom that also edits a second ticket, reverting both", () => {
  // Stub edits its target AND a second ticket it was told not to touch.
  const dir = gitBoard(
    'sed -i -E "s/^labels: \\[\\]/labels: [backend]/" "$BLAZE_GROOM_TARGET"\n' +
    'sed -i -E "s/^priority: medium/priority: high/" backlog/TASK-002-y.md',
  );
  const cfg = loadConfig({ root: dir, env: {} });
  const evt = groomOnce({ root: dir, cfg, agentsMd: "## Grooming rules\n- add labels\n", today: "2026-07-01" });

  assert.equal(evt.blocked, true, "expected the groom to be blocked");
  assert.doesNotMatch(gitLog(dir), /chore\(groom\)/, "must not create a groom commit");
  // Both files restored to seed content.
  assert.match(readFileSync(join(dir, "backlog", "TASK-001-x.md"), "utf8"), /labels: \[\]/);
  assert.match(readFileSync(join(dir, "backlog", "TASK-002-y.md"), "utf8"), /priority: medium/);
  rmSync(dir, { recursive: true, force: true });
});

test("groomOnce blocks a groom that moves the target to another column, restoring it in place", () => {
  // Stub "moves" the ticket forward: deletes it from backlog, writes it into done/.
  const dir = gitBoard(
    'cp "$BLAZE_GROOM_TARGET" done/TASK-001-x.md\n' +
    'rm "$BLAZE_GROOM_TARGET"',
  );
  const cfg = loadConfig({ root: dir, env: {} });
  const evt = groomOnce({ root: dir, cfg, agentsMd: "## Grooming rules\n", today: "2026-07-01" });

  assert.equal(evt.blocked, true, "expected the groom to be blocked");
  assert.doesNotMatch(gitLog(dir), /chore\(groom\)/, "must not create a groom commit");
  assert.ok(existsSync(join(dir, "backlog", "TASK-001-x.md")), "target must be restored in backlog");
  assert.ok(!existsSync(join(dir, "done", "TASK-001-x.md")), "stray done/ copy must be removed");
  rmSync(dir, { recursive: true, force: true });
});
