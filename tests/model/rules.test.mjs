// tests/model/rules.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTicket } from "../../scripts/model/rules.mjs";

const t = (fm, body = "body") => ({ frontmatter: fm, body });

test("valid task with an epic parent passes", () => {
  const epic = t({ id: "OBA-1", type: "epic" });
  const task = t({ id: "OBA-2", type: "task", title: "x", estimate: 30, parent: "OBA-1" });
  assert.deepEqual(validateTicket(task, (id) => (id === "OBA-1" ? epic : null)), []);
});

test("missing required field is reported", () => {
  const task = t({ id: "OBA-2", type: "task", title: "x", parent: "OBA-1" });
  const errs = validateTicket(task, () => t({ id: "OBA-1", type: "epic" }));
  assert.ok(errs.some((e) => /missing required: estimate/.test(e)));
});

test("missing body fails the description requirement", () => {
  const goal = { frontmatter: { id: "OBA-9", type: "goal", title: "x" }, body: "  " };
  assert.ok(validateTicket(goal).some((e) => /description/.test(e)));
});

test("invalid parent type is rejected", () => {
  const goal = t({ id: "OBA-1", type: "goal" });
  const task = t({ id: "OBA-2", type: "task", title: "x", estimate: 30, parent: "OBA-1" });
  const errs = validateTicket(task, () => goal);
  assert.ok(errs.some((e) => /invalid parent/.test(e)));
});

test("missing parent target is reported", () => {
  const task = t({ id: "OBA-2", type: "task", title: "x", estimate: 30, parent: "OBA-99" });
  assert.ok(validateTicket(task, () => null).some((e) => /parent not found/.test(e)));
});

test("parent cycle is detected", () => {
  const a = t({ id: "A", type: "task", title: "x", estimate: 5, parent: "B" });
  const b = t({ id: "B", type: "task", title: "x", estimate: 5, parent: "A" });
  const lookup = (id) => (id === "A" ? a : id === "B" ? b : null);
  assert.ok(validateTicket(a, lookup).some((e) => /cycle/.test(e)));
});

test("parent cycle is detected across three nodes", () => {
  const mk = (id, parent) => ({ frontmatter: { id, type: "task", title: "x", estimate: 5, parent }, body: "b" });
  const a = mk("A", "B"), b = mk("B", "C"), c = mk("C", "A");
  const lookup = (id) => ({ A: a, B: b, C: c }[id] ?? null);
  assert.ok(validateTicket(a, lookup).some((e) => /cycle/.test(e)));
});

test("self-parent is detected as a cycle", () => {
  const a = { frontmatter: { id: "A", type: "task", title: "x", estimate: 5, parent: "A" }, body: "b" };
  assert.ok(validateTicket(a, (id) => (id === "A" ? a : null)).some((e) => /cycle/.test(e)));
});
