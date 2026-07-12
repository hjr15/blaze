// tests/serve-endpoints.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, CSRF } from "../scripts/serve.mjs";
import { acquireLock, releaseLock } from "../scripts/commit-lock.mjs";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-ep-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "in-review"), { recursive: true });
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(projects, "OBA", "in-review", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\nworklog:\n  - { date: 2026-06-01, minutes: 30 }\n---\n## Acceptance Criteria\n- [ ] one\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return { root, projects };
}

async function boot({ root, projects }) {
  const server = startServer({ projectsDir: projects, root, port: 0 });
  await new Promise((res) => server.once("listening", res));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

// Two-project fixture (T + U, one ticket each) for scoped /api/hash tests.
function repoTwoProjects() {
  const root = mkdtempSync(join(tmpdir(), "blaze-ep-hash-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  const projects = join(root, "projects");
  mkdirSync(join(projects, "T", "todo"), { recursive: true });
  mkdirSync(join(projects, "U", "todo"), { recursive: true });
  writeFileSync(join(projects, "T", "todo", "T-1.md"),
    "---\nid: T-1\ntitle: t\ntype: task\nproject: T\nestimate: 5\n---\nbody\n");
  writeFileSync(join(projects, "U", "todo", "U-1.md"),
    "---\nid: U-1\ntitle: u\ntype: task\nproject: U\nestimate: 5\n---\nbody\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return { root, projects };
}

const post = (base, path, body, headers = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-blaze-csrf": CSRF, ...headers }, body: JSON.stringify(body) });

test("GET /api/hash?project=T is scoped and differs from /api/hash?project=U after touching only U", async () => {
  const fx = repoTwoProjects();
  const { server, base } = await boot(fx);
  const beforeT = await (await fetch(base + "/api/hash?project=T")).text();
  writeFileSync(join(fx.projects, "U", "todo", "U-1.md"),
    "---\nid: U-1\ntitle: changed\ntype: task\nproject: U\nestimate: 5\n---\nx\n");
  const afterT = await (await fetch(base + "/api/hash?project=T")).text();
  const afterU = await (await fetch(base + "/api/hash?project=U")).text();
  assert.equal(afterT, beforeT);       // T-scope blind to U's change
  assert.notEqual(afterT, afterU);     // and the two scopes disagree
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("GET /api/sync reports ahead count", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const j = await (await fetch(base + "/api/sync")).json();
  assert.equal(typeof j.ahead, "number");   // 0 (no upstream) is fine
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("POST without the CSRF header is rejected 403", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const res = await fetch(base + "/api/move", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 403);
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("POST /api/move performs a valid transition and commits only that file", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const res = await post(base, "/api/move", { id: "OBA-1", to: "done" });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.resolution, "done");
  const status = execFileSync("git", ["-C", fx.root, "status", "--porcelain"], { encoding: "utf8" });
  assert.equal(status.trim(), "");                       // clean: the move was committed, nothing stray
  const log = execFileSync("git", ["-C", fx.root, "log", "-1", "--name-only", "--format="], { encoding: "utf8" });
  assert.match(log, /OBA\/done\/OBA-1\.md/);
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("POST /api/move rejects an illegal skip 422 and writes nothing", async () => {
  const fx = repo();                                     // OBA-1 is in in-review
  const { server, base } = await boot(fx);
  // defined <- in-review is a backward skip that is not a legal forward transition target
  const res = await post(base, "/api/move", { id: "OBA-1", to: "in-progress" });
  assert.equal(res.status, 422);
  assert.equal(execFileSync("git", ["-C", fx.root, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("POST /api/edit patches a field and commits", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const res = await post(base, "/api/edit", { id: "OBA-1", patch: { assignee: "ryan" } });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.match(execFileSync("git", ["-C", fx.root, "log", "-1", "--format=%s"], { encoding: "utf8" }), /OBA-1: edit/);
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("POST /api/ac toggles an AC checkbox and commits", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const res = await post(base, "/api/ac", { id: "OBA-1", index: 0, checked: true });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const show = execFileSync("git", ["-C", fx.root, "show", "HEAD:projects/OBA/in-review/OBA-1.md"], { encoding: "utf8" });
  assert.match(show, /- \[x\] one/);
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("POST /api/log appends a worklog entry and commits", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const res = await post(base, "/api/log", { id: "OBA-1", minutes: 15, note: "review" });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("POST /api/log responds 503 when the commit lock is held (not a generic 500)", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  assert.equal(acquireLock(fx.root, { session: "other" }).ok, true);
  try {
    const res = await post(base, "/api/log", { id: "OBA-1", minutes: 15, note: "review" });
    const body = await res.json();
    assert.equal(res.status, 503, JSON.stringify(body));
    assert.match(body.errors[0], /commit lock held/);
  } finally {
    releaseLock(fx.root);
    server.close(); rmSync(fx.root, { recursive: true, force: true });
  }
});

test("POST /api/resolve overrides resolution and commits", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const res = await post(base, "/api/resolve", { id: "OBA-1", resolution: "wont-do" });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.match(execFileSync("git", ["-C", fx.root, "log", "-1", "--format=%s"], { encoding: "utf8" }), /OBA-1: resolve wont-do/);
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

import { pageHtml } from "../scripts/serve.mjs";

// Both tests below need at least one rendered ticket card, so they use a
// fixture projectsDir rather than the ambient cwd board data (which may not
// exist, or may differ, depending on where this repo checkout lives).
function ticketFixture() {
  const fixDir = mkdtempSync(join(tmpdir(), "blaze-ep2-"));
  mkdirSync(join(fixDir, "T", "todo"), { recursive: true });
  writeFileSync(join(fixDir, "T", "todo", "T-1.md"),
    "---\nid: T-1\ntitle: fixture ticket\ntype: task\nproject: T\nestimate: 5\npriority: medium\n---\n## Acceptance Criteria\n- [ ] one\n");
  return fixDir;
}

test("pageHtml wires drag + csrf + toast", () => {
  const fixDir = ticketFixture();
  const html = pageHtml({ project: "all", projectsDir: fixDir });
  rmSync(fixDir, { recursive: true, force: true });
  assert.match(html, /draggable="true"/);
  assert.match(html, /data-status=/);
  assert.match(html, /window\.__csrf/);
  assert.match(html, /blazePost/);
  assert.match(html, /id="toast"/);
});

test("pageHtml renders inline-edit affordances", () => {
  const fixDir = ticketFixture();
  const html = pageHtml({ project: "all", projectsDir: fixDir });
  rmSync(fixDir, { recursive: true, force: true });
  assert.match(html, /data-edit="priority"/);
  assert.match(html, /data-edit="assignee"/);
  assert.match(html, /blazeEdit/);
});

test("pageHtml renders live AC checkboxes and a sync badge", () => {
  // Use a dedicated fixture directory so AC checkbox rendering is deterministic.
  // Only AC-section checkboxes here so doesNotMatch(disabled) is unambiguous.
  const fixDir = mkdtempSync(join(tmpdir(), "blaze-ac-"));
  mkdirSync(join(fixDir, "T", "todo"), { recursive: true });
  writeFileSync(join(fixDir, "T", "todo", "T-1.md"),
    "---\nid: T-1\ntitle: ac test\ntype: task\nproject: T\nestimate: 5\n---\n## Acceptance Criteria\n- [ ] first ac\n- [x] second ac\n");
  const html = pageHtml({ project: "all", projectsDir: fixDir });
  rmSync(fixDir, { recursive: true, force: true });
  assert.match(html, /data-ac-index=/);
  assert.doesNotMatch(html, /<input type="checkbox" disabled/); // AC boxes are live, not disabled
  assert.match(html, /id="sync"/);
});

test("pageHtml includes reconcileBtn", () => {
  const html = pageHtml({ project: "all" });
  assert.match(html, /id="reconcileBtn"/);
});

test("pageHtml renders a client-side search box wired to a filter pass", () => {
  const html = pageHtml({ project: "all" });
  assert.match(html, /id="board-search"/);
  assert.match(html, /applyFilters/);
  // filtered-out cards/rows are hidden purely client-side (no round-trip)
  assert.match(html, /\.filtered-out/);
});

test("pageHtml renders a status chip bar with counts, All/Active presets, hash wiring", () => {
  const fixDir = ticketFixture();   // T-1 lives in the 'todo' status dir
  const html = pageHtml({ project: "all", projectsDir: fixDir });
  rmSync(fixDir, { recursive: true, force: true });
  assert.match(html, /class="chipbar"/);
  assert.match(html, /data-chip="all"/);
  assert.match(html, /data-chip="active"/);
  assert.match(html, /class="chip"[^>]*data-status="todo"/); // one chip per resolved status
  assert.match(html, /chip-n">1</);                          // live count on the chip
  assert.match(html, /hashchange/);                          // chip state round-trips via the URL hash
});

test("pageHtml priority select includes none and urgent (Fix 2 — unified enum)", () => {
  // The client-side PRIORITIES array must be injected from the canonical server constant,
  // covering all enum values including none and urgent (previously absent from the narrow list).
  const html = pageHtml({ project: "all" });
  // The injected array literal must contain both values.
  assert.match(html, /"none"/, "none missing from injected PRIORITIES");
  assert.match(html, /"urgent"/, "urgent missing from injected PRIORITIES");
});

test("pageHtml client script contains self-drop guard (Fix 3)", () => {
  // The drop handler must compare dragSourceStatus to zone.dataset.status
  // before POSTing, so a same-column drop is a no-op without a network request.
  const html = pageHtml({ project: "all" });
  assert.match(html, /dragSourceStatus !== zone\.dataset\.status/, "self-drop guard missing");
});

test("GET /api/panel returns the rendered detail panel, 404 for an unknown id", async () => {
  const fx = repo();                                   // OBA-1 in OBA/in-review, has one AC
  const { server, base } = await boot(fx);
  const res = await fetch(base + "/api/panel?id=OBA-1");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /html/);
  const html = await res.text();
  assert.match(html, /data-ticket="OBA-1"/);           // AC-toggle hook
  assert.match(html, /data-ac-index/);                 // live AC checkbox in the rendered body
  const miss = await fetch(base + "/api/panel?id=NOPE");
  assert.equal(miss.status, 404);
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("GET /api/reconcile-preview returns a change list and writes nothing", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const res = await fetch(base + "/api/reconcile-preview");
  const j = await res.json();
  assert.ok(Array.isArray(j.changes));
  assert.equal(execFileSync("git", ["-C", fx.root, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

// Review fix: /api/reconcile-preview must reuse the server's resolved
// projectsDir, not recompute join(root, "projects"). With a custom-named
// projects dir (documented via BLAZE_PROJECTS_DIR — tests/roots.test.mjs) the
// board rendered tickets but the preview silently returned { changes: [] }.
test("GET /api/reconcile-preview sees tickets under a custom-named projectsDir", async () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-ep-custom-"));
  const codeRepo = mkdtempSync(join(tmpdir(), "blaze-ep-code-"));
  for (const dir of [root, codeRepo]) {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  }
  writeFileSync(join(codeRepo, "README.md"), "x\n");
  execFileSync("git", ["-C", codeRepo, "add", "-A"]);
  execFileSync("git", ["-C", codeRepo, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", codeRepo, "checkout", "-q", "-b", "you/ZZZ-1-fix-thing"]);

  const tickets = join(root, "tickets");                 // deliberately NOT "projects"
  mkdirSync(join(tickets, "ZZZ", "defined"), { recursive: true });
  writeFileSync(join(tickets, "ZZZ", "defined", "ZZZ-1-fix-thing.md"),
    "---\nid: ZZZ-1\ntitle: t\ntype: task\nstatus: defined\nproject: ZZZ\nestimate: 30\n---\n\nbody\n");
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "ZZZ", projects: ["ZZZ"], codeRepos: [codeRepo] }));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);

  const { server, base } = await boot({ root, projects: tickets });
  try {
    const j = await (await fetch(base + "/api/reconcile-preview")).json();
    assert.equal(j.changes.length, 1, "preview must find the ticket under the custom-named projects dir");
    assert.equal(j.changes[0].id, "ZZZ-1");
    assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
  } finally {
    // finally, not tail cleanup: a failed assertion must not leak the server
    // handle (it keeps the test process alive) or the temp dirs.
    server.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(codeRepo, { recursive: true, force: true });
  }
});

test("GET /api/live groups fresh events and degrades to [] with no file", async () => {
  const fx = repo();                                  // OBA-1 lives in OBA/in-review
  // no .blaze yet -> empty
  let { server, base } = await boot(fx);
  let j = await (await fetch(base + "/api/live")).json();
  assert.deepEqual(j.groups, []);
  server.close();

  // now drop a fresh event for OBA-1 and a stale one
  mkdirSync(join(fx.root, ".blaze"), { recursive: true });
  const fresh = new Date().toISOString();
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  writeFileSync(join(fx.root, ".blaze", "activity.jsonl"),
    `{"ts":"${stale}","key":"OBA-1","branch":"OBA-1-x","tool":"Read","cwd":"/c"}\n` +
    `{"ts":"${fresh}","key":"OBA-1","branch":"OBA-1-x","tool":"Bash","cwd":"/c"}\n` +
    `garbage line\n`);
  ({ server, base } = await boot(fx));
  j = await (await fetch(base + "/api/live")).json();
  assert.equal(j.groups.length, 1);
  assert.equal(j.groups[0].key, "OBA-1");
  assert.equal(j.groups[0].tool, "Bash");             // latest wins
  assert.equal(j.groups[0].active, true);
  assert.equal(j.groups[0].column, "in-review");      // from the board index
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("pageHtml wires a card/row click to open the detail panel", () => {
  const html = pageHtml({ project: "all" });
  assert.match(html, /blazePanel\.open/);   // clicking a ticket id opens the panel
});

test("pageHtml client shows-all for an unknown #status (mirrors model statusFilter, no blank board)", () => {
  const html = pageHtml({ project: "all" });
  // The client must guard the hash status against the known status list before
  // constraining — an unknown/stale/shared value falls through to show-all
  // instead of hiding every card (which diverges from model/filters.mjs).
  assert.match(html, /const ALL_STATUSES =/);
  assert.match(html, /ALL_STATUSES\.includes\(v\)/);
});

test("pageHtml scopes drag-drop drop zones to columns/groups so chips are not move targets", () => {
  const html = pageHtml({ project: "all" });
  // Status chips also carry data-status (for filtering); the drop-zone query
  // must not treat them as move targets, or dropping a card on a chip moves it.
  assert.match(html, /querySelectorAll\("\.col\[data-status\], \.group\[data-status\]"\)/);
  assert.doesNotMatch(html, /querySelectorAll\("\[data-status\]"\)/);
});

test("pageHtml wires the Live view pill, region and poll", () => {
  const html = pageHtml({ project: "all" });
  assert.match(html, /data-view="live"/);
  assert.match(html, /\/api\/live/);
});

test("GET /view/list returns a JSON envelope with only the list markup", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const res = await fetch(`${base}/view/list`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.view, "list");
  assert.match(j.html, /class="list"/);
  assert.doesNotMatch(j.html, /class="board"/);
  assert.match(j.chipbar, /class="chipbar"/);
  assert.equal(typeof j.total, "number");
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("GET /view/nope 404s", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const res = await fetch(`${base}/view/nope`);
  assert.equal(res.status, 404);
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("startServer views option disables a view: /view/map 404s, no map pill, board pill present", async () => {
  const fx = repo();
  const server = startServer({
    projectsDir: fx.projects, root: fx.root, port: 0,
    views: { board: true, list: true, live: true, metrics: true, map: false },
  });
  await new Promise((res) => server.once("listening", res));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const viewRes = await fetch(`${base}/view/map`);
    assert.equal(viewRes.status, 404);
    const html = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(html, /class="pill" data-view="map"/);
    assert.match(html, /class="pill" data-view="board"/);
  } finally {
    server.close(); rmSync(fx.root, { recursive: true, force: true });
  }
});

// Review fix (BLZ-88): GET /?view=map must not bypass the views gate. Only
// /view/<name> checked views[view] before this fix — pageHtml took ?view=
// straight from the query string and rendered it (including running
// graphModel), defeating the whole point of disabling a view.
test("GET /?view=map falls back to board when map is disabled (no bypass, no graphModel compute)", async () => {
  const fx = repo();
  const server = startServer({
    projectsDir: fx.projects, root: fx.root, port: 0,
    views: { board: true, list: true, live: true, metrics: true, map: false },
  });
  await new Promise((res) => server.once("listening", res));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/?view=map`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.doesNotMatch(html, /class="mapview"/);
    assert.match(html, /data-rendered="board"/);
  } finally {
    server.close(); rmSync(fx.root, { recursive: true, force: true });
  }
});

test("GET /?view=board still works when map is disabled", async () => {
  const fx = repo();
  const server = startServer({
    projectsDir: fx.projects, root: fx.root, port: 0,
    views: { board: true, list: true, live: true, metrics: true, map: false },
  });
  await new Promise((res) => server.once("listening", res));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/?view=board`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /data-rendered="board"/);
  } finally {
    server.close(); rmSync(fx.root, { recursive: true, force: true });
  }
});

test("GET / gzips when asked", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const res = await fetch(`${base}/`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(res.headers.get("content-encoding"), "gzip"); // fetch auto-decodes body
  assert.match(await res.text(), /<!doctype html>/);
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("GET / renders only the active view's markup", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const res = await fetch(`${base}/`);
  const html = await res.text();
  assert.match(html, /id="viewhost" data-rendered="board"/);
  assert.doesNotMatch(html, /class="list" data-board/); // list not inlined
  assert.doesNotMatch(html, /svg class="graph"/);       // map not inlined
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("GET /view/live envelope carries the class=\"live\" markup", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const res = await fetch(`${base}/view/live`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.view, "live");
  assert.match(j.html, /class="live"/);
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});
