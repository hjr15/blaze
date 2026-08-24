// tests/model/read-seam-projection.test.mjs — BLZ-391.
//
// The read seam projected 15 of a ticket's 28 frontmatter keys. `loadCorpus` WRITES most of the
// missing columns and the read side never selected them back, so the data went into the database
// and did not come out — invisible to every consumer of the seam, and to any migration oracle
// comparing through it.
//
// This is the test the ticket asks for: round-trip a ticket carrying EVERY key and assert what
// survives, so the next column added cannot go missing silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteRead } from "../../scripts/model/sqlite-storage.mjs";
import { loadCorpus } from "../../scripts/migrate/load-corpus.mjs";

// Every frontmatter key a ticket can carry, with a distinctive value for each.
const FULL = {
  id: "BLZ-1", title: "a title", type: "task", project: "BLZ", priority: "high",
  resolution: "done", parent: "BLZ-2", assignee: "me", estimate: 30, sprint: "S1",
  likelihood: "likely", impact: "major", branch: "b1", pr: "p1",
  ref: "R-1", category: "c1", verification: "v1", derived: "d1",
  created: "2026-01-01", updated: "2026-01-02",
  start: "2026-02-01", due: "2026-02-02",
  not_before: "2026-03-01", deadline: "2026-03-02",
};

function loaded() {
  const dir = mkdtempSync(join(tmpdir(), "seam-"));
  mkdirSync(join(dir, "BLZ", "defined"), { recursive: true });
  // BLZ-2 must EXIST or `loadCorpus`'s pass-two link insert is skipped — the trap that made an
  // earlier measurement of this gap report `links` as unsurfaced when it always was surfaced.
  writeFileSync(join(dir, "BLZ", "defined", "BLZ-2.md"),
    "---\nid: BLZ-2\ntitle: two\ntype: task\nproject: BLZ\n---\nb\n");
  const fm = Object.entries(FULL).map(([k, v]) => `${k}: ${v}`).join("\n");
  writeFileSync(join(dir, "BLZ", "defined", "BLZ-1.md"),
    `---\n${fm}\nlabels: [infra]\ncomponents: [core]\n`
    + "worklog:\n  - { date: 2026-01-05, minutes: 30, note: did it }\n"
    + "links:\n  - { type: Blocks, target: BLZ-2 }\n---\nbody text\n");
  const s = openSqliteRead(":memory:", { create: true });
  const report = loadCorpus(s.db, dir);
  const [row] = [...s.listTickets(null)].filter((r) => r.frontmatter.id === "BLZ-1");
  return { row, report };
}

test("the loader actually wrote the child rows — otherwise this test proves nothing", () => {
  const { report } = loaded();
  assert.equal(report.links, 1, "no link written, so a links assertion below would be vacuous");
  assert.equal(report.worklog, 1);
  assert.equal(report.labels, 1);
  assert.equal(report.components, 1);
});

for (const [key, value] of Object.entries(FULL)) {
  test(`the read seam projects '${key}'`, () => {
    const { row } = loaded();
    assert.equal(String(row.frontmatter[key] ?? ""), String(value),
      `'${key}' went into the database and did not come back out`);
  });
}

test("the read seam projects labels and components from their child tables", () => {
  const { row } = loaded();
  assert.deepEqual(row.frontmatter.labels, ["infra"]);
  assert.deepEqual(row.frontmatter.components, ["core"]);
});

test("the read seam projects worklog, entry by entry", () => {
  const { row } = loaded();
  assert.equal(row.frontmatter.worklog.length, 1);
  assert.equal(row.frontmatter.worklog[0].minutes, 30);
  assert.equal(row.frontmatter.worklog[0].date, "2026-01-05");
  assert.equal(row.frontmatter.worklog[0].note, "did it");
});

test("the read seam projects links", () => {
  const { row } = loaded();
  assert.deepEqual(row.frontmatter.links, [{ type: "Blocks", target: "BLZ-2" }]);
});

test("NOTHING a ticket can carry is silently dropped — the whole point of BLZ-391", () => {
  // The catch-all. A column added later that nobody projects fails here rather than going
  // missing in silence, which is how these thirteen accumulated.
  const { row } = loaded();
  const expected = [...Object.keys(FULL), "labels", "components", "worklog", "links"].sort();
  const carried = expected.filter((k) => {
    const v = row.frontmatter[k];
    return Array.isArray(v) ? v.length > 0 : String(v ?? "").trim() !== "";
  });
  assert.deepEqual(carried, expected,
    `not projected: ${expected.filter((k) => !carried.includes(k)).join(", ")}`);
});

