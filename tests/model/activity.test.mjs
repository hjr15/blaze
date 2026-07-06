import { test } from "node:test";
import assert from "node:assert/strict";
import { parseActivity, groupByTicket, relativeTime, renderLiveHtml } from "../../scripts/model/activity.mjs";

const ev = (o) => JSON.stringify({ ts: "2026-07-07T00:00:00Z", key: "INF-1", branch: "INF-1-x", tool: "Bash", cwd: "/c", ...o });

test("parseActivity skips malformed and short lines, keeps valid ones", () => {
  const text = [ev({ key: "INF-1" }), "not json", "", "{}", ev({ key: "INF-2", tool: "Edit" })].join("\n");
  const out = parseActivity(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].key, "INF-1");
  assert.equal(out[1].tool, "Edit");
});

test("parseActivity honours the tail limit (keeps the LAST n lines)", () => {
  const lines = Array.from({ length: 10 }, (_, i) => ev({ key: `INF-${i}` }));
  const out = parseActivity(lines.join("\n"), { limit: 3 });
  assert.deepEqual(out.map((e) => e.key), ["INF-7", "INF-8", "INF-9"]);
});

test("parseActivity on empty/whitespace returns []", () => {
  assert.deepEqual(parseActivity(""), []);
  assert.deepEqual(parseActivity("\n\n  \n"), []);
});

function mk(key, tool, ms) {
  return { ts: new Date(ms).toISOString(), key, tool, branch: `${key}-x`, cwd: "/c" };
}

test("groupByTicket keeps the latest event per key and marks active within TTL", () => {
  const now = 1_000_000;
  const evs = [
    mk("INF-1", "Read",  now - 300_000),  // idle (5m old)
    mk("INF-1", "Bash",  now - 10_000),   // latest for INF-1 (10s old -> active)
    mk("INF-2", "Edit",  now - 200_000),  // idle (>2m)
  ];
  const groups = groupByTicket(evs, { now, ttlMs: 120_000, statusByKey: { "INF-1": "in-progress" } });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].key, "INF-1");          // sorted by lastTs desc
  assert.equal(groups[0].tool, "Bash");          // latest wins
  assert.equal(groups[0].active, true);
  assert.equal(groups[0].column, "in-progress");
  assert.equal(groups[0].count, 2);
  const inf2 = groups.find((g) => g.key === "INF-2");
  assert.equal(inf2.active, false);
  assert.equal(inf2.column, null);
});

test("groupByTicket active boundary is inclusive at exactly ttlMs", () => {
  const now = 1_000_000;
  const evs = [mk("INF-9", "Bash", now - 120_000)]; // exactly ttlMs old
  const [g] = groupByTicket(evs, { now, ttlMs: 120_000 });
  assert.equal(g.active, true);                       // ageMs === ttlMs -> active
  const [g2] = groupByTicket([mk("INF-9", "Bash", now - 120_001)], { now, ttlMs: 120_000 });
  assert.equal(g2.active, false);                     // one ms past -> idle
});

test("relativeTime buckets", () => {
  assert.equal(relativeTime(2_000), "now");
  assert.equal(relativeTime(6_000), "6s ago");
  assert.equal(relativeTime(120_000), "2m ago");
  assert.equal(relativeTime(3 * 3600_000), "3h ago");
  assert.equal(relativeTime(2 * 86_400_000), "2d ago");
});

test("renderLiveHtml escapes and shows a no-data state", () => {
  assert.match(renderLiveHtml([]), /no-data|no recent/i);
  const html = renderLiveHtml([
    { key: "INF-1", tool: "Bash", branch: "INF-1-x", cwd: "/c", lastTs: 0, ageMs: 6000, active: true, column: "in-progress", count: 3 },
  ]);
  assert.match(html, /INF-1/);
  assert.match(html, /Bash/);
  assert.match(html, /6s ago/);
  assert.match(html, /in-progress/);
});

test("renderLiveHtml escapes hostile fields", () => {
  const html = renderLiveHtml([
    { key: "<x>", tool: "<img>", branch: "\"'&", cwd: "/c", lastTs: 0, ageMs: 1000, active: true, column: null, count: 1 },
  ]);
  assert.doesNotMatch(html, /<img>/);
  assert.match(html, /&lt;img&gt;/);
});
