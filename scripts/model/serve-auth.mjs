// scripts/model/serve-auth.mjs — the HTTP gate (blaze-pm BLZ-304), per ADR-0013.
//
// Two decisions live here, and the second is the one worth arguing with.
//
// 1. Every /api/* route is classified read / write / admin, and an UNCLASSIFIED route
//    is denied. A new endpoint nobody remembered to add must fail closed, or it ships
//    unauthorised until somebody notices.
//
// 2. WHEN NO IDENTITY IS CONFIGURED, the rule depends on the bind address:
//
//      loopback      -> serve without auth, exactly as Blaze always has
//      any other     -> REFUSE TO START, naming the command to fix it
//
//    That is not a compromise for its own sake. Today's actual security boundary IS
//    the bind address (`HOST || 127.0.0.1`), and thousands of existing single-operator
//    boards depend on it. Demanding a token from them would break every one for no
//    security gain — nothing outside the machine can reach them.
//
//    But the container sets HOST=0.0.0.0 (Dockerfile), so a deployment is exactly the
//    case where the loopback assumption silently stops being true. Refusing to start
//    there converts a silent exposure into a startup error, which is the trade this
//    whole exercise exists to make.
import { isIP } from "node:net";
import { SESSION_PREFIX } from "./identity.mjs";

/** Every route the API answers, and what it costs to call. */
export const ROUTE_SCOPES = {
  "GET /api/hash": "read",
  "GET /api/sync": "read",
  "GET /api/live": "read",
  "GET /api/panel": "read",
  "GET /api/reconcile-preview": "read",
  "POST /api/move": "write",
  "POST /api/edit": "write",
  "POST /api/resolve": "write",
  "POST /api/log": "write",
  "POST /api/ac": "write",

  // v4 (BLZ-323): artifact model, links, gates, baselines, custom fields, matrix and
  // coverage. POST /api/field is "admin", not "write": defining a filterable field
  // emits ALTER TABLE, and it spends the install-wide 200-filterable-field budget that
  // ADR-0018 shares across every project in the installation — one project's member
  // could exhaust another project's headroom. That is an administrative act. (An
  // earlier revision of this file scored it "write" to satisfy an exact-equality
  // invariant in the test below; that invariant was the thing that was wrong, and has
  // since been loosened — see task-13-report.md fix round 1.) POST /api/artifact,
  // /api/link and /api/baseline are ordinary mutations.
  "POST /api/artifact": "write",
  "POST /api/link": "write",
  "POST /api/baseline": "write",
  "POST /api/field": "admin",
  "GET /api/matrix": "read",
  "GET /api/coverage": "read",
};

/** Loopback, in either family. Anything else is reachable by something else. */
export function isLoopback(host) {
  const h = String(host ?? "").trim();
  if (h === "localhost") return true;
  if (isIP(h) === 4) return h.startsWith("127.");
  if (isIP(h) === 6) return h === "::1" || h === "::ffff:127.0.0.1";
  return false;
}

/**
 * May this server start at all?
 *
 * @returns { ok, error } — never throws, so the caller decides how loudly to fail.
 */
export function checkBindSafety({ host, hasIdentity }) {
  if (hasIdentity) return { ok: true, error: null };
  if (isLoopback(host)) return { ok: true, error: null };
  return {
    ok: false,
    error:
      `blaze: refusing to serve on ${host} with no users configured.\n\n`
      + "Every mutating endpoint would be reachable by anything that can reach this\n"
      + "address, with no credential. On loopback that is the behaviour Blaze has always\n"
      + "had; on any other interface it is an open door.\n\n"
      + "Either bind to loopback:\n"
      + "    HOST=127.0.0.1 blaze board\n\n"
      + "or create the first user, which turns authentication on:\n"
      + "    blaze user add --email you@example.com --role admin\n",
  };
}

/** The scope an incoming request needs, or null if the route is unknown. */
export function scopeFor(method, pathname) {
  return ROUTE_SCOPES[`${String(method).toUpperCase()} ${pathname}`] ?? null;
}

/**
 * The scope a board CONTENT route needs, or null if this is not one.
 *
 * Kept apart from ROUTE_SCOPES on purpose. `/api/*` is fail-closed — an unclassified
 * route is a 404 — but the page router is not a fixed table, and turning every unknown
 * path into an auth decision would break the plain 404 the board has always returned.
 * So this answers only for the routes that actually serve ticket content.
 *
 * `/` is rendered server-side and embeds the whole board, which is why it needs `read`:
 * an ungated `/` hands every ticket to an unauthenticated caller and makes `viewer` a
 * role that protects nothing.
 */
