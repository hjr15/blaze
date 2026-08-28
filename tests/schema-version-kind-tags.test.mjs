// tests/schema-version-kind-tags.test.mjs — BLZ-428 and BLZ-429.
//
// `checkSchemaVersion` returns a `kind` discriminator on every `{ok:false}` result, and
// `loadConfig` reads it to decide WHICH error class to throw — which in turn decides
// whether `blaze audit` tolerates the failure (`IncompatibleSchemaVersionError`, treated as
// "config absent") or reports it as a HARD `config-unloadable`. The tag is therefore
// load-bearing on every branch, not decoration.
//
// BLZ-428 — TWO of those branches are UNREACHABLE THROUGH ANY PRODUCTION CALL PATH. Both
// live under `v < min`, and with the shipped constants `MIN_SCHEMA_VERSION === 1` there is
// no value of `v` that reaches them: an absent or null stamp resolves to the literal 1, and
// every explicit stamp that is not an integer >= 1 was already refused by the branch above.
// `min` is injectable precisely so they stay unit-testable, so they are pinned HERE BY
// DIRECT CALL with `min` raised — and stated plainly rather than implied to be pinned: no
// mutation of these two branches can be killed by any test that goes through `loadConfig`,
// because nothing calls them. They become live the day `MIN_SCHEMA_VERSION` is raised, and
// that day is what the tag has to be right for. `MIN_SCHEMA_VERSION` is NOT raised to make
// them reachable — that is a board-migration decision, not a test convenience.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkSchemaVersion, SCHEMA_VERSION, MIN_SCHEMA_VERSION, REMOVED_KEYS }
  from "../scripts/model/schema-version.mjs";

const AUDIT = join(import.meta.dirname, "..", "scripts", "audit-runner.mjs");

describe("BLZ-428: the kind tag on the two branches unreachable until MIN_SCHEMA_VERSION rises", () => {
  test("the shipped constants really do make both `v < min` branches unreachable", () => {
    // Stated as an executable claim rather than a comment, so "unreachable" cannot quietly
    // become false. With min === 1 no input reaches `v < min`: the absent case resolves to
    // 1, and anything below 1 is refused as `invalid schemaVersion` one branch earlier.
    assert.equal(MIN_SCHEMA_VERSION, 1);
    for (const cfg of [{}, { schemaVersion: null }, { schemaVersion: 0 }, { schemaVersion: -3 },
                       { schemaVersion: 1 }, { schemaVersion: SCHEMA_VERSION }]) {
      const r = checkSchemaVersion(cfg);
      assert.doesNotMatch(String(r.error ?? ""), /older than this engine supports/,
        `${JSON.stringify(cfg)} reached a too-old branch at the shipped constants`);
    }
  });

  test("an ABSENT stamp below a raised floor is tagged version-window", () => {
    const r = checkSchemaVersion({}, { current: 3, min: 2 });
    assert.equal(r.ok, false);
    assert.equal(r.kind, "version-window",
      "an absent stamp is a stamp problem, and must not be confused with a removed key");
    assert.match(r.error, /no schemaVersion stamp/);
    assert.match(r.error, /supported: 2\.\.3/);
  });

  test("an EXPLICIT stamp below a raised floor is tagged version-window", () => {
    const r = checkSchemaVersion({ schemaVersion: 1 }, { current: 3, min: 2 });
    assert.equal(r.ok, false);
    assert.equal(r.kind, "version-window");
    assert.match(r.error, /board schemaVersion 1 is older/);
  });

  test("every {ok:false} branch carries a kind, and every {ok:true} carries none", () => {
    // The contract in one assertion, across every branch this function has — the two
    // unreachable ones included, via the injected floor.
    const cases = [
      [{ provider: "github" }, {}, "removed-key"],
      [{ schemaVersion: "1" }, {}, "version-window"],
      [{ schemaVersion: 1.5 }, {}, "version-window"],
      [{ schemaVersion: SCHEMA_VERSION + 1 }, {}, "version-window"],
      [{}, { current: 3, min: 2 }, "version-window"],
      [{ schemaVersion: 1 }, { current: 3, min: 2 }, "version-window"],
    ];
    for (const [cfg, opts, kind] of cases) {
      const r = checkSchemaVersion(cfg, opts);
      assert.equal(r.ok, false, JSON.stringify(cfg));
      assert.equal(r.kind, kind, JSON.stringify(cfg));
    }
    const good = checkSchemaVersion({ schemaVersion: SCHEMA_VERSION });
    assert.deepEqual(good, { ok: true, error: null },
      "the ok shape is unchanged — no kind key at all");
  });
});

