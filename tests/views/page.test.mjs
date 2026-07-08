import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageHtml, CSRF } from "../../scripts/views/page.mjs";

test("page.mjs exports CSRF and a composing pageHtml", () => {
  assert.equal(typeof CSRF, "string");
  const html = pageHtml({ project: "all" });
  // shared chrome present
  assert.match(html, /window\.__csrf/);
  assert.match(html, /blazePost/);
  assert.match(html, /id="toast"/);
  assert.match(html, /"urgent"/);            // injected PRIORITIES
  // each view section wired
  assert.match(html, /class="board"/);
  assert.match(html, /class="list"/);
  assert.match(html, /class="live"/);
  assert.match(html, /id="blaze-panel"/);
  assert.match(html, /window\.blazePanel/);
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
