// tests/migrate/jira-client.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheFile, writeRawCache, readRawCache } from "../../scripts/migrate/jira-client.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "blaze-cache-")); }

test("writeRawCache then readRawCache round-trips the issues array", () => {
  const dir = tmp();
  writeRawCache(dir, "OBA", [{ key: "OBA-1" }, { key: "OBA-2" }]);
  const got = readRawCache(dir, "OBA");
  assert.equal(got.length, 2);
  assert.equal(got[0].key, "OBA-1");
  rmSync(dir, { recursive: true, force: true });
});

test("cacheFile builds <dir>/<key>.json", () => {
  assert.equal(cacheFile("/c", "INF"), join("/c", "INF.json"));
});

test("readRawCache accepts a bare array file", () => {
  const dir = tmp();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "INF.json"), JSON.stringify([{ key: "INF-1" }]));
  assert.equal(readRawCache(dir, "INF")[0].key, "INF-1");
  rmSync(dir, { recursive: true, force: true });
});

test("readRawCache throws a clear message when the cache is missing", () => {
  const dir = tmp();
  assert.throws(() => readRawCache(dir, "OBA"), /jira-export-migrator|populate/i);
  rmSync(dir, { recursive: true, force: true });
});
