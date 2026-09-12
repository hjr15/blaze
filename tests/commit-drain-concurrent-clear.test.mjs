// tests/commit-drain-concurrent-clear.test.mjs — BLZ-608: two ORDINARY, concurrent
// `blaze commit` flushes of the same queue must not destroy a ledger record that neither
// of them read.
//
// THE DEFECT, reproduced against 13f661c with no injected fault and no lock steal.
// `readForDrain` runs at commit-runner.mjs:359 — inside the `const drained = targets…`
// statement that begins at :358 — while `acquireLock(store, …)` does not run until :557. So
// two overlapping flushes both measure `bytes` over the SAME on-disk file before either one
// takes the store lock, and whichever clears second calls `clearLedger` (:747) with a byte
// count taken from a file that has since changed shape. Measured: a 106-byte ledger became
// the 3-byte fragment `"}\n`, the op appended while both runs were in flight was in no
// commit and sat untracked on disk, and BOTH processes exited 0.
//
// WHY THE GUARD AND NOT THE LOCK. The ticket offers two directions. Moving `readForDrain`
// under the store lock narrows the window but does not close it: `acquireLock`'s 60 s
// `staleMs` steals the lock from a LIVE owner by design (commit-lock.mjs, pinned by
// tests/commit-lock.test.mjs), so a flush slower than the lease still has its lock taken and
// the same two-reader shape returns — and holding the lock across every git probe and the
// whole classification pass makes exceeding that lease MORE likely, not less. A lock is a
// convention; the bytes are a fact. So the clear PROVES it is erasing what it read: it
// compares the queue's current leading `consumedBytes` against the exact bytes
// `readForDrain` returned, and refuses — ledger kept, run reported, exit non-zero — when
// they differ. That is correct whatever the lock did, which is the property this file
// defends from four sides:
//
//   * T1/T2 — the clear refuses when the queue changed under the run, in BOTH shapes:
//     a file that shrank, and a file of the same length holding different bytes.
//   * T3 — a clear offered NO proof refuses too. Fail closed: a drain-exact clear that
//     cannot say which bytes it read is a guess, and this is the one path where a wrong
//     guess destroys a record nothing can re-derive.
//   * T4 — the feature the byte arithmetic exists for still works: an op appended mid-drain
//     survives a clear whose prefix IS intact. A guard that refused everything would pass
//     T1–T3 and be useless.
//   * T5 — the end-to-end race itself, two real `blaze commit` processes.
//   * T6 — the ROLLBACK. T5's scenario with the proof neutralised in the fixture's own copy
//     of the engine, asserting the original destruction returns. Without it T5 is
//     green-by-construction and proves nothing.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, chmodSync, existsSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { appendEntry, ledgerPath, readForDrain, readEntries, clearLedger }
  from "../scripts/pending-ledger.mjs";

const REPO = join(import.meta.dirname, "..");
const SESSION = "s1";

const cleanup = (d) => rmSync(d, { recursive: true, force: true });

/** A temp board carrying its own copy of scripts/, so the copied runner resolves its
 *  script-relative root to the fixture and never to this worktree. The prefix is a LITERAL
 *  at the `mkdtempSync` call (BLZ-491) so tests/tmp-scratch-attribution.test.mjs's static
 *  scan can trace a leaked directory back here. */
