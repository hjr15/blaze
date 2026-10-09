// tests/audit-governance.test.mjs — BLZ-681 (spec §5.6). blaze-pm's governance scripts,
// re-homed as `blaze audit` kinds: terminal-parent-open-child, empty-body and
// config-project-drift (soft), plus `--fail-on <kinds>` so one kind can gate on its own. The
// rules are the scripts' own, pinned here; the runner tests prove they read through the
// resolved store — the db-mode test deletes a ticket FILE after loading the shadow, and the
// finding is still reported, because it came from the database.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { governanceFindings, isScaffoldLine, bodyIsEmpty, TERMINAL_PARENT_STATUSES,
         EMPTY_BODY_TERMINAL, HARD_KINDS, SOFT_KINDS } from "../scripts/model/audit.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";
import { QUIET } from "./helpers/db-board.mjs";

const scratch = scratchRegistry();
const AUDIT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "audit-runner.mjs");

const t = (id, status, { type = "task", parent = "", body = "Some prose." } = {}) =>
  ({ frontmatter: { id, type, parent }, status, body });

describe("the rules, as the scripts wrote them", () => {
  test("the two terminal sets are the scripts' sets, verbatim", () => {
    assert.deepEqual([...TERMINAL_PARENT_STATUSES].sort(), ["accepted", "achieved", "done", "mitigated", "obsolete"]);
    assert.deepEqual([...EMPTY_BODY_TERMINAL].sort(),
      ["accepted", "achieved", "done", "implemented", "mitigated", "obsolete", "rejected"]);
  });

  test("severities: all three are soft — terminal-parent-open-child until the board is groomed", () => {
    for (const k of ["terminal-parent-open-child", "empty-body", "config-project-drift"]) {
      assert.ok(SOFT_KINDS.includes(k), k);
      assert.ok(!HARD_KINDS.has(k), k);
    }
  });

  test("terminal-parent-open-child: any type pair, cross-project, open children in id order", () => {
    const f = governanceFindings({ tickets: [
      t("ENG-1", "done", { type: "feature" }),
      t("ENG-10", "in-progress", { parent: "ENG-1" }), t("ENG-2", "defined", { parent: "ENG-1" }),
      t("OPS-3", "done", { parent: "ENG-1" }),
      t("ENG-5", "achieved", { type: "goal" }), t("OPS-9", "proposed", { type: "requirement", parent: "ENG-5" }),
      t("ENG-7", "implemented", { type: "requirement" }), t("ENG-8", "defined", { parent: "ENG-7" }),
      t("ENG-11", "defined", { parent: "ENG-404" }),
    ] }).filter((x) => x.kind === "terminal-parent-open-child");
    assert.deepEqual(f, [
      { ticket: "ENG-1", kind: "terminal-parent-open-child", detail: "feature done with 2/3 children open: ENG-2, ENG-10" },
      { ticket: "ENG-5", kind: "terminal-parent-open-child", detail: "goal achieved with 1/1 children open: OPS-9" },
    ], "`implemented` is not in the script's set, and a dangling parent is dangling-parent's job");
  });

  test("empty-body: scaffold-only bodies, non-terminal tickets only", () => {
    for (const line of ["", "   ", "## Context", "- [ ]", "* [x]", "-", "*", "<!-- note -->"]) {
      assert.equal(isScaffoldLine(line), true, JSON.stringify(line));
    }
    for (const line of ["prose", "- [ ] a real criterion", "- a bullet", "<!-- open"]) {
      assert.equal(isScaffoldLine(line), false, JSON.stringify(line));
    }
    assert.equal(bodyIsEmpty("## Context\n\n## Acceptance Criteria\n\n- [ ]\n"), true);
    assert.equal(bodyIsEmpty(""), true);
    const f = governanceFindings({ tickets: [
      t("ENG-1", "defined", { body: "## Context\n\n- [ ]\n" }),
      t("ENG-2", "done", { body: "" }),
      t("ENG-3", "defined"),
    ] }).filter((x) => x.kind === "empty-body");
    assert.deepEqual(f, [{ ticket: "ENG-1", kind: "empty-body", detail: "defined" }]);
  });

  test("config-project-drift: both directions; skipped when the config did not load", () => {
    const f = governanceFindings({ configProjects: ["ENG", "OPS"], storeProjects: ["ENG", "NEW"] });
    assert.deepEqual(f.map((x) => [x.ticket, x.kind]), [["NEW", "config-project-drift"], ["OPS", "config-project-drift"]]);
    assert.match(f[0].detail, /store holds this project but blaze\.config\.json's projects does not list it/);
    assert.match(f[1].detail, /lists this project but the store holds none of it/);
    assert.deepEqual(governanceFindings({ configProjects: null, storeProjects: ["X"] }), []);
  });
});

// --- the runner ----------------------------------------------------------------------------------
const doc = (fm, body = "Some prose.") =>
  ["---", ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), "---", "", body, ""].join("\n");

