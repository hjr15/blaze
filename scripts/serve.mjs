#!/usr/bin/env node
// serve.mjs — a tiny, zero-dependency dashboard for the file-based tracker.
//
//   node scripts/serve.mjs            # serves http://localhost:<cfg.port>
//   PORT=8080 node scripts/serve.mjs  # custom port
//
// Stats every ticket file on each request and re-parses only those whose
// mtime+size changed — an on-disk edit is always reflected, but unchanged
// files skip the parse. The page also auto-reloads within a few seconds when
// any ticket file changes (it polls a cheap content hash), but never reloads
// while the files are untouched — so it won't fight you mid-read.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { loadConfig, listProjects, resolveRoots } from "./config.mjs";
import { resolveWritePort } from "./model/write-port-resolve.mjs";
import { applyMove } from "./move.mjs";
import { applyResolve } from "./resolve.mjs";
import { applyLog } from "./log.mjs";
import { applyEdit, applyToggleAc } from "./edit.mjs";
import { commitOrQueue } from "./commit-or-queue.mjs";
import { isReadonly } from "./readonly.mjs";
import { boardModel, contentHash, liveModel } from "./views/data.mjs";
import { panelHtml } from "./views/panel-content.mjs";
import { pageHtml, viewEnvelope, CSRF } from "./views/page.mjs";
import { checkBindSafety, gate, pageScopeFor } from "./model/serve-auth.mjs";
import { loadIdentity } from "./model/identity-db.mjs";
import { addUser, ensureIdentityIgnored } from "./model/user-admin.mjs";
import { issueSetupToken, readSetupToken, clearSetupToken, setupTokenMatches, setupTokenPath,
         ensureSetupTokenIgnored } from "./model/setup-token.mjs";
import { actorFor } from "./model/identity.mjs";
export { boardModel, contentHash, liveModel, pageHtml, CSRF }; // back-compat for tests + supervisor.mjs

// BLZ-133: config is read lazily, and from the board being SERVED rather than
// the ambient engine tree. Import-time resolution broke merely importing this
// module (several tests import it only for the boardModel/pageHtml re-exports)
// now that resolveRoots() throws outside a board — and reading commitMode from
// the engine root was already wrong for a server started against an explicit
// --root. Memoised per data root.
const _cfgCache = new Map();
const cfgFor = (root) => {
  if (!_cfgCache.has(root)) _cfgCache.set(root, loadConfig({ root }));
  return _cfgCache.get(root);
};

