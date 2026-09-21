// tests/model/import-mapping-propose.test.mjs — BLZ-635, design §4.3 and §4.4.
//
// THE ONE PLACE A MODEL RUNS, and the whole of what it is allowed to produce:
// a CANDIDATE MAPPING FILE. Not a ticket, not an id, not a staged change
// (ADR-0037 §2). These tests drive the module directly with a stub command;
// the PROOF that nothing spawns the agent on the deterministic import path is
// a different test, tests/import-agent-boundary.test.mjs, because it has to
// cross a process boundary that an in-process stub cannot reach.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  proposeMapping, renderProposal, runProposeMapping, sampleOf,
} from "../../scripts/model/import-mapping-propose.mjs";
import { MAPPING_DIR, headerDigest, loadMapping } from "../../scripts/model/import-mapping.mjs";

const HEADER = ["Issue key", "Summary", "Issue Type", "Status", "Reporter"];

function root(t) {
  const dir = mkdtempSync(join(tmpdir(), "blaze-propose-"));
  t.after(() => {
    // Restore any permission a test narrowed, or rmSync cannot empty it.
    try { chmodSync(join(dir, MAPPING_DIR), 0o700); } catch { /* not narrowed */ }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function csvAt(dir, name = "export.csv") {
  const p = join(dir, name);
  writeFileSync(p, [
    HEADER.join(","),
    "ACME-1,first,Story,To Do,someone",
    "ACME-2,second,Story,Blocked,other",
  ].join("\n") + "\n");
  return p;
}

function candidate(overrides = {}) {
  return {
    mappingVersion: 1,
    schemaVersion: 1,
    name: "acme",
    source: { columns: HEADER.slice(), sha256: headerDigest(HEADER) },
    sourceIdColumn: "Issue key",
    columns: {
      title: { from: "Summary" },
      description: { from: "Summary" },
      type: { from: "Issue Type" },
      status: { from: "Status" },
      project: { constant: "ACME" },
    },
    values: { type: { Story: "story" }, status: { "To Do": "defined" } },
    unmapped: ["Reporter"],
    ...overrides,
  };
}

/** A spawn seam that answers with whatever the test hands it, and records
 *  exactly what it was asked — the argv shape is what the PATH-shadowed stub
 *  of BLZ-636 relies on. */
function fakeSpawn(result) {
  const calls = [];
  const fn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return result; };
  fn.calls = calls;
  return fn;
}

const ok = (obj) => ({ status: 0, stdout: JSON.stringify(obj), stderr: "" });

// =============================================================================
// §4.3 — the spawn, and its resolution order
// =============================================================================

describe("proposeMapping spawns the configured agent command, once", () => {
  test("it splits `agentCommand` the way the groomer does and appends the prompt", () => {
    const spawn = fakeSpawn(ok(candidate()));
    const r = proposeMapping(HEADER, [["ACME-1", "first", "Story", "To Do", "someone"]],
      { agentCommand: "claude -p", spawn });
    assert.equal(r.ok, true, r.errors?.join("\n"));
    assert.equal(spawn.calls.length, 1, "ONCE — §4.3's table says `Model? yes, once`");
    assert.equal(spawn.calls[0].cmd, "claude",
      "a BARE command name, so a PATH lookup resolves it — which is what makes the PATH arm of "
      + "the resolution order reachable at all (§4.3)");
    assert.deepEqual(spawn.calls[0].args.slice(0, 1), ["-p"]);
    assert.match(spawn.calls[0].args[1], /Issue key/, "the prompt carries the header");
    assert.match(spawn.calls[0].args[1], /first/, "...and a bounded sample of rows");
  });

  test("an ABSOLUTE agentCommand is spawned as-is — PATH is never consulted", () => {
    const spawn = fakeSpawn(ok(candidate()));
    proposeMapping(HEADER, [], { agentCommand: "/opt/agent/run.sh --json", spawn });
    assert.equal(spawn.calls[0].cmd, "/opt/agent/run.sh");
  });

  test("the sample is BOUNDED — a 10,000-row export does not become a 10,000-row prompt", () => {
    const rows = Array.from({ length: 10000 }, (_, i) => [`ACME-${i}`, "x", "Story", "To Do", "r"]);
    assert.ok(sampleOf(rows).length <= 25);
    assert.ok(sampleOf(rows).length > 0);
  });

  test("a non-zero exit is a FAILURE whose message carries the command's own output", () => {
    const spawn = fakeSpawn({ status: 7, stdout: "", stderr: "SENTINEL_WROTE_ENV_HIT" });
    const r = proposeMapping(HEADER, [], { agentCommand: "stub", spawn });
    assert.equal(r.ok, false);
    assert.match(r.errors.join("\n"), /SENTINEL_WROTE_ENV_HIT/,
      "§4.3 assertion 2 requires the failure message to carry the stub's sentinel string — "
      + "without it a positive control cannot be attributed to the stub");
    assert.match(r.errors.join("\n"), /stub/, "...and the command that produced it");
  });

  test("a command that cannot be spawned at all is a failure, not a throw", () => {
    const spawn = fakeSpawn({ status: null, error: new Error("spawnSync ENOENT"), stdout: "", stderr: "" });
    const r = proposeMapping(HEADER, [], { agentCommand: "nope", spawn });
    assert.equal(r.ok, false);
    assert.match(r.errors.join("\n"), /ENOENT/);
  });

  test("output that is not a mapping is a failure — the model's answer is DATA, never code", () => {
    for (const out of ["not json", "[1,2,3]", '"a string"', ""]) {
      const r = proposeMapping(HEADER, [], {
        agentCommand: "stub", spawn: fakeSpawn({ status: 0, stdout: out, stderr: "" }),
      });
      assert.equal(r.ok, false, `expected a refusal for ${JSON.stringify(out)}`);
    }
  });

  test("a candidate wrapped in prose or a fenced block is still read", () => {
    const body = "Here is the mapping:\n```json\n" + JSON.stringify(candidate()) + "\n```\nHope that helps.";
    const r = proposeMapping(HEADER, [], {
      agentCommand: "stub", spawn: fakeSpawn({ status: 0, stdout: body, stderr: "" }),
    });
    assert.equal(r.ok, true, r.errors?.join("\n"));
    assert.equal(r.candidate.name, "acme");
  });

  test("the candidate's `source` is OVERWRITTEN with the real header and digest", () => {
    const lying = candidate({ source: { columns: ["whatever"], sha256: "0".repeat(64) } });
    const r = proposeMapping(HEADER, [], {
      agentCommand: "stub", spawn: fakeSpawn(ok(lying)),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.candidate.source.columns, HEADER);
    assert.equal(r.candidate.source.sha256, headerDigest(HEADER),
      "the digest is the file's, measured here — a model-supplied digest would make the header "
      + "check vouch for nothing");
  });
});

// =============================================================================
// §4.4 — what the operator is shown
// =============================================================================

describe("renderProposal shows the four blocks §4.4 names", () => {
  const rows = [
    ["ACME-1", "first", "Story", "To Do", "someone"],
    ["ACME-2", "second", "Story", "Blocked", "other"],
    ["ACME-3", "third", "Story", "Blocked", "other"],
  ];

  test("MAPPED names every source column, its canonical column and its translations", () => {
    const text = renderProposal(candidate(), HEADER, rows);
    assert.match(text, /MAPPED/);
    assert.match(text, /Summary\s+→ title/);
    assert.match(text, /Issue Type\s+→ type/);
    assert.match(text, /Story→story/);
    assert.match(text, /\(constant\)\s+→ project\s+ACME/);
  });

  test("UNMAPPED says DISCARDED, in the affirmative", () => {
    const text = renderProposal(candidate(), HEADER, rows);
    assert.match(text, /UNMAPPED — 1 source column[s]? will be DISCARDED/);
    assert.match(text, /Reporter/,
      "§4.4: a column silently absent from a mapping table is the failure mode this whole layer "
      + "exists to prevent");
  });

  test("REQUIRED AND UNFILLED lists canonical columns nothing maps to", () => {
    const missing = candidate();
    delete missing.columns.title;
    const text = renderProposal(missing, HEADER, rows);
    assert.match(text, /REQUIRED AND UNFILLED[\s\S]*title/);
    assert.match(renderProposal(candidate(), HEADER, rows), /REQUIRED AND UNFILLED[^\n]*\n\s+\(none\)/);
  });

  test("VALUES SEEN BUT NOT TRANSLATED is derived from the sample, with its row count", () => {
    const text = renderProposal(candidate(), HEADER, rows);
    assert.match(text, /VALUES SEEN BUT NOT TRANSLATED — 1/);
    assert.match(text, /Status: "Blocked" \(2 rows\)/,
      "§4.4: this render is the ONE exemption from §5.2's echo rule — an unmapped status the "
      + "operator cannot see is a mapping they cannot fix");
  });

  test("the render ends by naming the file it would write, and asks", () => {
    assert.match(renderProposal(candidate(), HEADER, rows),
      /Write import-mappings\/acme\.json\? \[y\/N\]/);
  });
});

// =============================================================================
// The verb: ONE file written, and nothing else
// =============================================================================

describe("runProposeMapping writes the mapping file and NOTHING else", () => {
  function opts(dir, extra = {}) {
    return {
      file: csvAt(dir),
      dataRoot: dir,
      agentCommand: "stub",
      spawn: fakeSpawn(ok(candidate())),
      confirm: () => "y",
      ...extra,
    };
  }

  test("on `y` it writes import-mappings/<name>.json, and that file LOADS", (t) => {
    const dir = root(t);
    const r = runProposeMapping(opts(dir));
    assert.equal(r.exitCode, 0, r.report);
    const written = join(dir, MAPPING_DIR, "acme.json");
    assert.equal(existsSync(written), true);
    const loaded = loadMapping(written);
    assert.equal(loaded.ok, true,
      `the proposer must emit a file BLZ-634's deterministic loader accepts: ${loaded.errors?.join("; ")}`);
  });

  test("it creates no ticket, allocates no id and stages nothing", (t) => {
    const dir = root(t);
    runProposeMapping(opts(dir));
    assert.deepEqual(readdirSync(dir).sort(), [MAPPING_DIR, "export.csv"].sort(),
      "ADR-0037 §3: the operator is agreeing to a FILE, not to a run. One file appears and "
      + "nothing else — no projects tree, no .ids, no receipt, no source-ids, no queue");
  });

  test("on anything but `y` it writes NOTHING — the default is No", (t) => {
    for (const answer of ["", "n", "N", "no", "Y E S"]) {
      const dir = root(t);
      const r = runProposeMapping(opts(dir, { confirm: () => answer }));
      assert.equal(existsSync(join(dir, MAPPING_DIR)), false, `answer ${JSON.stringify(answer)} wrote a file`);
      assert.equal(r.exitCode, 0, "declining is not an error");
    }
  });

  test("`y` is accepted case-insensitively and with surrounding whitespace", (t) => {
    const dir = root(t);
    assert.equal(runProposeMapping(opts(dir, { confirm: () => " Y \n" })).exitCode, 0);
    assert.equal(existsSync(join(dir, MAPPING_DIR, "acme.json")), true);
  });

  test("it REFUSES to write a mapping named `canonical`", (t) => {
    const dir = root(t);
    const r = runProposeMapping(opts(dir, { spawn: fakeSpawn(ok(candidate({ name: "canonical" }))) }));
    assert.notEqual(r.exitCode, 0);
    assert.match(r.report, /canonical/);
    assert.equal(existsSync(join(dir, MAPPING_DIR)), false);
  });

  test("it REFUSES a name that is not a bare basename — the model does not choose a path", (t) => {
    for (const name of ["../escape", "a/b", ".", "", "x.json"]) {
      const dir = root(t);
      const r = runProposeMapping(opts(dir, { spawn: fakeSpawn(ok(candidate({ name }))) }));
      assert.notEqual(r.exitCode, 0, `name ${JSON.stringify(name)} was accepted`);
      assert.equal(existsSync(join(dir, MAPPING_DIR)), false);
    }
  });

  test("a spawn failure is reported and nothing is written or asked", (t) => {
    const dir = root(t);
    let asked = 0;
    const r = runProposeMapping(opts(dir, {
      spawn: fakeSpawn({ status: 3, stdout: "", stderr: "PATH_HIT" }),
      confirm: () => { asked++; return "y"; },
    }));
    assert.notEqual(r.exitCode, 0);
    assert.match(r.report, /PATH_HIT/);
    assert.equal(asked, 0, "there is nothing to confirm");
    assert.equal(existsSync(join(dir, MAPPING_DIR)), false);
  });

  test("an unreadable input is exit 2 and never reaches the agent", (t) => {
    const dir = root(t);
    const spawn = fakeSpawn(ok(candidate()));
    const r = runProposeMapping(opts(dir, { file: join(dir, "gone.csv"), spawn }));
    assert.equal(r.exitCode, 2);
    assert.equal(spawn.calls.length, 0);
  });

  test("a candidate the deterministic loader would reject is refused BEFORE it is written", (t) => {
    const dir = root(t);
    const bad = candidate();
    bad.columns.estimate = { from: "Summary", transform: "ask-the-model" };
    const r = runProposeMapping(opts(dir, { spawn: fakeSpawn(ok(bad)) }));
    assert.notEqual(r.exitCode, 0);
    assert.match(r.report, /transform/);
    assert.equal(existsSync(join(dir, MAPPING_DIR)), false,
      "a mapping file the importer cannot load is not a proposal, it is a trap laid for the "
      + "next run");
  });

  test("an unwritable import-mappings/ is reported, not thrown", (t) => {
    const dir = root(t);
    mkdirSync(join(dir, MAPPING_DIR), { recursive: true });
    chmodSync(join(dir, MAPPING_DIR), 0o500);
    const r = runProposeMapping(opts(dir));
    assert.notEqual(r.exitCode, 0);
    assert.equal(readdirSync(join(dir, MAPPING_DIR)).length, 0);
  });

  test("the render reaches the operator BEFORE the question is asked", (t) => {
    const dir = root(t);
    const shown = [];
    runProposeMapping(opts(dir, {
      say: (l) => shown.push(l),
      confirm: () => { assert.ok(shown.join("\n").includes("UNMAPPED"), "the blocks come first"); return "n"; },
    }));
    assert.match(shown.join("\n"), /MAPPED/);
  });
});

test("the proposer never imports a write port, the planner, or the applier", () => {
  const src = readFileSync(
    new URL("../../scripts/model/import-mapping-propose.mjs", import.meta.url), "utf8");
  for (const forbidden of ["write-port", "import-plan", "import-apply", "storage.mjs", "claims.mjs"]) {
    assert.equal(src.includes(`from "./${forbidden}`), false,
      `ADR-0037 §2: the proposer "will never resolve an id, never read the corpus and never touch `
      + `a write port" — and it imports ${forbidden}`);
  }
});
