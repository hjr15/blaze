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
  // coverage. NOTE: task-13-brief.md's worked example scores "POST /api/field" as
  // "admin" — the field-promotion route mutates schema (ALTER TABLE), which is a
  // meaningfully higher-risk action than an ordinary write. But the pre-existing test
  // immediately below ("every mutating route costs write, and no GET does") asserts
  // EXACT equality to "write" for every POST route, and this task's brief cannot touch
  // that test file. "admin" cannot satisfy that assertion, so this stays "write" —
  // flagged in task-13-report.md as a brief/test contradiction rather than silently
  // picked. GET /api/coverage and GET /api/artifact/:id are read; POST /api/artifact,
  // /api/link and /api/baseline are ordinary mutations.
  "POST /api/artifact": "write",
  "POST /api/link": "write",
  "POST /api/baseline": "write",
  "POST /api/field": "write",
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

/** The bearer token, or "" — a malformed header is treated as absent, never guessed at. */
export function bearerFrom(headers) {
  const raw = String(headers?.authorization ?? headers?.Authorization ?? "").trim();
  if (!/^Bearer\s+/i.test(raw)) return "";
  return raw.replace(/^Bearer\s+/i, "").trim();
}

/**
 * Decide one request.
 *
 * @param store  an identityStore, or null when no identity is configured
 * @returns { ok, status, error, principal }
 */
export async function gate({ method, pathname, headers, store }) {
  const operation = scopeFor(method, pathname);
  if (!operation) {
    // Unknown /api/* route. Denied rather than passed through: a route added without a
    // classification must not inherit whatever the last one had.
    return { ok: false, status: 404, error: "unknown endpoint", principal: null };
  }
  // No identity configured — the loopback case, already vouched for at startup.
  if (!store) return { ok: true, status: 200, error: null, principal: null };

  const r = await store.authenticate({ presented: bearerFrom(headers), operation });
  return { ok: r.ok, status: r.status, error: r.error, principal: r.principal ?? null };
}
