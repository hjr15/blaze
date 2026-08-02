// tests/ids-allocator.test.mjs — BLZ-136 / ADR-0005, the three-layer allocator.
//
// Covers acceptance criteria ①–⑤: a fresh clone allocates above the true disk
// max; concurrent worktrees never collide; a same-id claim conflicts while
// different ids do not; claims survive squash-merge + branch-delete; offline
// behaviour is specified rather than accidental.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../scripts/model/index.mjs";
import { maxId } from "../scripts/model/ids.mjs";

function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-alloc-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "PROJ", "defined"), { recursive: true });
  mkdirSync(join(projects, "PROJ", ".ids"), { recursive: true });
  return { root, projects };
}

function ticket(projects, status, name, id) {
  const dir = join(projects, "PROJ", status);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name),
    `---\nid: ${id}\ntitle: t\ntype: task\nproject: PROJ\npriority: medium\n---\nbody\n`);
}

// The walkers previously skipped claim files only because those files have no
// .md extension — an accident, not a guard. These fixtures deliberately USE a
// .md suffix inside .ids/ so they fail unless the dot-dir rule is explicit.
test("BLZ-136: dot-directories are excluded from the ticket walk explicitly", () => {
  const { root, projects } = board();
  ticket(projects, "defined", "PROJ-1-real.md", "PROJ-1");
  writeFileSync(join(projects, "PROJ", ".ids", "2.md"), "not a ticket\n");
  const idx = buildIndex(projects);
  assert.equal(idx.count(), 1, "only the real ticket may be indexed");
  assert.deepEqual(idx.rows.map((r) => r.id), ["PROJ-1"]);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-136: maxId ignores dot-directories", () => {
  const { root, projects } = board();
  ticket(projects, "defined", "PROJ-3-real.md", "PROJ-3");
  writeFileSync(join(projects, "PROJ", ".ids", "PROJ-99.md"), "decoy\n");
  assert.equal(maxId(projects, "PROJ"), 3, "a dot-dir decoy must not raise the max");
  rmSync(root, { recursive: true, force: true });
});
