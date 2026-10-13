// tests/db-runner.test.mjs — `blaze db` (BLZ-299).
//
// The counts in `db status` must agree with the counts in `db init`. They did not: the
// `acceptance_criterion` table holds BOTH criteria and notes, and status counted the
// whole table while calling it "criteria". On the live board that overstated it by
// 2,339 — and it reads as the shadow INVENTING rows, which is exactly the false alarm
// a soak must never raise. It briefly convinced me the database was corrupting data.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDb } from "../scripts/db-runner.mjs";
import { writeClaim } from "../scripts/model/claims.mjs";
import { openShadow } from "../scripts/model/write-port-resolve.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";
import { subVerbOf } from "../scripts/readonly.mjs";

// BLZ-503: every scratch directory this file mints, removed when the file is done with
// it. Registered rather than written as a test's trailing statement, so a failing
// assertion earlier in the test cannot skip it.
const scratch = scratchRegistry();

function board() {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blaze-db-")));
  const projectsDir = join(dataRoot, "projects");
  mkdirSync(join(projectsDir, "ENG", "defined"), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"),
    JSON.stringify({ projects: ["ENG"], schemaVersion: 2 }));
  writeFileSync(join(projectsDir, "ENG", "project.json"),
    JSON.stringify({ key: "ENG", components: [], labels: [] }));
  // One ticket with TWO criteria and ONE note — the shape that exposed the bug.
  writeFileSync(join(projectsDir, "ENG", "defined", "ENG-1-a.md"),
    ["---", "id: ENG-1", "title: A task", "type: task", "project: ENG",
     "priority: medium", "assignee: unassigned", "estimate: 30",
     "created: 2026-01-01", "updated: 2026-01-01", "links:", "---", "",
     "## Acceptance Criteria", "", "- [x] one", "- [ ] two",
     "", "Some prose that is a note, not a criterion.", ""].join("\n"));
  return { dataRoot, projectsDir };
}

const capture = () => {
  const out = [];
  // `env: {}` — runDb's readonly guard must not read an ambient BLAZE_READONLY (BLZ-668).
  const io = { log: (s) => out.push(String(s)), err: (s) => out.push(String(s)), env: {} };
  return { io, out, text: () => out.join("\n") };
};

describe("blaze db", () => {
  test("init loads the board and reports criteria separately from notes", async () => {
    const roots = board();
    const c = capture();
    assert.equal(0, await runDb(["init"], { ...c.io, roots }));
    assert.match(c.text(), /tickets\s+1/);
    assert.match(c.text(), /criteria\s+2/, "two checkboxes, not three rows");
  });

  test("status agrees with init — criteria are criteria, notes are notes", async () => {
    const roots = board();
    await runDb(["init"], { ...capture().io, roots });
    const c = capture();
    assert.equal(0, await runDb(["status"], { ...c.io, roots }));
    // The bug: `criteria 3`, counting the note as a criterion.
    assert.match(c.text(), /criteria\s+2/);
    assert.match(c.text(), /AC notes\s+1/);
  });

  test("status on a clean soak does not claim the soak never ran", async () => {
    // An absent log is what a CLEAN soak looks like — it is written only on divergence.
    const roots = board();
    await runDb(["init"], { ...capture().io, roots });
    const c = capture();
    await runDb(["status"], { ...c.io, roots });
    assert.match(c.text(), /none recorded/);
    assert.doesNotMatch(c.text(), /no soak has (written|run)/);
  });

  test("init refuses to replace an existing shadow without --force", async () => {
    const roots = board();
    await runDb(["init"], { ...capture().io, roots });
    const c = capture();
    assert.equal(1, await runDb(["init"], { ...c.io, roots }));
    assert.match(c.text(), /already exists/);
    assert.match(c.text(), /discards whatever the current shadow/);
    assert.equal(0, await runDb(["init", "--force"], { ...capture().io, roots }));
  });

  test("status before init says what to run, rather than failing", async () => {
    const c = capture();
    assert.equal(0, await runDb(["status"], { ...c.io, roots: board() }));
    assert.match(c.text(), /blaze db init/);
  });

  test("an unknown subcommand is refused with the usage", async () => {
    const c = capture();
    assert.equal(1, await runDb(["frobnicate"], { ...c.io, roots: board() }));
    assert.match(c.text(), /unknown command "frobnicate"/);
    assert.match(c.text(), /usage: blaze db/);
  });
});

