#!/usr/bin/env node
// supervisor.mjs — boots the Blaze app: serves the board + activity feed and runs
// the loops. All loop effects go through git on the board repo.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, listProjects, resolveRoots } from "./config.mjs";
import { pageHtml, contentHash } from "./serve.mjs";
import { viewEnvelope, CSRF } from "./views/page.mjs";
import { createBus } from "./event-bus.mjs";
import { reconcile } from "./reconcile.mjs";
import { groomOnce } from "./loops/groomer.mjs";
import { checkBindSafety, gate, pageScopeFor } from "./model/serve-auth.mjs";
import { loadIdentity } from "./model/identity-db.mjs";
import { execFileSync } from "node:child_process";

const today = () => new Date().toISOString().slice(0, 10);

/**
 * BLZ-359. The routes THIS server owns, and what each costs.
 *
 * `serve-auth.mjs`'s `ROUTE_SCOPES` owns `/api/*` and `pageScopeFor()` owns `/` and
 * `/view/<name>` — both shared with `serve.mjs`, so the two servers cannot drift on the
 * routes they have in common. This table is only for the routes the supervisor adds:
 * the control strip and the activity stream.
 *
 * Everything under `/control/*` is `write`, including `stop`. None of them is a read:
 * `run` dispatches the configured agent or a committing-and-pushing reconcile pass,
 * `revert` shells out to `git revert`, and `start`/`stop` decide whether either happens
 * at all. `/events` is `read` because the feed names ticket ids and commit shas.
 *
 * Fail-closed, exactly as `ROUTE_SCOPES` is: a `/control/*` path absent from this table
 * resolves to no scope, and `gate()` answers 404 rather than letting it inherit the
 * scope of whichever route matched last.
 */
export const SUPERVISOR_SCOPES = {
  "GET /events": "read",
  "POST /control/reconcile/start": "write",
  "POST /control/reconcile/stop": "write",
  "POST /control/reconcile/run": "write",
  "POST /control/groomer/start": "write",
  "POST /control/groomer/stop": "write",
  "POST /control/groomer/run": "write",
  "POST /control/revert": "write",
};

/** A commit sha and nothing else — hex only, so no argv of git's can be spelled with it. */
export const SHA_RE = /^[0-9a-fA-F]{4,40}$/;

/** The scope one of this server's own routes needs, or null if it owns no such route. */
export function supervisorScopeFor(method, pathname) {
  return SUPERVISOR_SCOPES[`${String(method).toUpperCase()} ${pathname}`] ?? null;
}

// ---- the control strip + activity feed injected into the board page ----
const CONTROLS_HTML = `
  <section id="blaze-app">
    <div class="ctl-strip">
      <strong>Loops</strong>
      <span class="ctl-group" data-loop="reconcile">reconcile
        <button data-act="start">▶</button><button data-act="stop">⏸</button><button data-act="run">run</button>
      </span>
      <span class="ctl-group" data-loop="groomer">groomer
        <button data-act="start">▶</button><button data-act="stop">⏸</button><button data-act="run">run</button>
      </span>
      <span id="conn" class="sub">● live</span>
    </div>
    <ol id="activity" class="activity"></ol>
  </section>
  <style>
    #blaze-app { padding: 0 20px 8px; }
    .ctl-strip { display:flex; align-items:center; gap:12px; flex-wrap:wrap;
      padding:8px 10px; background:#161b22; border:1px solid #21262d; border-radius:8px; }
    .ctl-group { color:#adbac7; font-size:12px; }
    .ctl-strip button { appearance:none; border:0; cursor:pointer; font:inherit; font-size:11px;
      margin-left:3px; padding:2px 8px; border-radius:6px; color:var(--charcoal); background:var(--blaze-orange); }
    .ctl-strip button:hover { background:var(--blaze-red); color:var(--neutral); }
    #conn { margin-left:auto; color:var(--blaze-orange); }
    .activity { list-style:none; margin:8px 0 0; padding:0; max-height:180px; overflow:auto;
      font-size:12px; font-family:ui-monospace, monospace; }
    .activity li { padding:4px 8px; border-bottom:1px solid #21262d; color:#adbac7; display:flex; gap:8px; }
    .activity .revert { margin-left:auto; cursor:pointer; color:var(--blaze-orange); background:none; border:0; font:inherit; }
  </style>`;

