// tests/csv-round-trip.test.mjs — BLZ-630: the CSV round-trip gate.
//
// Design §3.1 and §3.3 (docs/design/csv-import-and-export.md), and ADR-0037 §5.
//
//     A  ──blaze export --format csv──▶  X
//     X  ──blaze import --apply──▶  B   (an empty board)
//     B  ──blaze export --format csv──▶  Y
//
// THREE GATES, BECAUSE THE OBVIOUS ONE IS BLIND.
//
//   Gate 1 — `diff X Y` is empty, byte for byte. Catches IMPORTER defects.
//   Gate 2 — `zeroDiff(A, B).valueDiffs` is empty. Catches EXPORTER defects,
//            and without it gate 1 is vacuous: X and Y come from the SAME
//            exporter, so any exporter defect is common-mode and cancels in
//            the diff. The refuting input is trivial — an exporter that emits
//            a correct 31-name header and an empty cell for 21 of the 31
//            columns passes gate 1 byte-for-byte AND passes `blaze audit`.
//   Gate 3 — every one of the 31 columns is non-empty in at least one row of
//            X. Gates 1 and 2 both compare CORPORA; neither notices a column
//            that is empty EVERYWHERE, in the fixture and in both exports
//            alike.
//
// THIS SUITE IS DELIBERATELY NOT IN board-gate.yml. It needs a temp board,
// and the repo's most important correctness gate has to be runnable locally
// and mutation-testable — encoding it in CI-workflow YAML would make it the
// one piece of test logic nobody can run without pushing.
//
// The revert test that proves gate 2 DISCRIMINATES is BLZ-631, in
// tests/csv-round-trip-revert.test.mjs. A gate merged without it is, in this
// campaign's own words, a decoration.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { exportCsv } from "../scripts/model/export-rows.mjs";
import { parseCsv } from "../scripts/model/csv.mjs";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { fsReadStorage } from "../scripts/model/read-storage.mjs";
import { zeroDiff } from "../scripts/migrate/zero-diff.mjs";
import { missingClaimErrors } from "../scripts/model/index.mjs";
import { claimPath, cutoverPath } from "../scripts/model/claims.mjs";
import { TYPES, PRIORITIES } from "../scripts/model/schema.mjs";
import { WORKFLOWS, RESOLUTIONS } from "../scripts/model/workflows.mjs";
import { LINK_TYPES } from "../scripts/model/links.mjs";
import {
  REPO, FIXTURE_PROJECTS, roundTrip, importInto, cleanUp,
} from "./helpers/csv-round-trip.mjs";

// --- one run, shared by every gate -------------------------------------------

const cleanup = [];
let X; let Y; let B; let imported;

before(async () => {
  const rt = roundTrip({ cleanup });
  X = rt.X; B = rt.B;
  imported = await importInto(rt);
  assert.equal(imported.exitCode, 0,
    `the import of the fixture must succeed before any gate means anything:\n${imported.report}`);
  Y = exportCsv(join(B, "projects")).text;
});

process.on("exit", () => cleanUp(cleanup));

// --- the fixture itself ------------------------------------------------------

