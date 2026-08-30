// tests/commit-step-attribution.test.mjs — BLZ-502: the failing git step is CARRIED, not guessed.
//
// `reconcile-commit-report.mjs:38` labelled EVERY commit-path failure `git commit failed
// (exit status N)`. But `serve-commit.mjs` returns on a non-zero `git add` first, and its
// return discarded WHICH step failed — so by the time the sentence was composed the
// distinction was gone. The consequence is a misdirected diagnosis, not a silence: the run
// is loud and exits 1 (verified against `blaze` 1b00f3a: `reconcile: FAILED TO COMMIT — git
// commit failed (exit status 128)`), but an operator reading "git commit failed" goes
// looking at pre-commit hooks or a detached HEAD when the real cause was a pathspec `git
// add` refused.
//
// SCOPE NOTE. The step is carried on `commitFile`'s return and read by `commitOutcomeFrom`,
// which is where the sentence is composed. It is deliberately NOT threaded as a new
// `applySummary({ step })` parameter: the only caller that would supply it is
// `scripts/reconcile.mjs:2478`, which belongs to another lane, and a parameter no reachable
// call path ever sets is an unpinnable branch pretending to be a fix. Instead the remedial
// advice in the `failed` arm is made TRUE FOR BOTH STEPS and defers to the step named in
// `error` — every line of which is reachable from the live CLI today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { commitFile } from "../scripts/serve-commit.mjs";
import { commitOutcomeFrom, applySummary } from "../scripts/reconcile-commit-report.mjs";

/** A real git repo. The mkdtempSync prefix is a LITERAL at the call site (BLZ-491) so
 *  `tests/tmp-scratch-attribution.test.mjs`'s static scan can attribute any leak here. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-stepattr-"));
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "seed"), "seed");
  execFileSync("git", ["-C", root, "add", "seed"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

// Pins: serve-commit.mjs's `step: "add"` on the non-zero-add return, and
// reconcile-commit-report.mjs's use of it. The fixture is the ticket's own case — a
// pathspec `git add` refuses, exit 128 — driven through the REAL commitFile, not a stub,
// so the field is proven to survive the function that was discarding it.
test("BLZ-502: a failed `git add` is reported as `git add failed`, not `git commit failed`", () => {
  const root = repo();
  try {
    const c = commitFile(root, "no-such-file.md", "ZZZ-1: a message");
    assert.equal(c.ok, false);
    assert.equal(c.committed, false);
    assert.equal(c.step, "add", "commitFile must CARRY the step that failed, not leave it to be guessed");
    const { outcome, error } = commitOutcomeFrom(c);
    assert.equal(outcome, "failed");
    assert.match(error, /^git add failed \(exit status \d+\)$/,
      "the sentence must name the step that actually refused");
    assert.doesNotMatch(error, /git commit failed/,
      "this is the misdirection the ticket is about — it sends the operator to look at hooks");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The other spelling of the same property — the case that would pass BY ACCIDENT if the
// fix simply relabelled every failure "git add failed". Pins: serve-commit.mjs's
// `step: "commit"` on the commit-refused return.
test("BLZ-502: a failed `git commit` is still reported as `git commit failed`", () => {
  const root = repo();
  try {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    const hook = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    writeFileSync(join(root, "ZZZ-1.md"), "content\n");
    const c = commitFile(root, "ZZZ-1.md", "ZZZ-1: a message");
    assert.equal(c.ok, false, "a refusing pre-commit hook is a real failure, not the benign no-op");
    assert.equal(c.step, "commit");
    const { error } = commitOutcomeFrom(c);
    assert.match(error, /^git commit failed \(exit status \d+\)$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Pins: applySummary's `failed`-arm remediation. Naming the step in `error` is worth
// nothing if the sentence underneath it still tells the operator to go and read hooks.
// BLZ-404 round 2 already made this arm stop borrowing the LOCK's advice for the same
// reason; this is the same defect one level down.
test("BLZ-502: the `failed` advice is true for an add failure — it does not send the operator to hooks alone", () => {
  const add = applySummary({ outcome: "failed", error: "git add failed (exit status 128)", movedCount: 2, nonMovedCount: 1 });
  assert.equal(add.stream, "err");
  assert.equal(add.exit, 1);
  assert.match(add.text, /git add failed \(exit status 128\)/, "the step must reach the operator's terminal");
  assert.match(add.text, /pathspec/i,
    "an add failure's most common cause is a pathspec that matched nothing — the advice must say so");
  // The BLZ-481 quantities stay on this arm: the one outcome where the tree must be
  // inspected by hand is the one that must say how much of it to inspect.
  assert.match(add.text, /2 ticket\(s\) moved/);
  assert.match(add.text, /1 ticket\(s\) updated without a status change/);

  const commit = applySummary({ outcome: "failed", error: "git commit failed (exit status 1)", movedCount: 1, nonMovedCount: 0 });
  assert.match(commit.text, /pre-commit hook/,
    "and a commit failure's own diagnosis must not be lost while making room for add's");
  assert.match(commit.text, /No lock is involved/,
    "BLZ-404 round 2's correction must survive: this arm carries no lock");
});
