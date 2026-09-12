// tests/queue-store-migration-provenance.test.mjs — BLZ-602: the queue-store migration must
// STAMP provenance onto the lines it moves.
//
// THE DEFECT. `docs/operations/queue-store-migration.md` and its
// `migrate-queue-store.sh` appended ledger lines BYTE-VERBATIM into the shared store and
// stamped nothing — the runbook said so in as many words: "The ops need no rewriting … Do not
// edit the JSONL." BLZ-590 then made the store's own working tree the SOLE CLAIMANT of an op
// recording neither `worktree` nor `branch` (commit-runner.mjs's `queuedHere`: `return
// here.worktree === ""`). Compose the two and a no-provenance op left in a LANE's pre-BLZ-556
// `.blaze/`, merged into the shared store, is claimed by the MAIN tree, found in none of its
// three trees, classified `absent`/superseded, and CLEARED AT EXIT 0 — while the lane's file
// sits uncommitted and the record that would have led anyone back to it is destroyed.
//
// The runbook's reasoning was true of the ops it was written for and not of the ones it
// describes: "each already records the branch it was queued on" holds for every op queued
// after INF-673, and a PRE-INF-673 op is exactly the case a migration exists to move.
//
// LATENT, NOT LIVE — measured, not assumed. Across the live board's shared store and every
// stranded queue in every working copy: 32 ops in 47 queue files, of which 19 record `branch`
// only and 13 record both `worktree` and `branch`. NONE records no provenance, so there is no
// op on disk today that this destroys. (The ticket measured 216 ops on 2026-08-31 with the
// same result of zero; the store has drained since.) It is reachable in principle and
// unreachable in fact, which is why it is fixed in the migration rather than guessed at in
// the engine — `queuedHere` cannot recover a fact the record does not carry.
//
// WHAT IS PINNED HERE:
//   T1 — a migrated lane op, stamped, is HELD BACK when judged from the main tree.
//   T2 — the ROLLBACK: unstamp that same line and the exit-0 destruction returns. Without it
//        T1 is green-by-construction, because a held-back op and an op that was never at risk
//        look identical from outside.
//   T3 — an op that ALREADY records provenance is passed through byte-verbatim. The ledger is
//        append-only evidence; re-serialising a line this engine did not write normalises it,
//        and overwriting a recorded `worktree` would destroy the only fact that matters.
//   T4 — a line that will not parse is REFUSED, not stamped. A regex that injects a field into
//        text it did not understand is how a migration fuses two records into one.
//   T5 — the real `migrate` subcommand stamps, end to end.
//   T6 — the DOCUMENTED MANUAL PROCEDURE says the same thing the script does. The ticket asks
//        for both, and an operator following the prose is the path that had no guard at all.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, cpSync, existsSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const REPO = join(import.meta.dirname, "..");
const SCRIPT = join(REPO, "docs", "operations", "migrate-queue-store.sh");
const DOC = join(REPO, "docs", "operations", "queue-store-migration.md");
const SESSION = "s1";
const cleanup = (...p) => { for (const x of p) rmSync(x, { recursive: true, force: true }); };
const gitIn = (root, ...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });

/** The board (which IS the shared store) plus a linked worktree standing in for a lane. */
function fixture() {
  const main = mkdtempSync(join(tmpdir(), "blaze-migprov-"));
  cpSync(join(REPO, "scripts"), join(main, "scripts"), { recursive: true });
  mkdirSync(join(main, "projects", "ZZZ", "defined"), { recursive: true });
  writeFileSync(join(main, "blaze.config.json"), "{}\n");
  execFileSync("git", ["-C", main, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", main, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", main, "config", "user.name", "t"]);
  writeFileSync(join(main, "seed"), "seed");
  execFileSync("git", ["-C", main, "add", "-A"]);
  execFileSync("git", ["-C", main, "commit", "-q", "-m", "seed"]);
  const lane = join(dirname(main), `blaze-migprov-lane-${process.pid}-${Math.random().toString(36).slice(2)}`);
  gitIn(main, "worktree", "add", "-q", "-b", "lane-x", lane);
  return { main, lane };
}

/** THE FIXTURE THE WHOLE TICKET IS ABOUT: a pre-INF-673 op, stranded in a LANE's own
 *  pre-BLZ-556 `.blaze/`, recording NEITHER `worktree` NOR `branch`, whose file exists only
 *  in that lane. Written as raw JSON rather than through `appendEntry`, because the current
 *  engine stamps provenance unconditionally and this shape is precisely what it no longer
 *  produces. */
function strandedLaneOp(lane, id = "ZZZ-7") {
  const rel = `projects/ZZZ/defined/${id}.md`;
  mkdirSync(join(lane, "projects", "ZZZ", "defined"), { recursive: true });
  writeFileSync(join(lane, rel), `${id} lane work, never committed\n`);
  const line = JSON.stringify({ id, op: "new", message: `${id}: create task`, files: [rel], ts: "t" });
  mkdirSync(join(lane, ".blaze", "pending"), { recursive: true });
  const src = join(lane, ".blaze", "pending", `${SESSION}.jsonl`);
  writeFileSync(src, `${line}\n`);
  return { rel, line, src };
}

