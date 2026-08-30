// tests/signin-flow.test.mjs — BLZ-566. A human can reach the board again.
//
// THE DEFECT, MEASURED LIVE ON 2026-08-30: once any user existed, `/` was 401, every
// `/api/*` was 401, and `/setup` was 404. `bearerFrom` read the Authorization header and
// only that header, and a browser cannot set it — so the board was reachable from curl,
// from the API, and from a reverse proxy that injected the header, and from nothing a
// person uses. `docs/guide/commands.md` described the hole and called the fix "tracked
// separately"; no ticket carried it.
//
// These tests are the reachability proof for the fix, in the shape BLZ-358's setup tests
// take. The ones to read first are in "what did NOT change": bearer, fail-closed, and the
// standing refusal to treat `x-blaze-csrf` as a credential.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, CSRF } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { loadIdentity } from "../scripts/model/identity-db.mjs";
import { SESSION_COOKIE } from "../scripts/model/serve-auth.mjs";

const PASSWORD = "correct horse battery staple";
const roots = [];

function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-signin-"));
  roots.push(root);
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  mkdirSync(join(projects, "OBA", "in-progress"), { recursive: true });
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    ["---", "id: OBA-1", "title: t", "type: task", "project: OBA", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01",
     "---", "", "## Acceptance Criteria", "", "- [ ] one", ""].join("\n"));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return { root, projects };
}
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

async function boot(opts) {
  const server = startServer({ port: 0, ...opts });
  await new Promise((res) => server.once("listening", res));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** A board with one admin, a password, and an API token. */
async function configured({ role = "admin" } = {}) {
  const { root, projects } = board();
  const { token } = await addUser(root, { email: "op@example.com", role });
  const id = loadIdentity(root);
  await id.store.setPassword({ email: "op@example.com", password: PASSWORD });
  id.close();
  const { server, base } = await boot({ root, projectsDir: projects });
  return { root, projects, server, base, bearer: token.token };
}

/** A board with NO users, bound off-loopback, so `/setup` is the surface being served. */
async function unconfigured() {
  const { root, projects } = board();
  const server = startServer({ port: 0, root, projectsDir: projects, host: "0.0.0.0" });
  await new Promise((res) => server.once("listening", res));
  return { root, server, base: `http://127.0.0.1:${server.address().port}` };
}

const post = (base, path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/json", "x-blaze-csrf": CSRF, ...headers },
    body: JSON.stringify(body),
  });

/** The cookie a successful sign-in handed back, as a request header value. */
function cookieOf(res) {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(set, "sign-in must set the session cookie");
  return { header: set, value: set.split(";")[0] };
}

