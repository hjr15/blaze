// tests/adr-0014-singletons.test.mjs — BLZ-362.
//
// ADR-0014's Context named the v3 singleton tables, and three of the four things it said
// about them were wrong: it named `board_config`, which has never existed; it omitted
// `blaze_config.config_version`, which does exist; and it counted `migration_mode` twice,
// as "the two write-rules tables", when it is one table declared once per dialect.
//
// That is not a typo, because other work reasons from an ADR. BLZ-362 records the
// neighbouring sentence being quoted to the operator as the settled model on a day when
// the code had already disagreed with it. A decision record that is wrong about what
// exists is worse than no record, because it is quoted with confidence.
//
// A prose fix alone drifts again the next time a singleton is added or renamed. That is
// precisely what BLZ-356 found for `docs/schema-versioning.md`, and the remedy here is the
// one that ticket established: make the doc a checked artefact. The inventory is DERIVED
// from the DDL the engine actually emits and asserted against the names the ADR prints, so
// the two cannot disagree without a red test.
//
// Scope, stated honestly. BLZ-362 judged three of its four errors mechanically detectable and
// the omission not. Set equality against the derived inventory catches the omission too, so
// all three table errors fall to one assertion — a named table that does not exist, a real one
// left out, and one counted twice. The fourth error, "one installation is one board", is a
// claim about the render layer rather than the schema, and is pinned separately at the bottom.
//
// NOTE for a future session: the cited line numbers are load-bearing and WILL go stale if
// a singleton's declaration moves — BLZ-377 adds tables to `config-schema.mjs`, for one.
// That is the check working, not a flaw in it: the assertion prints the line the CHECK is
// on now, so the repair is a one-line edit to the ADR's table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { configDdl } from "../scripts/model/config-schema.mjs";
import { projectionDdl } from "../scripts/model/projection-schema.mjs";
import { writeRulesDdl } from "../scripts/model/write-rules.mjs";
import { deriveBoards } from "../scripts/model/boards.mjs";
import { DEFAULT_TYPES } from "../scripts/model/schema.mjs";
import { DEFAULT_WORKFLOWS } from "../scripts/model/workflows.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADR = join(ROOT, "docs", "decisions", "0014-tenancy-is-deferred-and-row-level-is-ruled-out.md");

/** A singleton is `id integer PRIMARY KEY CHECK (id = 1)` — ADR-0014's own definition. */
const SINGLETON = /CHECK\s*\(\s*id\s*=\s*1\s*\)/;

/** The three modules that emit DDL containing a singleton. Asserted complete below. */
const DDL = { "config-schema.mjs": configDdl, "projection-schema.mjs": projectionDdl, "write-rules.mjs": writeRulesDdl };

/**
 * Strip `--` line comments and single-quoted literals, so a `CREATE TABLE` mentioned in a
 * comment or in a string literal is not counted as a table. Both produced wrong answers
 * before this existed: a commented-out CREATE TABLE mis-attributed a real singleton to a
 * phantom table name.
 *
 * It does NOT understand dollar-quoted (`$$ ... $$`) bodies, and does not pretend to. No DDL
 * this repo emits contains one. If that changes, an odd quote inside such a body over-strips —
 * and because `total` is counted on the RAW input, that surfaces as a loud `parsed !== total`
 * failure rather than a silently short inventory.
 */
function decommented(sql) {
  let out = "", i = 0;
  while (i < sql.length) {
    if (sql[i] === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; continue; }
    if (sql[i] === "'") {
      i++;
      while (i < sql.length) { if (sql[i] === "'" && sql[i + 1] === "'") i += 2; else if (sql[i] === "'") { i++; break; } else i++; }
      out += "''";
      continue;
    }
    out += sql[i++];
  }
  return out;
}

const CREATE_HEAD = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([A-Za-z_][\w.]*)\s*\(/g;

/**
 * Every table in `ddl` whose body carries the singleton CHECK, by fully-qualified name.
 *
 * The body is delimited by PAREN DEPTH, not by a line that starts with `)`. An adversarial
 * review broke the line-anchored version with a table whose multi-line CHECK constraint
 * closes on its own line: the body was truncated before the singleton, the table was
 * silently dropped from the inventory, and the parsed/total guard still reported a complete
 * read. That is the exact "understates itself silently" mode this function claims to refuse.
 *
 * Returns parsed/total as well, so a scanner that stops early is a failure rather than a
 * short answer.
 */
function singletonTables(ddl) {
  const sql = decommented(ddl);
  const names = new Set();
  let parsed = 0;
  for (const m of sql.matchAll(CREATE_HEAD)) {
    let depth = 1, i = m.index + m[0].length;
    const start = i;
    while (i < sql.length && depth > 0) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
      i++;
    }
    if (depth !== 0) continue;            // unbalanced: not a table we can read
    parsed++;
    if (SINGLETON.test(sql.slice(start, i - 1))) names.add(m[1]);
  }
  // `total` counts the RAW input, never the decommented copy. Counting the stripped text let
  // anything `decommented()` over-removed vanish from `parsed` AND `total` together, so
  // `parsed === total` still held and the guard could not see its own blindness — the exact
  // "understates itself silently" mode this function claims to refuse. Round 2 of review
  // reproduced it with an odd quote in a `$$` body swallowing the next real table.
  return { names, parsed, total: (ddl.match(/CREATE TABLE/g) || []).length };
}

