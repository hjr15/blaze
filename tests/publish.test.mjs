// tests/publish.test.mjs — BLZ-135, the sanctioned publish verb.
//
// The point of this command is that the EASY path becomes the CORRECT one: the
// alternative it replaces is a raw `kubectl create job --from=cronjob/...`
// incantation, and the alternative sessions actually reach for when that feels
// heavy is `git push`, which breaks the sole-merger invariant this board runs on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { appendEntry } from "../scripts/pending-ledger.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// A board with a real copy of scripts/, so the copied runner resolves its
// script-relative ROOT to the temp repo rather than the worktree.
function boardRepo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-pub-"));
  execFileSync("cp", ["-r", join(REPO, "scripts"), join(root, "scripts")]);
  mkdirSync(join(root, "projects", "PROJ", "defined"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "seed"), "s");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "seed"]);
  return root;
}

function runPublish(cwd, root, extraEnv = {}) {
  return spawnSync(process.execPath, [join(root, "scripts", "publish-runner.mjs"), "--dry-run"], {
    cwd, encoding: "utf8",
    env: { ...process.env, BLAZE_SESSION: "pubtest", ...extraEnv },
  });
}

// Uses the REPO's own script, not a copy inside a board: that is the real shape
// of the failure — a globally-installed `blaze` invoked from some random
// directory. (A copy living inside a board correctly resolves THAT board, which
// is the legitimate single-tree path, so it cannot exercise the refusal.)
test("BLZ-135: publish refuses to run outside a board data root", () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "blaze-notaboard-"));
  const env = { ...process.env, BLAZE_SESSION: "pubtest" };
  delete env.BLAZE_PROJECTS_DIR;
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "publish-runner.mjs"), "--dry-run"], {
    cwd: elsewhere, encoding: "utf8", env,
  });
  assert.notEqual(r.status, 0, "must refuse outside a board");
  assert.match(r.stderr, /blaze publish:/);
  assert.match(r.stderr, /no data dir found|does not exist/);
  rmSync(elsewhere, { recursive: true, force: true });
});

// The whole reason this subsumes mounting .blaze into the flush pod: queues are
// HOST state, so the host has to drain them. A publish that triggers the flush
// without sweeping would leave exactly the ops that stranded before.
test("BLZ-135: publish sweeps local pending queues before triggering the flush", () => {
  const root = boardRepo();
  const file = "projects/PROJ/defined/PROJ-1-x.md";
  mkdirSync(join(root, "projects", "PROJ", "defined"), { recursive: true });
  writeFileSync(join(root, file), "---\nid: PROJ-1\ntitle: t\ntype: task\nproject: PROJ\npriority: medium\n---\nb\n");
  appendEntry(root, { id: "PROJ-1", op: "new", message: "PROJ-1: create task", files: [file] }, "otherSession");

  const r = runPublish(root, root);
  assert.equal(r.status, 0, `expected success, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /flushed 1 op/, "the stranded queue must be swept");

  const log = execFileSync("git", ["-C", root, "log", "--oneline"], { encoding: "utf8" });
  assert.match(log, /board update/, "the swept op must land as a commit");
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-135: --dry-run reports the trigger it would run without running it", () => {
  const root = boardRepo();
  const r = runPublish(root, root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /kubectl/, "dry-run must show the trigger command");
  assert.match(r.stdout, /dry-run/i);
  rmSync(root, { recursive: true, force: true });
});

// INF-800: `blaze publish` built its kubectl invocation with no --context, so it
// targeted whatever context happened to be current. Observed live: the ambient
// context was k3d-online-broker-agent while the blaze namespace lives on
// k3d-service-platform, so the trigger died with `namespaces "blaze" not found`
// — a message that names the namespace and never the context, pointing the
// reader at the wrong thing entirely.
test("INF-800: the trigger targets BLAZE_FLUSH_CONTEXT explicitly when set", () => {
  const root = boardRepo();
  const r = runPublish(root, root, { BLAZE_FLUSH_CONTEXT: "k3d-service-platform" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /--context k3d-service-platform/,
    "the flush cluster must be named explicitly, not inherited from the ambient kubectl context",
  );
  rmSync(root, { recursive: true, force: true });
});

test("INF-800: with no context configured, publish says which context it will use", () => {
  const root = boardRepo();
  const env = { ...process.env, BLAZE_SESSION: "pubtest" };
  delete env.BLAZE_FLUSH_CONTEXT;
  const r = spawnSync(process.execPath, [join(root, "scripts", "publish-runner.mjs"), "--dry-run"], {
    cwd: root, encoding: "utf8", env,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /ambient kubectl context/i,
    "an unconfigured publish must SAY it is falling back to the ambient context, so a wrong-cluster failure is self-diagnosing",
  );
  rmSync(root, { recursive: true, force: true });
});
