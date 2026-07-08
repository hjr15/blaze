import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../../scripts/model/index.mjs";
import { parseTicket } from "../../scripts/model/ticket.mjs";
import { panelModel, panelContentHtml } from "../../scripts/views/panel-content.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-panel-"));
  mkdirSync(join(dir, "T", "in-progress"), { recursive: true });
  mkdirSync(join(dir, "T", "defined"), { recursive: true });
  writeFileSync(join(dir, "T", "in-progress", "T-1.md"),
    "---\nid: T-1\ntitle: Parent epic\ntype: epic\nproject: T\nassignee: ryan\nlinks:\n  - { type: Blocks, target: T-9 }\n---\n## Acceptance Criteria\n- [ ] one\n\nBody **text**.\n");
  writeFileSync(join(dir, "T", "defined", "T-2.md"),
    "---\nid: T-2\ntitle: Child task\ntype: task\nproject: T\nparent: T-1\n---\nchild body\n");
  return dir;
}

const read = (dir, status, id) =>
  parseTicket(readFileSync(join(dir, "T", status, `${id}.md`), "utf8"));

test("panelModel resolves meta, rendered body, children and links", () => {
  const dir = fixture();
  const index = buildIndex(dir);
  const m = panelModel(index, "T-1", read(dir, "in-progress", "T-1"));
  rmSync(dir, { recursive: true, force: true });
  assert.equal(m.id, "T-1");
  assert.equal(m.meta.title, "Parent epic");
  assert.match(m.bodyHtml, /<strong>text<\/strong>/);      // markdown rendered
  assert.match(m.bodyHtml, /data-ac-index/);               // AC checkboxes stay live
  assert.equal(m.parent, null);                            // T-1 is a root
  assert.deepEqual(m.children.map((c) => c.id), ["T-2"]);
  assert.deepEqual(m.links, [{ type: "Blocks", target: "T-9" }]);
});

test("panelModel resolves a child's parent breadcrumb", () => {
  const dir = fixture();
  const index = buildIndex(dir);
  const m = panelModel(index, "T-2", read(dir, "defined", "T-2"));
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(m.parent, { id: "T-1", title: "Parent epic" });
  assert.deepEqual(m.children, []);
});

test("panelModel returns null for an unknown id", () => {
  const dir = fixture();
  const index = buildIndex(dir);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(panelModel(index, "NOPE", null), null);
});

test("panelContentHtml renders description, a full frontmatter table, children and links (escaped)", () => {
  const dir = fixture();
  const index = buildIndex(dir);
  const html = panelContentHtml(panelModel(index, "T-1", read(dir, "in-progress", "T-1")));
  rmSync(dir, { recursive: true, force: true });
  assert.match(html, /Parent epic/);                       // title
  assert.match(html, /data-ticket="T-1"/);                 // AC-toggle hook wraps the body
  assert.match(html, /data-ac-index/);                     // live AC checkbox
  assert.match(html, /assignee/);                          // frontmatter table row
  assert.match(html, /T-2/);                               // child listed
  assert.match(html, /Blocks/);                            // link type shown
});

test("panelContentHtml on a null model shows a not-found state (no crash)", () => {
  assert.match(panelContentHtml(null), /not found/i);
});
