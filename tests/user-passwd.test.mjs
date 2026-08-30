// tests/user-passwd.test.mjs — BLZ-566: `blaze user passwd`.
//
// The board that is ALREADY locked out — the one this ticket was filed from — has an
// admin, an identity.db and no password, and no credential over HTTP that could authorise
// setting one. So the recovery path is a command on the host, which needs exactly the
// filesystem privilege that reading identity.db already needs and therefore grants
// nothing new. That is the same argument setup-token.mjs makes for writing its token to a
// file rather than serving it.
//
// THE PASSWORD NEVER APPEARS IN argv. `ps`, a shell history file and every process
// listing on the box would carry it, and the operator would have no idea. It comes in on
// stdin, and `parseUserArgv` has no flag that could take it.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { addUser, parseUserArgv, setUserPassword } from "../scripts/model/user-admin.mjs";
import { identityDbPath, loadIdentity } from "../scripts/model/identity-db.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "cli.mjs");
const roots = [];
function boardRoot() {
  const root = mkdtempSync(join(tmpdir(), "blaze-userpasswd-"));
  roots.push(root);
  return root;
}
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const PASSWORD = "correct horse battery staple";

describe("NO ERROR THIS PARSER PRODUCES EVER CONTAINS AN ARGUMENT IT DID NOT RECOGNISE",
  () => {
    // THE PROPERTY, SWEPT — NOT A LIST OF ARMS. Three earlier versions of this suite tested
    // arms: first the literal `--password`, then ten spellings of a password flag. Each
    // time the fix closed the listed shapes and the property stayed open somewhere else —
    // the unknown-VERB arm (which returns before any flag handling runs), a VALUE beginning
    // with `-` read as a flag name, `--password<newline><value>`, and `unknown role`, which
    // never went near the flag path. A per-arm test invites exactly that round again.
    //
    // So this drives a secret through every position of every command shape the parser
    // accepts, in every form a secret can take in argv, and asserts one thing: it never
    // comes back out. A new arm added to the parser is covered the moment it can be
    // reached by any of these, without anyone remembering to extend a list.

    /** Every way a secret can turn up as an argv token. */
    const FORMS = [
      PASSWORD, `-${PASSWORD}`, `--${PASSWORD}`, `-p${PASSWORD}`,
      `--password=${PASSWORD}`, `--Password=${PASSWORD}`, `--pwd=${PASSWORD}`,
      `-p=${PASSWORD}`, `--pass=${PASSWORD}`, `--password\n${PASSWORD}`,
      `--pwd\t${PASSWORD}`, `--role=${PASSWORD}`, `--email=${PASSWORD}`,
      `=${PASSWORD}`, `${PASSWORD}=x`,
    ];

    /** Every command shape, including the malformed ones an operator actually types. */
    const SKELETONS = [
      [], ["add"], ["passwd"], ["frobnicate"],
      ["add", "--email", "op@example.com"],
      ["passwd", "--email", "op@example.com"],
      ["add", "--email", "op@example.com", "--role", "admin"],
      ["add", "--email", "op@example.com", "--role"],
      ["add", "--email", "op@example.com", "--name"],
      ["passwd", "--email"],
      ["passwd", "--email", "op@example.com", "--bogus"],
      ["passwd", "--email", "op@example.com", "--pwd"],
    ];

    test("a secret placed at every position of every command shape never comes back",
      () => {
        let cases = 0;
        let erroring = 0;
        for (const skeleton of SKELETONS) {
          for (const form of FORMS) {
            for (let at = 0; at <= skeleton.length; at++) {
              const argv = [...skeleton.slice(0, at), form, ...skeleton.slice(at)];
              const parsed = parseUserArgv(argv);
              cases += 1;
              if (parsed.errors.length) erroring += 1;
              assert.doesNotMatch(parsed.errors.join(" \n"), /correct horse battery staple/,
                `leaked from ${JSON.stringify(argv)}`);
              // AND NO ERROR POINTS AT AN ARGUMENT THAT DOES NOT EXIST. Redaction makes
              // the position the ONLY handle the operator has, so a position that is
              // wrong is not cosmetic — it sends them hunting an argument they never
              // typed. Swept here rather than tested per arm for the same reason the
              // leak is.
              for (const m of parsed.errors.join(" ").matchAll(/argument (\d+)/g)) {
                assert.ok(Number(m[1]) <= argv.length,
                  `points at argument ${m[1]} of a ${argv.length}-argument command: `
                  + JSON.stringify(argv));
              }
            }
          }
        }
        // ASSERT THE OBSERVATION HAPPENED. A sweep in which nothing ever errored would pass
        // this test while proving nothing at all about the error paths it claims to cover.
        assert.ok(cases > 500, `expected a real sweep, ran ${cases} cases`);
        assert.ok(erroring > cases * 0.8,
          `only ${erroring}/${cases} cases reached an error path — the sweep is not `
          + "exercising the arms it claims to");
      });

    test("…and the four escapes found by review are each closed", () => {
      // Named individually as well as swept, because a regression in any one of them is a
      // specific thing a reader should be able to find by name.
      const escapes = {
        "the unknown-VERB arm, which returns before any flag handling":
          [`--password=${PASSWORD}`, "--email", "op@example.com"],
        "a VALUE beginning with a dash, read as a flag name":
          ["passwd", "--email", "op@example.com", "--pwd", `-${PASSWORD}`],
        "a password flag with a newline instead of an = or a space":
          ["passwd", "--email", "op@example.com", `--password\n${PASSWORD}`],
        "the unknown-ROLE arm, which never went near the flag path":
          ["add", "--email", "op@example.com", "--role", PASSWORD],
      };
      for (const [why, argv] of Object.entries(escapes)) {
        const parsed = parseUserArgv(argv);
        assert.equal(parsed.ok, false, why);
        assert.doesNotMatch(parsed.errors.join(" "), /correct horse battery staple/, why);
      }
    });

    test("`--role` given no value names the FLAG, not an argument past the end", () => {
      // `blaze user add --email a@b.c --role` is four arguments. Pointing at "argument 5"
      // — which it did — is worse than saying nothing, because the position is the only
      // handle redaction leaves the operator. `--role` is a literal matched by exact
      // equality, so naming it repeats nothing they supplied.
      const argv = ["add", "--email", "a@b.c", "--role"];
      const p = parseUserArgv(argv);
      assert.equal(p.ok, false);
      assert.match(p.errors.join(" "), /--role was given no value/);
      for (const m of p.errors.join(" ").matchAll(/argument (\d+)/g)) {
        assert.ok(Number(m[1]) <= argv.length,
          `points at argument ${m[1]} of a ${argv.length}-argument command`);
      }
    });

    test("the position an error names is counted from the VERB, and says so", () => {
      // Without the clause the operator has to infer whether `blaze` and `user` count.
      const p = parseUserArgv(["add", "--email", "a@b.c", "--role", "superuser"]);
      assert.match(p.errors.join(" "), /argument 5, counting the verb as 1/);
    });

    test("an unrecognised argument is named by POSITION, which is what makes it usable",
      () => {
        // The redaction is not silence. The operator is told which argument was rejected
        // and what was expected there, and `user-runner.mjs` prints the usage block — which
        // lists every verb and flag — alongside it.
        const p = parseUserArgv(["passwd", "--email", "op@example.com", "--bogus"]);
        assert.match(p.errors.join(" "), /argument 4/);
        const r = parseUserArgv(["add", "--email", "op@example.com", "--role", "superuser"]);
        assert.match(r.errors.join(" "), /argument 5/);
        assert.match(r.errors.join(" "), /expected admin, member, viewer/i);
      });

    test("a literal the parser matched EXACTLY may still be named — it is our constant, "
      + "not their text", () => {
      // The line the boundary draws. `--role` here came from a string literal in
      // user-admin.mjs; repeating it repeats nothing the operator supplied.
      const p = parseUserArgv(["add", "--email", "op@example.com", "--role", "superuser"]);
      assert.match(p.errors.join(" "), /unknown role/);
    });

    test("`passwd --email <address>` parses", () => {
      const p = parseUserArgv(["passwd", "--email", "op@example.com"]);
      assert.equal(p.ok, true);
      assert.equal(p.verb, "passwd");
      assert.equal(p.email, "op@example.com");
    });

    test("`passwd` with no --email is refused", () => {
      assert.equal(parseUserArgv(["passwd"]).ok, false);
    });

    test("a password flag is refused BY NAME, with the reason — defence in depth", () => {
      // `PASSWORD_FLAG` is no longer what stops the leak; `argAt` is. It stays so that an
      // operator reaching for the obvious flag is told WHY there is no such thing rather
      // than trying harder to find the right spelling.
      for (const form of [["--password", PASSWORD], [`--password=${PASSWORD}`],
                          ["-p", PASSWORD], [`--PASS=${PASSWORD}`],
                          [`--password\n${PASSWORD}`]]) {
        const said = parseUserArgv(["passwd", "--email", "op@example.com", ...form]).errors.join(" ");
        assert.match(said, /looks like a password flag/, `${form[0]} must be recognised`);
        assert.match(said, /stdin/);
      }
    });

    test("a password flag consumes its separate value, so the operator gets ONE error", () => {
      // WHAT THE SWALLOW BUYS, PINNED HONESTLY — and it is NOT the leak. Measured: removing
      // the `i++` leaves the whole sweep above green, because an unrecognised argument is
      // never rendered. What it buys is that the operator is not also told about an
      // argument they never typed as one. An earlier revert row claimed this hunk was
      // load-bearing for the leak; that measurement was taken against a baseline where the
      // fix had been checked out from under it, and it was wrong.
      const p = parseUserArgv(["passwd", "--email", "op@example.com", "--password", PASSWORD]);
      assert.equal(p.errors.length, 1, `expected one refusal, got: ${JSON.stringify(p.errors)}`);
      assert.match(p.errors[0], /looks like a password flag/);
    });

    test("an unknown verb is still refused, and names what it expected", () => {
      const p = parseUserArgv(["frobnicate"]);
      assert.equal(p.ok, false);
      assert.match(p.errors.join(" "), /add/);
      assert.match(p.errors.join(" "), /passwd/);
    });

    test("there is no --password field on the parsed result to put one in", () => {
      const p = parseUserArgv(["passwd", "--email", "op@example.com", "--password", PASSWORD]);
      assert.equal("password" in p, false);
    });
  });

