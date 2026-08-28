// tests/supervisor-run-error-dedup.test.mjs — BLZ-425.
//
// The reconcile loop's forge errors and findings are deduped (`newForgeErrorEvents`,
// `newFindingEvents`) precisely because "the reconcile loop runs on a timer and an
// unsupported forge is a PERMANENT condition, so republishing every tick would bury the
// feed it warns through". The loop's OWN run failure had no such memory: the
// `else if (r && !r.ok)` arm published one `type: "error"` event per tick, forever.
//
// `BLAZE_READONLY` is the shape that makes this certain rather than theoretical. A direct
// `supervisor` run under it hits reconcile's `assertWritable` guard, which returns
// `{ ok: false, error: "blaze: read-only mode …" }` — a byte-identical message, on a
// condition only an operator can clear. At the shipped `loops.reconcile.intervalSec: 60`
// that is 60 identical error events an hour, 1,440 a day, in the feed that is "the
// operator's whole account of the run".
//
// The rule adopted is not the forge/finding rule. Those `said` sets grow forever, so a
// condition that clears and returns is never re-announced. A RUN failure is different: it
// is the loop's own health, and an operator who fixed it needs to hear about it if it comes
// back. So the memory is the LAST message, cleared by a successful pass — a persistent
// refusal is stated once, and a recurrence after a good pass is stated again.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../scripts/config.mjs";
import { createApp, newRunErrorEvent } from "../scripts/supervisor.mjs";
import { CSRF } from "../scripts/views/page.mjs";

