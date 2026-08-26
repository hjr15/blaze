// tests/cli.test.mjs — BLZ-119: cli.mjs must handle --help/-h AT DISPATCH,
// before any runner spawns. This is what stops an unrecognised flag falling
// through to a real mutation (the original bug), and guarantees a future
// subcommand can't ship without help by omission.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEntry, ledgerPath } from "../scripts/pending-ledger.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(REPO, "scripts", "cli.mjs");

test("blaze --help prints the full usage listing (all subcommands) and exits 0", () => {
  const r = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: blaze/);
  for (const name of ["reconcile", "sprint", "commit", "migrate", "rollup"]) {
    assert.match(r.stdout, new RegExp(`\\b${name}\\b`));
  }
});

test("blaze -h prints the full usage listing and exits 0", () => {
  const r = spawnSync(process.execPath, [cli, "-h"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: blaze/);
});

test("blaze commit --help prints subcommand help, exits 0, and never spawns the runner", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cli-help-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "seed"), "seed");
  execFileSync("git", ["-C", root, "add", "seed"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-1.md"), "x");
  appendEntry(root, { id: "OBA-1", op: "new", message: "OBA-1: x", files: ["projects/OBA/backlog/OBA-1.md"], ts: "t" });
  const queue = ledgerPath(root);
  const beforeBytes = readFileSync(queue);
  const beforeHead = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") };
  delete env.BLAZE_SESSION;
  const r = spawnSync(process.execPath, [cli, "commit", "--help"], { cwd: root, env, encoding: "utf8" });

  assert.equal(r.status, 0);
  assert.match(r.stdout, /commit/i);
  assert.deepEqual(readFileSync(queue), beforeBytes, "runner must never have run — queue byte-identical");
  assert.equal(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), beforeHead, "HEAD must not move");
  rmSync(root, { recursive: true, force: true });
});

test("blaze new -h prints subcommand help and exits 0 without creating a ticket", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cli-help-new-"));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"], commitMode: "batch" }));
  mkdirSync(join(root, "projects", "OBA"), { recursive: true });
  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") };
  const r = spawnSync(process.execPath, [cli, "new", "-h"], { env, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /new/i);
  assert.ok(!existsSync(join(root, "projects", "OBA", "defined")), "no ticket dir must have been created");
  rmSync(root, { recursive: true, force: true });
});

test("blaze sprint --help prints subcommand help, exits 0, and never spawns the runner", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-cli-help-sprint-"));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"], commitMode: "batch" }));
  mkdirSync(join(root, "projects", "OBA"), { recursive: true });
  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") };
  const r = spawnSync(process.execPath, [cli, "sprint", "--help"], { env, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /sprint/i);
  assert.ok(!existsSync(join(root, "sprints.json")), "runner must never have run — no sprints.json written");
  rmSync(root, { recursive: true, force: true });
});

