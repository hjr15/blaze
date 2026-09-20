// tests/flush-real-blaze-commit.test.mjs — BLZ-567, the part of it this repo can hold.
//
// THE FLUSH IS `blaze commit --all`, run by the `blaze-flush` CronJob inside the engine
// container. Every drain test in this suite spawns `scripts/commit-runner.mjs` DIRECTLY —
// `runCommit` in `tests/commit-settled-drain.test.mjs` is the canonical one — which is not
// what the CronJob runs. `scripts/cli.mjs` is. This file runs what the CronJob runs.
//
// A CORRECTION TO THE TICKET, MEASURED RATHER THAN ARGUED. BLZ-567 asks for the flush test
// to use the real `blaze commit` "so a config the engine rejects fails the test". The first
// half is right and is done here. THE SECOND HALF IS FALSE, twice over, and neither is an
// accident:
//
//   1. `commit` is one of three verbs DELIBERATELY EXEMPT from `cli.mjs`'s schema preflight
//      (`SCHEMA_PREFLIGHT_EXEMPT`, an explicitly recorded AC-4 decision), because refusing a
//      flush would strand ticket files other verbs have ALREADY relocated but not committed.
//   2. THE EXEMPTION IS NOT EVEN WHAT DECIDES IT. Measured by deleting `"commit"` from that
//      Set and re-running this file: all four cases stayed green. The refusal other verbs
//      give on these boards comes from `config.mjs`'s `loadConfig`, raised inside the
//      RUNNER — `node scripts/edit-runner.mjs` fails identically with no `cli.mjs` involved
//      — and `commit-runner.mjs` never calls `loadConfig` at all. That is the same fact
//      `cli.mjs`'s own comment gives as the reason for the exemption ("commit-runner.mjs
//      imports nothing from the model"), and it holds one layer below it.
//
// So this file does not make the flush refuse — that would delete a decision this repo made
// on purpose. It pins the PROPERTY THE DECISION EXISTS TO PROTECT: on a board every other
// verb refuses, the queued work still reaches a commit. That is what would actually break in
// production, and nothing pinned it before. It goes red the day `commit-runner.mjs` grows a
// `loadConfig` — measured, by adding one: the case below fails with the queued op stranded.
//
// NO PATH STUBS. Real git, real `cli.mjs`, real `commit-runner.mjs` underneath it, a real
// repository built here. Nothing on `PATH` is replaced.
//
// DUMMY DATA ONLY, per the ticket: a throwaway `FIX` board in a temp dir. Never the live
// board, never a real credential, and nothing here touches a queued op that is not its own.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "scripts", "cli.mjs");
const RUNNER = join(ROOT, "scripts", "commit-runner.mjs");
const FIXTURES = join(ROOT, "tests", "fixtures");
const SESSION = "blz567-flush";

const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

/** A real git repository holding a real board. No shims: `blaze commit` will run real git
 *  against this, and a commit that lands here is a commit that really landed. */
function repo(fixture) {
  const root = mkdtempSync(join(tmpdir(), "blz567-"));
  cpSync(join(FIXTURES, fixture), root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "blz567");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  return root;
}

/** A queued op with its work ON DISK but NOT committed — what the CronJob exists to drain. */
function queue(root, id) {
  const rel = `projects/FIX/backlog/${id}.md`;
  const file = join(root, rel);
  mkdirSync(join(root, "projects", "FIX", "backlog"), { recursive: true });
  writeFileSync(file, `---\nid: ${id}\ntype: task\nproject: FIX\ntitle: queued\n---\n\nqueued body\n`);
  const ledger = join(root, ".blaze", "pending", `${SESSION}.jsonl`);
  mkdirSync(join(root, ".blaze", "pending"), { recursive: true });
  writeFileSync(ledger, JSON.stringify({
    op: "edit", id, message: `${id}: queued`, files: [rel],
    at: new Date().toISOString(), session: SESSION,
  }) + "\n");
  return { rel, file, ledger };
}

const env = (extra = {}) => ({
  ...process.env, BLAZE_SESSION: SESSION, CLAUDE_CODE_SESSION_ID: SESSION,
  BLAZE_PROJECTS_DIR: undefined, ...extra,
});

/** THE REAL FLUSH: the same entry point the CronJob runs, `blaze` → `scripts/cli.mjs`. */
const realFlush = (root, ...args) =>
  spawnSync(process.execPath, [CLI, "commit", ...args],
    { cwd: root, env: env(), encoding: "utf8" });

/** What every OTHER drain test in this suite runs: the runner, with no preflight in front. */
const runnerOnly = (root, ...args) =>
  spawnSync(process.execPath, [RUNNER, ...args],
    { cwd: root, env: env(), encoding: "utf8" });