describe("BLZ-425: a persistent reconcile refusal is stated once, not once per tick", () => {
  test("newRunErrorEvent: the same message yields an event once", () => {
    const said = {};
    const first = newRunErrorEvent("blaze: read-only mode (BLAZE_READONLY=1) — refusing to x", said);
    assert.equal(first.type, "error");
    assert.equal(first.loop, "reconcile");
    assert.match(first.message, /read-only mode/);
    for (let tick = 0; tick < 59; tick++) {
      assert.equal(
        newRunErrorEvent("blaze: read-only mode (BLAZE_READONLY=1) — refusing to x", said), null,
        `tick ${tick + 2} republished a refusal that has not changed`);
    }
  });

  test("newRunErrorEvent: a DIFFERENT failure is still announced", () => {
    // Dedup must be on the message, never on "an error has already been seen" — a loop
    // that goes silent about a NEW failure because an old one is still standing is the
    // same class of defect one layer along.
    const said = {};
    assert.ok(newRunErrorEvent("read-only", said));
    const other = newRunErrorEvent("no projects are configured", said);
    assert.ok(other, "a different message is a different condition and must be published");
    assert.equal(other.message, "no projects are configured");
  });

  test("newRunErrorEvent: a recurrence AFTER a healthy pass is announced again", () => {
    const said = {};
    assert.ok(newRunErrorEvent("read-only", said));
    assert.equal(newRunErrorEvent(null, said), null, "a healthy pass publishes nothing itself");
    assert.ok(newRunErrorEvent("read-only", said),
      "…but it clears the memory, so the condition coming back is news again");
  });

  /** A board the reconcile loop can run against. Returned as a teardown-carrying handle so
   *  the two loop tests below build it the same way. */
  function loopBoard(name) {
    const dir = mkdtempSync(join(tmpdir(), name));
    mkdirSync(join(dir, "projects", "TASK", "defined"), { recursive: true });
    writeFileSync(join(dir, "projects", "TASK", "project.json"),
      JSON.stringify({ key: "TASK", codeRepos: [] }));
    writeFileSync(join(dir, "projects", "TASK", "defined", "TASK-1-x.md"),
      "---\nid: TASK-1\ntitle: x\ntype: task\nproject: TASK\n---\nbody\n");
    writeFileSync(join(dir, "blaze.config.json"),
      JSON.stringify({ key: "TASK", projects: ["TASK"] }));
    for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                     ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
      execFileSync("git", ["-C", dir, ...a]);
    }
    return dir;
  }

  test("the loop publishes ONE error across many ticks under BLAZE_READONLY", async () => {
    const dir = loopBoard("blz425-ro-");
    const prev = process.env.BLAZE_READONLY;
    try {
      const cfg = loadConfig({ root: dir, env: {} });
      const app = createApp(cfg, { root: dir });
      const seen = [];
      const off = app.bus.subscribe((e) => seen.push(e));

      process.env.BLAZE_READONLY = "1";
      for (let tick = 0; tick < 5; tick++) await app.runReconcile();
      off();

      const errors = seen.filter((e) => e.type === "error" && e.loop === "reconcile");
      assert.equal(errors.length, 1,
        `five ticks under BLAZE_READONLY published ${errors.length} error events: ` +
        JSON.stringify(errors.map((e) => e.message)));
      assert.match(errors[0].message, /read-only mode \(BLAZE_READONLY=1\)/);
    } finally {
      if (prev === undefined) delete process.env.BLAZE_READONLY;
      else process.env.BLAZE_READONLY = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // BLZ-476. THE CALL SITE, not the pure function.
  //
  // `newRunErrorEvent(null, said)` clearing the memory is pinned above, by direct call. What
  // was pinned by NOTHING is the line in `createApp`'s `runReconcile` that MAKES that call on
  // a healthy pass — `if (r && r.ok) newRunErrorEvent(null, runErrorSaid);`. Review deleted it
  // and the supervisor suite stayed 57/57 green, while the behaviour it protects genuinely
  // broke: an operator who fixes a condition and then re-breaks it is never told a second
  // time, because the memory still holds the first message.
  //
  // A SINGLE TICK CANNOT SEE THAT, which is why this drives the whole sequence. Ticks 1 and 2
  // (broken) and tick 3 (healthy) publish identically with the line and without it; the two
  // runs diverge only at tick 4. Cumulative counts, asserted at every step:
  //
  //     tick        1 break   2 still broken   3 healthy   4 re-break
  //     with    →      1            1              1           2
  //     without →      1            1              1           1
  //
  // The break is `BLAZE_READONLY=1`: reconcile's `assertWritable` returns a byte-identical
  // `{ ok: false, error }` every time, so a differing message can never be what re-announces
  // it. The fix is unsetting the variable — a healthy pass, `r.ok === true`, which is the one
  // input the deleted line reads.
  test("BLZ-476: a condition FIXED and then RE-BROKEN is announced a second time", async () => {
    const dir = loopBoard("blz476-rebreak-");
    const prev = process.env.BLAZE_READONLY;
    try {
      const app = createApp(loadConfig({ root: dir, env: {} }), { root: dir });
      const seen = [];
      const off = app.bus.subscribe((e) => seen.push(e));
      const errors = () => seen.filter((e) => e.type === "error" && e.loop === "reconcile");

      const setBroken = (broken) => {
        if (broken) process.env.BLAZE_READONLY = "1";
        else delete process.env.BLAZE_READONLY;
      };

      const SEQUENCE = [
        { broken: true,  cumulative: 1, why: "the first failing tick announces the condition" },
        { broken: true,  cumulative: 1, why: "a persistent condition is stated once, not once per tick" },
        { broken: false, cumulative: 1, why: "a healthy pass publishes no error of its own" },
        { broken: true,  cumulative: 2, why: "…but it CLEARED the memory, so the condition coming " +
          "back is news again — this is the tick the healthy-pass clear exists for, and the only " +
          "one that can tell whether the line is there" },
      ];
      for (const [i, step] of SEQUENCE.entries()) {
        setBroken(step.broken);
        await app.runReconcile();
        assert.equal(errors().length, step.cumulative,
          `after tick ${i + 1} (${step.broken ? "broken" : "healthy"}): expected ${step.cumulative} ` +
          `cumulative error event(s), got ${errors().length} — ${step.why}. Events so far: ` +
          JSON.stringify(errors().map((e) => e.message)));
      }
      off();

      // Both announcements are the SAME condition, so nothing but the healthy-pass clear can
      // account for the second one: a dedup keyed on the message would have suppressed it.
      const messages = errors().map((e) => e.message);
      assert.equal(messages.length, 2, JSON.stringify(messages));
      assert.equal(messages[0], messages[1],
        "the re-announcement must be the SAME message — if it differs, this test is passing " +
        "on the new-message rule instead of on the healthy-pass clear");
      assert.match(messages[0], /read-only mode \(BLAZE_READONLY=1\)/);
    } finally {
      if (prev === undefined) delete process.env.BLAZE_READONLY;
      else process.env.BLAZE_READONLY = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The CSRF import is what the sibling supervisor tests use to reach /control/*; kept here
// so this file's `createApp` usage matches theirs even though it drives runReconcile
// directly (the timer and /control/reconcile/run both call it with no arguments).
assert.equal(typeof CSRF, "string");
