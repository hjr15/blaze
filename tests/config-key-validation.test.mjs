// tests/config-key-validation.test.mjs — BLZ-402.
//
// `loadConfig`/`loadProject` used to interpolate a project key RAW into `new RegExp(...)`
// with no shape check: a metacharacter key blew up as a raw engine SyntaxError, and a
// valid-regex-but-not-a-key value (e.g. "A.*") built a silently over-broad matcher instead
// of being refused. Escaping alone would fix the crash but not the over-broad-match danger,
// which is why the fix here is a SHAPE check (`KEY_RE`/`assertValidKey`), not quoting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig, loadProject, KEY_RE, assertValidKey, InvalidProjectKeyError,
} from "../scripts/config.mjs";
import { idsFromSubject } from "../scripts/reconcile.mjs";

function withConfig(json) {
  const dir = mkdtempSync(join(tmpdir(), "blaze-keyval-"));
  if (json !== null) writeFileSync(join(dir, "blaze.config.json"), JSON.stringify(json));
  return dir;
}

test("BLZ-402: KEY_RE accepts upper-case-letters-and-digits starting with a letter", () => {
  for (const good of ["TASK", "OBA", "BLZ2", "A", "X9Y"]) {
    assert.ok(KEY_RE.test(good), `${good} should be a valid key shape`);
  }
});

test("BLZ-402: assertValidKey throws a named, catchable InvalidProjectKeyError on a bad shape", () => {
  assert.throws(() => assertValidKey("nope", { source: "test" }),
    (e) => e instanceof InvalidProjectKeyError && e.name === "InvalidProjectKeyError");
});

test("BLZ-402: a non-string key (e.g. a bare JSON number in blaze.config.json) is refused too", () => {
  // JSON.parse happily turns `"key": 123` into a number; nothing upstream of assertValidKey
  // coerces it back to a string, so the shape check must reject non-strings outright rather
  // than letting one reach `KEY_RE.test` (which would coerce and could mislead).
  const dir = withConfig({ key: 123 });
  assert.throws(
    () => loadConfig({ root: dir, env: {} }),
    (e) => e instanceof InvalidProjectKeyError,
  );
  rmSync(dir, { recursive: true, force: true });
});

// --- Consequence 1: the metacharacter key that used to throw a raw SyntaxError -----------
test("BLZ-402: loadProject refuses a metacharacter key with a blaze: refusal, not a raw SyntaxError", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-keyval-"));
  const projectsDir = join(root, "projects");
  mkdirSync(join(projectsDir, "A("), { recursive: true });
  assert.throws(
    () => loadProject("A(", { root, projectsDir, allowMissing: true }),
    (e) => e instanceof InvalidProjectKeyError
      && e.name !== "SyntaxError"
      && e.message.startsWith("blaze: ")
      && e.message.includes('"A("'),
    "must be a named blaze: refusal naming the bad key, not the engine's own SyntaxError",
  );
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-402: loadConfig refuses a metacharacter key from the config file, not a raw SyntaxError", () => {
  const dir = withConfig({ key: "A(" });
  assert.throws(
    () => loadConfig({ root: dir, env: {} }),
    (e) => e instanceof InvalidProjectKeyError && e.message.startsWith("blaze: "),
  );
  rmSync(dir, { recursive: true, force: true });
});

// --- Consequence 2: the over-broad-but-valid-regex key ------------------------------------
// First, prove the danger this prevents: `idsFromSubject` builds its matcher straight from
// whatever key it is given, with no shape check of its own. Fed a regex-metacharacter key
// unchecked, it lets a subject belonging to a DIFFERENT project's ticket read as a match.
test("BLZ-402: unchecked, an over-broad key lets idsFromSubject claim another project's ticket", () => {
  // idsFromSubject has no shape check of its own — it builds its matcher straight from
  // whatever key it is handed. A key of ".*" (which assertValidKey refuses outright, since
  // it doesn't even start with a letter) makes it match a subject that plainly belongs to
  // a DIFFERENT project (ZZZ), which is the exact over-broad-match danger the refusal at
  // load time exists to prevent from ever reaching this function.
  assert.deepEqual(idsFromSubject("ZZZ-9: fix the thing", ".*"), [".*-9"],
    "this is the exact over-broad-match danger assertValidKey exists to refuse before it reaches here");
});

test("BLZ-402: an over-broad-but-valid-regex key ('A.*') is REFUSED, not silently built into idRegex", () => {
  const dir = withConfig({ key: "A.*" });
  assert.throws(
    () => loadConfig({ root: dir, env: {} }),
    (e) => e instanceof InvalidProjectKeyError && e.message.includes('"A.*"'),
    "a key that is valid regex but not a valid KEY shape must be refused, not built into a working matcher",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("BLZ-402: loadProject refuses the same over-broad key", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-keyval-"));
  const projectsDir = join(root, "projects");
  mkdirSync(join(projectsDir, "A.*"), { recursive: true });
  assert.throws(
    () => loadProject("A.*", { root, projectsDir, allowMissing: true }),
    (e) => e instanceof InvalidProjectKeyError,
  );
  rmSync(root, { recursive: true, force: true });
});

// --- AC-2: the BLAZE_KEY env override goes through the SAME check, not a bypass ----------
test("BLZ-402: a bad BLAZE_KEY is refused even when blaze.config.json's key is fine", () => {
  const dir = withConfig({ key: "OK" });
  assert.throws(
    () => loadConfig({ root: dir, env: { BLAZE_KEY: "A(" } }),
    (e) => e instanceof InvalidProjectKeyError
      && e.message.includes("BLAZE_KEY")
      && e.message.includes('"A("'),
    "the env override must be validated, not accepted as a bypass around a valid file key",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("BLZ-402: a good BLAZE_KEY still overrides a fine file key (no false refusal)", () => {
  const dir = withConfig({ key: "OK" });
  const cfg = loadConfig({ root: dir, env: { BLAZE_KEY: "OPS2" } });
  assert.equal(cfg.key, "OPS2");
  rmSync(dir, { recursive: true, force: true });
});