describe("BLZ-630: the fixture is the gate's real content", () => {
  test("it exports with no hostile cells, so the round trip is not measuring a refusal", () => {
    const { warnings } = exportCsv(FIXTURE_PROJECTS);
    assert.deepEqual(warnings, []);
  });

  test("the id sequence has GAPS, so the round trip cannot pass by renumbering", () => {
    const nums = parseCsv(X).slice(1)
      .filter((r) => r[COLUMN_NAMES.indexOf("project")] === "BLZ")
      .map((r) => Number(r[COLUMN_NAMES.indexOf("id")].split("-")[1]));
    assert.ok(nums.length > 1);
    assert.ok(nums.some((n, i) => i > 0 && n - nums[i - 1] > 1), "no gap in the id sequence");
  });

  test("a row with `priority` ABSENT and a DIFFERENT row with `assignee` absent both exist", () => {
    const rows = parseCsv(X).slice(1);
    const pi = COLUMN_NAMES.indexOf("priority");
    const ai = COLUMN_NAMES.indexOf("assignee");
    const noPriority = rows.filter((r) => r[pi] === "");
    const noAssignee = rows.filter((r) => r[ai] === "");
    assert.ok(noPriority.length >= 1,
      "requiring all 7 priorities is NOT the same as requiring a priority-ABSENT row, and the "
      + "enum-coverage assertion cannot produce one — without this the §2.6 defaults conflict "
      + "stays green in CI");
    assert.ok(noAssignee.length >= 1);
    assert.notDeepEqual(noPriority.map((r) => r[1]), noAssignee.map((r) => r[1]),
      "on DIFFERENT tickets — on the live board these are not a shared cohort");
  });

  test("the fixture project carries a .ids/.cutover marker — without it the claim guard is structurally untestable", () => {
    assert.equal(existsSync(cutoverPath(FIXTURE_PROJECTS, "BLZ")), true,
      "missingClaimErrors returns early at index.mjs:367 when readCutover is null, so a fresh "
      + "board stays silent forever and an importer that regressed to skipping claims would pass "
      + "CI indefinitely and fail only on the operator's real board");
  });
});

// --- gate 3 ------------------------------------------------------------------

describe("BLZ-630 gate 3: every one of the 31 columns is non-empty in at least one row of X", () => {
  // The artefact is X, not the fixture, and the distinction is load-bearing:
  // gate 3 over X catches an exporter that blanks a column; gate 3 over the
  // fixture does not, and "a column of the fixture" is ill-typed anyway,
  // since the fixture is a board of markdown tickets and has no columns.
  for (const [i, name] of COLUMN_NAMES.entries()) {
    test(`column \`${name}\` is non-empty somewhere in X`, () => {
      const rows = parseCsv(X).slice(1);
      assert.ok(rows.some((r) => r[i] !== ""),
        `every row of X has an empty \`${name}\` — gates 1 and 2 compare corpora and neither `
        + `notices a column empty EVERYWHERE`);
    });
  }
});

// --- the enum-coverage assertion --------------------------------------------

describe("BLZ-630: enum coverage, read from the REGISTRY and never from the corpus", () => {
  // Sampling the live board would miss `Cloners`, `none`, `urgent`, `lowest`
  // and `epic`, all of which have zero live instances (§1.6). Adding an enum
  // value without adding a fixture row therefore fails here — BLZ-589's last
  // acceptance criterion made mechanical instead of remembered.
  const valuesIn = (column) => {
    const i = COLUMN_NAMES.indexOf(column);
    return new Set(parseCsv(X).slice(1).map((r) => r[i]).filter((v) => v !== ""));
  };

  test("every declared TYPE appears in X", () => {
    for (const type of Object.keys(TYPES)) {
      assert.ok(valuesIn("type").has(type), `no fixture row has type ${type}`);
    }
  });

  test("every STATUS of every workflow appears in X", () => {
    const declared = new Set();
    for (const def of Object.values(WORKFLOWS)) for (const s of def.statuses) declared.add(s);
    const seen = valuesIn("status");
    for (const s of declared) assert.ok(seen.has(s), `no fixture row is in status ${s}`);
    assert.equal(declared.size, 13, "13 distinct statuses across 5 workflows (§1.3)");
  });

  test("every PRIORITY appears in X", () => {
    for (const p of PRIORITIES) assert.ok(valuesIn("priority").has(p), `no fixture row has priority ${p}`);
  });

  test("every RESOLUTION appears in X", () => {
    for (const r of RESOLUTIONS) assert.ok(valuesIn("resolution").has(r), `no fixture row has resolution ${r}`);
  });

  test("every LINK TYPE appears in X, `Cloners` included — it has zero live instances", () => {
    const i = COLUMN_NAMES.indexOf("links");
    const seen = new Set();
    for (const r of parseCsv(X).slice(1)) {
      if (r[i] === "") continue;
      for (const pair of r[i].split(";")) seen.add(pair.split(":")[0]);
    }
    for (const t of LINK_TYPES) assert.ok(seen.has(t), `no fixture row carries a ${t} link`);
  });

  test("X carries a cross-project link and a forward reference", () => {
    const li = COLUMN_NAMES.indexOf("links");
    const pi = COLUMN_NAMES.indexOf("parent");
    const idi = COLUMN_NAMES.indexOf("id");
    const rows = parseCsv(X).slice(1);
    assert.ok(rows.some((r) => r[li].includes("ZZZ-")), "no cross-project link");
    const num = (id) => Number(String(id).split("-")[1]);
    // §3.3's forward reference is a LINK "to a row that appears later in the
    // file". Rows are ordered (project asc, numeric id asc), so a link whose
    // target outranks its source numerically within the same project is one.
    // It is what forces the planner to read the file as a UNIT rather than as
    // a stream — at the moment this row is judged, its target does not exist
    // on the board and has not yet been seen in the file.
    assert.ok(rows.some((r) => r[li] !== "" && r[li].split(";").some((pair) => {
      const target = pair.split(":")[1];
      return target.startsWith("BLZ-") && num(target) > num(r[idi]);
    })), "no FORWARD link reference in the fixture");
    // And a parent chain, so parent-type legality is exercised too.
    assert.ok(rows.some((r) => r[pi] !== ""), "no fixture row carries a parent");
  });
});

