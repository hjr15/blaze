// tests/init.test.mjs — `blaze init` (BLZ-285), implementing ADR-0012.
//
// The two properties worth protecting, because both are easy to lose in a refactor and
// silent when lost:
//
//   1. A PASSWORD NEVER REACHES DISK. Not the tracked config, not the untracked one.
//      Blaze stores the NAME of an environment variable.
//   2. NOTHING IS WRITTEN UNTIL EVERY CHECK PASSES. A wizard that creates a directory
//      and then fails leaves a half-board that the next run refuses to touch.
//
// The interactive prompts are deliberately NOT tested through a pty. They are a thin
// wrapper over the flags, and the flags are what everything else uses — testing the
// wrapper through a terminal emulator would test readline, not Blaze.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planInit, questions, testConnection, OFFERED_DRIVERS } from "../scripts/init.mjs";
import { parseArgs, runInit } from "../scripts/init-runner.mjs";

const dir = () => join(mkdtempSync(join(tmpdir(), "blaze-init-")), "board");
const silent = { isTTY: false, log: () => {}, err: () => {} };
const capture = () => {
  const out = [];
  return { io: { ...silent, log: (s) => out.push(String(s)), err: (s) => out.push(String(s)) }, out };
};

const PG = (over = {}) => ({
  dir: dir(), project: "ENG", driver: "postgres", host: "localhost", port: 5432,
  database: "blaze", user: "blaze", passwordEnv: "BLAZE_DB_PASSWORD", ...over,
});

/** A fake Postgres that passes every check. */
const goodPg = () => async () => ({
  serverVersionNum: async () => 170000,
  encoding: async () => "UTF8",
  probeCreate: async () => {},
  close: async () => {},
});

describe("planInit — the questions that earn a prompt", () => {
  test("a board needs a directory and a project, and says so together", () => {
    const r = planInit({});
    assert.equal(r.ok, false);
    // Collected, not thrown on the first: a wizard reporting one problem per run is a
    // wizard people run four times.
    assert.equal(r.errors.length, 2);
    assert.match(r.errors.join("\n"), /--dir is required/);
    assert.match(r.errors.join("\n"), /--project is required/);
  });

  test("a project key is upper-cased, and a bad one is refused with an example", () => {
    assert.equal(planInit({ dir: "/b", project: "eng" }).plan.config.projects[0], "ENG");
    const bad = planInit({ dir: "/b", project: "9ENG" });
    assert.equal(bad.ok, false);
    assert.match(bad.errors[0], /not a valid key/);
    assert.match(bad.errors[0], /e\.g\. ENG/);
  });

  test("sqlite needs nothing further, and writes no connection file", () => {
    const r = planInit({ dir: "/b", project: "ENG" });
    assert.equal(r.plan.config.database.driver, "sqlite");
    assert.equal(r.plan.databasePath, null, "there is nothing to connect to");
  });

  test("an unsupported driver is refused by name", () => {
    const r = planInit({ dir: "/b", project: "ENG", driver: "mysql" });
    assert.match(r.errors[0], /not a supported driver/);
    assert.match(r.errors[0], new RegExp(OFFERED_DRIVERS.join(" or ")));
  });

  test("postgres requires the connection parts, each named", () => {
    const r = planInit({ dir: "/b", project: "ENG", driver: "postgres" });
    for (const flag of ["--host", "--database", "--user", "--password-env"]) {
      assert.ok(r.errors.some((e) => e.includes(flag)), `${flag} must be named`);
    }
  });
});

