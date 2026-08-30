#!/usr/bin/env node
// scripts/user-runner.mjs — `blaze user add --email <e> --role <r>` (BLZ-348).
//
// The command `serve-auth.mjs`'s bind refusal has named since BLZ-304. Thin by design:
// argument parsing and the creation itself live in model/user-admin.mjs, where they are
// covered; this owns only the process — stdout, stderr and the exit code.
import { resolveRoots } from "./config.mjs";
import { parseUserArgv, addUser, setUserPassword, ensureIdentityIgnored } from "./model/user-admin.mjs";
import { MIN_PASSWORD_LENGTH } from "./model/passwords.mjs";
import { ROLES } from "./model/identity-schema.mjs";
import { identityDbPath } from "./model/identity-db.mjs";

const USAGE = [
  "usage: blaze user add    --email <address> [--role <role>] [--name <display name>]",
  "       blaze user passwd --email <address>",
  "",
  `  --role   ${ROLES.join(" | ")}   (default: member)`,
  "",
  "`passwd` sets the password this address signs in with from a browser. It is read",
  `from STDIN — never from a flag, because argv is visible in \`ps\` and is written to`,
  `shell history. Minimum ${MIN_PASSWORD_LENGTH} characters; only a scrypt verifier is stored.`,
  "",
  "Creates the user and issues its first API token. The token is printed ONCE and",
  "stored only as a SHA-256 hash — it cannot be read back. Adding the first user",
  "turns authentication on for this board — for servers started AFTER this command.",
  "A running `blaze board` or `blaze start` read the roster once, at boot; restart it.",
].join("\n");

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
  console.log(USAGE);
  process.exit(argv.length === 0 ? 1 : 0);
}

const parsed = parseUserArgv(argv);
if (!parsed.ok) {
  for (const e of parsed.errors) console.error(`blaze: ${e}`);
  console.error("");
  console.error(USAGE);
  process.exit(1);
}

const { dataRoot } = resolveRoots();

/**
 * Read the password from stdin, and from nowhere else.
 *
 * ECHO IS OFF ON A TTY. Node has no built-in for it, so the prompt is written to stderr
 * and readline's own echo is suppressed — a password typed into a shared terminal must
 * not be left on the screen for the next person, and it must not reach a scrollback
 * buffer that gets pasted into a support ticket.
 *
 * Piped input is read as-is, so `blaze user passwd --email you@example.com < secret` and
 * a password manager's stdout both work without a TTY.
 */
async function readPassword() {
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data.split("\n")[0].replace(/\r$/, "");
  }
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  process.stderr.write("Password: ");
  // The one line that makes it silent: readline asks its output stream to render each
  // keystroke, and this renders nothing at all.
  rl._writeToOutput = () => {};
  try {
    return await new Promise((resolve) => rl.question("", resolve));
  } finally {
    rl.close();
    process.stderr.write("\n");
  }
}

if (parsed.verb === "passwd") {
  try {
    const password = await readPassword();
    const { email } = await setUserPassword(dataRoot, { email: parsed.email, password });
    // The ADDRESS, never the value. Same rule the setup token follows: the path may be
    // named, the secret never may.
    console.log(`password set for ${email}`);
    console.log("");
    console.log("Sign in from a browser at /signin on this board.");
    console.log("API and CLI callers are unaffected — they keep using their `blz_` token.");
    console.log("");
    console.log("NOTE: a server that is ALREADY RUNNING picks this up without a restart —");
    console.log("      unlike `blaze user add`, this changes no roster the server read at boot.");
  } catch (e) {
    // `e.message` and nothing else: the exception object can carry the call that produced
    // it, and that call has the password in it.
    console.error(`blaze: ${e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

try {
  const { user, token } = await addUser(dataRoot, {
    email: parsed.email, role: parsed.role, displayName: parsed.displayName,
  });
  console.log(`user ${user.email} created with role ${user.role}`);
  console.log(`identities: ${identityDbPath(dataRoot)}`);
  // The identity database must never be committable. Reported, never silent — this
  // writes to the operator's .gitignore, and a change to their repo they did not ask
  // for is a change they have to be told about.
  const ignored = ensureIdentityIgnored(dataRoot);
  if (ignored.state === "added") {
    console.log(`note: added '.blaze/' to ${ignored.path} so this is never committed`);
  } else if (ignored.state === "not-a-repo" || ignored.state === "unavailable") {
    console.warn("");
    console.warn(`WARNING: ${identityDbPath(dataRoot)} is NOT covered by a gitignore rule`);
    console.warn("         (this board is not a git work tree, so none could be added).");
    console.warn("         Do not commit it — it holds your user roster and token hashes.");
  }
  console.log("");
  console.log("API token (shown once — copy it now, it is not recoverable):");
  console.log("");
  console.log(`    ${token.token}`);
  console.log("");
  console.log(`scopes: ${token.scopes.join(", ")}`);
  console.log("Use it as:  Authorization: Bearer <token>");
  // BLZ-359. Both servers read the roster ONCE, at boot (serve.mjs:startServer and
  // supervisor.mjs:createApp), so an operator who adds the first user to a board that is
  // already serving gets a board that is still open and no indication of it. Said here
  // because this is the moment they believe they have just turned authentication on.
  console.log("");
  console.log("NOTE: a server that is ALREADY RUNNING does not pick this up — it read the");
  console.log("      roster at boot. Restart `blaze board` / `blaze start` to apply it.");
} catch (e) {
  console.error(`blaze: ${e.message}`);
  process.exit(1);
}
