// scripts/model/identity-schema.mjs — users, identities, memberships and tokens
// (blaze-pm BLZ-303), implementing ADR-0013.
//
// THE INVARIANT THIS SCHEMA SERVES: a token is a delegation, never an escalation. It
// carries a subset of its owner's access AT THE MOMENT IT IS USED — which is why
// `api_token.scopes` is intersected with the owner's membership on every request rather
// than trusted on its own. Revoking a user's write access immediately narrows every
// token they ever created, with no token bookkeeping.
//
// `identity` is a separate table on purpose. One user, many ways to sign in: a local
// password today, a Google or Okta subject tomorrow, several at once during a
// migration. Putting the provider on `user` forces a rewrite the first time an
// engineering firm arrives with an identity provider — which is a stated requirement,
// not a maybe.


import { dialect } from "./sql-dialect.mjs";
/** The three roles. A permissions matrix is deliberately refused — ADR-0013 §3. */
export const ROLES = ["admin", "member", "viewer"];

/** What each role may do. The ONE definition; nothing else may hard-code a role name. */
export const ROLE_SCOPES = {
  admin:  ["read", "write", "admin"],
  member: ["read", "write"],
  viewer: ["read"],
};

/** Every scope a token may name. A token asking for anything else is refused at issue. */
export const SCOPES = ["read", "write", "admin"];

export function identityDdl(name) {
  const d = dialect(name);
  return `
CREATE TABLE IF NOT EXISTS app_user (
  id           text PRIMARY KEY,
  email        text NOT NULL,
  display_name text NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at   ${d.ts} NOT NULL,
  -- Case-insensitive uniqueness is enforced by storing the address already folded;
  -- doing it with a functional index diverges between the two dialects for no gain.
  CONSTRAINT app_user_email_unique UNIQUE (email)
);

-- How a user proves who they are. MANY per user, by design: local today, an external
-- provider tomorrow, both at once during a migration.
CREATE TABLE IF NOT EXISTS user_identity (
  provider   text NOT NULL,
  subject    text NOT NULL,
  user_id    text NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  created_at ${d.ts} NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS user_identity_user_idx ON user_identity (user_id);

-- What a user may do, and where. scope_key is NOT called board_id or tenant_id: today
-- it is always '*', and when there are tenants to scope to the column already exists
-- and its meaning widens without a schema change.
CREATE TABLE IF NOT EXISTS membership (
  user_id    text NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  scope_key  text NOT NULL DEFAULT '*',
  role       text NOT NULL CHECK (role IN ('admin','member','viewer')),
  created_at ${d.ts} NOT NULL,
  PRIMARY KEY (user_id, scope_key)
);

-- A delegation of its owner's access. scopes is what the token ASKED for; what it
-- GETS is that intersected with the owner's membership at request time (ADR-0013 §1).
CREATE TABLE IF NOT EXISTS api_token (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  name         text NOT NULL,
  -- SHA-256 of the token. The plaintext is shown once at creation and never stored: a
  -- database dump must not yield working credentials.
  token_hash   text NOT NULL,
  scopes       text NOT NULL,
  created_at   ${d.ts} NOT NULL,
  last_used_at ${d.ts},
  expires_at   ${d.ts},
  revoked_at   ${d.ts},
  CONSTRAINT api_token_hash_unique UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS api_token_user_idx ON api_token (user_id);
`.trim() + "\n";
}
