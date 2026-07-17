import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageHtml, viewEnvelope, CSRF } from "../../scripts/views/page.mjs";

test("page.mjs exports CSRF and a composing pageHtml", () => {
  assert.equal(typeof CSRF, "string");
  const html = pageHtml({ project: "all" });
  // shared chrome present
  assert.match(html, /window\.__csrf/);
  assert.match(html, /blazePost/);
  assert.match(html, /id="toast"/);
  assert.match(html, /"urgent"/);            // injected PRIORITIES
  // GET / renders only the default (board) view's markup inline
  assert.match(html, /class="board"/);
  assert.doesNotMatch(html, /class="list"/);
  assert.match(html, /id="blaze-panel"/);
  assert.match(html, /window\.blazePanel/);
});

test("viewEnvelope renders each view's markup on demand (moved out of pageHtml since it no longer inlines every view)", () => {
  const list = viewEnvelope({ project: "all", view: "list" });
  assert.match(list.html, /class="list"/);
  assert.doesNotMatch(list.html, /class="board"/);

  const map = viewEnvelope({ project: "all", view: "map" });
  assert.match(map.html, /class="mapwrap/);
  assert.doesNotMatch(map.html, /class="board"/);

  const live = viewEnvelope({ project: "all", view: "live" });
  assert.match(live.html, /class="live"/);
});

test("pageHtml({view:'map'}) falls back to board when views.map is disabled (review fix: ?view= bypass)", () => {
  const html = pageHtml({
    project: "all",
    view: "map",
    views: { board: true, list: true, live: true, metrics: true, map: false },
  });
  assert.doesNotMatch(html, /class="mapview"/);
  assert.match(html, /data-rendered="board"/);
});

test("pageHtml renders a board switcher when >1 workflow board has tickets", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-page-"));
  mkdirSync(join(dir, "INF", "identified"), { recursive: true });
  mkdirSync(join(dir, "INF", "defined"), { recursive: true });
  writeFileSync(join(dir, "INF", "identified", "INF-2.md"), "---\nid: INF-2\ntitle: r\ntype: risk\nproject: INF\n---\nx\n");
  writeFileSync(join(dir, "INF", "defined", "INF-3.md"), "---\nid: INF-3\ntitle: t\ntype: task\nproject: INF\n---\nx\n");
  const html = pageHtml({ project: "all", projectsDir: dir, now: 1751932800000, transitions: [] });
  assert.match(html, /class="boardtoggle"/);
  assert.match(html, /data-board-pill="risk"/);
});

test("pageHtml shows a breadcrumb when focused and a drill-down link on parents", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-crumb-"));
  mkdirSync(join(dir, "INF", "defined"), { recursive: true });
  writeFileSync(join(dir, "INF", "defined", "INF-9.md"), "---\nid: INF-9\ntitle: epic\ntype: epic\nproject: INF\n---\nx\n");
  writeFileSync(join(dir, "INF", "defined", "INF-10.md"), "---\nid: INF-10\ntitle: kid\ntype: task\nproject: INF\nparent: INF-9\n---\nx\n");
  const focused = pageHtml({ project: "all", projectsDir: dir, focus: "INF-9", now: 1751932800000, transitions: [] });
  assert.match(focused, /class="crumbs"/);

  const unfocused = pageHtml({ project: "all", projectsDir: dir, now: 1751932800000, transitions: [] });
  assert.doesNotMatch(unfocused, /class="crumbs"/);
  assert.match(unfocused, /href="\?focus=INF-9"/);  // epic has a child → drill-down link
});

function mapFixture() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-mapfocus-"));
  mkdirSync(join(dir, "M", "defined"), { recursive: true });
  // M-1 Blocks M-2 (M-2 downstream of M-1); M-3 Relates M-1 (related). A real
  // dependency neighbourhood, not a hierarchy — the map now renders links.
  writeFileSync(join(dir, "M", "defined", "M-1.md"), "---\nid: M-1\ntitle: goal\ntype: goal\nproject: M\nlinks:\n  - { type: Blocks, target: M-2 }\n---\nx\n");
  writeFileSync(join(dir, "M", "defined", "M-2.md"), "---\nid: M-2\ntitle: epic\ntype: epic\nproject: M\n---\nx\n");
  writeFileSync(join(dir, "M", "defined", "M-3.md"), "---\nid: M-3\ntitle: task\ntype: task\nproject: M\nlinks:\n  - { type: Relates, target: M-1 }\n---\nx\n");
  return dir;
}

