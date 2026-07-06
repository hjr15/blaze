// scripts/model/activity.mjs — pure core for the board's Live view.
// Tails <dataRoot>/.blaze/activity.jsonl (written by the claude-config
// PostToolUse hook), parses it defensively, and groups events by ticket with a
// TTL-based active/idle state. No new source of truth: the .jsonl is an
// append-only, regenerable, truncatable feed. Zero-dep, pure functions only —
// I/O and `now` are the caller's job so this is fully unit-testable.

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Parse raw file text into validated events. Malformed JSON or lines missing a
// string ts/key/tool are skipped (never fatal). Only the last `limit` lines are
// considered, so the feed can grow unbounded and reads stay cheap.
export function parseActivity(text, { limit = 500 } = {}) {
  const lines = String(text ?? "").split("\n").filter((l) => l.trim() !== "");
  const tail = lines.slice(-limit);
  const out = [];
  for (const line of tail) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e.ts !== "string" || typeof e.key !== "string" || typeof e.tool !== "string") continue;
    out.push({ ts: e.ts, key: e.key, tool: e.tool, branch: typeof e.branch === "string" ? e.branch : "", cwd: typeof e.cwd === "string" ? e.cwd : "" });
  }
  return out;
}

// Group events by ticket key, using each key's most-recent event. Sorted by
// recency (newest first). active = the latest event is within ttlMs of `now`.
export function groupByTicket(events, { now = Date.now(), ttlMs = 120_000, statusByKey = {} } = {}) {
  const byKey = new Map();
  for (const e of events) {
    const ms = Date.parse(e.ts);
    if (Number.isNaN(ms)) continue;
    const prev = byKey.get(e.key);
    if (!prev) { byKey.set(e.key, { ...e, lastTs: ms, count: 1 }); continue; }
    prev.count += 1;
    if (ms >= prev.lastTs) { prev.lastTs = ms; prev.tool = e.tool; prev.branch = e.branch; prev.cwd = e.cwd; prev.ts = e.ts; }
  }
  return [...byKey.values()]
    .map((g) => {
      const ageMs = Math.max(0, now - g.lastTs);
      return { key: g.key, tool: g.tool, branch: g.branch, cwd: g.cwd, lastTs: g.lastTs, ageMs, active: ageMs <= ttlMs, column: statusByKey[g.key] ?? null, count: g.count };
    })
    .sort((a, b) => b.lastTs - a.lastTs);
}

export function relativeTime(ageMs) {
  const s = Math.floor(Math.max(0, ageMs) / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Render the live cards as an HTML fragment. Pure string builder so it's
// testable and serve.mjs just drops the result into the .live region.
export function renderLiveHtml(groups) {
  if (!groups || groups.length === 0) {
    return '<div class="empty live-empty">No recent activity — no-data. The feed is empty or agents are idle.</div>';
  }
  return groups.map((g) => `
    <article class="livecard ${g.active ? "active" : "idle"}" data-key="${esc(g.key)}">
      <div class="lc-top">
        <span class="id">${esc(g.key)}</span>
        <span class="lc-dot ${g.active ? "on" : ""}" aria-hidden="true"></span>
        <span class="lc-age">${esc(relativeTime(g.ageMs))}</span>
      </div>
      <div class="lc-now">now: <strong>${esc(g.tool)}</strong></div>
      <div class="lc-meta">
        ${g.column ? `<span class="lc-col">${esc(g.column)}</span>` : ""}
        <span class="lc-branch">${esc(g.branch)}</span>
      </div>
    </article>`).join("");
}
