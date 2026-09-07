// tests/commit-drain-quarantine.test.mjs — BLZ-531: `blaze commit` must not destroy an
// unparseable ledger line when it drains the queue that held it.
//
// THE DEFECT, verified by construction at be4b110 and reproduced here as T1's fixture:
// `readForDrain` measures `bytes` over the WHOLE file, and `parseRecords` skips a line it
// cannot parse. So the drain committed the ops that parsed and then handed `clearLedger`
// the whole-file byte count — erasing the line that was never committed along with the ones
// that were. Three recorded ops with a truncated middle line drained to a commit carrying
// two, and the third was then present NOWHERE on disk. It is the one path on which this
// engine can lose a record for good, and nothing could re-derive it.
//
// The property every test here defends is the same one, from a different side: EVIDENCE THE
// RUN CANNOT RE-DERIVE IS NEVER DESTROYED. Which means, concretely:
//
//   * T1 — the bytes are somewhere on disk after the drain, and recoverable verbatim. Not
//     "the code called quarantine": the assertion is a filesystem scan of the whole board.
//   * T2 — quarantining BYTES, not a decoded string. A queue truncated mid-multibyte-
//     character decodes that byte to U+FFFD, which re-encodes at three DIFFERENT bytes; a
//     quarantine that round-trips through a JS string silently rewrites the evidence.
//   * T3 — a quarantine that FAILS keeps the ledger (fail closed) and does not leak the
//     commit lock, so the next flush still runs. Driven by injecting EISDIR on the sidecar.
//   * T4 — the sidecar write goes through ADR-0031's regular-file guard, so a FIFO planted
//     at that path is refused immediately instead of blocking in open(2) forever.
//
// T4 is driven with a bounded spawn `timeout` for the reason ADR-0031 exists: a synchronous
// open that blocks cannot be rescued by `node:test`'s own timer, which lives on an event
// loop the blocked call never yields to. A regression must redden this test in seconds
// rather than hang the suite the way the bug hangs the board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { appendEntry, ledgerPath, quarantinePath } from "../scripts/pending-ledger.mjs";
import { lockPath } from "../scripts/commit-lock.mjs";

const REPO = join(import.meta.dirname, "..");
const HARNESS_ID = "test-harness-uuid";
const SESSION = "drain-quarantine-session";

/** A temp board carrying its own copy of scripts/, so the copied runner resolves its
 *  script-relative root to the fixture and never to this worktree. The prefix is a LITERAL
 *  at the `mkdtempSync` call (BLZ-491) so `tests/tmp-scratch-attribution.test.mjs`'s static
 *  scan can trace a leaked directory back here. */
function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-drainquarantine-"));
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

function runCommit(root, { session = SESSION, args = [], timeout = 60_000 } = {}) {
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: HARNESS_ID, BLAZE_SESSION: session };
  const r = spawnSync(process.execPath, [join(root, "scripts", "commit-runner.mjs"), ...args],
    { cwd: root, env, encoding: "utf8", timeout });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status, signal: r.signal };
}

const gitIn = (root, ...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" });
const headCount = (root) => Number(gitIn(root, "rev-list", "--count", "HEAD").trim());

/** Queue an op whose work is genuinely outstanding — written, never committed — so the
 *  drain has something real to commit and cannot be mistaken for a no-op run. */
function queueOutstanding(root, id, session = SESSION) {
  const rel = `projects/ZZZ/defined/${id}.md`;
  writeFileSync(join(root, rel), `${id} body\n`);
  appendEntry(root, { id, op: "new", message: `${id}: create task`, files: [rel], ts: "t" }, session);
  return rel;
}

/** THE be4b110 CONSTRUCTION. Three recorded ops, and the MIDDLE line replaced by a
 *  truncated prefix of itself — the shape a process killed mid-append leaves behind, and
 *  the shape whose recovery this ticket is about. Returns the truncated line's exact BYTES,
 *  which is what every assertion downstream looks for: a paraphrase is not a record.
 *
 *  The middle line, not the last, deliberately. A trailing partial line is the case the
 *  `bytes`-on-the-raw-buffer comment in `readForDrain` already reasons about; a partial line
 *  with good ops on BOTH sides is the case that proves the drain preserves position as well
 *  as content. */
function threeOpsWithTruncatedMiddleLine(root, session = SESSION, middle = null) {
  for (const id of ["ZZZ-1", "ZZZ-2", "ZZZ-3"]) queueOutstanding(root, id, session);
  const path = ledgerPath(root, session);
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
  assert.equal(lines.length, 3, "fixture must have queued exactly three ops");
  // Default: chop the middle line mid-JSON, so it cannot parse and cannot be reconstructed.
  const truncated = middle ?? Buffer.from(lines[1].slice(0, 24), "utf8");
  const rebuilt = Buffer.concat([
    Buffer.from(`${lines[0]}\n`, "utf8"), truncated, Buffer.from("\n", "utf8"),
    Buffer.from(`${lines[2]}\n`, "utf8"),
  ]);
  writeFileSync(path, rebuilt);
  assert.throws(() => JSON.parse(truncated.toString("utf8")),
    "the fixture's middle line must actually be unparseable, or this test proves nothing");
  return truncated;
}

/** Every file under `root` whose bytes CONTAIN `needle`, as board-relative paths.
 *
 *  The assertion is deliberately a filesystem scan and not "quarantineDropped was called":
 *  the acceptance criterion is that the line "is present somewhere on disk afterwards", and
 *  only looking at the disk can establish that. Nothing is excluded from the walk — not
 *  `.git`, not `scripts/` — so a hit anywhere at all counts in the fix's favour, which
 *  makes an empty result the strongest possible statement of the defect. */
function filesContaining(root, needle) {
  const hits = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) { walk(p); continue; }
      if (!d.isFile()) continue;
      let buf;
      try { buf = readFileSync(p); } catch { continue; }
      if (buf.includes(needle)) hits.push(relative(root, p));
    }
  };
  walk(root);
  return hits;
}

