// tests/commit-status-provenance.test.mjs — BLZ-597: `blaze commit --status` must not reach
// a verdict about an op belonging to another checkout.
//
// THE DEFECT, reproduced by an actual run at 13f661c (this file's own red run). The
// `--status` read path had no provenance partition AT ALL. A queue of ops recording
// `worktree: "lane-q"`, read from the main working tree, exited 0 and printed
//
//     orphaned:    1 file(s) already match HEAD — filed by something else
//     superseded:  1 file(s) relocated again within a batch
//
// Both verdicts were measured against the WRONG CHECKOUT. `outstandingFiles` asked this
// tree's `existsSync`, this tree's index and this tree's HEAD about paths whose files live in
// a lane — and a tracked board file exists in every checkout, so the answers are confidently
// wrong rather than blank. This is the same lying sentence BLZ-590's round 3 removed from the
// DRAIN path, still live in the read path: the drain was partitioned at its partition loop
// and `--status` was left out of scope.
//
// Operator consequence, and why this is a high: someone reading "0 outstanding" hand-cleans a
// queue that is full of live foreign work.
//
// THE PROPERTY. `--status` partitions by provenance exactly as the drain does — the same two
// legs, `belongsHere` then `queuedHere`, in the same order — and an op this checkout may not
// judge is reported as UNREACHABLE rather than measured into a bucket. What it must NOT do is
// go silent: the ops are still counted, still named, and the reason is the field that
// actually refused them.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { appendEntry } from "../scripts/pending-ledger.mjs";

const REPO = join(import.meta.dirname, "..");
const SESSION = "s1";
const cleanup = (...p) => { for (const x of p) rmSync(x, { recursive: true, force: true }); };

function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-statusprov-"));
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

function status(root) {
  const env = { ...process.env, BLAZE_SESSION: SESSION };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [join(root, "scripts", "commit-runner.mjs"), "--status"],
    { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status };
}

const op = (id, extra = {}) => ({
  id, op: "new", message: `${id}: create task`,
  files: [`projects/ZZZ/defined/${id}.md`], ts: "2026-09-01T00:00:00.000Z", ...extra,
});

/** A file that is committed and clean here — which is what makes this tree answer "settled"
 *  (rendered as `orphaned`) about it, whoever actually queued it. */
