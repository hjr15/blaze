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

  test("the loop publishes ONE error across many ticks under BLAZE_READONLY", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blz425-ro-"));
    const prev = process.env.BLAZE_READONLY;
    try {
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
});

// The CSRF import is what the sibling supervisor tests use to reach /control/*; kept here
// so this file's `createApp` usage matches theirs even though it drives runReconcile
// directly (the timer and /control/reconcile/run both call it with no arguments).
assert.equal(typeof CSRF, "string");