describe("a password never reaches disk", () => {
  test("a literal --password is refused, pointing at --password-env", () => {
    const r = planInit({ ...PG(), password: "hunter2" });
    assert.equal(r.ok, false);
    assert.match(r.errors.join("\n"), /refusing a literal password/);
    assert.match(r.errors.join("\n"), /--password-env/);
  });

  test("a URL carrying credentials is refused wherever it is pasted", () => {
    // "put it in the untracked file" degrades to JIRA's plaintext dbconfig.xml the
    // moment someone pastes a URL into the wrong field. So the field refuses it.
    for (const field of ["host", "database", "user"]) {
      const r = planInit({ ...PG(), [field]: "postgres://u:p@h:5432/d" });
      assert.equal(r.ok, false, field);
      assert.match(r.errors.join("\n"), /URL containing credentials/);
    }
  });

  test("the plan holds passwordEnv — the NAME — and no password field at all", () => {
    const r = planInit(PG());
    assert.equal(r.plan.database.passwordEnv, "BLAZE_DB_PASSWORD");
    assert.ok(!("password" in r.plan.database), "the plan must have no password field");
  });

  test("end to end: neither file written contains the password", async () => {
    const d = dir();
    const code = await runInit(
      [`--dir=${d}`, "--project=ENG", "--db=postgres", "--host=h", "--database=b",
       "--user=u", "--password-env=SECRET_VAR", "--yes", "--no-git"],
      { ...silent, env: { SECRET_VAR: "hunter2" }, openPostgres: goodPg() });
    assert.equal(code, 0);
    for (const f of [join(d, "blaze.config.json"), join(d, ".blaze", "database.json")]) {
      const text = readFileSync(f, "utf8");
      assert.doesNotMatch(text, /hunter2/, `${f} must not contain the password`);
    }
    assert.match(readFileSync(join(d, ".blaze", "database.json"), "utf8"), /SECRET_VAR/,
      "it stores the variable NAME");
  });

  test("the connection file is created 0600", async () => {
    const d = dir();
    await runInit([`--dir=${d}`, "--project=ENG", "--db=postgres", "--host=h",
                   "--database=b", "--user=u", "--password-env=V", "--yes", "--no-git"],
      { ...silent, env: { V: "x" }, openPostgres: goodPg() });
    assert.equal(statSync(join(d, ".blaze", "database.json")).mode & 0o777, 0o600);
  });
});

describe("nothing is written until every check passes", () => {
  test("a failed connection leaves no directory behind", async () => {
    const d = dir();
    const failing = async () => { const e = new Error("nope"); e.code = "ECONNREFUSED"; throw e; };
    const code = await runInit(
      [`--dir=${d}`, "--project=ENG", "--db=postgres", "--host=h", "--database=b",
       "--user=u", "--password-env=V", "--yes"],
      { ...silent, env: { V: "x" }, openPostgres: failing });
    assert.equal(code, 1);
    assert.equal(existsSync(d), false, "a half-board is worse than no board");
  });

  test("each failure names its own fix", async () => {
    const cases = [
      [{ code: "ECONNREFUSED" }, /Could not reach Postgres/],
      [{ code: "28P01" }, /rejected the credentials/],
      [{ code: "3D000" }, /has no database named/],
    ];
    for (const [err, expected] of cases) {
      const { io, out } = capture();
      const throwing = async () => { const e = new Error("x"); Object.assign(e, err); throw e; };
      await runInit([`--dir=${dir()}`, "--project=ENG", "--db=postgres", "--host=h",
                     "--database=b", "--user=u", "--password-env=V", "--yes"],
        { ...io, env: { V: "x" }, openPostgres: throwing });
      assert.match(out.join("\n"), expected, JSON.stringify(err));
    }
  });

  test("a server too old is refused with its version, not a syntax error later", async () => {
    const old = async () => ({
      serverVersionNum: async () => 110000, encoding: async () => "UTF8",
      probeCreate: async () => {}, close: async () => {},
    });
    const { io, out } = capture();
    const code = await runInit([`--dir=${dir()}`, "--project=ENG", "--db=postgres",
      "--host=h", "--database=b", "--user=u", "--password-env=V", "--yes"],
      { ...io, env: { V: "x" }, openPostgres: old });
    assert.equal(code, 1);
    assert.match(out.join("\n"), /version 110000; Blaze needs 12 or newer/);
  });

  test("a non-UTF8 database is refused — it silently mangles ticket text", async () => {
    const latin = async () => ({
      serverVersionNum: async () => 170000, encoding: async () => "LATIN1",
      probeCreate: async () => {}, close: async () => {},
    });
    const { io, out } = capture();
    assert.equal(1, await runInit([`--dir=${dir()}`, "--project=ENG", "--db=postgres",
      "--host=h", "--database=b", "--user=u", "--password-env=V", "--yes"],
      { ...io, env: { V: "x" }, openPostgres: latin }));
    assert.match(out.join("\n"), /LATIN1 encoding; Blaze requires UTF8/);
  });

  test("a connection that cannot CREATE is refused, with the GRANT to run", async () => {
    // Without this probe the wizard reports "connection OK" and `db init` then fails,
    // which means the wizard lied.
    const noPriv = async () => ({
      serverVersionNum: async () => 170000, encoding: async () => "UTF8",
      probeCreate: async () => { throw new Error("permission denied for database b"); },
      close: async () => {},
    });
    const { io, out } = capture();
    assert.equal(1, await runInit([`--dir=${dir()}`, "--project=ENG", "--db=postgres",
      "--host=h", "--database=b", "--user=u", "--password-env=V", "--yes"],
      { ...io, env: { V: "x" }, openPostgres: noPriv }));
    assert.match(out.join("\n"), /could not create a table/);
    assert.match(out.join("\n"), /GRANT CREATE ON DATABASE b TO u/);
  });
});

