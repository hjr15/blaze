// tests/user-add.test.mjs — BLZ-348: `blaze user add`.
//
// ADR-0013 §5: "the bootstrap token is a user, not an exception". There is no separate
// first-admin path — the first user and the fiftieth take the same call, so the
// single-operator case exercises exactly the code every later case uses.
//
// `serve-auth.mjs`'s bind refusal has named `blaze user add --email … --role admin`
// since BLZ-304, and the command did not exist. An error message that names a command
// nobody can run is worse than no message.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { addUser, parseUserArgv } from "../scripts/model/user-admin.mjs";
import { identityDbPath, loadIdentity } from "../scripts/model/identity-db.mjs";
import { TOKEN_PREFIX } from "../scripts/model/identity.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cli.mjs");
const boardRoot = () => mkdtempSync(join(tmpdir(), "blaze-useradd-"));

describe("blaze user add creates a user and issues its token", () => {
  test("the first user is created through the ordinary path and gets a `blz_` token",
    async () => {
      const root = boardRoot();
      assert.equal(loadIdentity(root).hasIdentity, false, "no identity before the first add");

      const { user, token } = await addUser(root, { email: "First@Example.com", role: "admin" });
      assert.equal(user.email, "first@example.com", "email is folded on the way in");
      assert.equal(user.role, "admin");
      assert.ok(token.token.startsWith(TOKEN_PREFIX), `expected a ${TOKEN_PREFIX} token`);
      assert.deepEqual(token.scopes, ["read", "write", "admin"]);
      assert.ok(existsSync(identityDbPath(root)));

      const after = loadIdentity(root);
      assert.equal(after.hasIdentity, true);
      after.close();
    });

  test("the SECOND user takes exactly the same call — there is no bootstrap special case",
    async () => {
      const root = boardRoot();
      const first = await addUser(root, { email: "one@example.com", role: "admin" });
      const second = await addUser(root, { email: "two@example.com", role: "viewer" });
      assert.notEqual(first.user.id, second.user.id);
      assert.deepEqual(second.token.scopes, ["read"], "a viewer's token cannot exceed the role");

      const { store, close } = loadIdentity(root);
      const users = await store.listUsers();
      assert.deepEqual(users.map((u) => `${u.email}:${u.role}`),
        ["one@example.com:admin", "two@example.com:viewer"]);
      close();
    });

  test("the token is shown ONCE: only its hash is stored, so it cannot be read back",
    async () => {
      const root = boardRoot();
      const { user, token } = await addUser(root, { email: "once@example.com", role: "member" });
      const { store, close } = loadIdentity(root);
      const rows = await store.listTokens(user.id);
      close();
      assert.equal(rows.length, 1);
      assert.equal(JSON.stringify(rows).includes(token.token), false,
        "the plaintext must not be recoverable from the database");
    });

  test("an unknown role is refused rather than stored", async () => {
    const root = boardRoot();
    await assert.rejects(() => addUser(root, { email: "x@example.com", role: "superuser" }),
      /unknown role "superuser"/);
    assert.equal(loadIdentity(root).hasIdentity, false);
  });

  test("an email is required", async () => {
    const root = boardRoot();
    await assert.rejects(() => addUser(root, { email: "", role: "admin" }), /email/i);
  });
});

describe("the argv the error message promises", () => {
  test("`user add --email <e> --role <r>` parses", () => {
    const r = parseUserArgv(["add", "--email", "you@example.com", "--role", "admin"]);
    assert.deepEqual(r, { ok: true, verb: "add", email: "you@example.com",
                          role: "admin", displayName: null, errors: [] });
  });

  test("--role defaults to member, and a missing --email is an error not a crash", () => {
    assert.equal(parseUserArgv(["add", "--email", "a@b.c"]).role, "member");
    const bad = parseUserArgv(["add"]);
    assert.equal(bad.ok, false);
    assert.match(bad.errors.join(" "), /--email/);
  });

  test("an unknown verb is refused", () => {
    const r = parseUserArgv(["delete", "--email", "a@b.c"]);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(" "), /unknown/i);
  });
});

describe("the CLI verb the refusal message names", () => {
  test("`blaze user add` runs and prints the token exactly once", () => {
    const root = boardRoot();
    const out = execFileSync(process.execPath,
      [CLI, "user", "add", "--email", "cli@example.com", "--role", "admin"],
      { encoding: "utf8", env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") } });
    const tokens = out.match(/blz_[A-Za-z0-9_-]+/g) ?? [];
    assert.equal(tokens.length, 1, `the token must be printed exactly once, got:\n${out}`);
    assert.match(out, /shown once/i);
    assert.ok(existsSync(identityDbPath(root)), "the identity database lands in the board root");
  });

  test("`blaze user --help` describes the verb", () => {
    const out = execFileSync(process.execPath, [CLI, "user", "--help"], { encoding: "utf8" });
    assert.match(out, /usage: blaze user/);
  });
});