export function pageScopeFor(method, pathname) {
  if (String(method).toUpperCase() !== "GET") return null;
  if (pathname === "/") return "read";
  if (/^\/view\/[a-z]+$/.test(pathname)) return "read";
  return null;
}

/** The bearer token, or "" — a malformed header is treated as absent, never guessed at. */
export function bearerFrom(headers) {
  const raw = String(headers?.authorization ?? headers?.Authorization ?? "").trim();
  if (!/^Bearer\s+/i.test(raw)) return "";
  const value = raw.replace(/^Bearer\s+/i, "").trim();
  // BLZ-566. A BROWSER SESSION IS NOT A BEARER TOKEN. The two credential spaces are
  // disjoint by construction (identity.mjs, SESSION_PREFIX) and they are kept disjoint at
  // both ends: a session is ambient and an api_token is not, and letting one arrive
  // through the other's door would hand the Authorization header the cookie's CSRF
  // exposure for nothing. Refused HERE as well as in `authenticate`, because this is the
  // function every caller in the codebase asks "is there a bearer credential", and an
  // answer of "yes, a session" is wrong before anyone acts on it.
  return value.startsWith(SESSION_PREFIX) ? "" : value;
}

/** The name of the cookie a signed-in browser carries. One name, exported, so the page,
 *  the gate and the sign-out route cannot drift. */
export const SESSION_COOKIE = "blaze_session";

/**
 * One cookie's value out of a Cookie header, or "".
 *
 * Written out rather than split-on-`=`-and-take-[1]: a session credential is base64url
 * and carries no `=`, but a cookie value in general may, and a parser that silently
 * truncates at the first one is a parser that fails on the day something else uses it.
 * The NAME is compared exactly — a cookie called `xblaze_session` is a different cookie,
 * and matching it by suffix is how an attacker who can set ANY cookie on the origin sets
 * the one that matters.
 */
export function cookieFrom(headers, name) {
  const raw = String(headers?.cookie ?? headers?.Cookie ?? "");
  if (!raw) return "";
  for (const pair of raw.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    return pair.slice(eq + 1).trim();
  }
  return "";
}

/** The session credential a browser presented, or "" — where "" also covers "something
 *  that is not session-shaped", so an api_token pasted into the cookie is not a session
 *  and never reaches the store. */
export function sessionFrom(headers) {
  const value = cookieFrom(headers, SESSION_COOKIE);
  return value.startsWith(SESSION_PREFIX) ? value : "";
}

/**
 * Decide one request.
 *
 * @param store  an identityStore, or null when no identity is configured
 * @returns { ok, status, error, principal }
 */
export async function gate({ method, pathname, headers, store, operation: forced }) {
  // `forced` lets a caller decide a route this table does not own — the board content
  // routes, whose scope comes from pageScopeFor(). /api/* still resolves here, so an
  // unclassified API route is still a 404.
  const operation = forced ?? scopeFor(method, pathname);
  if (!operation) {
    // Unknown /api/* route. Denied rather than passed through: a route added without a
    // classification must not inherit whatever the last one had.
    return { ok: false, status: 404, error: "unknown endpoint", principal: null };
  }
  // No identity configured — the loopback case, already vouched for at startup.
  if (!store) return { ok: true, status: 200, error: null, principal: null };

  // BLZ-566. TWO DOORS, IN THIS ORDER, AND ONE OF THEM IS TAKEN PER REQUEST.
  //
  // The bearer header first, and if it carries anything at all that is the credential
  // being judged — a wrong or revoked token is NOT rescued by a cookie sitting beside it.
  // Falling through would mean a caller who deliberately presented a narrowed token got
  // silently upgraded to whatever their browser session happens to hold, which is the
  // opposite of what presenting it explicitly asked for.
  //
  // The cookie only when no bearer was presented. That ordering is also what keeps this
  // additive: every existing API, curl and reverse-proxy caller takes exactly the path it
  // took before, and `store.authenticateSession` is not reached at all on that path.
  const bearer = bearerFrom(headers);
  const session = bearer ? "" : sessionFrom(headers);
  const r = session
    ? await store.authenticateSession({ presented: session, operation })
    : await store.authenticate({ presented: bearer, operation });
  return { ok: r.ok, status: r.status, error: r.error, principal: r.principal ?? null };
}