test("blaze bogus-command --help falls back to the full usage and exits non-zero", () => {
  const r = spawnSync(process.execPath, [cli, "bogus-command", "--help"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /usage: blaze/);
});

test("blaze <unknown> still prints usage and exits non-zero (unchanged behaviour)", () => {
  const r = spawnSync(process.execPath, [cli, "bogus-command"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /usage: blaze/);
});

// Shared table-parsing helper: evaluates SUBCOMMANDS as a plain object
// literal (strings/booleans only, no imports) straight out of cli.mjs's
// source — never executes cli.mjs itself.
function parseSubcommands(src) {
  const m = src.match(/const SUBCOMMANDS = (\{[\s\S]*?\n\});/);
  assert.ok(m, "SUBCOMMANDS table not found in cli.mjs");
  return new Function(`return ${m[1]}`)();
}

// No-arg dispatch still wires to supervisor.mjs (unchanged): asserted
// against the dispatch TABLE, not a source regex on the ternary expression
// that resolves the key — a regex on `cmd === undefined ? "start" : cmd`
// breaks on a harmless refactor of that line's wording, and would still pass
// even if SUBCOMMANDS.start.file pointed at the wrong script (the regex only
// checks the key resolves to "start", never what "start" actually runs).
// Asserted at the source level rather than by executing it — supervisor.mjs
// starts a real server/loop and must never be spawned from a test.
test("blaze with no args still dispatches to supervisor.mjs (source-level guard)", () => {
  const src = readFileSync(cli, "utf8");
  const SUBCOMMANDS = parseSubcommands(src);
  assert.equal(SUBCOMMANDS.start.file, "supervisor.mjs");
});

// BLZ-121: SUBCOMMANDS is the single dispatch table (the switch was collapsed
// into it) — every entry must declare mutates:boolean so BLAZE_READONLY has a
// complete, source-verifiable classification to gate on.
test("every SUBCOMMANDS entry declares mutates: boolean", () => {
  const src = readFileSync(cli, "utf8");
  const SUBCOMMANDS = parseSubcommands(src);
  for (const [name, entry] of Object.entries(SUBCOMMANDS)) {
    assert.equal(typeof entry.mutates, "boolean", `${name}: mutates must be a boolean`);
  }
});

// Finding 3 (code-review, LOW): SUBCOMMANDS[cmd] resolves inherited
// Object.prototype keys ("constructor", "toString", "__proto__", ...) as a
// truthy `sub`, so the `if (!sub)` usage-fallback path never fires for them.
// Not exploitable (join(here, undefined) throws before spawnSync — no runner
// ever spawns), but it's the same class BLZ-119 exists to close: an
// unrecognised command must print usage and exit non-zero, cleanly — not a
// raw TypeError stack trace, and not a bogus "usage: blaze __proto__" with
// exit 0.
test("blaze constructor (an inherited Object.prototype key) prints usage and exits non-zero", () => {
  const r = spawnSync(process.execPath, [cli, "constructor"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /usage: blaze/);
  assert.doesNotMatch(r.stderr, /TypeError/);
});

test("blaze __proto__ --help (an inherited Object.prototype key) prints usage and exits non-zero", () => {
  const r = spawnSync(process.execPath, [cli, "__proto__", "--help"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /usage: blaze/);
});

// BLZ-56. The schema-preflight comment stated "TWO EXEMPTIONS" directly above a Set of
// THREE — the `commit` bullet had been appended below the closing paragraph and orphaned
// from the list, so the prose asserted what the code did not. That is the class this lane
// has already paid a review round for, so the count is now checked rather than trusted.
test("the schema-preflight comment's arithmetic matches the code beneath it", () => {
  const src = readFileSync(cli, "utf8");
  const SUBCOMMANDS = parseSubcommands(src);
  const m = src.match(/const SCHEMA_PREFLIGHT_EXEMPT = new Set\((\[[^\]]*\])\)/);
  assert.ok(m, "SCHEMA_PREFLIGHT_EXEMPT not found in cli.mjs");
  const exempt = new Function(`return ${m[1]}`)();
  const total = Object.keys(SUBCOMMANDS).length;
  const checked = total - exempt.length;

  // Every exempt name must actually be a subcommand — an exemption for a verb that does
  // not exist is a verb silently left unguarded under a name nobody dispatches.
  for (const name of exempt) {
    assert.ok(Object.hasOwn(SUBCOMMANDS, name), `${name} is exempt but is not a subcommand`);
  }
  const WORDS = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE"];
  // WORDS must fail LOUDLY rather than run off its end: `WORDS[6]` is `undefined`, and
  // `new RegExp("undefined EXEMPTIONS")` is a perfectly valid regex that simply never
  // matches — a sixth exemption would turn this assertion into a confusing failure about
  // a word nobody wrote, or (had the comment happened to contain it) into a pass.
  assert.ok(exempt.length < WORDS.length,
    `${exempt.length} exemptions, but WORDS only spells out ${WORDS.length - 1} — `
    + "add the next word to WORDS before adding the exemption");
  assert.match(src, new RegExp(`${WORDS[exempt.length]} EXEMPTIONS`),
    `the comment must say ${WORDS[exempt.length]} EXEMPTIONS — the Set holds ${exempt.length}`);
  assert.match(src, new RegExp(`${checked} of the ${total} subcommands`),
    `the comment must say "${checked} of the ${total} subcommands"`);

  // THE BULLETS: ONE CONTIGUOUS BLOCK, AND ITS SET EQUALS THE SET.
  //
  // The count alone killed only half of the original defect. That defect was the whole
  // `commit` bullet sitting BELOW the closing paragraph: three bullets in the file, the
  // count correct, and the list a reader actually scans naming two. Reproduced against
  // the count-only assertion, it passed. So does an EXTRA bullet for a verb that is not
  // exempt at all — prose telling a reader `move` is exempt when it is not, which is the
  // same lie backwards. Contiguity kills the first; set EQUALITY (not containment) kills
  // the second.
  //
  // Scoped to the comment block directly above the Set, so an unrelated bullet-shaped
  // line elsewhere in cli.mjs cannot fail this, while a bullet orphaned to the far end of
  // THIS comment — the original defect exactly — still can.
  const lines = src.split("\n");
  const setLine = lines.findIndex((l) => l.startsWith("const SCHEMA_PREFLIGHT_EXEMPT"));
  assert.ok(setLine > 0, "SCHEMA_PREFLIGHT_EXEMPT's declaration line not found");
  let start = setLine;
  while (start > 0 && lines[start - 1].startsWith("//")) start -= 1;
  const BULLET = /^\/\/ {3}(\S+) +—/;      // exactly three spaces after `//`: a bullet.
  const WRAPPED = /^\/\/ ( {4,})\S/;       // deeper: a bullet's continuation line.
  const at = [];
  for (let i = start; i < setLine; i += 1) if (BULLET.test(lines[i])) at.push(i);
  assert.ok(at.length, "no exemption bullets found in the comment above the Set");
  for (let i = at[0]; i <= at[at.length - 1]; i += 1) {
    assert.ok(BULLET.test(lines[i]) || WRAPPED.test(lines[i]),
      `the exemption bullets must be ONE contiguous block — line ${i + 1} interrupts it, `
      + `so a bullet below it is orphaned from the list: ${lines[i]}`);
  }
  // AND THE CLOSING PARAGRAPH SITS BELOW THE WHOLE LIST. Contiguity alone cannot see the
  // original defect's real shape, because that shape does not interrupt anything: re-indent
  // the closing `That leaves N of the M subcommands` paragraph deep enough to read as a
  // continuation line, drop the blank `//` that separated it, and it is ABSORBED into the
  // block — after which a bullet moved below it is still "contiguous" and still orphaned
  // from the list a reader scans. Two earlier rounds tried to classify that paragraph by its
  // INDENT (four or more spaces; then, tighter, a depth differing from the first continuation
  // line's). Both lost to a paragraph re-indented to the depth the guard was looking for —
  // the second to a paragraph at the bullets' own continuation depth — and the depth rule
  // additionally red-lit LEGITIMATE reformatting, since re-padding the bullet names for a
  // longer exemption moves every continuation line to a new depth at once.
  //
  // So stop inferring structure from indentation and pin the invariant directly: whatever
  // that paragraph is indented to, its line must come AFTER the last bullet. That is the
  // thing the guard exists for, and it is true of the correct file and false of every
  // orphaned-bullet arrangement, at any indent.
  const closing = lines.findIndex((l, i) =>
    i >= start && i < setLine && l.includes(`That leaves ${checked} of the ${total} subcommands`));
  assert.ok(closing >= 0,
    `the comment above the Set must close with "That leaves ${checked} of the ${total} subcommands"`);
  assert.ok(closing > at[at.length - 1],
    `the closing "That leaves ..." paragraph (line ${closing + 1}) must sit BELOW the last `
    + `exemption bullet (line ${at[at.length - 1] + 1}) — a bullet below that paragraph is `
    + "orphaned from the list, which is the defect this block has already paid for twice");
  const bullets = at.map((i) => lines[i].match(BULLET)[1]);
  assert.deepEqual([...bullets].sort(), [...exempt].sort(),
    "the bullets and SCHEMA_PREFLIGHT_EXEMPT must name the SAME verbs — a missing bullet "
    + "hides a real exemption, an extra one claims an exemption the code does not grant");
});
