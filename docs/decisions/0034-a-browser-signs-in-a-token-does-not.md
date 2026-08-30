# ADR-0034 — a browser signs in; a token does not

Date: 2026-08-30

## Status

Accepted (BLZ-566). Builds on [ADR-0013](0013-identity-access-and-tokens.md) — §1 (a
token is a delegation, never an escalation), §2 ("a local password today"), §5 (the first
admin is a user, not an exception) and §7 (what CSRF is still for). Reopens none of them.

## Context

Creating the first admin **locked the operator out of their own board**. Measured live on
2026-08-30: setup completed, `identity.db` was written, and the board went from serving to
`401` with no way back in — `/` `401`, `/api/sync` `401`, `/setup` `404` once an identity
existed.

The mechanism was one line. Once any user exists, `pageScopeFor` gives `GET /` and
`GET /view/<name>` scope `read` and every `/api/*` route is scoped, so all of them require
a credential — and `bearerFrom` read the `Authorization` header and **only** that header.
No cookie, no session, no login page. **A browser cannot set that header.**

So the two states an operator could choose between were:

| | What it means |
|---|---|
| **no users** | an open board, protected solely by whatever fronts it |
| **users** | no browser access at all — reachable from `curl`, the API, or a reverse proxy that injects the header, and from nothing a human uses |

`docs/guide/commands.md` described this plainly and called a sign-in flow "tracked
separately". No ticket carried it, so the gap shipped as documented behaviour.

[BLZ-358](0013-identity-access-and-tokens.md) had already answered the same shape one step
earlier: rather than refusing to start with no users, the board serves a first-run
`/setup` over HTTP — a small pre-auth surface that carries its own credential check, exists
only while it can do anything, and serves nothing else at all. This decision applies that
precedent one step later.

## Decision

### 1. A second credential, and it is a real one

A user may hold a **local password**, stored as a scrypt verifier in a new
`local_password` table. Signing in at `POST /signin` with an email address and that
password mints a row in a new `user_session` table and returns its plaintext as a cookie.

`x-blaze-csrf` is **not** that credential and is not repurposed as one. It is a
per-process `randomUUID()` embedded in the served page and readable by anyone who can
`GET /` — ADR-0013 §7 says so and `serve.mjs` says so. It stays exactly what it was:
forgery protection, required on every `POST` alongside the credential, never instead of
it. What changes is that it is **load-bearing again** rather than vestigial, because this
decision is what puts a cookie back into the browser flow — which is the condition
ADR-0013 §7 made its retention conditional on.

scrypt, at N=16384/r=8/p=1, from `node:crypto`: memory-hard, no dependency (ADR-0016), and
the verifier carries its own parameters so raising the cost later needs no migration.
Nothing but the verifier is stored — the same rule ADR-0013 §4 applies to API tokens, and
sharper, because a password is reused across services in a way a `blz_` token is not.

### 2. The session is verified by the SAME code the token is

`user_session` is shaped exactly like `api_token` — hashed value, requested scopes,
expiry, revocation — and `lookupSessionByHash` returns exactly the structure
`lookupByHash` returns, so both are decided by the **same** `verify()`.

That is the whole reason the shape is copied. ADR-0013 §1's invariant — a credential
carries a subset of its owner's access *at the moment it is used*, never a frozen copy —
is therefore not re-implemented for the second credential type. Demoting a user narrows
every live session on their very next request for exactly the reason it narrows every
token, which is that neither one's stored scopes are trusted on their own. A second
implementation of that intersection is precisely how a session outlives a demotion.

`user_session.expires_at` is `NOT NULL`, unlike `api_token`'s. A bearer token an operator
pastes into a CI job may legitimately never expire; an **ambient** credential a browser
attaches to every request may not. There is no unexpiring session, and the schema is where
that is made unrepresentable. The window is 12 hours, fixed rather than sliding — a
sliding window on an ambient credential is a session that never expires for anyone who
keeps a tab open.

### 3. The two credential spaces are disjoint by construction

A session's plaintext begins `blz_sess.` — still `blz_`-prefixed, so the same
secret-scanning rules catch a leaked one, and with a `.` that **base64url cannot emit**.
`generateToken()` produces `blz_` plus base64url, so without that character a randomly
generated API token could begin `blz_sess_` with probability 64⁻⁵ and be routed to the
wrong table forever. Disjoint by construction beats disjoint by a probability nobody would
ever debug.

