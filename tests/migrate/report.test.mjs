// tests/migrate/report.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAudit, renderLedger } from "../../scripts/migrate/report.mjs";

const DISPS = [
  { id: "OBA-1", type: "goal", disposition: "keep", reason: "in-flight", proposed_status: "in-progress", proposed_parent: null },
  { id: "OBA-2", type: "task", disposition: "drop", reason: "resolution: Won't Do", proposed_status: null, proposed_parent: null },
  { id: "OBA-3", type: "task", disposition: "merge-into:OBA-1", reason: "duplicate of OBA-1", proposed_status: null, proposed_parent: null },
];
const NORMS = DISPS.map((d) => ({ key: d.id, project: "OBA", type: d.type, summary: d.id }));
const RESTRUCTURE = { parents: new Map(), flags: { orphans: ["OBA-9"], misLevelled: [], ambiguous: [], relatesNormalised: ["OBA-3"] } };

test("renderLedger wraps the dispositions with a source count", () => {
  const ledger = renderLedger(DISPS, { OBA: 3 });
  assert.deepEqual(ledger.source, { OBA: 3 });
  assert.equal(ledger.items.length, 3);
});

test("renderAudit lists counts, the drop list, the merge list, and flags", () => {
  const md = renderAudit({ norms: NORMS, dispositions: DISPS, restructure: RESTRUCTURE, warnings: ["OBA-1: unmapped status 'X'"] });
  assert.match(md, /# Migration Audit/i);
  assert.match(md, /kept/i); assert.match(md, /dropped/i); assert.match(md, /merged/i);
  assert.match(md, /OBA-2.*Won't Do/);              // drop list entry
  assert.match(md, /OBA-3.*OBA-1/);                 // merge list entry
  assert.match(md, /OBA-9/);                        // orphan flag
  assert.match(md, /unmapped status/);              // warning surfaced
});

// FIX 4: Link-integrity section in renderAudit
test("renderAudit includes a Link integrity section with rewrite + drop entries", () => {
  const integrity = {
    rewritten: [{ on: "OBA-4", from: "OBA-3", to: "OBA-1", type: "Blocks" }],
    dropped:   [{ on: "OBA-4", target: "GONE-99", type: "Relates", reason: "target not written" }],
  };
  const md = renderAudit({ norms: NORMS, dispositions: DISPS, restructure: RESTRUCTURE, integrity });
  assert.match(md, /## Link integrity/i);
  assert.match(md, /OBA-4.*Blocks.*OBA-3.*OBA-1/);       // rewrite line
  assert.match(md, /OBA-4.*Relates.*GONE-99.*target not written/);  // drop line
});

test("renderAudit renders _none_ in Link integrity when both lists are empty", () => {
  const md = renderAudit({ norms: NORMS, dispositions: DISPS, restructure: RESTRUCTURE });
  assert.match(md, /## Link integrity/i);
  // After the section header there should be _none_
  const afterSection = md.slice(md.indexOf("## Link integrity"));
  assert.match(afterSection, /_none_/);
});

test("renderAudit still passes without integrity argument (defaults to empty)", () => {
  // This is the regression guard — existing callers that omit integrity must still work
  const md = renderAudit({ norms: NORMS, dispositions: DISPS, restructure: RESTRUCTURE, warnings: [] });
  assert.match(md, /# Migration Audit/i);
  assert.match(md, /## Link integrity/i);
});