/** The raw records a sidecar holds, recovered by the format `quarantineDropped` writes:
 *  one record per line, `<ISO stamp>\t<the raw bytes, verbatim>`. Split at the FIRST tab —
 *  the quarantined bytes may contain tabs of their own, and must come back unaltered. */
function recoverQuarantined(path) {
  return readFileSync(path).toString("binary").split("\n").filter((l) => l !== "")
    .map((l) => Buffer.from(l.slice(l.indexOf("\t") + 1), "binary"));
}

// ---------------------------------------------------------------------------
// T1 — THE TICKET. The be4b110 construction, end to end through the real verb.
// ---------------------------------------------------------------------------
test("BLZ-531: an unparseable ledger line survives the drain of the queue that held it", () => {
  const root = board();
  try {
    const truncated = threeOpsWithTruncatedMiddleLine(root);
    const before = headCount(root);

    const r = runCommit(root);

    // The good ledger is not held hostage by the one bad line: the flush still happens.
    assert.equal(headCount(root), before + 1, `the two parseable ops must still be committed: ${r.stderr}`);
    const body = gitIn(root, "log", "-1", "--format=%B");
    assert.match(body, /ZZZ-1: create task/);
    assert.match(body, /ZZZ-3: create task/);
    assert.doesNotMatch(body, /ZZZ-2: create task/,
      "the truncated op was never parsed, so the commit must not claim to carry it");

    // THE ACCEPTANCE CRITERION. Not "a sidecar exists" — the BYTES are on disk somewhere.
    const hits = filesContaining(root, truncated);
    assert.notEqual(hits.length, 0,
      `the unparseable line was destroyed by the drain — its bytes are nowhere under ${root}`);

    // …and recoverable, verbatim, from the place the run said it put them.
    const sidecar = quarantinePath(root, SESSION);
    assert.ok(existsSync(sidecar), `the run must park the bytes at ${sidecar}`);
    const recovered = recoverQuarantined(sidecar);
    assert.equal(recovered.length, 1, "exactly the one dropped line, no more and no fewer");
    assert.deepEqual(recovered[0], truncated,
      "the quarantined record must be the RAW line byte-for-byte — a paraphrase is not a record");

    // The drain still did its job on everything it COULD parse.
    assert.equal(existsSync(ledgerPath(root, SESSION)), false,
      "with its one bad line preserved elsewhere, the drained queue is removed as usual");

    // The loss is named on the run that caused it, and the operator is told where to look.
    assert.match(r.stderr, /1 unparseable line\(s\)/);
    assert.ok(r.stderr.includes(sidecar), `stderr must name the sidecar path: ${r.stderr}`);

    // The sidecar must never come back as a phantom queue — its contents are by definition
    // unparseable, so a run that read it as a queue would re-quarantine it forever.
    const after = runCommit(root, { args: ["--status"] });
    assert.equal(after.status, 0, `board reads clean once the bad line is quarantined: ${after.stderr}`);
    assert.doesNotMatch(after.stdout, /\.corrupt/, "the sidecar is not a queue and is not listed as one");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// T2 — BYTES, NOT A STRING. `buf.toString("utf8")` maps an incomplete trailing multibyte
// sequence to U+FFFD, which re-encodes as EF BF BD — three bytes that are not the byte that
// was there. Quarantining the decoded string therefore records something the ledger never
// held, on exactly the fixture (a process killed mid-append) the whole feature is for.
// ---------------------------------------------------------------------------
test("BLZ-531: a line truncated mid-multibyte-character is quarantined byte-for-byte", () => {
  const root = board();
  try {
    // A valid JSON prefix, then the FIRST TWO bytes of a three-byte UTF-8 character.
    const middle = Buffer.concat([Buffer.from('{"id":"ZZZ-2","message":"caf', "utf8"), Buffer.from([0xe2, 0x82])]);
    const truncated = threeOpsWithTruncatedMiddleLine(root, SESSION, middle);
    assert.notEqual(truncated.toString("utf8"), truncated.toString("binary"),
      "the fixture must actually be un-round-trippable through a JS string");

    const r = runCommit(root);
    assert.equal(r.status, 0, `the parseable ops must still flush: ${r.stderr}`);

    const recovered = recoverQuarantined(quarantinePath(root, SESSION));
    assert.deepEqual(recovered, [truncated],
      "the incomplete character must survive as the byte it was, not as U+FFFD's three bytes");
    assert.notEqual(recovered[0].at(-1), 0xbd,
      "EF BF BD at the end is the replacement character — the evidence was rewritten, not kept");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// T3 — (a) A QUARANTINE FAILURE AFTER A SUCCESSFUL `git commit` MUST NOT LEAK THE LOCK.
//
// Injected, not reasoned about: a DIRECTORY at the sidecar path makes the append fail EISDIR
// at open(2), which is the shape an operator's stray `mkdir` or a botched restore leaves.
// The lock is taken before `git add` and released after the drain loop, so a throw between
// them walks straight out of the process with `.blaze/commit.lock/` still on disk.
//
// The observable consequence, and so the assertion, is the NEXT FLUSH: `acquireLock` would
// eventually steal the orphaned lock because its owner pid is dead, so "the next run
// works" alone does not discriminate. "The next run works AND never had to steal anything"
// does.
// ---------------------------------------------------------------------------
test("BLZ-531: a quarantine failure after a successful git commit does not leak commit.lock", () => {
  const root = board();
  try {
    threeOpsWithTruncatedMiddleLine(root);
    const sidecar = quarantinePath(root, SESSION);
    mkdirSync(sidecar, { recursive: true }); // EISDIR on the append

    const before = headCount(root);
    const r = runCommit(root);

    assert.equal(headCount(root), before + 1, "the commit itself succeeded — that is the premise");
    assert.notEqual(r.status, 0, `a run that could not preserve a record must not report success: ${r.stdout}`);
    assert.equal(existsSync(lockPath(root)), false,
      "git commit returned 0 and the quarantine then failed — the lock must still have been released");

    // FAIL CLOSED. What the run could not preserve elsewhere, it must not clear from here.
    assert.ok(existsSync(ledgerPath(root, SESSION)),
      "a queue whose unparseable line could not be quarantined must be KEPT, not cleared");
    const kept = readFileSync(ledgerPath(root, SESSION));
    assert.ok(kept.includes(Buffer.from('"ZZZ-2"', "utf8")),
      "and the bad line specifically must still be in it");
    assert.doesNotMatch(r.stderr, /^\s+at /m,
      "a failure AFTER a successful commit must reach the operator as a `blaze:` sentence, not a"
      + " raw stack trace — the commit already landed, so what state the board is in is the"
      + " whole of what they need to be told (the same contract BLZ-518a and 518b pin on --status)");
    assert.ok(r.stderr.includes(sidecar), `and it must name the path it could not write: ${r.stderr}`);

    // THE PROOF THAT THE LOCK DID NOT LEAK: the next flush runs, and steals nothing.
    rmSync(sidecar, { recursive: true, force: true });
    const next = runCommit(root);
    assert.doesNotMatch(next.stderr, /stealing stale commit\.lock/,
      "a leaked lock would be STOLEN by the next run rather than simply absent");
    assert.equal(existsSync(ledgerPath(root, SESSION)), false,
      `the next flush must actually drain the queue this time: ${next.stderr}`);
    assert.deepEqual(recoverQuarantined(sidecar).map((b) => b.toString("utf8")).length, 1,
      "and the record it could not save last time is saved now");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// T4 — (d) ADR-0031 ON THE SIDECAR WRITE PATH. `appendFileSync` OPENS the path, and opening
// a FIFO with no reader blocks in open(2) forever: no error, no timeout, no exit. The
// sidecar sits inside `.blaze/pending/`, the one directory BLZ-556 puts behind every
// worktree of the repo and the unattended flush CronJob, so a FIFO there wedges all of them
// — and it is reached AFTER `git commit` has already returned 0, with both locks held. A
// flush that never returns there is a CronJob that never finishes holding the store lock.
//
// WHICH HALF OF ADR-0031 ACTUALLY FIRES HERE, measured rather than assumed. It is the
// `O_NONBLOCK` on the open, not the `isFile()` refusal: `O_WRONLY | O_NONBLOCK` on a FIFO
// with no reader fails ENXIO before `fstatSync` is ever reached, so the message names the
// path and the errno rather than "a FIFO (a named pipe)". That is the same asymmetry
// `appendRegularFileSync`'s own docstring records for its one previous caller — the read
// side keeps its descriptor and can name the type; the write side never gets one. The
// property under test is therefore "it returned at all, and refused", which is exactly what
// distinguishes the guarded primitive from a bare `appendFileSync`.
//
// Bounded by a spawn `timeout` rather than by `node:test`'s: a synchronous open that blocks
// cannot be rescued by a timer living on an event loop it never yields to, so a regression
// must redden this in seconds instead of hanging the suite the way the bug hangs the board.
// ---------------------------------------------------------------------------
test("BLZ-531: a FIFO at the sidecar path is refused immediately, never blocked on", () => {
  const root = board();
  const sidecar = quarantinePath(root, SESSION);
  try {
    threeOpsWithTruncatedMiddleLine(root);
    execFileSync("mkfifo", [sidecar]);

    const r = runCommit(root, { timeout: 20_000 });
    assert.notEqual(r.signal, "SIGTERM",
      "the flush HUNG on a FIFO at the sidecar path instead of refusing it — ADR-0031");
    assert.notEqual(r.status, 0, "and a run that could not park a record must not report success");
    assert.ok(`${r.stdout}${r.stderr}`.includes(sidecar),
      `and it must name the path it could not write: ${r.stdout}${r.stderr}`);
    assert.equal(existsSync(lockPath(root)), false, "and it must not leak the lock on the way out");
    assert.ok(existsSync(ledgerPath(root, SESSION)), "and it must keep what it could not park");
  } finally {
    try { rmSync(sidecar, { force: true }); } catch { /* gone */ }
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T5 — THE `finally` COVERS THE WHOLE LOOP, NOT JUST THE QUARANTINE. T3's failure is caught
// by the per-queue `catch`, so it never reaches the outer `finally` at all — which means T3
// alone would leave that `finally` looking load-bearing while pinning only the `catch`.
//
// `clearLedger` can throw on the same post-commit, lock-held path and with nothing to catch
// it: its `readRegularFileSync` refuses a non-regular file, and its `rmSync` — the BLZ-498
// branch that removes an emptied queue rather than truncating it — raises EACCES on a
// read-only `.blaze/pending/`, which is what this injects. `force: true` swallows ENOENT,
// not that.
//
// So the property is the one the ticket states without the quarantine's help: once
// `git commit` has returned 0, NOTHING that happens afterwards may leave `commit.lock`
// behind. The store lock is the one BLZ-556 put behind every worktree of the repo and the
// unattended flush CronJob, so leaking it is not a local inconvenience.
// ---------------------------------------------------------------------------
test("BLZ-531: a failure in the post-commit loop releases the lock even when it is the CLEAR that fails, not the quarantine", (t) => {
  const root = board();
  const dir = join(root, ".blaze", "pending");
  try {
    queueOutstanding(root, "ZZZ-1"); // no bad line: the quarantine is not involved at all
    const before = headCount(root);

    chmodSync(dir, 0o555); // read-only: the queue reads fine, the unlink after it cannot
    try { rmSync(join(dir, "probe"), { force: true }); writeFileSync(join(dir, "probe"), "x"); rmSync(join(dir, "probe")); chmodSync(dir, 0o755); t.skip("running as root"); return; } catch { /* genuinely read-only */ }

    const r = runCommit(root);
    assert.equal(headCount(root), before + 1, "the commit itself succeeded — that is the premise");
    assert.equal(existsSync(lockPath(root)), false,
      "git commit returned 0 and the clear then threw — the lock must still have been released");
  } finally {
    try { chmodSync(dir, 0o755); } catch { /* gone */ }
    rmSync(root, { recursive: true, force: true });
  }
});
