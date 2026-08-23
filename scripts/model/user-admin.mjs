// scripts/model/user-admin.mjs — `blaze user add` (BLZ-348), implementing ADR-0013 §5.
//
// "The bootstrap token is a user, not an exception." There is no first-admin branch in
// here to find: `addUser` is one call with no knowledge of how many users already exist,
// so the single-operator install exercises the same path the fiftieth user takes. A
// special case only the first install runs is a special case nobody tests.
//
// `serve-auth.mjs`'s bind refusal has named this command since BLZ-304. Until now it
// named nothing — the message was accurate about the fix and wrong about the tool.
import { ROLES, ROLE_SCOPES } from "./identity-schema.mjs";
import { openIdentityDb } from "./identity-db.mjs";

/**
 * Parse `user <verb> [flags]`. Returns errors rather than throwing or exiting: the
 * runner owns the process, this owns the judgement.
 */
export function parseUserArgv(argv) {
  const [verb, ...rest] = argv;
  const errors = [];
  const out = { ok: false, verb: verb ?? null, email: null, role: "member",
                displayName: null, errors };
  if (verb !== "add") {
    errors.push(`unknown user verb ${JSON.stringify(verb ?? "")} — expected: add`);
    return out;
  }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === "--email") { out.email = value ?? null; i++; continue; }
    if (flag === "--role") { out.role = value ?? null; i++; continue; }
    if (flag === "--name") { out.displayName = value ?? null; i++; continue; }
    errors.push(`unknown flag ${JSON.stringify(flag)}`);
  }
  if (!out.email) errors.push("--email <address> is required");
  if (!ROLES.includes(out.role)) {
    errors.push(`unknown role ${JSON.stringify(out.role ?? "")} — expected ${ROLES.join(", ")}`);
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
