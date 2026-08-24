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
import { join, dirname } from "node:path";
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

const CREATE_TABLE = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([A-Za-z_][\w.]*)\s*\(([\s\S]*?)\n\s*\)/g;

/**
 * Every table in `ddl` whose body carries the singleton CHECK, by fully-qualified name.
 * Returns the parsed/total table count too, so a regex that silently stops early is a
 * failure rather than a short answer.
 */
function singletonTables(ddl) {
  const names = new Set();
  let parsed = 0;
  for (const m of ddl.matchAll(CREATE_TABLE)) {
    parsed++;
    if (SINGLETON.test(m[2])) names.add(m[1]);
  }
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
  for (const line of section[1].split("\n")) {
    const m = /^\|\s*`([\w.]+)`\s*\|(.+?)\|\s*$/.exec(line);
    if (m) rows.push({ table: m[1], citations: [...m[2].matchAll(/`([\w./-]+\.mjs):(\d+)`/g)].map((c) => ({ file: c[1], line: Number(c[2]) })) });
  }
  return rows;
}

test("BLZ-362: ADR-0014 lists exactly the singleton tables the engine emits", () => {
  const rows = documentedInventory(readFileSync(ADR, "utf8"));
  assert.notEqual(rows, null, "ADR-0014 must carry a `| Singleton table | Declared at |` inventory");
  const documented = [...new Set(rows.map((r) => r.table))].sort();
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
  const rows = documentedInventory(readFileSync(ADR, "utf8"));
  assert.notEqual(rows, null, "ADR-0014 must carry a `| Singleton table | Declared at |` inventory");
  let checked = 0;
  for (const row of rows) {
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

test("BLZ-362: no module outside the executed set declares a singleton", () => {
  // The inventory is only complete if the three modules it executes are the only ones
  // that can produce a singleton. A fourth grows one, this goes red, and the test is
  // extended rather than the ADR quietly understating itself again.
  const dir = join(ROOT, "scripts", "model");
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith(".mjs") && !(f in DDL))
    .filter((f) => SINGLETON.test(readFileSync(join(dir, f), "utf8")));
  assert.deepEqual(offenders, [],
    `these modules declare a singleton the ADR-0014 inventory does not read: ${offenders.join(", ")}`);
});

test("BLZ-362: ADR-0014 does not claim one installation is one board", () => {
  // The claim was contradicted by the render layer on the day it was written —
  // `deriveBoards()` landed 2026-07-09, the ADR 2026-08-22. Guarded on the live count so
  // this pins the contradiction rather than merely banning a phrase.
  const boards = deriveBoards({ types: DEFAULT_TYPES, workflows: DEFAULT_WORKFLOWS });
  assert.ok(boards.length > 1,
    `deriveBoards() returned ${boards.length} — with one board the ADR's original sentence would be true and this test is meaningless`);
  assert.doesNotMatch(readFileSync(ADR, "utf8"), /^[^>\n]*One installation is one board\./m,
    `ADR-0014 still asserts "One installation is one board" as its own claim, but deriveBoards() ` +
    `returns ${boards.length}: ${boards.map((b) => b.name).join(", ")}`);
});
