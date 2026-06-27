#!/usr/bin/env node
// supervisor.mjs — boots the Blaze app: serves the board + activity feed and runs
// the loops. All loop effects go through git on the board repo.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ROOT } from "./config.mjs";
import { pageHtml, contentHash } from "./serve.mjs";
import { createBus } from "./event-bus.mjs";
import { reconcile } from "./reconcile.mjs";
import { groomOnce } from "./loops/groomer.mjs";
import { execFileSync } from "node:child_process";

const today = () => new Date().toISOString().slice(0, 10);

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
        b.onclick = () => fetch("/control/revert", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ sha: e.sha }) });
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
          fetch("/control/" + g.dataset.loop + "/" + b.dataset.act, { method: "POST" }))));
  </script>`;

export function createApp(cfg, { root = ROOT } = {}) {
  const bus = createBus();

  const loops = { reconcile: { timer: null, busy: false }, groomer: { timer: null, busy: false } };

  function runReconcile() {
    if (!cfg.codeRepoPath || loops.reconcile.busy) return;
    loops.reconcile.busy = true;
    try {
      const r = reconcile({ fetch: true, commit: true, push: true });
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

  const server = createServer((req, res) => {
    if (req.url === "/api/hash") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(contentHash());
      return;
    }
    if (req.url === "/events") {
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
    if (req.url === "/" || req.url === "") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pageHtml({ afterHeader: CONTROLS_HTML, beforeBodyEnd: ACTIVITY_SCRIPT }));
      return;
    }
    const ctl = req.url && req.url.match(/^\/control\/(reconcile|groomer)\/(start|stop|run)$/);
    if (ctl && req.method === "POST") {
      const [, name, action] = ctl;
      if (action === "start") startLoop(name);
      else if (action === "stop") stopLoop(name);
      else (name === "reconcile" ? runReconcile : runGroomer)();
      res.writeHead(204); res.end();
      return;
    }
    if (req.url === "/control/revert" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { sha } = JSON.parse(body || "{}");
          execFileSync("git", ["-C", root, "revert", "--no-edit", sha]);
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

  return { server, bus, startLoop, stopLoop, runReconcile, runGroomer };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const app = createApp(cfg);
  const port = Number(process.env.PORT) || cfg.port;
  app.server.listen(port, () => {
    console.log(`${cfg.boardTitle} app → http://localhost:${port}`);
    if (cfg.loops.reconcile.enabled && cfg.codeRepoPath) app.startLoop("reconcile");
    if (cfg.loops.groomer.enabled) app.startLoop("groomer");
  });
}
