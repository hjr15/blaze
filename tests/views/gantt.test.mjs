import { test } from "node:test";
import assert from "node:assert/strict";
import { ganttModel } from "../../scripts/model/gantt.mjs";
import { render, styles, clientScript } from "../../scripts/views/gantt.mjs";

function fullIdx(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { rows, links: [], get: (id) => byId.get(id) };
}
const D = (iso) => Date.parse(iso + "T00:00:00Z");
const SPRINTS = { active: "S1", sprints: [
  { id: "S1", name: "Mid-July", start: "2026-07-13", end: "2026-07-26" },
  { id: "S2", name: "Late-July", start: "2026-07-27", end: "2026-08-09" },
] };
const NOW = D("2026-07-20");
const GUTTER = 220;

const EPIC = { id: "E-1", type: "epic", title: "Epic One", status: "defined", parent: null, project: "A", sprint: null, start: null, due: null, assignee: "unassigned" };
const row = (o) => ({
  id: o.id, project: "A", type: o.type ?? "task", title: o.title ?? o.id,
  status: o.status ?? "defined", parent: o.parent ?? null, assignee: o.assignee ?? "unassigned",
  sprint: "S1", start: o.start ?? null, due: o.due ?? null,
});

function gmFixture(now = NOW) {
  const idx = fullIdx([
    EPIC,
    row({ id: "A-1", parent: "E-1", start: "2026-07-20", due: "2026-07-22", status: "in-progress" }),
    row({ id: "A-2", parent: "E-1", status: "in-review", assignee: "ryan" }),
    row({ id: "B-1", status: "done", start: "2026-07-15", due: "2026-07-18" }),
  ]);
  return ganttModel({ index: idx, sprints: SPRINTS, sprint: "S1", project: "all", now });
}

test("render: contract — returns a string with the gantt SVG", () => {
  const html = render(gmFixture());
  assert.equal(typeof html, "string");
  assert.match(html, /class="ganttwrap"/);
  assert.match(html, /<svg[^>]*class="gantt"/);
});

test("render: a bar <rect> carries data-id and the model's EXACT x + width (gutter-offset)", () => {
  const html = render(gmFixture());
  // A-1 solid: model x=224, w=84 → rendered at GUTTER+224=444.
  const re = new RegExp(`<rect[^>]*data-id="A-1"[^>]*`);
  const m = html.match(re);
  assert.ok(m, "A-1 bar rect present");
  assert.match(html, new RegExp(`data-id="A-1"[^>]*x="${GUTTER + 224}"`));
  assert.match(html, new RegExp(`data-id="A-1"[^>]*width="84"`));
});

test("render: the today-marker renders at nowX and is absent when now is outside range", () => {
  const withNow = render(gmFixture(NOW));
  assert.match(withNow, /class="today"/);
  // today line x = GUTTER + nowX(224) = 444
  assert.match(withNow, new RegExp(`class="today"[^>]*x1="${GUTTER + 224}"`));

  const outside = render(gmFixture(D("2026-09-01")));
  assert.doesNotMatch(outside, /class="today"/);
});

test("render: sprint-picker renders one pill per sprint with the active one marked", () => {
  const html = render(gmFixture());
  assert.match(html, /data-sprint="S1"/);
  assert.match(html, /data-sprint="S2"/);
  // S1 is selected → carries the "on" class; S2 does not.
  assert.match(html, /class="gpill on"[^>]*data-sprint="S1"/);
  assert.doesNotMatch(html, /class="gpill on"[^>]*data-sprint="S2"/);
});

test("render: gutter shows id · title · assignee (assignee only when not unassigned)", () => {
  const html = render(gmFixture());
  assert.match(html, /A-2/);
  assert.match(html, /ryan/);            // A-2 assignee shown
  // A-1 is unassigned → no '· unassigned' text
  assert.doesNotMatch(html, /unassigned/);
});

test("render: a group-header row renders per distinct parent epic", () => {
  const html = render(gmFixture());
  assert.match(html, /Epic One/);
  assert.match(html, /class="ghead"/);
});

test("render: status drives the bar fill (done dim / in-progress+in-review solid / defined outline)", () => {
  const html = render(gmFixture());
  // done bar (B-1) is dimmed via fill-opacity; in-progress (A-1) solid; in-review (A-2) solid.
  assert.match(html, new RegExp(`data-id="B-1"[^>]*fill-opacity="0.35"`));
  assert.match(html, new RegExp(`data-id="A-1"[^>]*fill="#3fb950"`)); // task colour, solid
});

test("render: empty model shows a create-a-sprint prompt, not a frame", () => {
  const gm = ganttModel({ index: fullIdx([]), sprints: { active: null, sprints: [] }, sprint: null, project: "all", now: NOW });
  const html = render(gm);
  assert.match(html, /no-data/);
  assert.doesNotMatch(html, /<svg[^>]*class="gantt"/);
});

test("styles + clientScript are non-empty strings wired to blazePanel and ?sprint", () => {
  assert.equal(typeof styles, "string");
  assert.ok(styles.length > 0);
  assert.match(clientScript, /blazePanel\.open/);
  assert.match(clientScript, /sprint/);
});
