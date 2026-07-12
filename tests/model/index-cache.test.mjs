// tests/model/index-cache.test.mjs — walkTickets parse cache: reuse on
// unchanged mtime+size, re-parse on change, and buildIndex tickets reuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkTickets, buildIndex } from "../../scripts/model/index.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-cache-"));
  mkdirSync(join(dir, "T", "todo"), { recursive: true });
  writeFileSync(join(dir, "T", "todo", "T-1.md"),
    "---\nid: T-1\ntitle: one\ntype: task\nproject: T\nestimate: 5\n---\nbody\n");
  return dir;
}

test("unchanged file yields the identical parsed object (cache hit)", () => {
  const dir = fixture();
  const a = [...walkTickets(dir)][0];
  const b = [...walkTickets(dir)][0];
  assert.equal(a.frontmatter, b.frontmatter); // same object, not a re-parse
  assert.equal(a.body, b.body);
});

test("a changed file is re-parsed (mtime/size invalidation)", () => {
  const dir = fixture();
  const before = [...walkTickets(dir)][0];
  writeFileSync(join(dir, "T", "todo", "T-1.md"),
    "---\nid: T-1\ntitle: renamed\ntype: task\nproject: T\nestimate: 5\n---\nbody2\n");
  const after = [...walkTickets(dir)][0];
  assert.notEqual(before.frontmatter, after.frontmatter);
  assert.equal(after.frontmatter.title, "renamed");
});

test("same size + forced same mtime still re-parses when content differs is NOT required — stat contract only", () => {
  // Documents the contract: invalidation key is (mtimeMs, size). Equal-size
  // writes normally bump mtime; utimesSync back-dating is out of contract.
  const dir = fixture();
  const p = join(dir, "T", "todo", "T-1.md");
  const before = [...walkTickets(dir)][0];
  writeFileSync(p, "---\nid: T-1\ntitle: two\ntype: task\nproject: T\nestimate: 5\n---\nbodyX\n"); // different size
  const after = [...walkTickets(dir)][0];
  assert.equal(after.frontmatter.title, "two");
  assert.notEqual(before.frontmatter, after.frontmatter);
});

test("mtime-only change (identical size/content) still invalidates the cache", () => {
  // Kills an `&&`→`||` mutant on the cache-hit condition: writing the exact
  // same bytes leaves size unchanged, then bumping mtime alone must still
  // force a re-parse (a `||` mutant would treat matching size as a hit).
  const dir = fixture();
  const p = join(dir, "T", "todo", "T-1.md");
  const before = [...walkTickets(dir)][0];
  const bumped = new Date(Date.now() + 5000); // comfortably past filesystem mtime resolution
  utimesSync(p, bumped, bumped);
  const after = [...walkTickets(dir)][0];
  assert.notEqual(before.frontmatter, after.frontmatter); // new object identity: cache was invalidated
  assert.equal(after.frontmatter.title, before.frontmatter.title); // content unchanged
});

test("buildIndex accepts pre-walked tickets and skips its own walk", () => {
  const dir = fixture();
  const tickets = [...walkTickets(dir)];
  const idx = buildIndex(dir, { tickets });
  assert.equal(idx.count(), 1);
  assert.equal(idx.get("T-1").title, "one");
});
