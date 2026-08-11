// tests/audit.test.mjs — BLZ-137.
//
// `metadata_audit.py` is the blaze-pm board's hygiene gate: a Python script that cannot run
// against any other data repo. Porting its semantics into the engine makes the gate available
// to every board, and removes a Python dependency from a Node tool.
//
// The hard/soft split is the whole design (blaze-pm ADR-0011, the fill-or-justify soft gate):
// a HARD finding means the corpus is wrong and the run fails; a SOFT finding is a fill queue
// and must never fail a run, or the gate gets ignored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditCorpus, HARD_KINDS } from "../scripts/model/audit.mjs";

const T = (fm) => ({ frontmatter: { labels: [], components: [], links: [], ...fm }, body: "x" });
const kinds = (r) => new Set(r.findings.map((f) => `${f.ticket}:${f.kind}`));

const PROJECT = { key: "AAA", components: ["core"], labels: ["infra"] };

test("a clean corpus produces no findings and passes", () => {
  const r = auditCorpus({
    tickets: [T({ id: "AAA-1", type: "goal", components: ["core"], labels: ["infra"] })],
    projects: { AAA: PROJECT },
  });
  assert.deepEqual(r.findings, []);
  assert.equal(r.ok, true);
});

test("an off-taxonomy component is HARD — it fails the run", () => {
  const r = auditCorpus({
    tickets: [T({ id: "AAA-1", type: "goal", components: ["nope"], labels: ["infra"] })],
    projects: { AAA: PROJECT },
  });
  assert.ok(kinds(r).has("AAA-1:off-taxonomy-component"));
  assert.equal(r.ok, false, "an off-taxonomy value is corpus corruption, not a fill queue");
});

test("empty components and labels are SOFT — reported, never failing", () => {
  const r = auditCorpus({
    tickets: [T({ id: "AAA-1", type: "goal" })],
    projects: { AAA: PROJECT },
  });
  assert.ok(kinds(r).has("AAA-1:empty-components"));
  assert.ok(kinds(r).has("AAA-1:empty-labels"));
  assert.equal(r.ok, true, "a soft finding must not fail the run — that is what makes it soft");
});

test("the typed layer is not asked for labels", () => {
  // BLZ-234: a requirement/architecture/risk carries its classification in typed fields.
  const r = auditCorpus({
    tickets: ["requirement", "architecture", "risk"].map((t) =>
      T({ id: `AAA-${t}`, type: t, components: ["core"] })),
    projects: { AAA: PROJECT },
  });
  assert.equal([...kinds(r)].filter((k) => k.endsWith("empty-labels")).length, 0);
});

test("a link missing its target key is HARD — the silently-dropped-link class", () => {
  const r = auditCorpus({
    tickets: [T({ id: "AAA-1", type: "goal", components: ["core"], labels: ["infra"],
                  links: [{ type: "Relates", to: "AAA-2" }] })],
    projects: { AAA: PROJECT },
  });
  assert.ok([...kinds(r)].some((k) => k.includes("bad-link-key")));
  assert.equal(r.ok, false);
});

test("a dangling link target and a dangling parent are both HARD", () => {
  const r = auditCorpus({
    tickets: [T({ id: "AAA-1", type: "goal", components: ["core"], labels: ["infra"],
                  links: [{ type: "Relates", target: "AAA-999" }] }),
              T({ id: "AAA-2", type: "feature", parent: "AAA-404", components: ["core"], labels: ["infra"] })],
    projects: { AAA: PROJECT },
  });
  assert.ok(kinds(r).has("AAA-1:dangling-target"));
  assert.ok(kinds(r).has("AAA-2:dangling-parent"));
  assert.equal(r.ok, false);
});

test("an illegal parent PAIR is HARD, and the rule comes from the registry", () => {
  const r = auditCorpus({
    tickets: [T({ id: "AAA-1", type: "goal", components: ["core"], labels: ["infra"] }),
              T({ id: "AAA-2", type: "task", parent: "AAA-1", estimate: 30, components: ["core"], labels: ["infra"] })],
    projects: { AAA: PROJECT },
  });
  assert.ok(kinds(r).has("AAA-2:invalid-parent-type"), "a task cannot hang off a goal");
  assert.equal(r.ok, false);
});

test("a non-goal with no parent is SOFT — an orphan is reported, not fatal", () => {
  const r = auditCorpus({
    tickets: [T({ id: "AAA-1", type: "feature", components: ["core"], labels: ["infra"] })],
    projects: { AAA: PROJECT },
  });
  assert.ok(kinds(r).has("AAA-1:missing-parent"));
  assert.equal(r.ok, true);
});

