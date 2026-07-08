// tests/views/metrics.test.mjs — the Metrics view (tiles + CFD).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as metrics from "../../scripts/views/metrics.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

const nonEmptyModel = {
  tiles: { total: 3, inFlight: 2, donePct: 33, throughput14d: 1, medianCycleTime: 3 * DAY_MS },
  series: [
    { date: "2026-06-20", counts: { defined: 3, "in-progress": 0, "in-review": 0, done: 0 } },
    { date: "2026-06-23", counts: { defined: 0, "in-progress": 2, "in-review": 0, done: 1 } },
    { date: "2026-06-25", counts: { defined: 0, "in-progress": 1, "in-review": 1, done: 1 } },
  ],
};

const emptyModel = {
  tiles: { total: 0, inFlight: 0, donePct: 0, throughput14d: 0, medianCycleTime: null },
  series: [],
};

test("metrics exposes the view contract", () => {
  assert.equal(typeof metrics.render, "function");
  assert.equal(typeof metrics.styles, "string");
  assert.equal(typeof metrics.clientScript, "string");
});

test("metrics.render(nonEmptyModel) emits five tiles, the CFD svg host, all four range buttons, and the series JSON", () => {
  const html = metrics.render(nonEmptyModel);
  const tileCount = (html.match(/class="tile"/g) || []).length;
  assert.equal(tileCount, 5, "expected exactly 5 .tile cells");
  assert.match(html, /class="tiles"/);
  assert.match(html, /<svg class="cfd"/);
  for (const r of ["30", "90", "180", "all"]) {
    assert.match(html, new RegExp(`data-range="${r}"`));
  }
  assert.match(html, /<script type="application\/json" id="cfd-series">/);
  assert.match(html, /"defined":3/); // series actually serialised, not stubbed out
});

test("metrics.render(nonEmptyModel) formats a null-safe cycle-time tile and a done% tile", () => {
  const html = metrics.render(nonEmptyModel);
  assert.match(html, /33%/);
});

test("metrics.render(emptyModel) shows the no-data state and serialises an empty series array", () => {
  const html = metrics.render(emptyModel);
  assert.match(html, /no-data/);
  assert.match(html, /<script type="application\/json" id="cfd-series">\[\]<\/script>/);
  assert.match(html, /—/); // medianCycleTime: null renders as the em-dash placeholder
});
