import { test } from "node:test";
import assert from "node:assert/strict";
import { ganttModel } from "../../scripts/model/gantt.mjs";

// Pure index shim (copied idiom from tests/model/graph.test.mjs): rows + get().
function fullIdx(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { rows, links: [], get: (id) => byId.get(id) };
}
// A delivery bar row with sane defaults; override per-test.
const R = (o) => ({
  id: o.id, project: o.project ?? "A", type: "type" in o ? o.type : "task", title: o.title ?? o.id.toLowerCase(),
  status: o.status ?? "defined", parent: o.parent ?? null, assignee: o.assignee ?? "unassigned",
  sprint: o.sprint ?? "S1", start: o.start ?? null, due: o.due ?? null,
});

const D = (iso) => Date.parse(iso + "T00:00:00Z");
// Sprint window 2026-07-13..2026-07-26. Axis pads one day each side (07-12..07-27),
// pxPerDay = 28, so day-0 = 07-12 at x=0.
const SPRINTS = { active: "S1", sprints: [
  { id: "S1", name: "Mid-July", start: "2026-07-13", end: "2026-07-26" },
  { id: "S2", name: "Late-July", start: "2026-07-27", end: "2026-08-09" },
] };
const NOW = D("2026-07-20"); // mid-window
const X = (iso) => ((D(iso) - (D("2026-07-13") - 86400000)) / 86400000) * 28;

// ---- empty / selection -----------------------------------------------------

test("ganttModel: no sprints → empty", () => {
  const gm = ganttModel({ index: fullIdx([]), sprints: { active: null, sprints: [] }, sprint: null, project: "all", now: NOW });
  assert.equal(gm.empty, true);
  assert.deepEqual(gm.rows, []);
  assert.equal(gm.axis, null);
  assert.equal(gm.nowX, null);
});

test("ganttModel: absent sprint param falls back to active", () => {
  const gm = ganttModel({ index: fullIdx([R({ id: "A-1" })]), sprints: SPRINTS, sprint: null, project: "all", now: NOW });
  assert.equal(gm.selected, "S1");
  assert.equal(gm.empty, false);
});

test("ganttModel: sprint param wins over active (selects a NON-active sprint)", () => {
  const gm = ganttModel({ index: fullIdx([R({ id: "A-9", sprint: "S2" })]), sprints: SPRINTS, sprint: "S2", project: "all", now: NOW });
  assert.equal(gm.selected, "S2");
  assert.equal(gm.rows.length, 1); // the S2 row, not the (absent) S1 rows
  assert.equal(gm.rows[0].id, "A-9");
});

// ---- row + project filter --------------------------------------------------

test("ganttModel: only rows whose sprint === selected, intersected with project", () => {
  const idx = fullIdx([
    R({ id: "A-1", sprint: "S1", project: "A" }),
    R({ id: "A-2", sprint: "S2", project: "A" }),   // wrong sprint
    R({ id: "B-1", sprint: "S1", project: "B" }),   // wrong project
  ]);
  const gm = ganttModel({ index: idx, sprints: SPRINTS, sprint: "S1", project: "A", now: NOW });
  assert.deepEqual(gm.rows.map((r) => r.id), ["A-1"]);
});

test("ganttModel: project 'all' keeps every project in the sprint", () => {
  const idx = fullIdx([R({ id: "A-1", project: "A" }), R({ id: "B-1", project: "B" })]);
  const gm = ganttModel({ index: idx, sprints: SPRINTS, sprint: "S1", project: "all", now: NOW });
  assert.deepEqual(gm.rows.map((r) => r.id).sort(), ["A-1", "B-1"]);
});

// ---- delivery filter / warnings --------------------------------------------

test("ganttModel: a risk-type row in scope is dropped into warnings, not rendered", () => {
  const idx = fullIdx([R({ id: "A-1" }), R({ id: "A-2", type: "risk" })]);
  const gm = ganttModel({ index: idx, sprints: SPRINTS, sprint: "S1", project: "all", now: NOW });
  assert.deepEqual(gm.rows.map((r) => r.id), ["A-1"]);
  assert.equal(gm.warnings.length, 1);
  assert.match(gm.warnings[0], /A-2/);
});

test("ganttModel: a type:null row in scope is dropped with a warning, never thrown", () => {
  const idx = fullIdx([R({ id: "A-1" }), R({ id: "A-2", type: null })]);
  let gm;
  assert.doesNotThrow(() => { gm = ganttModel({ index: idx, sprints: SPRINTS, sprint: "S1", project: "all", now: NOW }); });
  assert.deepEqual(gm.rows.map((r) => r.id), ["A-1"]);
  assert.equal(gm.warnings.length, 1);
  assert.match(gm.warnings[0], /A-2/);
});

test("ganttModel: an unknown-type row in scope is dropped with a warning, never thrown", () => {
  const idx = fullIdx([R({ id: "A-2", type: "gizmo" })]);
  let gm;
  assert.doesNotThrow(() => { gm = ganttModel({ index: idx, sprints: SPRINTS, sprint: "S1", project: "all", now: NOW }); });
  assert.deepEqual(gm.rows, []);
  assert.equal(gm.warnings.length, 1);
});

// ---- bar kinds + geometry --------------------------------------------------

