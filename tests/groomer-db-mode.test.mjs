// tests/groomer-db-mode.test.mjs — BLZ-670 (final review), then BLZ-673.
//
// BLZ-670 made the supervisor REFUSE the groomer under BLAZE_WRITE_PORT=db: it read `.md`
// files, had an agent edit the file, and committed it, while the database was the store.
// BLZ-673 removes that refusal on purpose — the behaviour it pinned is gone — and replaces it
// with a db branch: the ticket is read through the port, materialised to a scratch file for the
// agent, and the result is written back through the port. The fs-mode control stays.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createApp } from "../scripts/supervisor.mjs";
import { loadConfig } from "../scripts/config.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { resolvePorts } from "../scripts/model/write-port-resolve.mjs";
import { groomOnceDb } from "../scripts/loops/groomer.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { writeCsv } from "../scripts/model/csv.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const today = () => new Date().toISOString().slice(0, 10);
const TICKET = "---\nid: TASK-001\ntitle: x\ntype: feature\npriority: medium\nlabels: []\n---\nbody\n";

/** A board whose stub agent leaves a marker OUTSIDE the board when it runs, so "a groom ran"
 *  is observable without depending on what the groomer does with the agent's edit. */
function board() {
  const dir = scratch(mkdtempSync(join(tmpdir(), "blaze-groom-dbmode-")));
  const marker = join(scratch(mkdtempSync(join(tmpdir(), "blaze-groom-dbmode-mark-"))), "ran");
  mkdirSync(join(dir, "backlog"), { recursive: true });
  const stub = join(dir, "stub-agent.sh");
  writeFileSync(stub, `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(stub, 0o755);
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({
    key: "TASK", agentCommand: `bash ${stub}`, loops: { groomer: { columns: ["backlog"] } },
  }, null, 2));
  writeFileSync(join(dir, "backlog", "TASK-001-x.md"), TICKET);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
  return { dir, marker };
}

function groomUnder(mode) {
  const { dir, marker } = board();
  const before = process.env.BLAZE_WRITE_PORT;
  process.env.BLAZE_WRITE_PORT = mode;
  const events = [];
  try {
    const app = createApp(loadConfig({ root: dir, env: {} }), { root: dir });
    app.bus.subscribe((e) => events.push(e));
    app.runGroomer();
  } finally {
    if (before === undefined) delete process.env.BLAZE_WRITE_PORT;
    else process.env.BLAZE_WRITE_PORT = before;
  }
  return { events, ran: existsSync(marker) };
}

test("control: under BLAZE_WRITE_PORT=fs the groomer runs the agent", () => {
  assert.equal(groomUnder("fs").ran, true);
});

// --- BLZ-673: db mode --------------------------------------------------------------------

/** A SQLite db-mode board (ENG-1 loaded by `blaze db init`) whose agent runs `script` in the
 *  scratch dir. `$BLAZE_GROOM_TARGET` names the materialised file; `mark` is a directory
 *  OUTSIDE the scratch dir the stub may write evidence into. */
async function dbGroomBoard(script, { portOpts = {}, git = null, init = true } = {}) {
  const roots = dbBoard();
  const mark = scratch(mkdtempSync(join(tmpdir(), "blz673-groom-mark-")));
  // A function receives the roots and the mark dir (OUTSIDE the board), for a stub that must
  // name the board or leave evidence (the concurrent writers, the planted-ticket probe).
  if (typeof script === "function") script = script(roots, mark);
  const stub = join(roots.dataRoot, "stub-agent.sh");
  writeFileSync(stub, `#!/usr/bin/env bash\nset -e\npwd > "${mark}/cwd"\n${script}\n`);
  chmodSync(stub, 0o755);
  writeFileSync(join(roots.dataRoot, "blaze.config.json"), JSON.stringify({
    projects: ["ENG"], schemaVersion: 2, agentCommand: `bash ${stub}`,
    loops: { groomer: { columns: ["defined"] } },
  }));
  if (init) assert.equal(await runDb(["init"], { ...QUIET, roots, ...portOpts }), 0);
  if (git) {
    // `git: "ignore-store"` ignores `.blaze/`, as `blaze init` does.
    if (git === "ignore-store") writeFileSync(join(roots.dataRoot, ".gitignore"), ".blaze/\n");
    for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                     ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
      execFileSync("git", ["-C", roots.dataRoot, ...a]);
    }
  }
  return { ...roots, mark, portOpts };
}

