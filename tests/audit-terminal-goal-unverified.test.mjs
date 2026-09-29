// tests/audit-terminal-goal-unverified.test.mjs — BLZ-353 / ruling R48.
//
// With BLZ-339, `verified` became a declared requirement status but `implemented` stayed
// terminal, so a goal could be achieved carrying requirements nobody ever verified. The
// operator settled the policy on 2026-08-23: verification is required.
//
// `gates.mjs` refuses this prospectively. This finding catches what the gate structurally
// cannot: a ticket moved by a direct file write (which bypasses `blaze` entirely), and any
// board that predates the gate. It found exactly that on the live board — NCA-1 sits in
// `achieved/` while NCA-24 is still `proposed`, which would have failed even the OLD rule.
//
// Like `duplicate-status`, it is raised by the RUNNER rather than `auditCorpus`: status is
// the directory, so it is a property of the WALK, and the pure function is a function of
// frontmatter, which carries no path.
//
// It is SOFT, deliberately and against BLZ-353's own initial expectation — see the note
// beside HARD_KINDS in scripts/model/audit.mjs. It flips to hard once NCA-39 is resolved.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HARD_KINDS } from "../scripts/model/audit.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { dbBoard, runner, QUIET } from "./helpers/db-board.mjs";

// BLZ-503: every scratch directory this file mints, removed when the file is done with
// it. Registered rather than written as a test's trailing statement, so a failing
// assertion earlier in the test cannot skip it.
const scratch = scratchRegistry();

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "audit-runner.mjs");
const KIND = "terminal-goal-unverified-requirement";

function write(dir, name, fm) {
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  writeFileSync(join(dir, name), `---\n${lines}\n---\n\nbody\n`);
}

/** A board with one goal in `achieved/` and one requirement beneath it at `reqStatus`. */
function board(reqStatus, { goalStatus = "achieved" } = {}) {
  const root = scratch(mkdtempSync(join(tmpdir(), "blaze-r48-")));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "PROJ"), { recursive: true });
  writeFileSync(join(projects, "PROJ", "project.json"),
    JSON.stringify({ key: "PROJ", components: ["core"], labels: ["infra"] }));
  write(join(projects, "PROJ", goalStatus), "PROJ-1-the-goal.md",
    { id: "PROJ-1", title: "the goal", type: "goal", project: "PROJ", priority: "medium",
      resolution: "done", parent: "", labels: "[infra]", components: "[core]" });
  write(join(projects, "PROJ", reqStatus), "PROJ-2-the-requirement.md",
    { id: "PROJ-2", title: "the requirement", type: "requirement", project: "PROJ",
      priority: "medium", resolution: "", parent: "PROJ-1", labels: "[]", components: "[core]" });
  return projects;
}

