import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardModel } from "../../scripts/views/data.mjs";

test("boardModel groups tickets into status columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-data-"));
  mkdirSync(join(dir, "T", "todo"), { recursive: true });
  writeFileSync(join(dir, "T", "todo", "T-1.md"),
    "---\nid: T-1\ntitle: t\ntype: task\nproject: T\nestimate: 5\n---\nbody\n");
  const m = boardModel(dir, { project: "all" });
  assert.equal(m.total, 1);
  assert.ok(m.columns.some((c) => c.dir === "todo" && c.tickets.length === 1));
});
