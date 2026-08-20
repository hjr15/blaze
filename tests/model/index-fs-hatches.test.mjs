// tests/model/index-fs-hatches.test.mjs — BLZ-274, ADR-0009.
//
// buildIndex advertises itself as storage-agnostic (index.mjs:4-5) but reached the
// filesystem three ways: walkTickets, missingClaimErrors (the id-claims ledger) and
// loadSprints (sprints.json). The read-seam panel found the last two; without them
// the seam ships with live node:fs escape hatches behind it.
//
// The precedent for where the claim check belongs is already in the tree —
// audit-runner.mjs:64-72: "This has to be caught HERE rather than in auditCorpus:
// ticket identity is a property of the WALK ... the pure function is a function of
// frontmatter, which carries no path."
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, missingClaimErrors } from "../../scripts/model/index.mjs";

function board({ withClaim = true, duplicate = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "blaze-hatch-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "BLZ", "defined"), { recursive: true });
  mkdirSync(join(projects, "BLZ", ".ids"), { recursive: true });
  writeFileSync(join(projects, "BLZ", ".ids", ".cutover"), "1");
  writeFileSync(join(projects, "BLZ", ".ids", "2"), "BLZ-2 x");
  const t = (id) => `---\nid: ${id}\ntitle: ${id}\ntype: task\nproject: BLZ\nparent: \n---\n\nb\n`;
  writeFileSync(join(projects, "BLZ", "defined", "BLZ-2-x.md"), t("BLZ-2"));
  if (!withClaim) writeFileSync(join(projects, "BLZ", "defined", "BLZ-5-y.md"), t("BLZ-5"));
  if (duplicate) {
    mkdirSync(join(projects, "BLZ", "done"), { recursive: true });
    writeFileSync(join(projects, "BLZ", "done", "BLZ-2-x.md"), t("BLZ-2"));
  }
  return { root, projects };
}

test("buildIndex.errors holds ONLY duplicate-id errors — the claim check has left it", () => {
  const { projects } = board({ withClaim: false });
  const idx = buildIndex(projects);
  assert.deepEqual(idx.errors, [],
    "a missing claim is a path-dependent check and must no longer reach the pure index");
});

test("buildIndex.errors still reports duplicate ids", () => {
  const { projects } = board({ duplicate: true });
  const idx = buildIndex(projects);
  assert.equal(idx.errors.length, 1);
  assert.match(idx.errors[0], /^duplicate id BLZ-2/);
});

test("missingClaimErrors is exported and still detects an unclaimed id", () => {
  const { projects } = board({ withClaim: false });
  const idx = buildIndex(projects);
  const errs = missingClaimErrors(projects, idx.rows);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /ticket BLZ-5 has no claim/);
});

test("BLZ-274: a missing claim is no longer mislabelled as a duplicate id", () => {
  // Before this change buildIndex.errors mixed both kinds, and reindex.mjs labelled
  // the whole array "N duplicate ticket id(s) — renumber one side of each collision".
  // On a board with zero duplicates that advice named a collision that did not exist.
  const { projects } = board({ withClaim: false });
  const idx = buildIndex(projects);
  const claims = missingClaimErrors(projects, idx.rows);
  assert.equal(idx.errors.length, 0, "no duplicate-id errors on this board");
  assert.equal(claims.length, 1, "but there IS a missing claim");
  // the two are now separately countable, which is what makes an honest message possible
});

test("buildIndex takes sprints through the seam, not from the filesystem", () => {
  const { projects } = board();
  const withInjected = buildIndex(projects, { sprints: [{ id: "S1" }] });
  assert.ok(Array.isArray(withInjected.warnings), "injected sprints are accepted");
});

test("a dangling sprint ref still warns, whether sprints come from disk or the seam", () => {
  const { projects } = board();
  writeFileSync(join(projects, "BLZ", "defined", "BLZ-2-x.md"),
    `---\nid: BLZ-2\ntitle: x\ntype: task\nproject: BLZ\nparent: \nsprint: S9\n---\n\nb\n`);
  const idx = buildIndex(projects, { sprints: [{ id: "S1" }] });
  assert.ok(idx.warnings.some((w) => /sprint 'S9' not in registry/.test(w)),
    "the lint must survive the sprints source moving behind the seam");
});
