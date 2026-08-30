// scripts/model/identity-store.mjs — the I/O half of identity (blaze-pm BLZ-304).
//
// The POLICY lives in identity.mjs and is pure. This is the part that touches a
// database, and it is deliberately thin: every decision it appears to make is actually
// made by a pure function it calls. Splitting it this way is the same shape BLZ-297
// arrived at — and for the same hard reason, since a synchronous driver cannot await.
import { randomUUID } from "node:crypto";
import { generateToken, generateSessionToken, hashToken, checkRequestedScopes, verify,
         SESSION_PREFIX, TOKEN_PREFIX } from "./identity.mjs";
import { ROLE_SCOPES } from "./identity-schema.mjs";
import { checkPasswordPolicy, hashPassword, verifyAgainst } from "./passwords.mjs";

const ph = (dialect, i) => (dialect === "postgres" ? `$${i + 1}` : "?");

/**
 * How long a browser session lives. Twelve hours: one working day, so an operator signs
 * in once in the morning; short enough that a cookie lifted off a shared machine is not
 * a standing grant. Fixed, not sliding — a sliding window on an ambient credential is a
 * session that never actually expires for anyone who keeps a tab open.
 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * @param exec     { run, all } — sync for node:sqlite, async for pg
 * @param dialect  'sqlite' | 'postgres'
 */
