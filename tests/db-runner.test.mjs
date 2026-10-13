// tests/db-runner.test.mjs — `blaze db` (BLZ-299).
//
// The counts in `db status` must agree with the counts in `db init`. They did not: the
// `acceptance_criterion` table holds BOTH criteria and notes, and status counted the
// whole table while calling it "criteria". On the live board that overstated it by
// 2,339 — and it reads as the shadow INVENTING rows, which is exactly the false alarm
// a soak must never raise. It briefly convinced me the database was corrupting data.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDb } from "../scripts/db-runner.mjs";
import { writeClaim } from "../scripts/model/claims.mjs";
import { openShadow, openShadowReadOnly } from "../scripts/model/write-port-resolve.mjs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
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
// BLZ-690: status opens the shadow `mode=ro` — never `immutable=1`, which skips locking and
// change detection and can return torn counts (or SQLITE_CORRUPT) when a writer checkpoints. The
// real guarantees, each pinned below: the CONTENTS of blaze.db and config.db never change; a
// database not in WAL mode gets no new file at all; a WAL database in an unwritable directory is
// refused with an error that names why; and a live writer is read through, one snapshot per run.
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

test("db status never modifies blaze.db or config.db", async () => {
  const roots = board();
  assert.equal(await runDb(["init"], { ...capture().io, roots }), 0);
  const dir = join(roots.dataRoot, ".blaze");
  const before = ["blaze.db", "config.db"].map((f) => sha(join(dir, f)));
  const c = capture();
  assert.equal(await runDb(["status"], { ...c.io, env: { BLAZE_READONLY: "1" }, roots }), 0, c.text());
  assert.match(c.text(), /tickets\s+1/);
  assert.match(c.text(), /criteria\s+2/);
  assert.deepEqual(["blaze.db", "config.db"].map((f) => sha(join(dir, f))), before);
});

test("openShadowReadOnly creates no file for a database not in WAL mode", async () => {
  const roots = board();
  assert.equal(await runDb(["init"], { ...capture().io, roots }), 0);
  const dir = join(roots.dataRoot, ".blaze");
  for (const f of ["blaze.db", "config.db"]) {
    const h = new DatabaseSync(join(dir, f)); h.exec("PRAGMA journal_mode = DELETE"); h.close();
  }
  const listing = readdirSync(dir).sort();
  const { db, exec } = await openShadowReadOnly(roots.dataRoot);
  try {
    assert.equal(exec.all("SELECT count(*) AS n FROM ticket")[0].n, 1);
    assert.throws(() => db.exec("DELETE FROM ticket"), /readonly/, "the handle cannot write");
  } finally { db.close(); }
  assert.deepEqual(readdirSync(dir).sort(), listing);
});

test("openShadowReadOnly names an unwritable directory it cannot read a WAL database from",
  { skip: process.getuid && process.getuid() === 0 ? "root ignores mode bits" : false }, async () => {
  const roots = board();
  assert.equal(await runDb(["init"], { ...capture().io, roots }), 0);
  const dir = join(roots.dataRoot, ".blaze");
  chmodSync(dir, 0o555);
  try {
    await assert.rejects(openShadowReadOnly(roots.dataRoot),
      /cannot read the shadow database read-only: it is in WAL mode and .*\.blaze is not writable/);
  } finally { chmodSync(dir, 0o755); }
});

test("openShadowReadOnly opened with NO writer still sees a writer that arrives later (no immutable snapshot)", async () => {
  const roots = board();
  assert.equal(await runDb(["init"], { ...capture().io, roots }), 0);
  const ro = await openShadowReadOnly(roots.dataRoot);   // no -wal now: the race window
  try {
    const count = () => ro.exec.all("SELECT count(*) AS n FROM acceptance_criterion")[0].n;
    const before = count();
    const writer = await openShadow(roots.dataRoot);
    try {
      writer.db.prepare("INSERT INTO acceptance_criterion (ticket_id, ord, kind, text, checked) VALUES ('ENG-1', 91, 'note', 'n', 0)").run();
      writer.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { writer.db.close(); }
    assert.equal(count(), before + 1, "the read-only handle locks and detects change like any reader");
  } finally { ro.db.close(); }
});

test("db status reads through a live writer: no error, and each run's counts are one snapshot", async () => {
  const roots = board();
  assert.equal(await runDb(["init"], { ...capture().io, roots }), 0);
  const writer = await openShadow(roots.dataRoot);   // held open across both reads: WAL is live
  try {
    const notes = (t) => Number(/AC notes\s+(\d+)/.exec(t)[1]);
    const first = capture();
    assert.equal(await runDb(["status"], { ...first.io, roots }), 0, first.text());
    writer.db.exec("BEGIN");
    writer.db.prepare("INSERT INTO acceptance_criterion (ticket_id, ord, kind, text, checked) VALUES ('ENG-1', 90, 'note', 'n', 0)").run();
    const during = capture();
    assert.equal(await runDb(["status"], { ...during.io, roots }), 0, during.text());
    assert.equal(notes(during.text()), notes(first.text()), "an uncommitted write is not seen");
    writer.db.exec("COMMIT");
    const second = capture();
    assert.equal(await runDb(["status"], { ...second.io, roots }), 0, second.text());
    assert.equal(notes(second.text()), notes(first.text()) + 1, "the committed write is");
    assert.match(second.text(), /tickets\s+1/);
  } finally { writer.db.close(); }
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

