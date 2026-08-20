// tests/ids-rollback.test.mjs — BLZ-136 rollback tests.
//
// These do not ask "does the feature work". They ask "does it still FAIL when it
// should". Each corresponds to a hole an adversarial pass found in ADR-0005, and
// each must be red before its guard lands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, missingClaimErrors } from "../scripts/model/index.mjs";
import { writeClaim, ensureCutover } from "../scripts/model/claims.mjs";

function boardWith(tickets, claims) {
  const root = mkdtempSync(join(tmpdir(), "blaze-rb-"));
  const projects = join(root, "projects");
  for (const [status, name, id] of tickets) {
    const dir = join(projects, "PROJ", status);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name),
      `---\nid: ${id}\ntitle: t\ntype: task\nproject: PROJ\npriority: medium\n---\nbody\n`);
  }
  for (const n of claims) writeClaim(projects, "PROJ", n, `slug${n}`);
  return { root, projects };
}

// Hole: a ticket committed without its claim — by hand, or because a merge
// strategy auto-resolved the claim away — merges as silently as it did before.
// BLZ-274 / ADR-0009 moved this check OUT of buildIndex and into the reindex runner:
// it reads the id-claims ledger off disk, so leaving it in the pure index made a
// filesystem-fed and a database-fed index return different `errors` arrays. The
// protection is unchanged — only where it is invoked. This test now asserts it where
// it lives, which is also closer to the behaviour that matters (reindex refusing).
test("BLZ-136 rollback: a ticket issued after cutover with no claim is a MISSING-CLAIM error", () => {
  const { root, projects } = boardWith([["defined", "PROJ-6-x.md", "PROJ-6"]], []);
  ensureCutover(projects, "PROJ", 5);
  const idx = buildIndex(projects);
  assert.deepEqual(idx.errors, [],
    "the pure index no longer carries path-dependent claim errors (BLZ-274)");
  const errs = missingClaimErrors(projects, idx.rows);
  assert.equal(errs.length, 1, `expected one error, got ${JSON.stringify(errs)}`);
  assert.match(errs[0], /PROJ-6/);
  assert.match(errs[0], /claim/i);
  rmSync(root, { recursive: true, force: true });
});

// `git merge -X theirs` auto-resolves the claim conflict and leaves BOTH ticket
// files. Layer 2 alone cannot stop that, so the duplicate must still be caught —
// this pins the backstop rather than assuming it.
test("BLZ-136 rollback: an auto-resolved claim conflict still leaves a loud duplicate id", () => {
  const { root, projects } = boardWith(
    [["defined", "PROJ-9-alpha.md", "PROJ-9"], ["done", "PROJ-9-beta.md", "PROJ-9"]],
    [9], // only one claim survived the -X theirs resolution
  );
  const errs = buildIndex(projects).errors;
  assert.ok(errs.some((e) => /duplicate id PROJ-9/.test(e)),
    `duplicate must still be reported, got ${JSON.stringify(errs)}`);
  rmSync(root, { recursive: true, force: true });
});

// ADR-0005 promises no backfill, so a board that predates the ledger must not
// light up with thousands of errors.
test("BLZ-136: tickets predating the claim ledger are grandfathered by the cutover", () => {
  const { root, projects } = boardWith([["defined", "PROJ-5-x.md", "PROJ-5"]], []);
  ensureCutover(projects, "PROJ", 5);
  assert.deepEqual(buildIndex(projects).errors, [], "pre-cutover tickets must not error");
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-136: a well-formed board with matching claims has no errors", () => {
  const { root, projects } = boardWith([["defined", "PROJ-1-x.md", "PROJ-1"]], [1]);
  ensureCutover(projects, "PROJ", 0);
  assert.deepEqual(buildIndex(projects).errors, []);
  rmSync(root, { recursive: true, force: true });
});

// The cutover marker only appears once a board has allocated through the new
// engine. A board that has NEVER allocated has no marker at all — and must not
// light up with one error per pre-existing ticket. Verified against a real
// 1805-ticket board, which produced 1805 false errors before this guard.
test("BLZ-136: a board with no claim ledger at all reports no missing-claim errors", () => {
  const { root, projects } = boardWith(
    [["defined", "PROJ-1-x.md", "PROJ-1"], ["done", "PROJ-900-y.md", "PROJ-900"]],
    [],
  );
  // No ensureCutover() call: the ledger has never been used for this project.
  assert.deepEqual(buildIndex(projects).errors, [],
    "an un-migrated board must be silent until its first allocation sets a cutover");
  rmSync(root, { recursive: true, force: true });
});
