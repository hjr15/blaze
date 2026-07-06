// tests/migrate/merge.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldMerges, extractAC, resolveLinkIntegrity } from "../../scripts/migrate/merge.mjs";

const issue = (o) => ({ key: o.key, summary: o.key, description: o.description ?? "",
  worklog: o.worklog ?? [], links: o.links ?? [] });

test("extractAC pulls checkbox lines under the AC heading", () => {
  const ac = extractAC("## Context\nx\n## Acceptance Criteria\n- [ ] one\n- [x] two\n## Notes\nn");
  assert.deepEqual(ac, ["- [ ] one", "- [x] two"]);
});

test("foldMerges carries worklog, links, a Duplicate breadcrumb, and unique AC", () => {
  const byKey = new Map([
    ["A", issue({ key: "A", description: "## Acceptance Criteria\n- [ ] shared", worklog: [{ seconds: 60 }], links: [] })],
    ["B", issue({ key: "B", description: "## Acceptance Criteria\n- [ ] shared\n- [ ] only-b",
      worklog: [{ seconds: 120 }], links: [{ type: "Blocks", target: "C" }] })],
  ]);
  const dispositions = [
    { id: "A", disposition: "keep" },
    { id: "B", disposition: "merge-into:A" },
  ];
  const { survivors, folded } = foldMerges(byKey, dispositions);
  assert.ok(folded.has("B"));
  assert.equal(survivors.has("B"), false);
  const A = survivors.get("A");
  assert.equal(A.worklog.length, 2);                                   // B's worklog carried
  assert.ok(A.links.some((l) => l.type === "Blocks" && l.target === "C"));   // B's link carried
  assert.ok(A.links.some((l) => l.type === "Duplicate" && l.target === "B")); // breadcrumb
  assert.match(A.description, /only-b/);                               // unique AC appended
  assert.equal((A.description.match(/shared/g) || []).length, 1);     // shared AC not duplicated
});

test("foldMerges excludes dropped items from survivors", () => {
  const byKey = new Map([["A", issue({ key: "A" })], ["B", issue({ key: "B" })]]);
  const { survivors } = foldMerges(byKey, [{ id: "A", disposition: "keep" }, { id: "B", disposition: "drop" }]);
  assert.ok(survivors.has("A"));
  assert.equal(survivors.has("B"), false);
});

// FIX 1: self-link guard in foldMerges
test("foldMerges does not produce a self-link when loser has a Relates link back to the survivor", () => {
  // B has a Relates link pointing back at A (common — the Relates triggered the merge decision)
  const byKey = new Map([
    ["A", issue({ key: "A", links: [] })],
    ["B", issue({ key: "B", links: [{ type: "Relates", target: "A" }] })],
  ]);
  const dispositions = [
    { id: "A", disposition: "keep" },
    { id: "B", disposition: "merge-into:A" },
  ];
  const { survivors } = foldMerges(byKey, dispositions);
  const A = survivors.get("A");
  // Must have the Duplicate breadcrumb (→ B), but NO link whose target is A itself
  assert.ok(A.links.some((l) => l.type === "Duplicate" && l.target === "B"), "breadcrumb to loser B must be present");
  assert.equal(A.links.filter((l) => l.target === "A").length, 0, "no link should target the survivor's own key");
});

// FIX 2a: resolveLinkIntegrity rewrites a Blocks→loser to Blocks→loser's survivor
test("resolveLinkIntegrity rewrites a non-Duplicate link whose target is a merged-away loser", () => {
  // C survives; it has a Blocks link → B which was merged into A.
  const survivors = new Map([
    ["A", { key: "A", links: [] }],
    ["C", { key: "C", links: [{ type: "Blocks", target: "B" }] }],
  ]);
  const dispositions = [
    { id: "A", disposition: "keep" },
    { id: "B", disposition: "merge-into:A" },
    { id: "C", disposition: "keep" },
  ];
  const { survivors: out, integrity } = resolveLinkIntegrity(survivors, dispositions);
  const C = out.get("C");
  // Blocks→B should have been rewritten to Blocks→A
  assert.ok(C.links.some((l) => l.type === "Blocks" && l.target === "A"), "Blocks→B should be rewritten to Blocks→A");
  assert.equal(C.links.filter((l) => l.target === "B").length, 0, "no residual link to merged-away B");
  assert.ok(integrity.rewritten.some((r) => r.on === "C" && r.from === "B" && r.to === "A" && r.type === "Blocks"), "rewrite logged");
});

// FIX 2b: resolveLinkIntegrity drops a Relates link to a dropped (not-in-written-ids) target
test("resolveLinkIntegrity drops a non-Duplicate link whose target is not in the written-id set", () => {
  const survivors = new Map([
    ["A", { key: "A", links: [{ type: "Relates", target: "GONE-1" }] }],
  ]);
  const dispositions = [{ id: "A", disposition: "keep" }];
  const { survivors: out, integrity } = resolveLinkIntegrity(survivors, dispositions);
  const A = out.get("A");
  assert.equal(A.links.length, 0, "dangling Relates link should be dropped");
  assert.ok(integrity.dropped.some((d) => d.on === "A" && d.target === "GONE-1" && d.reason === "target not written"), "drop logged");
});

// FIX 2c: resolveLinkIntegrity leaves Duplicate breadcrumbs intact even for merged-away targets
test("resolveLinkIntegrity preserves Duplicate breadcrumbs even when target is a merged-away id", () => {
  // A has a Duplicate breadcrumb → B (B was merged into A; B is not in survivors)
  const survivors = new Map([
    ["A", { key: "A", links: [{ type: "Duplicate", target: "B" }] }],
  ]);
  const dispositions = [
    { id: "A", disposition: "keep" },
    { id: "B", disposition: "merge-into:A" },
  ];
  const { survivors: out } = resolveLinkIntegrity(survivors, dispositions);
  const A = out.get("A");
  assert.ok(A.links.some((l) => l.type === "Duplicate" && l.target === "B"), "Duplicate breadcrumb must be kept intact");
});

// FIX 2d: resolveLinkIntegrity drops a link that becomes a self-link after rewrite
test("resolveLinkIntegrity drops a link that becomes a self-link after rewrite", () => {
  // A has a Relates→B; B was merged into A → after rewrite Relates→A = self-link → drop
  const survivors = new Map([
    ["A", { key: "A", links: [{ type: "Relates", target: "B" }] }],
  ]);
  const dispositions = [
    { id: "A", disposition: "keep" },
    { id: "B", disposition: "merge-into:A" },
  ];
  const { survivors: out, integrity } = resolveLinkIntegrity(survivors, dispositions);
  const A = out.get("A");
  assert.equal(A.links.filter((l) => l.target === "A").length, 0, "self-link after rewrite must be dropped");
  assert.ok(integrity.dropped.some((d) => d.on === "A" && d.reason === "self-link"), "self-link drop logged");
});
