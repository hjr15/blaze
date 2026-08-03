// INF-762 — a terminal move must not silently overwrite a resolution.
//
// `planMove` set `resolution` unconditionally on every move: the configured
// default on entering a terminal status, `null` otherwise. That defeats the house
// process bar, which mandates `blaze resolve` for non-Done outcomes — the natural
// reading (resolve, then move to terminal) produced exactly the wrong result:
//
//   blaze resolve  X cannot-reproduce   ->  resolution: cannot-reproduce
//   blaze move     X in-review          ->  CLEARED (non-terminal move)
//   blaze move     X done               ->  resolution: done        <- silently
//
// Exit 0, no warning, and the move even prints the resolution it just clobbered.
// Bugs cannot go in-progress -> done directly, so the `in-review` hop is
// mandatory, which makes the clobbering move unavoidable on the sanctioned path.
//
// Consequence: every ticket closed as wont-do / duplicate / cannot-reproduce via
// the documented order was recorded as `done`, erasing the distinction between
// "we fixed it" and "it never reproduced".

import { test } from "node:test";
import assert from "node:assert/strict";
import { planMove } from "../scripts/model/move-plan.mjs";

const ticket = (resolution) => ({
  frontmatter: { id: "PROJ-1", type: "bug", ...(resolution !== undefined ? { resolution } : {}) },
  body: "body",
});

test("INF-762: a terminal move preserves a resolution already set by `blaze resolve`", () => {
  const r = planMove(ticket("cannot-reproduce"), "in-review", "done");
  assert.equal(r.ok, true);
  assert.equal(r.frontmatter.resolution, "cannot-reproduce",
    "the deliberate resolution must survive the terminal move");
});

test("INF-762: the mandatory in-review hop does not clear a resolution", () => {
  // The first half of the trap: a non-terminal move wiped it before `done` even
  // ran, so preserving only on the terminal move would still lose it.
  const r = planMove(ticket("wont-do"), "in-progress", "in-review");
  assert.equal(r.ok, true);
  assert.equal(r.frontmatter.resolution, "wont-do",
    "moving between non-terminal statuses must not discard a set resolution");
});

test("INF-762: the full documented sequence keeps the resolution end to end", () => {
  const afterHop = planMove(ticket("duplicate"), "in-progress", "in-review");
  const afterDone = planMove({ frontmatter: { ...afterHop.frontmatter }, body: "b" }, "in-review", "done");
  assert.equal(afterDone.frontmatter.resolution, "duplicate",
    "resolve -> move in-review -> move done must end as `duplicate`, not `done`");
});

test("INF-762: a terminal move with NO resolution set still defaults to done", () => {
  // The common case must keep working — this is the convenience the fix must not cost.
  const r = planMove(ticket(undefined), "in-review", "done");
  assert.equal(r.frontmatter.resolution, "done");
});

test("INF-762: an empty-string resolution counts as unset and takes the default", () => {
  // `blaze new` writes `resolution: ` (blank), which must not be mistaken for a
  // deliberate choice and block the default.
  assert.equal(planMove(ticket(""), "in-review", "done").frontmatter.resolution, "done");
  assert.equal(planMove(ticket("   "), "in-review", "done").frontmatter.resolution, "done");
});

test("INF-762: REOPENING out of a terminal status still clears the resolution", () => {
  // Preservation must not make a stale `done` sticky through a reopen — that is
  // how a repaired ticket would keep claiming it was finished.
  const r = planMove(ticket("done"), "done", "defined");
  assert.equal(r.frontmatter.resolution, null,
    "leaving a terminal status must clear the resolution");
});

test("INF-762: reopening clears a non-done resolution too", () => {
  // `done -> defined` is the only legal reopen for a bug; `done -> in-progress`
  // and `done -> in-review` are rejected by validateTransition.
  const r = planMove(ticket("cannot-reproduce"), "done", "defined");
  assert.equal(r.ok, true);
  assert.equal(r.frontmatter.resolution, null);
});