function readJson(req) {
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

function aheadCount(root) {
  const r = spawnSync("git", ["-C", root, "rev-list", "--count", "@{u}..HEAD"], { encoding: "utf8" });
  return r.status === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

// Compresses when the client advertises gzip support and the body is large
// enough that compression is worth the CPU (below 1KB, gzip overhead can
// exceed the savings).
function send(req, res, code, type, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buf.length >= 1024 && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) {
    res.writeHead(code, { "content-type": type, "content-encoding": "gzip" });
    res.end(gzipSync(buf)); return;
  }
  res.writeHead(code, { "content-type": type });
  res.end(buf);
}

// ---- first-run setup page (BLZ-358) -----------------------------------------
// Deliberately self-contained and ugly: it is shown once, before any identity
// exists, and it must not depend on the board renderer — which is precisely the
// thing that is not safe to serve yet.
//
// It renders the token's PATH and never its VALUE. A page that printed the token
// would defeat the file it is meant to be read from: the whole point of writing it
// to disk is that reaching it requires filesystem access, and anything rendered
// over HTTP is available to whoever reached the port.
function setupPageHtml(tokenPath) {
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!doctype html><meta charset="utf-8"><title>blaze — first-run setup</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem}
label{display:block;margin:1rem 0 .25rem;font-weight:600}input{width:100%;padding:.5rem;font:inherit}
code{background:#eee;padding:.15rem .35rem}button{margin-top:1.5rem;padding:.6rem 1.2rem;font:inherit}
#out{margin-top:1.5rem;white-space:pre-wrap}</style>
<h1>Set up blaze</h1>
<p>This board has no users yet, so nothing is being served until you create the first
administrator.</p>
<p>Read the one-time setup token from this file on the machine hosting the board — it is
not shown here, and it is not in any log:</p>
<p><code>${esc(tokenPath)}</code></p>
<form id="f">
  <label for="token">Setup token</label>
  <input id="token" name="token" autocomplete="off" required>
  <label for="email">Your email address</label>
  <input id="email" name="email" type="email" required>
  <label for="displayName">Display name (optional)</label>
  <input id="displayName" name="displayName" autocomplete="off">
  <button type="submit">Create administrator</button>
</form>
<div id="out"></div>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { token: token.value, email: email.value, displayName: displayName.value || null };
  const r = await fetch("/setup", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  out.textContent = r.ok
    ? "Administrator created.\n\nYour API token is shown ONCE and is not recoverable:\n\n"
      + j.token + "\n\nStore it now, then reload this page."
    : "Setup failed: " + ((j.errors || ["unknown error"]).join(", "));
});
</script>`;
}

// ---- server factory ---------------------------------------------------------

// PORT=0 is a REQUEST, not an absence: it means "bind any free port", which is how tests get
// an isolated server. `Number(env.PORT) || fallback` treated it as unset — 0 is falsy — so the
// server quietly took the configured 4321 instead, and the standalone-entry test failed with
// EADDRINUSE whenever a real board happened to be running locally. Only an unset, blank, or
// non-numeric value falls through to the config.
function envPort() {
  const raw = process.env.PORT;
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : null;
}

export function startServer({ projectsDir = resolveRoots().projectsDir, root = resolveRoots().dataRoot, port = envPort() ?? cfgFor(root).port, host = process.env.HOST || "127.0.0.1", views, identity = loadIdentity(root) } = {}) {
  // BLZ-348, ADR-0013. checkBindSafety() has existed and been tested since BLZ-304 and
  // was called by nothing, so the one control written for exactly this configuration was
  // dead code: an operator publishing the port to a LAN interface got an unauthenticated
  // board with every mutating route open, and Blaze raised nothing.
  //
  // Checked BEFORE .listen(), and thrown rather than logged: a warning printed next to a
  // socket that is already accepting connections is not a refusal.
  // BEFORE the bind check, so a damaged roster is diagnosed as a damaged roster. Reading
  // it as "no identities" both removed authentication from a loopback board and, on
  // 0.0.0.0, killed the container with the false message "no users configured".
  if (identity?.state === "broken") throw new Error(identity.error);
  const bind = checkBindSafety({ host, hasIdentity: Boolean(identity?.hasIdentity) });
  // BLZ-358: the refusal is REPLACED here, not removed. `checkBindSafety` is unchanged
  // and still returns exactly the refusal it always did — what changes is that
  // serve.mjs now has somewhere better to go with it. The supervisor still throws on
  // the same verdict (it is loopback-by-construction, so the setup flow must not be
  // reachable through that second server), which is why the decision lives at this
  // call site rather than inside the check.
  //
  // Refusing was right GIVEN NO ALTERNATIVE. A container has no TTY, so
  // `scripts/init.mjs`'s wizard cannot reach it, and HTTP is the only channel the
  // deployment has. What it must NOT become is a way to serve the board unauthenticated
  // on a public interface — the exact hole the refusal closed — so setup mode serves
  // the setup flow and nothing else at all.
  let setupPending = false;
  // One attempt at a time. `setupPending` is only cleared AFTER `addUser` awaits, so with
  // an identity store that yields to the event loop two concurrent correct-token requests
  // could both pass the check and both create an admin. Today's SQLite store happens not
  // to yield, which closes the window by accident rather than by design — and 'accident'
  // is not a property a Postgres-backed store would preserve.
  let setupInFlight = false;
  if (!bind.ok) {
    let issued;
    try {
      issued = issueSetupToken(root);
    } catch (e) {
      // A read-only data mount (`-v <data>:/data:ro`, a supported and encouraged mode)
      // cannot hold a token, and neither can a board whose .blaze/ is not writable.
      // There is no setup flow to offer, so the original refusal stands — with the
      // reason appended, because "refusing to serve" without saying why the alternative
      // was unavailable sends the operator hunting the wrong problem.
      throw new Error(`${bind.error}\nA first-run setup flow could not be started either: `
        + `${String(e?.message ?? e)}\nOn a read-only data mount, create the first user `
        + `against a writable copy of the board with \`blaze user add\`.\n`);
    }
    setupPending = true;
    // The token file lives beside identity.db, so the rule that hides one hides the
    // other. Reused rather than re-derived — BLZ-348 wrote this for exactly this case.
    // BOTH, and not one on the assumption that it covers the other: a .gitignore naming
    // exactly `.blaze/identity.db` satisfies the first check while leaving the token
    // file committable.
    try { ensureIdentityIgnored(root); } catch { /* not a repo, or not ours to edit */ }
    try { ensureSetupTokenIgnored(root); } catch { /* same */ }
    // THE PATH, NEVER THE VALUE. A token that reaches a log stream is a token that has
    // to be rotated, and `docker logs` is shipped off-box by any log aggregator.
    console.log(`blaze: no users configured — serving first-run setup at /setup`);
    console.log(`blaze: read the one-time setup token from ${issued.path} (mode 0600)`);
  }
  // null when no identity is configured — which gate() reads as the loopback case that
  // the check above has just vouched for, and serves without auth exactly as always.
  // `let`, because completing setup adopts the identity it just created WITHOUT a
  // restart: leaving this null after setup would serve the new board with no credential
  // required, which is the refusal's own hole re-opened by the fix for it.
  let store = identity?.hasIdentity ? identity.store : null;

  return createServer(async (req, res) => {
    const json = (code, obj) => send(req, res, code, "application/json", JSON.stringify(obj));
    // `new URL` THROWS on a request line it cannot parse — `GET // HTTP/1.1` is enough —
    // and this handler has no wrapping try, so that ended the process for every
    // connected session. The line predates BLZ-358; serving setup is what made it
    // reachable pre-auth on a public interface, which makes it this ticket's problem.
    let u;
    try { u = new URL(req.url, "http://localhost"); }
    catch { return send(req, res, 400, "text/plain; charset=utf-8", "bad request\n"); }

    // Every /api/* request, classified and decided in ONE place. An unclassified route
    // is a 404 here rather than falling through to whichever handler happens to match
    // later — a route added without a scope must not inherit the last one's.
    // BLZ-358: first-run setup, decided BEFORE the gate. `gate()` is fail-closed and
    // 404s any route it does not classify, and a caller completing setup has no
    // credential to present yet — by definition, since creating one is what it is for.
    // So this branch carries its own authentication (the token file) and never reaches
    // the gate. It exists ONLY while `setupPending`, so once an identity exists there is
    // no route here to reach: not hidden, absent.
    if (setupPending) {
      // WRAPPED, because this branch runs BEFORE any credential is checked and the rest
      // of this file states the rule three times: an uncaught throw in an async handler
      // ends the process for every connected session rather than refusing one request.
      // It was the one place here without a try, and one unauthenticated request with a
      // poisoned `toString` was enough to take the board down.
      try {
      if (req.method === "GET" && u.pathname === "/setup") {
        return send(req, res, 200, "text/html; charset=utf-8", setupPageHtml(setupTokenPath(root)));
      }
      if (req.method === "POST" && u.pathname === "/setup") {
        let body;
        try { body = await readJson(req); } catch { return json(400, { errors: ["malformed request"] }); }
        // The token first, so a caller who cannot authenticate learns nothing about
        // whether their email would have been acceptable.
        if (!setupTokenMatches(body?.token, readSetupToken(root))) {
          // Neither the presented value nor the real one is echoed. One would confirm a
          // guess; the other would hand over the credential outright.
          return json(401, { errors: ["invalid setup token"] });
        }
        const email = typeof body?.email === "string" ? body.email.trim() : "";
        if (!email) return json(400, { errors: ["a user needs an email address"] });
        if (setupInFlight) return json(409, { errors: ["setup is already in progress"] });
        setupInFlight = true;
        let created;
        try {
          // ADR-0013 section 5: the first admin is a user, not an exception. This is the
          // same `addUser` that `blaze user add` calls — there is no bootstrap branch.
          created = await addUser(root, { email, role: "admin",
                                          displayName: body?.displayName ?? null });
        } catch (e) {
          // A failed creation must leave setup COMPLETABLE — the token is not consumed
          // by a mistake the operator can correct and retry.
          setupInFlight = false;
          return json(400, { errors: [String(e?.message ?? e)] });
        }
        // Close the door in this order: the credential first, then the route.
        clearSetupToken(root);
        setupPending = false;
        // Adopt the identity just created, so the board this process goes on to serve is
        // authenticated rather than open. Without this the running server keeps
        // `store = null` and serves everything to anyone until it is restarted.
        const adopted = loadIdentity(root);
        if (adopted?.state === "healthy") store = adopted.store;
        // The API token is returned ONCE. ADR-0013 stores only its SHA-256, so this is
        // the only moment it exists; it is not logged, for the same reason.
        return json(200, { ok: true, user: created.user, token: created.token.token });
      }
      // Everything else waits. 503 rather than 404: the board is really there, it is
      // simply not safe to serve it yet, and a 404 would suggest the operator had the
      // wrong address. The body is a fixed string and carries nothing from the request
      // or from the token.
      return send(req, res, 503, "text/plain; charset=utf-8",
        "blaze: first-run setup required — no users are configured. Open /setup\n");
      } catch {
        // Deliberately says nothing about what failed: this is the pre-auth surface.
        return json(500, { errors: ["setup could not be completed"] });
      }
    }

    let principal = null;
    // Board CONTENT is gated too, at `read`. `/` is rendered SERVER-SIDE and carries
    // every ticket, so leaving it open made `viewer` a role that protected nothing: a
    // caller with no credential could read the whole board — and the CSRF token with it
    // — while /api/live correctly 401'd beside it.
    const apiRoute = u.pathname.startsWith("/api/");
    const pageScope = apiRoute ? null : pageScopeFor(req.method, u.pathname);
    if (apiRoute || pageScope) {
      let decision;
      try {
        decision = await gate({ method: req.method, pathname: u.pathname,
                                headers: req.headers, store, operation: pageScope ?? undefined });
      } catch {
        // THE GATE COULD NOT DECIDE, so the answer is no. Never rethrow: this handler has
        // no wrapping try/catch, and an uncaught throw here ends the process for every
        // connected session rather than refusing one request — which is exactly what a
        // read-only or locked identity.db used to do. 503, because the caller may well be
        // entitled and should retry, and it is the operator's database that is unwell.
        return json(503, { errors: ["authentication is temporarily unavailable"] });
      }
      if (!decision.ok) {
        // A page route answers in prose. It is reached by a browser, and a JSON envelope
        // there tells a human nothing about what to do next.
        if (pageScope) {
          res.writeHead(decision.status, { "content-type": "text/plain; charset=utf-8" });
          res.end(`${decision.error}\n\nThis board has users configured, so its content `
            + "requires a token:\n\n    Authorization: Bearer blz_...\n\n"
            + "Issue one with `blaze user add`. A browser cannot set that header itself — "
            + "put a\nreverse proxy in front that adds it, or use the API directly, until "
            + "the sign-in\nflow lands.\n");
          return;
        }
        return json(decision.status, { errors: [decision.error] });
      }
      principal = decision.principal;
    }
    // ADR-0013 §6: the name the event log records for this caller. "unknown" when there
    // is no principal, which is the historic default the column already carried.
    const actor = actorFor(principal);

    if (req.method === "GET" && u.pathname === "/api/hash") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(contentHash({ projectsDir, project: u.searchParams.get("project") || null })); return;
    }
    if (req.method === "GET" && u.pathname === "/api/sync") return json(200, { ahead: aheadCount(root) });
    if (req.method === "GET" && u.pathname === "/api/live") {
      return json(200, liveModel(root, projectsDir));
    }
    if (req.method === "GET" && u.pathname === "/api/panel") {
      // Guard the render: panelHtml re-reads the ticket file after the index
      // walk, so a concurrent move/edit could ENOENT between the two — catch it
      // as a 500 rather than letting the async handler crash the process.
      try {
        const html = panelHtml(projectsDir, u.searchParams.get("id"));
        if (html === null) return json(404, { errors: ["not found"] });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); return;
      } catch {
        return json(500, { errors: ["panel render failed"] });
      }
    }
    if (req.method === "GET" && u.pathname === "/api/reconcile-preview") {
      const { reconcile } = await import("./reconcile.mjs");
      const r = await reconcile({ fetch: false, commit: false, push: false, dryRun: true, root, projectsDir });
      // BLZ-350: a thin preview and an unreadable forge look identical otherwise.
      return json(200, { changes: r.changes || [], forgeErrors: r.forgeErrors || [] });
    }
    const vm = req.method === "GET" && u.pathname.match(/^\/view\/([a-z]+)$/);
    if (vm) {
      const envelope = viewEnvelope({
        view: vm[1],
        project: u.searchParams.get("project") || "all",
        focus: u.searchParams.get("focus") || null,
        flat: u.searchParams.get("flat") === "1",
        sprint: u.searchParams.get("sprint") || null,
        projectsDir,
        views,
      });
      if (!envelope) return json(404, { errors: ["unknown view"] });
      return send(req, res, 200, "application/json", JSON.stringify(envelope));
    }
    if (req.method === "GET" && u.pathname === "/") {
      const project = u.searchParams.get("project") || "all";
      const focus = u.searchParams.get("focus") || null;
      const flat = u.searchParams.get("flat") === "1";
      const sprint = u.searchParams.get("sprint") || null;
      const view = u.searchParams.get("view") || "board";
      // projectsDir is explicit: without it pageHtml would fall back to the
      // AMBIENT board rather than the one this server was started against
      // (/view/<name> above already passes it) — a latent mismatch that
      // BLZ-133's stricter resolveRoots turns from wrong-data into a throw.
      return send(req, res, 200, "text/html; charset=utf-8", pageHtml({ project, focus, flat, sprint, view, views, projectsDir }));
    }
    if (req.method === "POST") {
      // NOT authentication, and never was — ADR-0013 §7 and the ADR's own reproduction:
      // this value is a per-process randomUUID() embedded in the served HTML, readable
      // by anyone who can GET /. It is forgery protection for the browser flow, and it
      // is retained as defence-in-depth ALONGSIDE the gate above, which is the thing
      // that asks for a credential. It is removed with the last cookie, not before.
      if (req.headers["x-blaze-csrf"] !== CSRF) return json(403, { errors: ["bad csrf token"] });
      // BLZ-121 defence-in-depth, checked here (before any apply* call below,
      // not just inside commitOrQueue) and as a plain 403 rather than a thrown
      // assertWritable(): this handler has no wrapping try/catch, and an
      // uncaught throw inside an async request handler would crash the whole
      // board server for every connected session, not just refuse one write.
      if (isReadonly()) return json(403, { errors: ["blaze: read-only mode (BLAZE_READONLY=1) — refusing to write"] });

      let payload;
      try { payload = await readJson(req); } catch { return json(400, { errors: ["bad json body"] }); }
      const today = new Date().toISOString().slice(0, 10);
      // in-place ops only — use the inline path for ops that rename (see /api/move)
      // A lock-contended request stalls only for these bounded retries (~0.4s)
      // rather than acquireLock's own default (~2s) — a board click should
      // fail fast into a 503 rather than hang the request.
      const LOCK_OPTS = { retries: 2 };
      // Writes the error response for a failed commit and reports whether it
      // did so (true = handled, caller must not also write a success response).
      const commitFailed = (c) => {
        if (c.ok) return false;
        if (c.locked) json(503, { errors: ["written but not committed — commit lock held, retry shortly"] });
        else json(500, { errors: [`written but commit failed (status ${c.status})`] });
        return true;
      };
      const done = (r, msg, op, extra = {}) => {
        if (!r.ok) return json(422, { errors: r.errors });
        const c = commitOrQueue({ root, mode: cfgFor(root).commitMode, op, id: payload.id, message: msg, files: [r.file], lockOpts: LOCK_OPTS });
        if (commitFailed(c)) return;
        return json(200, { ok: true, ...extra });
      };

      // BLZ-301: the viewer's handlers wrote through the verbs' DEFAULT port, so a
      // board edited in the browser bypassed the dual-write soak entirely — the week's
      // evidence would have been silently partial. Resolved per request, and closed
      // after, so a long-lived server does not hold the shadow open.
      // Wrapped, and the file states the rule twice already: "an uncaught throw here ends the
      // process for every connected session rather than refusing one request". `resolveWritePort`
      // THROWS when the shadow's schema version is out of range — a named, correct refusal — and
      // it was outside the try, so one ordinary POST against a stale shadow killed the server for
      // everyone. 503 for the same reason the identity gate uses it: the caller is not at fault
      // and the condition is fixable (`blaze db init --force`).
      let writePort, closeWritePort;
      try {
        ({ port: writePort, close: closeWritePort } =
          await resolveWritePort({ dataRoot: root, projectsDir }));
      } catch (e) {
        return json(503, { errors: [String(e?.message ?? e)] });
      }
      try {
      if (u.pathname === "/api/move") {
        const r = await applyMove(projectsDir, payload.id, payload.to, { today, writePort, actor, source: "api" });
        if (!r.ok) return json(422, { errors: r.errors });
        const extraFiles = (r.fromFile && r.fromFile !== r.file) ? [r.fromFile] : [];
        const c = commitOrQueue({ root, mode: cfgFor(root).commitMode, op: "move", id: payload.id, message: `${payload.id}: ${r.from ?? "?"} → ${payload.to}`, files: [r.file, ...extraFiles], lockOpts: LOCK_OPTS });
        if (commitFailed(c)) return;
        return json(200, { ok: true, resolution: r.resolution });
      }
      if (u.pathname === "/api/edit") {
        const r = await applyEdit(projectsDir, payload.id, payload.patch || {}, { today, writePort, actor, source: "api" });
        return done(r, `${payload.id}: edit ${Object.keys(payload.patch || {}).join(",")}`, "edit");
      }
      if (u.pathname === "/api/resolve") {
        const r = await applyResolve(projectsDir, payload.id, payload.resolution, { today, writePort, actor, source: "api" });
        return done(r, `${payload.id}: resolve ${payload.resolution}`, "resolve");
      }
      if (u.pathname === "/api/log") {
        const r = await applyLog(projectsDir, payload.id, payload.minutes, { note: payload.note ?? null, today, writePort, actor, source: "api" });
        return done(r, `${payload.id}: log ${payload.minutes}m`, "log");
      }
      if (u.pathname === "/api/ac") {
        const r = await applyToggleAc(projectsDir, payload.id, { index: payload.index, checked: payload.checked }, { today, writePort, actor, source: "api" });
        return done(r, `${payload.id}: ac[${payload.index}]=${payload.checked ? "x" : " "}`, "ac");
      }
      return json(404, { errors: ["not found"] });
      } finally { closeWritePort(); }
    }
    res.writeHead(404, { "content-type": "text/plain" }); res.end("not found");
  }).listen(port, host);
}

// ---- standalone entry -------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Resolve the data root HERE and pass it in. `root` is a destructured
  // parameter of startServer(), not a module-level binding, so referencing it
  // in this block threw `ReferenceError: root is not defined` from the
  // "listening" handler — after the port was already bound, so the process
  // crash-looped instead of failing to start (BLZ-133 regression).
  const root = resolveRoots().dataRoot;
  // BLZ-348: the bind refusal has to be LOUD and FATAL here, not a stack trace. This is
  // the container path — the Dockerfile sets HOST=0.0.0.0 because loopback inside a
  // container netns is unreachable through a published -p port, which is correct and
  // is exactly the configuration checkBindSafety was written for. A container with no
  // identities now exits 1 with the two fixes named, instead of serving an open board.
  let server;
  try {
    server = startServer({ root });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  server.on("listening", () => console.log(`${cfgFor(root).boardTitle} board → http://localhost:${server.address().port}`));
}
