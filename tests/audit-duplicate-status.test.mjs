// tests/audit-duplicate-status.test.mjs — BLZ-122 / REQ-035 (BLZ-187).
//
// Status IS the directory (blaze-pm ADR-0001). A ticket id resolving to a file under two
// different status directories therefore has two contradictory statuses at once, and every
// derived view silently picks one.
//
// This is not hypothetical. On 2026-08-11 the PUBLISHED blaze-pm board carried SEVEN such
// pairs on `origin/main` (BLZ-143 through BLZ-149), each a pre-completion snapshot
// resurrected alongside its real `done/` copy by a PR cut from an older base. It reached
// published main because nothing looked for it: `blaze audit` had no duplicate check and
// neither did the Python gate it was ported from.
//
// The detection lives in the RUNNER, not in `auditCorpus`. Ticket identity is a property of
// the WALK — which files exist at which paths — and `auditCorpus` is a pure function over
// frontmatter that carries no obligation to know a ticket's path. Putting it there would
// make the pure layer's contract depend on every caller threading file paths through.
//
// It is HARD: the corpus is WRONG, not merely unfilled, so it fails the run (ADR-0011's
// hard/soft split — a soft finding is a fill queue and must never fail).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HARD_KINDS } from "../scripts/model/audit.mjs";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "audit-runner.mjs");

function ticket(dir, name, { id, status }) {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, name);
  writeFileSync(f,
    `---\nid: ${id}\ntitle: ${id} in ${status}\ntype: goal\nproject: PROJ\npriority: medium\n` +
    `resolution: ${status === "done" ? "done" : ""}\nlabels: [infra]\ncomponents: [core]\n---\n\nbody\n`);
  return f;
}

/** A board whose PROJ-41 exists in `done/` and in `defined/` at once — the real shape. */
function duplicatedBoard() {
  const root = mkdtempSync(join(tmpdir(), "blaze-dupstatus-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "PROJ"), { recursive: true });
  writeFileSync(join(projects, "PROJ", "project.json"),
    JSON.stringify({ key: "PROJ", components: ["core"], labels: ["infra"] }));
  const done = ticket(join(projects, "PROJ", "done"), "PROJ-41-the-real-one.md",
    { id: "PROJ-41", status: "done" });
  const defined = ticket(join(projects, "PROJ", "defined"), "PROJ-41-the-real-one.md",
    { id: "PROJ-41", status: "defined" });
  return { root, projects, done, defined };
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

test("BLZ-122: `duplicate-status` is HARD — the published contract, not an implementation detail", () => {
  assert.ok(HARD_KINDS.has("duplicate-status"),
    "a ticket in two statuses is a WRONG corpus, so it must fail the run");
});

test("BLZ-122: an id in two status directories is reported as a HARD finding naming BOTH paths", () => {
  const { root, projects, done, defined } = duplicatedBoard();
  const r = audit(projects, ["--json"]);
  const report = JSON.parse(r.stdout);

  const dupes = report.findings.filter((f) => f.kind === "duplicate-status");
  assert.equal(dupes.length, 1, `expected exactly one duplicate-status finding, got ${JSON.stringify(dupes)}`);
  assert.equal(dupes[0].ticket, "PROJ-41");
  // Naming only one path leaves the operator hunting for the other — which IS the failure mode.
  assert.ok(dupes[0].detail.includes(done), `must name the done/ copy:\n${dupes[0].detail}`);
  assert.ok(dupes[0].detail.includes(defined), `must name the defined/ copy:\n${dupes[0].detail}`);

  assert.equal(report.ok, false, "a hard finding must set ok=false");
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-122: the detection actually FAILS the run — a gate that reports and exits 0 is not a gate", () => {
  const { root, projects } = duplicatedBoard();
  const r = audit(projects);
  assert.equal(r.status, 1, `audit must exit non-zero on a duplicated board (stdout: ${r.stdout})`);
  assert.match(r.stdout, /\[hard\] duplicate-status: 1/);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-122: --kind duplicate-status lists every offending path", () => {
  const { root, projects, done, defined } = duplicatedBoard();
  const r = audit(projects, ["--kind", "duplicate-status"]);
  assert.match(r.stdout, /PROJ-41\s+duplicate-status/);
  assert.ok(r.stdout.includes(done) && r.stdout.includes(defined),
    `--kind output must name both paths:\n${r.stdout}`);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-122: three copies of one id name all three, as one finding", () => {
  const { root, projects } = duplicatedBoard();
  const third = ticket(join(projects, "PROJ", "in-progress"), "PROJ-41-the-real-one.md",
    { id: "PROJ-41", status: "in-progress" });
  const report = JSON.parse(audit(projects, ["--json"]).stdout);
  const dupes = report.findings.filter((f) => f.kind === "duplicate-status");
  assert.equal(dupes.length, 1, "one finding per id, not one per surplus copy");
  assert.ok(dupes[0].detail.includes(third), `must name the third copy:\n${dupes[0].detail}`);
  assert.equal(dupes[0].detail.split(",").length, 3, "all three paths listed");
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-122: a clean board reports no duplicate-status finding and still exits 0", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-dupstatus-clean-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "PROJ"), { recursive: true });
  writeFileSync(join(projects, "PROJ", "project.json"),
    JSON.stringify({ key: "PROJ", components: ["core"], labels: ["infra"] }));
  ticket(join(projects, "PROJ", "done"), "PROJ-41-a.md", { id: "PROJ-41", status: "done" });
  ticket(join(projects, "PROJ", "defined"), "PROJ-42-b.md", { id: "PROJ-42", status: "defined" });

  const r = audit(projects, ["--json"]);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.findings.filter((f) => f.kind === "duplicate-status"), []);
  assert.equal(r.status, 0, `a clean board must pass (stdout: ${r.stdout})`);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-122: the same id in two DIFFERENT projects is still a duplicate", () => {
  // The seven real cases were same-project, but an id landing under the wrong project dir
  // is the same defect wearing a different hat: one id, two files, two statuses.
  const { root, projects } = duplicatedBoard();
  rmSync(join(projects, "PROJ", "defined"), { recursive: true, force: true });
  mkdirSync(join(projects, "OTHER"), { recursive: true });
  writeFileSync(join(projects, "OTHER", "project.json"),
    JSON.stringify({ key: "OTHER", components: ["core"], labels: ["infra"] }));
  const strayFile = ticket(join(projects, "OTHER", "defined"), "PROJ-41-misfiled.md",
    { id: "PROJ-41", status: "defined" });

  const report = JSON.parse(audit(projects, ["--json"]).stdout);
  const dupes = report.findings.filter((f) => f.kind === "duplicate-status");
  assert.equal(dupes.length, 1, `expected the misfiled copy to be caught: ${JSON.stringify(report.findings)}`);
  assert.ok(dupes[0].detail.includes(strayFile), `must name the misfiled copy:\n${dupes[0].detail}`);
  rmSync(root, { recursive: true, force: true });
});