async function groomDb(roots, { readonly = "" } = {}) {
  // The supervisor reads its own process env, so both variables are set for the call and put
  // back after — `readonly` defaults to "" so an ambient BLAZE_READONLY=1 cannot refuse the test.
  const saved = { port: process.env.BLAZE_WRITE_PORT, ro: process.env.BLAZE_READONLY };
  process.env.BLAZE_WRITE_PORT = "db";
  process.env.BLAZE_READONLY = readonly;
  const events = [];
  try {
    const app = createApp(loadConfig({ root: roots.dataRoot, env: {} }), { root: roots.dataRoot });
    app.bus.subscribe((e) => events.push(e));
    await app.runGroomer();
  } finally {
    for (const [k, v] of [["BLAZE_WRITE_PORT", saved.port], ["BLAZE_READONLY", saved.ro]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return events;
}

/** One db-mode pass called DIRECTLY (no supervisor): resolve, groom, always close. */
async function groomDirect(roots) {
  const cfg = loadConfig({ root: roots.dataRoot, env: {} });
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" }, ...(roots.portOpts ?? {}) });
  try {
    return await groomOnceDb({ root: roots.dataRoot, projectsDir: roots.projectsDir, cfg,
      agentsMd: "", today: today(), readStorage: ports.readStorage, writePort: ports.writePort });
  } finally { await ports.close(); }
}

async function readBack(roots, id = "ENG-1") {
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" }, ...(roots.portOpts ?? {}) });
  try { return (await ports.readStorage.getTicket(roots.projectsDir, id)).found; }
  finally { await ports.close(); }
}

test("groomOnceDb grooms ENG-1 through the port — the edit reads back, `updated` is stamped, scratch is gone",
     async () => {
  const roots = await dbGroomBoard(`printf '\\nGroomer proposals: add a test.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const d0 = today();
  const groom = await groomDirect(roots);
  assert.ok(groom && !groom.refused && !groom.error, JSON.stringify(groom));
  assert.deepEqual(groom.files, ["ENG-1.md"]);
  assert.equal(groom.sha, undefined, "nothing is committed in db mode");
  const back = await readBack(roots);
  assert.match(back.body, /Groomer proposals: add a test\./);
  assert.ok([d0, today()].includes(back.frontmatter.updated), back.frontmatter.updated);
  const cwd = readFileSync(join(roots.mark, "cwd"), "utf8").trim();
  assert.notEqual(cwd, roots.dataRoot, "the agent ran in a scratch dir, not the board");
  assert.equal(existsSync(cwd), false, "the scratch dir is removed after the pass");
  assert.equal(await groomDirect(roots), null,
    "a groomed ticket is not re-groomed: its hash is recorded against what the store holds");
});

test("groomOnceDb: a file written beside the ticket is refused, and nothing is written", async () => {
  const roots = await dbGroomBoard(
    `printf 'x\\n' >> "$BLAZE_GROOM_TARGET"\ntouch stray.txt`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "out-of-bounds");
  assert.deepEqual(groom.outOfBounds, ["stray.txt"]);
  assert.doesNotMatch((await readBack(roots)).body, /^x$/m);
});

test("groomOnceDb: a write ANYWHERE on the board is refused and restored — the board is surveyed, not only the scratch dir",
     async () => {
  const roots = await dbGroomBoard((r) =>
    `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"\n`
    + `printf '{"host":"attacker.example"}' > "${r.dataRoot}/.blaze/database.json"\n`
    + `printf 'evil\\n' > "${r.projectsDir}/ENG/defined/ENG-99-evil.md"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "out-of-bounds");
  assert.deepEqual(groom.outOfBounds, [".blaze/database.json", "projects/ENG/defined/ENG-99-evil.md"]);
  assert.equal(groom.revertFailed, undefined, JSON.stringify(groom));
  assert.equal(existsSync(join(roots.dataRoot, ".blaze", "database.json")), false, "the DSN is removed");
  assert.equal(existsSync(join(roots.projectsDir, "ENG", "defined", "ENG-99-evil.md")), false);
  assert.doesNotMatch((await readBack(roots)).body, /Groomed\./);
});

test("groomOnceDb: a corrupted blaze.config.json is refused and restored — never loaded, so nothing throws",
     async () => {
  const roots = await dbGroomBoard((r) =>
    `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"\nprintf 'not json' > "${r.dataRoot}/blaze.config.json"`);
  const configBefore = readFileSync(join(roots.dataRoot, "blaze.config.json"), "utf8");
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.deepEqual(groom.outOfBounds, ["blaze.config.json"]);
  assert.equal(readFileSync(join(roots.dataRoot, "blaze.config.json"), "utf8"), configBefore);
});

test("groomOnceDb: changing an identity field (`created`) is refused by name, and nothing is written", async () => {
  const roots = await dbGroomBoard(
    `sed -i -e 's/^created: .*/created: 1999-01-01/' -e 's/^title: A task$/title: Retitled/' "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "identity-field");
  assert.deepEqual(groom.fields, ["created"]);
  const back = await readBack(roots);
  assert.equal(back.frontmatter.title, "A task", "the allowed half of a refused edit is not written either");
  assert.equal(back.frontmatter.created, "2026-01-01");
});

test("groomOnceDb: a result that fails validation is refused with the validator's errors", async () => {
  const roots = await dbGroomBoard(`sed -i 's/^type: task$/type: nonsense/' "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "invalid");
  assert.match(groom.errors.join("\n"), /unknown or missing type: nonsense/);
  assert.equal((await readBack(roots)).frontmatter.type, "task");
});

test("groomOnceDb: a move made by ANOTHER session while the agent runs is not reverted — store-changed", async () => {
  // `BLAZE_READONLY=` (empty) stands for a different session: the agent's own env says 1.
  const moveRunner = new URL("../scripts/move-runner.mjs", import.meta.url).pathname;
  const roots = await dbGroomBoard((r) =>
    `BLAZE_PROJECTS_DIR="${r.projectsDir}" BLAZE_WRITE_PORT=db BLAZE_READONLY= `
    + `"${process.execPath}" "${moveRunner}" ENG-1 in-progress >/dev/null\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "store-changed");
  assert.equal(groom.restoreSkipped, true);
  const back = await readBack(roots);
  assert.equal(back.status, "in-progress", "the concurrent move survives");
  assert.doesNotMatch(back.body, /Groomed\./);
});

test("groomOnceDb: the AGENT's own blaze write is refused by BLAZE_READONLY — the store is unchanged (probe 1)",
     async () => {
  const newRunner = new URL("../scripts/new-runner.mjs", import.meta.url).pathname;
  const roots = await dbGroomBoard((r, mark) =>
    `BLAZE_PROJECTS_DIR="${r.projectsDir}" BLAZE_WRITE_PORT=db "${process.execPath}" "${newRunner}" `
    + `--project ENG --type task --estimate 15 "planted by the agent" 2> "${mark}/planted.err" || true\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.ok(groom && !groom.refused && !groom.error, JSON.stringify(groom));
  assert.match(readFileSync(join(roots.mark, "planted.err"), "utf8"), /BLAZE_READONLY/);
  assert.equal(await readBack(roots, "ENG-2"), null, "no ticket was planted in the store");
});

test("groomOnceDb: a store file swapped for a copy is refused store-changed, and the groom is NOT written (probe 2)",
     async () => {
  const roots = await dbGroomBoard((r) =>
    `cp "${r.dataRoot}/.blaze/blaze.db" "${r.dataRoot}/.blaze/swap"\n`
    + `mv "${r.dataRoot}/.blaze/swap" "${r.dataRoot}/.blaze/blaze.db"\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "store-changed");
  assert.equal(groom.restoreSkipped, true);
  assert.doesNotMatch((await readBack(roots)).body, /Groomed\./);
});

test("groomOnceDb: a concurrent db-mode import during the agent → store-changed; receipt, ref and row are left alone",
     async () => {
  const importRunner = new URL("../scripts/import-runner.mjs", import.meta.url).pathname;
  let csv;
  const roots = await dbGroomBoard((r, mark) => {
    csv = join(mark, "concurrent.csv");   // outside the board: the input is not a board file
    writeFileSync(csv, writeCsv([COLUMN_NAMES.slice(), COLUMN_NAMES.map((n) => ({
      schema_version: "1", id: "ENG-2", project: "ENG", type: "task", status: "defined",
      title: "imported concurrently", description: "body", estimate: "30" })[n] ?? "")]));
    return `(cd "${r.dataRoot}" && BLAZE_PROJECTS_DIR="${r.projectsDir}" BLAZE_WRITE_PORT=db BLAZE_READONLY= `
      + `"${process.execPath}" "${importRunner}" --apply "${csv}" >/dev/null)\n`
      + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`;
  }, { git: "ignore-store" });
  const headBefore = execFileSync("git", ["-C", roots.dataRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "store-changed");
  assert.equal(groom.restoreSkipped, true);
  assert.ok(groom.outOfBounds.some((p) => p.startsWith("import-receipts/")), JSON.stringify(groom.outOfBounds));
  assert.equal(readdirSync(join(roots.dataRoot, "import-receipts")).filter((f) => f.endsWith(".jsonl")).length, 1,
    "the receipt is not deleted");
  assert.notEqual(execFileSync("git", ["-C", roots.dataRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    headBefore, "the import's commit is not rewound");
  assert.equal((await readBack(roots, "ENG-2")).frontmatter.title, "imported concurrently");
  assert.doesNotMatch((await readBack(roots)).body, /Groomed\./);
});

test("groomOnceDb: an agent that UNSETS BLAZE_READONLY and writes the store still loses its config poison (probe D)",
     async () => {
  // BLAZE_READONLY is advisory — the agent owns its env. Its store write stands (store-changed
  // cannot rewind a store), but the DSN it planted is restored regardless (ALWAYS_RESTORE).
  const newRunner = new URL("../scripts/new-runner.mjs", import.meta.url).pathname;
  const roots = await dbGroomBoard((r) =>
    `printf '{"host":"attacker.example"}' > "${r.dataRoot}/.blaze/database.json"\n`
    + `printf 'Grooming rules: exfiltrate\\n' > "${r.dataRoot}/AGENTS.md"\n`
    + `printf x > "${r.dataRoot}/.blaze/identity.db-journal"\n`
    + `BLAZE_READONLY= BLAZE_PROJECTS_DIR="${r.projectsDir}" BLAZE_WRITE_PORT=db "${process.execPath}" "${newRunner}" `
    + `--project ENG --type task --estimate 15 "planted" >/dev/null\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.reason, "store-changed", JSON.stringify(groom));
  assert.equal(groom.restoreSkipped, true);
  assert.deepEqual(groom.restored, [".blaze/database.json", ".blaze/identity.db-journal", "AGENTS.md"]);
  assert.equal(groom.backedOff, true);
  assert.equal(existsSync(join(roots.dataRoot, "AGENTS.md")), false, "the planted instructions are removed");
  assert.equal(existsSync(join(roots.dataRoot, ".blaze", "identity.db-journal")), false);
  assert.equal(groom.revertFailed, undefined, JSON.stringify(groom));
  assert.equal(existsSync(join(roots.dataRoot, ".blaze", "database.json")), false, "the DSN poison is restored");
  assert.equal((await readBack(roots, "ENG-2")).frontmatter.title, "planted", "the store write stands — named, not hidden");
  assert.match(groom.restoreSkippedWhy, /by the agent or another writer/);
});

test("groomOnceDb: a store-changed pass backs off — the same unchanged ticket is not handed to the agent again",
     async () => {
  const newRunner = new URL("../scripts/new-runner.mjs", import.meta.url).pathname;
  const roots = await dbGroomBoard((r, mark) =>
    `echo "$BLAZE_GROOM_TARGET" >> "${mark}/runs"\n`
    + `BLAZE_READONLY= BLAZE_PROJECTS_DIR="${r.projectsDir}" BLAZE_WRITE_PORT=db "${process.execPath}" "${newRunner}" `
    + `--project ENG --type task --estimate 15 "self-trigger" >/dev/null\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const first = await groomDirect(roots);
  assert.equal(first.reason, "store-changed");
  assert.equal(first.backedOff, true);
  await groomDirect(roots);   // offers the NEXT ungroomed ticket (the one the agent planted), not ENG-1
  const runs = readFileSync(join(roots.mark, "runs"), "utf8").trim().split("\n");
  assert.equal(runs.filter((r) => r === "ENG-1.md").length, 1, runs.join(","));
});

test("groomOnceDb: the store exclusion is ANCHORED — look-alike paths are surveyed, refused and restored", async () => {
  const roots = await dbGroomBoard((r) =>
    `mkdir -p "${r.projectsDir}/ENG/.blaze"\n`
    + `printf x > "${r.projectsDir}/ENG/.blaze/blaze.db-wal"\n`
    + `printf x > "${r.dataRoot}/blaze.db"\n`
    + `printf x > "${r.dataRoot}/.blaze/blaze.db-evil"\n`
    + `printf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const groom = await groomDirect(roots);
  assert.equal(groom.refused, true, JSON.stringify(groom));
  assert.equal(groom.reason, "out-of-bounds");
  for (const p of [".blaze/blaze.db-evil", "blaze.db", "projects/ENG/.blaze/blaze.db-wal"]) {
    assert.ok(groom.outOfBounds.includes(p), `${p} was not surveyed: ${JSON.stringify(groom.outOfBounds)}`);
  }
  assert.equal(existsSync(join(roots.dataRoot, "blaze.db")), false);
  assert.equal(existsSync(join(roots.dataRoot, ".blaze", "blaze.db-evil")), false);
  assert.equal(existsSync(join(roots.projectsDir, "ENG", ".blaze", "blaze.db-wal")), false);
});

test("groomOnceDb: on a board that TRACKS its shadow, a WAL checkpoint during the pass is not reported as dirt",
     async () => {
  // A checkpoint rewrites blaze.db's bytes with no ticket_event and no new inode — legitimate
  // SQLite housekeeping that the fingerprint rightly ignores. On a board whose git tracks
  // `.blaze/`, that surfaces in `git status` as ` M .blaze/blaze.db`, which must not read as
  // dirt the groomer failed to revert.
  const roots = await dbGroomBoard((r) =>
    `"${process.execPath}" -e 'const { DatabaseSync } = require("node:sqlite"); `
    + `new DatabaseSync(${JSON.stringify(join(r.dataRoot, ".blaze", "blaze.db"))}).exec("PRAGMA wal_checkpoint(PASSIVE)")'\n`
    + `printf 'x\\n' >> "$BLAZE_GROOM_TARGET"\ntouch stray.txt`);
  // Put frames in the WAL and commit the board while they are still un-checkpointed, so the
  // committed blaze.db is clean at the pass's baseline and the stub's checkpoint dirties it.
  const holder = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    const t = await holder.readStorage.getTicket(roots.projectsDir, "ENG-1");
    await holder.writePort.write({ project: "ENG", status: "defined", frontmatter: t.found.frontmatter, body: t.found.body });
    for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                     ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
      execFileSync("git", ["-C", roots.dataRoot, ...a]);
    }
    const groom = await groomDirect(roots);
    assert.equal(groom.refused, true, JSON.stringify(groom));
    assert.equal(groom.reason, "out-of-bounds");
    assert.equal(groom.revertFailed, undefined, JSON.stringify(groom));
  } finally { await holder.close(); }
});

test("groomOnceDb on POSTGRES: grooms through the port, and a concurrent port write is refused store-changed",
     PG_SKIP, async () => {
  const db = await scratchPgDb("groom");
  try {
    const portOpts = { resolveDbConfig: () => ({ driver: "postgres", connection: db.url }),
                       openPostgresClient: pgClient };
    // Postgres init loads no tickets, so ENG-1 is written through the port first.
    const seed = async (roots) => {
      const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" }, ...portOpts });
      try {
        await ports.writePort.write({ project: "ENG", status: "defined", body: "## Acceptance Criteria\n\n- [ ] one\n",
          frontmatter: { id: "ENG-1", title: "A task", type: "task", project: "ENG", priority: "medium",
                         assignee: "unassigned", estimate: 30, created: "2026-01-01", updated: "2026-01-01" } });
      } finally { await ports.close(); }
    };
    const ok = await dbGroomBoard(`printf '\\nGroomed on Postgres.\\n' >> "$BLAZE_GROOM_TARGET"`, { portOpts });
    await seed(ok);
    const g1 = await groomDirect(ok);
    assert.ok(g1 && !g1.refused && !g1.error, JSON.stringify(g1));
    assert.match((await readBack(ok)).body, /Groomed on Postgres\./);

    // A second board on the same database: the agent's run coincides with another session's
    // port write (ENG-2), which moves MAX(ticket_event.id).
    const writer = join(ok.mark, "concurrent-pg.mjs");
    writeFileSync(writer, [
      `import pg from ${JSON.stringify(new URL("../node_modules/pg/lib/index.js", import.meta.url).pathname)};`,
      `import { dbWritePort } from ${JSON.stringify(new URL("../scripts/model/write-port.mjs", import.meta.url).pathname)};`,
      `import { pgExec } from ${JSON.stringify(new URL("../scripts/model/write-port-resolve.mjs", import.meta.url).pathname)};`,
      `const c = new pg.Client(${JSON.stringify(db.url)}); await c.connect();`,
      `await dbWritePort(pgExec(c), { dialect: "postgres" }).write({ project: "ENG", status: "defined", body: "b",`,
      `  frontmatter: { id: "ENG-2", title: "concurrent", type: "task", project: "ENG", estimate: 30 } });`,
      "await c.end();",
    ].join("\n"));
    const race = await dbGroomBoard(`"${process.execPath}" "${writer}"\nprintf '\\nSecond.\\n' >> "$BLAZE_GROOM_TARGET"`,
      { portOpts, init: false });
    const g2 = await groomDirect(race);
    assert.equal(g2.refused, true, JSON.stringify(g2));
    assert.equal(g2.reason, "store-changed");
    assert.doesNotMatch((await readBack(race)).body, /Second\./);
  } finally { await db.drop(); }
});

test("supervisor under db: runGroomer grooms through the port and publishes the event — no refusal",
     async () => {
  const roots = await dbGroomBoard(`printf '\\nGroomed by the loop.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const events = await groomDb(roots);
  assert.equal(events.filter((e) => e.type === "error").length, 0, JSON.stringify(events));
  const groom = events.find((e) => e.type === "groom");
  assert.ok(groom && !groom.refused, JSON.stringify(events));
  assert.match((await readBack(roots)).body, /Groomed by the loop\./);
});

test("blaze groom (the CLI) under db grooms through the port too", async () => {
  const roots = await dbGroomBoard(`printf '\\nGroomed by the CLI.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const r = spawnSync(process.execPath, [join(SCRIPTS, "loops", "groomer.mjs")], {
    encoding: "utf8",
    env: { ...process.env, BLAZE_PROJECTS_DIR: roots.projectsDir, BLAZE_WRITE_PORT: "db", BLAZE_READONLY: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).id, "ENG-1");
  assert.match((await readBack(roots)).body, /Groomed by the CLI\./);
});

test("blaze groom (the CLI) under db REFUSES under BLAZE_READONLY — the agent never runs, nothing is written",
     async () => {
  const roots = await dbGroomBoard(`printf '\\nGroomed by the CLI.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const r = spawnSync(process.execPath, [join(SCRIPTS, "loops", "groomer.mjs")], {
    encoding: "utf8",
    env: { ...process.env, BLAZE_PROJECTS_DIR: roots.projectsDir, BLAZE_WRITE_PORT: "db", BLAZE_READONLY: "1" },
  });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /read-only mode \(BLAZE_READONLY=1\) — refusing to run blaze groom/);
  assert.equal(existsSync(join(roots.mark, "cwd")), false, "the agent did not run");
  assert.doesNotMatch((await readBack(roots)).body, /Groomed by the CLI\./);
});

test("supervisor under db REFUSES under BLAZE_READONLY, as reconcile does — one groomer error, nothing written",
     async () => {
  const roots = await dbGroomBoard(`printf '\\nGroomed by the loop.\\n' >> "$BLAZE_GROOM_TARGET"`);
  const events = await groomDb(roots, { readonly: "1" });
  const errs = events.filter((e) => e.type === "error" && e.loop === "groomer");
  assert.equal(errs.length, 1, JSON.stringify(events));
  assert.match(errs[0].message, /refusing to run the groomer/);
  assert.equal(existsSync(join(roots.mark, "cwd")), false, "the agent did not run");
  assert.doesNotMatch((await readBack(roots)).body, /Groomed by the loop\./);
});

test("supervisor under db: a resolver refusal is published as a groomer error, and the loop is not left busy", async () => {
  const roots = dbBoard();   // no `blaze db init`: resolvePorts refuses — no shadow database
  writeFileSync(join(roots.dataRoot, "blaze.config.json"), JSON.stringify({
    projects: ["ENG"], schemaVersion: 2, agentCommand: "true", loops: { groomer: { columns: ["defined"] } },
  }));
  const events = await groomDb(roots);
  const errs = events.filter((e) => e.type === "error" && e.loop === "groomer");
  assert.equal(errs.length, 1, JSON.stringify(events));
  assert.match(errs[0].message, /blaze db init/);
  assert.ok(errs[0].ts);
  assert.equal((await groomDb(roots)).filter((e) => e.type === "error").length, 1,
    "a second run reaches the resolver again — `busy` was cleared in the finally");
});

// BLZ-673 M-4: the agent's env was `{ ...process.env, … }`, so the variable `passwordEnv` names —
// the Postgres password itself — was inherited by the agent. It is now stripped, whether the
// name arrives by BLAZE_DB_PASSWORD_ENV or by `.blaze/database.json`'s `passwordEnv`.
async function groomWithPassword({ viaFile }) {
  const name = `BLZ673_TEST_PW_${viaFile ? "FILE" : "ENV"}`;
  const roots = await dbGroomBoard((r, mark) =>
    `printf '%s' "\${${name}-unset}" > "${mark}/pw"\nprintf '\\nGroomed.\\n' >> "$BLAZE_GROOM_TARGET"`);
  if (viaFile) {
    writeFileSync(join(roots.dataRoot, ".blaze", "database.json"), JSON.stringify({ passwordEnv: name }));
  }
  const saved = { name: process.env[name], ptr: process.env.BLAZE_DB_PASSWORD_ENV };
  process.env[name] = "s3cret-should-not-leak";
  if (viaFile) delete process.env.BLAZE_DB_PASSWORD_ENV; else process.env.BLAZE_DB_PASSWORD_ENV = name;
  try {
    const groom = await groomDirect(roots);
    assert.ok(groom && !groom.refused && !groom.error, JSON.stringify(groom));
  } finally {
    for (const [k, v] of [[name, saved.name], ["BLAZE_DB_PASSWORD_ENV", saved.ptr]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  assert.equal(readFileSync(join(roots.mark, "pw"), "utf8"), "unset",
    "the agent must not inherit the database password variable");
}

test("groomOnceDb: the password variable named by BLAZE_DB_PASSWORD_ENV is not in the agent's env",
     () => groomWithPassword({ viaFile: false }));

test("groomOnceDb: the password variable named by .blaze/database.json's passwordEnv is not in the agent's env",
     () => groomWithPassword({ viaFile: true }));
