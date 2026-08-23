// BLZ-350 — a forge call that FAILED must not look like a repo with no PRs.
//
// `reconcile` reads PR state through exactly one forge call, `gh pr list`, and
// `gh` speaks GitHub.com and GitHub Enterprise Server only. `sh()` swallowed
// every error and returned `null`, so on a GitLab/Bitbucket/Gitea/plain-SSH
// remote that call failed with "none of the git remotes configured for this
// repository point to a known GitHub host", `JSON.parse(null || "[]")` produced
// an empty array, and the board reported a clean, in-sync run.
//
// `decide()` reaches "in-review" ONLY through its `pr` branch, so the net effect
// was a delivery workflow that had silently lost a state, with nothing on stdout,
// nothing on stderr and exit 0.
//
// GitHub-only is a STATED non-goal (docs/design.md), and this ticket does not
// change that. What it changes is that being unsupported is now SAID.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reconcile, classifyRemote, remoteHost, gatherPrs, shResult, parseRemoteUrls } from "../scripts/reconcile.mjs";

// A real git repo whose `origin` points wherever the caller says (or nowhere).
function codeRepo(tmp, name, remoteUrl) {
  const repo = join(tmp, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "seed"), "s");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "seed"]);
  if (remoteUrl) execFileSync("git", ["-C", repo, "remote", "add", "origin", remoteUrl]);
  return repo;
}

function board(tmp, codeRepos) {
  const root = join(tmp, "board");
  mkdirSync(join(root, "projects", "PROJ", "defined"), { recursive: true });
  writeFileSync(join(root, "projects", "PROJ", "project.json"), JSON.stringify({ codeRepos }));
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "PROJ", projects: ["PROJ"], codeRepos: [] }));
  writeFileSync(join(root, "projects", "PROJ", "defined", "PROJ-1-x.md"),
    "---\nid: PROJ-1\ntype: task\nstatus: defined\nproject: PROJ\nestimate: 30\n---\n\nbody\n");
  return root;
}

