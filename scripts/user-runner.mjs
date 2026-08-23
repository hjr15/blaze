#!/usr/bin/env node
// scripts/user-runner.mjs — `blaze user add --email <e> --role <r>` (BLZ-348).
//
// The command `serve-auth.mjs`'s bind refusal has named since BLZ-304. Thin by design:
// argument parsing and the creation itself live in model/user-admin.mjs, where they are
// covered; this owns only the process — stdout, stderr and the exit code.
import { resolveRoots } from "./config.mjs";
import { parseUserArgv, addUser, ensureIdentityIgnored } from "./model/user-admin.mjs";
import { ROLES } from "./model/identity-schema.mjs";
import { identityDbPath } from "./model/identity-db.mjs";

const USAGE = [
  "usage: blaze user add --email <address> [--role <role>] [--name <display name>]",
  "",
  `  --role   ${ROLES.join(" | ")}   (default: member)`,
  "",
  "Creates the user and issues its first API token. The token is printed ONCE and",
  "stored only as a SHA-256 hash — it cannot be read back. Adding the first user",
  "turns authentication on for this board.",
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
} catch (e) {
  console.error(`blaze: ${e.message}`);
  process.exit(1);
}
