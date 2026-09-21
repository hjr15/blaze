// tests/import-sigkill.test.mjs — BLZ-629 / design §5.1's SIGKILL floor.
//
// "A test that SIGKILLs `blaze import --apply` mid-write and asserts BOTH the
// observed exit code AND the receipt's contents. Pinning the exit code alone
// pins the wrong thing: the code is the part this design admits is
// uninformative, and the receipt is the part it promotes to sole evidence. A
// floor nobody tests is a claim."
//
// WHY A CHILD PROCESS. node:test's `timeout` is an event-loop timer and a
// signal death is not an event-loop event, so it cannot observe this at all.
// The run is spawned, killed from outside, and what it left on disk is read
// back — which is also the only way to prove the receipt appends are durable
// rather than buffered.
//
// THE ASSERTION IS A SUPERSET, NOT AN EQUALITY, and the design records an
// earlier draft getting that wrong. §5.5 already admits the unmatched set
// names rows whose reservation MAY be orphaned, which is a superset: the
// per-row sequence has a window between the ticket write and `done` in which
// the ticket is on disk and the `intent` is unmatched. Reproduced in the
// design: intent appended, BLZ-1.md written, SIGKILL before `done` →
// unmatched = ["BLZ-1"], not-on-disk = [], and equality is FALSE. A test
// asserting equality is flaky by kill placement. So:
//
//   unmatched ⊇ not-on-disk          — every unwritten row is named: COMPLETE
//   |unmatched \ not-on-disk| ≤ 1    — at most the one in flight: TIGHT
//
// Both halves are needed. The first alone is satisfied by a receipt that
// names everything; the second alone by one that names nothing.
//
// BOTH SETS ARE KEYED BY `seq`, NOT BY ID: an `intent` killed before its
// `allocated` has `"id": null`, and a set keyed by id would silently drop it
// — which is the row most worth naming.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { writeCsv } from "../scripts/model/csv.mjs";
import { exitCodeForSpawn } from "../scripts/model/spawn-exit-code.mjs";
import { RECEIPT_DIR } from "../scripts/model/import-apply.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "scripts", "cli.mjs");
const ROWS = 400;

