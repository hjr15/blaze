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
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HARD_KINDS } from "../scripts/model/audit.mjs";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "audit-runner.mjs");
const KIND = "terminal-goal-unverified-requirement";

function write(dir, name, fm) {
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  writeFileSync(join(dir, name), `---\n${lines}\n---\n\nbody\n`);
}

/** A board with one goal in `achieved/` and one requirement beneath it at `reqStatus`. */
function board(reqStatus, { goalStatus = "achieved" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "blaze-r48-"));
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