const ACTIVITY_SCRIPT = `
  <script>
    const act = document.getElementById("activity");
    const conn = document.getElementById("conn");
    function line(e) {
      const li = document.createElement("li");
      let txt = e.type;
      if (e.type === "reconcile") txt = e.id + ": " + e.from + " → " + e.to;
      else if (e.type === "groom") txt = e.error ? ("groom " + e.id + " failed: " + e.error)
        : e.noop ? ("groom " + e.id + ": no change") : ("groom " + e.id + " (" + (e.files||[]).length + " file)");
      else if (e.type === "status") txt = e.loop + " " + e.state;
      else if (e.type === "error") txt = (e.loop||"") + " error: " + e.message;
      li.innerHTML = "<span>" + (e.ts||"") + "</span><span>" + txt + "</span>";
      if (e.type === "groom" && e.sha) {
        const b = document.createElement("button");
        b.className = "revert"; b.textContent = "↩ revert";
        b.onclick = () => fetch("/control/revert", { method:"POST", headers:{"content-type":"application/json","x-blaze-csrf":window.__csrf}, body: JSON.stringify({ sha: e.sha }) });
        li.appendChild(b);
      }
      act.prepend(li);
      while (act.children.length > 100) act.removeChild(act.lastChild);
    }
    const es = new EventSource("/events");
    es.onmessage = (m) => { try { line(JSON.parse(m.data)); } catch {} };
    es.onerror = () => { conn.textContent = "● offline"; };
    es.onopen = () => { conn.textContent = "● live"; };
    document.querySelectorAll(".ctl-group").forEach((g) =>
      g.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () =>
          fetch("/control/" + g.dataset.loop + "/" + b.dataset.act,
            { method: "POST", headers: { "x-blaze-csrf": window.__csrf } }))));
  </script>`;

/** BLZ-350: reconcile's forge outcomes → activity-feed events, deduped.
 *  Pure and exported so the "say it once" rule is testable without a live loop:
 *  the reconcile loop runs on a timer and an unsupported forge is a PERMANENT
 *  condition, so republishing every tick would bury the feed it warns through.
 *  `said` is the caller's memory of what has already been announced. */
export function newForgeErrorEvents(forgeErrors, said) {
  const out = [];
  for (const f of forgeErrors || []) {
    if (!f || !f.message || said.has(f.message)) continue;
    said.add(f.message);
    out.push({ type: "error", loop: "reconcile", message: `forge unreadable — ${f.message}` });
  }
  return out;
}

