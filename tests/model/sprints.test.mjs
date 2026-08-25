import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSprints, saveSprints, nextSprintId, validateSprintFields, isIsoDate, addSprint, setActive, formatSprintList,
         SPRINT_REGISTRY_VERSION, unstampedRegistryWarning } from "../../scripts/model/sprints.mjs";
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
  // BLZ-369: the round trip now also STAMPS. Everything written still comes back — that is what
  // this test was for and it still holds — plus `registryVersion`, which is the point.
  assert.deepEqual(loadSprints({ root }), { ...reg, registryVersion: SPRINT_REGISTRY_VERSION });
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

test("EDITABLE_FIELDS includes sprint, and NOT the dates the scheduler owns", () => {
  // Inverted by BLZ-386, not deleted: this test pinned the pre-ADR-0022 contract, where a
  // sprint's dates and a ticket's dates were both operator inputs. `sprint` still is. `start`
  // and `due` are scheduler outputs now, and `not_before`/`deadline` are what an operator sets.
  assert.ok(EDITABLE_FIELDS.has("sprint"));
  for (const f of ["not_before", "deadline"]) assert.ok(EDITABLE_FIELDS.has(f), f);
  for (const f of ["start", "due"]) assert.equal(EDITABLE_FIELDS.has(f), false, f);
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

// --- BLZ-369: the registry round-trip must not be lossy -----------------------------------
//
// `loadSprints` whitelisted two keys, so `loadSprints -> setActive -> saveSprints` wrote every
// other key out of existence. Spec 2's §9 measured it directly:
//
//     file keys BEFORE : [ active, activeByProject, sprints ]
//     loadSprints keys : [ active, sprints ]        <- never reaches a reader
//
// `addSprint` and `setActive` were never the problem — both already spread `...registry`. The
// loader was the whole of it.
//
// This matters BEFORE `activeByProject` ships, not after: whichever engine version is current
// when it lands becomes "the old engine" for every board that migrates. An engine that
// preserves what it does not understand can never be that engine. It cannot help against
// versions already released — nothing can, they are shipped — which is what the stamp is for.
describe("BLZ-369: an additive key survives a round trip", () => {
  const withRegistry = (obj, fn) => {
    const root = mkdtempSync(join(tmpdir(), "blz369-"));
    try {
      writeFileSync(join(root, "sprints.json"), JSON.stringify(obj, null, 2) + "\n");
      return fn(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  const onDisk = (root) => JSON.parse(readFileSync(join(root, "sprints.json"), "utf8"));
  const REGISTRY = {
    active: "S1",
    activeByProject: { OBA: "S5", INF: "S3" },
    sprints: [{ id: "S1", name: "one", start: "2026-08-01", end: "2026-08-14" },
              { id: "S2", name: "two", start: "2026-08-15", end: "2026-08-28" }],
  };

  test("loadSprints does not drop a key it does not know", () => {
    withRegistry(REGISTRY, (root) => {
      const loaded = loadSprints({ root });
      assert.deepEqual(loaded.activeByProject, { OBA: "S5", INF: "S3" },
        "the loader dropped an additive key — every writer downstream then persists the loss");
    });
  });

  test("THE DESTRUCTION PATH: load -> setActive -> save keeps it", () => {
    withRegistry(REGISTRY, (root) => {
      saveSprints({ root }, setActive(loadSprints({ root }), "S2"));
      const after = onDisk(root);
      assert.deepEqual(after.activeByProject, { OBA: "S5", INF: "S3" },
        "the exact round trip spec 2 §9 measured still destroys operator-entered state");
      assert.equal(after.active, "S2", "the round trip did not do its actual job");
    });
  });

  test("load -> addSprint -> save keeps it too", () => {
    withRegistry(REGISTRY, (root) => {
      saveSprints({ root }, addSprint(loadSprints({ root }),
        { name: "three", start: "2026-08-29", end: "2026-09-11" }).registry);
      assert.deepEqual(onDisk(root).activeByProject, { OBA: "S5", INF: "S3" });
      assert.equal(onDisk(root).sprints.length, 3);
    });
  });

  test("a malformed registry is still EMPTY, and carries nothing forward", () => {
    // The contract that made the whitelist look safe. Preserving unknown keys must not turn a
    // junk file into a half-trusted one.
    for (const bad of [{ sprints: "not an array", activeByProject: { X: "S1" } }, null, 42, []]) {
      withRegistry(bad, (root) => {
        const loaded = loadSprints({ root });
        assert.deepEqual(loaded.sprints, [], `${JSON.stringify(bad)} produced sprints`);
        assert.equal(loaded.activeByProject, undefined,
          "a malformed registry leaked an unknown key into a caller that trusts the shape");
      });
    }
  });

  test("a missing `active` still normalises to null, not undefined", () => {
    withRegistry({ sprints: [], other: 1 }, (root) => {
      assert.equal(loadSprints({ root }).active, null);
    });
  });
});

describe("BLZ-369: the stamp, for engines already released", () => {
  const withRegistry = (obj, fn) => {
    const root = mkdtempSync(join(tmpdir(), "blz369s-"));
    try {
      writeFileSync(join(root, "sprints.json"), JSON.stringify(obj, null, 2) + "\n");
      return fn(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  const onDisk = (root) => JSON.parse(readFileSync(join(root, "sprints.json"), "utf8"));
  const S = [{ id: "S1", name: "one", start: "2026-08-01", end: "2026-08-14" }];

  test("saveSprints stamps the registry", () => {
    withRegistry({ active: "S1", sprints: S }, (root) => {
      saveSprints({ root }, loadSprints({ root }));
      assert.equal(onDisk(root).registryVersion, SPRINT_REGISTRY_VERSION);
    });
  });

  test("a stamped registry that comes back unstamped is REPORTED", () => {
    // The only signal available against an engine that shipped before the stamp existed: it
    // rewrites the file and drops every key it does not know, the stamp included.
    assert.notEqual(unstampedRegistryWarning({ active: "S1", sprints: S }), null,
      "a registry with sprints and no stamp raised nothing");
    assert.match(unstampedRegistryWarning({ active: "S1", sprints: S }), /older engine|version stamp/i);
  });

  test("a stamped registry is quiet", () => {
    assert.equal(
      unstampedRegistryWarning({ active: "S1", sprints: S, registryVersion: SPRINT_REGISTRY_VERSION }),
      null, "a correctly stamped registry warned anyway");
  });

  test("a board with no sprints is quiet — there is nothing to have lost", () => {
    // Otherwise every fresh board warns on its first `blaze sprint new`.
    assert.equal(unstampedRegistryWarning({ active: null, sprints: [] }), null);
  });
});
