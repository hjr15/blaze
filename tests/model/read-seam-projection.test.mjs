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
