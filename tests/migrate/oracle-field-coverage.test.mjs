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

function board(extra = "") {
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