describe("setUserPassword makes an existing account signable-into", () => {
  test("an admin created before this feature existed can sign in afterwards", async () => {
    const root = boardRoot();
    await addUser(root, { email: "op@example.com", role: "admin" });
    await setUserPassword(root, { email: "op@example.com", password: PASSWORD });

    const id = loadIdentity(root);
    try {
      assert.equal((await id.store.signIn({ email: "op@example.com", password: PASSWORD })).ok, true);
    } finally { id.close(); }
  });

  test("it replaces an existing password rather than adding a second one", async () => {
    const root = boardRoot();
    await addUser(root, { email: "op@example.com", role: "admin" });
    await setUserPassword(root, { email: "op@example.com", password: PASSWORD });
    await setUserPassword(root, { email: "op@example.com", password: "a different passphrase" });

    const id = loadIdentity(root);
    try {
      assert.equal((await id.store.signIn({ email: "op@example.com", password: PASSWORD })).ok, false);
      assert.equal((await id.store.signIn({ email: "op@example.com", password: "a different passphrase" })).ok, true);
    } finally { id.close(); }
  });

  test("a board with no roster at all is refused, not silently given one", async () => {
    const root = boardRoot();
    await assert.rejects(() => setUserPassword(root, { email: "op@example.com", password: PASSWORD }),
      /no users are configured/);
  });

  test("a weak password is refused and nothing is stored", async () => {
    const root = boardRoot();
    await addUser(root, { email: "op@example.com", role: "admin" });
    await assert.rejects(() => setUserPassword(root, { email: "op@example.com", password: "short" }),
      /at least 12 characters/);
    const id = loadIdentity(root);
    try {
      assert.equal((await id.store.signIn({ email: "op@example.com", password: "short" })).ok, false);
    } finally { id.close(); }
  });
});

