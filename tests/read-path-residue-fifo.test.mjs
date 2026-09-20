// tests/read-path-residue-fifo.test.mjs — BLZ-512, the read-path RESIDUE.
//
// BLZ-493 guarded the ten `readFileSync` sites on the SHARED read path (`blaze audit`,
// `buildIndex`, id resolution, the board view, `reconcile`, the long-lived server) and
// recorded the rest as "twenty-odd outside the shared path", raised as their own ticket.
// This file is that ticket's evidence.
//
// THE INVENTORY WAS RE-DERIVED, NOT TRUSTED. Every case below was reproduced as a HANG at
// `44b797f` before a line of the fix was written, under a 6-second child-process cap
// (`timeout -s KILL`), and each produced `EXIT=137` — the child had to be killed. Three of
// the work order's own claims were checked against HEAD and one of them was already stale:
//
//   * `scripts/commit-lock.mjs`'s `readOwner` IS a real site and was missing from BLZ-493's
//     inventory entirely — the ELEVENTH. Reproduced: `acquireLock` on a contended
//     `.blaze/commit.lock/` whose `owner.json` is a FIFO never returns.
//   * `scripts/pending-ledger.mjs` IS ALREADY GUARDED at HEAD. It imports
//     `readRegularFileSync`/`writeRegularFileSync`/`appendRegularFileSync` and has no bare
//     `readFileSync` left. The correction the ticket carries was true when it was filed and
//     is not true now; nothing is changed there, and ADR-0031's table says so.
//   * `scripts/model/setup-token.mjs` IS reachable PRE-AUTH, from `serve.mjs`'s `POST
//     /setup` — the single highest-priority site here, because a hang on it is reachable by
//     an unauthenticated caller and wedges the one route that makes the install usable.
//
// EVERY CASE RUNS OUT OF PROCESS, and that is load-bearing. `node:test`'s `timeout` option
// is enforced on the EVENT LOOP, and a blocking synchronous `readFileSync` never yields to
// it — an in-process case for this shape does not fail, it WEDGES THE WHOLE FILE. So the
// hang is detected the only way it can be: a child process with a hard wall-clock limit and
// an assertion on the child's `signal`. A killed child IS the hang.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

const SCRIPTS = join(import.meta.dirname, "..", "scripts");
const mod = (...p) => JSON.stringify(join(SCRIPTS, ...p));
const CHILD_MS = 15000;

const fifo = (p) => execFileSync("mkfifo", [p]);

function tmp() {
  return mkdtempSync(join(tmpdir(), "blz512-"));
}

/** A minimal board: enough for `loadConfig` and `buildIndex` to answer. */
function board(root) {
  const projects = join(root, "projects");
  mkdirSync(join(projects, "BLZ", "backlog"), { recursive: true });
  writeFileSync(join(projects, "BLZ", "project.json"), JSON.stringify({ key: "BLZ", codeRepos: [] }));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "BLZ", projects: ["BLZ"] }));
  mkdirSync(join(root, ".blaze"), { recursive: true });
  return projects;
}

/** Run `source` in a child node process under a hard wall-clock limit. A child that had to
 *  be KILLED is the hang itself — the one outcome this whole file exists to turn into a
 *  failure, because nothing else can observe it. */