const sh = (args, opts = {}) => {
  const r = spawnSync("bash", [SCRIPT, ...args],
    { encoding: "utf8", timeout: 120_000, ...opts });
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status };
};

function flush(main, args = ["--all"]) {
  const env = { ...process.env, BLAZE_SESSION: "flusher" };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [join(main, "scripts", "commit-runner.mjs"), ...args],
    { cwd: main, env, encoding: "utf8", timeout: 60_000 });
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status };
}

/** What the migration must put in the store, and what the RUNBOOK's manual procedure must
 *  tell an operator to put there. Moving the lane's source aside mirrors what `migrate` does
 *  (into `.blaze/migrated-*`, which `strandedQueues` does not read) so the flush below is
 *  judging the migrated copy and nothing else. */
function migrateInto(main, lane, srcPath, { stamp }) {
  const store = join(main, ".blaze", "pending");
  mkdirSync(store, { recursive: true });
  let payload;
  if (stamp) {
    const r = sh(["stamp", lane, srcPath]);
    assert.equal(r.code, 0, `stamp refused: ${r.err}`);
    payload = r.out;
  } else {
    payload = readFileSync(srcPath, "utf8");   // the pre-BLZ-602 behaviour: byte-verbatim
  }
  appendFileSync(join(store, `${SESSION}.jsonl`), payload);
  const hold = join(lane, ".blaze", `migrated-x`, "pending");
  mkdirSync(hold, { recursive: true });
  writeFileSync(join(hold, `${SESSION}.jsonl`), readFileSync(srcPath));
  rmSync(srcPath);
  return payload;
}

