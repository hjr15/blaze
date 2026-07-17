import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSprints, saveSprints, nextSprintId, validateSprintFields, isIsoDate, addSprint, setActive, formatSprintList } from "../../scripts/model/sprints.mjs";
import { parseTicket, serializeTicket } from "../../scripts/model/ticket.mjs";
import { EDITABLE_FIELDS } from "../../scripts/model/fields.mjs";
import { buildIndex } from "../../scripts/model/index.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "blz-sprints-")); }

test("loadSprints degrades to empty on missing file", () => {
  const root = tmp();
  assert.deepEqual(loadSprints({ root }), { active: null, sprints: [] });
  rmSync(root, { recursive: true, force: true });
});

test("loadSprints degrades to empty on malformed JSON", () => {
  const root = tmp();
  writeFileSync(join(root, "sprints.json"), "{not json");
  assert.deepEqual(loadSprints({ root }), { active: null, sprints: [] });
  rmSync(root, { recursive: true, force: true });
});

test("loadSprints reads a well-formed registry", () => {
  const root = tmp();
  const reg = { active: "S1", sprints: [{ id: "S1", name: "Mid-July", start: "2026-07-13", end: "2026-07-26" }] };
  writeFileSync(join(root, "sprints.json"), JSON.stringify(reg));
  assert.deepEqual(loadSprints({ root }), reg);
  rmSync(root, { recursive: true, force: true });
});

test("saveSprints round-trips through loadSprints and writes trailing newline", () => {
  const root = tmp();
  const reg = { active: "S2", sprints: [{ id: "S2", name: "x", start: "2026-08-01", end: "2026-08-14" }] };
  saveSprints({ root }, reg);
  assert.deepEqual(loadSprints({ root }), reg);
  assert.ok(readFileSync(join(root, "sprints.json"), "utf8").endsWith("\n"));
  rmSync(root, { recursive: true, force: true });
});

test("nextSprintId allocates S1 on empty and max+1 otherwise", () => {
  assert.equal(nextSprintId({ active: null, sprints: [] }), "S1");
  assert.equal(nextSprintId({ active: null, sprints: [{ id: "S1" }, { id: "S3" }] }), "S4");
});

test("isIsoDate accepts YYYY-MM-DD and rejects junk / impossible dates", () => {
  assert.equal(isIsoDate("2026-07-13"), true);
  assert.equal(isIsoDate("2026-7-13"), false);   // not zero-padded
  assert.equal(isIsoDate("2026-13-01"), false);  // month 13
  assert.equal(isIsoDate("2026-02-30"), false);  // impossible day
  assert.equal(isIsoDate("nope"), false);
  assert.equal(isIsoDate(""), false);
});

const IDS = new Set(["S1", "S2"]);

test("validateSprintFields: clean when fields absent", () => {
  assert.deepEqual(validateSprintFields({}, { sprintIds: IDS }), []);
});
test("validateSprintFields: unknown sprint id is an error", () => {
  const errs = validateSprintFields({ sprint: "S9" }, { sprintIds: IDS });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /sprint 'S9'/);
});
test("validateSprintFields: known sprint id is clean", () => {
  assert.deepEqual(validateSprintFields({ sprint: "S1" }, { sprintIds: IDS }), []);
});
test("validateSprintFields: bad date format is an error", () => {
  assert.match(validateSprintFields({ start: "07/20/2026" }, { sprintIds: IDS })[0], /start/);
  assert.match(validateSprintFields({ due: "soon" }, { sprintIds: IDS })[0], /due/);
});
test("validateSprintFields: start after due is an error", () => {
  const errs = validateSprintFields({ start: "2026-07-25", due: "2026-07-20" }, { sprintIds: IDS });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /start.*after.*due/i);
});
test("validateSprintFields: start equal to due is clean", () => {
  assert.deepEqual(validateSprintFields({ start: "2026-07-20", due: "2026-07-20" }, { sprintIds: IDS }), []);
});
test("validateSprintFields: empty-string sprint (membership clear) is clean", () => {
  assert.deepEqual(validateSprintFields({ sprint: "" }, { sprintIds: IDS }), []);
});