test("ganttModel: solid bar (both dates) — x/w match the date offsets", () => {
  const gm = ganttModel({ index: fullIdx([R({ id: "A-1", start: "2026-07-20", due: "2026-07-22" })]), sprints: SPRINTS, sprint: "S1", project: "all", now: NOW });
  const r = gm.rows[0];
  assert.equal(r.barKind, "solid");
  assert.equal(r.x, X("2026-07-20"));           // 224
  assert.equal(r.w, X("2026-07-23") - X("2026-07-20")); // due day inclusive → 84
});

test("ganttModel: open-end bar (start only) runs start → sprint end", () => {
  const gm = ganttModel({ index: fullIdx([R({ id: "A-1", start: "2026-07-20" })]), sprints: SPRINTS, sprint: "S1", project: "all", now: NOW });
  const r = gm.rows[0];
  assert.equal(r.barKind, "open-end");
  assert.equal(r.x, X("2026-07-20"));
  assert.equal(r.w, X("2026-07-27") - X("2026-07-20")); // to sprint.end (07-26) inclusive
});

test("ganttModel: open-start bar (due only) runs sprint start → due", () => {
  const gm = ganttModel({ index: fullIdx([R({ id: "A-1", due: "2026-07-22" })]), sprints: SPRINTS, sprint: "S1", project: "all", now: NOW });
  const r = gm.rows[0];
  assert.equal(r.barKind, "open-start");
  assert.equal(r.x, X("2026-07-13"));
  assert.equal(r.w, X("2026-07-23") - X("2026-07-13"));
});

test("ganttModel: unplanned bar (neither date) spans the whole sprint", () => {
  const gm = ganttModel({ index: fullIdx([R({ id: "A-1" })]), sprints: SPRINTS, sprint: "S1", project: "all", now: NOW });
  const r = gm.rows[0];
  assert.equal(r.barKind, "unplanned");
  assert.equal(r.x, X("2026-07-13"));
  assert.equal(r.w, X("2026-07-27") - X("2026-07-13"));
});

// ---- DISCRIMINATING GEOMETRY (the load-bearing one) ------------------------

test("ganttModel: a start one day later lands at a strictly greater, EXACT x", () => {
  const idx = fullIdx([
    R({ id: "A-1", start: "2026-07-20", due: "2026-07-22" }),
    R({ id: "A-2", start: "2026-07-21", due: "2026-07-22" }),
  ]);
  const gm = ganttModel({ index: idx, sprints: SPRINTS, sprint: "S1", project: "all", now: NOW });
  const x1 = gm.rows.find((r) => r.id === "A-1").x;
  const x2 = gm.rows.find((r) => r.id === "A-2").x;
  // EXACT anchors — a constant-x layout or a wrong offset breaks these.
  assert.equal(x1, 224); // 07-20 = day 8 * 28
  assert.equal(x2, 252); // 07-21 = day 9 * 28
  assert.ok(x2 > x1, "later start → greater x");
});

// ---- nowX in / out of range ------------------------------------------------

test("ganttModel: nowX is a number when now is inside the axis", () => {
  const gm = ganttModel({ index: fullIdx([R({ id: "A-1" })]), sprints: SPRINTS, sprint: "S1", project: "all", now: NOW });
  assert.equal(gm.nowX, X("2026-07-20")); // 224
});

test("ganttModel: nowX is null when now is outside the axis range", () => {
  const gm = ganttModel({ index: fullIdx([R({ id: "A-1" })]), sprints: SPRINTS, sprint: "S1", project: "all", now: D("2026-09-01") });
  assert.equal(gm.nowX, null);
});

test("ganttModel: nowX is null when now is before the axis start", () => {
  const gm = ganttModel({ index: fullIdx([R({ id: "A-1" })]), sprints: SPRINTS, sprint: "S1", project: "all", now: D("2026-01-01") });
  assert.equal(gm.nowX, null);
});

// ---- groups ----------------------------------------------------------------

test("ganttModel: two rows under different epics → two groups; same epic → one", () => {
  const idx2 = fullIdx([R({ id: "A-1", parent: "E-1" }), R({ id: "A-2", parent: "E-2" }), { id: "E-1", type: "epic", title: "Epic One", status: "defined", parent: null, project: "A", sprint: null, start: null, due: null, assignee: "unassigned" }, { id: "E-2", type: "epic", title: "Epic Two", status: "defined", parent: null, project: "A", sprint: null, start: null, due: null, assignee: "unassigned" }]);
  const g2 = ganttModel({ index: idx2, sprints: SPRINTS, sprint: "S1", project: "all", now: NOW });
  assert.deepEqual(g2.groups.map((x) => x.epicId).sort(), ["E-1", "E-2"]);
  assert.equal(g2.groups.find((x) => x.epicId === "E-1").title, "Epic One");

  const idx1 = fullIdx([R({ id: "A-1", parent: "E-1" }), R({ id: "A-2", parent: "E-1" })]);
  const g1 = ganttModel({ index: idx1, sprints: SPRINTS, sprint: "S1", project: "all", now: NOW });
  assert.deepEqual(g1.groups.map((x) => x.epicId), ["E-1"]);
});

// ---- determinism -----------------------------------------------------------

test("ganttModel: deterministic (same input → identical output)", () => {
  const idx = fullIdx([
    R({ id: "A-2", parent: "E-1", start: "2026-07-15" }),
    R({ id: "A-1", parent: "E-1", start: "2026-07-14" }),
    R({ id: "A-3", parent: "E-2" }),
  ]);
  const args = { index: idx, sprints: SPRINTS, sprint: "S1", project: "all", now: NOW };
  assert.deepEqual(ganttModel(args), ganttModel(args));
});