// ---------------------------------------------------------------------------------------
// BLZ-429 — the severity of a NULL-VALUED removed key, measured before it was left alone.
//
// #135 (BLZ-402 round 3) gave `removed-key` its own `kind`, so `loadConfig` stopped
// wrapping it in `IncompatibleSchemaVersionError`. That is what flipped it from a failure
// `blaze audit` TOLERATED (config = null, ok=true) into a HARD `config-unloadable` that
// exits 1 — a severity change the PR body never enumerated. `present` tests
// `cfg[k] !== undefined`, so `"provider": null` counts as SET, and BLZ-429 asks whether
// that is right.
//
// MEASURED FIRST (BLZ-353's lesson), read-only, on 2026-08-28 across every
// `blaze.config.json` on this machine outside node_modules — 14 distinct boards (9 in the
// blaze-pm family, 5 fixtures under this repo's tests/):
//
//   * NULL-VALUED removed key:  0 boards, 0 keys. Not one config on disk sets `provider`,
//     `terminal` or `codeRepo` to null. This branch newly refuses NOTHING.
//   * any-valued removed key:   7 of the 9 blaze-pm checkouts set `provider: "github"` (a
//     STRING). The live board's working branch BLZ-305-v4-spine (2535a6ae) and the v3
//     branch are both clean; `main` and five stale feature worktrees are not, and the work
//     order records that `provider` self-resolves at the flush.
//
// THE SEVERITY IS RIGHT AND IS LEFT AS IT IS. The null case costs nothing (0), and treating
// null as "absent" would invent a second spelling of "set but ignored" — which is exactly
// the defect BLZ-298 removed these keys to end: a key the operator wrote and nothing reads.
// A `null` in JSON is a value, not an absence, and "Delete it" is the right remedy for both
// spellings. Pinned below so the discrimination is a decision rather than an accident.
describe("BLZ-429: a null-valued removed key is refused, and that is deliberate", () => {
  test("checkSchemaVersion tags a null-valued removed key removed-key, not version-window", () => {
    for (const key of Object.keys(REMOVED_KEYS)) {
      const r = checkSchemaVersion({ [key]: null, schemaVersion: SCHEMA_VERSION });
      assert.equal(r.ok, false, key);
      assert.equal(r.kind, "removed-key",
        `${key}: null is a value, and mis-tagging it version-window would make blaze audit ` +
        "tolerate it as though the config were absent");
      assert.match(r.error, new RegExp(key));
    }
  });

  test("an in-window stamp does not rescue it — the key is checked first", () => {
    const r = checkSchemaVersion({ provider: null, schemaVersion: SCHEMA_VERSION });
    assert.equal(r.kind, "removed-key");
    assert.doesNotMatch(r.error, /schemaVersion/,
      "the message must not send an operator to the version stamp, which is fine");
  });

  test("`blaze audit` reports it as a HARD config-unloadable and exits 1", () => {
    // The whole severity claim, end to end through the runner that owns it.
    const dir = mkdtempSync(join(tmpdir(), "blz429-null-"));
    try {
      mkdirSync(join(dir, "projects", "TASK", "defined"), { recursive: true });
      writeFileSync(join(dir, "projects", "TASK", "defined", "TASK-1-x.md"),
        "---\nid: TASK-1\ntitle: x\ntype: task\nproject: TASK\ncomponents: [a]\nlabels: [b]\n---\nbody\n");
      writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({
        key: "TASK", projects: ["TASK"], provider: null, schemaVersion: SCHEMA_VERSION,
      }));
      const res = spawnSync(process.execPath, [AUDIT, "--json"], { cwd: dir, encoding: "utf8" });
      assert.equal(res.status, 1, res.stderr);
      const report = JSON.parse(res.stdout);
      assert.equal(report.ok, false);
      const hit = report.findings.find((f) => f.kind === "config-unloadable");
      assert.ok(hit, `no config-unloadable finding: ${res.stdout}`);
      assert.match(hit.detail, /provider/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("...and a board that simply omits the key is clean", () => {
    // The negative side: without it, the test above would pass on a runner that failed
    // every board.
    const dir = mkdtempSync(join(tmpdir(), "blz429-clean-"));
    try {
      mkdirSync(join(dir, "projects", "TASK", "defined"), { recursive: true });
      writeFileSync(join(dir, "projects", "TASK", "defined", "TASK-1-x.md"),
        "---\nid: TASK-1\ntitle: x\ntype: task\nproject: TASK\ncomponents: [a]\nlabels: [b]\n---\nbody\n");
      writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({
        key: "TASK", projects: ["TASK"], schemaVersion: SCHEMA_VERSION,
      }));
      const res = spawnSync(process.execPath, [AUDIT, "--json"], { cwd: dir, encoding: "utf8" });
      const report = JSON.parse(res.stdout);
      assert.equal(report.findings.some((f) => f.kind === "config-unloadable"), false, res.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
