// tests/migrate/date-migration-oracle.test.mjs — BLZ-385 / BLZ-360 §4.1 item 3.
//
// "The zero-diff oracle is EXTENDED, not weakened." Under the date migration `start` and `due`
// change on purpose, so the oracle needs a way to say which tickets are allowed to differ —
// and the whole value of the extension is that it stays a gate. A 41st changed ticket fails.
//
// Every test here PROVES the extension discriminates by injecting the change and watching the
// oracle catch it, rather than asserting a green run and calling it proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zeroDiff } from "../../scripts/migrate/zero-diff.mjs";
import { fsReadStorage } from "../../scripts/model/read-storage.mjs";

const tk = (id, over = {}) => ({
  id, title: `t ${id}`, type: "task", priority: "medium", resolution: "",
  parent: "", assignee: "unassigned", labels: "[]", components: "[]", ...over,
});

function board(tickets) {
  const dir = mkdtempSync(join(tmpdir(), "zd-"));
  mkdirSync(join(dir, "TST", "defined"), { recursive: true });
  for (const t of tickets) {
    const fm = Object.entries(t).map(([k, v]) => `${k}: ${v}`).join("\n");
    writeFileSync(join(dir, "TST", "defined", `${t.id}-x.md`), `---\n${fm}\n---\nbody\n`);
  }
  return dir;
}

// A stand-in for the migrated corpus: same tickets, with edits applied.
const loadedFrom = (dir, edit) => ({
  listTickets: () => [...fsReadStorage.listTickets(dir)].map((t) => {
    const copy = { ...t, frontmatter: { ...t.frontmatter } };
    edit(copy);
    return copy;
  }),
});

test("without the expected-delta list, a migrated date is data loss — the oracle's default", () => {
  // This is the behaviour that must NOT change: the oracle still catches an unexplained
  // start/due change. If this ever goes green the extension has swallowed the gate.
  const dir = board([tk("TST-1", { start: "2026-08-11", due: "2026-08-16" })]);
  const r = zeroDiff(fsReadStorage, dir, loadedFrom(dir, (t) => { t.frontmatter.due = ""; }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.valueDiffs.map((d) => `${d.id}.${d.field}`), ["TST-1.due"]);
});

test("an id in the expected-delta list may change start and due, and the oracle stays green", () => {
  const dir = board([tk("TST-1", { start: "2026-08-11", due: "2026-08-16" })]);
  const r = zeroDiff(fsReadStorage, dir, loadedFrom(dir, (t) => { t.frontmatter.start = ""; t.frontmatter.due = ""; }),
    { expectedDelta: ["TST-1"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.valueDiffs, []);
  assert.deepEqual(r.expectedDeltas.map((d) => `${d.id}.${d.field}`), ["TST-1.start", "TST-1.due"],
    "excused, and RECORDED as excused — a silent excuse is indistinguishable from no check");
});

test("A 41ST CHANGED TICKET FAILS THE ORACLE — the criterion, proved by injecting one", () => {
  const dir = board([
    tk("TST-1", { start: "2026-08-11", due: "2026-08-16" }),
    tk("TST-2", { start: "2026-08-12", due: "2026-08-17" }),
  ]);
  // TST-1 is expected. TST-2 is the 41st, and it must not ride along.
  const r = zeroDiff(fsReadStorage, dir,
    loadedFrom(dir, (t) => { t.frontmatter.start = ""; t.frontmatter.due = ""; }),
    { expectedDelta: ["TST-1"] });
  assert.equal(r.ok, false, "an unlisted ticket changing its dates is still data loss");
  assert.deepEqual(r.valueDiffs.map((d) => `${d.id}.${d.field}`), ["TST-2.start", "TST-2.due"]);
});

test("the list excuses ONLY start and due, never another field on the same ticket", () => {
  // The migration touches two fields. A listed id that also lost its title is data loss, and an
  // expected-delta list that excuses the whole ticket would hide exactly that.
  const dir = board([tk("TST-1", { start: "2026-08-11", due: "2026-08-16" })]);
  const r = zeroDiff(fsReadStorage, dir,
    loadedFrom(dir, (t) => { t.frontmatter.due = ""; t.frontmatter.title = "clobbered"; }),
    { expectedDelta: ["TST-1"] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.valueDiffs.map((d) => `${d.id}.${d.field}`), ["TST-1.title"]);
});

test("a FROZEN terminal ticket is asserted unchanged, which is stronger than excusing it", () => {
  // §4.1 names an expected-delta list of "those 40 ids". Measured, only 12 change; the other 28
  // are the terminal cohort §4 keeps VERBATIM. Listing them would excuse the one accident §4
  // exists to prevent — overwriting history with a forecast. So they are asserted, not excused.
  const dir = board([tk("TST-1", { start: "2026-06-01", due: "2026-06-05" })]);
  const r = zeroDiff(fsReadStorage, dir, loadedFrom(dir, (t) => { t.frontmatter.due = "2026-07-01"; }),
    { expectedDelta: [], frozen: ["TST-1"] });
  assert.equal(r.ok, false, "a frozen actual that moved is the migration's worst failure");
  assert.deepEqual(r.frozenViolations.map((d) => `${d.id}.${d.field}`), ["TST-1.due"]);
});

test("a frozen id and an expected-delta id cannot be the same ticket", () => {
  // Contradictory instructions must be refused rather than silently resolved by ordering.
  const dir = board([tk("TST-1", { due: "2026-06-05" })]);
  assert.throws(() => zeroDiff(fsReadStorage, dir, loadedFrom(dir, () => {}),
    { expectedDelta: ["TST-1"], frozen: ["TST-1"] }), /both frozen and expected to change/);
});

test("with no options the oracle behaves exactly as it did before this extension", () => {
  const dir = board([tk("TST-1", { start: "2026-08-11", due: "2026-08-16" })]);
  const r = zeroDiff(fsReadStorage, dir, loadedFrom(dir, () => {}));
  assert.equal(r.ok, true);
  assert.deepEqual(r.expectedDeltas, []);
  assert.deepEqual(r.frozenViolations, []);
});
