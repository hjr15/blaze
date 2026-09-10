// tests/board-csp.test.mjs — BLZ-578. The board page gets a policy, and keeps working.
//
// THE GAP. BLZ-566 hardened the PRE-AUTH surface only. `/signin` and `/setup` carry
// `default-src 'none'` with a per-response nonce; the board page — served the moment a
// session cookie or bearer token is present — carried NO Content-Security-Policy at all.
// Its nine inline scripts ran entirely unconstrained, with nothing standing between an
// injected `<script>` (BLZ-582 names one concrete route in: a ticket body rendered into
// the page) and the operator's session.
//
// THE HAZARD THIS FILE IS REALLY ABOUT. A policy copied from the pre-auth page would have
// silently broken the board. The pre-auth pages carry ONE inline script and ONE inline
// style; the board carries nine scripts, a stylesheet, and — until this ticket — inline
// `style=` attributes that a nonce-only `style-src` drops without a word. A CSP that
// disables the page it protects is worse than no CSP, and BLZ-566 shipped exactly that
// defect once already (`default-src 'none'` with no `connect-src`, which blocked sign-in
// entirely while every test stayed green).
//
// SO WHAT IS ACTUALLY PINNED HERE, stated plainly rather than implied:
//   * every script the browser must RUN carries the nonce the served header names — a
//     script without it is silently never executed, which is the whole failure mode;
//   * nothing in the served document, in any view fragment that gets swapped into it, or
//     in the panel fragment uses a construct the policy drops: no `style=` attribute, no
//     `on*=` handler, no `javascript:` URL, no form;
//   * every URL literal the board's scripts name is ADMITTED by the served policy,
//     evaluated (tests/support/csp.mjs), never string-matched — and the endpoints behind
//     those URLs really answer 200 for a signed-in browser;
//   * the policy admits nothing beyond that.
//
// WHAT IS NOT PINNED, said here rather than left to look covered: no browser is driven by
// this suite, and a URL the board assembles at run time out of a non-literal is not
// visible to the extraction below. The manual browser exercise that complements these
// lives in the ticket's own verification notes, not in CI.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, CSRF } from "../scripts/serve.mjs";
import { createApp } from "../scripts/supervisor.mjs";
import { loadConfig } from "../scripts/config.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { loadIdentity } from "../scripts/model/identity-db.mjs";
import { render as renderMetrics } from "../scripts/views/metrics.mjs";
import { cspAllowsFetch, parseCsp } from "./support/csp.mjs";

const PASSWORD = "correct horse battery staple";
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-boardcsp-"));
  roots.push(root);
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  const projects = join(root, "projects");
  for (const d of ["defined", "in-progress", "in-review", "done"]) {
    mkdirSync(join(projects, "OBA", d), { recursive: true });
  }
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    ["---", "id: OBA-1", "title: one", "type: task", "project: OBA", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01",
     "---", "", "## Acceptance Criteria", "", "- [ ] one", ""].join("\n"));
  writeFileSync(join(projects, "OBA", "done", "OBA-2.md"),
    ["---", "id: OBA-2", "title: two", "type: task", "project: OBA", "priority: high",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-02",
     "---", "", "## Acceptance Criteria", "", "- [x] one", ""].join("\n"));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "OBA" }));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return { root, projects };
}