function child(dir, source, { ms = CHILD_MS, cwd = dir } = {}) {
  const script = join(dir, `probe-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(script, source);
  const res = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: ms, cwd });
  assert.equal(res.signal, null,
    `the child had to be KILLED after ${ms}ms — THAT IS THE HANG, not a failed assertion. ` +
    "A synchronous read on this path opened a FIFO and blocked forever: no error, no " +
    `timeout, no exit.\nstdout so far: ${res.stdout}\nstderr so far: ${res.stderr}`);
  return res;
}

/** Run a repo script in a child process under the same limit. */
function childScript(dir, script, args, { ms = CHILD_MS, env = {} } = {}) {
  const res = spawnSync(process.execPath, [join(SCRIPTS, script), ...args],
    { encoding: "utf8", timeout: ms, cwd: dir, env: { ...process.env, ...env } });
  assert.equal(res.signal, null,
    `${script} had to be KILLED after ${ms}ms — THAT IS THE HANG. A CLI that never exits ` +
    "reports nothing at all, which is strictly worse than any wrong sentence.");
  return res;
}

/** The shape every REFUSING site must produce: a named throw, not a silent default. */
function assertRefusal(out, path) {
  assert.match(out, /REFUSED/,
    "the site must REFUSE a non-regular file, not fall back to a default — a default here " +
    "is exactly the silent drop BLZ-470 exists to close. Got: " + out);
  assert.match(out, /ERR_BLAZE_NOT_A_REGULAR_FILE/,
    "the refusal must carry the named code, so a caller can tell it from ENOENT");
  assert.ok(out.includes(path), `the refusal must NAME the path it would not read; got: ${out}`);
  assert.match(out, /FIFO/, `the refusal must say WHAT it found; got: ${out}`);
}

// =============================================================================
// THE PRE-AUTH SURFACE. Highest priority in the whole ticket: `readSetupToken` is
// reached from `serve.mjs`'s `POST /setup`, BEFORE any credential is checked.
// =============================================================================

describe("BLZ-512: the setup token is the pre-auth surface, and it must not hang", () => {
  test("readSetupToken REFUSES a FIFO setup-token instead of blocking forever", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, ".blaze"), { recursive: true });
      const token = join(dir, ".blaze", "setup-token");
      fifo(token);
      const res = child(dir, `
        import { readSetupToken } from ${mod("model", "setup-token.mjs")};
        try { console.log("RETURNED", JSON.stringify(readSetupToken(${JSON.stringify(dir)}))); }
        catch (e) { console.log("REFUSED", e.code, e.message); }
      `);
      assertRefusal(res.stdout, token);
      assert.doesNotMatch(res.stdout, /RETURNED/,
        "a token file that could not be READ must not come back as `null`, which is this " +
        "function's word for `there is no token on disk`. Those are different facts, and " +
        "only one of them is an answer.");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the refusal names the token's PATH and never carries a token VALUE", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, ".blaze"), { recursive: true });
      const token = join(dir, ".blaze", "setup-token");
      fifo(token);
      const res = child(dir, `
        import { readSetupToken } from ${mod("model", "setup-token.mjs")};
        try { readSetupToken(${JSON.stringify(dir)}); }
        catch (e) { console.log("REFUSED", e.message); }
      `);
      assert.ok(res.stdout.includes(token), "the PATH is the thing the operator needs");
      assert.doesNotMatch(res.stdout + res.stderr, /blz_setup_/,
        "the token's VALUE must never be logged, anywhere, ever — and a refusal message is " +
        "somewhere. (Nothing was read here, so a prefix in the output could only come from " +
        "the module leaking one.)");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("ensureSetupTokenIgnored REPORTS a non-regular .gitignore instead of blocking in append", () => {
    const dir = tmp();
    try {
      execFileSync("git", ["init", "-q", dir]);
      const gi = join(dir, ".gitignore");
      fifo(gi);
      const res = child(dir, `
        import { ensureSetupTokenIgnored } from ${mod("model", "setup-token.mjs")};
        console.log("STATE", JSON.stringify(ensureSetupTokenIgnored(${JSON.stringify(dir)})));
      `);
      // It is the APPEND that hangs here, not the read: `lstatSync` already gates the read
      // on `isFile()`, so a FIFO reaches `appendFileSync` with `before === null`. A
      // `try/catch` around a blocking call catches nothing.
      assert.match(res.stdout, /"state":"not-a-regular-file"/,
        "the state must NAME what stopped it. `added` would be a claim that a live " +
        "credential is now git-ignored, made by a run that wrote no rule.");
      assert.match(res.stderr, /WARNING/,
        "and the operator must be TOLD — a silent skip here leaves a live credential " +
        "committable with nothing on stderr.");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// =============================================================================
// The ELEVENTH site — missing from BLZ-493's inventory altogether.
// =============================================================================

describe("BLZ-512: commit-lock's readOwner is the site the inventory missed", () => {
  test("acquireLock REFUSES a FIFO owner.json instead of blocking forever", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, ".blaze", "commit.lock"), { recursive: true });
      const owner = join(dir, ".blaze", "commit.lock", "owner.json");
      fifo(owner);
      const res = child(dir, `
        import { acquireLock } from ${mod("commit-lock.mjs")};
        try { console.log("RETURNED", JSON.stringify(acquireLock(${JSON.stringify(dir)}, { retries: 0, delayMs: 1 }))); }
        catch (e) { console.log("REFUSED", e.code, e.message); }
      `);
      assertRefusal(res.stdout, owner);
      assert.doesNotMatch(res.stdout, /RETURNED/,
        "`readOwner` returning null means `an acquirer between mkdir and write` — a " +
        "sentence about another process, produced by a run that never read the file. " +
        "After OWNERLESS_GRACE_MS that sentence STEALS the lock.");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// =============================================================================
// The groomer loop.
// =============================================================================

describe("BLZ-512: the groomer's reads", () => {
  test("loadState REFUSES a FIFO .blaze/state.json instead of reporting an ungroomed board", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, ".blaze"), { recursive: true });
      const p = join(dir, ".blaze", "state.json");
      fifo(p);
      const res = child(dir, `
        import { loadState } from ${mod("loops", "groomer.mjs")};
        try { console.log("RETURNED", JSON.stringify(loadState(${JSON.stringify(dir)}))); }
        catch (e) { console.log("REFUSED", e.code, e.message); }
      `);
      assertRefusal(res.stdout, p);
      assert.doesNotMatch(res.stdout, /RETURNED/,
        "`{ groomed: {} }` is `this board has never been groomed` — which sends the agent " +
        "over every ticket again. A run that could not read the state must not say it.");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("selectNextTicket REFUSES a FIFO ticket .md instead of blocking the whole loop", () => {
    const dir = tmp();
    try {
      board(dir);
      const t = join(dir, "projects", "BLZ", "backlog", "BLZ-1-t.md");
      fifo(t);
      const res = child(dir, `
        import { selectNextTicket } from ${mod("loops", "groomer.mjs")};
        import { loadConfig } from ${mod("config.mjs")};
        const cfg = loadConfig({ root: ${JSON.stringify(dir)} });
        try { console.log("RETURNED", JSON.stringify(selectNextTicket(${JSON.stringify(dir)}, cfg, { groomed: {} }))); }
        catch (e) { console.log("REFUSED", e.code, e.message); }
      `);
      assertRefusal(res.stdout, t);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the groomer CLI REFUSES a FIFO AGENTS.md rather than grooming with no rules", () => {
    const dir = tmp();
    try {
      board(dir);
      fifo(join(dir, "AGENTS.md"));
      const res = childScript(dir, join("loops", "groomer.mjs"), [],
        { env: { BLAZE_DATA_DIR: dir, BLAZE_PROJECTS_DIR: join(dir, "projects") } });
      assert.match(res.stderr, /ERR_BLAZE_NOT_A_REGULAR_FILE|not a regular file/,
        "an AGENTS.md that could not be read must not arrive at `buildPrompt` as the empty " +
        `string, which is the grooming rules of a board that declares none. Got: ${res.stderr}`);
      assert.notEqual(res.status, 0, "and the run must not report success");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// =============================================================================
// The write-port soak instruments and `blaze db status`.
// =============================================================================

describe("BLZ-512: the soak instruments", () => {
  test("readSoakState REFUSES a FIFO soak log instead of blocking `blaze db status`", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, ".blaze"), { recursive: true });
      const p = join(dir, ".blaze", "soak-ops.jsonl");
      fifo(p);
      const res = child(dir, `
        import { readSoakState } from ${mod("model", "write-port-resolve.mjs")};
        try { console.log("RETURNED", JSON.stringify(readSoakState(${JSON.stringify(dir)}))); }
        catch (e) { console.log("REFUSED", e.code, e.message); }
      `);
      assertRefusal(res.stdout, p);
      assert.doesNotMatch(res.stdout, /RETURNED/,
        "`null` here prints `operations 0 — nothing has been written through the dual " +
        "port yet`, which is the soak's DENOMINATOR asserted by a run that never read it.");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // `recordSoakOp` / `logDivergence`'s APPENDS are a NAMED RESIDUAL, not an oversight and
  // not a passing case dressed up as one. `appendFileSync` on a FIFO with no reader blocks
  // in `open(2)` exactly as the read above did — reproduced at `44b797f`, `EXIT=137` under
  // a 6s cap — and the one-import fix (`appendRegularFileSync`) cannot land without editing
  // `tests/model/seam-closure.test.mjs`, whose narrow exemption for this module names
  // `appendFileSync` by hand and which is owned by another lane (BLZ-642). No test is
  // written here that would pass over an unfixed hang; ADR-0031 carries the residual.
});

