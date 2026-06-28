import { test } from "node:test";
import assert from "node:assert/strict";
import { mapData, pageHtml, tryServeAsset } from "../scripts/serve.mjs";

test("mapData returns flattened tickets with the required keys", () => {
  const data = mapData();
  assert.ok(Array.isArray(data));
  for (const t of data) {
    for (const k of ["id", "title", "priority", "status", "updated", "parent", "labels", "bodyHtml"]) {
      assert.ok(k in t, `missing key ${k}`);
    }
  }
});

test("pageHtml includes the Map view scaffolding", () => {
  const html = pageHtml();
  assert.match(html, /data-view="map"/);
  assert.match(html, /id="blaze-map-data"/);
  assert.match(html, /class="mapview"/);
  assert.match(html, /\/assets\/map-view\.js/);
});

test("tryServeAsset serves the map module and rejects other urls", () => {
  let code = 0, body = "";
  const res = { writeHead: (c) => { code = c; }, end: (b) => { body = b; } };
  assert.equal(tryServeAsset({ url: "/assets/map-view.js" }, res), true);
  assert.equal(code, 200);
  assert.match(body, /export function buildForest/);
  assert.equal(tryServeAsset({ url: "/nope" }, { writeHead() {}, end() {} }), false);
});