test("EDITABLE_FIELDS includes sprint, start, due", () => {
  for (const f of ["sprint", "start", "due"]) assert.ok(EDITABLE_FIELDS.has(f), f);
});

test("serializeTicket places sprint/start/due right after estimate", () => {
  const fm = { id: "OBA-1", title: "t", type: "task", project: "OBA", estimate: 60,
    sprint: "S1", start: "2026-07-20", due: "2026-07-24" };
  const text = serializeTicket({ frontmatter: fm, body: "b" });
  const order = ["estimate:", "sprint:", "start:", "due:"].map((k) => text.indexOf(k));
  assert.ok(order.every((v, i) => i === 0 || v > order[i - 1]), text);
  // round-trip preserves values
  const back = parseTicket(text).frontmatter;
  assert.equal(back.sprint, "S1"); assert.equal(back.start, "2026-07-20"); assert.equal(back.due, "2026-07-24");
});

test("buildIndex projects sprint/start/due onto rows (null when absent)", () => {
  const root = tmp();
  const projects = join(root, "projects");
  const dir = join(projects, "OBA", "defined");
  mkdirSync(dir, { recursive: true });
  const tagged = { id: "OBA-1", title: "t", type: "task", project: "OBA", estimate: 60,
    sprint: "S1", start: "2026-07-20", due: "2026-07-24" };
  const bare = { id: "OBA-2", title: "u", type: "task", project: "OBA", estimate: 30 };
  writeFileSync(join(dir, "OBA-1.md"), serializeTicket({ frontmatter: tagged, body: "b" }));
  writeFileSync(join(dir, "OBA-2.md"), serializeTicket({ frontmatter: bare, body: "b" }));
  const idx = buildIndex(projects);   // POSITIONAL: buildIndex(projectsDir, {tickets}={}) — index.mjs:80
  const r1 = idx.rows.find((r) => r.id === "OBA-1");
  const r2 = idx.rows.find((r) => r.id === "OBA-2");
  assert.equal(r1.sprint, "S1"); assert.equal(r1.start, "2026-07-20"); assert.equal(r1.due, "2026-07-24");
  assert.equal(r2.sprint, null); assert.equal(r2.start, null); assert.equal(r2.due, null);
  rmSync(root, { recursive: true, force: true });
});

test("buildIndex warns (not errors) on a dangling sprint ref", () => {
  const root = tmp();
  const projects = join(root, "projects");
  const dir = join(projects, "OBA", "defined");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "sprints.json"), JSON.stringify({
    active: "S1", sprints: [{ id: "S1", name: "Mid-July", start: "2026-07-13", end: "2026-07-26" }],
  }));
  const dangling = { id: "OBA-1", title: "t", type: "task", project: "OBA", estimate: 30, sprint: "S9" };
  const valid = { id: "OBA-2", title: "u", type: "task", project: "OBA", estimate: 30, sprint: "S1" };
  writeFileSync(join(dir, "OBA-1.md"), serializeTicket({ frontmatter: dangling, body: "b" }));
  writeFileSync(join(dir, "OBA-2.md"), serializeTicket({ frontmatter: valid, body: "b" }));
  const idx = buildIndex(projects);
  assert.ok(idx.warnings.some((w) => /OBA-1: sprint 'S9' not in registry/.test(w)));
  assert.ok(!idx.warnings.some((w) => /OBA-2/.test(w)));
  rmSync(root, { recursive: true, force: true });
});

