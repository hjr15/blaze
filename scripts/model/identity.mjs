// scripts/model/identity.mjs — issuing and verifying tokens (blaze-pm BLZ-303),
// implementing ADR-0013.
//
// The judgement is PURE and the I/O is per-driver, the same split BLZ-297 arrived at:
// `effectiveScopes` and `authorise` decide, and never touch a database. An async guard
// cannot serve a synchronous driver at all — `.then` always defers to a microtask — and
// the policy is the part worth testing exhaustively anyway.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ROLE_SCOPES, SCOPES } from "./identity-schema.mjs";

/** Tokens are recognisable in a log or a paste, and matchable by secret-scanning. */
export const TOKEN_PREFIX = "blz_";

/** A token's plaintext, generated once and never stored. */
export function generateToken() {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** What goes in the database. SHA-256: a dump must not yield working credentials. */
export function hashToken(plaintext) {
  return createHash("sha256").update(String(plaintext)).digest("hex");
}

/** Constant-time compare, so a mismatch cannot be timed to recover the value. */
export function tokenMatches(plaintext, storedHash) {
  const a = Buffer.from(hashToken(plaintext), "hex");
  const b = Buffer.from(String(storedHash ?? ""), "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * THE INVARIANT: a token carries a subset of its owner's access at the moment it is
 * used — never a superset, and never a frozen copy.
 *
 * The scopes are intersected with the owner's CURRENT role on every request, so
 * revoking a user's write access immediately narrows every token they ever created,
 * with no token bookkeeping. The failure this prevents is the ordinary one: someone
 * with write access issues a token, later moves to read-only, and the token keeps
 * writing because its scopes were copied at issue time rather than derived at use time.
 */
export function effectiveScopes({ role, tokenScopes }) {
  const fromRole = new Set(ROLE_SCOPES[role] ?? []);
  const asked = Array.isArray(tokenScopes) ? tokenScopes : String(tokenScopes ?? "").split(",");
  return SCOPES.filter((s) => fromRole.has(s) && asked.map((x) => String(x).trim()).includes(s));
}

/**
 * May a caller with these scopes perform this operation?
 *
 * Unknown operations are DENIED rather than allowed. A new endpoint that nobody
 * remembered to classify must fail closed — a default-allow here would mean every
 * future route ships unauthorised until someone notices.
 */
export const OPERATION_SCOPE = {
  read: "read", write: "write", admin: "admin",
};

export function authorise({ scopes, operation }) {
  const need = OPERATION_SCOPE[operation];
  if (!need) return { ok: false, error: `unknown operation ${JSON.stringify(operation)} — denied` };
  if (!scopes.includes(need)) {
    return { ok: false, error: `this token does not carry the '${need}' scope` };
  }
  return { ok: true, error: null };
}

/**
 * Validate the scopes a user is ASKING for when issuing a token.
 *
 * Refused at issue time as well as intersected at use time. Both matter: the
 * intersection makes an over-broad token harmless, and the refusal means nobody is
 * handed a token that silently does less than the API said it would.
 */
export function checkRequestedScopes({ role, requested }) {
  const allowed = new Set(ROLE_SCOPES[role] ?? []);
  const asked = (Array.isArray(requested) ? requested : String(requested ?? "").split(","))
    .map((s) => String(s).trim()).filter(Boolean);
  if (!asked.length) return { ok: false, error: "a token must request at least one scope" };

  const unknown = asked.filter((s) => !SCOPES.includes(s));
  if (unknown.length) {
    return { ok: false, error: `unknown scope(s): ${unknown.join(", ")} — expected ${SCOPES.join(", ")}` };
  }
  const beyond = asked.filter((s) => !allowed.has(s));
  if (beyond.length) {
    return { ok: false, error:
      `a ${role} cannot issue a token with scope(s): ${beyond.join(", ")}. `
      + "A token is a delegation of your own access, never an escalation of it." };
  }
  return { ok: true, error: null, scopes: SCOPES.filter((s) => asked.includes(s)) };
}

/** Is this token row usable at all, independent of what it may do? */
export function tokenUsable(row, { now = new Date().toISOString() } = {}) {
  if (!row) return { ok: false, error: "no such token" };
  if (row.revoked_at) return { ok: false, error: "this token has been revoked" };
  if (row.expires_at && String(row.expires_at) <= now) return { ok: false, error: "this token has expired" };
  return { ok: true, error: null };
}

/**
 * The whole decision, from a presented token to a verdict. Pure — the caller supplies
 * the rows.
 *
 * @param presented  the plaintext from the Authorization header
 * @param lookup     (hash) => { token, user, membership } | null
 */
export function verify({ presented, lookup, operation, now }) {
  const raw = String(presented ?? "").trim();
  if (!raw) return { ok: false, status: 401, error: "no credentials supplied" };
  if (!raw.startsWith(TOKEN_PREFIX)) {
    // Named rather than silently rejected: an operator pasting a password or a CSRF
    // token here should be told what shape was expected.
    return { ok: false, status: 401,
             error: `not a Blaze token — expected one beginning ${TOKEN_PREFIX}` };
  }

  // Looked up BY HASH, never by a scan-and-compare: the database never sees the
  // plaintext, and there is nothing to iterate over in constant time.
  const found = lookup(hashToken(raw));
  if (!found?.token) return { ok: false, status: 401, error: "unknown token" };

  const usable = tokenUsable(found.token, { now });
  if (!usable.ok) return { ok: false, status: 401, error: usable.error };

  if (found.user?.status !== "active") {
    return { ok: false, status: 403, error: "the account this token belongs to is not active" };
  }
  if (!found.membership?.role) {
    return { ok: false, status: 403, error: "the account this token belongs to has no access" };
  }

  const scopes = effectiveScopes({ role: found.membership.role,
                                   tokenScopes: found.token.scopes });
  if (!scopes.length) {
    return { ok: false, status: 403,
             error: "this token's scopes no longer overlap its owner's access" };
  }
  const allowed = authorise({ scopes, operation });
  if (!allowed.ok) return { ok: false, status: 403, error: allowed.error };

  return { ok: true, status: 200, error: null,
           principal: { userId: found.user.id, email: found.user.email,
                        role: found.membership.role, scopes,
                        tokenId: found.token.id, tokenName: found.token.name } };
}

/** How the event log names this caller. `actor` has existed and never been set. */
export function actorFor(principal) {
  if (!principal) return "unknown";
  return `${principal.email} (${principal.tokenName})`;
}