function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-concurrentclear-"));
  cpSync(join(REPO, "scripts"), join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "projects", "ZZZ", "defined"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "seed"), "seed");
  execFileSync("git", ["-C", root, "add", "seed"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

const ledgerTmp = () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-concurrentclear-unit-"));
  mkdirSync(join(root, ".blaze"), { recursive: true });
  return root;
};

const gitIn = (root, ...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
const op = (id) => ({ id, op: "new", message: `${id}: create task`, files: [`projects/ZZZ/defined/${id}.md`], ts: "t" });

// ---------------------------------------------------------------------------
// T1–T4 — the clear itself, driven directly. No timing, no processes: the property is
// about bytes, so it is asserted about bytes.
// ---------------------------------------------------------------------------
describe("BLZ-608: a drain-exact clear must prove it is erasing the bytes it read", () => {
  test("T1: the queue SHRANK under the run — the clear refuses and keeps every byte", () => {
    const root = ledgerTmp();
    try {
      appendEntry(root, op("ZZZ-1"), SESSION);
      const q = readForDrain(root, SESSION);
      assert.ok(q.bytes > 0);
      // Another flush cleared this queue and something shorter took its place — exactly
      // what the second of two overlapping flushes finds.
      const survivor = `${JSON.stringify(op("ZZZ-LATE"))}\n`.slice(0, 20);
      writeFileSync(ledgerPath(root, SESSION), survivor);

      const res = clearLedger(root, SESSION, q.bytes, [], q.consumed);
      assert.equal(res.cleared, false, "a clear that cannot prove what it erases must refuse");
      assert.match(res.why, /read|changed/i, "and must say why, so the operator can act on it");
      assert.equal(readFileSync(ledgerPath(root, SESSION), "utf8"), survivor,
        "the file is byte-identical — nothing was truncated, shredded or removed");
    } finally { cleanup(root); }
  });

  test("T2: the queue is the SAME LENGTH and different bytes — the clear still refuses", () => {
    const root = ledgerTmp();
    try {
      appendEntry(root, op("ZZZ-1"), SESSION);
      const q = readForDrain(root, SESSION);
      // A length check alone — the ticket's first proposal — passes this and destroys the
      // record. Byte equality is what actually decides it.
      const replacement = Buffer.alloc(q.bytes, 0x41);
      writeFileSync(ledgerPath(root, SESSION), replacement);

      const res = clearLedger(root, SESSION, q.bytes, [], q.consumed);
      assert.equal(res.cleared, false, "same length is not the same bytes");
      assert.deepEqual(readFileSync(ledgerPath(root, SESSION)), replacement, "and nothing was erased");
    } finally { cleanup(root); }
  });

  test("T3: a drain-exact clear offered NO record of what it read refuses — fail closed", () => {
    const root = ledgerTmp();
    try {
      appendEntry(root, op("ZZZ-1"), SESSION);
      const q = readForDrain(root, SESSION);
      const before = readFileSync(ledgerPath(root, SESSION));

      const res = clearLedger(root, SESSION, q.bytes, []); // byte offset, no proof
      assert.equal(res.cleared, false,
        "a byte-offset clear with no record of the bytes read is a guess, and this is the one "
        + "path where a wrong guess destroys a record nothing can re-derive");
      assert.deepEqual(readFileSync(ledgerPath(root, SESSION)), before, "so the ledger is kept");
    } finally { cleanup(root); }
  });

  test("T3b: a queue that VANISHED between the read and the clear reports not-cleared", () => {
    const root = ledgerTmp();
    try {
      appendEntry(root, op("ZZZ-1"), SESSION);
      const q = readForDrain(root, SESSION);
      rmSync(ledgerPath(root, SESSION), { force: true }); // another run drained and unlinked it

      const res = clearLedger(root, SESSION, q.bytes, [], q.consumed);
      assert.equal(res.cleared, false,
        "nothing was cleared by THIS run, and a caller that is told otherwise goes on to "
        + "report a queue it never emptied");
      assert.match(res.why, /no longer on disk/);
    } finally { cleanup(root); }
  });

  test("T4: an intact prefix still clears, and an op appended mid-drain still survives", () => {
    const root = ledgerTmp();
    try {
      appendEntry(root, op("ZZZ-1"), SESSION);
      const q = readForDrain(root, SESSION);
      const late = op("ZZZ-LATE");
      appendEntry(root, late, SESSION); // another session, while this drain was committing

      const res = clearLedger(root, SESSION, q.bytes, [], q.consumed);
      assert.equal(res.cleared, true, `the drain-exact clear must still work: ${res.why}`);
      assert.deepEqual(readEntries(root, SESSION), [late],
        "only the op appended after the read survives — the guard must not break the feature "
        + "the byte arithmetic exists for");
    } finally { cleanup(root); }
  });
});

// ---------------------------------------------------------------------------
// T5/T6 — the end-to-end race, and its rollback.
// ---------------------------------------------------------------------------

/** The ticket's repro, as a function of the board it runs against, so T5 and T6 drive
 *  BYTE-IDENTICAL scenarios and differ only in the engine the fixture carries.
 *
 *  P1 is slowed by a plain `sleep 1` git pre-commit hook — the commonest real-world cause of
 *  a long flush, and no part of blaze. P2 starts 150 ms later against the same one-op queue
 *  and blocks on P1's store lock. While both are in flight a brand-new op is appended: the
 *  exact case `clearLedger`'s drain-exact arithmetic exists to protect. */
async function race(root) {
  const rel1 = "projects/ZZZ/defined/ZZZ-x1.md";
  writeFileSync(join(root, rel1), "ZZZ-x1 body\n");
  appendEntry(root, op("ZZZ-x1"), SESSION);
  const originalBytes = readFileSync(ledgerPath(root, SESSION)).length;

  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nsleep 1\n");
  chmodSync(hook, 0o755);

  const env = { ...process.env, BLAZE_SESSION: SESSION };
  delete env.CLAUDE_CODE_SESSION_ID;
  const run = (tag) => new Promise((res) => {
    const p = spawn(process.execPath, [join(root, "scripts", "commit-runner.mjs")],
      { cwd: root, env, timeout: 60_000 });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => res({ tag, code, out, err }));
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const p1 = run("P1");
  await sleep(150);
  const p2 = run("P2");   // reads the SAME one-op ledger, then blocks on the lock
  await sleep(400);       // P1 is still inside its pre-commit hook, lock held

  const relNew = "projects/ZZZ/defined/ZZZ-NEW.md";
  writeFileSync(join(root, relNew), "queued during the flush, never committed\n");
  appendEntry(root, op("ZZZ-NEW"), SESSION);

  const [r1, r2] = await Promise.all([p1, p2]);
  const path = ledgerPath(root, SESSION);
  const ledger = existsSync(path) ? readFileSync(path, "utf8") : "";
  return {
    runs: [r1, r2], originalBytes, ledger,
    inACommit: gitIn(root, "log", "--all", "--name-only", "--format=").includes("ZZZ-NEW.md"),
    inTheLedger: ledger.split("\n").some((l) => {
      try { return JSON.parse(l).id === "ZZZ-NEW"; } catch { return false; }
    }),
  };
}

/** ASSERT THE OBSERVATION HAPPENED. If P2 was simply refused by the store lock it never
 *  reached a clear at all, and a green assertion below would be a run that could not look
 *  rather than a run that looked. Both processes must have got past the lock. */
function assertBothRan(r) {
  for (const p of r.runs) {
    assert.doesNotMatch(p.err, /commit\.lock held/,
      `${p.tag} was refused by the lock and never reached a clear — this run observed nothing:\n${p.err}`);
  }
  assert.equal(r.runs.filter((p) => /flushed 1 op/.test(p.out)).length, 1,
    `exactly one of the two runs must have made the commit:\n${r.runs.map((p) => `${p.tag} ${p.out}${p.err}`).join("\n")}`);
}

test("BLZ-608: two ordinary concurrent flushes never destroy the op appended while both were in flight", async () => {
  const root = board();
  try {
    const r = await race(root);
    assertBothRan(r);

    assert.ok(r.inACommit || r.inTheLedger,
      "the mid-flight op must end in a commit or in the ledger — never in neither. "
      + `ledger on disk: ${JSON.stringify(r.ledger)}; runs: `
      + r.runs.map((p) => `${p.tag} exit=${p.code}`).join(", "));

    // And what is left of the queue is a QUEUE, not a fragment of one. The shredded
    // remainder the defect leaves ("}\n) is itself unparseable, which is how the destroyed
    // record then goes on to be silently stranded rather than quarantined.
    for (const line of r.ledger.split("\n").filter((l) => l.trim() !== "")) {
      assert.doesNotThrow(() => JSON.parse(line),
        `the drain left an unparseable fragment in the queue: ${JSON.stringify(line)}`);
    }

    // NO FALSE GREEN, and the run that kept a queue must SAY so. Exactly one of the two can
    // refuse: the first to clear finds its prefix intact and clears; the second finds a file
    // it never read. Asserted as an exact count rather than "at least one", because a guard
    // that refused both would leave the committed ops queued forever.
    const kept = r.runs.filter((p) => /queue\(s\) were NOT cleared/.test(p.err));
    assert.equal(kept.length, 1,
      "exactly one of the two overlapping flushes must report the queue it did not clear:\n"
      + r.runs.map((p) => `${p.tag} exit=${p.code}\n  out:${p.out}\n  err:${p.err}`).join("\n"));
    assert.equal(kept[0].code, 3,
      "and it must exit 3 (ops remain queued that this run could not reach), never 0 — "
      + "an unattended CronJob reads 0 as `the board is flushed`");
    assert.doesNotMatch(kept[0].out, /[Cc]leared from the queue/,
      "and it must not also claim it cleared the queue it just declined to clear");
    assert.equal(r.runs.find((p) => p !== kept[0]).code, 0,
      "the run whose clear WAS provable still succeeds — the guard must not refuse everything");
  } finally { cleanup(root); }
});

/** Replace one named function's BODY in the fixture's own copy of the engine, located by
 *  brace matching rather than by a regex over its contents — so the rollback re-instates the
 *  pre-fix behaviour without pinning how the guard happens to be spelled. */
function neutralise(file, fn, body) {
  const src = readFileSync(file, "utf8");
  const at = src.indexOf(`export function ${fn}(`);
  assert.notEqual(at, -1, `${fn} is not in ${file} — the rollback has nothing to neutralise`);
  const open = src.indexOf("{", src.indexOf(")", at));
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  const out = `${src.slice(0, open)}{ ${body} }${src.slice(i + 1)}`;
  assert.notEqual(out, src, "the rollback mutation changed nothing — it did not apply");
  writeFileSync(file, out);
}

test("BLZ-608 ROLLBACK: with the proof neutralised, the same race destroys the mid-flight op", async () => {
  const root = board();
  try {
    // The pre-fix engine: a drain-exact clear that trusts its byte count unconditionally.
    neutralise(join(root, "scripts", "pending-ledger.mjs"), "consumedPrefixIntact",
      "return { ok: true, why: null };");

    const r = await race(root);
    assertBothRan(r);

    assert.equal(r.inACommit, false, "the mid-flight op is in no commit");
    assert.equal(r.inTheLedger, false,
      "…and its ledger record is gone too — this is the destruction BLZ-608 reports. "
      + `ledger on disk: ${JSON.stringify(r.ledger)}`);
    assert.ok(r.ledger.length < r.originalBytes,
      `and what is left is a fragment of a queue, not a queue: ${JSON.stringify(r.ledger)}`);
    // The whole point of the ticket: it happens at exit 0, unattended, with nothing said.
    assert.deepEqual(r.runs.map((p) => p.code), [0, 0],
      "both processes reported success over a record they had just destroyed");
  } finally { cleanup(root); }
});