// --- gate 1 ------------------------------------------------------------------

describe("BLZ-630 gate 1: diff X Y is empty, byte for byte", () => {
  test("X and Y are byte-identical", () => {
    if (X !== Y) {
      // A 200k-character assertion diff is unreadable; name the first
      // differing record instead.
      const xl = X.split("\n"); const yl = Y.split("\n");
      const i = xl.findIndex((l, k) => l !== yl[k]);
      assert.fail(`X and Y differ at line ${i + 1}:\n  X: ${xl[i]}\n  Y: ${yl[i]}`);
    }
    assert.equal(X, Y);
  });

  test("Y has the same record count as X — nothing dropped, nothing invented", () => {
    assert.equal(parseCsv(Y).length, parseCsv(X).length);
  });
});

// --- gate 2 ------------------------------------------------------------------

describe("BLZ-630 gate 2: zeroDiff compares the SOURCE board against the imported one, by value", () => {
  /**
   * THE WRAPPER, and it is not optional. `zero-diff.mjs:81` hard-codes
   * `loaded.listTickets(null)`, written for a database driver that ignores
   * the argument. B is a FILESYSTEM board, whose `listTickets(root)` is
   * `walkTickets(root)` — and `safeReaddir` swallows the error from
   * `walkTickets(null)` and returns []. So without this, `dst` is empty and
   * EVERY id lands in `missing`: it fails loud rather than silently, but it
   * never passes.
   *
   * It belongs in the test rather than in `zero-diff.mjs`: that module is
   * shared with the migration suites and its `null` convention is
   * load-bearing there.
   */
  const loadedB = () => ({ listTickets: () => fsReadStorage.listTickets(join(B, "projects")) });

  test("the comparator is REUSED, not reimplemented — and it reports no value diffs", () => {
    const r = zeroDiff(fsReadStorage, FIXTURE_PROJECTS, loadedB());
    assert.deepEqual(r.valueDiffs, [], "a field whose VALUE differs between A and B is data loss");
    assert.deepEqual(r.missing, [], "an id in A and not in B");
    assert.deepEqual(r.extra, [], "an id in B and not in A");
    assert.deepEqual(r.frozenViolations, []);
    assert.equal(r.ok, true);
  });

  test("POSITIVE CONTROL: `compared` and `fieldsChecked` are non-zero and match the corpus", () => {
    const r = zeroDiff(fsReadStorage, FIXTURE_PROJECTS, loadedB());
    const sourceCount = [...fsReadStorage.listTickets(FIXTURE_PROJECTS)].length;
    assert.ok(sourceCount > 0);
    assert.equal(r.compared, sourceCount,
      "a comparator handed two EMPTY corpora reports clean and the gate is measuring nothing — "
      + "assert the OBSERVATION happened, not just the value");
    // 26 scalar FIELDS + 2 ARRAY_FIELDS per compared ticket (zero-diff.mjs:130-136).
    assert.equal(r.fieldsChecked, sourceCount * 28);
  });

  test("the wrapper is genuinely load-bearing: the un-wrapped call sees an EMPTY board", () => {
    // Proving the hazard the wrapper exists for, rather than asserting it in
    // prose. `zeroDiff` would call `listTickets(null)` on the fs driver.
    const unwrapped = zeroDiff(fsReadStorage, FIXTURE_PROJECTS, fsReadStorage);
    assert.ok(unwrapped.missing.length > 0,
      "without the wrapper every id lands in `missing` — a recipe that was never runnable");
  });
});

