// tests/model/new-request.test.mjs — BLZ-684: `POST /api/new`'s network boundary, as a function.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    "labels must be a list of strings", "estimate must be a number of minutes above 0 and at most 2147483645"]);
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

test("BLZ-691: withoutServerPaths also strips the board's REAL projects directory, whatever it is named", () => {
  const projectsDir = "/srv/board/tickets";
  assert.deepEqual(withoutServerPaths([
    "refusing to overwrite /srv/board/tickets/ENG/defined/ENG-2-t.md",
    "cannot read /srv/board/tickets",
    "cannot read '/srv/board/tickets/ENG/project.json'",
  ], { projectsDir }), [
    "refusing to overwrite projects/ENG/defined/ENG-2-t.md",
    "cannot read projects",
    "cannot read 'projects/ENG/project.json'",
  ]);
  assert.deepEqual(withoutServerPaths(["at /srv/board/tickets/ENG/x.md"], { projectsDir: "/srv/board/tickets/" }),
                   ["at projects/ENG/x.md"], "a trailing separator on projectsDir is the same directory");
  assert.deepEqual(withoutServerPaths(["at /srv/board/ticketsX/a"], { projectsDir }), ["at /srv/board/ticketsX/a"],
                   "only the directory itself, never a sibling whose name starts the same");
  assert.deepEqual(withoutServerPaths(["at /srv/data/projects/ENG/a.md"]), ["at projects/ENG/a.md"],
                   "no projectsDir given: the /projects/ rule alone, as before");
});

test("BLZ-691: the estimate refusal names its upper bound", () => {
  assert.deepEqual(newRequestOrErrors({ project: "ENG", type: "task", title: "t", estimate: 2147483646 }, ["ENG"]).errors,
                   ["estimate must be a number of minutes above 0 and at most 2147483645"]);
});

test("BLZ-691: the 300-character title cap counts characters (code points), not UTF-16 units", () => {
  // 200 astral characters are 400 UTF-16 units — and 200 characters. The slug drops them, so
  // the file name fits; the only bound in play is the character cap, which they are under.
  const title = "\u{1F600}".repeat(200);
  assert.equal(title.length, 400);
  assert.ok(newRequestOrErrors({ project: "ENG", type: "task", title }, ["ENG"]).request);
  assert.deepEqual(newRequestOrErrors({ project: "ENG", type: "task", title: "\u{1F600}".repeat(NEW_TITLE_MAX + 1) }, ["ENG"]).errors,
                   ["title is too long (300 characters max)"]);
});

test("BLZ-691 review M1: projectsDir followed by punctuation is stripped too", () => {
  const projectsDir = "/srv/b/t";
  assert.deepEqual(withoutServerPaths(["cannot read /srv/b/t.", "at /srv/b/t, then", "at /srv/b/t: no", "[/srv/b/t]", "x /srv/b/t;"], { projectsDir }),
                   ["cannot read projects.", "at projects, then", "at projects: no", "[projects]", "x projects;"]);
  assert.deepEqual(withoutServerPaths(["at /srv/b/tX/a", "at /srv/b/t-old/a", "at /srv/b/t.bak/a"], { projectsDir }), ["at /srv/b/tX/a", "at /srv/b/t-old/a", "at /srv/b/t.bak/a"],
                   "a sibling whose name starts the same is left alone");
});

test("BLZ-691 review M2: projectsDir is matched only where a path starts, never inside a longer path", () => {
  assert.deepEqual(withoutServerPaths(["at /mnt/srv/b/t/ENG/x.md", "at '/srv/b/t/ENG/x.md'", "(/srv/b/t/ENG)", "`/srv/b/t/ENG`"], { projectsDir: "/srv/b/t" }),
                   ["at /mnt/srv/b/t/ENG/x.md", "at 'projects/ENG/x.md'", "(projects/ENG)", "`projects/ENG`"]);
});

test("BLZ-691 review M3: a symlinked projectsDir is stripped by its real path too; a missing one does not throw", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "blz691-real-")));
  const real = join(base, "real-projects");
  mkdirSync(real);
  const link = join(base, "linked");
  symlinkSync(real, link);
  assert.deepEqual(withoutServerPaths([`at ${real}/ENG/x.md`, `at ${link}/ENG/x.md`], { projectsDir: link }),
                   ["at projects/ENG/x.md", "at projects/ENG/x.md"]);
  assert.deepEqual(withoutServerPaths(["at /no/such/dir/ENG/x.md"], { projectsDir: "/no/such/dir" }), ["at projects/ENG/x.md"]);
});