test("a ticket carrying none of the optional fields still round-trips cleanly", () => {
  // The widening must not invent values for a sparse ticket — 2,590 of the live corpus carry
  // no dates at all, and an empty child table must read as empty, not as undefined.
  const dir = mkdtempSync(join(tmpdir(), "seam-min-"));
  mkdirSync(join(dir, "BLZ", "defined"), { recursive: true });
  writeFileSync(join(dir, "BLZ", "defined", "BLZ-9.md"),
    "---\nid: BLZ-9\ntitle: bare\ntype: task\nproject: BLZ\n---\nb\n");
  const s = openSqliteRead(":memory:", { create: true });
  loadCorpus(s.db, dir);
  const [row] = [...s.listTickets(null)];
  assert.deepEqual(row.frontmatter.labels, []);
  assert.deepEqual(row.frontmatter.components, []);
  assert.deepEqual(row.frontmatter.worklog, []);
  assert.deepEqual(row.frontmatter.links, []);
  for (const k of ["branch", "pr", "ref", "category", "verification", "derived",
    "likelihood", "impact", "not_before", "deadline"]) {
    assert.equal(row.frontmatter[k], "", `${k} should be empty, got ${JSON.stringify(row.frontmatter[k])}`);
  }
});

test("REVIEW D1 — a worklog entry with NO note round-trips WITHOUT one", () => {
  // The defect this file's original fixture could not see, because it always supplied a note.
  // Both drivers emitted `note: ""` for a NULL column, so a source entry stating no note came
  // back stating an empty one — and the zero-diff oracle went RED on 655 of the live corpus's
  // tickets. Measured: 691 of 1,700 live worklog entries carry no `note` key at all.
  //
  // write-port.mjs:326 already had this right; the two new drivers did not.
  const dir = mkdtempSync(join(tmpdir(), "seam-note-"));
  mkdirSync(join(dir, "BLZ", "defined"), { recursive: true });
  writeFileSync(join(dir, "BLZ", "defined", "BLZ-1.md"),
    "---\nid: BLZ-1\ntitle: t\ntype: task\nproject: BLZ\n"
    + "worklog:\n  - { date: 2026-01-05, minutes: 30 }\n"
    + "  - { date: 2026-01-06, minutes: 60, note: with a note }\n---\nb\n");
  const s = openSqliteRead(":memory:", { create: true });
  loadCorpus(s.db, dir);
  const [row] = [...s.listTickets(null)];
  assert.deepEqual(row.frontmatter.worklog, [
    { date: "2026-01-05", minutes: 30 },
    { date: "2026-01-06", minutes: 60, note: "with a note" },
  ], "a note-less entry must not gain `note: \"\"`");
  assert.ok(!("note" in row.frontmatter.worklog[0]), "the key must be ABSENT, not empty");
});

test("REVIEW D5/D6 — the write port persists not_before/deadline, and NOT into extra_json too", async () => {
  // Two defects with one root: `COLUMN_FIELDS` was not extended when the columns arrived.
  //
  // D6 — `dbWritePort.persist`'s column list never wrote them, so a ticket written through the
  //      dual-write port read back with both empty: BLZ-391's own defect on the other path.
  // D5 — and because they were absent from COLUMN_FIELDS, `extraFields()` swept them into
  //      `extra_json` as well. This file's own comment says what that costs: "a key in both is
  //      stored twice and the second write wins", so the two readers disagreed.
  const { COLUMN_FIELDS, extraFields } = await import("../../scripts/model/write-port.mjs");
  assert.ok(COLUMN_FIELDS.has("not_before"), "not_before must be a COLUMN, not a JSON-tail key");
  assert.ok(COLUMN_FIELDS.has("deadline"));
  const extra = extraFields({ id: "X-1", not_before: "2026-03-01", deadline: "2026-03-02", odd: "keep" });
  assert.deepEqual(extra, { odd: "keep" },
    "a field with its own column must NOT also land in extra_json");
});