Enforced at both ends and at both layers: `bearerFrom` refuses a session value,
`sessionFrom` refuses a non-session value, `authenticate` refuses a session and
`authenticateSession` refuses an API token. The bearer header is tried **first**, and if
it carries anything at all it is the credential being judged — a wrong or revoked token is
never rescued by a cookie beside it, because presenting a narrowed credential explicitly
must not be silently upgraded to whatever the browser happens to hold.

### 4. Bearer tokens are untouched

This adds a path; it replaces none. Every API, `curl`, CLI and reverse-proxy caller takes
exactly the request path it took before — `store.authenticateSession` is not reached at
all when a bearer is presented — and `blaze user add` still prints a token once and stores
only its SHA-256.

### 5. The pre-auth surface stays fail-closed

`/signin` and `/signout` are answered before the gate, for the reason `/setup` is: a caller
signing in has no credential to present, by definition, since obtaining one is what the
route is for. Around that:

- `/api/*` never reaches the sign-in handler, so an unclassified API route is still a
  `404` — with a valid session cookie attached, and there is a test that says so.
- On a board with **no users** the handler declines and the server's own `404` answers, so
  the route is **absent, not hidden**: an unconfigured board gains no new surface.
- During first-run setup the `/setup` `503` catch-all owns the surface and `/signin` is
  not reachable at all.
- A failed sign-in returns **one refusal object, constructed once**, for all five ways it
  can fail: no such account, no password set, wrong password, suspended account, and an
  account stripped of its membership. And the KDF runs in every branch — an unknown
  address is verified against a decoy verifier — because an identical body that returns in
  a microsecond for one case and a hundred milliseconds for the other is not an identical
  answer.
- Nothing on this surface echoes an internal message. A malformed body is
  `"malformed request"`, not a `SyntaxError`. Every input is **type-checked, never
  coerced**: `String(x)` throws outright on an object with a poisoned `toString`, which is
  the failure the setup branch already learned when one unauthenticated request took the
  whole board down.

### 6. The pre-auth forms POST, and a pre-auth route takes no query string

**`method="post"` is load-bearing markup, not decoration.** A `<form>` with no method GETs
the current URL, which puts every field in the **query string** — the password on
`/signin`, and on `/setup` the **one-time setup token**. That lands in browser history, in
the address bar, and in the access log of every proxy fronting the board, while blaze's own
logs — which record no request line — stay clean and show nothing. It contradicts
`setup-token.mjs`'s stated invariant that the token value is *never logged, echoed, or
rendered*, and the only thing that prevented it was `e.preventDefault()` in a trailing
inline script.

A script is exactly what a fronting reverse proxy's default `script-src 'self'` CSP
removes — blaze sets no CSP of its own and its docs recommend a proxy — and what a hurried
Enter beats to the parser. **The method has to be right in the markup so that the failure
mode is a refused POST rather than a silent leak.** With script disabled the form posts
form-encoded with no `x-blaze-csrf` header and is refused; a `<noscript>` says so up front.
A no-JS submission is deliberately **not** made to work: accepting form-encoded bodies
would widen the pre-auth surface, and a refusal that puts the password in a request body
leaks nothing.

Alongside it, **no pre-auth route accepts a query string at all** — not a parameter named
`password` or `token`, but *any* query string, refused with 400 and a page that echoes
nothing and tells the operator to treat what they sent as compromised. That breadth is the
same boundary lesson `user-admin.mjs` learned three times over: enumerating the dangerous
spellings loses to the one nobody listed. A parameter these routes genuinely want can be
allowed deliberately, one at a time.

