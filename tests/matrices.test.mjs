// tests/matrices.test.mjs — BLZ-682: `blaze matrices`, replacing blaze-pm's build_matrices.py.
//
// GENERATOR-ORACLE, IN MINIATURE. tests/fixtures/matrices-board/docs/matrices/ is the output
// `python3 scripts/build_matrices.py --project ENG` wrote for that fixture board, committed
// byte for byte, so every assertion below compares against the script's own output rather than
// a hand-derived expectation. The board exercises each rule: goals sorted as strings, `ref`
// ordering with a TIE (ENG-7/ENG-8 have no ref — path order, not id order), Implements
// tracing, Addresses by link, by `engine ADR-n` prose and by the `**Addresses:**` fallback, the
// `[:4]`/`[:5]` truncations, an untraced decision, and `?` for a missing ref.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fsReadStorage } from "../scripts/model/read-storage.mjs";
import { matrixFiles } from "../scripts/model/matrices.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";
import { QUIET } from "./helpers/db-board.mjs";

const scratch = scratchRegistry();
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "matrices-board");
const CLI = join(HERE, "..", "scripts", "cli.mjs");
const NAMES = ["eng-requirements-matrix.md", "eng-architecture-matrix.md"];
const expected = (name) => readFileSync(join(FIXTURE, "docs", "matrices", name), "utf8");

/** A private copy of the fixture board, so a run may write into it. */
function copy() {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz682-matrices-")));
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}
function matrices(root, args = [], env = {}) {
  const base = { ...process.env };
  delete base.BLAZE_WRITE_PORT;
  delete base.BLAZE_READONLY;
  return spawnSync(process.execPath, [CLI, "matrices", ...args],
    { encoding: "utf8", env: { ...base, BLAZE_PROJECTS_DIR: join(root, "projects"), ...env } });
}

test("matrixFiles reproduces the script's two files byte for byte", () => {
  const tickets = [...fsReadStorage.listTickets(join(FIXTURE, "projects"))];
  const files = matrixFiles(tickets, "ENG", (t) => relative(FIXTURE, t.file));
  assert.deepEqual(Object.keys(files), NAMES);
  for (const n of NAMES) assert.equal(files[n], expected(n), n);
});

test("a tie on ref is broken by PATH, as a sorted glob would — not by id, not by walk order", () => {
  const tickets = [...fsReadStorage.listTickets(join(FIXTURE, "projects"))].reverse();
  const arch = matrixFiles(tickets, "ENG", (t) => relative(FIXTURE, t.file))["eng-architecture-matrix.md"];
  assert.ok(arch.indexOf("ENG-8 |") < arch.indexOf("ENG-7 |"),
    "accepted/ENG-8 sorts before proposed/ENG-7 whatever order the tickets arrive in");
  assert.equal(arch, expected("eng-architecture-matrix.md"));
});

test("only the named project's tickets are rendered", () => {
  const tickets = [...fsReadStorage.listTickets(join(FIXTURE, "projects"))];
  const other = matrixFiles(tickets, "OPS", () => "x")["ops-requirements-matrix.md"];
  assert.match(other, /^# OPS requirements traceability matrix/);
  assert.match(other, /\*\*0\*\* requirements — 0 implemented, 0 proposed/);
});

test("blaze matrices --check: in sync exits 0; a drifted file exits 1 and is named", () => {
  const root = copy();
  const ok = matrices(root, ["--check"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /matrices are in sync with the tickets/);
  writeFileSync(join(root, "docs", "matrices", NAMES[0]), "hand-edited\n");
  const drift = matrices(root, ["--check"]);
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /MATRIX DRIFT — regenerate: eng-requirements-matrix\.md$/m);
  assert.equal(readFileSync(join(root, "docs", "matrices", NAMES[0]), "utf8"), "hand-edited\n",
    "--check writes nothing");
});

test("blaze matrices --out writes the two files, and they are the script's", () => {
  const root = copy();
  const out = join(root, "elsewhere");
  const r = matrices(root, ["--out", out]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(out).sort(), [...NAMES].sort());
  for (const n of NAMES) assert.equal(readFileSync(join(out, n), "utf8"), expected(n), n);
  assert.match(r.stdout, /wrote elsewhere\/eng-requirements-matrix\.md/);
});

test("BLAZE_READONLY refuses a write — even run directly — but allows --check", () => {
  const root = copy();
  const out = join(root, "ro");
  const viaCli = matrices(root, ["--out", out], { BLAZE_READONLY: "1" });
  assert.notEqual(viaCli.status, 0);
  assert.match(viaCli.stderr, /read-only mode \(BLAZE_READONLY=1\)/);
  const direct = spawnSync(process.execPath, [join(HERE, "..", "scripts", "matrices-runner.mjs"), "--out", out],
    { encoding: "utf8", env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects"), BLAZE_READONLY: "1" } });
  assert.equal(direct.status, 1);
  assert.match(direct.stderr, /refusing to run blaze matrices/);
  assert.equal(existsSync(out), false, "nothing written");
  assert.equal(matrices(root, ["--check"], { BLAZE_READONLY: "1" }).status, 0);
});

test("under BLAZE_WRITE_PORT=db the matrices come from the database, and match", async () => {
  const root = copy();
  assert.equal(await runDb(["init"], { ...QUIET, roots: { dataRoot: root, projectsDir: join(root, "projects") } }), 0);
  writeFileSync(join(root, "projects", "ENG", "implemented", "ENG-5-no-trace-yet.md"),
    "---\nid: ENG-5\ntitle: CHANGED ON DISK ONLY\ntype: requirement\nproject: ENG\n---\n\nx\n");
  const out = join(root, "from-db");
  const r = matrices(root, ["--out", out], { BLAZE_WRITE_PORT: "db" });
  assert.equal(r.status, 0, r.stderr);
  for (const n of NAMES) assert.equal(readFileSync(join(out, n), "utf8"), expected(n), n);
});

test("an empty board is refused (exit 2), never reported as in sync", () => {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz682-empty-")));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: [] }));
  const r = matrices(root, ["--check"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no projects found/);
});

test("an unknown argument, or --out with no value, is refused with the usage", () => {
  const root = copy();
  for (const args of [["--bogus"], ["--out"]]) {
    const r = matrices(root, args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, /usage: blaze matrices/);
  }
});