// BLZ-668 / BLZ-669. The SQLite half of the counter seed: init now also counts `.ids/` claims,
// and `blaze db seed-counter` re-seeds an existing shadow.
describe("blaze db seed-counter (sqlite)", () => {
  const counterOf = async (dataRoot, key) => {
    const { db, exec } = await openShadow(dataRoot);
    try { return exec.all("SELECT n FROM project_counter WHERE project_key = ?", [key])[0]?.n ?? 0; }
    finally { db.close(); }
  };

  test("init seeds the counter from a claim above every ticket", async () => {
    const roots = board();
    writeClaim(roots.projectsDir, "ENG", 7, "claimed-no-ticket");
    assert.equal(await runDb(["init"], { ...capture().io, roots }), 0);
    assert.equal(await counterOf(roots.dataRoot, "ENG"), 7);
  });

  test("seed-counter raises the counter to a claim made after init, then is idempotent", async () => {
    const roots = board();
    assert.equal(await runDb(["init"], { ...capture().io, roots }), 0);
    writeClaim(roots.projectsDir, "ENG", 9, "handed-out-on-the-file-path");
    const c1 = capture();
    assert.equal(await runDb(["seed-counter"], { ...c1.io, roots }), 0);
    assert.match(c1.text(), /ENG\s+1 → 9/);
    const c2 = capture();
    assert.equal(await runDb(["seed-counter"], { ...c2.io, roots }), 0);
    assert.match(c2.text(), /ENG\s+9 → 9/);
    assert.equal(await counterOf(roots.dataRoot, "ENG"), 9);
  });

  test("seed-counter before init refuses, naming blaze db init", async () => {
    const c = capture();
    assert.equal(await runDb(["seed-counter"], { ...c.io, roots: board() }), 1);
    assert.match(c.text(), /no shadow database/);
    assert.match(c.text(), /blaze db init/);
  });
});

// BLZ-668: `init` and `seed-counter` carry the per-runner BLAZE_READONLY guard (AGENTS.md), so a
// direct `node db-runner.mjs` refuses under it just as `blaze db` does at dispatch.
describe("blaze db under BLAZE_READONLY", () => {
  test("init refuses and creates no shadow; seed-counter refuses", async () => {
    const roots = board();
    const c = capture();
    assert.equal(await runDb(["init"], { ...c.io, roots, env: { BLAZE_READONLY: "1" } }), 1);
    assert.match(c.text(), /read-only mode \(BLAZE_READONLY=1\) — refusing to run blaze db init/);
    assert.equal(existsSync(join(roots.dataRoot, ".blaze", "blaze.db")), false);
    const c2 = capture();
    assert.equal(await runDb(["seed-counter"], { ...c2.io, roots, env: { BLAZE_READONLY: "1" } }), 1);
    assert.match(c2.text(), /refusing to run blaze db seed-counter/);
  });

  test("status still runs — it only reads", async () => {
    assert.equal(await runDb(["status"], { ...capture().io, roots: board(), env: { BLAZE_READONLY: "1" } }), 0);
  });
});

// BLZ-690 review: `db status` runs under BLAZE_READONLY, so it must not write — not even the
// -wal/-shm files or the WAL journal-mode switch a read-write open makes.
// A read-write WAL open creates -wal/-shm and deletes them again on close, so a before/after
// listing cannot see it. Making `.blaze` and its files read-only can: any write — a journal file,
// the WAL switch — then fails, and only a genuinely read-only open still answers.
test("db status opens the shadow READ-ONLY: it works with .blaze and its files unwritable, and changes nothing",
  { skip: process.getuid && process.getuid() === 0 ? "root ignores mode bits" : false }, async () => {
  const roots = board();
  assert.equal(await runDb(["init"], { ...capture().io, roots }), 0);
  const dir = join(roots.dataRoot, ".blaze");
  const snap = () => readdirSync(dir).sort().map((f) => {
    const st = statSync(join(dir, f));
    return `${f} ${st.size} ${st.mtimeMs}`;
  });
  const before = snap();
  const files = readdirSync(dir);
  for (const f of files) chmodSync(join(dir, f), 0o444);
  chmodSync(dir, 0o555);
  try {
    const c = capture();
    assert.equal(await runDb(["status"], { ...c.io, env: { BLAZE_READONLY: "1" }, roots }), 0, c.text());
    assert.match(c.text(), /tickets\s+1/);
    assert.match(c.text(), /criteria\s+2/);
  } finally {
    chmodSync(dir, 0o755);
    for (const f of files) chmodSync(join(dir, f), 0o644);
  }
  assert.deepEqual(snap().map((x) => x.replace(/ [\d.]+$/, "")), before.map((x) => x.replace(/ [\d.]+$/, "")),
    "status created, removed or resized a file");
});

test("cli.mjs and runDb pick the db sub-verb by ONE rule (subVerbOf)", () => {
  assert.equal(subVerbOf(["--replace", "load", "verify"]), "load");
  assert.equal(subVerbOf(["--force"]), undefined);
  const here = (f) => readFileSync(fileURLToPath(new URL(`../scripts/${f}`, import.meta.url)), "utf8");
  for (const f of ["cli.mjs", "db-runner.mjs"]) {
    assert.match(here(f), /subVerbOf\((rest|argv)\)/, `${f} must use subVerbOf`);
  }
  // And end to end: the verb dispatch exempts is the verb the runner runs.
  const cli = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));
  const roots = board();
  const r = spawnSync(process.execPath, [cli, "db", "--force", "status"],
    { encoding: "utf8", env: { ...process.env, BLAZE_READONLY: "1", BLAZE_PROJECTS_DIR: roots.projectsDir } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no shadow database/, "the runner ran STATUS, the verb dispatch let through");
});

