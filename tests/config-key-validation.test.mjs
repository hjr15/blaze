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
import { matchersFor, selectNextTicket } from "../scripts/loops/groomer.mjs";

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

// --- BLZ-402 review finding 2: cfg.projects[] members are keys too, and were unchecked ---
//
// `loadConfig` validated `cfg.key` only. `cfg.projects` entries reach `new RegExp(...)`
// completely unchecked wherever a caller derives per-project matchers from them —
// `scripts/loops/groomer.mjs`'s `matchersFor` being the one an adversarial review actually
// drove a `SyntaxError` and an over-broad match out of. The PR body's claim that
// `assertValidKey` is "the ONE key validator ... on the config-LOAD path" was false until
// every entry of `cfg.projects`, not just `cfg.key`, goes through it.
test("BLZ-402 review finding 2: loadConfig refuses a metacharacter entry in cfg.projects", () => {
  const dir = withConfig({ key: "ENG", projects: ["A(", "ENG"] });
  assert.throws(
    () => loadConfig({ root: dir, env: {} }),
    (e) => e instanceof InvalidProjectKeyError
      && e.message.startsWith("blaze: ")
      && e.message.includes('"A("')
      && e.message.includes("projects"),
    "a bad entry in cfg.projects must be refused at load, naming the entry",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("BLZ-402 review finding 2: loadConfig refuses an over-broad-but-valid-regex entry ('A.*') in cfg.projects", () => {
  const dir = withConfig({ key: "ENG", projects: ["A.*"] });
  assert.throws(
    () => loadConfig({ root: dir, env: {} }),
    (e) => e instanceof InvalidProjectKeyError && e.message.includes('"A.*"'),
    "an entry that is valid regex but not a valid KEY shape must be refused, not carried into a matcher",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("BLZ-402 review finding 2: a fully valid cfg.projects array loads without complaint", () => {
  const dir = withConfig({ key: "ENG", projects: ["ENG", "OBA2"] });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.deepEqual(cfg.projects, ["ENG", "OBA2"]);
  rmSync(dir, { recursive: true, force: true });
});

test("BLZ-402 review finding 2: end to end — matchersFor/selectNextTicket never see an unchecked key,"
  + " because loadConfig refused the board first", () => {
  // Before the fix: `loadConfig` accepted this board without a word, and `matchersFor`
  // crashed with the engine's own SyntaxError the moment `selectNextTicket` walked
  // project "A("'s directory — the exact `SyntaxError` the config-load path was supposed
  // to have made unreachable.
  const root = mkdtempSync(join(tmpdir(), "blaze-keyval-groom-"));
  mkdirSync(join(root, "projects", "A(", "backlog"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "ENG", projects: ["A(", "ENG"] }));
  assert.throws(
    () => loadConfig({ root, env: {} }),
    (e) => e instanceof InvalidProjectKeyError,
    "loadConfig itself must refuse this board — matchersFor must never be reached with 'A('",
  );
  // And directly: matchersFor/selectNextTicket have no shape check of their own, so a
  // config that (wrongly) carried "A(" through would still blow up here. This is the
  // danger loadConfig's refusal exists to make unreachable, demonstrated the same way
  // the existing idsFromSubject test above demonstrates it for reconcile.
  assert.throws(
    () => matchersFor({ fileRegex: /x/, idLineRegex: /x/ }, "A("),
    /Unterminated group|Invalid regular expression/,
    "matchersFor builds new RegExp(key) with no shape check — this is the raw crash a" +
    " reachable 'A(' would still produce",
  );
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-402 review finding 2: an over-broad projects entry ('A.*') would let selectNextTicket"
  + " claim an id outside its own project — refused at load instead", () => {
  // Demonstrates the SECOND half of the danger (over-broad match, not a crash): unchecked,
  // "A.*" matches ANY file, including one that plainly belongs to project ENG.
  // "ABC-7-other.md" / id "ABC-7", matching the exact reproduction in the review: the
  // filename must itself start with literal "A" for `^A.*-\d+.*\.md$` to match at all —
  // that literal "A" is the part `.*` cannot stand in for.
  const root = mkdtempSync(join(tmpdir(), "blaze-keyval-groom2-"));
  mkdirSync(join(root, "projects", "A.*", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "A.*", "backlog", "ABC-7-other.md"),
    "---\nid: ABC-7\n---\n");
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "ENG", projects: ["A.*"] }));
  assert.throws(
    () => loadConfig({ root, env: {} }),
    (e) => e instanceof InvalidProjectKeyError,
    "loadConfig must refuse 'A.*' — the over-broad match below is exactly AC-3's danger",
  );
  // Directly: an unchecked "A.*" cfg would let selectNextTicket walk into project "A.*"'s
  // directory and match ABC-7 — a ticket claiming an id outside its own project's key.
  const cfg = { loops: { groomer: { columns: ["backlog"] } }, projects: ["A.*"], fileRegex: /x/, idLineRegex: /x/ };
  const found = selectNextTicket(root, cfg, { groomed: {} });
  assert.equal(found?.id, "ABC-7",
    "unchecked, the over-broad key claims a ticket outside its own project — the load-time refusal prevents this cfg from ever being built");
  rmSync(root, { recursive: true, force: true });
});