describe("the command reads the password from stdin and prints it nowhere", () => {
  test("`blaze user passwd --email <address>` sets it, and echoes no secret", async () => {
    const root = boardRoot();
    await addUser(root, { email: "op@example.com", role: "admin" });
    const r = spawnSync(process.execPath, [CLI, "user", "passwd", "--email", "op@example.com"], {
      cwd: root, input: `${PASSWORD}\n`, encoding: "utf8",
      env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") },
    });
    assert.equal(r.status, 0, r.stderr);
    const said = `${r.stdout}${r.stderr}`;
    assert.doesNotMatch(said, /correct horse battery staple/,
      "a password that reaches a terminal or a log is a password that has to be changed");
    assert.match(said, /password set/i);

    const id = loadIdentity(root);
    try {
      assert.equal((await id.store.signIn({ email: "op@example.com", password: PASSWORD })).ok, true);
    } finally { id.close(); }
  });

  test("a refusal names the reason and still echoes no secret", async () => {
    const root = boardRoot();
    await addUser(root, { email: "op@example.com", role: "admin" });
    const r = spawnSync(process.execPath, [CLI, "user", "passwd", "--email", "op@example.com"], {
      cwd: root, input: "short\n", encoding: "utf8", env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") },
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /at least 12 characters/);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /\bshort\b/);
  });

  test("no argv shape reaches STDERR through the real CLI", async () => {
    // The parser sweep pins the errors ARRAY. This pins the channel review actually named:
    // terminal scrollback, CI logs, and any stderr capture. The runner prints every parse
    // error AND the usage block to stderr and exits 1, so this is the end of the path — and
    // these are the four shapes that were proven to leak through it.
    const root = boardRoot();
    await addUser(root, { email: "op@example.com", role: "admin" });
    const shapes = [
      [`--password=${PASSWORD}`, "--email", "op@example.com"],
      ["passwd", "--email", "op@example.com", "--pwd", `-${PASSWORD}`],
      ["passwd", "--email", "op@example.com", `--password\n${PASSWORD}`],
      ["add", "--email", "op@example.com", "--role", PASSWORD],
      ["passwd", "--email", "op@example.com", "--bogus", PASSWORD],
      ["passwd", "--email", "op@example.com", `--pass=${PASSWORD}`],
      [PASSWORD],
    ];
    for (const shape of shapes) {
      const r = spawnSync(process.execPath, [CLI, "user", ...shape], {
        cwd: root, encoding: "utf8", input: "",
        env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") },
      });
      assert.equal(r.status, 1, `${JSON.stringify(shape)} must be refused`);
      assert.doesNotMatch(`${r.stdout}${r.stderr}`, /correct horse battery staple/,
        `${JSON.stringify(shape)} echoed the secret to stderr`);
    }
  });

  test("the password never lands in identity.db in the clear", async () => {
    const root = boardRoot();
    await addUser(root, { email: "op@example.com", role: "admin" });
    await setUserPassword(root, { email: "op@example.com", password: PASSWORD });
    assert.equal(readFileSync(identityDbPath(root)).includes(Buffer.from(PASSWORD)), false);
  });
});
