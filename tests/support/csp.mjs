// tests/support/csp.mjs — BLZ-570. A Content-Security-Policy evaluated, not spelled.
//
// WHY THIS EXISTS. The pre-auth CSP test asserted two unrelated facts: that the header
// text contained `connect-src 'self'`, and that the served script contained `fetch(`.
// A script that fetched `https://evil.example/…` kept BOTH green. The test pinned the
// SPELLING of the policy, never the question the policy exists to answer — would the
// browser allow the call this page actually makes. That is the same defect class as the
// CSP regression BLZ-566 hit, where a policy that disabled sign-in entirely read as
// passing.
//
// So: a small evaluator. Give it the served policy, the page's own origin, and a URL the
// page's script really passed to `fetch()`, and it answers the browser's question.
//
// IT THROWS ON ANYTHING IT DOES NOT UNDERSTAND, and that is the whole discipline of the
// file. An evaluator that silently returns `true` for a source expression it cannot parse
// is a test that passes because it stopped looking — the failure mode this module was
// written to remove. Every unknown token is an error the caller sees, not an allow.
//
// The supported subset is exactly what blaze serves: `'none'`, `'self'`, `*`,
// scheme-sources (`https:`), and host-sources (`https://host:port`, `*.host`). Nonces and
// hashes parse but grant no origin — correct, since they govern which inline scripts run,
// not which hosts may be reached.

/** Split a policy into directives. First occurrence of a name wins, as browsers do. */
export function parseCsp(csp) {
  const out = new Map();
  for (const part of String(csp ?? "").split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens[0].toLowerCase();
    if (!out.has(name)) out.set(name, tokens.slice(1));
  }
  return out;
}

/**
 * The directive a fetch of `kind` is actually governed by.
 *
 * THE FALLBACK IS THE LOAD-BEARING PART. `connect-src` falls back to `default-src` when
 * it is absent — which is exactly how `default-src 'none'` silently blocked the sign-in
 * page's own `fetch()` in BLZ-566. Returning the fallback (rather than "no directive")
 * is what makes deleting `connect-src` from the policy fail this evaluator instead of
 * sailing past it.
 *
 * @returns {{name: string, sources: string[]}|null} null when the policy governs this
 *   kind of fetch not at all — the only case in which everything is permitted.
 */
export function governingDirective(csp, kind) {
  const p = parseCsp(csp);
  if (p.has(kind)) return { name: kind, sources: p.get(kind) };
  if (p.has("default-src")) return { name: "default-src", sources: p.get("default-src") };
  return null;
}

const SCHEME_SOURCE = /^[a-z][a-z0-9+.-]*:$/;
const HOST_SOURCE =
  /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\*)(?::(\d{1,5}|\*))?(?:\/\S*)?$/;
// Keywords that constrain WHICH inline scripts run, never WHICH origins may be reached.
// Present in a source list they simply grant no origin; they are not unknown tokens.
const NON_ORIGIN_KEYWORD =
  /^'(?:nonce-[^']+|sha(?:256|384|512)-[^']+|unsafe-inline|unsafe-eval|unsafe-hashes|report-sample|wasm-unsafe-eval)'$/;
// `'strict-dynamic'` is NOT in that list, and its absence is deliberate. It does not
// merely grant no origin — it CHANGES WHAT THE OTHER SOURCES MEAN: a browser that sees it
// in `script-src` ignores every host-source, scheme-source and `'self'` in the same
// directive, so `script-src 'nonce-abc' 'strict-dynamic' https://cdn.example` allows
// cdn.example NOTHING, while a source-by-source walk reports ALLOW. Over-permissive, which
// is the exact failure class this file exists to remove — an evaluator that answers a
// question it has not modelled is worse than one that refuses. blaze serves no
// `'strict-dynamic'` today, so this throws rather than pretending; whoever adds one gets a
// loud failure and has to model it here first.
const STRICT_DYNAMIC = "'strict-dynamic'";

function hostSourceAllows(source, url) {
  const m = HOST_SOURCE.exec(source);
  if (!m) throw new Error(`unsupported CSP source expression: ${source}`);
  const [, scheme, wildcardSub, host, port] = m;
  if (scheme && `${scheme}:` !== url.protocol) return false;
  const target = url.hostname.toLowerCase();
  if (host === "*") { /* any host */ }
  else if (wildcardSub) { if (!target.endsWith(`.${host}`)) return false; }
  else if (target !== host) return false;
  if (port && port !== "*") { if ((url.port || defaultPort(url.protocol)) !== port) return false; }
  return true;
}

function defaultPort(protocol) {
  return protocol === "https:" ? "443" : protocol === "http:" ? "80" : "";
}

/**
 * Would a browser holding `csp` allow the page at `pageOrigin` to fetch `target`?
 *
 * @param {string} csp        the served Content-Security-Policy header value
 * @param {string} pageOrigin the origin the page was served from
 * @param {string} target     the URL the page's script passed to fetch() — relative or absolute
 * @param {string} kind       the fetch directive, default `connect-src`
 */
export function cspAllowsFetch(csp, { pageOrigin, target, kind = "connect-src" }) {
  const directive = governingDirective(csp, kind);
  if (!directive) return true;                      // nothing governs it at all
  if (directive.sources.some((s) => s.toLowerCase() === STRICT_DYNAMIC)) {
    throw new Error(
      `${directive.name} contains 'strict-dynamic', which changes what every host-source `
      + "in it means; this evaluator does not model it and will not guess");
  }
  const url = new URL(target, pageOrigin);
  const origin = new URL(pageOrigin).origin;
  for (const raw of directive.sources) {
    const s = raw.toLowerCase();
    if (s === "'none'") continue;                   // grants nothing
    if (s === "*") return true;
    if (s === "'self'") { if (url.origin === origin) return true; continue; }
    if (NON_ORIGIN_KEYWORD.test(s)) continue;
    if (s.startsWith("'")) throw new Error(`unsupported CSP source expression: ${raw}`);
    if (SCHEME_SOURCE.test(s)) { if (url.protocol === s) return true; continue; }
    if (hostSourceAllows(s, url)) return true;
  }
  return false;
}
