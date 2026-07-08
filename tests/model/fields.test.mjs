import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldInputs, EDITABLE_FIELDS } from "../../scripts/model/fields.mjs";
import { PRIORITIES } from "../../scripts/model/schema.mjs";

test("priority is an editable select over PRIORITIES", () => {
  const f = fieldInputs({ priority: "high" }).find((x) => x.key === "priority");
  assert.equal(f.editable, true);
  assert.equal(f.kind, "select");
  assert.deepEqual(f.options, PRIORITIES);
});

test("only allowlisted fields are editable; project/created are read-only", () => {
  const rows = fieldInputs({ assignee: "ryan", project: "INF", created: "2026-07-01", status: "defined" });
  assert.equal(rows.find((r) => r.key === "assignee").editable, true);
  for (const k of ["project", "created", "status"]) {
    assert.equal(rows.find((r) => r.key === k).editable, false, k + " must be read-only");
  }
});

test("editable set matches what applyEdit will accept (no phantom-editable field)", () => {
  // every editable field surfaced must be in the shared allowlist
  const rows = fieldInputs({ assignee: "a", priority: "high", labels: ["x"], estimate: 5, project: "INF" });
  for (const r of rows.filter((x) => x.editable)) assert.ok(EDITABLE_FIELDS.has(r.key));
});

test("arrays render comma-joined text", () => {
  const f = fieldInputs({ labels: ["a", "b"] }).find((x) => x.key === "labels");
  assert.equal(f.kind, "text");
  assert.equal(f.value, "a, b");
});

test("an array of objects (e.g. worklog) renders as JSON-joined, not [object Object]", () => {
  const f = fieldInputs({ worklog: [{ date: "2026-07-02", minutes: 120 }] }).find((x) => x.key === "worklog");
  assert.equal(f.value, '{"date":"2026-07-02","minutes":120}');
  assert.doesNotMatch(f.value, /\[object Object\]/);
});
