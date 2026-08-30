// scripts/model/signin.mjs — BLZ-566. The browser's door, per ADR-0034.
//
// WHY THIS EXISTS. Once a board had users, `pageScopeFor` gave `GET /` and
// `GET /view/<name>` scope `read`, every `/api/*` route was scoped, and `bearerFrom` read
// the `Authorization` header and nothing else. A browser cannot set that header. So the
// two states an operator could choose between were "no users" — an open board protected
// only by whatever fronts it — and "users", which meant no browser access at all.
// Measured on the live board on 2026-08-30: `/` 401, `/api/sync` 401, `/setup` 404.
//
// BLZ-358 answered the same shape one step earlier, and this is built on its precedent:
// a small, self-contained, PRE-AUTH surface that carries its own credential check, exists
// only while it can do anything, and serves nothing else at all.
//
// WHAT IS AND IS NOT AUTHENTICATION HERE. `x-blaze-csrf` is NOT. It is a per-process
// randomUUID() embedded in the served page and readable by anyone who can `GET /`, and
// ADR-0013 §7 says so; it is required on the POSTs below as forgery protection, ALONGSIDE
// the password, never instead of it. The credential is the password, checked against a
// scrypt verifier (passwords.mjs) and answered with one refusal for every way it can fail.
//
// SHARED BY BOTH SERVERS on purpose. `serve.mjs` and `supervisor.mjs` both gate `/` and
// `/view/<name>` through the same `pageScopeFor`, so both had the same lockout; mounting
// one handler in both is what stops the fix reaching one of them and not the other.
import { SESSION_COOKIE, sessionFrom } from "./serve-auth.mjs";
import { SESSION_TTL_MS } from "./identity-store.mjs";
import { hashToken } from "./identity.mjs";
import { randomBytes } from "node:crypto";
import { MIN_PASSWORD_LENGTH } from "./passwords.mjs";

export const SIGNIN_PATH = "/signin";
export const SIGNOUT_PATH = "/signout";

/**
 * Read a JSON request body, capped.
 *
 * Lifted verbatim from `serve.mjs`, which is now its only other caller, so the 256KB cap
 * has ONE definition. A pre-auth surface with its own privately re-typed body limit is a
 * pre-auth surface whose limit drifts.
 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "", size = 0, settled = false;
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > 256 * 1024) {
        settled = true;
        req.destroy();
        reject(new Error("too large"));
      } else {
        data += c;
      }
    });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", (e) => { if (!settled) reject(e); });
  });
}

/**
 * Did this request arrive over TLS?
 *
 * `x-forwarded-proto` is trusted here and NOWHERE ELSE, and only because of the direction
 * it can move the answer: a false claim of `https` only makes the cookie STRICTER
 * (`Secure`, so the browser refuses to send it over plain HTTP), and a caller who omits
 * the header gets exactly the plain-HTTP behaviour that is already the default. There is
 * no configuration of it that widens anything. Blaze does not terminate TLS, so without
 * this a board behind the reverse proxy the setup docs recommend would issue a cookie
 * that is never marked Secure.
 *
 * THE LAST ELEMENT, NOT THE FIRST, AND THAT IS THE WHOLE OF THIS FUNCTION'S SUBTLETY.
 * `X-Forwarded-*` is a CHAIN: the client's own value sits leftmost and each proxy APPENDS
 * its view, so the trustworthy element is the one the NEAREST proxy wrote. Reading the
 * leftmost let a client send `x-forwarded-proto: http`, arrive behind an appending proxy
 * as `http, https`, and STRIP `Secure` from a cookie issued over a genuine TLS connection
 * — the one direction the paragraph above claims is impossible. (Traefik, which fronts
 * this deployment, overwrites `X-Forwarded-*` for untrusted clients, so it was not live
 * here; a security decision should not rest on which proxy happens to be in front.)
 *
 * `req.socket.encrypted` is checked first, so a direct TLS connection never depends on
 * any of this.
 */
export function isSecureRequest(req) {
  if (req?.socket?.encrypted) return true;
  const chain = String(req?.headers?.["x-forwarded-proto"] ?? "").split(",");
  return chain[chain.length - 1].trim().toLowerCase() === "https";
}

