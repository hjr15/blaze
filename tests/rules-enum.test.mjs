// tests/rules-enum.test.mjs — validate enum constraints on priority and resolution
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTicket } from "../scripts/model/rules.mjs";

test("validateTicket rejects invalid priority value", () => {
  const ticket = {
    frontmatter: {
      id: "OBA-1",
      title: "test ticket",
      type: "task",
      priority: "banana",
      estimate: 30,
      created: "2026-06-01",
      updated: "2026-06-01"
    },
    body: "description"
  };
  const errors = validateTicket(ticket);
  assert.ok(errors.some((e) => /invalid priority/.test(e)), `Expected invalid priority error, got: ${errors}`);
});

test("validateTicket rejects invalid resolution value", () => {
  const ticket = {
    frontmatter: {
      id: "OBA-1",
      title: "test ticket",
      type: "task",
      resolution: "nope",
      estimate: 30,
      created: "2026-06-01",
      updated: "2026-06-01"
    },
    body: "description"
  };
  const errors = validateTicket(ticket);
  assert.ok(errors.some((e) => /invalid resolution/.test(e)), `Expected invalid resolution error, got: ${errors}`);
});

test("validateTicket accepts valid priority and no resolution", () => {
  const ticket = {
    frontmatter: {
      id: "OBA-1",
      title: "test ticket",
      type: "task",
      priority: "high",
      estimate: 30,
      created: "2026-06-01",
      updated: "2026-06-01"
    },
    body: "description"
  };
  const errors = validateTicket(ticket);
  const enumErrors = errors.filter((e) => /priority|resolution/.test(e));
  assert.equal(enumErrors.length, 0, `Expected no enum errors, got: ${enumErrors}`);
});

test("validateTicket accepts valid resolution value", () => {
  const ticket = {
    frontmatter: {
      id: "OBA-1",
      title: "test ticket",
      type: "task",
      resolution: "done",
      estimate: 30,
      created: "2026-06-01",
      updated: "2026-06-01"
    },
    body: "description"
  };
  const errors = validateTicket(ticket);
  const enumErrors = errors.filter((e) => /priority|resolution/.test(e));
  assert.equal(enumErrors.length, 0, `Expected no enum errors, got: ${enumErrors}`);
});

test("validateTicket allows missing priority and resolution (optional fields)", () => {
  const ticket = {
    frontmatter: {
      id: "OBA-1",
      title: "test ticket",
      type: "task",
      estimate: 30,
      created: "2026-06-01",
      updated: "2026-06-01"
    },
    body: "description"
  };
  const errors = validateTicket(ticket);
  const enumErrors = errors.filter((e) => /priority|resolution/.test(e));
  assert.equal(enumErrors.length, 0, `Expected no enum errors, got: ${enumErrors}`);
});