Both pre-auth responses — page and JSON — carry `Cache-Control: no-store` (the `/setup`
success body holds the API token plaintext, and the `/signin` one a session `Set-Cookie`),
`Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a
`default-src 'none'` CSP with a **per-response** nonce for the one inline script and style.
`form-action 'self'` in that policy is the one that matters for this decision: the
credential form cannot be retargeted at another origin.

### 7. A password value is never logged, anywhere

The rule `setup-token.mjs` states — the *path* may be logged, the *value* never is —
extends unchanged. `blaze user passwd` reads the password from **stdin** and there is no
`--password` flag; the parser refuses one **by name**, because `argv` is visible to every
process on the box through `ps` and is written to shell history.

And a rule that outranks that one, because three attempts to enumerate spellings were each
defeated by a spelling nobody had listed: **no error `user-admin.mjs` constructs
interpolates an argument the parser did not recognise** — not a flag, not a value, not a
verb, not a role. An unrecognised argument is named by its **position** and never by its
text. The reason no shape test can be trusted here is that **nothing syntactic separates
`--pwd` from `-correct-horse`**: a password may be spelled either way, so truncating at
`=`, or at whitespace, or testing for a leading dash all still emit part of a secret. The
one fact about an unrecognised argument that is certainly not a secret is where it sat on
the command line. A literal the parser matched by exact equality — `--email`, `--role`,
`--name` — may still be named, because that string comes from this source file rather than
from the operator. The cost is a less specific message for a plain typo, paid down by the
usage block printed alongside every refusal. On a TTY the echo is
suppressed. Neither the password nor the minted session appears in stdout, stderr, an
exception message, or the HTTP response.

### 8. The schema grows on the read path, once

`identity.db` has no migration runner and ADR-0006's write seams do not reach it: the DDL
was applied by `openIdentityDb(create: true)` and nowhere else. That was sufficient while
the schema never grew, and the board this ticket was filed from is precisely the one it is
insufficient for — an existing roster with no sign-in tables.

So `loadIdentity` applies the additive DDL **after** the user count succeeds and **only**
on the healthy branch. Every statement is `CREATE ... IF NOT EXISTS`, so a current roster
pays a no-op. The ordering is the control: run it earlier and a truncated or non-database
file would be given a schema first, turning the `broken` verdict — the one that stops a
corrupted roster from silently disarming a board's authentication — into `empty`. It is
best-effort, because a read-only data mount (the Dockerfile's own hardened deployment)
cannot take DDL and must still serve every bearer token it was deployed with.

## Consequences

An operator can use their own board from a browser. A fresh deployment stays usable: the
`/setup` form now asks for a password, validated before the administrator is created so a
refused password cannot leave a half-made board behind. An **existing** locked-out board
recovers with `blaze user passwd` on the host — which needs exactly the filesystem
privilege that reading `identity.db` already needs, and therefore grants nothing new. That
is the same argument `setup-token.mjs` makes for writing its token to a file rather than
serving it.

**What this does NOT protect against, stated plainly, because a security control that
oversells itself is worse than none:**

- **It is not transport security.** The password crosses the network in the `POST` body,
  so on a plain-HTTP LAN bind it is observable in transit. Blaze does not terminate TLS;
  putting the board behind a proxy that does is the operator's job. The cookie is marked
  `Secure` when the request arrived over TLS or a proxy said so — the only header trusted
  for this, and only because a false claim can make the cookie stricter and never looser.
  `x-forwarded-proto` is read as a **chain**, and the **last** element is the one that
  decides: the client's own value sits leftmost and each proxy appends its view, so the
  trustworthy element is the one the nearest trusted proxy wrote. Reading the leftmost —
  which the first cut did — let a client sending `http` arrive behind an appending proxy
  as `http, https` and **strip** `Secure` from a cookie issued over a genuine TLS
  connection, which is the one direction this trust was argued to be incapable of moving.
- **There is no rate limit on `/signin`.** The brake is scrypt's own cost, roughly 50–100 ms
  per attempt per core. A counter keyed on the address would let anyone lock the
  administrator out, and one keyed on the source address is defeated by the same proxy that
  makes the board reachable. Edge rate limiting is the operator's control, as edge TLS is.
  Tracked rather than pretended away.
- **A stolen cookie works until it expires or is revoked.** `HttpOnly` keeps script from
  reading it and `SameSite=Strict` keeps a foreign page from sending it; neither survives
  an attacker with the file.
- **A read-only board cannot sign in at all.** It cannot write a session row, and it never
  had browser access to lose. Its bearer tokens are unaffected.

**One latent-path guard is carried here deliberately.** `tokenUsable` compares expiry as
an **instant**, not as a string. The original `String(row.expires_at) <= now` is a
lexicographic compare, correct only because identity is hard-wired to SQLite, where
`d.ts` is `TEXT` and timestamps round-trip as ISO-8601 `Z` strings that sort
chronologically. `identity-store.mjs` already supports the `postgres` dialect, where
`d.ts` is `timestamptz` and `pg` returns a `Date` whose string form never compares `<=`
an ISO string — so on that driver expiry would silently never fire and **every session
would become permanent**. Nothing constructs that dialect today, so this is a guard on a
path no request can reach; it is stated as one, and it fails closed on an expiry it
cannot read at all.

**Explicitly deferred**, and not to be built ahead of a customer who asks: SSO/OIDC (the
`user_identity` table is still the hook, unchanged), password reset over HTTP, a
remembered-device or refresh-token flow, per-session listing in the UI, and a permissions
matrix beyond ADR-0013 §3's three roles.
