// tests/model/move-plan.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { planMove } from "../../scripts/model/move-plan.mjs";

const tk = (extra = {}) => ({ frontmatter: { id: "OBA-1", type: "task", ...extra }, body: "b" });

test("reopen from a terminal status clears resolution to null", () => {
  const r = planMove(tk({ resolution: "done" }), "done", "defined"); // done→defined is a legal reopen
  assert.equal(r.ok, true);
  assert.equal(r.frontmatter.resolution, null);
  assert.equal(r.resolution, null);
});

test("defined → in-progress is legal and leaves resolution null", () => {
  const r = planMove(tk(), "defined", "in-progress");
  assert.equal(r.ok, true);
  assert.equal(r.frontmatter.resolution, null);
  assert.equal(r.resolution, null);
});

test("entering terminal sets resolution via post-function", () => {
  const r = planMove(tk(), "in-review", "done");
  assert.equal(r.ok, true);
  assert.equal(r.frontmatter.resolution, "done");
  assert.equal(r.resolution, "done");
});

test("risk → obsolete sets wont-do", () => {
  const r = planMove({ frontmatter: { id: "OBA-9", type: "risk" }, body: "b" }, "identified", "obsolete");
  assert.equal(r.ok, true);
  assert.equal(r.frontmatter.resolution, "wont-do");
});

test("planMove does not mutate the caller's frontmatter", () => {
  const ticket = { frontmatter: { id: "OBA-1", type: "task", resolution: "done" }, body: "b" };
  planMove(ticket, "done", "defined"); // reopen → would clear resolution on the RESULT, not the input
  assert.equal(ticket.frontmatter.resolution, "done"); // input unchanged
});

test("illegal transition fails with errors and no frontmatter", () => {
  const r = planMove(tk(), "defined", "done");
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /illegal transition/.test(e)));
  assert.equal(r.frontmatter, undefined);
});

test("requireWorklog blocks terminal entry when no worklog", () => {
  const r = planMove(tk(), "in-review", "done", { hasWorklog: false, requireWorklog: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /worklog required/.test(e)));
});
