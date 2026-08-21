// scripts/model/identity-store.mjs — the I/O half of identity (blaze-pm BLZ-304).
//
// The POLICY lives in identity.mjs and is pure. This is the part that touches a
// database, and it is deliberately thin: every decision it appears to make is actually
// made by a pure function it calls. Splitting it this way is the same shape BLZ-297
// arrived at — and for the same hard reason, since a synchronous driver cannot await.
import { randomUUID } from "node:crypto";
import { generateToken, hashToken, checkRequestedScopes, verify } from "./identity.mjs";

const ph = (dialect, i) => (dialect === "postgres" ? `$${i + 1}` : "?");

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
  };

  /**
   * Authenticate a presented token for an operation.
   *
   * `verify` is pure and takes a SYNCHRONOUS lookup, so the row is fetched first and
   * handed in. That is why this is two steps rather than one.
   */
  api.authenticate = async ({ presented, operation }) => {
    const raw = String(presented ?? "").trim();
    // Cheap rejections happen before any query: an empty or wrongly-shaped credential
    // must not cost a database round trip, or an unauthenticated flood becomes load.
    const pre = verify({ presented: raw, operation, lookup: () => null });
    if (!pre.ok && pre.status === 401 && !raw.startsWith("blz_")) return pre;

    const found = await api.lookupByHash(hashToken(raw));
    const result = verify({ presented: raw, operation, lookup: () => found });
    if (result.ok) await api.touchToken(result.principal.tokenId);
    return result;
  };

  return api;
}
