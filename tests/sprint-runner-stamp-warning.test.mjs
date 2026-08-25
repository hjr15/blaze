// tests/sprint-runner-stamp-warning.test.mjs — BLZ-369.
//
// A SUBPROCESS test, because `scripts/*-runner.mjs` is c8-excluded and the unit tests reach the
// warning function but not its DELIVERY. Three mutations survived the whole suite without this:
// deleting both `warnIfUnstamped` calls, switching `console.error` to `console.log`, and warning
// unconditionally.
//
// The `console.log` one has teeth. stdout is a machine-parsed channel here —
// `tests/runner-flag-guard.test.mjs` does `created.stdout.match(/created (\S+)/)` — so a warning
// leaking into it would break a parser with nothing red anywhere.
//
// WHAT THESE DO NOT KILL, stated because an earlier version of this header claimed otherwise.
// Moving `warnIfUnstamped(before)` below `saveSprints` is an EQUIVALENT MUTANT: it is fed the
// pre-write registry, so its output is identical wherever the call sits, and no test can or
// should distinguish it. The regression that actually matters is re-reading the registry after
// the write — `warnIfUnstamped(loadSprints(...))` — which is silent, because by then the file is
// stamped. That one IS killed, by the tests below asserting the warning fires AND the file ends
// up stamped in the same run.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../scripts/sprint-runner.mjs", import.meta.url));
const SPRINTS = [{ id: "S1", name: "one", start: "2026-08-01", end: "2026-08-14" },
                 { id: "S2", name: "two", start: "2026-08-15", end: "2026-08-28" }];

/** A board whose sprints.json is exactly `registry`. */
function board(registry) {
  const root = mkdtempSync(join(tmpdir(), "blz369r-"));
  mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "ENG", projects: ["ENG"], commitMode: "per-op" }));
  writeFileSync(join(root, "sprints.json"), JSON.stringify(registry, null, 2) + "\n");
  // A real git repo: `commitOrQueue` runs on the write path, and without one the runner exits 1
  // with "commit failed (status 128)" — which would make every assertion below pass vacuously.
  const git = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "init");
  return root;
}
const run = (root, ...args) => spawnSync(process.execPath, [runner, ...args],
  { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });
const onDisk = (root) => JSON.parse(readFileSync(join(root, "sprints.json"), "utf8"));

describe("BLZ-369: the stamp warning reaches the operator, on stderr", () => {
  for (const args of [["active", "S2"],
                      ["new", "three", "--start", "2026-08-29", "--end", "2026-09-11"]]) {
    test(`\`blaze sprint ${args[0]}\` warns on an unstamped registry`, () => {
      const root = board({ active: "S1", activeByProject: { OBA: "S5" }, sprints: SPRINTS });
      try {
        const r = run(root, ...args);
        assert.equal(r.status, 0,
          `the command failed, so every assertion below would pass vacuously:\n${r.stderr}`);
        assert.match(r.stderr ?? "", /version stamp/,
          `the warning never reached stderr:\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        // STDOUT stays machine-parseable. This is the assertion that kills console.log.
        assert.doesNotMatch(r.stdout ?? "", /version stamp/,
          "the warning leaked into stdout, which other tests parse for ids");
        // And the write still happened, with the unknown key intact.
        assert.deepEqual(onDisk(root).activeByProject, { OBA: "S5" });
        assert.equal(onDisk(root).registryVersion, 1);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test("a stamped registry produces no warning at all", () => {
    // Without this control, a warning that fired unconditionally would satisfy every assertion
    // above.
    const root = board({ active: "S1", sprints: SPRINTS, registryVersion: 1 });
    try {
      const r = run(root, "active", "S2");
      assert.equal(r.status, 0, `the command failed, so the assertion below is vacuous:\n${r.stderr}`);
      assert.doesNotMatch(r.stderr ?? "", /version stamp/,
        `a correctly stamped registry warned:\n${r.stderr}`);
      assert.equal(onDisk(root).active, "S2", "the command did not do its job");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the warning describes the PRE-write registry, not the file it leaves behind", () => {
    // The discriminator for the regression that matters. After the run the file IS stamped, so a
    // warning derived from the post-write registry would be silent. Seeing the warning and a
    // stamped file in the same run is what proves it read the state that was there before.
    //
    // It does NOT prove the call sits above `saveSprints` in the source, and does not try to —
    // that is an equivalent mutant. See the header.
    const root = board({ active: "S1", sprints: SPRINTS });
    try {
      const r = run(root, "active", "S2");
      assert.equal(r.status, 0, `the command failed:\n${r.stderr}`);
      assert.match(r.stderr ?? "", /Saving now stamps it/,
        "the message no longer describes a pending write");
      assert.equal(onDisk(root).registryVersion, 1,
        "the file was not stamped, so the warning could have come from the post-write state");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a board with no sprints at all is silent", () => {
    const root = board({ active: null, sprints: [] });
    try {
      const r = run(root, "new", "first", "--start", "2026-08-01", "--end", "2026-08-14");
      // Without this the test passes when the command CRASHES — a `doesNotMatch` on the stderr of
      // a run that never got as far as the warning proves nothing. Tests 1-2 guard it this way;
      // this one did not, and an injected throw sailed through.
      assert.equal(r.status, 0, `the command failed, so the assertion below is vacuous:\n${r.stderr}`);
      assert.doesNotMatch(r.stderr ?? "", /version stamp/,
        `a fresh board warned on its first sprint:\n${r.stderr}`);
      assert.equal(onDisk(root).sprints.length, 1, "the sprint was not actually created");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
