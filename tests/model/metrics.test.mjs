// tests/model/metrics.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { metricsModel } from "../../scripts/model/metrics.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function ticket(id, status, created, project = "T") {
  return { file: `${id}.md`, meta: { id, created }, body: "", status, project };
}

// Fixture: 3 tickets, all created 2026-06-20.
// T-1: defined -> in-progress (06-21) -> done (06-23). Currently "done".
// T-2: defined -> in-progress (06-22). Currently "in-progress", never done.
// T-3: defined -> in-progress (06-21) -> in-review (06-24). Currently "in-review".
function board() {
  const t1 = ticket("T-1", "done", "2026-06-20");
  const t2 = ticket("T-2", "in-progress", "2026-06-20");
  const t3 = ticket("T-3", "in-review", "2026-06-20");
  return {
    selected: "all",
    projects: { T: 3 },
    columns: [
      { dir: "done", label: "Done", tickets: [t1] },
      { dir: "in-progress", label: "In Progress", tickets: [t2] },
      { dir: "in-review", label: "In Review", tickets: [t3] },
    ],
    total: 3,
    rollup: {},
  };
}

function transitions() {
  return [
    { id: "T-1", from: "defined", to: "in-progress", ts: "2026-06-21T00:00:00Z" },
    { id: "T-1", from: "in-progress", to: "done", ts: "2026-06-23T00:00:00Z" },
    { id: "T-2", from: "defined", to: "in-progress", ts: "2026-06-22T00:00:00Z" },
    { id: "T-3", from: "defined", to: "in-progress", ts: "2026-06-21T00:00:00Z" },
    { id: "T-3", from: "in-progress", to: "in-review", ts: "2026-06-24T00:00:00Z" },
  ];
}

const NOW = Date.parse("2026-06-25T10:00:00Z");

test("metricsModel computes exact tile numbers from board + transitions", () => {
  const { tiles } = metricsModel({ board: board(), transitions: transitions(), now: NOW, project: "all" });
  assert.equal(tiles.total, 3);
  assert.equal(tiles.inFlight, 2); // T-2 (in-progress) + T-3 (in-review)
  assert.equal(tiles.donePct, 33); // round(1/3*100)
  assert.equal(tiles.throughput14d, 1); // only T-1's ->done, within 14d of NOW
  assert.equal(tiles.medianCycleTime, 3 * DAY_MS); // T-1: 06-23 - 06-20
});

test("metricsModel builds a daily CFD series whose per-day counts sum to the ticket total", () => {
  const { series } = metricsModel({ board: board(), transitions: transitions(), now: NOW, project: "all" });
  assert.equal(series.length, 6); // 06-20 .. 06-25 inclusive
  assert.deepEqual(series.map((s) => s.date), [
    "2026-06-20", "2026-06-21", "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25",
  ]);
  for (const day of series) {
    const sum = Object.values(day.counts).reduce((a, b) => a + b, 0);
    assert.equal(sum, 3, `day ${day.date} counts should sum to 3`);
  }
  // Spot-check the known statuses on a couple of days.
  assert.equal(series[0].counts["defined"], 3); // 06-20: all three still "defined"
  assert.equal(series[3].counts["done"], 1); // 06-23: T-1 done
  assert.equal(series[3].counts["in-progress"], 2); // T-2, T-3 still in-progress
  const last = series[series.length - 1];
  assert.equal(last.counts["done"], 1);
  assert.equal(last.counts["in-progress"], 1);
  assert.equal(last.counts["in-review"], 1);
});

test("metricsModel degrades cleanly with no transitions: series is [], throughput/median null-out, tiles stay board-derived", () => {
  const { tiles, series } = metricsModel({ board: board(), transitions: [], now: NOW, project: "all" });
  assert.equal(tiles.total, 3); // still from board
  assert.equal(tiles.inFlight, 2); // still board-derived
  assert.equal(tiles.donePct, 33); // still board-derived
  assert.equal(tiles.throughput14d, 0);
  assert.equal(tiles.medianCycleTime, null);
  assert.deepEqual(series, []);
});

test("metricsModel degrades series to [] on empty transitions even when board has no tickets at all", () => {
  const empty = { selected: "all", projects: {}, columns: [], total: 0, rollup: {} };
  const { tiles, series } = metricsModel({ board: empty, transitions: [], now: NOW, project: "all" });
  assert.equal(tiles.total, 0);
  assert.equal(tiles.inFlight, 0);
  assert.equal(tiles.donePct, 0); // 0 guard, not NaN
  assert.equal(tiles.throughput14d, 0);
  assert.equal(tiles.medianCycleTime, null);
  assert.deepEqual(series, []);
});

test("metricsModel never reads the wall clock: identical now yields identical output across calls", () => {
  const a = metricsModel({ board: board(), transitions: transitions(), now: NOW, project: "all" });
  const b = metricsModel({ board: board(), transitions: transitions(), now: NOW, project: "all" });
  assert.deepEqual(a, b);
});

test("metricsModel scopes tiles + transitions to a single project", () => {
  const t1 = ticket("A-1", "done", "2026-06-20", "A");
  const t2 = ticket("B-1", "in-progress", "2026-06-20", "B");
  const mixedBoard = {
    selected: "all",
    projects: { A: 1, B: 1 },
    columns: [
      { dir: "done", label: "Done", tickets: [t1] },
      { dir: "in-progress", label: "In Progress", tickets: [t2] },
    ],
    total: 2,
    rollup: {},
  };
  const mixedTransitions = [
    { id: "A-1", from: "in-progress", to: "done", ts: "2026-06-22T00:00:00Z" },
    { id: "B-1", from: "defined", to: "in-progress", ts: "2026-06-21T00:00:00Z" },
  ];
  const { tiles, series } = metricsModel({ board: mixedBoard, transitions: mixedTransitions, now: NOW, project: "A" });
  assert.equal(tiles.throughput14d, 1); // only A-1's ->done counted
  assert.notEqual(series.length, 0);
  for (const day of series) {
    const sum = Object.values(day.counts).reduce((a, b) => a + b, 0);
    assert.equal(sum, 1, `day ${day.date} should only tally project A's ticket`);
  }
});
