#!/usr/bin/env node
// serve.mjs — a tiny, zero-dependency dashboard for the file-based tracker.
//
//   node scripts/serve.mjs            # serves http://localhost:<cfg.port>
//   PORT=8080 node scripts/serve.mjs  # custom port
//
// Reads the markdown tickets fresh on every request, so editing a file in your
// IDE and refreshing shows the change. The page also auto-reloads within a few
// seconds when any ticket file changes (it polls a cheap content hash), but
// never reloads while the files are untouched — so it won't fight you mid-read.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadConfig, listProjects, resolveRoots } from "./config.mjs";
import { applyMove } from "./move.mjs";
import { applyResolve } from "./resolve.mjs";
import { applyLog } from "./log.mjs";
import { applyEdit, applyToggleAc } from "./edit.mjs";
import { commitFile } from "./serve-commit.mjs";
import { boardModel, contentHash, liveModel } from "./views/data.mjs";
import { pageHtml, CSRF } from "./views/page.mjs";
export { boardModel, contentHash, liveModel, pageHtml, CSRF }; // back-compat for tests + supervisor.mjs

const cfg = loadConfig({ root: resolveRoots().dataRoot });

const PORT = Number(process.env.PORT) || cfg.port;

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

// ---- server factory ---------------------------------------------------------

export function startServer({ projectsDir = resolveRoots().projectsDir, root = resolveRoots().dataRoot, port = PORT, host = process.env.HOST || "127.0.0.1" } = {}) {
  return createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

    if (req.method === "GET" && u.pathname === "/api/hash") {
      res.writeHead(200, { "content-type": "text/plain" }); res.end(contentHash()); return;
    }
    if (req.method === "GET" && u.pathname === "/api/sync") return json(200, { ahead: aheadCount(root) });
    if (req.method === "GET" && u.pathname === "/api/live") {
      return json(200, liveModel(root, projectsDir));
    }
    if (req.method === "GET" && u.pathname === "/api/reconcile-preview") {
      const { reconcile } = await import("./reconcile.mjs");
      const r = reconcile({ fetch: false, commit: false, push: false, dryRun: true, root, projectsDir });
      return json(200, { changes: r.changes || [] });
    }
    if (req.method === "GET" && u.pathname === "/") {
      const project = u.searchParams.get("project") || "all";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pageHtml({ project })); return;
    }
    if (req.method === "POST") {
      if (req.headers["x-blaze-csrf"] !== CSRF) return json(403, { errors: ["bad csrf token"] });

      let payload;
      try { payload = await readJson(req); } catch { return json(400, { errors: ["bad json body"] }); }
      const today = new Date().toISOString().slice(0, 10);
      // in-place ops only — use the inline path for ops that rename (see /api/move)
      const done = (r, msg, extra = {}) => {
        if (!r.ok) return json(422, { errors: r.errors });
        const c = commitFile(root, r.file, msg);
        if (!c.ok) return json(500, { errors: [`written but commit failed (status ${c.status})`] });
        return json(200, { ok: true, ...extra });
      };

      if (u.pathname === "/api/move") {
        const r = applyMove(projectsDir, payload.id, payload.to, { today });
        if (!r.ok) return json(422, { errors: r.errors });
        const extraFiles = (r.fromFile && r.fromFile !== r.file) ? [r.fromFile] : [];
        const c = commitFile(root, r.file, `${payload.id}: ${r.from ?? "?"} → ${payload.to}`, extraFiles);
        if (!c.ok) return json(500, { errors: [`written but commit failed (status ${c.status})`] });
        return json(200, { ok: true, resolution: r.resolution });
      }
      if (u.pathname === "/api/edit") {
        const r = applyEdit(projectsDir, payload.id, payload.patch || {}, { today });
        return done(r, `${payload.id}: edit ${Object.keys(payload.patch || {}).join(",")}`);
      }
      if (u.pathname === "/api/resolve") {
        const r = applyResolve(projectsDir, payload.id, payload.resolution, { today });
        return done(r, `${payload.id}: resolve ${payload.resolution}`);
      }
      if (u.pathname === "/api/log") {
        const r = applyLog(projectsDir, payload.id, payload.minutes, { note: payload.note ?? null, today });
        return done(r, `${payload.id}: log ${payload.minutes}m`);
      }
      if (u.pathname === "/api/ac") {
        const r = applyToggleAc(projectsDir, payload.id, { index: payload.index, checked: payload.checked }, { today });
        return done(r, `${payload.id}: ac[${payload.index}]=${payload.checked ? "x" : " "}`);
      }
      return json(404, { errors: ["not found"] });
    }
    res.writeHead(404, { "content-type": "text/plain" }); res.end("not found");
  }).listen(port, host);
}

// ---- standalone entry -------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = startServer();
  server.on("listening", () => console.log(`${cfg.boardTitle} board → http://localhost:${server.address().port}`));
}
