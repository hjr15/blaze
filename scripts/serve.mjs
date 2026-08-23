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

export function startServer({ projectsDir = resolveRoots().projectsDir, root = resolveRoots().dataRoot, port = envPort() ?? cfgFor(root).port, host = process.env.HOST || "127.0.0.1", views } = {}) {
  return createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    const json = (code, obj) => send(req, res, code, "application/json", JSON.stringify(obj));

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
      const { port: writePort, close: closeWritePort } =
        await resolveWritePort({ dataRoot: root, projectsDir });
      try {
      if (u.pathname === "/api/move") {
        const r = await applyMove(projectsDir, payload.id, payload.to, { today, writePort });
        if (!r.ok) return json(422, { errors: r.errors });
        const extraFiles = (r.fromFile && r.fromFile !== r.file) ? [r.fromFile] : [];
        const c = commitOrQueue({ root, mode: cfgFor(root).commitMode, op: "move", id: payload.id, message: `${payload.id}: ${r.from ?? "?"} → ${payload.to}`, files: [r.file, ...extraFiles], lockOpts: LOCK_OPTS });
        if (commitFailed(c)) return;
        return json(200, { ok: true, resolution: r.resolution });
      }
      if (u.pathname === "/api/edit") {
        const r = await applyEdit(projectsDir, payload.id, payload.patch || {}, { today, writePort });
        return done(r, `${payload.id}: edit ${Object.keys(payload.patch || {}).join(",")}`, "edit");
      }
      if (u.pathname === "/api/resolve") {
        const r = await applyResolve(projectsDir, payload.id, payload.resolution, { today, writePort });
        return done(r, `${payload.id}: resolve ${payload.resolution}`, "resolve");
      }
      if (u.pathname === "/api/log") {
        const r = await applyLog(projectsDir, payload.id, payload.minutes, { note: payload.note ?? null, today, writePort });
        return done(r, `${payload.id}: log ${payload.minutes}m`, "log");
      }
      if (u.pathname === "/api/ac") {
        const r = await applyToggleAc(projectsDir, payload.id, { index: payload.index, checked: payload.checked }, { today, writePort });
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
  const server = startServer({ root });
  server.on("listening", () => console.log(`${cfgFor(root).boardTitle} board → http://localhost:${server.address().port}`));
}