/** The singleton inventory the engine actually emits, for one dialect. */
function derivedInventory(dialect) {
  const names = new Set();
  for (const emit of Object.values(DDL)) {
    const { names: found, parsed, total } = singletonTables(emit(dialect));
    assert.equal(parsed, total,
      `the DDL parser read ${parsed} of ${total} CREATE TABLE statements for ${dialect} — ` +
      `an inventory built from a partial read would understate itself silently`);
    for (const n of found) names.add(n);
  }
  assert.ok(names.size > 0, `no singleton tables found for ${dialect} — the parser found nothing, which is not a result`);
  return names;
}

/**
 * The `| \`table\` | citations |` rows of the ADR's singleton table. Anchored on the
 * heading so ordinary prose backticks elsewhere in the ADR cannot be mistaken for rows.
 */
function documentedInventory(text) {
  const section = /\|\s*Singleton table\s*\|\s*Declared at\s*\|\n\|[-\s|]+\|\n([\s\S]*?)(?:\n\n|\n[^|])/.exec(text);
  if (!section) return null;
  const rows = [];
  const unparsed = [];
  for (const line of section[1].split("\n")) {
    if (!line.trim()) continue;
    const m = /^\|\s*`([\w.]+)`\s*\|(.+?)\|\s*$/.exec(line);
    // Silently skipping a row it cannot read would let the ADR name a table that does not
    // exist — the ORIGINAL board_config error — and stay green, because an unreadable row is
    // invisible to set equality. An adversarial review landed exactly that with an unbackticked
    // name. Every line in the section must parse, or the inventory is not the inventory.
    if (m) rows.push({ table: m[1], citations: [...m[2].matchAll(/`([\w./-]+\.mjs):(\d+)`/g)].map((c) => ({ file: c[1], line: Number(c[2]) })) });
    else unparsed.push(line);
  }
  return { rows, unparsed };
}

test("BLZ-362: ADR-0014 lists exactly the singleton tables the engine emits", () => {
  const parsed = documentedInventory(readFileSync(ADR, "utf8"));
  assert.notEqual(parsed, null, "ADR-0014 must carry a `| Singleton table | Declared at |` inventory");
  assert.deepEqual(parsed.unparsed, [],
    `these inventory rows could not be read, so their table names were never checked:\n  ${parsed.unparsed.join("\n  ")}`);
  const documented = [...new Set(parsed.rows.map((r) => r.table))].sort();
  const derived = [...derivedInventory("sqlite")].sort();
  assert.deepEqual(documented, derived,
    `ADR-0014's singleton inventory disagrees with the DDL.\n` +
    `  ADR says:  ${documented.join(", ") || "(none)"}\n` +
    `  DDL emits: ${derived.join(", ")}`);
});

test("BLZ-362: both drivers agree on the singleton inventory", () => {
  // The original error counted one table twice by reading two dialects as two tables.
  // If the dialects ever genuinely diverged, the ADR could not name one set at all.
  assert.deepEqual([...derivedInventory("sqlite")].sort(), [...derivedInventory("postgres")].sort(),
    "the SQLite and Postgres dialects declare different singleton tables");
});

test("BLZ-362: every file:line ADR-0014 cites lands on the singleton CHECK", () => {
  const parsed = documentedInventory(readFileSync(ADR, "utf8"));
  assert.notEqual(parsed, null, "ADR-0014 must carry a `| Singleton table | Declared at |` inventory");
  assert.deepEqual(parsed.unparsed, [], "an inventory row could not be read, so its citations were never checked");
  let checked = 0;
  for (const row of parsed.rows) {
    assert.ok(row.citations.length > 0, `${row.table} is listed with no file:line citation`);
    for (const { file, line } of row.citations) {
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      const at = lines[line - 1];
      assert.notEqual(at, undefined, `${file}:${line} (cited for ${row.table}) is past the end of the file — it has ${lines.length} lines`);
      const elsewhere = lines.flatMap((l, i) => (SINGLETON.test(l) ? [i + 1] : []));
      assert.match(at, SINGLETON,
        `${file}:${line} is cited for ${row.table} but carries no \`CHECK (id = 1)\`.\n` +
        `  that line reads: ${at.trim()}\n` +
        `  the CHECKs in that file are now on lines: ${elsewhere.join(", ") || "(none)"}`);
      checked++;
    }
  }
  assert.ok(checked >= 4, `only ${checked} citations were checked — the inventory should cite at least one site per singleton`);
});