/** The Set-Cookie a signed-in browser gets. */
export function sessionCookieHeader({ token, ttlMs = SESSION_TTL_MS, secure }) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    // Script must not be able to read it. The board page runs JS, and an XSS that could
    // read the cookie would be a credential theft rather than a defacement.
    "HttpOnly",
    // The one attribute that makes an ambient credential safe to have at all: the browser
    // will not attach it to a request originating from another site, so the forged POST
    // ADR-0013 §7 describes cannot carry it. CSRF stays on as defence in depth.
    "SameSite=Strict",
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** The Set-Cookie that tells a browser to forget it. Same attributes, so the browser
 *  matches and replaces the cookie it already holds rather than adding a second one. */
export function clearedSessionCookieHeader({ secure }) {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * A fresh CSP nonce. Per RESPONSE, never per process: a nonce reused across responses is
 * not a nonce, and this page is served to anyone who can reach the port.
 */
export function cspNonce() {
  return randomBytes(16).toString("base64");
}

/**
 * The headers every PRE-AUTH response carries — the page and the JSON alike.
 *
 * WHY EACH ONE IS HERE, because a header nobody can justify is a header somebody deletes:
 *
 *   cache-control: no-store   the /setup response body carries the API token plaintext
 *                             ONCE, and the sign-in page carries a form a browser will
 *                             happily restore from a back-button cache. Neither belongs
 *                             in a disk cache or a shared proxy cache.
 *   referrer-policy: no-referrer
 *                             a pre-auth page must not name itself — or anything in its
 *                             URL — to whatever it navigates to next.
 *   x-content-type-options    no sniffing a served page into something executable.
 *   content-security-policy   `default-src 'none'` with a per-response nonce for the one
 *                             inline script and one inline style these pages carry.
 *                             `form-action 'self'` is the load-bearing one for THIS
 *                             ticket: the credential form cannot be retargeted at another
 *                             origin. `frame-ancestors 'none'` stops the sign-in form
 *                             being framed and clickjacked.
 *
 * Blaze sets no CSP anywhere else and its docs recommend fronting it with a reverse
 * proxy, so a proxy's default policy is exactly what these pages must survive — which is
 * why the form's method is markup, not script (see `signinPageHtml`).
 */
export function preAuthHeaders({ nonce = null } = {}) {
  const csp = ["default-src 'none'"];
  if (nonce) csp.push(`script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`);
  // CONNECT-SRC IS NOT OPTIONAL, AND OMITTING IT BROKE SIGN-IN COMPLETELY.
  //
  // Both pre-auth pages submit with `fetch()`. With `default-src 'none'` and no
  // `connect-src`, the browser falls back to `default-src` and BLOCKS that fetch —
  // measured in Chromium: "Connecting to '…/signin' violates … default-src 'none'.
  // Note that 'connect-src' was not explicitly set, so 'default-src' is used as a
  // fallback." Zero requests left the page and the error area stayed empty, so the
  // operator saw NOTHING HAPPEN — which is the exact symptom this ticket exists to
  // remove. A hardening header that silently disables the feature it protects is worse
  // than no header.
  //
  // `'self'` and nothing more: the page calls its own origin and no other.
  csp.push("connect-src 'self'", "form-action 'self'", "base-uri 'none'",
           "frame-ancestors 'none'");
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": csp.join("; "),
  };
}

/**
 * A PRE-AUTH ROUTE TAKES NO QUERY STRING, AND THE RULE IS THAT BROAD ON PURPOSE.
 *
 * `/signin` and `/setup` accept nothing in a URL, so any query string on one is either a
 * form that submitted the wrong way or something this server does not understand — and in
 * the first case it is carrying a PASSWORD or a SETUP TOKEN. Refusing the whole shape,
 * rather than testing for parameters named `password` or `token`, is the same boundary
 * lesson `user-admin.mjs` learned three times: enumerating the dangerous spellings loses
 * to the one nobody listed. A parameter this route genuinely wants can be allowed
 * deliberately, one at a time.
 *
 * Answering 200 with the page again — which is what happened before this — is the worst
 * possible response: the operator sees no failure, retypes, and does it again.
 */
export function queryRefusalPageHtml() {
  return `<!doctype html><meta charset="utf-8"><title>blaze — refused</title>
<h1>Refused: credentials must never travel in a URL</h1>
<p>This request carried a query string. Blaze's sign-in and setup pages accept nothing in
a URL, so the request was refused rather than answered.</p>
<p>A URL is written to your browser history and to the access log of every proxy in front
of this board. <strong>If you just submitted a password or a setup token, treat it as
compromised</strong>: change the password with <code>blaze user passwd</code>, or restart
blaze to mint a fresh setup token.</p>
<p>Nothing you sent is repeated on this page.</p>
`;
}