export function createApp(cfg, { root = resolveRoots().dataRoot, identity = loadIdentity(root) } = {}) {
  // BLZ-359. A DAMAGED ROSTER IS A REFUSAL, NOT "NOBODY IS CONFIGURED". Reading only
  // `hasIdentity` here would reintroduce, in this server, the exact bug BLZ-348 shipped
  // and then fixed in serve.mjs: truncating a protected board's identity.db read as "no
  // identities configured" and silently removed authentication. `loadIdentity` reports
  // absent / broken / empty / healthy precisely so this decision is not a boolean.
  //
  // Thrown from the FACTORY rather than from the bind, because the factory is what
  // decides `store` — a caller that builds the app itself (as the tests do) must not be
  // able to obtain an unauthenticated handler for a board that has users.
  if (identity?.state === "broken") throw new Error(identity.error);
  // null for absent and empty, which `gate()` reads as the loopback case: served
  // without authentication, exactly as Blaze always has.
  const store = identity?.hasIdentity ? identity.store : null;
  const bus = createBus();
  // BLZ-133: the app serves THIS root's board. pageHtml/contentHash used to fall
  // back to the ambient engine tree when passed no projectsDir — wrong board for
  // an app started against an explicit root, and now a throw rather than silently
  // wrong data.
  const projectsDir = join(root, "projects");

  const loops = { reconcile: { timer: null, busy: false }, groomer: { timer: null, busy: false } };
  // BLZ-350: forge problems already announced, so a timer loop reports each once.
  const forgeSaid = new Set();

  // Mirrors serve.mjs's aheadCount() so the client's sync badge works the same
  // under supervisor mode.
  function aheadCount() {
    try {
      const out = execFileSync("git", ["-C", root, "rev-list", "--count", "@{u}..HEAD"], { encoding: "utf8" });
      return Number(out.trim()) || 0;
    } catch {
      return 0;
    }
  }

  // async: reconcile awaits the write port (BLZ-293/294). The busy flag still guards
  // correctly — it is set before the await and cleared in the finally, which now runs
  // after the awaited work rather than before it.
  async function runReconcile() {
    if (!listProjects(cfg).length || loops.reconcile.busy) return;
    loops.reconcile.busy = true;
    try {
      // BLZ-133: reconcile THIS app's board. Omitting root made it resolve the
      // ambient tree — the wrong board whenever the app was started against an
      // explicit root, and now a throw rather than silently reconciling nothing.
      const r = await reconcile({ fetch: true, commit: true, push: true, root, projectsDir });
      // BLZ-350: an unreadable forge is the loop's version of the silence the CLI
      // now breaks. Without this the app runs reconcile every tick, never reaches
      // "in-review", and the activity feed shows a healthy board.
      for (const e of newForgeErrorEvents(r && r.forgeErrors, forgeSaid)) bus.publish({ ...e, ts: today() });
      if (r && r.ok && r.changes) {
        for (const c of r.changes) bus.publish({ type: "reconcile", id: c.id, from: c.from, to: c.to, moved: c.moved, ts: today() });
      } else if (r && !r.ok) {
        bus.publish({ type: "error", loop: "reconcile", message: r.error, ts: today() });
      }
    } catch (e) {
      bus.publish({ type: "error", loop: "reconcile", message: e.message, ts: today() });
    } finally {
      loops.reconcile.busy = false;
    }
  }

  function runGroomer() {
    if (loops.groomer.busy) return;
    loops.groomer.busy = true;
    try {
      let agentsMd = "";
      try { agentsMd = readFileSync(join(root, "AGENTS.md"), "utf8"); } catch {}
      const evt = groomOnce({ root, cfg, agentsMd, today: today() });
      if (evt) bus.publish(evt);
    } catch (e) {
      bus.publish({ type: "error", loop: "groomer", message: e.message, ts: today() });
    } finally {
      loops.groomer.busy = false;
    }
  }

  function startLoop(name) {
    const fn = name === "reconcile" ? runReconcile : runGroomer;
    if (loops[name].timer) return;
    fn();
    loops[name].timer = setInterval(fn, cfg.loops[name].intervalSec * 1000);
    bus.publish({ type: "status", loop: name, state: "started", ts: today() });
  }

  function stopLoop(name) {
    if (loops[name].timer) { clearInterval(loops[name].timer); loops[name].timer = null; }
    bus.publish({ type: "status", loop: name, state: "stopped", ts: today() });
  }

  const server = createServer(async (req, res) => {
    const u = new URL(req.url || "/", "http://localhost");
    const json = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    // ---- the gate (BLZ-359) -------------------------------------------------------
    // `blaze start` boots THIS server, and it is the default command. Until now it
    // imported neither `gate` nor `checkBindSafety`, so every route below was open on a
    // board whose operator had run `blaze user add` and had every reason to believe it
    // was not — /control/revert included, which shells out to `git revert`.
    //
    // One decision, in one place, before any handler runs. /api/* passes NO forced
    // scope so that `ROUTE_SCOPES` resolves it: an /api/ route added without a
    // classification 404s here exactly as it does in serve.mjs, rather than inheriting
    // whichever route matched last.
    const isApi = u.pathname.startsWith("/api/");
    const isControl = u.pathname.startsWith("/control/");
    const ownScope = isApi ? null : supervisorScopeFor(req.method, u.pathname);
    const pageScope = isApi || ownScope ? null : pageScopeFor(req.method, u.pathname);
    const scope = ownScope ?? pageScope;
    if (isApi || isControl || scope) {
      let decision;
      try {
        decision = await gate({ method: req.method, pathname: u.pathname,
                                headers: req.headers, store, operation: scope ?? undefined });
      } catch {
        // THE GATE COULD NOT DECIDE, so the answer is no. Never rethrown: nothing wraps
        // this async handler, and a throw would end the process for every connected
        // session rather than refuse one request. 503 because the caller may well be
        // entitled and it is the operator's database that is unwell.
        return json(503, { errors: ["authentication is temporarily unavailable"] });
      }
      if (!decision.ok) {
        // A page route is reached by a browser, so it answers in prose; a JSON envelope
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
      // NOT AUTHENTICATION, and not described as such anywhere — ADR-0013 §7. The CSRF
      // value is a per-process randomUUID() embedded in the served HTML, readable by
      // anyone who can already read the board. It is forgery protection for the browser
      // flow, kept ALONGSIDE the gate above, which is the part that asks for a credential.
      //
      // It is checked here, and not only in serve.mjs, because on this server it is the
      // only control that covers the DEFAULT configuration: a loopback board with no
      // identities has no credential to demand, and a page in the operator's own browser
      // can POST cross-origin to http://localhost:<port>/control/revert as a "simple
      // request" — no preflight, response unreadable, side effect done. The gate cannot
      // refuse that request; this does.
      if (isControl && req.headers["x-blaze-csrf"] !== CSRF) {
        return json(403, { errors: ["bad csrf token"] });
      }
    }

    if (req.method === "GET" && u.pathname === "/api/hash") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(contentHash({ projectsDir }));
      return;
    }
    if (req.method === "GET" && u.pathname === "/api/sync") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ahead: aheadCount() }));
      return;
    }
    // GET-only, and that is load-bearing rather than tidiness: SUPERVISOR_SCOPES
    // classifies "GET /events", so a POST here would resolve to no scope, skip the gate
    // above and open an unauthenticated stream on a board that has users. Every other
    // handler in this file already pins its method.
    if (req.method === "GET" && u.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const off = bus.subscribe((evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`));
      const hb = setInterval(() => res.write(": hb\n\n"), 15000);
      req.on("close", () => { clearInterval(hb); off(); });
      return;
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
      });
      if (!envelope) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: ["unknown view"] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(envelope));
      return;
    }
    if (req.method === "GET" && u.pathname === "/") {
      // The query scopes the initial full-page render (?project=/?focus=/?flat=/?view=)
      // — matches serve.mjs's GET /, and a drilldown link is a full-page ?focus=
      // navigation, so matching on the PATH rather than the whole URL is what keeps it
      // from 404ing.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pageHtml({
        project: u.searchParams.get("project") || "all",
        focus: u.searchParams.get("focus") || null,
        flat: u.searchParams.get("flat") === "1",
        sprint: u.searchParams.get("sprint") || null,
        view: u.searchParams.get("view") || "board",
        afterHeader: CONTROLS_HTML,
        beforeBodyEnd: ACTIVITY_SCRIPT,
        projectsDir,
      }));
      return;
    }
    const ctl = u.pathname.match(/^\/control\/(reconcile|groomer)\/(start|stop|run)$/);
    if (ctl && req.method === "POST") {
      const [, name, action] = ctl;
      if (action === "start") startLoop(name);
      else if (action === "stop") stopLoop(name);
      else (name === "reconcile" ? runReconcile : runGroomer)();
      res.writeHead(204); res.end();
      return;
    }
    if (u.pathname === "/control/revert" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let sha;
        try { ({ sha } = JSON.parse(body || "{}")); }
        catch { return json(400, { errors: ["bad json body"] }); }
        // BLZ-359: `sha` came off the wire and went straight into an argv with no `--`
        // ahead of it, so a value beginning with `-` was parsed by git as an OPTION
        // rather than a commit. There is no shell here, so this was never RCE — but
        // `--strategy-option=...`-shaped input is still an attacker choosing git's
        // behaviour, and the endpoint's whole job is to run git. Refused at the door
        // AND separated with `--`, because either alone is one edit away from gone.
        if (!SHA_RE.test(String(sha ?? ""))) {
          bus.publish({ type: "error", loop: "groomer",
                        message: `revert refused: ${JSON.stringify(sha ?? null)} is not a commit sha`,
                        ts: today() });
          return json(400, { errors: ["not a commit sha"] });
        }
        try {
          execFileSync("git", ["-C", root, "revert", "--no-edit", "--", sha]);
          bus.publish({ type: "status", loop: "groomer", state: `reverted ${sha.slice(0, 7)}`, ts: today() });
        } catch (e) {
          bus.publish({ type: "error", loop: "groomer", message: `revert failed: ${e.message}`, ts: today() });
        }
        res.writeHead(204); res.end();
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  return { server, bus, startLoop, stopLoop, runReconcile, runGroomer, identity };
}

/**
 * The ONLY address `blaze start` binds. BLZ-359, AC 3.
 *
 * This server is loopback-BY-CONSTRUCTION and stays that way: unlike `serve.mjs` it does
 * not read `HOST`, and there is no configuration that widens it. That is deliberate and
 * it is the reason this defect was local-only rather than remote — `/control/revert` and
 * `/control/groomer/run` are a shell-out and an agent dispatch, and neither belongs on an
 * interface reachable from off the machine even with a token.
 *
 * `checkBindSafety` IS called below, on the `host` argument, so the ADR-0013 boundary is
 * live here rather than merely inherited. Called on a constant it could only ever return
 * ok, which is the shape of check this repo has spent the week deleting — so `startSupervisor`
 * takes an explicit `host`, defaulted to this constant and fed by nothing in the shipped
 * path, precisely so the refusal is reachable and provable. The tests exercise both
 * halves: that a non-loopback host with no identities is refused, and that HOST in the
 * environment does not move this bind.
 */
export const SUPERVISOR_HOST = "127.0.0.1";

/**
 * Boot the supervisor: build the app, vouch for the bind address, then listen.
 *
 * Ordered exactly as `serve.mjs` orders it. `createApp` runs FIRST because it is what
 * diagnoses a damaged roster, and a corrupt identity.db must be reported as a corrupt
 * identity.db rather than as "no users configured". Both refusals happen before
 * `.listen()`: a warning printed next to a socket that is already accepting connections
 * is not a refusal.
 */
export function startSupervisor({
  root = resolveRoots().dataRoot,
  cfg = loadConfig({ root }),
  port = Number(process.env.PORT) || cfg.port,
  host = SUPERVISOR_HOST,
  identity,
  onListening,
} = {}) {
  const app = createApp(cfg, identity === undefined ? { root } : { root, identity });
  const bind = checkBindSafety({ host, hasIdentity: Boolean(app.identity?.hasIdentity) });
  if (!bind.ok) throw new Error(bind.error);
  app.server.listen(port, host, onListening);
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolveRoots().dataRoot;
  const cfg = loadConfig({ root });
  const port = Number(process.env.PORT) || cfg.port;
  // Loud and fatal, not a stack trace: a broken roster is an operator problem with a
  // named fix, and the message says which file to deal with.
  let app;
  try {
    app = startSupervisor({ root, cfg, port, onListening: () => {
      console.log(`${cfg.boardTitle} app → http://localhost:${port}`);
      if (cfg.loops.reconcile.enabled && listProjects(cfg).length) app.startLoop("reconcile");
      if (cfg.loops.groomer.enabled) app.startLoop("groomer");
    } });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
