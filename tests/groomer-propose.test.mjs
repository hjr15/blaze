// tests/groomer-propose.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, isStructuralChange } from "../scripts/loops/groomer.mjs";

test("groomer prompt instructs propose-only, no transition", () => {
  const ticket = { id: "OBA-1", type: "task", title: "t", body: "## Acceptance Criteria\n", file: "x" };
  const p = buildPrompt(ticket, "", { });
  assert.match(p, /propose/i);
  assert.match(p, /Notes/);
  assert.match(p, /do not.*(status|transition|resolution|move)/i);
});

const FM_BASE = "---\nid: TASK-001\ntitle: x\nstatus: backlog\nresolution: \n---\nbody\n";

test("isStructuralChange: status frontmatter changed → true", () => {
  const after = FM_BASE.replace("status: backlog", "status: done");
  assert.equal(isStructuralChange(FM_BASE, after), true);
});

test("isStructuralChange: resolution frontmatter changed → true", () => {
  const after = FM_BASE.replace("resolution: ", "resolution: Done");
  assert.equal(isStructuralChange(FM_BASE, after), true);
});

test("isStructuralChange: body-only change, frontmatter identical → false", () => {
  const after = FM_BASE.replace("body\n", "body\n\n## Notes\nGroomer proposals\n");
  assert.equal(isStructuralChange(FM_BASE, after), false);
});

test("isStructuralChange: frontmatter present before, stripped after → true", () => {
  const after = "just a body with no frontmatter\n";
  assert.equal(isStructuralChange(FM_BASE, after), true);
});

test("isStructuralChange: duplicate status key with different value appended → true (parser-based)", () => {
  // The original status: backlog is kept, but a second status: done is appended.
  // A first-match regex would see 'backlog' in both, missing the mutation;
  // the real parser's last-write-wins on repeated keys exposes the change.
  const after = FM_BASE.replace(
    "resolution: \n---",
    "resolution: \nstatus: done\n---",
  );
  assert.equal(isStructuralChange(FM_BASE, after), true);
});