test("buildIndex emits no sprint warning on a board that never opted in (no sprints.json, no sprint field)", () => {
  const root = tmp();
  const projects = join(root, "projects");
  const dir = join(projects, "OBA", "defined");
  mkdirSync(dir, { recursive: true });
  const plain = { id: "OBA-1", title: "t", type: "task", project: "OBA", estimate: 30 };
  writeFileSync(join(dir, "OBA-1.md"), serializeTicket({ frontmatter: plain, body: "b" }));
  const idx = buildIndex(projects);
  assert.equal(idx.warnings.length, 0);
  rmSync(root, { recursive: true, force: true });
});

// --- addSprint / setActive / formatSprintList (BLZ-111 pure helpers) -------

test("addSprint allocates the next id, appends, and returns {registry, id} without mutating the input", () => {
  const reg = { active: null, sprints: [] };
  const out = addSprint(reg, { name: "Mid-July", start: "2026-07-13", end: "2026-07-26" });
  assert.equal(out.id, "S1");
  assert.deepEqual(out.registry.sprints, [{ id: "S1", name: "Mid-July", start: "2026-07-13", end: "2026-07-26" }]);
  assert.equal(reg.sprints.length, 0, "input registry must not be mutated");
});

test("addSprint allocates max+1 when sprints already exist", () => {
  const reg = { active: "S1", sprints: [{ id: "S1", name: "a", start: "2026-07-01", end: "2026-07-10" }] };
  const out = addSprint(reg, { name: "b", start: "2026-07-13", end: "2026-07-26" });
  assert.equal(out.id, "S2");
  assert.equal(out.registry.sprints.length, 2);
  assert.equal(out.registry.active, "S1", "active is untouched by addSprint when one is already set");
});

test("addSprint auto-activates the first sprint when none was active yet", () => {
  const out = addSprint({ active: null, sprints: [] }, { name: "Mid-July", start: "2026-07-13", end: "2026-07-26" });
  assert.equal(out.registry.active, "S1");
});

test("addSprint throws blaze: ... on a malformed start/end date", () => {
  assert.throws(
    () => addSprint({ active: null, sprints: [] }, { name: "x", start: "not-a-date", end: "2026-07-26" }),
    /blaze: /,
  );
  assert.throws(
    () => addSprint({ active: null, sprints: [] }, { name: "x", start: "2026-07-13", end: "soon" }),
    /blaze: /,
  );
});

test("addSprint throws blaze: ... when start is after end", () => {
  assert.throws(
    () => addSprint({ active: null, sprints: [] }, { name: "x", start: "2026-07-26", end: "2026-07-13" }),
    /blaze: .*start.*end/i,
  );
});

test("addSprint allows start equal to end (single-day sprint)", () => {
  const out = addSprint({ active: null, sprints: [] }, { name: "x", start: "2026-07-13", end: "2026-07-13" });
  assert.equal(out.registry.sprints[0].end, "2026-07-13");
});

test("setActive flips active on a known id and does not mutate the input", () => {
  const reg = { active: "S1", sprints: [{ id: "S1" }, { id: "S2" }] };
  const out = setActive(reg, "S2");
  assert.equal(out.active, "S2");
  assert.equal(reg.active, "S1", "input registry must not be mutated");
});

test("setActive throws blaze: ... on an unknown id", () => {
  assert.throws(
    () => setActive({ active: null, sprints: [{ id: "S1" }] }, "S9"),
    /blaze: .*S9/,
  );
});

test("formatSprintList renders 'id · name · start..end' with an active marker on the active row", () => {
  const reg = {
    active: "S1",
    sprints: [
      { id: "S1", name: "Mid-July", start: "2026-07-13", end: "2026-07-26" },
      { id: "S2", name: "Late-July", start: "2026-07-27", end: "2026-08-09" },
    ],
  };
  const out = formatSprintList(reg);
  const lines = out.split("\n");
  assert.equal(lines[0], "S1 · Mid-July · 2026-07-13..2026-07-26 (active)");
  assert.equal(lines[1], "S2 · Late-July · 2026-07-27..2026-08-09");
});

test("formatSprintList on an empty registry", () => {
  assert.equal(formatSprintList({ active: null, sprints: [] }), "(no sprints)");
});
