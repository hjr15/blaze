// tests/audit-project-mismatch.test.mjs — BLZ-406 AC-3.
//
// `auditCorpus` is pure over frontmatter and keys off the id prefix, so it cannot see the
// DIRECTORY a ticket actually sits in. The RUNNER can, exactly as it already does for
// `duplicate-status` and `terminal-goal-unverified-requirement` — ticket identity (which
// paths exist) is a property of the WALK, not of frontmatter.
//
// Decided HARD (not a fill queue): the corpus really is wrong — a ticket sitting in
// another project's directory while its frontmatter claims a different one is exactly the
// shape `scripts/model/audit.mjs`'s own header sets as the test for HARD. Licensed by
// measurement, per the BLZ-353 lesson: re-verified at blaze-pm branch BLZ-305-v4-spine
// (1d172e1e6edfe481465609c9dfd05bd97f6b8930), across 2,682 tickets in 11 projects, BOTH
// frontmatter/directory mismatches and id-prefix/directory mismatches measure ZERO, so
// shipping this hard fails no existing board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HARD_KINDS } from "../scripts/model/audit.mjs";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "audit-runner.mjs");

function ticket(dir, name, { id, project }) {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, name);
  writeFileSync(f,
    `---\nid: ${id}\ntitle: ${id}\ntype: task\nproject: ${project}\nestimate: 30\n` +
    "labels: [infra]\ncomponents: [core]\n---\n\nbody\n");
  return f;
}

function projectJson(projectsDir, key) {
  mkdirSync(join(projectsDir, key), { recursive: true });
  writeFileSync(join(projectsDir, key, "project.json"),
    JSON.stringify({ key, components: ["core"], labels: ["infra"] }));
}

/** A board with two projects, ZZZ and YYY, and one ticket filed under YYY's directory
 *  while its frontmatter names ZZZ. */
function misfiledBoard() {
  const root = mkdtempSync(join(tmpdir(), "blaze-projmismatch-"));
  const projects = join(root, "projects");
  projectJson(projects, "ZZZ");
  projectJson(projects, "YYY");
  const misfiled = ticket(join(projects, "YYY", "defined"), "ZZZ-999-misfiled.md",
    { id: "ZZZ-999", project: "ZZZ" });
  return { root, projects, misfiled };
}

function audit(projects, extra = []) {
  try {
    const stdout = execFileSync(process.execPath, [RUNNER, ...extra, projects],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

test("BLZ-406: `project-mismatch` is HARD — a misfiled ticket is a wrong corpus, not a fill queue", () => {
  assert.ok(HARD_KINDS.has("project-mismatch"),
    "a ticket whose directory and frontmatter project disagree must fail the run");
});

test("BLZ-406: a ticket under one project's directory naming another's is a HARD finding", () => {
  const { root, projects, misfiled } = misfiledBoard();
  const r = audit(projects, ["--json"]);
  const report = JSON.parse(r.stdout);

  const findings = report.findings.filter((f) => f.kind === "project-mismatch");
  assert.equal(findings.length, 1, `expected exactly one project-mismatch finding, got ${JSON.stringify(findings)}`);
  assert.equal(findings[0].ticket, "ZZZ-999");
  assert.match(findings[0].detail, /YYY/);
  assert.match(findings[0].detail, /ZZZ/);
  void misfiled;

  assert.equal(report.ok, false, "a hard finding must set ok=false");
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-406: the detection actually FAILS the run", () => {
  const { root, projects } = misfiledBoard();
  const r = audit(projects);
  assert.equal(r.status, 1, `audit must exit non-zero on a misfiled board (stdout: ${r.stdout})`);
  assert.match(r.stdout, /\[hard\] project-mismatch: 1/);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-406: --kind project-mismatch names the ticket", () => {
  const { root, projects } = misfiledBoard();
  const r = audit(projects, ["--kind", "project-mismatch"]);
  assert.match(r.stdout, /ZZZ-999\s+project-mismatch/);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-406: a ticket with NO frontmatter project at all is not a mismatch", () => {
  // `.project` is absent on some boards (index.mjs's own comment) — nothing to
  // contradict the directory with, so this must not fire.
  const root = mkdtempSync(join(tmpdir(), "blaze-projmismatch-none-"));
  const projects = join(root, "projects");
  projectJson(projects, "ZZZ");
  mkdirSync(join(projects, "ZZZ", "defined"), { recursive: true });
  writeFileSync(join(projects, "ZZZ", "defined", "ZZZ-1-t.md"),
    "---\nid: ZZZ-1\ntitle: t\ntype: task\nestimate: 30\nlabels: [infra]\ncomponents: [core]\n---\n\nbody\n");
  const report = JSON.parse(audit(projects, ["--json"]).stdout);
  assert.deepEqual(report.findings.filter((f) => f.kind === "project-mismatch"), []);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-406: a well-filed board reports no project-mismatch finding and still exits 0", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-projmismatch-clean-"));
  const projects = join(root, "projects");
  projectJson(projects, "ZZZ");
  ticket(join(projects, "ZZZ", "defined"), "ZZZ-1-t.md", { id: "ZZZ-1", project: "ZZZ" });

  const r = audit(projects, ["--json"]);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.findings.filter((f) => f.kind === "project-mismatch"), []);
  assert.equal(r.status, 0, `a clean board must pass (stdout: ${r.stdout})`);
  rmSync(root, { recursive: true, force: true });
});
