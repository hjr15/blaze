// tests/reconcile-preview-refusal.test.mjs — BLZ-405.
//
// `/api/reconcile-preview` used to call `reconcile()` and return `{ changes: r.changes ||
// [], ... }` without ever checking `r.ok`. reconcile() has had two `ok: false` refusal
// shapes since BLZ-394 (an unknown `--project` key, or `--project` given no key at all),
// and on both, `changes` is `[]` — identical to a genuinely clean, in-sync board. A
// refused run and a clean one must not render the same.
//
// Both refusals require `projects !== null` in reconcile()'s options, and the route never
// passes one — unreachable through the endpoint TODAY (a contract gap, not a live bug),
// which is why the two refusal cases below drive `reconcilePreview()` directly with
// `projects` set rather than over HTTP: that function IS the handler's own logic (the
// route delegates to it verbatim), and adding a query-string `?project=` to reach it over
// HTTP would silently ship a DIFFERENT feature (a per-project preview) that this ticket
// deliberately does not scope. The clean-run CONTROL below drives the real HTTP endpoint,
// since that case needs no seam at all.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function oneProjectBoard(tmp) {
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "x\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/hjr15/inf.git"]);

  const root = join(tmp, "board");
  mkdirSync(join(root, "projects", "INF", "defined"), { recursive: true });
  writeFileSync(join(root, "projects", "INF", "project.json"),
    JSON.stringify({ key: "INF", codeRepos: [repo] }));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "INF", projects: ["INF"] }));
  writeFileSync(join(root, "projects", "INF", "defined", "INF-1-t.md"),
    "---\nid: INF-1\ntitle: t\ntype: task\nproject: INF\nestimate: 30\n---\n\nbody\n");
  return root;
}

describe("BLZ-405: /api/reconcile-preview tells a refusal apart from a clean run", () => {
  test("an unknown --project key: refused, not rendered as clean", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz405-unknown-"));
    try {
      const root = oneProjectBoard(tmp);
      const { reconcilePreview } = await import("../scripts/serve.mjs");
      const body = await reconcilePreview({
        root, projectsDir: join(root, "projects"), projects: ["NOPE"],
      });
      assert.equal(body.ok, false, "an unknown project key must not render as ok");
      assert.match(body.error, /NOPE/, "the refusal must say what was wrong");
      assert.deepEqual(body.changes, [], "a refusal still carries an empty (not absent) changes array");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--project given no key at all: refused, not rendered as clean", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz405-nokey-"));
    try {
      const root = oneProjectBoard(tmp);
      const { reconcilePreview } = await import("../scripts/serve.mjs");
      const body = await reconcilePreview({
        root, projectsDir: join(root, "projects"), projects: [],
      });
      assert.equal(body.ok, false);
      assert.match(body.error, /--project/i);
      assert.deepEqual(body.changes, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the control: a genuinely clean run over the real HTTP endpoint says ok: true", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz405-clean-"));
    try {
      const root = oneProjectBoard(tmp);
      const { startServer } = await import("../scripts/serve.mjs");
      const srv = startServer({ root, projectsDir: join(root, "projects"), port: 0 });
      await new Promise((resolve) => srv.once("listening", resolve));
      try {
        const { port } = srv.address();
        const j = await (await fetch(`http://127.0.0.1:${port}/api/reconcile-preview`)).json();
        assert.equal(j.ok, true, "a clean run must say so plainly, not leave `ok` implicit");
        assert.ok(Array.isArray(j.changes));
      } finally {
        srv.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Mutation-verify companion (also proven by hand and recorded in the PR body): revert
  // the `if (!r.ok)` branch in `reconcilePreview` and this test — the first refusal test
  // above — goes red, because `body.ok` becomes `undefined`/truthy-shaped instead of `false`.
  test("a refusal is never indistinguishable from a clean run on the `ok` field alone", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz405-disc-"));
    try {
      const root = oneProjectBoard(tmp);
      const { reconcilePreview } = await import("../scripts/serve.mjs");
      const refused = await reconcilePreview({ root, projectsDir: join(root, "projects"), projects: ["NOPE"] });
      const clean = await reconcilePreview({ root, projectsDir: join(root, "projects") });
      assert.notEqual(refused.ok, clean.ok, "refused and clean must not agree on `ok`");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