describe("a browser can sign in and use the board", () => {
  test("an unauthenticated browser asking for the board is sent to /signin", async () => {
    const { server, base } = await configured();
    try {
      const r = await fetch(`${base}/`, { redirect: "manual", headers: { accept: "text/html" } });
      assert.equal(r.status, 302);
      assert.equal(r.headers.get("location"), "/signin");
      assert.doesNotMatch(await r.text(), /OBA-1/, "the redirect must carry no board content");
    } finally { server.close(); }
  });

  test("the sign-in page is served, and carries no board content", async () => {
    const { server, base } = await configured();
    try {
      const r = await fetch(`${base}/signin`);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.match(html, /type="password"/, "…it asks for a password");
      assert.doesNotMatch(html, /OBA-1/, "…and nothing else");
    } finally { server.close(); }
  });

  test("the right password mints a session cookie, and the cookie opens the board",
    async () => {
      const { server, base } = await configured();
      try {
        const r = await post(base, "/signin", { email: "op@example.com", password: PASSWORD });
        assert.equal(r.status, 200);
        const cookie = cookieOf(r);

        const page = await fetch(`${base}/`, { headers: { cookie: cookie.value } });
        assert.equal(page.status, 200);
        assert.match(await page.text(), /OBA-1/, "the board itself, in a browser, at last");

        const api = await fetch(`${base}/api/live`, { headers: { cookie: cookie.value } });
        assert.equal(api.status, 200);
      } finally { server.close(); }
    });

  test("the session cookie is HttpOnly, SameSite=Strict, path-scoped and expiring",
    async () => {
      const { server, base } = await configured();
      try {
        const { header } = cookieOf(
          await post(base, "/signin", { email: "op@example.com", password: PASSWORD }));
        assert.match(header, /HttpOnly/i, "script must not be able to read it");
        assert.match(header, /SameSite=Strict/i,
          "an ambient credential must not travel on a cross-site request");
        assert.match(header, /Path=\//i);
        assert.match(header, /Max-Age=\d+/i, "a session that never expires is not a session");
        assert.doesNotMatch(header, /Secure/i, "…and not Secure over plain HTTP, or it is never sent");
      } finally { server.close(); }
    });

  test("behind a TLS-terminating proxy the cookie is Secure", async () => {
    const { server, base } = await configured();
    try {
      const { header } = cookieOf(await post(base, "/signin",
        { email: "op@example.com", password: PASSWORD }, { "x-forwarded-proto": "https" }));
      assert.match(header, /Secure/i);
    } finally { server.close(); }
  });

  test("the NEAREST proxy decides Secure, not the client — the LAST forwarded value wins",
    async () => {
      // `X-Forwarded-*` is a CHAIN: the client's own value sits leftmost and each proxy
      // APPENDS its view, so the trustworthy element is the one the nearest trusted proxy
      // wrote — the last. Reading the leftmost let a client sending
      // `x-forwarded-proto: http` yield `http, https` behind an appending proxy and strip
      // `Secure` from a cookie issued over a genuine TLS connection.
      const { server, base } = await configured();
      try {
        const { header } = cookieOf(await post(base, "/signin",
          { email: "op@example.com", password: PASSWORD },
          { "x-forwarded-proto": "http, https" }));
        assert.match(header, /Secure/i,
          "a client-supplied leftmost value must not strip Secure from a TLS connection");
      } finally { server.close(); }
    });

  test("…and when the nearest proxy says plain HTTP, Secure is correctly withheld",
    async () => {
      // The other direction, and it is not symmetry for its own sake: a `Secure` cookie is
      // never SENT over plain HTTP, so marking one here would break sign-in outright
      // rather than harden it.
      const { server, base } = await configured();
      try {
        const { header } = cookieOf(await post(base, "/signin",
          { email: "op@example.com", password: PASSWORD },
          { "x-forwarded-proto": "https, http" }));
        assert.doesNotMatch(header, /Secure/i);
      } finally { server.close(); }
    });

  test("signing out revokes the session — the cookie stops working", async () => {
    const { server, base } = await configured();
    try {
      const { value } = cookieOf(
        await post(base, "/signin", { email: "op@example.com", password: PASSWORD }));
      assert.equal((await fetch(`${base}/`, { headers: { cookie: value } })).status, 200);

      const out = await post(base, "/signout", {}, { cookie: value });
      assert.equal(out.status, 200);
      assert.match(out.headers.getSetCookie().join(" "), /blaze_session=;/,
        "…and the browser is told to drop it");

      const after = await fetch(`${base}/`, { redirect: "manual",
                                              headers: { cookie: value, accept: "text/html" } });
      assert.equal(after.status, 302, "a revoked session is an unauthenticated browser again");
    } finally { server.close(); }
  });
});

describe("A CREDENTIAL CAN NEVER LEAVE THE BROWSER IN A URL", () => {
  // THE DEFECT THIS PINS, MEASURED AGAINST A LIVE SERVER RATHER THAN THE SOURCE: both
  // pre-auth forms were emitted as `<form id="f">` — no method. A form with no method GETs
  // the current URL, so every field goes in the QUERY STRING: the password here, and on
  // `/setup` the ONE-TIME SETUP TOKEN. That lands in browser history, in the address bar,
  // and in the access log of every proxy fronting the board — while blaze's own logs,
  // which record no request line, stay clean and show nothing at all. It contradicts
  // `setup-token.mjs`'s stated invariant that the token value is "never logged, echoed, or
  // rendered".
  //
  // The ONLY thing preventing it was `e.preventDefault()` in a trailing inline script.
  // Two realistic ways that script does not run: a fronting reverse proxy adding a default
  // `script-src 'self'` CSP — blaze sets none of its own and its docs recommend a proxy —
  // or Enter pressed before the script parses. And the server answered the resulting GET
  // with 200 and the page again, so the operator saw no failure and simply retried.
  //
  // ASSERTED ON THE RESPONSE, NOT THE MARKUP SOURCE. These fetch the running server, for
  // the same reason the defect was confirmed that way: the property is what a browser
  // receives.
  for (const [name, path] of [["the sign-in page", "/signin"], ["the setup page", "/setup"]]) {
    test(`${name} submits by POST, so a credential never reaches a URL`, async () => {
      const ctx = path === "/setup" ? await unconfigured() : await configured();
      try {
        const r = await fetch(`${ctx.base}${path}`);
        assert.equal(r.status, 200);
        const html = await r.text();
        const form = (html.match(/<form[^>]*>/) || [""])[0];
        assert.match(form, /method="post"/i,
          "a form with no method GETs the current URL, putting every field in the query string");
        assert.match(form, /action="\/(signin|setup)"/,
          "…and it names its own action rather than inheriting whatever URL it was served from");
        assert.match(html, /<noscript>/,
          "with script disabled the submission is refused, and the operator is told so");
      } finally { ctx.server.close(); }
    });

    test(`${name} carries no-store, no-referrer and a CSP`, async () => {
      const ctx = path === "/setup" ? await unconfigured() : await configured();
      try {
        const r = await fetch(`${ctx.base}${path}`);
        assert.equal(r.headers.get("cache-control"), "no-store",
          "a page carrying a credential form must not be cached or back-button restored");
        assert.equal(r.headers.get("referrer-policy"), "no-referrer");
        assert.equal(r.headers.get("x-content-type-options"), "nosniff");
        const csp = r.headers.get("content-security-policy");
        assert.ok(csp, "a pre-auth page must state its own policy");
        assert.match(csp, /form-action 'self'/,
          "the credential form must not be retargetable at another origin");
        assert.match(csp, /frame-ancestors 'none'/);
        assert.match(csp, /script-src 'nonce-/, "the one inline script runs by nonce, nothing else does");
      } finally { ctx.server.close(); }
    });

    test(`${name} REFUSES a GET carrying credentials in the query, it does not answer 200`,
      async () => {
        // Answering 200 with the page again is the worst response available: the operator
        // sees no failure, retypes, and does it again.
        const ctx = path === "/setup" ? await unconfigured() : await configured();
        try {
          for (const query of [`?email=op%40example.com&password=${encodeURIComponent(PASSWORD)}`,
                               "?token=blz_setup_abcdef", "?anything=at-all"]) {
            const r = await fetch(`${ctx.base}${path}${query}`);
            assert.equal(r.status, 400, `${path}${query} must be refused`);
            const body = await r.text();
            assert.doesNotMatch(body, /correct horse battery staple/,
              "and the refusal must not echo what it refused");
            assert.doesNotMatch(body, /blz_setup_abcdef/);
            assert.match(body, /treat it as\s+compromised/i,
              "the operator is told the value is already in a history and a proxy log");
          }
        } finally { ctx.server.close(); }
      });
  }

  // ---- BLOCKER 3: THE PAGES MUST FUNCTION UNDER THEIR OWN HEADERS ------------------
  //
  // The CSP test above asserts `script-src 'nonce-…'` is PRESENT. That is not the same
  // question as "can this page do its job", and the gap let two blockers ship green:
  //
  //   a CSP with `default-src 'none'` and NO `connect-src`, which blocks the very
  //     `fetch()` both pages submit with — zero requests leave the page, the error area
  //     stays empty, and the operator sees nothing happen at all; and
  //   a `/setup` inline script that HAS NEVER PARSED, because a bare `\n` inside the
  //     JS template literal that builds the page is consumed at build time and the served
  //     HTML carried a real newline inside a double-quoted string.
  //
  // A test that would pass against a page whose script never runs is not testing the page.
  // These three assert the page WORKS: the script parses, the policy permits the call the
  // script makes, and every style the markup uses is reachable under a nonce-only
  // `style-src`.
  const scriptsIn = (html) =>
    [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  for (const [name, path] of [["the sign-in page", "/signin"], ["the setup page", "/setup"]]) {
    test(`${name}'s inline script actually PARSES`, async () => {
      const ctx = path === "/setup" ? await unconfigured() : await configured();
      try {
        const html = await (await fetch(`${ctx.base}${path}`)).text();
        const scripts = scriptsIn(html);
        // ASSERT THE OBSERVATION HAPPENED: a page with no script would otherwise sail
        // through the loop below without ever parsing anything.
        assert.equal(scripts.length, 1, `expected exactly one inline script on ${path}`);
        assert.doesNotThrow(() => new Function(scripts[0]),
          `${path}'s inline script does not parse, so its submit handler never binds and `
          + "the form submits natively");
      } finally { ctx.server.close(); }
    });

    test(`${name}'s CSP permits the request its own script makes`, async () => {
      const ctx = path === "/setup" ? await unconfigured() : await configured();
      try {
        const r = await fetch(`${ctx.base}${path}`);
        const html = await r.text();
        const csp = r.headers.get("content-security-policy");
        // The page submits with fetch(), which CSP governs under `connect-src` — and
        // which falls back to `default-src` when unset. `default-src 'none'` therefore
        // BLOCKS it unless connect-src is stated.
        assert.match(scriptsIn(html)[0], /fetch\(/,
          "this test's premise is that the page submits by fetch");
        assert.match(csp, /connect-src 'self'/,
          "without connect-src the page's own fetch is blocked by default-src 'none' and "
          + "the operator sees nothing happen at all");
      } finally { ctx.server.close(); }
    });

    test(`${name} uses no inline style= attribute, which its own CSP would block`,
      async () => {
        const ctx = path === "/setup" ? await unconfigured() : await configured();
        try {
          const html = await (await fetch(`${ctx.base}${path}`)).text();
          assert.equal((html.match(/ style="/g) || []).length, 0,
            "style-src is nonce-only, so an inline style= attribute is dropped — which "
            + "silently un-styles the <noscript> warning that tells the operator why "
            + "nothing is happening");
        } finally { ctx.server.close(); }
      });
  }

  test("the sign-in page's script posts JSON with the CSRF header and never navigates",
    async () => {
      // END TO END, WITHOUT A BROWSER. The parsed script is executed against a minimal
      // DOM so the submit handler runs for real: what it sends is what a browser sends.
      const { server, base } = await configured();
      try {
        const html = await (await fetch(`${base}/signin`)).text();
        const calls = [];
        let handler = null;
        const el = (value) => ({ value });
        const sandbox = {
          email: el("op@example.com"),
          password: el(PASSWORD),
          out: { textContent: "" },
          location: { href: "/signin" },
          document: {
            getElementById: (id) => (id === "f"
              ? { addEventListener: (_e, fn) => { handler = fn; } }
              : sandbox[id]),
          },
          fetch: async (url, init) => {
            calls.push({ url, init });
            return { ok: true, json: async () => ({ ok: true }) };
          },
        };
        // eslint-disable-next-line no-new-func
        new Function(...Object.keys(sandbox), scriptsIn(html)[0])(...Object.values(sandbox));
        assert.ok(handler, "the script must bind a submit handler — it did not");

        let defaultPrevented = false;
        await handler({ preventDefault: () => { defaultPrevented = true; } });

        assert.equal(defaultPrevented, true, "a native submit would put the password in a URL");
        assert.equal(calls.length, 1, "the handler must actually send the request");
        assert.equal(calls[0].init.method, "POST");
        assert.equal(calls[0].init.headers["x-blaze-csrf"], CSRF);
        assert.match(calls[0].init.headers["content-type"], /application\/json/);
        assert.doesNotMatch(String(calls[0].url), /password/,
          "the credential goes in the body, never in the URL");
        assert.match(calls[0].init.body, /correct horse battery staple/,
          "…and it is genuinely in the body");
        assert.equal(sandbox.location.href, "/", "a successful sign-in lands on the board");
      } finally { server.close(); }
    });

  test("the /setup response that carries the API token once is not cacheable", async () => {
    const ctx = await unconfigured();
    try {
      const token = readFileSync(join(ctx.root, ".blaze", "setup-token"), "utf8");
      const done = await post(ctx.base, "/setup",
        { token, email: "op@example.com", password: PASSWORD });
      assert.equal(done.status, 200);
      assert.equal(done.headers.get("cache-control"), "no-store",
        "this body holds the API token plaintext — the only moment it exists");
    } finally { ctx.server.close(); }
  });

  test("a successful sign-in response is not cacheable either", async () => {
    const { server, base } = await configured();
    try {
      const r = await post(base, "/signin", { email: "op@example.com", password: PASSWORD });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("cache-control"), "no-store",
        "it carries the session plaintext in Set-Cookie");
    } finally { server.close(); }
  });
});

describe("a failed sign-in reveals nothing", () => {
  test("a wrong password and an unknown address give the identical answer", async () => {
    const { server, base } = await configured();
    try {
      const wrong = await post(base, "/signin", { email: "op@example.com", password: "nope nope nope" });
      const unknown = await post(base, "/signin", { email: "ghost@example.com", password: PASSWORD });
      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, wrong.status);
      assert.deepEqual(await unknown.json(), await wrong.json(),
        "the two must be byte-identical, or sign-in enumerates accounts");
      assert.equal(wrong.headers.getSetCookie().length, 0, "and neither hands back a credential");
    } finally { server.close(); }
  });

  test("a malformed body is refused without a stack trace or an internal message",
    async () => {
      const { server, base } = await configured();
      try {
        const r = await fetch(`${base}/signin`, { method: "POST",
          headers: { "content-type": "application/json", "x-blaze-csrf": CSRF }, body: "{not json" });
        assert.equal(r.status, 400);
        const body = JSON.stringify(await r.json());
        assert.doesNotMatch(body, /JSON|SyntaxError|at /, "no internal wording on the pre-auth surface");
      } finally { server.close(); }
    });

  test("a non-string password is not a wrong password — it is refused as a shape", async () => {
    const { server, base } = await configured();
    try {
      for (const password of [null, 12345678901234, { toString: null }, ["a"]]) {
        const r = await post(base, "/signin", { email: "op@example.com", password });
        assert.equal(r.status, 401, `${JSON.stringify(password)} must be refused, not thrown over`);
      }
      // The server must still be alive: a poisoned toString on the pre-auth surface used
      // to end the process for every connected session.
      assert.equal((await fetch(`${base}/signin`)).status, 200);
    } finally { server.close(); }
  });

  test("the session credential is never written to a log", async () => {
    const { server, base } = await configured();
    const said = [];
    const real = { log: console.log, error: console.error, warn: console.warn };
    console.log = (...a) => said.push(a.join(" "));
    console.error = (...a) => said.push(a.join(" "));
    console.warn = (...a) => said.push(a.join(" "));
    try {
      const { value } = cookieOf(
        await post(base, "/signin", { email: "op@example.com", password: PASSWORD }));
      await post(base, "/signin", { email: "op@example.com", password: "wrong wrong wrong" });
      const token = value.split("=")[1];
      assert.doesNotMatch(said.join("\n"), new RegExp(token.slice(0, 24)),
        "a credential that reaches a log stream is a credential that has to be rotated");
      assert.doesNotMatch(said.join("\n"), /correct horse battery staple/,
        "and a password even more so");
    } finally {
      Object.assign(console, real);
      server.close();
    }
  });
});

describe("what did NOT change", () => {
  test("a bearer token works exactly as it did, and never consults a session", async () => {
    const { server, base, bearer } = await configured();
    try {
      const auth = { authorization: `Bearer ${bearer}` };
      assert.equal((await fetch(`${base}/`, { headers: auth })).status, 200);
      assert.equal((await fetch(`${base}/api/live`, { headers: auth })).status, 200);
      assert.equal((await fetch(`${base}/api/sync`, { headers: auth })).status, 200);
    } finally { server.close(); }
  });

  test("no credential at all is still 401 for a non-browser caller", async () => {
    const { server, base } = await configured();
    try {
      assert.equal((await fetch(`${base}/api/live`)).status, 401);
      const page = await fetch(`${base}/`, { redirect: "manual" });
      assert.equal(page.status, 401, "a caller that did not ask for HTML is not redirected");
      assert.match(await page.text(), /\/signin/, "…but it is told where the door is");
    } finally { server.close(); }
  });

  // THIS GUARD IS PINNED, AND AN EARLIER WRITE-UP CALLED IT "UNPINNABLE BY CONSTRUCTION".
  // That was wrong, and the correction is recorded here rather than only in a report: a
  // guard described as unpinnable when it is in fact pinned is the same class of
  // inaccuracy as the reverse. Measured — making `handleSigninRoutes` actually ANSWER
  // `GET /api/*` (widening its route test and dropping `path === SIGNIN_PATH` from the GET
  // branch) turns THIS test red along with 14 others — 15 failing tests in total — across
  // six files: serve-identity, supervisor-identity, setup-flow, identity-resilience,
  // board-overstatement-oracle and this one. (An earlier draft of this comment said "16
  // others"; that count was taken from a run whose two forwarded-proto failures were
  // unrelated to the revert, and it is corrected here.) A narrower revert that merely
  // widens the route test is INEFFECTIVE — the handler still falls through and declines —
  // which is the reason the first attempt at this row read green and was misfiled.
  test("an unclassified /api/* route is STILL 404, session cookie or not", async () => {
    const { server, base } = await configured();
    try {
      const { value } = cookieOf(
        await post(base, "/signin", { email: "op@example.com", password: PASSWORD }));
      assert.equal((await fetch(`${base}/api/invented`, { headers: { cookie: value } })).status, 404);
    } finally { server.close(); }
  });

  test("x-blaze-csrf alone still authenticates nothing", async () => {
    const { server, base } = await configured();
    try {
      const r = await fetch(`${base}/api/live`, { headers: { "x-blaze-csrf": CSRF } });
      assert.equal(r.status, 401, "the CSRF value is readable by anyone who can GET / — "
        + "it is forgery protection, not a credential");
    } finally { server.close(); }
  });

  test("POST /signin is itself CSRF-protected, because the session is a cookie", async () => {
    const { server, base } = await configured();
    try {
      const r = await fetch(`${base}/signin`, { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "op@example.com", password: PASSWORD }) });
      assert.equal(r.status, 403, "ADR-0013 §7: CSRF is retained while any part of the "
        + "browser flow uses a cookie — and this ticket puts one back");
      assert.equal(r.headers.getSetCookie().length, 0);
    } finally { server.close(); }
  });

  test("a cookie-authenticated write still needs the CSRF header", async () => {
    const { server, base } = await configured();
    try {
      const { value } = cookieOf(
        await post(base, "/signin", { email: "op@example.com", password: PASSWORD }));
      const r = await fetch(`${base}/api/edit`, { method: "POST",
        headers: { "content-type": "application/json", cookie: value },
        body: JSON.stringify({ id: "OBA-1", patch: { title: "x" } }) });
      assert.equal(r.status, 403);
    } finally { server.close(); }
  });
});

describe("a session cannot exceed its owner's CURRENT role", () => {
  test("demoting the owner narrows a live session on the very next request", async () => {
    const { root, server, base } = await configured({ role: "admin" });
    try {
      const { value } = cookieOf(
        await post(base, "/signin", { email: "op@example.com", password: PASSWORD }));
      const edit = () => post(base, "/api/edit", { id: "OBA-1", patch: { title: "changed" } },
                              { cookie: value });
      assert.equal((await edit()).status, 200);

      const id = loadIdentity(root);
      const [user] = await id.store.listUsers();
      await id.store.setRole({ userId: user.id, role: "viewer" });
      id.close();

      assert.equal((await edit()).status, 403,
        "no session bookkeeping happened — the scopes are re-derived from the role");
      assert.equal((await fetch(`${base}/`, { headers: { cookie: value } })).status, 200,
        "…and a viewer can still read");
    } finally { server.close(); }
  });
});

describe("the pre-auth surface stays fail-closed", () => {
  test("with NO users configured there is no /signin at all — absent, not hidden",
    async () => {
      const { root, projects } = board();
      const { server, base } = await boot({ root, projectsDir: projects });
      try {
        assert.equal((await fetch(`${base}/signin`)).status, 404);
        assert.equal((await post(base, "/signin", { email: "a@b.c", password: PASSWORD })).status, 404);
      } finally { server.close(); }
    });

  test("during first-run setup, /signin is the same 503 as everything else", async () => {
    const { root, projects } = board();
    const server = startServer({ port: 0, root, projectsDir: projects, host: "0.0.0.0" });
    await new Promise((res) => server.once("listening", res));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const r = await fetch(`${base}/signin`);
      assert.equal(r.status, 503, "there is no user to sign in as, and setup owns the surface");
      assert.doesNotMatch(await r.text(), /OBA-1/);
    } finally { server.close(); }
  });
});

describe("first-run setup leaves an operator who can sign in", () => {
  test("a password given at /setup is usable at /signin immediately", async () => {
    const { root, projects } = board();
    const server = startServer({ port: 0, root, projectsDir: projects, host: "0.0.0.0" });
    await new Promise((res) => server.once("listening", res));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const token = (await import("node:fs")).readFileSync(join(root, ".blaze", "setup-token"), "utf8");
      const done = await post(base, "/setup",
        { token, email: "op@example.com", password: PASSWORD });
      assert.equal(done.status, 200);
      assert.equal((await done.json()).passwordSet, true);

      const r = await post(base, "/signin", { email: "op@example.com", password: PASSWORD });
      assert.equal(r.status, 200, "the operator is not locked out of the board they just made");
      cookieOf(r);
    } finally { server.close(); }
  });

  test("a password that fails the policy is refused BEFORE any administrator is created",
    async () => {
      const { root, projects } = board();
      const server = startServer({ port: 0, root, projectsDir: projects, host: "0.0.0.0" });
      await new Promise((res) => server.once("listening", res));
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        const token = (await import("node:fs")).readFileSync(join(root, ".blaze", "setup-token"), "utf8");
        const r = await post(base, "/setup", { token, email: "op@example.com", password: "short" });
        assert.equal(r.status, 400);
        assert.equal(loadIdentity(root).state, "absent",
          "a refused password must not leave a half-made board behind");
      } finally { server.close(); }
    });

  test("setup WITHOUT a password still works — the API contract is unchanged", async () => {
    const { root, projects } = board();
    const server = startServer({ port: 0, root, projectsDir: projects, host: "0.0.0.0" });
    await new Promise((res) => server.once("listening", res));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const token = (await import("node:fs")).readFileSync(join(root, ".blaze", "setup-token"), "utf8");
      const done = await post(base, "/setup", { token, email: "op@example.com" });
      assert.equal(done.status, 200);
      const body = await done.json();
      assert.match(body.token, /^blz_/, "the API token is still issued and still shown once");
      assert.equal(body.passwordSet, false, "…and the response says plainly that sign-in is not set up");
    } finally { server.close(); }
  });
});
