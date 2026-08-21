# 13. Identity, access and tokens

Date: 2026-08-21

## Status

Accepted (blaze-pm BLZ-303). Implements REQ (blaze-pm BLZ-302).

## Context

Blaze has **no application-layer authentication**. `serve.mjs` checks a CSRF header
whose value is `randomUUID()` per process, embedded in the served page — forgery
protection, not a credential. Reproduced end to end:

```
1. anonymous GET /            -> token harvested, no credentials
2. POST /api/edit + token     -> {"ok":true}
3. on disk:  title: EDITED BY AN UNAUTHENTICATED CALLER
```

Nothing is exposed today: the deployed chart puts Traefik basic-auth in front
(`auth.enabled: true`, INF-386) and the public endpoint returns 404. The gap is
architectural, not an incident.

The operator has set the direction: a **hosted tool for agent-driven engineering
teams**, with a SaaS offering as a later goal. And a binding constraint on this
decision:

> "the app will need to facilitate **users**, and connectivity to **user providers**,
> and users should be able to **generate tokens based on their access**."

A review panel recommended starting with a single shared bearer token. That is the right
*first delivery* and the wrong *first model*: a shared secret has no owner, so there is
nothing for a token's access to be derived from, and adding users later means replacing
it rather than extending it. The constraint above is what settles the difference.

## Decision

### 1. A token is a delegation, never an escalation

**This is the invariant everything else serves.** A token carries a subset of its
owner's access at the moment it is used — never a superset, and never a frozen copy.

- Scopes are **intersected with the owner's current access on every request**, not
  stamped into the token at issue time. Revoking a user's write access immediately
  narrows every token they ever created, with no token bookkeeping.
- A user cannot mint a token that can do something they cannot do. The API refuses it
  at issue time, and the intersection makes it unreachable even if a row were forged.

The failure this prevents is the ordinary one: someone with write access issues a token,
later moves to read-only, and the token keeps writing because its scopes were copied
rather than derived.

### 2. Four tables, and identity is separate from the user

```
user       — the person.  id, email, display_name, status, created_at
identity   — how they prove it.  (provider, subject) -> user_id
membership — what they can do.   (user_id, scope_key) -> role
api_token  — a delegation.       id, user_id, name, token_hash, scopes,
                                 created_at, last_used_at, expires_at, revoked_at
```

**`identity` is a separate table on purpose.** One user, many ways to sign in: a local
password today, a Google or GitHub or Okta subject tomorrow, several at once during a
migration. Putting the provider on `user` forces a rewrite the first time an engineering
firm arrives with an identity provider — which the operator has stated is a requirement,
not a maybe. This is the "connectivity to user providers" hook, and it costs one table
now rather than a migration later.

`membership.scope_key` is deliberately not called `board_id` or `tenant_id`. Today there
is one board and the key is `'*'`. When there are projects or tenants to scope to, the
column already exists and the meaning widens without a schema change.

### 3. Roles: three, and no matrix

`admin`, `member`, `viewer`. Admin manages users and tokens; member reads and writes
tickets; viewer reads. A permissions matrix is explicitly refused for now — nobody
buying from a solo vendor expects granular RBAC, and every additional role is a
permanent maintenance cost paid by one person.

### 4. Tokens are stored hashed, shown once

`token_hash` holds a SHA-256 of the token; the plaintext is displayed exactly once at
creation and never again. A token is a bearer credential — a database dump must not
yield working credentials, and a support conversation must not be able to read one back.

Comparison is constant-time. Tokens carry a `blz_` prefix so they are recognisable in a
log or a paste and can be matched by secret-scanning.

### 5. The bootstrap token is a user, not an exception

`blaze init` creates the first admin user and issues its token through the ordinary
path. There is no separate "shared token" mechanism with its own code path — the
single-operator case is one user with one token, and it exercises exactly the code every
later case uses. A special case that only the first install takes is a special case
nobody tests.

### 6. Every event records who

`ticket_event.actor` already exists (`sqlite-schema.mjs:126`, default `'unknown'`) and
both drivers already read and write it — nothing has ever set it. The authenticated
principal is threaded into it. Attaching identity is therefore cheap: the column and its
plumbing are already in place.

Audit becomes a compliance matter, not a nicety, the moment several people share one
deployment — which is exactly the engineering-firm case being targeted.

### 7. What CSRF is still for

A bearer token in an `Authorization` header is **not ambient**: a foreign page cannot
attach it, so bearer auth already defeats classic CSRF for API and CLI callers. The CSRF
check is retained only while any part of the browser flow uses a cookie, and is removed
with the last cookie rather than kept out of habit.

## Consequences

The first release ships one admin user and one token — operationally identical to the
shared token the panel recommended, and structurally ready for the rest.

Adding an identity provider becomes rows in `identity` plus a verification callback,
not a redesign. Adding tenancy becomes a meaning for `scope_key`, not a migration.

The cost is four tables and a token-issuing path before the first external user, rather
than one env-var comparison. That is the cost of the operator's constraint, taken
deliberately: tokens derived from a user's access require a user to derive them from.

**Explicitly deferred**, and not to be built ahead of a customer who asks: SSO/OIDC
wiring itself, a permissions matrix beyond three roles, cross-tenant isolation, billing,
and per-project roles. The schema anticipates them; none is built.