test("BLZ-350: a GitLab remote yields a visible forge error, not a silently empty PR map", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "blz350-gitlab-"));
  try {
    const repo = codeRepo(tmp, "svc", "https://gitlab.com/acme/svc.git");
    const root = board(tmp, [repo]);
    const r = await reconcile({ root, projectsDir: join(root, "projects"), dryRun: true });

    assert.ok(Array.isArray(r.forgeErrors),
      "reconcile must report forge-call outcomes, not just changes");
    assert.equal(r.forgeErrors.length, 1,
      "the one unreadable forge must be named, not silently skipped");
    const [f] = r.forgeErrors;
    assert.equal(f.reason, "unsupported-forge");
    assert.equal(f.host, "gitlab.com");
    assert.equal(f.repo, repo);
    assert.match(f.message, /gitlab\.com/, "the message must name the host the user actually configured");
    assert.match(f.message, /in-review/, "the message must name the status that is unreachable");
    assert.match(f.message, /\bgh\b/, "the message must name gh, so the user knows what is doing the reading");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("BLZ-350: a no-remote codeRepo is reported too — in-review is unreachable there as well", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "blz350-noremote-"));
  try {
    const repo = codeRepo(tmp, "svc", null);
    const root = board(tmp, [repo]);
    const r = await reconcile({ root, projectsDir: join(root, "projects"), dryRun: true });
    assert.equal(r.forgeErrors.length, 1);
    assert.equal(r.forgeErrors[0].reason, "no-remote");
    assert.match(r.forgeErrors[0].message, /in-review/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("BLZ-350: a GitHub remote reaches gh — a missing gh is reported as such, not as an unsupported forge", () => {
  // Hermetic on purpose: the suite must never make a live forge call. What is
  // asserted is the branch taken — github.com goes THROUGH gh, so an absent or
  // unauthenticated gh surfaces as gh's own failure, never as "wrong forge".
  const run = (cmd) => cmd === "git"
    ? { ok: true, stdout: "remote.origin.url git@github.com:hjr15/blaze.git", stderr: "", status: 0 }
    : { ok: false, stdout: "", stderr: "spawnSync gh ENOENT", status: null };
  const { forgeErrors } = gatherPrs("/repo", { run, ghHost: "" });
  assert.equal(forgeErrors.length, 1);
  assert.equal(forgeErrors[0].reason, "gh-failed",
    "a github.com remote must be handed to gh, not pre-rejected");
  assert.match(forgeErrors[0].message, /ENOENT/);
});

test("BLZ-350: the CLI says so on stderr, and stays non-fatal", () => {
  const tmp = mkdtempSync(join(tmpdir(), "blz350-cli-"));
  try {
    const repo = codeRepo(tmp, "svc", "git@gitlab.com:acme/svc.git");
    const root = board(tmp, [repo]);
    const cli = fileURLToPath(new URL("../scripts/reconcile.mjs", import.meta.url));
    const r = spawnSync(process.execPath, [cli], {
      env: { ...process.env, BLAZE_DATA_ROOT: root, BLAZE_PROJECTS_DIR: join(root, "projects") },
      cwd: root, encoding: "utf8",
    });
    assert.match(r.stderr, /FORGE UNREADABLE/,
      "the failure must be on stderr — silence is the whole bug");
    assert.match(r.stderr, /gitlab\.com/);
    assert.equal(r.status, 0,
      "an unsupported forge degrades the run; branch + shipped signals still reconcile");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --- the distinction itself, at the seam that must keep it --------------------

test("BLZ-350: shResult separates 'succeeded with no output' from 'failed'", () => {
  const empty = shResult(process.execPath, ["-e", "process.stdout.write('')"]);
  assert.equal(empty.ok, true, "a command that exits 0 printing nothing SUCCEEDED");
  assert.equal(empty.stdout, "");

  const failed = shResult(process.execPath, ["-e", "console.error('boom'); process.exit(3)"]);
  assert.equal(failed.ok, false, "a non-zero exit must not look like empty output");
  assert.equal(failed.status, 3);
  assert.match(failed.stderr, /boom/, "stderr must survive — it is what makes the error actionable");

  const missing = shResult("blaze-no-such-binary-blz350", []);
  assert.equal(missing.ok, false, "an uninstalled binary is a failure, not an empty result");
  assert.ok(missing.stderr.length > 0, "ENOENT has no stderr; the error text must stand in for it");
});

test("BLZ-350: gatherPrs reports a failed gh call instead of returning zero PRs", () => {
  const run = (cmd) => cmd === "git"
    ? { ok: true, stdout: "remote.origin.url git@github.com:acme/svc.git", stderr: "", status: 0 }
    : { ok: false, stdout: "", stderr: "gh: could not determine base repo", status: 1 };
  const { prs, forgeErrors } = gatherPrs("/repo", { run });
  assert.deepEqual(prs, []);
  assert.equal(forgeErrors.length, 1, "gh failing is an outcome the caller must be able to see");
  assert.equal(forgeErrors[0].reason, "gh-failed");
  assert.match(forgeErrors[0].message, /could not determine base repo/,
    "gh's own words are the actionable part");
});

test("BLZ-350: gatherPrs reports NOTHING when gh legitimately returns no PRs", () => {
  // The other half of the distinction — it is only worth having if the quiet
  // case stays quiet.
  const run = (cmd) => cmd === "git"
    ? { ok: true, stdout: "remote.origin.url https://github.com/acme/svc.git", stderr: "", status: 0 }
    : { ok: true, stdout: "[]", stderr: "", status: 0 };
  const { prs, forgeErrors } = gatherPrs("/repo", { run });
  assert.deepEqual(prs, []);
  assert.deepEqual(forgeErrors, [], "an empty PR list is not an error");
});

test("BLZ-350: gatherPrs never spends a gh call on a forge gh cannot read", () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(cmd);
    return cmd === "git"
      ? { ok: true, stdout: "remote.origin.url https://bitbucket.org/acme/svc.git", stderr: "", status: 0 }
      : { ok: true, stdout: "[]", stderr: "", status: 0 };
  };
  const { forgeErrors } = gatherPrs("/repo", { run });
  assert.deepEqual(calls, ["git"], "a known-unsupported host is classified without shelling to gh");
  assert.equal(forgeErrors[0].reason, "unsupported-forge");
});

// --- pure classification ------------------------------------------------------

test("BLZ-350: remoteHost parses every remote shape git accepts", () => {
  assert.equal(remoteHost("https://github.com/o/r.git"), "github.com");
  assert.equal(remoteHost("git@github.com:o/r.git"), "github.com");
  assert.equal(remoteHost("ssh://git@gitlab.example.com:2222/o/r.git"), "gitlab.example.com");
  assert.equal(remoteHost("git://Gitea.COM/o/r"), "gitea.com", "hosts are compared case-folded");
  assert.equal(remoteHost("/srv/git/r.git"), null, "a local path names no forge");
  assert.equal(remoteHost("../sibling/r"), null);
  assert.equal(remoteHost(""), null);
  assert.equal(remoteHost(undefined), null);
});

test("BLZ-350: classifyRemote splits GitHub from the forges gh cannot read", () => {
  assert.equal(classifyRemote("https://github.com/o/r.git", { ghHost: "" }).kind, "github");
  assert.equal(classifyRemote("git@github.com:o/r.git", { ghHost: "" }).kind, "github");
  for (const u of ["https://gitlab.com/o/r.git", "git@bitbucket.org:o/r.git",
                   "https://codeberg.org/o/r.git", "https://gitea.com/o/r.git",
                   "ssh://git@gitlab.internal.example.com/o/r.git",
                   "https://dev.azure.com/o/r"]) {
    assert.equal(classifyRemote(u, { ghHost: "" }).kind, "unsupported", u);
  }
  assert.equal(classifyRemote("", { ghHost: "" }).kind, "none");
  assert.equal(classifyRemote("/srv/git/r.git", { ghHost: "" }).kind, "none");
});

test("BLZ-350: an unknown host stays optimistic — GHES is self-hosted under any name", () => {
  // Guessing 'unsupported' here would silently disable PR reading for a working
  // GitHub Enterprise board, which is the exact failure mode being fixed.
  assert.equal(classifyRemote("https://git.corp.example/o/r.git", { ghHost: "" }).kind, "unknown");
  assert.equal(classifyRemote("https://git.corp.example/o/r.git",
    { ghHost: "git.corp.example" }).kind, "github", "$GH_HOST names the GHES install");
  assert.equal(classifyRemote("https://github.corp.example/o/r.git", { ghHost: "" }).kind, "github",
    "a *github* hostname is taken as GitHub Enterprise");
});

// --- the same silence, on the app's surfaces ----------------------------------

test("BLZ-350: the reconcile LOOP announces an unreadable forge, once, not every tick", async () => {
  const { newForgeErrorEvents } = await import("../scripts/supervisor.mjs");
  const seen = new Set();
  const errs = [{ message: "svc is on gitlab.com" }, { message: "web has no origin" }];

  const first = newForgeErrorEvents(errs, seen);
  assert.equal(first.length, 2, "the activity feed must be told, not just the CLI");
  assert.equal(first[0].type, "error");
  assert.equal(first[0].loop, "reconcile");
  assert.match(first[0].message, /gitlab\.com/);

  // The loop runs on a timer and an unsupported forge is permanent — repeating it
  // every tick would bury the feed it is trying to warn through.
  assert.deepEqual(newForgeErrorEvents(errs, seen), [], "a repeat tick must stay quiet");
  assert.equal(newForgeErrorEvents([{ message: "third one" }], seen).length, 1,
    "a NEW forge problem must still get through");
});

test("BLZ-350: /api/reconcile-preview carries the forge outcome, not just the changes", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "blz350-preview-"));
  try {
    const repo = codeRepo(tmp, "svc", "https://gitlab.com/acme/svc.git");
    const root = board(tmp, [repo]);
    const { startServer } = await import("../scripts/serve.mjs");
    const srv = startServer({ root, projectsDir: join(root, "projects"), port: 0 });
    await new Promise((r) => srv.once("listening", r));
    try {
      const { port } = srv.address();
      const j = await (await fetch(`http://127.0.0.1:${port}/api/reconcile-preview`)).json();
      assert.ok(Array.isArray(j.forgeErrors), "the board must be able to show why a preview is thin");
      assert.equal(j.forgeErrors.length, 1);
      assert.match(j.forgeErrors[0].message, /gitlab\.com/);
    } finally {
      srv.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --- BLZ-350 review regression: `gh` resolves its base repo from ANY remote ----
//
// The first cut of this fix classified the `origin` remote alone and
// short-circuited before ever calling `gh`. That re-introduced the exact defect
// this ticket exists to fix, on a different axis: `gh` resolves its base repo
// from any GitHub remote it finds, not just `origin`. A repo whose only GitHub
// remote is named `upstream` — or one with `origin` on GitLab and `upstream` on
// GitHub — reads its PRs perfectly, yet was refused a `gh` call and told, falsely,
// that it had no forge. `in-review` went from reachable to unreachable.
//
// The rule: short-circuit ONLY when EVERY remote is unsupported or hostless. One
// GitHub-or-unknown remote is enough to hand the repo to `gh`.

test("BLZ-350 regression: a GitHub remote named `upstream` still reaches gh", () => {
  const calls = [];
  const run = (cmd) => {
    calls.push(cmd);
    if (cmd === "git") {
      return { ok: true, status: 0, stderr: "",
        stdout: "remote.upstream.url https://github.com/hjr15/blaze.git" };
    }
    return { ok: true, status: 0, stderr: "", stdout: '[{"number":93,"state":"OPEN"}]' };
  };
  const { prs, forgeErrors } = gatherPrs("/repo", { run, ghHost: "" });
  assert.ok(calls.includes("gh"),
    "gh reads a repo by ANY GitHub remote — refusing the call makes in-review unreachable");
  assert.equal(prs.length, 1, "the PRs gh returned must survive");
  assert.deepEqual(forgeErrors, [], "a repo gh can read is not a forge error");
});

test("BLZ-350 regression: origin on GitLab + upstream on GitHub still reaches gh", () => {
  const calls = [];
  const run = (cmd) => {
    calls.push(cmd);
    if (cmd === "git") {
      return { ok: true, status: 0, stderr: "",
        stdout: "remote.origin.url https://gitlab.com/acme/svc.git\n"
              + "remote.upstream.url git@github.com:hjr15/blaze.git" };
    }
    return { ok: true, status: 0, stderr: "", stdout: '[{"number":93,"state":"OPEN"}]' };
  };
  const { prs, forgeErrors } = gatherPrs("/repo", { run, ghHost: "" });
  assert.ok(calls.includes("gh"),
    "one readable remote is enough — origin is not the only remote gh looks at");
  assert.equal(prs.length, 1);
  assert.deepEqual(forgeErrors, []);
});

test("BLZ-350 regression: the short-circuit needs EVERY remote to be unreadable", () => {
  const calls = [];
  const run = (cmd) => {
    calls.push(cmd);
    return { ok: true, status: 0, stderr: "",
      stdout: "remote.origin.url https://gitlab.com/acme/svc.git\n"
            + "remote.mirror.url git@bitbucket.org:acme/svc.git" };
  };
  const { forgeErrors } = gatherPrs("/repo", { run, ghHost: "" });
  assert.deepEqual(calls, ["git"], "all remotes unreadable — no point spending a gh call");
  assert.equal(forgeErrors[0].reason, "unsupported-forge");
  assert.match(forgeErrors[0].message, /gitlab\.com/);
  assert.match(forgeErrors[0].message, /bitbucket\.org/,
    "every unreadable host must be named, not just origin's");
});

test("BLZ-350 regression: the no-remote message asserts nothing false", () => {
  const run = () => ({ ok: false, status: 1, stderr: "", stdout: "" });
  const { forgeErrors } = gatherPrs("/repo", { run, ghHost: "" });
  assert.equal(forgeErrors[0].reason, "no-remote");
  assert.doesNotMatch(forgeErrors[0].message, /origin/,
    "the old wording blamed `origin` specifically, which was false whenever another remote existed");
  assert.match(forgeErrors[0].message, /remote/);
});

test("BLZ-350 regression: end-to-end — reconcile reaches a repo whose GitHub remote is `upstream`", async () => {
  // The live proof, without the network: a real git repo with no `origin` at all.
  // gh is stubbed out via a PATH shim so this stays hermetic.
  const tmp = mkdtempSync(join(tmpdir(), "blz350-upstream-"));
  try {
    const repo = codeRepo(tmp, "svc", null);
    execFileSync("git", ["-C", repo, "remote", "add", "upstream", "https://github.com/hjr15/blaze.git"]);
    const root = board(tmp, [repo]);

    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), '#!/usr/bin/env bash\necho \'[]\'\n');
    execFileSync("chmod", ["+x", join(bin, "gh")]);
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      const r = await reconcile({ root, projectsDir: join(root, "projects"), dryRun: true });
      assert.deepEqual(r.forgeErrors, [],
        "a repo gh can read must not be reported unreadable — that is this ticket's own bug");
    } finally {
      process.env.PATH = prevPath;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("BLZ-350: parseRemoteUrls reads every remote git lists, in order", () => {
  const out = "remote.origin.url https://gitlab.com/acme/svc.git\n"
            + "remote.upstream.url git@github.com:hjr15/blaze.git\n"
            + "remote.fork.url /srv/git/svc.git";
  assert.deepEqual(parseRemoteUrls(out), [
    "https://gitlab.com/acme/svc.git",
    "git@github.com:hjr15/blaze.git",
    "/srv/git/svc.git",
  ]);
  assert.deepEqual(parseRemoteUrls(""), [], "a repo with no remotes yields no urls, not [\"\"]");
  assert.deepEqual(parseRemoteUrls("remote.origin.pushurl x"), [],
    "only .url lines count — .pushurl is not what gh resolves from");
});

test("BLZ-350: an UNCLASSIFIABLE host is handed to gh — GHES lives under arbitrary names", () => {
  // Mutation-driven: making `unknown` non-askable broke no test, so nothing was
  // guarding the GHES path. A self-hosted GitHub Enterprise install is
  // indistinguishable from any other private host by name alone, so `unknown`
  // must behave exactly like `github` here — anything else silently disables PR
  // reading for a working enterprise board.
  const calls = [];
  const run = (cmd) => {
    calls.push(cmd);
    if (cmd === "git") {
      return { ok: true, status: 0, stderr: "", stdout: "remote.origin.url https://git.corp.example/o/r.git" };
    }
    return { ok: true, status: 0, stderr: "", stdout: '[{"number":7,"state":"OPEN"}]' };
  };
  assert.equal(classifyRemote("https://git.corp.example/o/r.git", { ghHost: "" }).kind, "unknown");
  const { prs, forgeErrors } = gatherPrs("/repo", { run, ghHost: "" });
  assert.ok(calls.includes("gh"), "an unknown host must reach gh, not be pre-rejected");
  assert.equal(prs.length, 1);
  assert.deepEqual(forgeErrors, []);
});