test("BLZ-362: no module anywhere under scripts/ declares a singleton the inventory misses", () => {
  // The inventory is only complete if the three modules it executes are the only ones that
  // can produce a singleton. A fourth grows one, this goes red, and the test is extended
  // rather than the ADR quietly understating itself again.
  //
  // RECURSIVE, and over all of scripts/. The first version read `scripts/model/` alone and
  // non-recursively, which an adversarial review broke twice over: `scripts/init-pg.mjs`
  // emits DDL and sits outside that directory, and any subdirectory was invisible. A
  // completeness guard that scans one flat directory is not a completeness guard.
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  const files = walk(join(ROOT, "scripts")).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.length > 20, `only ${files.length} .mjs files found under scripts/ — the walk is not finding them`);
  // Exempt by PATH, not basename. Making the walk recursive turned a path-exact exemption
  // into a wildcard: `scripts/legacy/config-schema.mjs` would have been silently exempt
  // across all 140 files under scripts/ merely for sharing a name.
  const EXECUTED = new Set(Object.keys(DDL).map((f) => join("scripts", "model", f)));
  const offenders = files
    .filter((f) => !EXECUTED.has(relative(ROOT, f)))
    .filter((f) => SINGLETON.test(readFileSync(f, "utf8")))
    .map((f) => relative(ROOT, f));
  assert.deepEqual(offenders, [],
    `these modules declare a singleton the ADR-0014 inventory does not read: ${offenders.join(", ")}`);
});

/** ADR-0014's Context section alone — the part that makes claims in the ADR's own voice.
 *  The Amendment at the foot quotes the retracted sentence deliberately and must not be
 *  read as an assertion of it. */
function contextSection(text) {
  const m = /\n## Context\n([\s\S]*?)\n## /.exec(text);
  return m ? m[1] : null;
}

test("BLZ-362: ADR-0014's Context states the corrected claim, not the refuted one", () => {
  // Scoped to the Context, and PINNED POSITIVELY. Two reasons, both found by adversarial
  // review of the first version, which banned one literal spelling across the whole file:
  //
  //   - As a ban it was trivially evaded. Dropping the full stop, wrapping the sentence over
  //     a line break, lowercasing it, or paraphrasing it all sailed through while the ADR
  //     asserted the refuted claim. A ban can only ever enumerate spellings; a positive pin
  //     fails whenever the sentence stops saying the true thing, however it is rephrased.
  //   - As a whole-file ban it had a FALSE POSITIVE waiting: the Amendment's own preserved
  //     quote of the retracted sentence escaped only because it happens to straddle a line
  //     break. Reflowing that paragraph, without changing a word, would have turned this red.
  const boards = deriveBoards({ types: DEFAULT_TYPES, workflows: DEFAULT_WORKFLOWS });
  assert.ok(boards.length > 1,
    `deriveBoards() returned ${boards.length} — with one board the ADR's original sentence would be true and this test is meaningless`);
  const ctx = contextSection(readFileSync(ADR, "utf8"));
  assert.notEqual(ctx, null, "ADR-0014 must have a Context section");
  assert.match(ctx, /One installation is one installation\./,
    "the Context no longer carries the corrected sentence — if it was rewritten, say what is true now");
  assert.doesNotMatch(ctx, /one installation is one board/i,
    `ADR-0014's Context asserts "one installation is one board", but deriveBoards() returns ` +
    `${boards.length}: ${boards.map((b) => b.name).join(", ")}`);

  // Scoping the ban to the Context lost every OTHER section: the sentence reasserted verbatim
  // under Consequences was invisible. The whole-file ban is therefore restored, exempting only
  // the Amendment — the one section that quotes the retracted sentence on purpose.
  const text = readFileSync(ADR, "utf8");
  const outsideAmendment = text.slice(0, text.indexOf("\n## Amendment"));
  assert.ok(text.includes("\n## Amendment"), "the Amendment section must exist to be exempted");
  assert.doesNotMatch(outsideAmendment, /one installation is one board/i,
    "ADR-0014 asserts the refuted sentence outside its Amendment, where it is not a quotation");
});