// ------------------------------------------- STRICT regressions found by adversarial review
//
// Both are reachable from a HAND-EDITED markdown ticket, which is Blaze's stated premise and
// exactly the input `loadCorpus` exists to tolerate. Neither is reachable from the CLI, because
// `roundEstimate`/`roundWorklog` already guarantee integers there. Under the pre-STRICT schema
// both slipped through and were stored as REAL in an INTEGER column; STRICT refuses that, so the
// fix is to round at the writers rather than to weaken the column.

test("REVIEW — a fractional worklog `minutes` does not break the load under STRICT", () => {
  const dir = mkdtempSync(join(tmpdir(), "frac-w-"));
  mkdirSync(join(dir, "BLZ", "defined"), { recursive: true });
  writeFileSync(join(dir, "BLZ", "defined", "BLZ-1.md"),
    "---\nid: BLZ-1\ntitle: t\ntype: task\nproject: BLZ\n"
    + "worklog:\n  - { date: 2026-01-05, minutes: 1.5 }\n---\nb\n");
  const s = openSqliteRead(":memory:", { create: true });
  const r = loadCorpus(s.db, dir);   // threw an uncaught REAL-into-INTEGER error before
  assert.equal(r.tickets, 1);
  assert.equal(r.worklog, 1);
  const [row] = [...s.listTickets(null)];
  assert.equal(row.frontmatter.worklog[0].minutes, 2, "1.5 rounds to 2, it does not vanish");
});

test("REVIEW — BOTH writers give the SAME answer for a non-storable estimate", async () => {
  // The previous version of this test PASSED against the pre-fix tree, so it covered nothing:
  // it never called `est`, and `roundEstimate(10.5)` was already 10 either way. The defect was
  // that the two writers DISAGREED — filesystem 7, loadCorpus null, write-port 5 — and that
  // write-port INVENTED, `roundEstimate(1)` being 5 in a path that only mirrors.
  const { storableEstimate } = await import("../../scripts/model/time.mjs");
  for (const [input, want] of [[7, null], [10.5, null], [1, null], [0.4, null], [30, 30], [5, 5]]) {
    assert.equal(storableEstimate(input), want, `storableEstimate(${input})`);
  }
  // And the mirror really uses it: a non-storable estimate lands as NULL, not as an invention.
  const dir = mkdtempSync(join(tmpdir(), "est-"));
  mkdirSync(join(dir, "BLZ", "defined"), { recursive: true });
  writeFileSync(join(dir, "BLZ", "defined", "BLZ-1.md"),
    "---\nid: BLZ-1\ntitle: t\ntype: task\nproject: BLZ\nestimate: 7\n---\nb\n");
  const s2 = openSqliteRead(":memory:", { create: true });
  assert.equal(loadCorpus(s2.db, dir).tickets, 1);
  assert.equal(String([...s2.listTickets(null)][0].frontmatter.estimate), "",
    "7 is not storable, so it is NULL — never rounded up to 5 or down to 5");
});

test("REVIEW — a worklog entry that rounds to zero is COUNTED, not silently dropped", () => {
  // Also replaced: the previous version's fixture used `minutes: 30` and a valid date, so it
  // inserted cleanly and asserted only that `insertFailed` was an array. It passed pre-fix.
  // load-corpus.mjs's header promises "nothing is silently dropped — every skip is counted and
  // named", and Math.round(0.4) is 0.
  const dir = mkdtempSync(join(tmpdir(), "drop-"));
  mkdirSync(join(dir, "BLZ", "defined"), { recursive: true });
  writeFileSync(join(dir, "BLZ", "defined", "BLZ-1.md"),
    "---\nid: BLZ-1\ntitle: t\ntype: task\nproject: BLZ\n"
    + "worklog:\n  - { date: 2026-01-05, minutes: 0.4 }\n"
    + "  - { date: 2026-01-06, minutes: 30 }\n---\nb\n");
  const s2 = openSqliteRead(":memory:", { create: true });
  const r = loadCorpus(s2.db, dir);
  assert.equal(r.worklog, 1, "only the storable entry is written");
  // The RAW value as written, not a coerced one: `coerceScalar`'s integer regex leaves "0.4" a
  // string, and a tally of what was dropped should say what the file actually said.
  assert.deepEqual(r.skipped.worklogDropped, [{ id: "BLZ-1", minutes: "0.4" }],
    "and the dropped one is NAMED in the tally");
});