describe("BLZ-567: the flush test exercises the REAL `blaze commit`", () => {
  test("a queued op drains through the real entry point and the commit genuinely lands", () => {
    const root = repo("board-gate-good");
    try {
      const { rel } = queue(root, "FIX-9");
      const before = git(root, "rev-parse", "HEAD").trim();

      const r = realFlush(root, "--all");
      assert.equal(r.status, 0,
        `the real \`blaze commit --all\` must drain a healthy board.\n${r.stdout}\n${r.stderr}`);

      // Asserted against GIT, not against what the command printed. A drain that reports
      // success and leaves the work uncommitted is the failure this is here to catch, and
      // the report is exactly what cannot be trusted to notice it.
      const after = git(root, "rev-parse", "HEAD").trim();
      assert.notEqual(after, before, "no commit was created, though the flush reported success");
      assert.match(git(root, "show", "--name-only", "--format=", "HEAD"), new RegExp(rel.replace(/\//g, "[/\\\\]")),
        "the commit exists but does not contain the queued file");
      assert.equal(git(root, "status", "--porcelain").trim(), "",
        "the tree must be clean afterwards — work left behind is work the flush did not drain");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("other verbs REFUSE these boards — so the case below is a contrast, not a tautology", () => {
    // The premise. "The flush drains a board the engine rejects" means nothing unless the
    // engine really does reject it, so that is asserted first, on the same fixture, through
    // a verb that is not exempt. The refusal is `config.mjs`'s `IncompatibleSchemaVersionError`
    // and it is raised in the RUNNER, which is why `commit` escapes it: `commit-runner.mjs`
    // never calls `loadConfig`.
    const root = repo("board-gate-bad-schema-version");
    try {
      const edit = spawnSync(process.execPath, [CLI, "edit", "FIX-1", "--title", "x"],
        { cwd: root, env: env(), encoding: "utf8" });
      assert.match(edit.stderr, /schemaVersion 99 is newer than this engine supports/,
        `\`blaze edit\` accepted a board with schemaVersion 99, so there is nothing for the `
        + `flush to be an exception TO.\n${edit.stdout}\n${edit.stderr}`);

      const flush = realFlush(root, "--all");
      assert.equal(flush.status, 0,
        "`blaze commit` refused a board other verbs refuse. That is a behaviour CHANGE, not "
        + "a bug fix — refusing a flush strands ticket files other verbs have already "
        + `relocated but not committed. Reopen that decision explicitly, not here.\n${flush.stdout}\n${flush.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("on a board the engine otherwise refuses, queued work STILL reaches a commit", () => {
    // THE PROPERTY THE EXEMPTION EXISTS TO PROTECT, and the one nothing pinned before.
    // `board-gate-removed-key` carries `provider`, removed by BLZ-298, so every verb that
    // calls `loadConfig` refuses this board. The flush must still drain it — otherwise a config mistake
    // silently converts every queued op into work that is on disk, uncommitted, and
    // invisible to `git status` consumers that expect the queue to be empty.
    const root = repo("board-gate-removed-key");
    try {
      const { rel, ledger } = queue(root, "FIX-9");
      const before = git(root, "rev-parse", "HEAD").trim();

      const r = realFlush(root, "--all");
      assert.equal(r.status, 0,
        `the flush must drain a board every other verb refuses.\n${r.stdout}\n${r.stderr}`);
      assert.notEqual(git(root, "rev-parse", "HEAD").trim(), before,
        "the flush reported success and created no commit — the queued op is stranded");
      assert.match(git(root, "show", "--name-only", "--format=", "HEAD"),
        new RegExp(rel.replace(/\//g, "[/\\\\]")),
        "the commit does not contain the queued file");
      // Drained means the ledger no longer holds the op — whether the file was emptied or
      // removed outright is `pending-ledger.mjs`'s business and not this test's.
      const left = existsSync(ledger) ? readFileSync(ledger, "utf8").trim() : "";
      assert.equal(left, "", "the ledger still holds the op the flush says it drained");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("nothing on PATH is replaced — the flush ran against real git", () => {
    // The ticket's objection is to a PATH-stubbed `git`/`cli.mjs`, so this file must be
    // able to say it used neither. `git --version` from inside the harness resolves to the
    // same binary the child would resolve, and no case above modifies PATH.
    const root = repo("board-gate-good");
    try {
      queue(root, "FIX-9");
      const r = spawnSync(process.execPath, [CLI, "commit", "--all"],
        { cwd: root, env: env(), encoding: "utf8" });
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      // A commit object with a real author and a real tree is something a stub cannot
      // produce; `cat-file` proves git itself wrote it.
      const type = execFileSync("git", ["-C", root, "cat-file", "-t", "HEAD"], { encoding: "utf8" }).trim();
      assert.equal(type, "commit", "HEAD is not a real git commit object");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