describe("BLZ-602: the migration stamps provenance onto the lines it moves", () => {
  test("T1: a migrated lane op is HELD BACK when the main tree judges it, not cleared", () => {
    const { main, lane } = fixture();
    try {
      const { rel, src } = strandedLaneOp(lane);
      const payload = migrateInto(main, lane, src, { stamp: true });

      // The stamp is the lane's path RELATIVE TO THE STORE — the same value the engine
      // computes as `here.worktree`, so `queuedHere` can compare them at all.
      assert.equal(JSON.parse(payload).worktree, relative(main, lane),
        "the stamp must be the source copy's path relative to the store");

      const r = flush(main);
      assert.equal(r.code, 3,
        `the main tree must refuse to judge a lane's op: ${r.out}${r.err}`);
      assert.match(r.err, /could not establish what they record|belong to ANOTHER working tree/,
        "and must say so, naming the checkout it belongs to");
      assert.match(readFileSync(join(main, ".blaze", "pending", `${SESSION}.jsonl`), "utf8"),
        /ZZZ-7/, "the ledger record survives — it is the only thing that leads anyone back to the work");
      assert.equal(existsSync(join(lane, rel)), true, "and the lane's file is untouched");
      assert.doesNotMatch(gitIn(main, "log", "--all", "--name-only", "--format="), /ZZZ-7/,
        "nothing of the lane's was committed from here");
    } finally { cleanup(main, lane); }
  });

  test("T2 ROLLBACK: unstamped, the same line is claimed by the main tree and cleared at exit 0", () => {
    const { main, lane } = fixture();
    try {
      const { rel, src } = strandedLaneOp(lane);
      migrateInto(main, lane, src, { stamp: false });   // byte-verbatim: the pre-fix migration

      const r = flush(main);
      // THE DESTRUCTION, in full: a green run, an emptied queue, and the work still sitting
      // uncommitted in the lane with nothing left recording that it exists.
      assert.equal(r.code, 0,
        `the pre-fix migration is cleared at exit 0 — that is the defect: ${r.out}${r.err}`);
      assert.match(r.out, /superseded/,
        "the main tree claims an op it cannot see and calls it superseded");
      assert.equal(existsSync(join(main, ".blaze", "pending", `${SESSION}.jsonl`)), false,
        "and the queue is cleared — the record is gone from the store");
      assert.equal(existsSync(join(lane, rel)), true,
        "while the lane's file sits uncommitted, now with nothing anywhere pointing at it");
      assert.doesNotMatch(gitIn(main, "log", "--all", "--name-only", "--format="), /ZZZ-7/,
        "and it is in no commit either");
    } finally { cleanup(main, lane); }
  });

  test("T3: a line that already records provenance is passed through BYTE-VERBATIM", () => {
    const { main, lane } = fixture();
    try {
      mkdirSync(join(lane, ".blaze", "pending"), { recursive: true });
      // Deliberately not what `JSON.stringify` of a parsed copy would produce: key order that
      // no re-serialisation would reproduce, and an unusual `worktree` this engine did not
      // write. Both must survive.
      const already = '{"worktree":"somewhere-else","id":"ZZZ-8","op":"new","files":["projects/ZZZ/defined/ZZZ-8.md"],"message":"m","ts":"t"}';
      const src = join(lane, ".blaze", "pending", `${SESSION}.jsonl`);
      writeFileSync(src, `${already}\n`);

      const r = sh(["stamp", lane, src]);
      assert.equal(r.code, 0, r.err);
      assert.equal(r.out, `${already}\n`,
        "a recorded provenance is the fact the drain decides on — overwriting it destroys the "
        + "only evidence of where the work is, and re-serialising it normalises a line this "
        + "engine did not write");
    } finally { cleanup(main, lane); }
  });

  test("T3b: a line recording only `branch` IS stamped — `worktree` is what is exempt, not provenance", () => {
    const { main, lane } = fixture();
    try {
      mkdirSync(join(lane, ".blaze", "pending"), { recursive: true });
      const src = join(lane, ".blaze", "pending", `${SESSION}.jsonl`);
      writeFileSync(src, '{"id":"ZZZ-8","op":"new","files":["projects/ZZZ/defined/ZZZ-8.md"],"message":"m","ts":"t","branch":"lane-x"}\n');

      const r = sh(["stamp", lane, src]);
      assert.equal(r.code, 0, r.err);
      const e = JSON.parse(r.out);
      assert.equal(e.worktree, relative(main, lane),
        "a branch-only op becomes worktree-claimable — the stronger fact, and the common case: "
        + "19 of the 32 live ops measured on 2026-09-09 recorded only `branch`");
      assert.equal(e.branch, "lane-x", "and the branch it recorded is kept");
    } finally { cleanup(main, lane); }
  });

  test("T4: a line that will not parse is REFUSED, and nothing is written", () => {
    const { main, lane } = fixture();
    try {
      mkdirSync(join(lane, ".blaze", "pending"), { recursive: true });
      const src = join(lane, ".blaze", "pending", `${SESSION}.jsonl`);
      writeFileSync(src, '{"id":"ZZZ-9","op":"new","files":[],"message":"m","ts":"t"}\n{"id":"ZZZ-1\n');

      const r = sh(["stamp", lane, src]);
      assert.notEqual(r.code, 0, `a migration must not stamp text it could not parse:\n${r.out}`);
      assert.match(r.err, /line 2/, "and must name the line, so the operator can fix it");
    } finally { cleanup(main, lane); }
  });

  test("T5: the migrate subcommand itself stamps, end to end", () => {
    const { main, lane } = fixture();
    try {
      strandedLaneOp(lane);
      const env = {
        ...process.env,
        BLAZE_STATUS_CMD: `${process.execPath} ${join(main, "scripts", "commit-runner.mjs")} --status`,
      };
      delete env.CLAUDE_CODE_SESSION_ID;
      // `assert_quiesced` refuses while ANY node commit-runner/reconcile is running anywhere on
      // the host, and the rest of this suite runs them constantly. That is a REFUSAL, not a
      // wrong answer, so it is retried — and if every attempt is refused the test FAILS rather
      // than passing on an observation it never made.
      let r;
      for (let i = 0; i < 40; i++) {
        r = sh(["migrate", lane], { env });
        if (r.code === 0 || !/blaze is running|commit\.lock/.test(r.err)) break;
        execFileSync("sleep", ["0.25"]);
      }
      assert.equal(r.code, 0, `migrate never got a quiet moment to run in:\n${r.err}`);

      const migrated = readFileSync(join(main, ".blaze", "pending", `${SESSION}.jsonl`), "utf8").trim();
      assert.equal(JSON.parse(migrated).worktree, relative(main, lane),
        `the migrate subcommand must stamp what the stamp subcommand stamps:\n${migrated}`);
      assert.equal(JSON.parse(migrated).id, "ZZZ-7", "and must not change anything else");
    } finally { cleanup(main, lane); }
  });

  test("T6: the DOCUMENTED manual procedure stamps too, and no longer says not to", () => {
    const doc = readFileSync(DOC, "utf8");
    assert.doesNotMatch(doc, /ops need no rewriting/,
      "the runbook told the operator the ops need no rewriting — true of a post-INF-673 op and "
      + "false of exactly the pre-INF-673 ops a migration exists to move");
    assert.doesNotMatch(doc, /Do not edit the JSONL/,
      "…and told them not to edit it, which is the instruction that produces the destruction");
    assert.match(doc, /stamp/i, "the procedure must tell the operator that lines are stamped");
    assert.match(doc, /`worktree`/,
      "and must name the field, so a hand-run migration puts the same fact in the same place");
    assert.match(doc, /migrate-queue-store\.sh stamp/,
      "and must give the command, so the manual path and the script path are one procedure");
  });
});
