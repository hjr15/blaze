// tests/migrate/oracle-field-coverage.test.mjs — BLZ-389.
//
// `zeroDiff` is the oracle that gates every migration, and BLZ-324's plan calls it "the same
// method that caught six data-loss defects in already-merged v3 code". Its `FIELDS` list checked
// 12 of the 21 fields a ticket can carry, so destroying any of the other nine reported `ok`.
//
// The list is explicit ON PURPOSE — its own comment says a wildcard "would silently stop checking
// a field the day someone adds one the loader ignores". So this widens the list rather than
// replacing it with a wildcard, and EVERY addition is proved to discriminate by injecting the
// loss and watching the oracle fail. A green run proves nothing here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zeroDiff } from "../../scripts/migrate/zero-diff.mjs";
import { fsReadStorage } from "../../scripts/model/read-storage.mjs";

const FULL = {
  id: "TST-1", title: "t", type: "task", priority: "medium", resolution: "",
  parent: "TST-0", assignee: "ryan", labels: "[infra]", components: "[core]",
  estimate: 30, sprint: "S1", likelihood: "likely", impact: "major",
  branch: "tst-1-x", pr: "#12 — https://example.com/pull/12",
};

function board(extra = "") {   // `extra` appends raw frontmatter lines
  const dir = mkdtempSync(join(tmpdir(), "ofc-"));
  mkdirSync(join(dir, "TST", "defined"), { recursive: true });
  const fm = Object.entries(FULL).map(([k, v]) => `${k}: ${v}`).join("\n");
  writeFileSync(join(dir, "TST", "defined", "TST-1-x.md"), `---\n${fm}\n${extra}---\nbody\n`);
  return dir;
}

// A migrated corpus that loses exactly one field.
const losing = (dir, field) => ({
  listTickets: () => [...fsReadStorage.listTickets(dir)].map((t) => {
    const copy = { ...t, frontmatter: { ...t.frontmatter } };
    delete copy.frontmatter[field];
    return copy;
  }),
});

const CHECKED = ["title", "type", "priority", "parent", "assignee", "sprint",
  "labels", "components", "estimate", "likelihood", "impact", "branch", "pr"];

for (const field of CHECKED) {
  test(`losing '${field}' is DATA LOSS and the oracle fails`, () => {
    const dir = board();
    const r = zeroDiff(fsReadStorage, dir, losing(dir, field));
    assert.equal(r.ok, false, `${field} was destroyed and the oracle reported ok`);
    assert.ok(r.valueDiffs.some((d) => d.field === field),
      `${field} is not in valueDiffs: ${JSON.stringify(r.valueDiffs)}`);
  });
}

test("the seven-field wipe that reported ok before now fails", () => {
  // The exact reproduction from PR #114's review: delete or empty seven fields at once.
  const dir = board("worklog:\n  - { date: 2026-08-01, minutes: 30, note: did it }\nlinks:\n  - { type: Blocks, target: TST-2 }\n");
  const wiped = {
    listTickets: () => [...fsReadStorage.listTickets(dir)].map((t) => {
      const c = { ...t, frontmatter: { ...t.frontmatter } };
      for (const f of ["worklog", "links", "branch", "pr"]) delete c.frontmatter[f];
      c.frontmatter.labels = []; c.frontmatter.components = []; c.frontmatter.estimate = null;
      return c;
    }),
  };
  const r = zeroDiff(fsReadStorage, dir, wiped);
  assert.equal(r.ok, false);
  const lost = new Set(r.valueDiffs.map((d) => d.field));
  for (const f of ["labels", "components", "estimate", "branch", "pr"]) {
    assert.ok(lost.has(f), `${f} still slips through: ${[...lost].join(", ")}`);
  }
});

test("an unchanged corpus is still clean — the widening did not make the oracle cry wolf", () => {
  const dir = board("worklog:\n  - { date: 2026-08-01, minutes: 30, note: did it }\nlinks:\n  - { type: Blocks, target: TST-2 }\n");
  const r = zeroDiff(fsReadStorage, dir, { listTickets: () => [...fsReadStorage.listTickets(dir)] });
  assert.equal(r.ok, true, JSON.stringify(r.valueDiffs));
  assert.deepEqual(r.valueDiffs, []);
});

test("the fields it CANNOT check are named in the file, not silently omitted", async () => {
  // A field left out for a reason is fine. A field left out silently is the defect.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../scripts/migrate/zero-diff.mjs", import.meta.url), "utf8");
  assert.match(src, /worklog/, "worklog must be named — checked or explained");
  assert.match(src, /links/, "links must be named — checked or explained");
});