function audit(projects) {
  try {
    const stdout = execFileSync(process.execPath, [RUNNER, "--json", projects],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (e) {
    return JSON.parse(String(e.stdout ?? "{}"));
  }
}

test("R48: an achieved goal over an `implemented` requirement is reported", () => {
  const report = audit(board("implemented"));
  const hits = report.findings.filter((f) => f.kind === KIND);
  assert.equal(hits.length, 1, `expected one ${KIND}, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].ticket, "PROJ-1", "the finding names the GOAL — that is what is wrong");
  assert.match(hits[0].detail, /PROJ-2/, "and names the requirement that blocks it");
  assert.match(hits[0].detail, /implemented/, "and its status, so the fix is obvious");
});

test("R48: `proposed` beneath an achieved goal is reported too — it failed even the old rule", () => {
  const report = audit(board("proposed"));
  assert.equal(report.findings.filter((f) => f.kind === KIND).length, 1);
});

for (const satisfying of ["verified", "rejected", "obsolete"]) {
  test(`R48: a '${satisfying}' requirement does NOT block an achieved goal`, () => {
    const report = audit(board(satisfying));
    assert.equal(report.findings.filter((f) => f.kind === KIND).length, 0,
      `${satisfying} is a settled outcome — only delivered-but-unverified blocks`);
  });
}

test("R48: an `implemented` requirement under a NON-terminal goal is fine — work in flight", () => {
  const report = audit(board("implemented", { goalStatus: "in-progress" }));
  assert.equal(report.findings.filter((f) => f.kind === KIND).length, 0,
    "the finding is about terminal goals; an open goal may legitimately hold unverified work");
});

test("R48: the finding is SOFT, and that is a recorded decision, not an oversight", () => {
  // BLZ-353 predicted zero pre-existing violations and reasoned hard was affordable. That
  // measurement was wrong — it omitted `achieved` from the terminal set. The real count was
  // 7. Shipping hard would have failed `blaze audit` on day one for pre-existing debt, which
  // scripts/model/audit.mjs's own header calls the wrong trade. Flip to hard under NCA-39.
  assert.ok(!HARD_KINDS.has(KIND),
    "soft until NCA-39 clears the pre-existing violations; then promote it");
});

test("R48: a soft finding does not fail the run", () => {
  const report = audit(board("implemented"));
  assert.equal(report.ok, true, "a fill-queue finding must never fail the gate");
});

// BLZ-670. R48's finding is raised from `statusOf`, keyed off each ticket's status — and until
// this task that status was read as `basename(dirname(t.file))`, which only means anything when
// `t.file` is a FILESYSTEM PATH. In `db` mode, `t.file` is an opaque ROW ID (BLZ-271's own
// comment on the sqlite/postgres readers), so `dirname` collapses to "." for every ticket and
// the finding goes silently blind. The R48 tests above never catch this — they run the runner
// with no `BLAZE_WRITE_PORT`, so `t.file` is a real path there and the bug hides. `audit-runner`
// is a CLI/subprocess entry point with no exported function to unit-test the walk in isolation,
// so this drives it the same way Task 1's own coverage does: through the runner, in `db` mode.
describe("BLZ-670: R48's finding still fires when statuses come from the database, not paths", () => {
  async function dbBoardWithR48() {
    const roots = dbBoard();
    assert.equal(0, await runDb(["init"], { ...QUIET, roots }));
    // ENG-2: a goal, moved to its terminal status.
    let r = runner("new-runner.mjs", ["--project", "ENG", "--type", "goal", "The goal"], roots);
    assert.equal(r.status, 0, r.stderr);
    r = runner("move-runner.mjs", ["ENG-2", "in-progress"], roots);
    assert.equal(r.status, 0, r.stderr);
    r = runner("move-runner.mjs", ["ENG-2", "achieved"], roots);
    assert.equal(r.status, 0, r.stderr);
    // ENG-3: a requirement under it, left at its initial (non-satisfying) status.
    r = runner("new-runner.mjs",
      ["--project", "ENG", "--type", "requirement", "--parent", "ENG-2", "The requirement"], roots);
    assert.equal(r.status, 0, r.stderr);
    return roots;
  }

  test("an achieved goal over an unverified requirement is reported in db mode too", async () => {
    const roots = await dbBoardWithR48();
    const r = runner("audit-runner.mjs", ["--json"], roots);
    const report = JSON.parse(r.stdout);
    const hits = report.findings.filter((f) => f.kind === KIND);
    assert.equal(hits.length, 1,
      `expected one ${KIND} in db mode, got ${JSON.stringify(report.findings)}`);
    assert.equal(hits[0].ticket, "ENG-2", "the finding names the GOAL, by id, not a filesystem path");
    assert.match(hits[0].detail, /ENG-3/, "and names the requirement that blocks it");
    assert.match(hits[0].detail, /proposed/,
      "and the requirement's STATUS, read from the row rather than mis-derived from its opaque " +
      "db handle — `dirname(t.file)` on a db id collapses to \".\" and this assertion catches it");
  });
});
