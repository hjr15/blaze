// tests/model/new-request.test.mjs — BLZ-684: `POST /api/new`'s network boundary, as a function.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newRequestOrErrors, withoutServerPaths, ticketFileNameFits, NEW_TITLE_MAX } from "../../scripts/model/new-request.mjs";

test("a well-formed body becomes applyNew's options, untouched", () => {
  assert.deepEqual(newRequestOrErrors({ project: "ENG", type: "task", title: "t", estimate: 30,
    labels: ["a"], components: ["c"], parent: "ENG-1", not_before: "2026-11-01" }, ["ENG"]),
    { request: { project: "ENG", type: "task", title: "t", priority: "medium", labels: ["a"],
                 extra: { parent: "ENG-1", not_before: "2026-11-01", components: ["c"], estimate: 30 } } });
  assert.equal(newRequestOrErrors({ project: "NEW", type: "task", title: "t" }, []).request.project, "NEW",
    "a board that configures no projects keeps blaze new's own behaviour");
});

test("every refusal is named, and they are all reported at once", () => {
  const r = newRequestOrErrors({ project: 1, type: "", title: "x".repeat(NEW_TITLE_MAX + 1),
    priority: 2, sprint: [], labels: [1], estimate: 2147483648 }, ["ENG"]);
  assert.deepEqual(r.errors, ["project must be a non-empty string", "type must be a non-empty string",
    "title is too long (300 characters max)", "priority must be a string", "sprint must be a string",
    "labels must be a list of strings", "estimate must be a number of minutes above 0"]);
  for (const body of [null, [], "x", 3]) assert.deepEqual(newRequestOrErrors(body).errors, ["the body must be a JSON object"]);
  assert.equal(newRequestOrErrors({ project: "ENG", type: "task", title: "t", estimate: 2147483645 }, ["ENG"]).request.extra.estimate, 2147483645);
  assert.equal(newRequestOrErrors({ project: "ENG", type: "task", title: "t", estimate: 7.5 }, ["ENG"]).request.extra.estimate, 7.5,
    "a fraction is passed through for applyNew to round, exactly as the local CLI's is");
  for (const e of [Infinity, NaN, -5, 0, 2147483646, "30"]) {
    assert.match(newRequestOrErrors({ project: "ENG", type: "task", title: "t", estimate: e }, ["ENG"]).errors?.[0] ?? "", /estimate must be a number/, String(e));
  }
});

test("a title is refused when its FILE NAME would not fit, before any id — 255 bytes, as a slug", () => {
  const fits = "a".repeat(255 - "ENG-9999999999-.md".length);
  assert.equal(ticketFileNameFits("ENG", fits), true);
  assert.equal(ticketFileNameFits("ENG", fits + "a"), false);
  assert.equal(ticketFileNameFits("ENG", "é".repeat(200)), true, "the slug drops what is not [a-z0-9], so bytes are judged after slugging");
  assert.deepEqual(newRequestOrErrors({ project: "ENG", type: "task", title: "x".repeat(300) }, ["ENG"]).errors,
                   ["title is too long to name the ticket's file (255 bytes max, as a slug)"]);
  assert.deepEqual(newRequestOrErrors({ project: "ENG", type: "task", title: "x".repeat(301) }, ["ENG"]).errors,
                   ["title is too long (300 characters max)"], "the 300-character cap is still its own bound");
});

test("withoutServerPaths keeps the ticket's place on the board and drops the server's filesystem", () => {
  assert.deepEqual(withoutServerPaths([
    "refusing to overwrite /srv/data/projects/ENG/defined/ENG-2-t.md",
    'link target does not resolve: "ENG-9"',
  ]), ["refusing to overwrite projects/ENG/defined/ENG-2-t.md", 'link target does not resolve: "ENG-9"']);
});