/** A signed-in browser, on whichever of the two servers is asked for. */
async function signedIn({ supervisor = false } = {}) {
  const { root, projects } = board();
  await addUser(root, { email: "op@example.com", role: "admin" });
  const id = loadIdentity(root);
  await id.store.setPassword({ email: "op@example.com", password: PASSWORD });
  id.close();

  let server, close;
  if (supervisor) {
    const app = createApp(loadConfig({ root }), { root });
    await new Promise((res) => app.server.listen(0, "127.0.0.1", res));
    server = app.server; close = () => app.server.close();
  } else {
    server = startServer({ port: 0, root, projectsDir: projects });
    await new Promise((res) => server.once("listening", res));
    close = () => server.close();
  }
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/signin`, {
    method: "POST", headers: { "content-type": "application/json", "x-blaze-csrf": CSRF },
    body: JSON.stringify({ email: "op@example.com", password: PASSWORD }) });
  assert.equal(r.status, 200, "the fixture must be able to sign in");
  const cookie = r.headers.getSetCookie()[0].split(";")[0];
  return { root, base, cookie, close };
}

/**
 * The inline scripts a browser would EXECUTE.
 *
 * A `<script type="application/json">` data block (metrics' `cfd-series`) is deliberately
 * excluded: the HTML spec abandons "prepare the script element" before the CSP check for
 * a non-executable type, so a nonce on it would be theatre and its absence is not a bug.
 */
const executableScripts = (html) =>
  [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attrs]) => !/type\s*=\s*"(?!(?:text\/javascript|module)")/i.test(attrs))
    .map(([, attrs, body]) => ({ attrs, body }));

const nonceOf = (csp) => {
  const sources = parseCsp(csp).get("script-src") ?? [];
  const found = sources.map((s) => /^'nonce-(.+)'$/.exec(s)).find(Boolean);
  return found ? found[1] : null;
};

/**
 * An XML NAMESPACE IS NOT A NETWORK ORIGIN. `document.createElementNS(SVG_NS, ...)` names
 * `http://www.w3.org/2000/svg` as an identifier — nothing is ever fetched from it, and no
 * CSP directive governs it. Excluded BY VALUE against a closed list rather than by
 * guessing at the call around it, so a literal that is genuinely fetched can never fall
 * through this hole.
 */
const NAMESPACE_URIS = new Set([
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/1999/xlink",
]);

/** Every URL literal the page's own scripts name. See the header for what this misses. */
function urlLiteralsIn(scripts) {
  const out = new Set();
  for (const { body } of scripts) {
    for (const [, lit] of body.matchAll(/"((?:https?:)?\/\/?[^"\s]*)"/g)) out.add(lit);
    for (const [, lit] of body.matchAll(/'((?:https?:)?\/\/?[^'\s]*)'/g)) out.add(lit);
  }
  return [...out].filter((lit) => !NAMESPACE_URIS.has(lit));
}

describe("the board page states a policy, and works under it", () => {
  test("the board page is served with a Content-Security-Policy at all", async () => {
    const ctx = await signedIn();
    try {
      const r = await fetch(`${ctx.base}/`, { headers: { cookie: ctx.cookie } });
      assert.equal(r.status, 200);
      const csp = r.headers.get("content-security-policy");
      assert.ok(csp, "the post-auth board carried no policy at all — an injected script "
        + "in a rendered ticket body would run entirely unconstrained");
      const p = parseCsp(csp);
      assert.deepEqual(p.get("default-src"), ["'none'"],
        "the board's policy must start from nothing, as the pre-auth one does");
      assert.deepEqual(p.get("frame-ancestors"), ["'none'"]);
      assert.deepEqual(p.get("base-uri"), ["'none'"]);
    } finally { ctx.close(); }
  });

  test("EVERY script the board must run carries the nonce the header names", async () => {
    // THE BREAKAGE MODE, PINNED. A nonce-only `script-src` drops an un-nonced inline
    // script in silence: no error the operator sees, just a board that stops updating,
    // stops switching views, and stops posting. One missed `<script>` here is a broken
    // board, so the assertion is over ALL of them and asserts how many were found.
    const ctx = await signedIn();
    try {
      const r = await fetch(`${ctx.base}/`, { headers: { cookie: ctx.cookie } });
      const html = await r.text();
      const csp = r.headers.get("content-security-policy");
      const nonce = nonceOf(csp);
      assert.ok(nonce, `script-src names no nonce, so no inline script can run: ${csp}`);

      const scripts = executableScripts(html);
      assert.ok(scripts.length >= 8,
        `only ${scripts.length} executable scripts were found on the board page — this `
        + "test's premise is that it carries many, so it observed almost nothing");
      const unnonced = scripts.filter(({ attrs }) => !attrs.includes(`nonce="${nonce}"`));
      assert.deepEqual(unnonced.map(({ body }) => body.trim().split("\n")[0]), [],
        "these scripts would be silently dropped by the board's own policy");
    } finally { ctx.close(); }
  });

  test("the nonce is fresh per response — a reused one is not a nonce", async () => {
    const ctx = await signedIn();
    try {
      const seen = new Set();
      for (let i = 0; i < 3; i++) {
        const r = await fetch(`${ctx.base}/`, { headers: { cookie: ctx.cookie } });
        seen.add(nonceOf(r.headers.get("content-security-policy")));
      }
      assert.equal(seen.size, 3, "the board page is served to anyone holding a session; a "
        + "nonce constant across responses is a value an injected script can simply read");
    } finally { ctx.close(); }
  });

  test("nothing the policy silently drops is used — no style=, no on*=, no javascript:, no form",
    async () => {
      // EVERY SURFACE THAT REACHES THE DOCUMENT, not just the shell: the view fragments
      // are swapped into `#viewhost` with `innerHTML`, and the panel fragment likewise, so
      // an inline `style=` in any of them is dropped by the same nonce-only `style-src`
      // that governs the page itself.
      const ctx = await signedIn();
      try {
        const surfaces = [];
        const page = await fetch(`${ctx.base}/`, { headers: { cookie: ctx.cookie } });
        surfaces.push(["the board page", await page.text()]);
        for (const v of ["board", "list", "live", "metrics", "map", "gantt"]) {
          const r = await fetch(`${ctx.base}/view/${v}`, { headers: { cookie: ctx.cookie } });
          assert.equal(r.status, 200, `/view/${v} must render for this test to see it`);
          const j = await r.json();
          surfaces.push([`the ${v} fragment`, [j.html, j.chipbar, j.crumbs].join("\n")]);
        }
        const panel = await fetch(`${ctx.base}/api/panel?id=OBA-1`, { headers: { cookie: ctx.cookie } });
        assert.equal(panel.status, 200);
        surfaces.push(["the panel fragment", await panel.text()]);

        assert.equal(surfaces.length, 8, "a surface went unexamined");
        for (const [name, html] of surfaces) {
          assert.deepEqual(html.match(/ style="[^"]*"/g) ?? [], [],
            `${name} uses an inline style attribute, which a nonce-only style-src drops — `
            + "the element renders unstyled and nothing says why");
          assert.deepEqual(html.match(/ on[a-z]+="[^"]*"/g) ?? [], [],
            `${name} uses an inline event handler, which script-src drops`);
          assert.deepEqual(html.match(/"javascript:[^"]*"/g) ?? [], [], `${name}: javascript: URL`);
          assert.deepEqual(html.match(/<form\b[^>]*>/g) ?? [], [],
            `${name} carries a form, but the board's policy sets form-action 'none'`);
        }
      } finally { ctx.close(); }
    });

  test("every URL the board's scripts name is ADMITTED by the served policy, and answers 200",
    async () => {
      const ctx = await signedIn();
      try {
        const r = await fetch(`${ctx.base}/`, { headers: { cookie: ctx.cookie } });
        const html = await r.text();
        const csp = r.headers.get("content-security-policy");

        const literals = urlLiteralsIn(executableScripts(html));
        assert.ok(literals.length >= 4,
          `only ${literals.length} URL literals were found in the board's scripts, so this `
          + "test observed almost nothing");
        for (const target of literals) {
          const called = new URL(target, ctx.base);
          assert.equal(cspAllowsFetch(csp, { pageOrigin: ctx.base, target }), true,
            `the board's script names ${called.origin}${called.pathname}, which the served `
            + `policy does not admit — the browser blocks the call. Policy: ${csp}`);
        }

        // ...and the same-origin endpoints it polls really are there. `connect-src 'self'`
        // is only sufficient if what the board calls is in fact its own origin.
        for (const path of ["/api/hash", "/api/sync", "/api/live", "/api/reconcile-preview",
                            "/view/board", "/api/panel?id=OBA-1"]) {
          const res = await fetch(`${ctx.base}${path}`, { headers: { cookie: ctx.cookie } });
          assert.equal(res.status, 200, `${path} must answer a signed-in browser`);
        }
      } finally { ctx.close(); }
    });

  test("the policy admits no origin the board does not call", async () => {
    const ctx = await signedIn();
    try {
      const r = await fetch(`${ctx.base}/`, { headers: { cookie: ctx.cookie } });
      const csp = r.headers.get("content-security-policy");
      // Dummy host in the reserved `.invalid` TLD (RFC 2606). Never resolved or contacted.
      for (const kind of ["connect-src", "script-src", "style-src", "img-src"]) {
        assert.equal(
          cspAllowsFetch(csp, { pageOrigin: ctx.base, kind, target: "https://not-this-board.invalid/x" }),
          false, `${kind} admits an origin the board never calls: ${csp}`);
      }
    } finally { ctx.close(); }
  });

  test("`blaze start` serves the board under the same policy, scripts and all", async () => {
    // BLZ-359's lesson yet again: two servers render this page, and a header added to one
    // is absent from the other. The supervisor also injects its OWN control strip and
    // activity script into the page, which need the same nonce as the shell's.
    const ctx = await signedIn({ supervisor: true });
    try {
      const r = await fetch(`${ctx.base}/`, { headers: { cookie: ctx.cookie } });
      assert.equal(r.status, 200);
      const html = await r.text();
      const csp = r.headers.get("content-security-policy");
      assert.ok(csp, "`blaze start` is the DEFAULT command and served no policy");
      const nonce = nonceOf(csp);
      assert.ok(nonce, csp);
      assert.match(html, /id="blaze-app"/, "the control strip must be on this page, or "
        + "this test is not looking at the supervisor's render");
      const scripts = executableScripts(html);
      assert.ok(scripts.length >= 9, `only ${scripts.length} scripts found`);
      assert.deepEqual(
        scripts.filter(({ attrs }) => !attrs.includes(`nonce="${nonce}"`))
          .map(({ body }) => body.trim().split("\n")[0]), [],
        "the supervisor's own injected script would be dropped by the board's policy");
      assert.deepEqual(html.match(/ style="[^"]*"/g) ?? [], []);
      const styles = [...html.matchAll(/<style([^>]*)>/g)].map(([, a]) => a);
      assert.ok(styles.length >= 2, `only ${styles.length} style blocks found`);
      assert.deepEqual(styles.filter((a) => !a.includes(`nonce="${nonce}"`)), [],
        "an un-nonced stylesheet leaves the board completely unstyled");
    } finally { ctx.close(); }
  });

  test("the metrics legend styles its swatches by CLASS, not by an inline style attribute",
    async () => {
      // The one inline `style=` the served fixtures never reach: the CFD legend renders it
      // only when there IS series data, so a board-level sweep can pass while the metrics
      // view is quietly unstyled for anyone whose board has history.
      const series = [{ date: "2026-01-01", counts: { defined: 1, "in-progress": 2, done: 3 } }];
      const html = renderMetrics({ tiles: {}, series });
      assert.match(html, /cfd-swatch/, "this test's premise is that the legend renders swatches");
      assert.deepEqual(html.match(/ style="[^"]*"/g) ?? [], [],
        "a nonce-only style-src drops this, and every swatch loses its colour");
    });
});
