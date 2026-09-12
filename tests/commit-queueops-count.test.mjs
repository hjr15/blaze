// tests/commit-queueops-count.test.mjs — BLZ-558: the op count `blaze commit --all` reports
// must cover every queue `--all` actually drains, the legacy shared fallback included.
//
// THE DEFECT. The nightly flush Job's `queueops=` counter is derived from `.blaze/pending/`
// alone, while `blaze commit --all` — the verb that Job runs — ALSO drains the legacy shared
// fallback ledger `.blaze/pending-commit.jsonl`: `listQueues()` reads it alongside the
// per-session queues (pending-ledger.mjs's `listQueuesResult` pushes it FIRST). So an op
// appended with no session id is swept by the same `--all` run and renders as ABSENT from
// the count — the Job can read `queueops=0` over a run that just committed work. PR #110
// narrowed the documented claim rather than widening the count; ADR-0033 records the gap
// explicitly as "filed separately and neither fixed nor widened here".
//
// WHY THE COUNT MOVES INTO BLAZE. The counter that undercounts is in the Job, not in this
// repo — and it undercounts because it re-derives, by globbing one directory, a fact the
// engine already knows exactly. Any consumer re-deriving it will get the same answer wrong
// the same way. So `blaze commit` states the count itself, over the queues THIS RUN read,
// and the Job reads it back instead of globbing. That is the AC's "or its replacement": the
// count is closed at the only place that can compute it correctly.
//
// ADR-0030 applies to a count as much as to a report: a run that could not read part of the
// board must not fold that into a number that looks complete. `queueops=` therefore covers
// only queues actually read, and says so when it does not cover everything.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { appendEntry, ledgerPath, listQueues } from "../scripts/pending-ledger.mjs";

const REPO = join(import.meta.dirname, "..");
const cleanup = (...p) => { for (const x of p) rmSync(x, { recursive: true, force: true }); };

function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-queueops-"));
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

function run(root, args = []) {
  const env = { ...process.env, BLAZE_SESSION: "flusher" };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [join(root, "scripts", "commit-runner.mjs"), ...args],
    { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status };
}

/** The number `blaze commit` states, read the way a flush Job would read it. Returns null
 *  when the line is absent — which the tests then FAIL on, rather than treating a missing
 *  measurement as a zero. */
function queueops(text) {
  const m = /(?:^|\s)queueops=(\d+)(?:\s|$)/m.exec(text);
  return m ? Number(m[1]) : null;
}

/** An op whose work is genuinely outstanding, queued into `session` — `null` is the LEGACY
 *  SHARED FALLBACK ledger, which is the whole point of this file. */
function queue(root, id, session) {
  const rel = `projects/ZZZ/defined/${id}.md`;
  writeFileSync(join(root, rel), `${id} body\n`);
  appendEntry(root, { id, op: "new", message: `${id}: create task`, files: [rel], ts: "t" }, session);
  return rel;
}

