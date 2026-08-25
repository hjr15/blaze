// tests/sprint-runner-stamp-warning.test.mjs — BLZ-369.
//
// A SUBPROCESS test, because `scripts/*-runner.mjs` is c8-excluded and the unit tests reach the
// warning function but not its DELIVERY. Three mutations survived the whole suite without this:
// deleting both `warnIfUnstamped` calls, moving the call after `saveSprints`, and switching
// `console.error` to `console.log`.
//
// The last one has teeth. stdout is a machine-parsed channel here —
// `tests/runner-flag-guard.test.mjs` does `created.stdout.match(/created (\S+)/)` — so a warning
// leaking into it would break a parser with nothing red anywhere.
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
      assert.doesNotMatch(r.stderr ?? "", /version stamp/,
        `a correctly stamped registry warned:\n${r.stderr}`);
      assert.equal(onDisk(root).active, "S2", "the command did not do its job");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the warning comes BEFORE the write, so it describes what is about to happen", () => {
    // Moving the call after `saveSprints` leaves it true but useless — by then the file is
    // already stamped and the sentence "saving now stamps it" is a lie about the past.
    const root = board({ active: "S1", sprints: SPRINTS });
    try {
      const r = run(root, "active", "S2");
      assert.match(r.stderr ?? "", /Saving now stamps it/,
        "the message no longer describes a pending write");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a board with no sprints at all is silent", () => {
    const root = board({ active: null, sprints: [] });
    try {
      const r = run(root, "new", "first", "--start", "2026-08-01", "--end", "2026-08-14");
      assert.doesNotMatch(r.stderr ?? "", /version stamp/,
        `a fresh board warned on its first sprint:\n${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