test("a goal with no parent is not an orphan", () => {
  const r = auditCorpus({
    tickets: [T({ id: "AAA-1", type: "goal", components: ["core"], labels: ["infra"] })],
    projects: { AAA: PROJECT },
  });
  assert.equal([...kinds(r)].filter((k) => k.endsWith("missing-parent")).length, 0);
});

test("a project's registry scopes its own parent rules", () => {
  // BLZ-238: the audit judges each project by its own resolved registry.
  const legacy = {
    key: "BBB", components: ["core"], labels: ["infra"],
    schema: { types: {
      epic: { level: 1, workflow: "delivery", parentTypes: ["goal"], required: ["title", "description"] },
      task: { level: 0, workflow: "delivery", parentTypes: ["epic"], required: ["title", "description", "estimate"] },
    } },
  };
  const tickets = [T({ id: "BBB-1", type: "goal", components: ["core"], labels: ["infra"] }),
                   T({ id: "BBB-2", type: "epic", parent: "BBB-1", components: ["core"], labels: ["infra"] }),
                   T({ id: "BBB-3", type: "task", parent: "BBB-2", estimate: 30, components: ["core"], labels: ["infra"] })];
  assert.equal(auditCorpus({ tickets, projects: { BBB: legacy } }).ok, true,
    "the project's own registry permits its legacy edges");
  assert.equal(auditCorpus({ tickets, projects: { BBB: { ...legacy, schema: undefined } } }).ok, false,
    "and without the block the shipped default refuses them — so the scoping is real");
});

test("HARD_KINDS is the published contract, not an implementation detail", () => {
  for (const k of ["off-taxonomy-component", "off-taxonomy-label", "bad-link-key",
                   "unknown-link-type", "dangling-target", "dangling-parent",
                   "invalid-parent-type"]) {
    assert.ok(HARD_KINDS.has(k), `${k} must stay hard`);
  }
  for (const k of ["empty-components", "empty-labels", "missing-parent"]) {
    assert.ok(!HARD_KINDS.has(k), `${k} must stay soft — it is a fill queue`);
  }
});

test("--json survives a pipe: a real board's payload is past the pipe buffer", async () => {
  // Regression: the runner ended with `process.exit()`. stdout to a PIPE is asynchronous, so
  // exiting immediately after a large console.log truncates the write. Against the live board
  // the payload was cut at 64KB and would not parse — silent, and only visible when the output
  // was actually consumed rather than printed to a terminal.
  //
  // The payload MUST exceed the pipe buffer or this test passes for the wrong reason.
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const root = mkdtempSync(join(tmpdir(), "blaze-audit-pipe-"));
  const dir = join(root, "projects", "AAA", "backlog");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "projects", "AAA", "project.json"), JSON.stringify({ key: "AAA" }));
  // Each ticket yields empty-components + empty-labels + missing-parent: 3 findings apiece.
  for (let i = 1; i <= 400; i++) {
    writeFileSync(join(dir, `AAA-${i}.md`),
      `---\nid: AAA-${i}\ntitle: "ticket number ${i} with a title long enough to bulk the payload"\n` +
      `type: task\nproject: AAA\nstatus: backlog\nlabels: []\ncomponents: []\n---\n\nbody\n`);
  }

  const runner = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "audit-runner.mjs");
  const stdout = execFileSync(process.execPath, [runner, "--json", join(root, "projects")],
                              { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  assert.ok(stdout.length > 65536, `payload must exceed the 64KB pipe buffer, got ${stdout.length}`);
  const parsed = JSON.parse(stdout);   // the assertion that actually failed before the fix
  assert.equal(parsed.findings.length, 1200);
  rmSync(root, { recursive: true, force: true });
});

test("an empty corpus is refused, not reported as clean", async () => {
  // The failure this rollout is named after: an absent measurement rendered as a clean result.
  // `loadConfig` yields `projects: []` with no config file, and `??` accepted it — so auditing
  // a directory outside a board printed "0 tickets ... clean, ok=true" without reading anything.
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const root = mkdtempSync(join(tmpdir(), "blaze-audit-empty-"));
  mkdirSync(join(root, "projects"), { recursive: true });
  const runner = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "audit-runner.mjs");

  assert.throws(
    () => execFileSync(process.execPath, [runner, join(root, "projects")], { encoding: "utf8", stdio: "pipe" }),
    (e) => e.status === 2,
    "an empty corpus must exit non-zero — silence is not a pass",
  );
  rmSync(root, { recursive: true, force: true });
});
