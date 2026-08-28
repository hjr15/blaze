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
  //
  // BLZ-412: the class alone used to be the whole assertion here, so a refusal that stopped
  // being a `blaze: ` line and stopped naming the offending value kept this green. What the
  // name promises is a REFUSAL, and a refusal the operator cannot read is not one.
  const dir = withConfig({ key: 123 });
  assert.throws(
    () => loadConfig({ root: dir, env: {} }),
    (e) => e instanceof InvalidProjectKeyError
      && e.message.startsWith("blaze: ")
      && e.message.includes("123"),
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
//
// BLZ-411: this block used to open with a test that asserted ONLY
// `idsFromSubject("ZZZ-9: …", ".*")`. That is a demonstration of the DANGER, and it names
// no guard at all — deleting `assertValidKey`'s body outright left it green, so NO mutation
// of the thing it was filed under could kill it. Measured on `df13824`: with
// `assertValidKey` reduced to a no-op, 11 of the 15 tests in this file went red and that
// one stayed green.
//
// It now asserts the GUARD — that ".*" is refused before any caller can hand it to a
// matcher builder — and keeps the demonstration as the REASON, below the assertion it
// justifies.
//
// The demonstration deliberately does not pin `idsFromSubject`'s subject GRAMMAR. BLZ-455
// widens it to admit `KEY-n — desc` beside `KEY-n:`; this asserts only that an over-broad
// key claims an id that belongs to another project, which is true of either grammar.
test("BLZ-402/BLZ-411: the over-broad key '.*' is REFUSED at every load path, so idsFromSubject"
  + " can never be reached with it", () => {
  assert.throws(
    () => assertValidKey(".*", { source: "test" }),
    (e) => e instanceof InvalidProjectKeyError
      && e.message.startsWith("blaze: ")
      && e.message.includes('".*"'),
    "the GUARD is what this test exists to pin — not the danger it prevents");
  const dir = withConfig({ key: ".*" });
  assert.throws(
    () => loadConfig({ root: dir, env: {} }),
    (e) => e instanceof InvalidProjectKeyError && e.message.includes('".*"'),
    "and it must be refused on the path a board actually takes, not only by the helper");
  rmSync(dir, { recursive: true, force: true });
  // WHY it is refused, demonstrated rather than asserted about: `idsFromSubject` builds its
  // matcher straight from whatever key it is handed, with no shape check of its own. Handed
  // ".*" it claims a subject that plainly belongs to a DIFFERENT project (ZZZ). The refusal
  // above is what makes that unreachable.
  assert.ok(idsFromSubject("ZZZ-9: fix the thing", ".*").includes(".*-9"),
    "unchecked, an over-broad key claims another project's ticket — which is why it is refused above");
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

// BLZ-412: this test's NAME promises a refusal — the `blaze: ` line an operator reads — and
// it asserted only `e instanceof InvalidProjectKeyError`. Measured on `df13824`: strip the
// `blaze: ` prefix and the `${JSON.stringify(key)}` out of `assertValidKey`'s message and
// this test stayed green while the two tests that DO assert the message went red. A test
// that names a refusal must assert the refusal.
test("BLZ-402/BLZ-412: loadProject refuses the same over-broad key with a blaze: refusal that NAMES it", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-keyval-"));
  const projectsDir = join(root, "projects");
  mkdirSync(join(projectsDir, "A.*"), { recursive: true });
  assert.throws(
    () => loadProject("A.*", { root, projectsDir, allowMissing: true }),
    (e) => e instanceof InvalidProjectKeyError
      && e.message.startsWith("blaze: ")
      && e.message.includes('"A.*"'),
    "the operator must be told WHICH key was refused, not merely that something threw");
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

// --- BLZ-410: an EMPTY override is a caller error, not an absent one ----------------------
//
// `loadConfig` tested `env.BLAZE_KEY` for TRUTHINESS, so `BLAZE_KEY=""` was discarded and
// the file key silently won. The shape that produces it is ordinary and silent: a shell
// script that does `BLAZE_KEY="$SOME_UNSET_VAR" blaze move ...` asks for one board and
// gets another, with no message on any stream. BLZ-394 settled exactly this shape for
// `--project=` — an empty value is a caller error — and the same reasoning applies to an
// env override.
test("BLZ-410: an EMPTY BLAZE_KEY is REFUSED, not discarded so the file key silently wins", () => {
  const dir = withConfig({ key: "OK" });
  assert.throws(
    () => loadConfig({ root: dir, env: { BLAZE_KEY: "" } }),
    (e) => e instanceof InvalidProjectKeyError
      && e.message.startsWith("blaze: ")
      && e.message.includes("BLAZE_KEY")
      && e.message.includes('""'),
    "an empty override is a caller error (an unset shell variable), not an absent override",
  );
  rmSync(dir, { recursive: true, force: true });
});

test("BLZ-410: a whitespace-only BLAZE_KEY is refused too — it is not a key, and it is not absent", () => {
  const dir = withConfig({ key: "OK" });
  assert.throws(
    () => loadConfig({ root: dir, env: { BLAZE_KEY: "  " } }),
    (e) => e instanceof InvalidProjectKeyError && e.message.includes("BLAZE_KEY"),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("BLZ-410 control: an ABSENT BLAZE_KEY still falls back to the file key", () => {
  // The whole point of the change is that ABSENT and EMPTY stop being the same thing. This
  // is the half that must NOT move.
  const dir = withConfig({ key: "OK" });
  assert.equal(loadConfig({ root: dir, env: {} }).key, "OK");
  assert.equal(loadConfig({ root: dir, env: { BLAZE_PORT: "8080" } }).key, "OK");
  rmSync(dir, { recursive: true, force: true });
});

// --- BLZ-408: the refusal names the source it was actually given -------------------------
//
// `loadProject` hardcoded `source: "a --project argument"` for every caller. Its callers
// include `edit.mjs` and `move.mjs`, which pass a TICKET'S OWN `project:` frontmatter, and
// `cli.mjs`'s preflight, which passes a directory name off a disk listing. An operator with
// one corrupt ticket file was told to fix a `--project` argument they never typed.
test("BLZ-408: loadProject's refusal names the SOURCE it was given, and does not invent a --project argument", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-keyval-src-"));
  const projectsDir = join(root, "projects");
  assert.throws(
    () => loadProject("A(", {
      root, projectsDir, allowMissing: true, source: "ticket ENG-1's 'project' field",
    }),
    (e) => e instanceof InvalidProjectKeyError
      && e.message.includes("ticket ENG-1's 'project' field")
      && !e.message.includes("--project"),
    "a caller passing ticket frontmatter must not be told to fix a --project argument",
  );
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-408: the DEFAULT source is neutral — it never claims a --project argument either", () => {
  // cli.mjs's preflight and reconcile.mjs pass no source; the default must be true for them.
  const root = mkdtempSync(join(tmpdir(), "blaze-keyval-src2-"));
  const projectsDir = join(root, "projects");
  assert.throws(
    () => loadProject("A(", { root, projectsDir, allowMissing: true }),
    (e) => e instanceof InvalidProjectKeyError && !e.message.includes("--project"),
    "the default must describe what every caller has in common, not what one of them has",
  );
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-408: the ONE caller that really does hold a --project argument still says so", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-keyval-src3-"));
  const projectsDir = join(root, "projects");
  assert.throws(
    () => loadProject("A(", {
      root, projectsDir, allowMissing: true, source: "a --project argument",
    }),
    (e) => e instanceof InvalidProjectKeyError && e.message.includes("a --project argument"),
  );
  rmSync(root, { recursive: true, force: true });
});

// --- BLZ-409: the refusal is short enough to read at 2am ---------------------------------
test("BLZ-409: the invalid-key refusal is short, still states the rule, and keeps the rest discoverable", () => {
  let msg = "";
  try { assertValidKey("eng", { source: "blaze.config.json's 'key' field" }); }
  catch (e) { msg = e.message; }
  const words = msg.trim().split(/\s+/).length;
  // 70 words on `df13824`, almost all of it regex rationale for what is nearly always a
  // typo. The ceiling is the point of the ticket, so it is asserted, not described.
  assert.ok(words <= 40, `the refusal is ${words} words and must stay under 40:\n${msg}`);
  assert.match(msg, /upper-case letters and digits, starting with a letter/,
    "the RULE itself must survive the shortening — that is the actionable half");
  assert.match(msg, /docs\/decisions\/0025-a-project-key-is-refused-never-normalised\.md/,
    "the reasoning must stay DISCOVERABLE from the refusal, not merely deleted");
  assert.match(msg, /"eng"/, "and the offending value must still be named");
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
