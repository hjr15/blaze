// tests/verbs-read-through-seam.test.mjs — BLZ-670. Every verb ignored `opts.readStorage` for
// its ticket lookup: locateTicket was called without it, so it always walked the files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memReadStorage } from "../scripts/model/read-storage.mjs";
import { applyMove } from "../scripts/move.mjs";
import { applyEdit } from "../scripts/edit.mjs";
import { applyLog } from "../scripts/log.mjs";
import { applyResolve } from "../scripts/resolve.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
function emptyBoard() {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz670-verbs-")));
  const projectsDir = join(dataRoot, "projects");
  mkdirSync(join(projectsDir, "ENG", "defined"), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"), JSON.stringify({ projects: ["ENG"], schemaVersion: 2 }));
  writeFileSync(join(projectsDir, "ENG", "project.json"), JSON.stringify({ key: "ENG", components: [], labels: [] }));
  return projectsDir;
}
const rec = (status) => ({ frontmatter: { id: "ENG-1", title: "t", type: "task", project: "ENG",
  priority: "medium", assignee: "unassigned", estimate: 30, created: "2026-01-01", updated: "2026-01-01",
  links: [], worklog: [] }, body: "## Acceptance Criteria\n\n- [ ] one\n", project: "ENG", status, file: "ENG-1" });
function capturingPort() {
  const seen = [];
  return { seen, port: { name: "capture",
    async move(t) { seen.push(["move", t]); return { file: "ENG-1", fromFile: "ENG-1" }; },
    async write(t) { seen.push(["write", t]); return { file: "ENG-1" }; },
    async read() { return null; }, async exists() { return true; }, close() {} } };
}

test("applyMove resolves the ticket through the injected reader", async () => {
  const { port, seen } = capturingPort();
  const r = await applyMove(emptyBoard(), "ENG-1", "in-review",
    { readStorage: memReadStorage([rec("in-progress")]), writePort: port, requireWorklog: false });
  assert.equal(r.ok, true, r.errors?.join("; "));
  assert.equal(r.from, "in-progress");
  assert.equal(seen[0][0], "move");
});

test("applyEdit finds a ticket only the reader holds", async () => {
  const { port } = capturingPort();
  const r = await applyEdit(emptyBoard(), "ENG-1", { priority: "high" },
    { readStorage: memReadStorage([rec("defined")]), writePort: port });
  assert.equal(r.ok, true, r.errors?.join("; "));
});

test("applyLog and applyResolve find a ticket only the reader holds", async () => {
  // The implementer fills these two calls from the REAL signatures: `sed -n 10,16p scripts/log.mjs`
  // and `sed -n 10,16p scripts/resolve.mjs`. The assertion is fixed: not "ticket not found".
  const P = emptyBoard();
  for (const call of [
    (o) => applyLog(P, "ENG-1", 30, o),
    (o) => applyResolve(P, "ENG-1", "wont-do", o),
  ]) {
    const { port } = capturingPort();
    const r = await call({ readStorage: memReadStorage([rec("defined")]), writePort: port });
    assert.doesNotMatch((r.errors ?? []).join(" "), /ticket not found/);
  }
});
