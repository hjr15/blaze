// tests/audit-observed-set.test.mjs — BLZ-714 (Plan B Task 4, R1): the audit says how many
// tickets it OBSERVED (`ticketCount`), and a `--fail-on` run that read none while a project
// resolved is "could-not-observe" (exit 2), never a pass. Without --fail-on the exit is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const AUDIT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "audit-runner.mjs");

const doc = (id, status) => ["---", `id: ${id}`, `title: T${id}`, "type: task", "project: ENG",
  "estimate: 30", "components: [a]", "labels: [b]", "---", "", "## Context", "", "Prose.", ""].join("\n");

/** A configured project ENG holding `n` tickets (a status directory is made either way). */
function board(n) {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz714-audit-")));
  const projectsDir = join(dataRoot, "projects");
  mkdirSync(join(projectsDir, "ENG", "defined"), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"), JSON.stringify({ projects: ["ENG"] }));
  for (let i = 1; i <= n; i++) writeFileSync(join(projectsDir, "ENG", "defined", `ENG-${i}-t.md`), doc(`ENG-${i}`, "defined"));
  return projectsDir;
}
function audit(projectsDir, args = []) {
  const env = { ...process.env };
  for (const k of ["BLAZE_WRITE_PORT", "BLAZE_READONLY", "BLAZE_REMOTE_URL", "BLAZE_TOKEN", "BLAZE_TOKEN_FILE"]) delete env[k];
  return spawnSync(process.execPath, [AUDIT, ...args, projectsDir], { encoding: "utf8", env });
}

test("BLZ-714: --json reports ticketCount", () => {
  const r = audit(board(2), ["--json"]);
  assert.equal(JSON.parse(r.stdout).ticketCount, 2, r.stderr);
  const f = audit(board(2), ["--json", "--fail-on", "duplicate-status"]);
  assert.equal(JSON.parse(f.stdout).ticketCount, 2, "with --fail-on too");
});

test("BLZ-714: --fail-on over an empty read is could-not-observe, exit 2", () => {
  const r = audit(board(0), ["--json", "--fail-on", "duplicate-status"]);
  assert.equal(r.status, 2, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.failOnVerdict, "could-not-observe");
  assert.ok(j.failOnBlind.includes("empty-read"), JSON.stringify(j.failOnBlind));
  assert.equal(j.ticketCount, 0);
  assert.match(r.stderr, /0 tickets were read across 1 project/);
  assert.match(r.stderr, /an empty read is not a clean board/);
});

test("BLZ-714: without --fail-on an empty board still exits 0", () => {
  const r = audit(board(0), ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ticketCount, 0);
});

test("BLZ-714 (prove-test-discriminates): one ticket makes the same --fail-on run pass", () => {
  const r = audit(board(1), ["--json", "--fail-on", "duplicate-status"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).failOnVerdict, "pass");
});

test("BLZ-714: ticketCount counts the in-scope tickets, so --projects naming the empty project is an empty read", () => {
  const projectsDir = board(3);
  const dataRoot = dirname(projectsDir);
  mkdirSync(join(projectsDir, "OPS", "defined"), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"), JSON.stringify({ projects: ["ENG", "OPS"] }));
  const r = audit(projectsDir, ["--json", "--projects", "OPS", "--fail-on", "duplicate-status"]);
  assert.equal(r.status, 2, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ticketCount, 0, "ENG's 3 tickets are out of scope");
  assert.ok(j.failOnBlind.includes("empty-read"));
  assert.match(r.stderr, /0 tickets were read across 1 project/);
});