function committedHere(root, id) {
  const rel = `projects/ZZZ/defined/${id}.md`;
  writeFileSync(join(root, rel), `${id} body\n`);
  execFileSync("git", ["-C", root, "add", "--", rel]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", `filed ${id}`]);
  return rel;
}

describe("BLZ-597: --status partitions by provenance before it reaches any verdict", () => {
  test("a foreign-only queue yields NO orphaned/superseded counts derived from this tree", () => {
    const root = board();
    try {
      // The ticket's exact fixture: ops recording `worktree: "lane-q"`, read from the main
      // working tree. ZZZ-1's file is committed and clean HERE (this tree would call it
      // settled -> `orphaned`); ZZZ-2's path is in none of this tree's three trees (this tree
      // would call it absent -> `superseded`). Both answers are about the wrong checkout.
      committedHere(root, "ZZZ-1");
      appendEntry(root, op("ZZZ-1", { worktree: "lane-q" }), SESSION);
      appendEntry(root, op("ZZZ-2", { worktree: "lane-q" }), SESSION);

      const r = status(root);
      assert.equal(r.code, 0, `--status must still report: ${r.out}${r.err}`);

      // Both ops are still COUNTED and NAMED — the fix is a partition, not a silence.
      assert.match(r.out, /2 op\(s\)/, "the ops are still reported as queued");
      assert.match(r.out, /lane-q/,
        "and the report names the checkout they belong to, so the operator can go and flush it");

      // …and neither is measured against this tree.
      assert.doesNotMatch(r.out, /orphaned: +[1-9]/,
        "an `orphaned` verdict here is this tree answering about a lane's files");
      assert.doesNotMatch(r.out, /superseded: +[1-9]/,
        "and so is a `superseded` one — BLZ-590's round 3 removed exactly this sentence "
        + "from the drain path");
      assert.doesNotMatch(r.out, /outstanding: +[1-9]/,
        "the third bucket is measured the same way and is wrong for the same reason");
    } finally { cleanup(root); }
  });

  test("an op queued HERE is still judged and still bucketed — the partition is not a mute", () => {
    const root = board();
    try {
      committedHere(root, "ZZZ-1");
      appendEntry(root, op("ZZZ-1"), SESSION);       // no provenance: the store's own tree claims it
      writeFileSync(join(root, "projects", "ZZZ", "defined", "ZZZ-3.md"), "outstanding\n");
      appendEntry(root, op("ZZZ-3", { worktree: "" }), SESSION); // explicitly the main tree

      const r = status(root);
      assert.equal(r.code, 0, `${r.out}${r.err}`);
      assert.match(r.out, /orphaned: +1 file\(s\)/,
        "a settled op this checkout MAY judge must still be reported as orphaned");
      assert.match(r.out, /outstanding: +1 file\(s\)/,
        "and real outstanding work must still be reported as outstanding");
      assert.doesNotMatch(r.out, /cannot judge/,
        "nothing here is unreachable, so nothing is reported as unreachable");
    } finally { cleanup(root); }
  });

  // The reason is named by the FIELD THAT REFUSED, and `belongsHere` has two legs. Spelling
  // the branch leg over both is not a cosmetic slip: it printed `queued on branch
  // 'undefined', which undefined currently has checked out` about a worktree-recorded op —
  // a sentence naming a field the record does not have, which is the failure mode
  // `notOursBecause`'s three legs exist to prevent. Asserted as a property over every
  // provenance shape rather than as one expected string.
  test("the reason names the field that refused, and never a field the record does not carry", () => {
    const root = board();
    try {
      appendEntry(root, op("ZZZ-1", { worktree: "lane-q" }), SESSION);           // worktree leg
      appendEntry(root, op("ZZZ-2", { branch: "some-other-branch" }), SESSION);  // branch leg
      const r = status(root);
      assert.equal(r.code, 0, `${r.out}${r.err}`);
      assert.doesNotMatch(r.out, /undefined|\bnull\b/,
        `the report named a field the record does not carry:\n${r.out}`);
      assert.match(r.out, /queued in working tree 'lane-q'/);
      assert.match(r.out, /queued on branch 'some-other-branch'/);
    } finally { cleanup(root); }
  });

  test("a mixed queue buckets only its own ops and reports the rest as unreachable", () => {
    const root = board();
    try {
      committedHere(root, "ZZZ-1");                   // settled HERE, and ours
      appendEntry(root, op("ZZZ-1"), SESSION);
      committedHere(root, "ZZZ-9");                   // settled HERE, and NOT ours
      appendEntry(root, op("ZZZ-9", { worktree: "lane-q" }), SESSION);

      const r = status(root);
      assert.equal(r.code, 0, `${r.out}${r.err}`);
      assert.match(r.out, /orphaned: +1 file\(s\)/,
        "exactly ONE orphan — the foreign op must not be added to this tree's count");
      assert.match(r.out, /1 op\(s\) .*cannot judge|cannot judge.*1 op\(s\)/s,
        "and the foreign op is reported as unreachable rather than dropped from the report");
      assert.match(r.out, /2 op\(s\)/, "the queue still holds two ops and still says so");
      assert.match(r.out, /1 op\(s\) belong to another checkout/,
        "and the TOTALS say it too — the totals are what an operator reads to decide the "
        + "board is clear, and a per-queue note under a clean-looking total is not enough");
    } finally { cleanup(root); }
  });

  // THE OTHER LEG. `belongsHere` refuses an op whose recorded BRANCH some other worktree
  // currently has checked out, and it is the leg that can name WHICH checkout — the thing an
  // operator needs in order to go and flush it. Driven with a real second worktree, because
  // the whole point is a branch git actually reports as held elsewhere; without one the leg
  // is unreachable and this file's other fixtures are all refused by `queuedHere` instead.
  // BOTH FIELDS, and the precedence between them. `belongsHere` decides on `worktree` FIRST
  // and consults the branch owner only when no worktree is recorded. Looking the branch up
  // before asking which leg refused sent an op recording `{worktree:"lane-q", branch:"bx"}`
  // to lane-b — the checkout holding `bx` — where the drain refuses it as foreign on the
  // worktree mismatch, and folded it into lane-b's count where it hid. The drain over the
  // identical queue says `queued in lane-q (branch 'bx')`. Refuted at review; 13 of the 32
  // live ops measured on 2026-09-09 recorded both fields, so this was the common shape.
  test("an op recording BOTH worktree and an owned branch is named by its WORKTREE, as the drain names it", () => {
    const root = board();
    const wt = join(root, "..", `blaze-statusprov-both-${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      execFileSync("git", ["-C", root, "worktree", "add", "-q", "-b", "bx", wt]);
      appendEntry(root, op("ZZZ-5", { worktree: "lane-q", branch: "bx" }), SESSION); // refused on worktree
      appendEntry(root, op("ZZZ-6", { worktree: "lane-q" }), SESSION);               // refused on worktree
      appendEntry(root, op("ZZZ-7", { branch: "bx" }), SESSION);                     // refused on branch

      const r = status(root);
      assert.equal(r.code, 0, `${r.out}${r.err}`);
      assert.match(r.out, /2 op\(s\) were queued in working tree 'lane-q'/,
        `both worktree-recorded ops belong to lane-q whatever branch they also record:\n${r.out}`);
      assert.match(r.out, /1 op\(s\) were queued on branch 'bx', which .+ currently has checked out/,
        `only the op with NO worktree is refused by the branch leg:\n${r.out}`);
    } finally {
      execFileSync("git", ["-C", root, "worktree", "remove", "--force", wt], { stdio: "ignore" });
      cleanup(root, wt);
    }
  });

  test("an op whose branch another WORKTREE holds is named by that worktree, not merely as 'not ours'", () => {
    const root = board();
    const wt = join(root, "..", `blaze-statusprov-lane-${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      execFileSync("git", ["-C", root, "worktree", "add", "-q", "-b", "lane-b", wt]);
      appendEntry(root, op("ZZZ-4", { branch: "lane-b" }), SESSION);

      const r = status(root);
      assert.equal(r.code, 0, `${r.out}${r.err}`);
      assert.match(r.out, /queued on branch 'lane-b', which .+ currently has checked out/,
        `the report must name the checkout that holds the branch:\n${r.out}`);
      assert.doesNotMatch(r.out, /orphaned: +[1-9]|superseded: +[1-9]/,
        "and it must still reach no verdict about that checkout's files");
    } finally {
      execFileSync("git", ["-C", root, "worktree", "remove", "--force", wt], { stdio: "ignore" });
      cleanup(root, wt);
    }
  });
});
