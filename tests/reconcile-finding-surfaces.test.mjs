// reconcile-finding-surfaces.test.mjs — BLZ-395, review round 1.
//
// Two defects found by the behaviour/security-scoped adversarial review of PR #128, both
// on the SURFACES a finding travels over rather than in the rule that produces it.
// Neither was caught by CI, and neither was caught by the 30 tests already covering the
// rule — which is the point: the finding was correct, deduped, published, and unreadable.
//
//   1. `newFindingEvents` publishes `type: "warning"`, and the activity feed's `line()`
//      had no branch for it, so the event rendered as the bare word "warning". A guard
//      can be UNOBSERVABLE rather than untested, and BLZ-395's whole deliverable is that
//      somebody is told.
//   2. `gh pr list` JSON was trusted verbatim. Control characters in `pr.url`/`pr.number`
//      reach the CLI's stderr, where a newline forges an entire extra
//      `reconcile: NEEDS ATTENTION —` line and ESC bytes write an OSC-8 hyperlink.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ACTIVITY_SCRIPT, newFindingEvents } from "../scripts/supervisor.mjs";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

// =============================================================================
// 1. The feed renders the finding, not the word "warning"
// =============================================================================

describe("BLZ-395: a published finding is READABLE in the activity feed", () => {
  // The renderer is browser code inside a template string, so it is extracted and run
  // against a DOM shim. Extracting the SHIPPED source is load-bearing: a hand-copied
  // twin would keep passing after someone edited the real one.
  function renderLine(event) {
    const src = ACTIVITY_SCRIPT;
    const start = src.indexOf("function line(e) {");
    assert.ok(start > 0, "line() must be findable in ACTIVITY_SCRIPT — this reads the SHIPPED renderer");
    let depth = 0, end = -1;
    for (let i = src.indexOf("{", start); i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    assert.ok(end > start, "line() body must be extractable");
    const el = () => {
      const node = { children: [], textContent: "", className: "", _html: "" };
      node.appendChild = (c) => { node.children.push(c); return c; };
      node.append = (...cs) => { node.children.push(...cs); };
      node.prepend = (c) => { node.children.unshift(c); };
      node.removeChild = (c) => { node.children = node.children.filter((x) => x !== c); };
      Object.defineProperty(node, "innerHTML", { get: () => node._html, set: (v) => { node._html = v; } });
      return node;
    };
    const act = el();
    const document = { createElement: el, getElementById: () => act };
    const fn = new Function("document", "act", src.slice(start, end) + "; return line;")(document, act);
    fn(event);
    const li = act.children[0];
    return { text: li.children.map((c) => c.textContent).join("|"), html: li._html };
  }

  const finding = {
    type: "warning", loop: "reconcile", id: "INF-645", ts: "2026-08-26",
    message: "INF-645 is done, but PR #81 carrying its key is still OPEN (u81).",
  };

  test("the finding's MESSAGE reaches the feed", () => {
    const out = renderLine(finding);
    assert.match(out.text, /PR #81 carrying its key is still OPEN/,
      "before the fix this rendered as the single word `warning` — published and unreadable");
    assert.match(out.text, /reconcile/);
  });

  test("it is not rendered as the bare event type", () => {
    assert.notEqual(renderLine(finding).text, "2026-08-26|warning");
  });

  test("the existing event kinds still render", () => {
    assert.match(renderLine({ type: "reconcile", id: "INF-1", from: "defined", to: "done", ts: "d" }).text,
      /INF-1: defined/);
    assert.match(renderLine({ type: "error", loop: "reconcile", message: "boom", ts: "d" }).text,
      /reconcile error: boom/);
    assert.match(renderLine({ type: "status", loop: "groom", state: "idle", ts: "d" }).text, /groom idle/);
  });

  test("forge-derived text is not concatenated into innerHTML", () => {
    // The message carries a PR url from `gh`; a forge error carries a remote host and a
    // codeRepo path. Adding the warning branch into the old innerHTML concat would have
    // widened a live injection sink rather than filled a gap.
    const nasty = { ...finding, message: '<img src=x onerror="alert(1)">' };
    const out = renderLine(nasty);
    assert.equal(out.html, "", "the row must be built from nodes, not an HTML string");
    assert.match(out.text, /<img src=x onerror="alert\(1\)">/, "and the text survives verbatim, as TEXT");
  });

  test("a warning still carries its id, so the feed traces back to a ticket", () => {
    assert.equal(newFindingEvents([{ id: "INF-645", message: "m" }], new Set())[0].id, "INF-645");
  });
});

// =============================================================================
// 2. The forge's JSON is untrusted input
// =============================================================================

describe("BLZ-395: `gh` output cannot forge a line on the operator's terminal", () => {
  /** Drive the REAL CLI with a stub `gh`, capturing stderr as a terminal would see it. */
  function runCli(prs) {
    const tmp = mkdtempSync(join(tmpdir(), "blz-forge-"));
    try {
      const repo = join(tmp, "svc");
      mkdirSync(repo, { recursive: true });
      execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
      execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
      execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
      writeFileSync(join(repo, "README.md"), "x\n");
      execFileSync("git", ["-C", repo, "add", "-A"]);
      execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"]);
      execFileSync("git", ["-C", repo, "remote", "add", "origin",
        "https://github.com/hjr15/service-platform.git"]);
      const root = join(tmp, "board");
      const dir = join(root, "projects", "INF", "done");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "INF-645-t.md"),
        "---\nid: INF-645\ntype: epic\nproject: INF\nestimate: 30\n---\n\nbody\n");
      writeFileSync(join(root, "blaze.config.json"),
        JSON.stringify({ key: "INF", projects: ["INF"], codeRepos: [repo] }));
      const bin = join(tmp, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "gh"),
        "#!/usr/bin/env bash\ncat <<'JSON'\n" + JSON.stringify(prs) + "\nJSON\n");
      execFileSync("chmod", ["+x", join(bin, "gh")]);
      const res = spawnSync(process.execPath,
        [join(import.meta.dirname, "..", "scripts", "reconcile.mjs")],
        { cwd: root, encoding: "utf8", env: { ...process.env, PATH: bin + ":" + process.env.PATH } });
      assert.equal(res.status, 0, "the CLI must run: " + res.stderr);
      return res.stderr || "";
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const MERGED = { number: 80, state: "MERGED", url: "u80",
    headRefName: "INF-645-docs", title: "INF-645: docs" };

  test("the finding is reported at all — the control for both tests below", () => {
    // Without this, a fix that suppressed the whole line would pass the two tests below.
    const err = runCli([MERGED, { number: 81, state: "OPEN", url: "u81",
      headRefName: "INF-645-work", title: "INF-645: work" }]);
    assert.match(err, /NEEDS ATTENTION/);
    assert.match(err, /#81/);
  });

  test("a newline in pr.number cannot forge a second NEEDS ATTENTION line", () => {
    const err = runCli([MERGED, { number: "81\nreconcile: NEEDS ATTENTION — FORGED",
      state: "OPEN", url: "u81", headRefName: "INF-645-work", title: "INF-645: work" }]);
    const lines = err.split("\n").filter((l) => l.includes("NEEDS ATTENTION"));
    assert.equal(lines.length, 1,
      "exactly one NEEDS ATTENTION line may appear; got " + lines.length + ":\n" + err);
    assert.doesNotMatch(err, /FORGED/, "the injected text must not survive as its own line");
  });

  test("ESC bytes in pr.url never reach the terminal", () => {
    const err = runCli([MERGED, { number: 81, state: "OPEN",
      url: ESC + "]8;;https://evil.example/" + BEL + "CLICKME" + ESC + "]8;;" + BEL,
      headRefName: "INF-645-work", title: "INF-645: work" }]);
    assert.equal(err.includes(ESC), false, "no ESC byte may reach stderr");
    assert.equal(err.includes(BEL), false, "nor a BEL");
    assert.match(err, /NEEDS ATTENTION/, "and the finding must still be reported");
  });
});

// =============================================================================
// 3. Every surfacing path is HELD BY A TEST — review round 2
// =============================================================================
// The behaviour-scoped review deleted each of the three publish/render sites in turn
// and the whole suite stayed green: `newFindingEvents(...)` in the supervisor's
// `runReconcile`, `findings: r.findings || []` on `/api/reconcile-preview`, and the
// CLI's stderr loop. The precedent each of those cites — `forgeErrors` — IS pinned in
// its own place, so the new field beside it being unpinned is the gap. The CLI loop is
// covered by the `runCli` tests above; these two close the rest.

test("BLZ-395: the supervisor's reconcile loop PUBLISHES the finding", async () => {
  const { loadConfig } = await import("../scripts/config.mjs");
  const { createApp } = await import("../scripts/supervisor.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "blz395-sup-"));
  try {
    const repo = join(tmp, "svc");
    mkdirSync(repo, { recursive: true });
    for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]])
      execFileSync("git", ["-C", repo, ...a]);
    writeFileSync(join(repo, "R"), "x");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin",
      "https://github.com/hjr15/service-platform.git"]);

    const root = join(tmp, "board");
    mkdirSync(join(root, "projects", "INF", "done"), { recursive: true });
    writeFileSync(join(root, "projects", "INF", "done", "INF-645-t.md"),
      "---\nid: INF-645\ntype: epic\nproject: INF\nestimate: 30\nresolution: done\n---\n\nbody\n");
    writeFileSync(join(root, "blaze.config.json"),
      JSON.stringify({ key: "INF", projects: ["INF"], codeRepos: [repo] }));
    for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                     ["add", "-A"], ["commit", "-q", "-m", "seed"]])
      execFileSync("git", ["-C", root, ...a]);

    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), "#!/usr/bin/env bash\ncat <<'JSON'\n" + JSON.stringify([
      { number: 80, state: "MERGED", url: "u80", headRefName: "INF-645-docs", title: "INF-645: docs" },
      { number: 81, state: "OPEN", url: "u81", headRefName: "INF-645-work", title: "INF-645: the real work" },
    ]) + "\nJSON\n");
    execFileSync("chmod", ["+x", join(bin, "gh")]);
    const prevPath = process.env.PATH;
    process.env.PATH = bin + ":" + prevPath;

    const app = createApp(loadConfig({ root }), { root });
    const seen = [];
    app.bus.subscribe((e) => seen.push(e));
    try {
      await app.runReconcile();
    } finally {
      process.env.PATH = prevPath;
      app.server.close();
    }
    const warn = seen.find((e) => e.type === "warning");
    assert.ok(warn, "the loop that OPENS this window must be the one that reports it; got: " +
      JSON.stringify(seen.map((e) => e.type)));
    assert.equal(warn.id, "INF-645");
    assert.match(warn.message, /PR #81 carrying its key is still OPEN/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("BLZ-395: /api/reconcile-preview carries the findings, not just the changes", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "blz395-prev-"));
  try {
    const repo = join(tmp, "svc");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    writeFileSync(join(repo, "R"), "x");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin",
      "https://github.com/hjr15/service-platform.git"]);
    const root = join(tmp, "board");
    mkdirSync(join(root, "projects", "INF", "done"), { recursive: true });
    writeFileSync(join(root, "projects", "INF", "done", "INF-645-t.md"),
      "---\nid: INF-645\ntype: epic\nproject: INF\nestimate: 30\nresolution: done\n---\n\nbody\n");
    writeFileSync(join(root, "blaze.config.json"),
      JSON.stringify({ key: "INF", projects: ["INF"], codeRepos: [repo] }));
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), "#!/usr/bin/env bash\ncat <<'JSON'\n" + JSON.stringify([
      { number: 80, state: "MERGED", url: "u80", headRefName: "INF-645-docs", title: "INF-645: docs" },
      { number: 81, state: "OPEN", url: "u81", headRefName: "INF-645-work", title: "INF-645: the real work" },
    ]) + "\nJSON\n");
    execFileSync("chmod", ["+x", join(bin, "gh")]);
    const prevPath = process.env.PATH;
    process.env.PATH = bin + ":" + prevPath;
    const { startServer } = await import("../scripts/serve.mjs");
    const srv = startServer({ root, projectsDir: join(root, "projects"), port: 0 });
    await new Promise((r) => srv.once("listening", r));
    try {
      const { port } = srv.address();
      const j = await (await fetch("http://127.0.0.1:" + port + "/api/reconcile-preview")).json();
      assert.ok(Array.isArray(j.findings), "the preview is where a person looks before believing the board");
      assert.equal(j.findings.length, 1);
      assert.equal(j.findings[0].id, "INF-645");
      assert.equal(j.findings[0].kind, "open-pr-on-terminal");
    } finally {
      process.env.PATH = prevPath;
      srv.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// =============================================================================
// 4. `cleared` reaches the operator — review round 4
// =============================================================================
// BLZ-398 added the one direction in which reconcile DESTROYS data, and the argument for
// reporting it was that the machine-readable account of a run must say so. Under
// `blaze start` the activity feed IS that account, and `runReconcile` was dropping the
// flag on the floor — reported everywhere except the surface the argument was about.

test("BLZ-398: a cleared record is reported on the activity feed, not just the CLI", () => {
  const src = ACTIVITY_SCRIPT;
  const start = src.indexOf("function line(e) {");
  let depth = 0, end = -1;
  for (let i = src.indexOf("{", start); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  const el = () => {
    const node = { children: [], textContent: "", className: "", _html: "" };
    node.appendChild = (c) => { node.children.push(c); return c; };
    node.append = (...cs) => { node.children.push(...cs); };
    node.prepend = (c) => { node.children.unshift(c); };
    node.removeChild = (c) => { node.children = node.children.filter((x) => x !== c); };
    Object.defineProperty(node, "innerHTML", { get: () => node._html, set: (v) => { node._html = v; } });
    return node;
  };
  const act = el();
  const document = { createElement: el, getElementById: () => act };
  const line = new Function("document", "act", src.slice(start, end) + "; return line;")(document, act);

  line({ type: "reconcile", id: "INF-645", from: "in-review", to: "done", moved: true, cleared: true, ts: "d" });
  const cleared = act.children[0].children.map((c) => c.textContent).join("|");
  assert.match(cleared, /CLEARED/, "the deletion must be visible where the operator watches");

  line({ type: "reconcile", id: "INF-1", from: "defined", to: "done", moved: true, cleared: false, ts: "d" });
  const plain = act.children[0].children.map((c) => c.textContent).join("|");
  assert.doesNotMatch(plain, /CLEARED/, "and an ordinary move must not claim a deletion");
  assert.match(plain, /INF-1: defined/);
});

test("BLZ-398: the supervisor PUBLISHES cleared, it does not just render it", async () => {
  // The renderer test above builds its event by hand, so it cannot see `runReconcile`
  // dropping the flag on the way to the bus — which is exactly what it was doing.
  const { loadConfig } = await import("../scripts/config.mjs");
  const { createApp } = await import("../scripts/supervisor.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "blz398-pub-"));
  try {
    const repo = join(tmp, "svc");
    mkdirSync(repo, { recursive: true });
    for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]])
      execFileSync("git", ["-C", repo, ...a]);
    writeFileSync(join(repo, "R"), "x");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin",
      "https://github.com/hjr15/service-platform.git"]);
    const root = join(tmp, "board");
    mkdirSync(join(root, "projects", "INF", "in-review"), { recursive: true });
    // Carries a rank-chosen record from its in-review phase — the shape that gets cleared.
    writeFileSync(join(root, "projects", "INF", "in-review", "INF-645-t.md"),
      "---\nid: INF-645\ntype: epic\nproject: INF\nestimate: 30\n" +
      "branch: INF-645-docs\npr: '#40 — u40'\n---\n\nbody\n");
    writeFileSync(join(root, "blaze.config.json"),
      JSON.stringify({ key: "INF", projects: ["INF"], codeRepos: [repo] }));
    for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                     ["add", "-A"], ["commit", "-q", "-m", "seed"]])
      execFileSync("git", ["-C", root, ...a]);
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), "#!/usr/bin/env bash\ncat <<'JSON'\n" + JSON.stringify([
      { number: 10, state: "MERGED", url: "u10", headRefName: "INF-645-work", title: "INF-645: the work" },
      { number: 40, state: "MERGED", url: "u40", headRefName: "INF-645-docs", title: "INF-645: follow-up docs" },
    ]) + "\nJSON\n");
    execFileSync("chmod", ["+x", join(bin, "gh")]);
    const prevPath = process.env.PATH;
    process.env.PATH = bin + ":" + prevPath;
    const app = createApp(loadConfig({ root }), { root });
    const seen = [];
    app.bus.subscribe((e) => seen.push(e));
    try {
      await app.runReconcile();
    } finally {
      process.env.PATH = prevPath;
      app.server.close();
    }
    const ev = seen.find((e) => e.type === "reconcile" && e.id === "INF-645");
    assert.ok(ev, "the move must reach the bus; got " + JSON.stringify(seen.map((e) => e.type)));
    assert.equal(ev.cleared, true,
      "under `blaze start` the feed IS the account of the run — the deletion must be in it");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
