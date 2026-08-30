// scripts/model/user-admin.mjs — `blaze user add` (BLZ-348), implementing ADR-0013 §5.
//
// "The bootstrap token is a user, not an exception." There is no first-admin branch in
// here to find: `addUser` is one call with no knowledge of how many users already exist,
// so the single-operator install exercises the same path the fiftieth user takes. A
// special case only the first install runs is a special case nobody tests.
//
// `serve-auth.mjs`'s bind refusal has named this command since BLZ-304. Until now it
// named nothing — the message was accurate about the fix and wrong about the tool.
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROLES, ROLE_SCOPES } from "./identity-schema.mjs";
import { openIdentityDb, identityDbPath } from "./identity-db.mjs";

/**
 * Parse `user <verb> [flags]`. Returns errors rather than throwing or exiting: the
 * runner owns the process, this owns the judgement.
 */
export const USER_VERBS = ["add", "passwd"];

/**
 * THE BOUNDARY, AND IT IS THE WHOLE OF THE FIX. NO ERROR THIS MODULE CONSTRUCTS
 * INTERPOLATES AN ARGUMENT THE PARSER DID NOT RECOGNISE — not a flag, not a value, not a
 * verb, not a role. An unrecognised argument is named by WHERE it is and never by WHAT it
 * says.
 *
 * THREE ATTEMPTS ENUMERATED SHAPES AND ALL THREE WERE DEFEATED BY A SPELLING NOBODY HAD
 * LISTED, which is why this one does not enumerate:
 *
 *   1. matching the literal `--password`      — nine of ten spellings walked past it
 *   2. a pattern plus a "looks like a flag" test on the text — defeated four ways over:
 *        `blaze user --password=<secret> …`   the unknown-VERB arm returns before either
 *                                             half of the flag handling ever runs
 *        `--pwd -<secret>`                    a VALUE beginning with `-` was read as a
 *                                             flag name and printed whole
 *        `--password<newline><secret>`        misses a `(=|$)` terminator AND is printed
 *                                             whole — the exact "next spelling nobody
 *                                             thought of" the old comment claimed to
 *                                             survive, and that claim was false
 *        `--role <secret>`                    never went through the flag path at all
 *
 * The reason every such attempt loses is worth stating once: NOTHING SYNTACTIC SEPARATES
 * `--pwd` FROM `-correct-horse`. A password may be spelled either way, so there is no test
 * on an argument's text that is safe — including truncating it at `=` or at whitespace,
 * which still emits the first word of a passphrase. The only fact about an unrecognised
 * argument that is certainly not a secret is its POSITION.
 *
 * WHAT MAY STILL BE NAMED is a literal this parser matched by exact equality — `--email`,
 * `--role`, `--name`. Those are constants from this source file, not the operator's text,
 * so naming one repeats nothing the operator supplied.
 *
 * The cost is a less specific message for a plain typo. It is paid down by the usage block
 * `user-runner.mjs` prints alongside every refusal, which lists every verb and flag — and
 * by the fact that the operator has their own command line in front of them.
 */
const REDACTED = "its text is not shown, in case it is a secret";

/** Name an argument by WHERE it is. 1-based, counting the VERB as argument 1 — so
 *  `blaze` and `user` are not counted, and in `blaze user add --email a@b.c` the verb
 *  `add` is 1 and `--email` is 2. Said in the message itself, because an operator
 *  otherwise has to guess whether the two words before the verb count. */
function argAt(position) {
  return `argument ${position}, counting the verb as 1 (${REDACTED})`;
}

/**
 * Every spelling of a password flag this parser recognises well enough to refuse BY NAME.
 *
 * DEFENCE IN DEPTH, NOT THE GUARD. `argAt` above is what makes the leak unrepresentable;
 * this exists so that an operator reaching for the obvious flag is told WHY there is no
 * such thing, rather than being told an argument was unrecognised and trying harder to
 * find the right spelling. It is matched case-insensitively and terminated by `=`,
 * whitespace or end of token, so `--PASSWORD=x` and `--password<newline>x` both land here
 * — but a form it misses is still refused, and still redacted, by the arm below it.
 */
const PASSWORD_FLAG = /^--?(password|passwd|pass|pw|p)(=|\s|$)/i;

/**
 * Parse `user <verb> [flags]`. Returns errors rather than throwing or exiting: the
 * runner owns the process, this owns the judgement.
 */