function board(t) {
  const root = mkdtempSync(join(tmpdir(), "blaze-import-kill-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "projects", "BLZ", "defined"), { recursive: true });
  spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  return root;
}

/** A file big enough that the run is still mid-write when the kill lands. */
function bigCsv(root) {
  const rows = [];
  for (let i = 1; i <= ROWS; i++) {
    const m = {
      schema_version: "1", id: `BLZ-${i}`, project: "BLZ", type: "task",
      status: "defined", title: `ticket ${i}`, description: `body ${i}`, estimate: "30",
    };
    rows.push(COLUMN_NAMES.map((n) => m[n] ?? ""));
  }
  const p = join(root, "in.csv");
  writeFileSync(p, writeCsv([COLUMN_NAMES.slice(), ...rows]));
  return p;
}

function receiptPath(root) {
  const dir = join(root, RECEIPT_DIR);
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  return hits.length ? join(dir, hits[hits.length - 1]) : null;
}

/** Parse the receipt the way a reader must: a torn LAST line is expected here
 *  — SIGKILL can land mid-append — and it is dropped, not guessed at. */
function readEntries(p) {
  const entries = [];
  let dropped = 0;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (line === "") continue;
    try { entries.push(JSON.parse(line)); } catch { dropped++; }
  }
  return { entries, dropped };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("SIGKILL mid-write: the exit code is non-zero AND the receipt's unmatched-intent set is a complete, tight record of what did not land",
  { timeout: 120000 }, async (t) => {
    const root = board(t);
    const csv = bigCsv(root);
    const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") };
    delete env.BLAZE_SESSION;

    const child = spawn(process.execPath, [CLI, "import", "--apply", csv],
      { cwd: root, env, stdio: "ignore" });

    // Wait until the run is genuinely mid-write, then kill. Polling the
    // receipt is what makes this deterministic rather than a sleep race: the
    // file only grows because `appendRegularFileSync` has already returned,
    // so seeing N lines means N records are durable.
    let killed = false;
    for (let i = 0; i < 2000; i++) {
      const p = receiptPath(root);
      if (p) {
        const { entries } = readEntries(p);
        if (entries.filter((e) => e.phase === "done").length >= 5) {
          // Kill the RUNNER, not the 40-line cli.mjs parent, so cli.mjs's own
          // signal mapping is the thing under test. cli.mjs spawns the runner
          // as its only child (cli.mjs:9).
          const kids = spawnSync("pgrep", ["-P", String(child.pid)], { encoding: "utf8" });
          const pid = Number(String(kids.stdout ?? "").trim().split("\n")[0]);
          if (Number.isFinite(pid) && pid > 0) {
            process.kill(pid, "SIGKILL");
            killed = true;
            break;
          }
        }
      }
      await sleep(5);
    }

    const observed = await new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve({ status: code, signal }));
    });

    assert.equal(killed, true, "the run never reached a killable mid-write state");

    // --- half 1: THE EXIT CODE.
    //
    // BLZ-639 shipped `exitCodeForSpawn`, which maps a signal-killed child's
    // `status: null` to `128 + signum` instead of the old `r.status ?? 0`.
    // Before it, an OOM-killed import that wrote 300 of 500 tickets exited
    // 0 — strictly worse than exit 1, because 1 at least says something went
    // wrong. This asserts the observed code through the process boundary the
    // operator actually sees.
    assert.notEqual(observed.status, 0,
      "a signal-killed import must never report success with the board partially written");
    assert.equal(observed.status, 137,
      "cli.mjs maps the runner's SIGKILL to 128 + 9 through exitCodeForSpawn (BLZ-639)");
    assert.equal(exitCodeForSpawn({ status: null, signal: "SIGKILL" }), 137,
      "and that is the same mapping, applied to the shape spawnSync reports");

    // --- half 2: THE RECEIPT, which is what says HOW MUCH was written.
    const rp = receiptPath(root);
    assert.ok(rp, "the receipt must exist — it is established before the writes it describes");
    const { entries } = readEntries(rp);

    const doneSeqs = new Set(entries.filter((e) => e.phase === "done").map((e) => e.seq));
    const allocatedById = new Map(
      entries.filter((e) => e.phase === "allocated").map((e) => [e.seq, e.id]));
    const intents = entries.filter((e) => e.phase === "intent");
    assert.ok(intents.length > 0, "the run must have got far enough to record intent");

    const unmatched = new Set(intents.filter((e) => !doneSeqs.has(e.seq)).map((e) => e.seq));

    // `not-on-disk`, derived by mapping each seq to its id through
    // `allocated` (or the intent's own id on the explicit path) and then to
    // the board. A seq with no id anywhere is NOT ON DISK by definition.
    const onDiskIds = new Set(
      readdirSync(join(root, "projects", "BLZ", "defined")).map((f) => f.split("-").slice(0, 2).join("-")));
    const notOnDisk = new Set();
    for (const e of intents) {
      const id = allocatedById.get(e.seq) ?? e.id ?? null;
      if (id === null || !onDiskIds.has(id)) notOnDisk.add(e.seq);
    }

    // --- THE ANCHOR, and it is what makes the two halves below discriminate
    // at all. Both sets are derived from the receipt, so an append the
    // receipt LOST removes a row from each side at once and cancels — the
    // superset and tightness checks then hold vacuously over a receipt that
    // is missing half the run. Measured: buffering the appends (the
    // `createWriteStream` shape §5.1 forbids) left ~100 tickets on disk that
    // the receipt never mentioned, and both halves still passed.
    //
    // So: EVERY TICKET ON DISK MUST BE NAMED BY AN INTENT. That is the
    // receipt's actual promise — it is what says HOW MUCH was written — and
    // it is the property only a durable, unbuffered append can keep.
    const intentIds = new Set();
    for (const e of intents) {
      const id = allocatedById.get(e.seq) ?? e.id ?? null;
      if (id !== null) intentIds.add(id);
    }
    for (const id of onDiskIds) {
      assert.equal(intentIds.has(id), true,
        `${id} is on the board and the receipt does not name it — the receipt is not the record of `
        + `what this run wrote. A buffered append loses exactly this, and the exit code cannot say `
        + `how much was written (§5.1)`);
    }


    // COMPLETE: every unwritten row is named.
    for (const seq of notOnDisk) {
      assert.equal(unmatched.has(seq), true,
        `seq ${seq} is not on disk and is not named by an unmatched intent — the set is incomplete, `
        + `which is the one thing the receipt exists to guarantee`);
    }
    // TIGHT: at most the one row that was in flight when the kill landed.
    const extra = [...unmatched].filter((s) => !notOnDisk.has(s));
    assert.ok(extra.length <= 1,
      `the unmatched set over-reports by ${extra.length} rows (${extra.join(", ")}); at most the `
      + `one row in flight between its ticket write and its \`done\` may differ`);

    // And the durability claim the two halves rest on: the run really did
    // write tickets before it died, and the receipt really did record them.
    assert.ok(onDiskIds.size >= 5, "the kill must land mid-write, not before the first write");
    assert.ok(doneSeqs.size >= 5,
      "every `done` on the receipt survived SIGKILL — appendRegularFileSync's O_APPEND write is in "
      + "the kernel's page cache before the call returns, which a createWriteStream receipt is not");
  });
