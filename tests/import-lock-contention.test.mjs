// tests/import-lock-contention.test.mjs — BLZ-640's own test, design §8 item 8:
//
//   "One test: two `--apply` runs over one file, one exits 5 with nothing
//    written, the board holds each source key once."
//
// The scenario §7 names is the one reproduced here: `--allocate-ids` plus a
// mapping that declares a `sourceIdColumn`. Two runs started together would
// each pass the exit-5 receipt check (each sees the other's receipt as empty),
// each allocate a number for the same source key, and each append a pair —
// §4.2's first-occurrence lookup keeps one and the other is a ticket nothing
// reads. That is the duplicate this lock exists to make impossible.
//
// TWO TESTS, TWO KINDS OF CONTENTION, DELIBERATELY:
//
//   1. a lock held by a live owner in ANOTHER PROCESS (this test runner) —
//      deterministic, and it pins the refusal's shape and "nothing written";
//   2. TWO REAL `blaze import --apply` PROCESSES, genuinely overlapping — the
//      property itself. Its ordering is not a race: the second is not started
//      until the lock directory the first took is observed on disk, so the
//      first is provably inside the guarded region when the second begins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { writeCsv } from "../scripts/model/csv.mjs";
import { RECEIPT_DIR } from "../scripts/model/import-apply.mjs";
import { headerDigest } from "../scripts/model/import-mapping.mjs";
import {
  importLockPath, acquireImportLock, releaseImportLock,
} from "../scripts/model/import-lock.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(REPO, "scripts", "cli.mjs");

