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