/**
 * The sign-in page.
 *
 * Self-contained and plain, for the reason BLZ-358's setup page is: it is served BEFORE
 * any credential is checked, and it must not depend on the board renderer — which is the
 * thing that is not safe to serve yet. It carries no ticket data, no view list and no
 * project names, because an unauthenticated caller must learn nothing from it.
 */
export function signinPageHtml({ csrf, boardTitle = "blaze", nonce = "" }) {
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!doctype html><meta charset="utf-8"><title>${esc(boardTitle)} — sign in</title>
<style nonce="${esc(nonce)}">body{font:15px/1.5 system-ui,sans-serif;max-width:24rem;margin:6rem auto;padding:0 1rem}
label{display:block;margin:1rem 0 .25rem;font-weight:600}input{width:100%;padding:.5rem;font:inherit;box-sizing:border-box}
button{margin-top:1.5rem;padding:.6rem 1.2rem;font:inherit}code{background:#eee;padding:.15rem .35rem}
#out{margin-top:1.25rem;color:#a00;min-height:1.5rem}
.warn{color:#a00}.hint{margin-top:2.5rem;color:#666;font-size:.9em}</style>
<h1>Sign in</h1>
<noscript><p class="warn"><strong>JavaScript is required to sign in.</strong> This
form is submitted by script so that the password travels in a request body and never in a
URL. With script disabled the submission below will be refused, not sent.</p></noscript>
<!-- METHOD="POST" IS LOAD-BEARING MARKUP, NOT DECORATION — BLZ-566.
     A form with NO method GETs the current URL, which puts every field in the QUERY
     STRING: the password here, and the one-time setup token on /setup. That lands in
     browser history, in the address bar, and in the access log of every proxy in front of
     this board — while blaze's own logs, which record no request line, stay clean and
     show nothing. It contradicts setup-token.mjs's stated invariant that the token value
     is "never logged, echoed, or rendered".
     The only thing that prevented it was 'e.preventDefault()' in the script below, and a
     script is exactly what a fronting proxy's default 'script-src 'self'' CSP removes —
     or what a hurried Enter beats to the parser. The METHOD has to be right in the markup
     for the failure mode to be a refused POST rather than a silent leak. -->
<form id="f" method="post" action="${esc(SIGNIN_PATH)}">
  <label for="email">Email address</label>
  <input id="email" name="email" type="email" autocomplete="username" required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password"
         minlength="${MIN_PASSWORD_LENGTH}" required>
  <button type="submit">Sign in</button>
</form>
<div id="out"></div>
<p class="hint">No password yet? On the machine
hosting the board, run <code>blaze user passwd --email &lt;you&gt;</code>. API and CLI
callers keep using <code>Authorization: Bearer blz_…</code> and do not sign in here.</p>
<script nonce="${esc(nonce)}">
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  out.textContent = "";
  const r = await fetch(${JSON.stringify(SIGNIN_PATH)}, { method: "POST",
    headers: { "content-type": "application/json", "x-blaze-csrf": ${JSON.stringify(csrf)} },
    body: JSON.stringify({ email: email.value, password: password.value }) });
  if (r.ok) { password.value = ""; location.href = "/"; return; }
  const j = await r.json().catch(() => ({}));
  out.textContent = (j.errors || ["sign-in failed"]).join(", ");
});
</script>`;
}

/**
 * Answer `/signin` and `/signout`, or decline.
 *
 * @returns true when this handler wrote the response, false when the caller should carry
 *   on. Declining is how the routes stay ABSENT rather than hidden on a board with no
 *   users: there is nothing to sign in as, so the server's own 404 answers, and no new
 *   surface is added to an unconfigured board.
 */
export async function handleSigninRoutes({ req, res, url, store, csrf, boardTitle }) {
  const path = url.pathname;
  if (path !== SIGNIN_PATH && path !== SIGNOUT_PATH) return false;
  // NO STORE MEANS NO ACCOUNTS, so there is no credential this could check and no session
  // it could mint. Declining (rather than answering 404 here) keeps ONE 404 in the server
  // — the one every other unknown path already gets — so this route is indistinguishable
  // from a path that was never implemented.
  if (!store) return false;

  const json = (code, obj, headers = {}) => {
    // `no-store` matters most on the SUCCESS response: it carries a `Set-Cookie` with the
    // session plaintext, and /setup's equivalent carries the API token shown once.
    res.writeHead(code, { "content-type": "application/json", ...preAuthHeaders(), ...headers });
    res.end(JSON.stringify(obj));
    return true;
  };
  // ONE REFUSAL, CONSTRUCTED ONCE, for every way signing in can fail: no such account, no
  // password set, wrong password, suspended, or stripped of its membership. `/setup`
  // already makes this trade — it checks the setup token before the email precisely so a
  // caller learns nothing — and the store equalises the KDF cost behind it so the identical
  // body is not undone by a stopwatch.
  const refuse = () => json(401, { errors: ["invalid email address or password"] });

  // WRAPPED, because this whole branch runs before any credential is checked and an
  // uncaught throw in an async handler ends the process for every connected session
  // rather than refusing one request. serve.mjs states that rule three times; the setup
  // branch learned it from a single unauthenticated request with a poisoned `toString`.
  try {
    // NO PRE-AUTH ROUTE TAKES A QUERY STRING. Checked before the method split so it
    // covers the GET a method-less form used to make AND any POST carrying one, and
    // before anything is rendered so nothing it carried is ever echoed.
    if ([...url.searchParams.keys()].length) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8",
                           ...preAuthHeaders() });
      res.end(queryRefusalPageHtml());
      return true;
    }

    if (req.method === "GET" && path === SIGNIN_PATH) {
      const nonce = cspNonce();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8",
                           ...preAuthHeaders({ nonce }) });
      res.end(signinPageHtml({ csrf, boardTitle, nonce }));
      return true;
    }

    if (req.method === "POST" && (path === SIGNIN_PATH || path === SIGNOUT_PATH)) {
      // NOT authentication — ADR-0013 §7 — and it is checked FIRST for the same reason
      // `/setup` checks its token first: a caller who cannot get past this must learn
      // nothing about whether the address they sent exists. This ticket is what puts a
      // cookie back into the browser flow, so the CSRF check the ADR made conditional on
      // one is load-bearing again rather than vestigial.
      if (req.headers["x-blaze-csrf"] !== csrf) return json(403, { errors: ["bad csrf token"] });

      const secure = isSecureRequest(req);
      if (path === SIGNOUT_PATH) {
        const presented = sessionFrom(req.headers);
        if (presented) {
          // Best-effort: a sign-out that could not reach the database must still clear the
          // browser's cookie. The session expires on its own either way.
          try {
            const found = await store.lookupSessionByHash(hashToken(presented));
            if (found?.token?.id) await store.revokeSession(found.token.id);
          } catch { /* the cookie is cleared below regardless */ }
        }
        return json(200, { ok: true }, { "set-cookie": clearedSessionCookieHeader({ secure }) });
      }

      let body;
      // The parse error's own wording is never echoed: this is the pre-auth surface, and
      // "Unexpected token } in JSON at position 9" is an internal message.
      try { body = await readJsonBody(req); } catch { return json(400, { errors: ["malformed request"] }); }
      // TYPE-CHECKED, NOT COERCED. `String(x)` throws outright on an object with a poisoned
      // `toString`, and both of these come straight off an unauthenticated request. A
      // non-string is not a wrong password; it is not a password — and it is answered with
      // the same refusal, because saying "that was the wrong SHAPE" is still saying
      // something about what would have been right.
      if (typeof body?.email !== "string" || typeof body?.password !== "string") return refuse();

      const r = await store.signIn({ email: body.email, password: body.password });
      if (!r.ok) return refuse();
      // The credential exists exactly here and is never logged, for the reason the setup
      // token is never logged: anything that reaches a log stream has to be rotated.
      return json(200, { ok: true, email: r.email, role: r.role, expiresAt: r.expiresAt },
        { "set-cookie": sessionCookieHeader({ token: r.token, secure }) });
    }
  } catch {
    // Says nothing about what failed, for the same reason the setup branch's catch says
    // nothing. There is no operator diagnostic to print here: unlike setup, no state was
    // being created, and a failed sign-in is a routine event an attacker can produce at
    // will — logging each one is a log-flooding surface, not a support aid.
    return json(500, { errors: ["sign-in could not be completed"] });
  }
  // A method this route does not answer (PUT /signin, say) falls through to the server's
  // own 404 rather than being invented here.
  return false;
}