function board(t) {
  const root = mkdtempSync(join(tmpdir(), "blaze-import-lock-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "projects", "BLZ", "defined"), { recursive: true });
  spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  spawnSync("git", ["-C", root, "config", "user.email", "t@example.com"]);
  spawnSync("git", ["-C", root, "config", "user.name", "t"]);
  return root;
}

/** The §7 scenario's mapping: a foreign CSV whose own `Key` column is the
 *  identity, with blaze allocating the ids. */
function mappingAt(root) {
  mkdirSync(join(root, "import-mappings"), { recursive: true });
  const p = join(root, "import-mappings", "acme.json");
  writeFileSync(p, JSON.stringify({
    mappingVersion: 1, schemaVersion: 1, name: "acme",
    source: { columns: ["Key", "Name"], sha256: headerDigest(["Key", "Name"]) },
    sourceIdColumn: "Key",
    columns: {
      title: { from: "Name" }, description: { from: "Name" },
      type: { constant: "task" }, status: { constant: "defined" },
      project: { constant: "BLZ" }, estimate: { constant: "30" },
    },
    unmapped: [],
  }));
  return p;
}

function foreignCsvAt(root, n) {
  const p = join(root, "foreign.csv");
  const rows = [["Key", "Name"]];
  for (let i = 1; i <= n; i++) rows.push([`ACME-${i}`, `row ${i}`]);
  writeFileSync(p, writeCsv(rows));
  return p;
}

const envFor = (root) => {
  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") };
  delete env.BLAZE_SESSION;
  return env;
};

const importArgs = (mapping, src) =>
  ["import", "--apply", "--allocate-ids", "--mapping", mapping, src];

function run(root, args) {
  return spawnSync(process.execPath, [cli, ...args],
    { cwd: root, env: envFor(root), encoding: "utf8" });
}

const ticketsOf = (root) => {
  try { return readdirSync(join(root, "projects", "BLZ", "defined")); } catch { return []; }
};
const pairsOf = (root) => {
  try {
    return readFileSync(join(root, "source-ids", "acme.jsonl"), "utf8")
      .split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
  } catch { return []; }
};

test("a second --apply that contends the import lock exits 5 and writes NOTHING", (t) => {
  const root = board(t);
  const mapping = mappingAt(root);
  const src = foreignCsvAt(root, 1);

  // A LIVE owner in another process: this test runner. `process.kill(pid, 0)`
  // on it succeeds, so the dead-owner theft arm does not fire and the lock is
  // genuinely held for the duration of the spawned run.
  assert.equal(acquireImportLock(root, { session: "holder" }).ok, true);
  const r = run(root, importArgs(mapping, src));
  releaseImportLock(root);

  assert.equal(r.status, 5,
    "§8 item 8: a contended lock is exit 5 — a record the run must establish before it may write");
  assert.match(r.stderr, /another import holds/);
  assert.match(r.stderr, /import\.lock/);
  assert.match(r.stderr, /session holder/, "the refusal names the owner it found");

  // "with nothing written" is the whole of the claim, so every artefact the
  // run would have produced is checked — including the two the lock is placed
  // BEFORE the prune and the exit-5 check to protect.
  assert.deepEqual(ticketsOf(root), [], "no ticket");
  assert.deepEqual(pairsOf(root), [], "no pair in the source-ids map");
  assert.equal(existsSync(join(root, "source-ids")), false, "not even the map's directory");
  assert.deepEqual(readdirSync(join(root, RECEIPT_DIR)), [],
    "no receipt: the lock is taken before the run opens one");
  assert.equal(existsSync(join(root, "projects", "BLZ", ".ids")), false,
    "no id reservation and no claim — §5.5's residue is not created either");
});

test("the lock is released after a run, so the next --apply proceeds and is a no-op", (t) => {
  const root = board(t);
  const mapping = mappingAt(root);
  const src = foreignCsvAt(root, 1);

  const first = run(root, importArgs(mapping, src));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(existsSync(importLockPath(root)), false,
    "released when the verb returns — a lock left held would wedge every later import");

  const second = run(root, importArgs(mapping, src));
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /SKIPPED/);
  assert.equal(ticketsOf(root).length, 1,
    "the board holds the source key ACME-1 exactly once — no duplicate, no phantom");
  assert.equal(pairsOf(root).filter((p) => p.source === "ACME-1").length, 1, "one pair, once");
});

test("a dry run takes NO lock — it writes nothing there is anything to serialise", (t) => {
  const root = board(t);
  const mapping = mappingAt(root);
  const src = foreignCsvAt(root, 1);
  assert.equal(acquireImportLock(root, { session: "holder" }).ok, true);
  const r = run(root, ["import", "--allocate-ids", "--mapping", mapping, src]);
  releaseImportLock(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WOULD CREATE/,
    "the lock guards the write phase, which is the one phase a dry run does not have");
});

test("two genuinely concurrent --apply runs: one exits 5, and each source key lands exactly once",
  async (t) => {
    const root = board(t);
    const mapping = mappingAt(root);
    const N = 300;
    const src = foreignCsvAt(root, N);

    const first = spawn(process.execPath, [cli, ...importArgs(mapping, src)],
      { cwd: root, env: envFor(root), stdio: ["ignore", "pipe", "pipe"] });
    const firstDone = new Promise((res) => {
      let out = "", err = "";
      first.stdout.on("data", (d) => { out += d; });
      first.stderr.on("data", (d) => { err += d; });
      first.on("close", (code) => res({ status: code, stdout: out, stderr: err }));
    });

    // Not a sleep and not a guess: wait until the FIRST run's lock directory
    // is on disk. Past that point it is provably inside the guarded region,
    // and 300 rows of claim + ticket + two receipt appends each keep it there
    // for far longer than the second run needs to start.
    const deadline = Date.now() + 20_000;
    while (!existsSync(importLockPath(root)) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 5));
    }
    assert.equal(existsSync(importLockPath(root)), true,
      "the first run must be holding the lock before the second is started");

    const second = run(root, importArgs(mapping, src));
    const a = await firstDone;

    const codes = [a.status, second.status].sort();
    assert.deepEqual(codes, [0, 5],
      `exactly one run may proceed: got ${JSON.stringify(codes)} `
      + `(first: ${a.stderr}) (second: ${second.stderr})`);

    // Without the lock this is where the duplicate appears: 600 tickets for
    // 300 source keys, half of them with a pair nothing reads (§4.2, §7).
    assert.equal(ticketsOf(root).length, N,
      "one ticket per source key — not two, which is the duplicate §4.2 exists to prevent");
    const pairs = pairsOf(root);
    assert.equal(pairs.length, N, "one pair per source key");
    assert.equal(new Set(pairs.map((p) => p.source)).size, N, "every source key distinct");
    assert.equal(new Set(pairs.map((p) => p.id)).size, N, "every allocated id distinct");
    assert.equal(existsSync(importLockPath(root)), false, "and the lock is gone afterwards");
  });