test("viewEnvelope: the map renders the focused ticket's dependency neighbourhood", () => {
  const env = viewEnvelope({ view: "map", projectsDir: mapFixture(), focus: "M-1" });
  assert.match(env.html, /class="node anchor"[^>]*data-node-id="M-1"/); // anchor
  assert.match(env.html, /data-node-id="M-2"/);        // downstream (M-1 Blocks M-2)
  assert.match(env.html, /data-node-id="M-3"/);        // related (M-3 Relates M-1)
  assert.match(env.html, /data-drill="M-2"/);          // neighbour carries the re-focus affordance
  assert.doesNotMatch(env.html, /Select a ticket/);    // not the empty prompt
});

test("viewEnvelope: the map with no focus shows the pick-a-ticket prompt and ignores ?flat=1", () => {
  const dir = mapFixture();
  const top = viewEnvelope({ view: "map", projectsDir: dir });
  assert.match(top.html, /Select a ticket to see its dependencies/);
  assert.doesNotMatch(top.html, /data-node-id="M-1"/);
  // ?flat=1 no longer renders the corpus in the map — it was removed (metrics keeps flat, not the map)
  const flat = viewEnvelope({ view: "map", projectsDir: dir, flat: true });
  assert.match(flat.html, /Select a ticket to see its dependencies/);
  assert.doesNotMatch(flat.html, /data-node-id="M-3"/);
});

// Gantt reads the sprint registry from dirname(projectsDir), so the fixture is a
// real data root (root/sprints.json + root/projects/<PROJ>/<status>/).
function ganttFixture() {
  const root = mkdtempSync(join(tmpdir(), "blaze-gantt-"));
  const pDir = join(root, "projects");
  writeFileSync(join(root, "sprints.json"), JSON.stringify({
    active: "S1",
    sprints: [
      { id: "S1", name: "Mid-July", start: "2026-07-13", end: "2026-07-26" },
      { id: "S2", name: "Late-July", start: "2026-07-27", end: "2026-08-09" },
    ],
  }));
  mkdirSync(join(pDir, "G", "defined"), { recursive: true });
  writeFileSync(join(pDir, "G", "defined", "G-1.md"),
    "---\nid: G-1\ntitle: one\ntype: task\nproject: G\nsprint: S1\nstart: 2026-07-20\ndue: 2026-07-22\n---\nx\n");
  writeFileSync(join(pDir, "G", "defined", "G-2.md"),
    "---\nid: G-2\ntitle: two\ntype: task\nproject: G\nsprint: S2\nstart: 2026-07-28\ndue: 2026-07-30\n---\nx\n");
  return pDir;
}
const GANTT_NOW = Date.parse("2026-07-20T00:00:00Z");

test("viewEnvelope: the gantt renders the active sprint's bars by default", () => {
  const env = viewEnvelope({ view: "gantt", projectsDir: ganttFixture(), now: GANTT_NOW });
  assert.match(env.html, /class="ganttview"/);
  assert.match(env.html, /data-sprint="S1"/);
  assert.match(env.html, /data-id="G-1"/);          // S1 ticket present
  assert.doesNotMatch(env.html, /data-id="G-2"/);   // S2 ticket out of scope
});

test("viewEnvelope: an explicit ?sprint= selects a NON-active sprint (S2)", () => {
  const env = viewEnvelope({ view: "gantt", projectsDir: ganttFixture(), sprint: "S2", now: GANTT_NOW });
  assert.match(env.html, /class="gpill on"[^>]*data-sprint="S2"/); // S2 marked active
  assert.match(env.html, /data-id="G-2"/);          // S2 ticket now in scope
  assert.doesNotMatch(env.html, /data-id="G-1"/);   // S1 ticket out of scope
});

test("pageHtml({view:'gantt'}) falls back to board when views.gantt is disabled", () => {
  const html = pageHtml({
    project: "all",
    view: "gantt",
    views: { board: true, list: true, live: true, metrics: true, map: true, gantt: false },
  });
  assert.doesNotMatch(html, /class="ganttview"/);
  assert.match(html, /data-rendered="board"/);
});
