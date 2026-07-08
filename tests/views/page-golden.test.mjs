import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pageHtml } from "../../scripts/serve.mjs";  // re-exported from page.mjs after Task 7

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-golden-"));
  mkdirSync(join(dir, "T", "todo"), { recursive: true });
  mkdirSync(join(dir, "T", "in-review"), { recursive: true });
  writeFileSync(join(dir, "T", "todo", "T-1.md"),
    "---\nid: T-1\ntitle: fixture one\ntype: task\nproject: T\nestimate: 5\npriority: medium\nassignee: ryan\n---\n## Acceptance Criteria\n- [ ] one\n- [x] two\n## Notes\n- plain\n");
  writeFileSync(join(dir, "T", "in-review", "T-2.md"),
    "---\nid: T-2\ntitle: fixture two\ntype: epic\nproject: T\nestimate: 30\npriority: high\n---\nbody\n");
  return dir;
}
// CSRF is a per-process random UUID injected into the page — normalise it so the snapshot is deterministic.
const norm = (h) => h.replace(/window\.__csrf = "[0-9a-f-]+"/, 'window.__csrf = "CSRF"');
const goldenPath = fileURLToPath(new URL("./page-golden.html", import.meta.url));

test("pageHtml output matches the golden snapshot (byte-level; guards CSS + markup)", () => {
  const html = norm(pageHtml({ project: "all", projectsDir: fixture() }));
  if (!existsSync(goldenPath)) writeFileSync(goldenPath, html);  // first run captures the baseline
  assert.equal(html, readFileSync(goldenPath, "utf8"),
    "pageHtml output drifted from the golden snapshot — if this change is intended (e.g. Task 6 panel), delete tests/views/page-golden.html, re-run to regenerate, and review the diff.");
});
