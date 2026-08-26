// tests/init-first-admin.test.mjs — BLZ-358 AC-6.
//
// The HTTP setup flow exists because a container has no TTY. The shell path has one, and
// it should never reach the refusal either: `blaze init` can create the first admin
// while it is already asking the operator questions.
//
// ADR-0013 section 5 governs both doors — "the first admin is a user, not an exception".
// Neither `blaze init` nor the setup route may grow its own way to make a user.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planInit, questions } from "../scripts/init.mjs";
import { parseArgs, runInit } from "../scripts/init-runner.mjs";
import { loadIdentity } from "../scripts/model/identity-db.mjs";
import { setupTokenPath } from "../scripts/model/setup-token.mjs";

describe("BLZ-358: blaze init offers the first admin", () => {
  test("the wizard asks for it, and says why", () => {
    const q = questions().find((x) => x.key === "adminEmail");
    assert.ok(q, "the terminal wizard must offer what the HTTP flow offers");
    assert.match(q.why, /\S/);
  });

  test("--admin-email is parsed, and the plan carries it", () => {
    assert.equal(parseArgs(["--admin-email=a@b.c"]).adminEmail, "a@b.c");
    const plan = planInit({ dir: "/tmp/x", project: "ENG", adminEmail: "a@b.c" });
    assert.equal(plan.ok, true);
    assert.equal(plan.plan.adminEmail, "a@b.c");
  });

  test("it stays OPTIONAL — a board with no admin is still a legal board", () => {
    // Loopback with no identities is what Blaze has always served, and BLZ-358 must not
    // turn that into a required step.
    const plan = planInit({ dir: "/tmp/x", project: "ENG" });
    assert.equal(plan.ok, true);
    assert.equal(plan.plan.adminEmail, null);
  });

  test("a blank-but-present email is a mistake, not a skip", () => {
    const plan = planInit({ dir: "/tmp/x", project: "ENG", adminEmail: "   " });
    assert.equal(plan.ok, false);
    assert.ok(plan.errors.some((e) => /admin-email/.test(e)));
  });
});

describe("BLZ-358: running it creates a real admin through the ordinary path", () => {
  test("the board ends up with an identity, and the token is shown once", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz358-init-"));
    const dir = join(tmp, "board");
    let out = "";
    const code = await runInit(
      ["--yes", `--dir=${dir}`, "--project=ENG", "--admin-email=ryan@example.com", "--no-git"],
      { log: (m = "") => { out += `${m}\n`; }, err: (m = "") => { out += `${m}\n`; }, isTTY: false },
    );
    try {
      assert.equal(code, 0, out);
      const id = loadIdentity(dir);
      try {
        assert.equal(id.hasIdentity, true, "blaze init must have created the admin");
      } finally { id.close(); }
      assert.match(out, /shown once/i, "the token has to be surfaced, because it is not recoverable");
      assert.match(out, /blz_/, "and it is the real token");
      assert.equal(existsSync(setupTokenPath(dir)), false,
        "a board that already has an admin must never be given a setup token");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("without the flag no identity is created, and nothing pretends otherwise", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz358-init-none-"));
    const dir = join(tmp, "board");
    let out = "";
    const code = await runInit(["--yes", `--dir=${dir}`, "--project=ENG", "--no-git"],
      { log: (m = "") => { out += `${m}\n`; }, err: (m = "") => { out += `${m}\n`; }, isTTY: false });
    try {
      assert.equal(code, 0, out);
      const id = loadIdentity(dir);
      try { assert.equal(id.hasIdentity, false); } finally { id.close(); }
      assert.doesNotMatch(out, /blz_/, "no token can be shown when none was issued");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