describe("the board it makes actually works", () => {
  test("sqlite: writes config and the project, and gitignores .blaze", async () => {
    const d = dir();
    assert.equal(0, await runInit([`--dir=${d}`, "--project=eng", "--yes", "--no-git"], silent));
    assert.deepEqual(JSON.parse(readFileSync(join(d, "blaze.config.json"), "utf8")).projects, ["ENG"]);
    assert.ok(existsSync(join(d, "projects", "ENG", "project.json")));
    // ADR-0012 puts the connection in .blaze/ BECAUSE .blaze/ is untracked. A brand new
    // board has no .gitignore at all, so without this the file would be committed on
    // the first `git add .` — the exact outcome the ADR exists to prevent.
    assert.match(readFileSync(join(d, ".gitignore"), "utf8"), /^\.blaze\/$/m);
  });

  test("an existing .gitignore is appended to, never replaced", async () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, ".gitignore"), "node_modules/\n");
    await runInit([`--dir=${d}`, "--project=ENG", "--yes", "--no-git"], silent);
    const text = readFileSync(join(d, ".gitignore"), "utf8");
    assert.match(text, /node_modules\//, "the existing rule must survive");
    assert.match(text, /^\.blaze\/$/m);
  });

  test("re-running against an existing board refuses unless --force", async () => {
    const d = dir();
    assert.equal(0, await runInit([`--dir=${d}`, "--project=ENG", "--yes", "--no-git"], silent));
    const { io, out } = capture();
    assert.equal(1, await runInit([`--dir=${d}`, "--project=OTHER", "--yes", "--no-git"], io));
    assert.match(out.join("\n"), /already exists/);
    assert.match(out.join("\n"), /does NOT migrate any existing data/);
    assert.deepEqual(JSON.parse(readFileSync(join(d, "blaze.config.json"), "utf8")).projects,
      ["ENG"], "the original board must be untouched");
    assert.equal(0, await runInit([`--dir=${d}`, "--project=OTHER", "--yes", "--no-git", "--force"], silent));
  });
});

describe("the flags are the contract", () => {
  test("every question has a flag", () => {
    // If a prompt can set something no flag can, the interactive path is a second
    // source of truth and it will drift.
    const flagged = new Set(["dir", "project", "driver", "host", "port", "database",
                             "user", "passwordEnv"]);
    for (const q of questions({ driver: "postgres" })) {
      assert.ok(flagged.has(q.key), `question '${q.key}' has no flag`);
    }
  });

  test("every question says what it is for", () => {
    for (const q of questions({ driver: "postgres" })) {
      assert.ok(q.why && q.why.length > 10, `question '${q.key}' has no justification`);
    }
  });

  test("an unknown flag is refused with the usage, not ignored", async () => {
    const { io, out } = capture();
    assert.equal(1, await runInit(["--dir=/x", "--project=E", "--wat", "--yes"], io));
    assert.match(out.join("\n"), /unknown option --wat/);
  });

  test("parseArgs handles bare flags and =values", () => {
    const a = parseArgs(["--dir=/x", "--project=E", "--yes", "--force", "--no-git"]);
    assert.equal(a.dir, "/x");
    assert.equal(a.yes, true);
    assert.equal(a.force, true);
    assert.equal(a.noGit, true);
  });

  test("--help exits 0 and prints the usage", async () => {
    const { io, out } = capture();
    assert.equal(0, await runInit(["--help"], io));
    assert.match(out.join("\n"), /usage: blaze init/);
    assert.match(out.join("\n"), /NEVER stores a password/);
  });
});

describe("testConnection", () => {
  test("all four checks are reported by name when they pass", async () => {
    const r = await testConnection(PG(), { password: "x", openPostgres: goodPg() });
    assert.equal(r.ok, true);
    assert.deepEqual(r.checks, ["connected", "server_version 170000", "encoding UTF8",
                                "can create tables"]);
  });

  test("it stops at the first failure and names the step", async () => {
    const failing = async () => { const e = new Error("x"); e.code = "ETIMEDOUT"; throw e; };
    const r = await testConnection(PG(), { password: "x", openPostgres: failing });
    assert.equal(r.ok, false);
    assert.equal(r.step, "reach");
    assert.deepEqual(r.checks, [], "nothing should be claimed as checked");
  });
});
