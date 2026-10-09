// tests/readonly-runners.test.mjs — BLZ-683 (spec §5.8). Four runners had no per-runner
// BLAZE_READONLY guard (ADR-0019's addendum named them): user, init, migrate and schedule. A
// direct `node scripts/<x>-runner.mjs` bypassed cli.mjs's dispatch gate and wrote. Each test runs
// the runner DIRECTLY under BLAZE_READONLY=1 and proves the refusal names the mode and that
// nothing was written — the positive invariant, not just a non-zero exit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../scripts/init-runner.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const TICKET = "---\nid: ENG-1\ntitle: One\ntype: task\nproject: ENG\nestimate: 30\ndue: 2026-12-01\n---\n\nbody\n";

function board() {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz683-readonly-")));
  mkdirSync(join(dataRoot, "projects", "ENG", "defined"), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"), JSON.stringify({ projects: ["ENG"] }));
  writeFileSync(join(dataRoot, "projects", "ENG", "defined", "ENG-1-one.md"), TICKET);
  return dataRoot;
}
function direct(dataRoot, script, args, extra = {}) {
  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(dataRoot, "projects"), BLAZE_READONLY: "1", ...extra };
  delete env.BLAZE_WRITE_PORT;
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args],
    { cwd: dataRoot, encoding: "utf8", input: "a-password-long-enough\n", env });
}
const refused = (r, what) => {
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`blaze: read-only mode \\(BLAZE_READONLY=1\\) — refusing to ${what}`));
};

test("user-runner add and passwd refuse, and no identity store is created", () => {
  const root = board();
  refused(direct(root, "user-runner.mjs", ["add", "--email", "a@example.com"]), "run blaze user add");
  refused(direct(root, "user-runner.mjs", ["passwd", "--email", "a@example.com"]), "run blaze user passwd");
  assert.equal(existsSync(join(root, ".blaze", "identity.db")), false);
  assert.equal(existsSync(join(root, ".gitignore")), false, "not even the .gitignore line");
});

test("user-runner still names a usage error first", () => {
  const r = direct(board(), "user-runner.mjs", ["add"]);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /read-only mode/);
});

test("init-runner refuses before writing a board; --help still answers", async () => {
  const dir = scratch(mkdtempSync(join(tmpdir(), "blz683-init-")));
  const out = [];
  const io = { log: (s) => out.push(String(s)), err: (s) => out.push(String(s)), isTTY: false,
               env: { BLAZE_READONLY: "1" } };
  assert.equal(await runInit(["--yes", `--dir=${dir}`, "--project=ENG", "--no-git"], io), 1);
  assert.match(out.join("\n"), /read-only mode \(BLAZE_READONLY=1\) — refusing to run blaze init/);
  assert.equal(existsSync(join(dir, "blaze.config.json")), false);
  assert.equal(existsSync(join(dir, "projects")), false);
  assert.equal(await runInit(["--help"], io), 0);
});

test("migrate-runner refuses both modes before writing migration/ or a ticket", () => {
  const root = board();
  refused(direct(root, "migrate-runner.mjs", ["--dry-run"]), "run blaze migrate");
  refused(direct(root, "migrate-runner.mjs", ["--live"]), "run blaze migrate");
  assert.equal(existsSync(join(root, "migration")), false);
});

test("schedule-runner refuses --write and leaves the ticket as it was; the dry run still runs", () => {
  const root = board();
  const file = join(root, "projects", "ENG", "defined", "ENG-1-one.md");
  refused(direct(root, "schedule-runner.mjs", ["migrate-dates", "--write"]), "run blaze schedule migrate-dates --write");
  assert.equal(readFileSync(file, "utf8"), TICKET);
  const dry = direct(root, "schedule-runner.mjs", ["migrate-dates"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(readFileSync(file, "utf8"), TICKET);
});