export function identityStore(exec, { dialect = "sqlite", now = () => new Date().toISOString() } = {}) {
  if (dialect !== "sqlite" && dialect !== "postgres") {
    throw new Error(`unknown dialect ${JSON.stringify(dialect)} — expected 'sqlite' or 'postgres'`);
  }
  const p = (i) => ph(dialect, i);

  const api = {
    /** Email is folded on the way in, so uniqueness is genuinely case-insensitive. */
    async createUser({ email, displayName, role = "member", scopeKey = "*" }) {
      const id = randomUUID();
      const at = now();
      const folded = String(email ?? "").trim().toLowerCase();
      if (!folded) throw new Error("a user needs an email address");
      await exec.run(
        `INSERT INTO app_user (id, email, display_name, status, created_at)
         VALUES (${p(0)}, ${p(1)}, ${p(2)}, 'active', ${p(3)})`,
        [id, folded, String(displayName ?? folded), at]);
      await exec.run(
        `INSERT INTO membership (user_id, scope_key, role, created_at)
         VALUES (${p(0)}, ${p(1)}, ${p(2)}, ${p(3)})`,
        [id, scopeKey, role, at]);
      // Every user gets a local identity row, even before an external provider exists.
      // The alternative — rows only for external providers — makes `user_identity`
      // mean two different things depending on how the user signed up.
      await exec.run(
        `INSERT INTO user_identity (provider, subject, user_id, created_at)
         VALUES ('local', ${p(0)}, ${p(1)}, ${p(2)})`,
        [folded, id, at]);
      return { id, email: folded, role };
    },

    /**
     * Issue a token. Returns the plaintext ONCE — it is never stored and cannot be
     * recovered, so a caller that discards it has to issue another.
     */
    async issueToken({ userId, name, scopes, expiresAt = null }) {
      const rows = await exec.all(
        `SELECT role FROM membership WHERE user_id = ${p(0)} AND scope_key = '*'`, [userId]);
      const role = rows?.[0]?.role;
      if (!role) throw new Error("cannot issue a token for a user with no access");

      // Refused at issue AND intersected at use. Both: the intersection makes an
      // over-broad token harmless, and the refusal means nobody is handed a token that
      // silently does less than they asked for.
      const checked = checkRequestedScopes({ role, requested: scopes });
      if (!checked.ok) throw new Error(checked.error);

      const plaintext = generateToken();
      const id = randomUUID();
      await exec.run(
        `INSERT INTO api_token (id, user_id, name, token_hash, scopes, created_at, expires_at)
         VALUES (${p(0)}, ${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)})`,
        [id, userId, String(name ?? "token"), hashToken(plaintext),
         checked.scopes.join(","), now(), expiresAt]);
      return { id, name, scopes: checked.scopes, token: plaintext };
    },

    async revokeToken(tokenId) {
      await exec.run(
        `UPDATE api_token SET revoked_at = ${p(0)} WHERE id = ${p(1)} AND revoked_at IS NULL`,
        [now(), tokenId]);
    },

    /** By hash, never by scanning: the database never sees a plaintext token. */
    async lookupByHash(hash) {
      const rows = await exec.all(
        `SELECT t.id AS token_id, t.name, t.scopes, t.revoked_at, t.expires_at,
                u.id AS user_id, u.email, u.status,
                m.role
           FROM api_token t
           JOIN app_user u ON u.id = t.user_id
           LEFT JOIN membership m ON m.user_id = u.id AND m.scope_key = '*'
          WHERE t.token_hash = ${p(0)}`, [hash]);
      const r = rows?.[0];
      if (!r) return null;
      return {
        token: { id: r.token_id, name: r.name, scopes: r.scopes,
                 revoked_at: r.revoked_at, expires_at: r.expires_at },
        user: { id: r.user_id, email: r.email, status: r.status },
        membership: r.role ? { role: r.role } : null,
      };
    },

    async touchToken(tokenId) {
      await exec.run(`UPDATE api_token SET last_used_at = ${p(0)} WHERE id = ${p(1)}`,
        [now(), tokenId]);
    },

    async listUsers() {
      return (await exec.all(
        `SELECT u.id, u.email, u.display_name, u.status, m.role
           FROM app_user u LEFT JOIN membership m ON m.user_id = u.id AND m.scope_key = '*'
          ORDER BY u.email`, [])) ?? [];
    },

    async listTokens(userId) {
      return (await exec.all(
        `SELECT id, name, scopes, created_at, last_used_at, expires_at, revoked_at
           FROM api_token WHERE user_id = ${p(0)} ORDER BY created_at`, [userId])) ?? [];
    },

    async setRole({ userId, role, scopeKey = "*" }) {
      // The whole point of the invariant: this narrows every token the user holds,
      // immediately, without touching a single token row.
      await exec.run(
        `UPDATE membership SET role = ${p(0)} WHERE user_id = ${p(1)} AND scope_key = ${p(2)}`,
        [role, userId, scopeKey]);
    },

    async anyUsers() {
      const rows = await exec.all("SELECT count(*) AS n FROM app_user", []);
      return Number(rows?.[0]?.n ?? 0) > 0;
    },

    // ---- BLZ-566: the browser half (ADR-0034) ---------------------------------------

    /**
     * Set (or replace) a user's local password.
     *
     * The POLICY is checked here rather than at the call site, because there are three
     * call sites — `blaze user passwd`, the first-run setup form, and any future admin
     * surface — and a floor that each of them re-states is a floor one of them will
     * eventually state differently.
     */
    async setPassword({ email, password }) {
      const policy = checkPasswordPolicy(password);
      if (!policy.ok) throw new Error(policy.error);
      const folded = String(email ?? "").trim().toLowerCase();
      const rows = await exec.all(
        `SELECT id FROM app_user WHERE email = ${p(0)}`, [folded]);
      const userId = rows?.[0]?.id;
      // NAMED, and this is not the sign-in path. `setPassword` is reached only by a
      // caller who already holds filesystem or admin access, so telling them the address
      // does not exist discloses nothing they could not read from the roster directly —
      // and silently succeeding on a typo'd address is how an operator locks themselves
      // out believing they just fixed it.
      if (!userId) throw new Error(`no such user: ${folded}`);
      const verifier = await hashPassword(password);
      const at = now();
      await exec.run(
        `INSERT INTO local_password (user_id, verifier, created_at, updated_at)
         VALUES (${p(0)}, ${p(1)}, ${p(2)}, ${p(3)})
         ON CONFLICT (user_id) DO UPDATE SET verifier = ${p(4)}, updated_at = ${p(5)}`,
        [userId, verifier, at, at, verifier, at]);
      return { userId };
    },

    /** The one query sign-in makes. Verifier, status and role together, so a refusal
     *  costs exactly one round trip whichever reason it has. */
    async lookupLocalPassword(email) {
      const folded = String(email ?? "").trim().toLowerCase();
      if (!folded) return null;
      const rows = await exec.all(
        `SELECT u.id AS user_id, u.email, u.status, m.role, lp.verifier
           FROM app_user u
           LEFT JOIN membership m ON m.user_id = u.id AND m.scope_key = '*'
           LEFT JOIN local_password lp ON lp.user_id = u.id
          WHERE u.email = ${p(0)}`, [folded]);
      return rows?.[0] ?? null;
    },

    /**
     * Mint a session for a user who has already been authenticated.
     *
     * The scopes recorded are the ROLE'S OWN — and they are re-intersected with the role
     * on every request anyway (identity.mjs), so this row can only ever narrow, never
     * widen. `ttlMs` is a parameter so a test can mint an already-expired session
     * without sleeping; production callers take the default.
     */
    async createSession({ userId, role, ttlMs = SESSION_TTL_MS }) {
      const plaintext = generateSessionToken();
      const id = randomUUID();
      const at = now();
      const expiresAt = new Date(Date.parse(at) + Number(ttlMs)).toISOString();
      await exec.run(
        `INSERT INTO user_session (id, user_id, token_hash, scopes, created_at, expires_at)
         VALUES (${p(0)}, ${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)})`,
        [id, userId, hashToken(plaintext), (ROLE_SCOPES[role] ?? []).join(","), at, expiresAt]);
      return { id, token: plaintext, expiresAt };
    },

    /** Shaped EXACTLY as `lookupByHash`, because the same `verify()` consumes both. */
    async lookupSessionByHash(hash) {
      const rows = await exec.all(
        `SELECT s.id AS session_id, s.scopes, s.revoked_at, s.expires_at,
                u.id AS user_id, u.email, u.status,
                m.role
           FROM user_session s
           JOIN app_user u ON u.id = s.user_id
           LEFT JOIN membership m ON m.user_id = u.id AND m.scope_key = '*'
          WHERE s.token_hash = ${p(0)}`, [hash]);
      const r = rows?.[0];
      if (!r) return null;
      return {
        token: { id: r.session_id, name: "browser session", scopes: r.scopes,
                 revoked_at: r.revoked_at, expires_at: r.expires_at },
        user: { id: r.user_id, email: r.email, status: r.status },
        membership: r.role ? { role: r.role } : null,
      };
    },

    async revokeSession(sessionId) {
      await exec.run(
        `UPDATE user_session SET revoked_at = ${p(0)} WHERE id = ${p(1)} AND revoked_at IS NULL`,
        [now(), sessionId]);
    },

    async touchSession(sessionId) {
      await exec.run(`UPDATE user_session SET last_used_at = ${p(0)} WHERE id = ${p(1)}`,
        [now(), sessionId]);
    },

    async listSessions(userId) {
      return (await exec.all(
        `SELECT id, created_at, last_used_at, expires_at, revoked_at
           FROM user_session WHERE user_id = ${p(0)} ORDER BY created_at`, [userId])) ?? [];
    },
  };

  /**
   * Email and password in, a session credential out — or the SAME refusal for every
   * reason it could have failed.
   *
   * THE REFUSAL IS ONE OBJECT, CONSTRUCTED ONCE. Four distinct conditions reach it — no
   * such account, no password set, wrong password, and an account that exists but may not
   * sign in (suspended, or stripped of its membership) — and a caller must not be able to
   * tell them apart. `/setup` already makes this trade the same way, checking the setup
   * token before the email precisely so a caller learns nothing.
   *
   * And the KDF RUNS IN EVERY BRANCH. `verifyAgainst(null, …)` derives against a decoy,
   * so the unknown-account path costs what the known-account path costs. An identical
   * body that returns in a microsecond for one and a hundred milliseconds for the other
   * is not an identical answer.
   */
  api.signIn = async ({ email, password, ttlMs = SESSION_TTL_MS }) => {
    const refused = { ok: false, status: 401, error: "invalid email address or password" };
    let found = null;
    // A lookup that THROWS — a roster whose session tables were never created because the
    // mount is read-only, an unwell database — is a refusal, not a 500 on the pre-auth
    // surface. The verification below still runs, so a broken database and a wrong
    // password are also indistinguishable from outside.
    try { found = await api.lookupLocalPassword(email); } catch { found = null; }
    const checked = await verifyAgainst(found?.verifier ?? null, password);
    if (!checked.ok) return refused;
    if (found.status !== "active") return refused;
    if (!found.role) return refused;
    // Only now, and only here, is anything written.
    const session = await api.createSession({ userId: found.user_id, role: found.role, ttlMs });
    return { ok: true, status: 200, error: null, id: session.id, token: session.token,
             expiresAt: session.expiresAt, email: found.email, role: found.role };
  };

  /**
   * Authenticate a SESSION credential for an operation.
   *
   * The same two steps `authenticate` takes, over the other table — and, decisively, the
   * same `verify()`. ADR-0013 §1's intersection is therefore not re-implemented here: a
   * demotion narrows a live session for exactly the reason it narrows a live token, which
   * is that neither one's scopes are trusted on their own.
   */
  api.authenticateSession = async ({ presented, operation }) => {
    const raw = String(presented ?? "").trim();
    // A value that is not session-shaped never reaches the database. An api_token
    // presented in the session cookie lands here and stops here: the two credential
    // spaces are disjoint (identity.mjs, SESSION_PREFIX), so this is a total test and not
    // a heuristic.
    if (!raw.startsWith(SESSION_PREFIX)) {
      return { ok: false, status: 401, error: "no credentials supplied" };
    }
    let found = null;
    try { found = await api.lookupSessionByHash(hashToken(raw)); }
    catch {
      // FAIL CLOSED, and never 503 from here. A board upgraded onto a read-only mount has
      // no user_session table; a browser holding a stale cookie must get 401 and a sign-in
      // page, not a 503 that also hides the bearer path still working beside it.
      return { ok: false, status: 401, error: "unknown session" };
    }
    const result = verify({ presented: raw, operation, lookup: () => found });
    if (result.ok) {
      // Telemetry only, exactly as `authenticate`'s stamp is: an unstampable session is
      // still a valid one, and a failed write here must never fail the request.
      try { await api.touchSession(result.principal.tokenId); } catch { /* see above */ }
    }
    return result;
  };

  /**
   * Authenticate a presented token for an operation.
   *
   * `verify` is pure and takes a SYNCHRONOUS lookup, so the row is fetched first and
   * handed in. That is why this is two steps rather than one.
   */
  api.authenticate = async ({ presented, operation }) => {
    const raw = String(presented ?? "").trim();
    // A SESSION IS NOT A BEARER TOKEN. It is ambient — a browser attaches it to every
    // request to this origin without being asked — and an api_token is not. Letting one
    // stand in for the other would mean the `Authorization` header inherits the cookie's
    // CSRF exposure for no gain, so the two spaces stay disjoint at BOTH ends: this
    // refuses a session, and `authenticateSession` refuses an api_token.
    if (raw.startsWith(SESSION_PREFIX)) {
      return { ok: false, status: 401, error: "no credentials supplied" };
    }
    // Cheap rejections happen before any query: an empty or wrongly-shaped credential
    // must not cost a database round trip, or an unauthenticated flood becomes load.
    const pre = verify({ presented: raw, operation, lookup: () => null });
    if (!pre.ok && pre.status === 401 && !raw.startsWith(TOKEN_PREFIX)) return pre;

    const found = await api.lookupByHash(hashToken(raw));
    const result = verify({ presented: raw, operation, lookup: () => found });
    // A LAST-USED STAMP MUST NEVER FAIL THE REQUEST THAT EARNED IT. This is the only
    // write on the authentication path, and it is pure telemetry: the caller has already
    // been verified, and `last_used_at` informs nothing that decides access.
    //
    // Unguarded it took the whole board process down. `authenticate` is awaited at the
    // top of an async HTTP handler, so this rejection was unhandled and Node exited —
    // remotely triggerable by any authenticated read whenever identity.db could not be
    // written: a `-v <board>:/data:ro` mount (the Dockerfile's own hardened deployment),
    // or a concurrent `blaze user add` holding the write lock.
    if (result.ok) {
      try { await api.touchToken(result.principal.tokenId); }
      catch { /* telemetry only — an unstampable token is still a valid one */ }
    }
    return result;
  };

  return api;
}
