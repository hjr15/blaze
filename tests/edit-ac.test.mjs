import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyToggleAc } from "../scripts/edit.mjs";

function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), "blaze-ac-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    `---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\n---\n${body}\n`);
  return { root, projects };
}

const BODY = `## Context\nsome text with - [ ] a decoy not under AC\n## Acceptance Criteria\n- [ ] first\n- [x] second\n- [ ] third\n## Notes\ntail\n`;

test("applyToggleAc checks the target AC line and leaves the rest intact", () => {
  const { root, projects } = fixture(BODY);
  const r = applyToggleAc(projects, "OBA-1", { index: 0, checked: true }, {});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const text = readFileSync(r.file, "utf8");
  assert.match(text, /- \[x\] first/);
  assert.match(text, /- \[x\] second/);      // untouched
  assert.match(text, /- \[ \] third/);        // untouched
  assert.match(text, /- \[ \] a decoy not under AC/); // decoy above AC untouched
  rmSync(root, { recursive: true, force: true });
});

test("applyToggleAc unchecks index 1", () => {
  const { root, projects } = fixture(BODY);
  const r = applyToggleAc(projects, "OBA-1", { index: 1, checked: false }, {});
  assert.equal(r.ok, true);
  assert.match(readFileSync(r.file, "utf8"), /- \[ \] second/);
  rmSync(root, { recursive: true, force: true });
});

test("applyToggleAc rejects an out-of-range index with no write", () => {
  const { root, projects } = fixture(BODY);
  const before = readFileSync(join(projects, "OBA", "defined", "OBA-1.md"), "utf8");
  const r = applyToggleAc(projects, "OBA-1", { index: 9, checked: true }, {});
  assert.equal(r.ok, false);
  assert.equal(readFileSync(join(projects, "OBA", "defined", "OBA-1.md"), "utf8"), before);
  rmSync(root, { recursive: true, force: true });
});

test("applyToggleAc rejects when there is no AC section", () => {
  const { root, projects } = fixture("## Context\nno criteria here\n");
  const r = applyToggleAc(projects, "OBA-1", { index: 0, checked: true }, {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /acceptance criteria/i.test(e)));
  rmSync(root, { recursive: true, force: true });
});
