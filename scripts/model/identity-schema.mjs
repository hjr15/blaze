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

-- BLZ-566, ADR-0034. The verifier for the local provider user_identity has carried a
-- row for since BLZ-303 with nothing to check against. One row per user, or none: an
-- account with no password simply cannot be signed into from a browser, which is the
-- correct answer for a service account that only ever holds an API token.
--
-- WHAT IS STORED IS A VERIFIER, NEVER A PASSWORD — scrypt$N$r$p$salt$key, carrying its
-- own cost parameters so raising them later needs no migration. Same rule as ADR-0013 §4,
-- and sharper: a password is reused across services in a way a blz_ token is not.
CREATE TABLE IF NOT EXISTS local_password (
  user_id    text PRIMARY KEY REFERENCES app_user (id) ON DELETE CASCADE,
  verifier   text NOT NULL,
  created_at ${d.ts} NOT NULL,
  updated_at ${d.ts} NOT NULL
);

-- A browser's credential. Deliberately the same SHAPE as api_token — hashed value,
-- requested scopes, expiry, revocation — because it is verified by the same verify(),
-- and ADR-0013 §1's intersection is therefore the same code rather than a second copy of
-- it. A second copy is how a session outlives its owner's demotion.
--
-- SEPARATE TABLE, not a kind column on api_token: identity.db has no migration runner,
-- so an ALTER would strand every board that already has one, while a CREATE TABLE IF NOT
-- EXISTS lands on an existing roster without touching a row of it.
--
-- expires_at is NOT NULL, unlike api_token's. A bearer token an operator pastes into a
-- CI job may legitimately never expire; an ambient cookie may not. There is no
-- unexpiring session, and the schema is where that is unrepresentable.
CREATE TABLE IF NOT EXISTS user_session (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  -- SHA-256, for the reason api_token.token_hash is: a dump must not yield a live login.
  token_hash   text NOT NULL,
  scopes       text NOT NULL,
  created_at   ${d.ts} NOT NULL,
  last_used_at ${d.ts},
  expires_at   ${d.ts} NOT NULL,
  revoked_at   ${d.ts},
  CONSTRAINT user_session_hash_unique UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS user_session_user_idx ON user_session (user_id);
`.trim() + "\n";
}
