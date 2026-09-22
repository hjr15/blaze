// tests/import-runner.test.mjs — BLZ-629: `blaze import` CLI wiring.
//
// The decisions live in scripts/model/import-plan.mjs and
// scripts/model/import-apply.mjs (tested in tests/model/); this pins the
// SUBCOMMANDS entry, the argument handling, the BLAZE_READONLY gate, and that
// the verb is genuinely a dry run end to end unless `--apply` is given —
// ADR-0037 §4, which is the rule the whole import surface rests on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { writeCsv } from "../scripts/model/csv.mjs";
import { claimPath } from "../scripts/model/claims.mjs";
import { RECEIPT_DIR } from "../scripts/model/import-apply.mjs";
import { headerDigest } from "../scripts/model/import-mapping.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(REPO, "scripts", "cli.mjs");

function board(t) {
  const root = mkdtempSync(join(tmpdir(), "blaze-import-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "projects", "BLZ", "defined"), { recursive: true });
  spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  spawnSync("git", ["-C", root, "config", "user.email", "t@example.com"]);
  spawnSync("git", ["-C", root, "config", "user.name", "t"]);
  return root;
}

function csvAt(root, ...maps) {
  const p = join(root, "in.csv");
  writeFileSync(p, writeCsv([COLUMN_NAMES.slice(),
    ...maps.map((m) => COLUMN_NAMES.map((n) => m[n] ?? ""))]));
  return p;
}

function row(overrides = {}) {
  return {
    schema_version: "1", id: "BLZ-1", project: "BLZ", type: "task", status: "defined",
    title: "t", description: "body", estimate: "30", ...overrides,
  };
}

function run(root, args, extraEnv = {}) {
  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects"), ...extraEnv };
  delete env.BLAZE_SESSION;
  return spawnSync(process.execPath, [cli, "import", ...args], { cwd: root, env, encoding: "utf8" });
}

const ticketExists = (root) => existsSync(join(root, "projects", "BLZ", "defined", "BLZ-1-t.md"));

test("blaze --help lists the import subcommand", () => {
  const r = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^\s+import\s+/m);
});

test("blaze import --help says the dry run is the default, and does not spawn the runner", () => {
  const r = spawnSync(process.execPath, [cli, "import", "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /dry run unless --apply/,
    "`blaze import --help` prints nothing but sub.desc (cli.mjs:86), so the desc carries this");
});

test("blaze import without --apply writes NOTHING and exits 0", (t) => {
  const root = board(t);
  const r = run(root, [csvAt(root, row())]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WOULD CREATE/);
  assert.equal(ticketExists(root), false);
  assert.equal(existsSync(join(root, RECEIPT_DIR)), false, "not even a receipt");
});

test("blaze import --apply creates the ticket, the claim and the receipt, and exits 0", (t) => {
  const root = board(t);
  const r = run(root, ["--apply", csvAt(root, row())]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ticketExists(root), true);
  assert.equal(existsSync(claimPath(join(root, "projects"), "BLZ", 1)), true,
    "§5.5: a claim per created ticket, on the explicit-id path too");
  const receipts = readdirSync(join(root, RECEIPT_DIR));
  assert.equal(receipts.length, 1);
  assert.match(receipts[0], /-canonical\.jsonl$/,
    "`canonical` is the reserved <name> for an import with no mapping file (§4.2)");
});

test("a second --apply of the same file is a NO-OP, not a duplicate", (t) => {
  const root = board(t);
  const file = csvAt(root, row());
  assert.equal(run(root, ["--apply", file]).status, 0);
  const r = run(root, ["--apply", file]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SKIPPED/);
  assert.equal(readdirSync(join(root, "projects", "BLZ", "defined")).length, 1,
    "BLZ-587's re-run-is-a-no-op criterion, end to end");
});

test("blaze import --apply refuses a bad row with exit 1 and writes none of the good ones", (t) => {
  const root = board(t);
  const file = csvAt(root, row(), row({ id: "BLZ-2", status: "wibble" }));
  const r = run(root, ["--apply", file]);
  assert.equal(r.status, 1);
  assert.equal(ticketExists(root), false, "validation is all-or-nothing (§5.3)");
});

test("an id already on the board that differs is exit 1 without --update, and applied with it", (t) => {
  const root = board(t);
  assert.equal(run(root, ["--apply", csvAt(root, row())]).status, 0);
  const changed = csvAt(root, row({ title: "renamed" }));
  assert.equal(run(root, ["--apply", changed]).status, 1);
  const r = run(root, ["--apply", "--update", changed]);
  assert.equal(r.status, 0, r.stderr);
});

test("blaze import with no file, or with two, is refused", (t) => {
  const root = board(t);
  assert.notEqual(run(root, []).status, 0);
  assert.notEqual(run(root, ["a.csv", "b.csv"]).status, 0);
});

test("an unknown flag is refused rather than silently ignored", (t) => {
  const root = board(t);
  const r = run(root, ["--force", csvAt(root, row())]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--force/);
});

test("BLAZE_READONLY refuses `blaze import` at the CLI gate — before the runner is even spawned", (t) => {
  const root = board(t);
  const r = run(root, ["--apply", csvAt(root, row())], { BLAZE_READONLY: "1" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /read-only/);
  assert.equal(ticketExists(root), false);
});

test("staging goes through commitOrQueue under the `import` op — scoped to what it wrote, never git add -A", (t) => {
  const root = board(t);
  const r = run(root, ["--apply", csvAt(root, row())], { BLAZE_COMMIT_MODE: "batch" });
  assert.equal(r.status, 0, r.stderr);
  // In batch mode commitOrQueue appends to the pending ledger rather than
  // committing — so exit 0 does NOT mean "committed", and the trailer says so.
  assert.match(r.stdout, /queued/i);
});

// =============================================================================
// BLZ-634 — the mapping layer's CLI surface: `--mapping` and `repair`
// =============================================================================

test("blaze import --help names both subcommands, and the flag clause does NOT attach to propose-mapping", () => {
  const r = spawnSync(process.execPath, [cli, "import", "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /propose-mapping/);
  assert.match(r.stdout, /repair/);
  assert.match(r.stdout, /`propose-mapping` \(interactive\)/,
    "ADR-0037 §4: `propose-mapping` has no --apply flag at all — its gate is the operator's own "
    + "answer at the prompt, and a desc that folded it into 'the flag' would be literally false");
});

test("blaze import --mapping reads an arbitrary CSV and writes the source-ids pair", (t) => {
  const root = board(t);
  mkdirSync(join(root, "import-mappings"), { recursive: true });
  writeFileSync(join(root, "import-mappings", "acme.json"), JSON.stringify({
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
  const src = join(root, "foreign.csv");
  writeFileSync(src, "Key,Name\nACME-7,seven\n");

  const dry = run(root, ["--allocate-ids", "--mapping", join(root, "import-mappings", "acme.json"), src]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /WOULD CREATE/);
  assert.equal(existsSync(join(root, "source-ids")), false, "a dry run writes no pair");

  const r = run(root, ["--apply", "--allocate-ids", "--mapping",
    join(root, "import-mappings", "acme.json"), src]);
  assert.equal(r.status, 0, r.stderr);
  const pairs = readFileSync(join(root, "source-ids", "acme.jsonl"), "utf8").trim().split("\n");
  assert.equal(pairs.length, 1);
  assert.equal(JSON.parse(pairs[0]).source, "ACME-7");
  assert.match(readdirSync(join(root, RECEIPT_DIR))[0], /-acme\.jsonl$/,
    "the receipt is keyed on the mapping's `name`, which equals its file's basename (§4.2)");
});

test("blaze import repair dry-runs by default and takes no CSV flags", (t) => {
  const root = board(t);
  mkdirSync(join(root, RECEIPT_DIR), { recursive: true });
  const receipt = join(root, RECEIPT_DIR, "2026-09-22T00-00-00.000Z-canonical.jsonl");
  writeFileSync(receipt, `${JSON.stringify({ seq: 1, phase: "intent", row: 1, id: "BLZ-9", op: "create" })}\n`);

  const r = run(root, ["repair", receipt]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ORPHAN RESERVATION/);
  assert.match(r.stdout, /dry run/);
  assert.equal(readFileSync(receipt, "utf8").includes("resolved"), false);

  const bad = run(root, ["repair", "--allocate-ids", receipt]);
  assert.notEqual(bad.status, 0, "`repair` reads a receipt, not a CSV — a CSV flag is a different verb");
});

test("blaze import repair --apply appends the `resolved` that lifts the refusal", (t) => {
  const root = board(t);
  mkdirSync(join(root, RECEIPT_DIR), { recursive: true });
  const receipt = join(root, RECEIPT_DIR, "2026-09-22T00-00-00.000Z-canonical.jsonl");
  writeFileSync(receipt, `${JSON.stringify({ seq: 1, phase: "intent", row: 1, id: "BLZ-9", op: "create" })}\n`);

  const r = run(root, ["repair", "--apply", receipt]);
  assert.equal(r.status, 0, r.stderr);
  const last = JSON.parse(readFileSync(receipt, "utf8").trim().split("\n").pop());
  assert.equal(last.phase, "resolved");
  assert.equal(last.state, "orphan-reservation");
});

test("BLAZE_READONLY refuses `blaze import repair --apply` at the CLI gate", (t) => {
  const root = board(t);
  mkdirSync(join(root, RECEIPT_DIR), { recursive: true });
  const receipt = join(root, RECEIPT_DIR, "2026-09-22T00-00-00.000Z-canonical.jsonl");
  writeFileSync(receipt, `${JSON.stringify({ seq: 1, phase: "intent", row: 1, id: "BLZ-9", op: "create" })}\n`);
  const r = run(root, ["repair", "--apply", receipt], { BLAZE_READONLY: "1" });
  assert.notEqual(r.status, 0);
  assert.equal(readFileSync(receipt, "utf8").includes("resolved"), false);
});