/** A done feature ENG-1 with an open child ENG-2 whose body is scaffold-only; config lists ENG
 *  and a project OPS that has no directory. */
function board() {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz681-audit-")));
  const projectsDir = join(dataRoot, "projects");
  for (const s of ["done", "defined"]) mkdirSync(join(projectsDir, "ENG", s), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"), JSON.stringify({ projects: ["ENG", "OPS"] }));
  writeFileSync(join(projectsDir, "ENG", "done", "ENG-1-f.md"),
    doc({ id: "ENG-1", title: "F", type: "feature", project: "ENG", components: "[a]", labels: "[b]" }));
  writeFileSync(join(projectsDir, "ENG", "defined", "ENG-2-t.md"),
    doc({ id: "ENG-2", title: "T", type: "task", project: "ENG", parent: "ENG-1", estimate: 30,
          components: "[a]", labels: "[b]" }, "## Context\n\n## Acceptance Criteria\n\n- [ ]"));
  return { dataRoot, projectsDir };
}
/** `blaze audit` against `projectsDir`, with the caller's mode only: an ambient
 *  BLAZE_WRITE_PORT must not leak in, and an EMPTY one is refused, so it is removed. */
function audit(projectsDir, args = [], env = {}) {
  const base = { ...process.env };
  delete base.BLAZE_WRITE_PORT;
  return spawnSync(process.execPath, [AUDIT, ...args, projectsDir],
    { encoding: "utf8", env: { ...base, ...env } });
}

test("blaze audit reports all three, and — all soft — none fails the run", () => {
  const { projectsDir } = board();
  const r = audit(projectsDir, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  const kinds = JSON.parse(r.stdout).findings.map((f) => `${f.ticket} ${f.kind}`);
  for (const k of ["ENG-1 terminal-parent-open-child", "ENG-2 empty-body", "OPS config-project-drift"]) {
    assert.ok(kinds.includes(k), `${k} missing from ${kinds.join("; ")}`);
  }
});

test("--fail-on gates on the named kinds only, hard or soft, and says so", () => {
  const { projectsDir } = board();
  const other = audit(projectsDir, ["--fail-on", "duplicate-status"]);
  assert.equal(other.status, 0, "findings of OTHER kinds do not fail a --fail-on run");
  assert.match(other.stdout, /fail-on duplicate-status: 0 finding\(s\)/);
  const soft = audit(projectsDir, ["--fail-on", "duplicate-status,empty-body"]);
  assert.equal(soft.status, 1, "a soft kind can gate when it is named");
  assert.match(soft.stdout, /fail-on duplicate-status,empty-body: 1 finding\(s\)/);
  const json = JSON.parse(audit(projectsDir, ["--json", "--fail-on", "terminal-parent-open-child"]).stdout);
  assert.deepEqual([json.failOn, json.failing], [["terminal-parent-open-child"], 1]);
});

test("--fail-on refuses a name that is not a kind (exit 2), so a typo is never a gate that cannot fail", () => {
  const { projectsDir } = board();
  const r = audit(projectsDir, ["--fail-on", "duplicate-statsu"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--fail-on names no such kind: duplicate-statsu/);
  const none = audit(projectsDir, ["--fail-on", ""]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--fail-on needs at least one kind/);
});

test("under BLAZE_WRITE_PORT=db the kinds come from the DATABASE, not the files", async () => {
  const roots = board();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  // Changed on disk only: the FILE now has prose and no parent; the ROW is as it was loaded.
  writeFileSync(join(roots.projectsDir, "ENG", "defined", "ENG-2-t.md"),
    doc({ id: "ENG-2", title: "T", type: "task", project: "ENG", estimate: 30 }, "Now it has prose."));
  const r = audit(roots.projectsDir, ["--json"], { BLAZE_WRITE_PORT: "db" });
  assert.equal(r.status, 0, r.stderr);
  const kinds = JSON.parse(r.stdout).findings.map((f) => `${f.ticket} ${f.kind}`);
  assert.ok(kinds.includes("ENG-1 terminal-parent-open-child"), kinds.join("; "));
  assert.ok(kinds.includes("ENG-2 empty-body"), kinds.join("; "));
  assert.ok(kinds.includes("OPS config-project-drift"), kinds.join("; "));
});

test("--projects scopes what is JUDGED, never what RESOLVES: a cross-project link or parent is not dangling", () => {
  // The defect: audit-runner filtered the corpus to --projects BEFORE auditCorpus built its id
  // set, so `blaze audit --projects BLZ` called BLZ-134 → INF-750 a hard dangling-target while
  // the unscoped audit called the same board clean.
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz681-scope-")));
  const projectsDir = join(dataRoot, "projects");
  for (const p of ["ENG", "OPS"]) mkdirSync(join(projectsDir, p, "defined"), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"), JSON.stringify({ projects: ["ENG", "OPS"] }));
  const flow = (target) => `\nlinks:\n  - { type: Relates, target: ${target} }`;
  const file = (p, id, extra) => writeFileSync(join(projectsDir, p, "defined", `${id}-x.md`),
    `---\nid: ${id}\ntitle: ${id}\ntype: ${extra.type}\nproject: ${p}\nparent: ${extra.parent ?? ""}`
    + `\nestimate: 30\ncomponents: [a]\nlabels: [b]${extra.links ?? ""}\n---\n\nProse.\n`);
  file("OPS", "OPS-1", { type: "feature" });
  file("ENG", "ENG-1", { type: "task", parent: "OPS-1", links: flow("OPS-1") });
  file("ENG", "ENG-2", { type: "task", parent: "OPS-1", links: flow("OPS-99") });
  const r = audit(projectsDir, ["--json", "--projects", "ENG"]);
  const found = JSON.parse(r.stdout).findings.map((f) => `${f.ticket} ${f.kind} ${f.detail}`);
  assert.deepEqual(found.filter((f) => /dangling/.test(f)), ["ENG-2 dangling-target OPS-99"],
    "only the truly missing target is dangling; OPS-1 exists, out of scope");
  assert.ok(!found.some((f) => f.startsWith("OPS-1 ")), "an out-of-scope ticket is resolved, never judged");
  assert.equal(r.status, 1, "the one real dangling target is still hard");
});

test("governanceFindings scopes like auditCorpus: children resolve across the store, findings stay in scope", () => {
  const universe = [
    t("ENG-1", "done", { type: "feature" }), t("OPS-2", "defined", { parent: "ENG-1" }),
    t("OPS-3", "done", { type: "feature" }), t("ENG-4", "defined", { parent: "OPS-3" }),
  ];
  const tickets = universe.filter((x) => x.frontmatter.id.startsWith("ENG-"));
  const f = governanceFindings({ tickets, universe, configProjects: ["ENG", "OPS", "GONE"],
                                 storeProjects: ["ENG", "OPS", "NEW"], scopeProjects: ["ENG"] });
  assert.deepEqual(f.map((x) => `${x.ticket} ${x.kind}`), ["ENG-1 terminal-parent-open-child"],
    "OPS-2 (out of scope) is still ENG-1's open child; OPS-3 is not judged; GONE/NEW are not ENG's");
  assert.match(f[0].detail, /1\/1 children open: OPS-2/);
});

test("blaze audit --projects: an in-scope terminal parent with an out-of-scope open child is reported", () => {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz681-scope2-")));
  const projectsDir = join(dataRoot, "projects");
  mkdirSync(join(projectsDir, "ENG", "done"), { recursive: true });
  mkdirSync(join(projectsDir, "OPS", "defined"), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"), JSON.stringify({ projects: ["ENG", "OPS", "GONE"] }));
  writeFileSync(join(projectsDir, "ENG", "done", "ENG-1-f.md"),
    doc({ id: "ENG-1", title: "F", type: "feature", project: "ENG", components: "[a]", labels: "[b]" }));
  writeFileSync(join(projectsDir, "OPS", "defined", "OPS-2-t.md"),
    doc({ id: "OPS-2", title: "T", type: "task", project: "OPS", parent: "ENG-1", estimate: 30,
          components: "[a]", labels: "[b]" }));
  const r = audit(projectsDir, ["--json", "--projects", "ENG"]);
  const found = JSON.parse(r.stdout).findings.map((f) => `${f.ticket} ${f.kind}`);
  assert.ok(found.includes("ENG-1 terminal-parent-open-child"), found.join("; "));
  assert.ok(!found.some((f) => f.endsWith("config-project-drift")), "GONE is outside --projects ENG");
});