// ---------------------------------------------------------------- the array fields
//
// PROVED MISSING by adversarial review: deleting the whole `ARRAY_FIELDS` block from
// zero-diff.mjs left all 116 tests/migrate tests green. The one half of BLZ-389 the ticket was
// raised for had zero regression cover, while the commit message claimed "every addition is
// PROVEN to discriminate". These are the tests that make that sentence true.

const WITH_ARRAYS = "worklog:\n  - { date: 2026-08-01, minutes: 30, note: first }\n"
  + "  - { date: 2026-08-02, minutes: 60, note: second }\n"
  + "links:\n  - { type: Blocks, target: TST-2 }\n  - { type: Relates, target: TST-3 }\n";

// Replace one array field wholesale.
const withArray = (dir, field, value) => ({
  listTickets: () => [...fsReadStorage.listTickets(dir)].map((t) => {
    const c = { ...t, frontmatter: { ...t.frontmatter } };
    c.frontmatter[field] = value;
    return c;
  }),
});

test("ARRAY — dropping ONE worklog entry is data loss", () => {
  const dir = board(WITH_ARRAYS);
  const kept = [...fsReadStorage.listTickets(dir)][0].frontmatter.worklog.slice(0, 1);
  const r = zeroDiff(fsReadStorage, dir, withArray(dir, "worklog", kept));
  assert.equal(r.ok, false, "a lost worklog entry reported clean");
  assert.ok(r.valueDiffs.some((d) => d.field === "worklog"));
});

test("ARRAY — CHANGING a worklog entry's minutes is data loss, not just losing one", () => {
  // The length check alone would miss this; the entry comparison is what catches it.
  const dir = board(WITH_ARRAYS);
  const wl = [...fsReadStorage.listTickets(dir)][0].frontmatter.worklog
    .map((w, i) => (i === 0 ? { ...w, minutes: 999 } : w));
  const r = zeroDiff(fsReadStorage, dir, withArray(dir, "worklog", wl));
  assert.equal(r.ok, false, "a mutated worklog entry reported clean");
});

test("ARRAY — dropping a link is data loss", () => {
  const dir = board(WITH_ARRAYS);
  const kept = [...fsReadStorage.listTickets(dir)][0].frontmatter.links.slice(0, 1);
  const r = zeroDiff(fsReadStorage, dir, withArray(dir, "links", kept));
  assert.equal(r.ok, false);
  assert.ok(r.valueDiffs.some((d) => d.field === "links"));
});

test("ARRAY — retargeting a link is data loss", () => {
  const dir = board(WITH_ARRAYS);
  const ls = [...fsReadStorage.listTickets(dir)][0].frontmatter.links
    .map((l, i) => (i === 0 ? { ...l, target: "TST-99" } : l));
  const r = zeroDiff(fsReadStorage, dir, withArray(dir, "links", ls));
  assert.equal(r.ok, false);
});

test("ARRAY — emptying an array is data loss, and so is deleting the key", () => {
  const dir = board(WITH_ARRAYS);
  assert.equal(zeroDiff(fsReadStorage, dir, withArray(dir, "worklog", [])).ok, false);
  assert.equal(zeroDiff(fsReadStorage, dir, losing(dir, "worklog")).ok, false);
});

test("ARRAY — REORDERING is NOT loss, so the oracle does not cry wolf", () => {
  // The comparison is a multiset, not a sequence: a driver that returns worklog rows in a
  // different order has lost nothing. Sequence comparison would fail here, which is the other
  // way this check can be wrong.
  const dir = board(WITH_ARRAYS);
  const wl = [...[...fsReadStorage.listTickets(dir)][0].frontmatter.worklog].reverse();
  const r = zeroDiff(fsReadStorage, dir, withArray(dir, "worklog", wl));
  assert.equal(r.ok, true, JSON.stringify(r.valueDiffs));
});

test("a field the caller declares unsurfaced is SKIPPED and NAMED, never silently passed", () => {
  // The third option between failing on a driver that cannot project a field and passing in
  // silence: say so. `report.unsurfaced` is the record.
  const dir = board(WITH_ARRAYS);
  const r = zeroDiff(fsReadStorage, dir, losing(dir, "worklog"), { unsurfaced: ["worklog"] });
  assert.equal(r.ok, true, "declared-blind, so not counted as loss");
  assert.deepEqual(r.unsurfaced, ["worklog"], "and the blindness is reported");
});
