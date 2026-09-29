// tests/groomer-db-mode.test.mjs — BLZ-670 (final review).
//
// The groomer picks a ticket by reading `projects/<KEY>/<col>/*.md`, drives an agent to edit
// that FILE, and commits it. Under BLAZE_WRITE_PORT=db the database is the store: the file is
// stale, the agent's edit is read by nothing, and the commit is noise. Until the groomer reads
// and writes through the port (BLZ-673), the supervisor refuses to run it in db mode, and SAYS
// so on the bus rather than going quiet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../scripts/supervisor.mjs";
import { loadConfig } from "../scripts/config.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const TICKET = "---\nid: TASK-001\ntitle: x\ntype: feature\npriority: medium\nlabels: []\n---\nbody\n";

/** A board whose stub agent leaves a marker OUTSIDE the board when it runs, so "a groom ran"
 *  is observable without depending on what the groomer does with the agent's edit. */
function board() {
  const dir = scratch(mkdtempSync(join(tmpdir(), "blaze-groom-dbmode-")));
  const marker = join(scratch(mkdtempSync(join(tmpdir(), "blaze-groom-dbmode-mark-"))), "ran");
  mkdirSync(join(dir, "backlog"), { recursive: true });
  const stub = join(dir, "stub-agent.sh");
  writeFileSync(stub, `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(stub, 0o755);
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({
    key: "TASK", agentCommand: `bash ${stub}`, loops: { groomer: { columns: ["backlog"] } },
  }, null, 2));
  writeFileSync(join(dir, "backlog", "TASK-001-x.md"), TICKET);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
  return { dir, marker };
}

function groomUnder(mode) {
  const { dir, marker } = board();
  const before = process.env.BLAZE_WRITE_PORT;
  process.env.BLAZE_WRITE_PORT = mode;
  const events = [];
  try {
    const app = createApp(loadConfig({ root: dir, env: {} }), { root: dir });
    app.bus.subscribe((e) => events.push(e));
    app.runGroomer();
  } finally {
    if (before === undefined) delete process.env.BLAZE_WRITE_PORT;
    else process.env.BLAZE_WRITE_PORT = before;
  }
  return { events, ran: existsSync(marker) };
}

test("control: under BLAZE_WRITE_PORT=fs the groomer runs the agent", () => {
  // Without this the db-mode assertion below could pass on a fixture that never grooms.
  assert.equal(groomUnder("fs").ran, true);
});

test("under BLAZE_WRITE_PORT=db the groomer is refused, by name, and no groom runs", () => {
  const { events, ran } = groomUnder("db");
  assert.equal(ran, false, "the agent ran against a ticket file the database does not read");
  const errs = events.filter((e) => e.type === "error" && e.loop === "groomer");
  assert.equal(errs.length, 1, JSON.stringify(events));
  assert.match(errs[0].message, /BLAZE_WRITE_PORT=db/);
  assert.match(errs[0].message, /database/);
  assert.match(errs[0].message, /BLZ-254/);
  assert.ok(errs[0].ts, "the event carries a timestamp like every other groomer error");
});
