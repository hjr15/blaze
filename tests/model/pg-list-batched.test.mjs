// tests/model/pg-list-batched.test.mjs — BLZ-670. listTickets hydrated each row with 4 more
// queries: ~10,000 round trips on the live corpus. A fake client counts them; no server needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { postgresReader } from "../../scripts/model/pg-storage.mjs";

function fakeClient(n) {
  const calls = [];
  const ids = Array.from({ length: n }, (_, i) => `BLZ-${i + 1}`);
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (/FROM ticket WHERE deleted_at IS NULL ORDER BY id/.test(sql))
        return { rows: ids.map((id, i) => ({ id, project_key: "BLZ", num: i + 1, type: "task",
          status: "defined", title: id, body: "", created_on: "2026-01-01", updated_on: "2026-01-01" })) };
      if (/FROM ticket_link/.test(sql)) return { rows: [{ src_id: "BLZ-2", link_type: "Blocks", target_id: "BLZ-1" }] };
      if (/FROM ticket_label/.test(sql)) return { rows: [{ ticket_id: "BLZ-1", label: "b", ord: 1 }, { ticket_id: "BLZ-1", label: "a", ord: 0 }] };
      if (/FROM ticket_component/.test(sql)) return { rows: [] };
      if (/FROM worklog_entry/.test(sql)) return { rows: [{ ticket_id: "BLZ-1", on_date: "2026-01-02", minutes: 5, note: null }] };
      return { rows: [] };
    },
    async end() {},
  };
}

test("listTickets costs 5 queries for 50 tickets, not 201", async () => {
  const c = fakeClient(50);
  assert.equal((await postgresReader(c).listTickets(null)).length, 50);
  assert.equal(c.calls.length, 5);
});

test("batched hydration groups child rows onto the right ticket, in ord order, omitting a NULL note", async () => {
  const [one, two] = await postgresReader(fakeClient(2)).listTickets(null);
  assert.deepEqual(one.frontmatter.labels, ["a", "b"]);
  assert.deepEqual(one.frontmatter.worklog, [{ date: "2026-01-02", minutes: 5 }]);
  assert.deepEqual(two.frontmatter.links, [{ type: "Blocks", target: "BLZ-1" }]);
  assert.deepEqual(two.frontmatter.labels, []);
});
