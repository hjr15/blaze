// scripts/model/board-csp.mjs — BLZ-578. The POST-AUTH board page gets a policy too.
//
// WHY A SECOND FILE AND NOT `preAuthHeaders`. BLZ-566 hardened `/signin` and `/setup`
// only, and the two surfaces are not the same shape: a pre-auth page carries ONE inline
// script, ONE inline style and a credential form (`form-action 'self'` is load-bearing
// there); the board carries nine inline scripts, a stylesheet, an EventSource, and no
// form at all. Reusing the pre-auth header on the board would have shipped a policy that
// silently disabled the page it protects — the exact defect BLZ-566 itself shipped once
// (`default-src 'none'` with no `connect-src`, which blocked sign-in entirely while every
// test stayed green). So the two policies are stated separately, and each is pinned by
// tests against the surface it actually governs.
//
// THE NONCE IS THE WHOLE MECHANISM. `script-src 'nonce-…'` and nothing else means an
// injected `<script>` — BLZ-582 names one route in, a ticket body rendered into the page
// — cannot run, because the attacker cannot know the value. That is only true if the
// value is FRESH PER RESPONSE: a nonce constant across responses is a value the injected
// script can simply read off any other element and copy. `cspNonce()` is therefore called
// per request by each server, never at module scope, and `tests/board-csp.test.mjs` pins
// three responses carrying three different values.
//
// WHAT IS DELIBERATELY ABSENT:
//   * `'unsafe-inline'` — it would make the nonce decorative. Every inline script and
//     style on this page is stamped instead.
//   * `img-src`/`font-src` — the board loads no image and no font; they fall back to
//     `default-src 'none'`, which is the fail-closed direction. Adding one when the board
//     grows an image is a visible change; leaving a permissive one here would not be.
//   * `form-action 'self'` — the board has NO form (pinned), so `'none'` is what its
//     absence should cost an injected one.

import { cspNonce } from "./signin.mjs";

export { cspNonce };

/**
 * The `Content-Security-Policy` the board page is served under.
 *
 * `connect-src 'self'` covers BOTH the board's `fetch()` calls and the supervisor's
 * `new EventSource("/events")` — CSP governs an event stream under `connect-src`, so
 * omitting it would leave `blaze start`'s activity feed permanently disconnected with
 * nothing on screen saying why.
 *
 * @param {string} nonce the per-response nonce stamped on every inline script and style
 */
export function boardCsp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * The headers a board-page response carries.
 *
 * `x-content-type-options` and `referrer-policy` join the CSP for the same reasons
 * `preAuthHeaders` states them: no sniffing a served page into something executable, and
 * a page whose URL carries a `?focus=OBA-123` must not name it to whatever it navigates
 * to next. NOT `cache-control: no-store` — unlike the pre-auth pages this body carries no
 * credential, and the board is the page an operator reloads constantly.
 */
export function boardHeaders(nonce) {
  return {
    "content-security-policy": boardCsp(nonce),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}