export function parseUserArgv(argv) {
  const [verb, ...rest] = argv;
  const errors = [];
  const out = { ok: false, verb: verb ?? null, email: null, role: "member",
                displayName: null, errors };
  if (!USER_VERBS.includes(verb)) {
    // REDACTED LIKE EVERY OTHER UNRECOGNISED ARGUMENT. Omitting the verb is an ordinary
    // slip — `blaze user --password=<secret> --email …` — and this arm returns before any
    // flag handling runs, so it was the first of the four proven escapes.
    errors.push(`unknown user verb — ${argAt(1)}. Expected: ${USER_VERBS.join(", ")}`);
    return out;
  }
  // Where `--role` was given, so a bad one can be pointed at without being quoted.
  let rolePosition = null;
  for (let i = 0; i < rest.length; i++) {
    // rest[0] is the argument after the verb, which is argument 2.
    const position = i + 2;
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === "--email") { out.email = value ?? null; i++; continue; }
    if (verb === "add" && flag === "--role") {
      out.role = value ?? null;
      // ONLY WHEN THERE IS AN ARGUMENT THERE TO POINT AT. `--role` as the last token has
      // no value, and `position + 1` then named an argument the operator never typed —
      // sending them hunting argument 5 of a four-argument command. `--role` is a literal
      // this parser matched by exact equality, so naming it is not repeating their text.
      rolePosition = value === undefined ? null : position + 1;
      i++;
      continue;
    }
    if (verb === "add" && flag === "--name") { out.displayName = value ?? null; i++; continue; }
    if (PASSWORD_FLAG.test(String(flag ?? ""))) {
      // THE VALUE IS SWALLOWED when it is a separate token, so the operator gets one
      // refusal rather than a second, unrelated-looking complaint about an argument they
      // never typed as one. It is no longer what stops the leak — `argAt` is — and this
      // comment says so because an earlier revision claimed otherwise and was wrong.
      errors.push(`${argAt(position)} looks like a password flag, and there is no such `
        + "flag: argv is visible in `ps` and recorded in shell history. "
        + "`blaze user passwd --email <address>` reads the password from stdin.");
      if (!/[=\s]/.test(String(flag))) i++;
      continue;
    }
    errors.push(`unknown flag — ${argAt(position)}`);
  }
  if (!out.email) errors.push("--email <address> is required");
  if (verb === "add" && !ROLES.includes(out.role)) {
    // `--role <secret>` was the fourth proven escape: the role never went near the flag
    // path, and this arm quoted it verbatim.
    errors.push(rolePosition === null
      ? `--role was given no value — expected ${ROLES.join(", ")}`
      : `unknown role — ${argAt(rolePosition)}. Expected ${ROLES.join(", ")}`);
  }
  out.ok = errors.length === 0;
  return out;
}

/**
 * Create a user and issue its first token.
 *
 * The token's scopes are the role's OWN scopes, not a widening of them — and they are
 * re-intersected with the role on every request anyway (identity.mjs), so demoting this
 * user later narrows this token without touching it.
 *
 * @returns { user, token } — `token.token` is the plaintext, which exists exactly once,
 *   here, and is never stored. A caller that drops it has to issue another.
 */
export async function addUser(dataRoot, { email, role = "member", displayName = null } = {}) {
  if (!ROLES.includes(role)) {
    throw new Error(`unknown role ${JSON.stringify(role)} — expected ${ROLES.join(", ")}`);
  }
  if (!String(email ?? "").trim()) throw new Error("a user needs an email address");

  const opened = openIdentityDb(dataRoot, { create: true });
  try {
    const user = await opened.store.createUser({ email, displayName, role });
    const token = await opened.store.issueToken({
      userId: user.id, name: `${user.email} initial token`, scopes: ROLE_SCOPES[role],
    });
    return { user, token };
  } finally {
    try { opened.db.close(); } catch { /* already closed */ }
  }
}

/**
 * Set an existing user's password, so they can sign in from a browser (BLZ-566).
 *
 * THIS IS THE RECOVERY PATH FOR A BOARD THAT IS ALREADY LOCKED OUT — the shape this
 * ticket was filed from: an admin exists, identity.db exists, and no credential over HTTP
 * could authorise setting a password because obtaining one is the thing that is blocked.
 * A command on the host needs exactly the filesystem privilege that reading identity.db
 * already needs, so it grants nothing new; that is the same argument setup-token.mjs makes
 * for writing its token to a file instead of serving it.
 *
 * `create: false`. Unlike `addUser`, this must never MATERIALISE a roster: setting a
 * password against the wrong data root would otherwise leave a new, empty identity.db that
 * silently turns authentication on for a board that had none.
 *
 * The password itself is never logged, never returned, and never put in an error message.
 */
export async function setUserPassword(dataRoot, { email, password } = {}) {
  const opened = openIdentityDb(dataRoot);
  if (!opened) {
    throw new Error(`no users are configured for this board (${identityDbPath(dataRoot)} does not `
      + "exist) — create one first with: blaze user add --email <address> --role admin");
  }
  try {
    // The policy check and the "no such user" refusal both live in the store, where the
    // HTTP setup path reaches them too. One floor, three call sites.
    await opened.store.setPassword({ email, password });
    return { email: String(email).trim().toLowerCase() };
  } finally {
    try { opened.db.close(); } catch { /* already closed */ }
  }
}

/**
 * Make sure `.blaze/` is actually ignored before an identity database lands in it.
 *
 * `blaze init` appends this rule, so a board it created is already covered — but a board
 * that predates it, or one assembled by hand, is not, and `blaze user add` would leave
 * the identity database one `git add -A` from being committed. "It is gitignored" was a
 * conditional claim stated as an unconditional one.
 *
 * Asked of git rather than by reading .gitignore: the rule can legitimately live in a
 * parent .gitignore, in .git/info/exclude, or in the user's global excludesFile, and
 * appending a duplicate in those cases would be noise.
 *
 * @returns { state, path } — 'already' | 'added' | 'not-a-repo' | 'unavailable'
 */
export function ensureIdentityIgnored(dataRoot) {
  const gitignore = join(dataRoot, ".gitignore");
  const git = (...args) => spawnSync("git", ["-C", dataRoot, ...args], { encoding: "utf8" });

  const inside = git("rev-parse", "--is-inside-work-tree");
  if (inside.error) return { state: "unavailable", path: gitignore };
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return { state: "not-a-repo", path: gitignore };
  }
  // --no-index: the path need not exist yet, and check-ignore is the only thing that
  // knows about every source of ignore rules.
  if (git("check-ignore", "--no-index", "-q", ".blaze/identity.db").status === 0) {
    return { state: "already", path: gitignore };
  }
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(gitignore,
    `${prefix}\n# Blaze runtime state, including identity.db — never commit credentials\n.blaze/\n`);
  return { state: "added", path: gitignore };
}