// =============================================================================
// The migrator.
// =============================================================================

describe("BLZ-512: the migrator's cache read", () => {
  test("readRawCache REFUSES a FIFO cache file instead of blocking `blaze migrate`", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, "cache"), { recursive: true });
      const p = join(dir, "cache", "ABC.json");
      fifo(p);
      const res = child(dir, `
        import { readRawCache } from ${mod("migrate", "jira-client.mjs")};
        try { console.log("RETURNED", readRawCache(${JSON.stringify(join(dir, "cache"))}, "ABC").length); }
        catch (e) { console.log("REFUSED", e.code, e.message); }
      `);
      assertRefusal(res.stdout, p);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// =============================================================================
// The two `.gitignore` hygiene writers. Both READ and then APPEND, and the append
// blocks on a FIFO exactly as the read does.
// =============================================================================

describe("BLZ-512: the .gitignore hygiene writers report rather than hang", () => {
  test("both hygiene checks bound `git` by the SAME ceiling", () => {
    // The two constants are deliberately separate definitions — `model/setup-token.mjs` is
    // a `"*"` member of the LOCAL write seam, so importing anything from it into
    // `user-admin.mjs` reads as taking a write primitive off the seam and reddens
    // `seam-closure.test.mjs` (a file this lane does not own). This is the drift guard that
    // buys back what a single definition would have given: two boot-time checks over the
    // SAME file must not end up with two different ideas of how long `git` may wedge them.
    // Read from SOURCE rather than imported, because neither constant is exported: every
    // export of a write-seam module is classified one-by-one by `seam-closure.test.mjs`,
    // and adding one there is a change to a file this lane does not own.
    const at = (f) => {
      const src = readFileSync(join(import.meta.dirname, "..", "scripts", "model", f), "utf8");
      const m = /^const GIT_TIMEOUT_MS = (.+);$/m.exec(src);
      assert.ok(m, `no GIT_TIMEOUT_MS found in ${f} — it was renamed, moved or exported`);
      return m[1];
    };
    assert.equal(at("user-admin.mjs"), at("setup-token.mjs"),
      "setup-token.mjs and user-admin.mjs bound their `git` spawns by different amounts");
  });

  test("ensureIdentityIgnored REPORTS a non-regular .gitignore instead of claiming `added`", () => {
    const dir = tmp();
    try {
      execFileSync("git", ["init", "-q", dir]);
      fifo(join(dir, ".gitignore"));
      const res = child(dir, `
        import { ensureIdentityIgnored } from ${mod("model", "user-admin.mjs")};
        console.log("STATE", JSON.stringify(ensureIdentityIgnored(${JSON.stringify(dir)})));
      `);
      assert.match(res.stdout, /"state":"not-a-regular-file"/,
        "`added` is the claim that `.blaze/` is now ignored. A run that wrote no rule must " +
        `not make it — an identity.db one \`git add -A\` from a commit is the whole point. Got: ${res.stdout}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("`blaze init` REPORTS a non-regular .gitignore instead of hanging the wizard", () => {
    const dir = tmp();
    try {
      const boardDir = join(dir, "board");
      mkdirSync(boardDir, { recursive: true });
      fifo(join(boardDir, ".gitignore"));
      const res = child(dir, `
        import { runInit } from ${mod("init-runner.mjs")};
        const code = await runInit(["--yes", "--dir=${boardDir}", "--project=BLZ"],
          { isTTY: false, log: () => {}, err: (...a) => console.log("ERR", ...a), cwd: ${JSON.stringify(boardDir)} });
        console.log("EXIT", code);
      `);
      assert.match(res.stdout, /EXIT/,
        "the wizard must RETURN. A board half-created and a terminal that never comes back " +
        "is the worst outcome of the three.");
      assert.match(res.stdout, /not a regular file/,
        "and it must say that `.blaze/` was NOT ignored — ADR-0012 puts the connection " +
        `details there BECAUSE .blaze/ is untracked. Got: ${res.stdout}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