// --- the claim guard (§5.5, §8 item 1) --------------------------------------

describe("BLZ-630: every imported ticket has a claim", () => {
  test("a claim file exists for every created ticket, asserted DIRECTLY", () => {
    // Directly, so this is independent of `missingClaimErrors`' own early
    // return — which is exactly the return that makes the audit blind here.
    const rows = parseCsv(X).slice(1);
    for (const r of rows) {
      const id = r[COLUMN_NAMES.indexOf("id")];
      const project = r[COLUMN_NAMES.indexOf("project")];
      const n = Number(id.split("-")[1]);
      assert.equal(existsSync(claimPath(join(B, "projects"), project, n)), true,
        `${id} was imported with no .ids/ claim — its id is not provably unique, and `
        + `\`blaze audit\` errors on every such ticket above the project's cutover`);
    }
  });

  test("with a cutover marker seeded, missingClaimErrors reports NOTHING on the imported board", () => {
    // THE TRAP THE TICKET WARNS ABOUT. The importer does not write a
    // `.cutover` on the explicit-id path — `ensureCutover` has exactly one
    // call site, inside `allocateId` (ids.mjs:72) — so a freshly imported
    // board never gets one, `readCutover` returns null, and the check stays
    // silent no matter how many claims are missing. Seeding the marker is
    // what makes the guard possible AT ALL.
    for (const project of ["BLZ", "ZZZ"]) {
      mkdirSync(join(B, "projects", project, ".ids"), { recursive: true });
      writeFileSync(cutoverPath(join(B, "projects"), project), "0\n");
    }
    const rows = [...fsReadStorage.listTickets(join(B, "projects"))]
      .map((t) => ({ id: t.frontmatter.id, project: t.project }));
    assert.ok(rows.length > 0);
    assert.deepEqual(missingClaimErrors(join(B, "projects"), rows), []);
  });

  test("and the guard is live: removing one claim makes it fire", () => {
    // The positive control on the check itself. Without this, "no errors"
    // could still mean "the check did not run".
    const victim = readdirSync(join(B, "projects", "BLZ", ".ids")).find((f) => /^\d+$/.test(f));
    rmSync(join(B, "projects", "BLZ", ".ids", victim));
    const rows = [{ id: `BLZ-${victim}`, project: "BLZ" }];
    const errs = missingClaimErrors(join(B, "projects"), rows);
    assert.equal(errs.length, 1, "the claim guard must actually fire when a claim is missing");
    assert.match(errs[0], new RegExp(`BLZ-${victim}`));
    // Put it back so a later test in this file is not affected by the probe.
    writeFileSync(join(B, "projects", "BLZ", ".ids", victim), `BLZ-${victim} probe\n`);
  });
});

// --- §3.3 step 7 -------------------------------------------------------------

describe("BLZ-630: the imported corpus passes blaze audit", () => {
  test("`blaze audit` over B exits 0", () => {
    // Noted as a WEAK check on its own — §3.1's blanking defect passes it —
    // but a round trip that produces a corpus the audit rejects has not
    // round-tripped.
    const env = { ...process.env, BLAZE_PROJECTS_DIR: join(B, "projects") };
    delete env.BLAZE_SESSION;
    const r = spawnSync(process.execPath, [join(REPO, "scripts", "cli.mjs"), "audit"],
      { cwd: B, env, encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  });
});
