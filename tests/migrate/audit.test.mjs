// tests/migrate/audit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditIssues, detectMerges, titleSimilarity, DROP_RESOLUTIONS } from "../../scripts/migrate/audit.mjs";
import { proposeStructure } from "../../scripts/migrate/restructure.mjs";

const N = (o) => ({ key: o.key, project: o.key.split("-")[0], type: o.type, summary: o.summary ?? o.key,
  status: o.status ?? "Done", resolution: "resolution" in o ? o.resolution : "Done", components: o.components ?? [],
  parent: o.parent ?? null, links: o.links ?? [], worklog: o.worklog ?? [] });

test("DROP_RESOLUTIONS covers the non-Done terminal set", () => {
  for (const r of ["won't do", "duplicate", "cannot reproduce"]) assert.ok(DROP_RESOLUTIONS.has(r));
  assert.equal(DROP_RESOLUTIONS.has("done"), false);
});

test("titleSimilarity is high for near-duplicates, low for unrelated", () => {
  assert.ok(titleSimilarity("Gateway timeout retry", "Gateway timeout retries") >= 0.6);
  assert.ok(titleSimilarity("Gateway timeout", "Borrower signup email") < 0.3);
});

test("auditIssues drops a Won't Do and a Cannot Reproduce", () => {
  const norms = [N({ key: "OBA-1", type: "Task", status: "Done", resolution: "Won't Do" }),
                 N({ key: "OBA-2", type: "Bug", status: "Done", resolution: "Cannot Reproduce" })];
  const { dispositions } = auditIssues(norms, proposeStructure(norms));
  assert.equal(dispositions.find((d) => d.id === "OBA-1").disposition, "drop");
  assert.equal(dispositions.find((d) => d.id === "OBA-2").disposition, "drop");
});

test("auditIssues keeps a Done item and fills proposed_status", () => {
  const norms = [N({ key: "OBA-1", type: "Goal", status: "Achieved", resolution: "Done" }),
                 N({ key: "OBA-2", type: "Epic", parent: "OBA-1", status: "In Progress", resolution: null })];
  const { dispositions } = auditIssues(norms, proposeStructure(norms));
  const epic = dispositions.find((d) => d.id === "OBA-2");
  assert.equal(epic.disposition, "keep");
  assert.equal(epic.proposed_status, "in-progress");
  assert.equal(epic.proposed_parent, "OBA-1");
});

test("auditIssues treats a terminal status with no resolution as abandoned → drop", () => {
  const norms = [N({ key: "OBA-3", type: "Task", status: "Done", resolution: null })];
  const { dispositions } = auditIssues(norms, proposeStructure(norms));
  assert.equal(dispositions[0].disposition, "drop");
  assert.match(dispositions[0].reason, /abandoned|no resolution/i);
});

test("detectMerges folds a duplicate into the more-worked survivor", () => {
  const norms = [
    N({ key: "OBA-10", type: "Task", summary: "Gateway timeout retry", components: ["gateway"],
        worklog: [{ seconds: 3600 }] }),
    N({ key: "OBA-11", type: "Task", summary: "Gateway timeout retries", components: ["gateway"],
        links: [{ type: "Relates", target: "OBA-10" }], worklog: [] }),
  ];
  const merges = detectMerges(norms);
  assert.equal(merges.get("OBA-11"), "OBA-10");        // 11 folds into the more-worked 10
  assert.equal(merges.has("OBA-10"), false);
});

test("auditIssues emits merge-into for the non-survivor (opt-in)", () => {
  const norms = [
    N({ key: "OBA-10", type: "Task", summary: "Gateway timeout retry", components: ["gateway"], worklog: [{ seconds: 3600 }] }),
    N({ key: "OBA-11", type: "Task", summary: "Gateway timeout retries", components: ["gateway"],
        links: [{ type: "Duplicate", target: "OBA-10" }] }),
  ];
  const { dispositions } = auditIssues(norms, proposeStructure(norms), { detectMerges: true });
  assert.equal(dispositions.find((d) => d.id === "OBA-11").disposition, "merge-into:OBA-10");
});

test("auditIssues without detectMerges opt-in produces no merge-into for a would-be duplicate pair", () => {
  const norms = [
    N({ key: "OBA-10", type: "Task", summary: "Gateway timeout retry", components: ["gateway"], worklog: [{ seconds: 3600 }] }),
    N({ key: "OBA-11", type: "Task", summary: "Gateway timeout retries", components: ["gateway"],
        links: [{ type: "Duplicate", target: "OBA-10" }] }),
  ];
  // Default: detectMerges off — neither item should get a merge-into disposition
  const { dispositions } = auditIssues(norms, proposeStructure(norms));
  assert.ok(!dispositions.some((d) => d.disposition.startsWith("merge-into:")),
    "no merge-into dispositions when detectMerges is not set");
  // Both items survive as keep/re-parent
  assert.ok(dispositions.every((d) => d.disposition === "keep" || d.disposition.startsWith("re-parent:")));
});

// Locks in the intended P5-2 "abandoned" drop: a terminal (done-category) item
// with no resolution is dropped. Category fallback makes the terminal detection
// fire for done-category statuses whose name isn't in the map (e.g. "Achieved").
test("auditIssues drops a done-category item with no resolution as abandoned", () => {
  const norms = [{ key: "OBA-1", project: "OBA", type: "Epic", summary: "x",
    status: "Achieved", statusCategory: "done", resolution: null,
    components: [], parent: null, links: [], worklog: [] }];
  const { dispositions } = auditIssues(norms, proposeStructure(norms));
  assert.equal(dispositions[0].disposition, "drop");
  assert.match(dispositions[0].reason, /abandoned/i);
});