describe("BLZ-558: the reported op count covers every queue --all drains", () => {
  test("an op in the LEGACY SHARED FALLBACK ledger, with no session id, is counted", () => {
    const root = board();
    try {
      queue(root, "ZZZ-1", null);
      // The AC's fixture, asserted as a fact about the filesystem and not assumed: the op
      // really is in `.blaze/pending-commit.jsonl` and in no per-session queue.
      assert.ok(existsSync(ledgerPath(root, null)), "the fallback ledger is where the op landed");
      assert.ok(!existsSync(join(root, ".blaze", "pending")),
        "and there is no per-session queue at all — the count has nothing else to see");

      const r = run(root, ["--all"]);
      assert.equal(r.code, 0, `${r.out}${r.err}`);
      assert.equal(queueops(r.out), 1,
        `--all drained the fallback and must count it:\n${r.out}${r.err}`);
      assert.match(r.out, /queueops=1 .*fallback ledger included/,
        "and must say the fallback was among the queues it read — that is the whole point");
      // And it really was drained — a count over ops nobody flushed would be a different bug.
      assert.match(r.out, /flushed 1 op/);
    } finally { cleanup(root); }
  });

  test("the count is the sum over listQueues(), fallback and per-session queues alike", () => {
    const root = board();
    try {
      queue(root, "ZZZ-1", null);       // fallback
      queue(root, "ZZZ-2", "s1");       // per-session
      queue(root, "ZZZ-3", "s2");       // another session
      // The ticket's own statement of the mechanism, checked rather than trusted: the
      // fallback is one of the queues `listQueues` enumerates, so a count taken over
      // `.blaze/pending/` alone is short by exactly the fallback's ops.
      assert.deepEqual(listQueues(root).map((q) => q.session), [null, "s1", "s2"]);

      const r = run(root, ["--all"]);
      assert.equal(r.code, 0, `${r.out}${r.err}`);
      assert.equal(queueops(r.out), 3, `${r.out}${r.err}`);
      assert.match(r.out, /flushed 3 op/);
    } finally { cleanup(root); }
  });

  test("a run with nothing queued states queueops=0 rather than omitting the line", () => {
    const root = board();
    try {
      const r = run(root, ["--all"]);
      assert.equal(r.code, 0, `${r.out}${r.err}`);
      assert.equal(queueops(r.out), 0,
        "an absent measurement and a measured zero are different facts, and a consumer that "
        + "cannot tell them apart reads a run that could not look as a clean board");
    } finally { cleanup(root); }
  });

  // A queue this run READ and could not parse a single line of. It is dropped from the drain
  // before the count was taken — `.filter((q) => q.entries.length > 0)` — so two garbage
  // lines plus one good queue printed `queueops=1 across 1 queue(s) read` at exit 0, a short
  // count indistinguishable from a clean board. Quarantining it is BLZ-532/610's scope; what
  // is pinned here is only that the count does not claim to cover a queue it dropped.
  test("a wholly-unparseable queue is named as NOT covered, never silently left out of the count", () => {
    const root = board();
    try {
      queue(root, "ZZZ-1", "good");
      mkdirSync(join(root, ".blaze", "pending"), { recursive: true });
      writeFileSync(join(root, ".blaze", "pending", "garbage.jsonl"), "not json\n{\"half\n");

      const r = run(root, ["--all"]);
      assert.equal(queueops(r.out), 1, `${r.out}${r.err}`);
      assert.match(r.out, /queueops=1 across 2 queue\(s\) read/,
        `both queues were read, and the count must say so:\n${r.out}`);
      assert.match(r.out, /NOT covering 2 unparseable line\(s\)/,
        `and must name the lines it does not cover:\n${r.out}`);
    } finally { cleanup(root); }
  });

  test("a run that drains only its OWN queue counts only its own queue", () => {
    const root = board();
    try {
      queue(root, "ZZZ-1", null);          // the fallback, which this run does NOT drain
      queue(root, "ZZZ-2", "flusher");     // this run's own queue
      const r = run(root, []);             // no --all
      assert.equal(r.code, 0, `${r.out}${r.err}`);
      assert.equal(queueops(r.out), 1,
        "the count is over the queues THIS RUN read, not over the whole store — a count that "
        + "outran the run would be the same class of overstatement in the other direction");
      // Refuted at review: the line said "(the legacy shared fallback ledger included)" on
      // this exact run, which never read it — while the fallback op sat there unread and
      // unnamed. An absent measurement and a measured zero are different facts, and so are
      // "included" and "not read".
      assert.doesNotMatch(r.out, /queueops=.*fallback ledger included/,
        `this run did not read the fallback and must not say it did:\n${r.out}`);
      assert.match(r.out, /queueops=.*fallback ledger .*NOT read/i,
        `and must say so, so the Job cannot read the number as covering it:\n${r.out}`);
    } finally { cleanup(root); }
  });
});
