// tests/setup-residuals.test.mjs — BLZ-400 + BLZ-397.
//
// Both are first-run-setup residuals left by BLZ-358's PR (#124), raised by its adversarial
// review and deliberately not fixed there: #124 had already been through six rounds, and
// neither is a hole.
//
//   BLZ-400 — after a failed identity adoption the operator holds an admin account whose
//             credential was never issued. `blaze user add` recovers it; the product never
//             says so. Two guards on that path are also unpinned.
//   BLZ-397 — `ensureSetupTokenIgnored` reports `added` WITHOUT checking the rule took, and
//             accretes a duplicate line every boot on a board whose `.blaze/.gitignore`
//             negates the token.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
         chmodSync, unlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { startServer, CSRF } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { identityDbPath, loadIdentity } from "../scripts/model/identity-db.mjs";
import { setupTokenPath, readSetupToken, ensureSetupTokenIgnored } from "../scripts/model/setup-token.mjs";

function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-residual-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    ["---", "id: OBA-1", "title: t", "type: task", "project: OBA", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return { root, projects };
}

async function boot(opts) {
  const server = startServer({ port: 0, ...opts });
  await new Promise((res) => server.once("listening", res));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const postSetup = (base, body) =>
  fetch(`${base}/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-blaze-csrf": CSRF },
    body: JSON.stringify(body),
  });

/** Capture console.error + raw stderr. Deliberately NOT process.stdout.write — stubbing
 *  that in-process swallows the test runner's own result lines and hides whole suites. */
function captureOutput() {
  const saved = { error: console.error, stderr: process.stderr.write.bind(process.stderr) };
  let text = "";
  console.error = (...a) => { text += a.join(" ") + "\n"; };
  process.stderr.write = (chunk, ...rest) => { text += String(chunk); return true; };
  return {
    get text() { return text; },
    stop() { console.error = saved.error; process.stderr.write = saved.stderr; },
  };
}

/** Does git ignore the setup token on this board? The only question that matters. */
const isIgnoredAt = (root) =>
  spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-q", "--", ".blaze/setup-token"])
    .status === 0;

// =============================================================================
// BLZ-400 — the operator is told how to recover, and every non-healthy state fails closed
// =============================================================================

describe("BLZ-400: a failed adoption names the recovery route", () => {
  // Three ways `loadIdentity` can come back non-healthy after the admin row IS written.
  // The shipped guard is `adopted?.state !== "healthy"`; narrowing it to `=== "broken"`
  // survived every test before this file existed, and would fall OPEN on the other two —
  // serving the whole board unauthenticated, which is the hole BLZ-358 closed.
  const breakers = {
    // unreadable file -> `broken`
    broken: (r) => chmodSync(identityDbPath(r), 0o000),
    // no identity.db at all -> `absent`. `gate()` reads a null store as "loopback, no
    // identity configured" and serves everything.
    absent: (r) => unlinkSync(identityDbPath(r)),
    // SCHEMA INTACT, NO ROWS -> `empty`. The first version of this breaker wrote a
    // ZERO-BYTE file, which is not an empty schema at all: `SELECT count(*) FROM app_user`
    // throws on it, so `loadIdentity` returned `broken` and this case was a byte-for-byte
    // duplicate of the one above it. `empty` — a genuine unauthenticated full-board serve
    // if the guard is narrowed — was pinned by nothing, while the commit message said all
    // three states were driven. Hence the assertion below: every breaker now PROVES which
    // state it produced.
    empty: (r) => {
      const db = new DatabaseSync(identityDbPath(r));
      db.exec("DELETE FROM app_user");
      db.close();
    },
  };

  for (const [state, breakIt] of Object.entries(breakers)) {
    test(`${state}: the board serves nothing, and the diagnostic says how to recover`, async () => {
      const { root, projects } = board();
      const createThenBreak = async (r, opts) => {
        const out = await addUser(r, opts);
        breakIt(r);
        // PROVE the breaker produced the state this test is named for. Without this the
        // `empty` case silently drove `broken` and duplicated its sibling.
        assert.equal(loadIdentity(r)?.state, state,
          `the ${state} breaker must actually produce the ${state} state`);
        return out;
      };
      const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0",
                                           addUser: createThenBreak });
      const cap = captureOutput();
      let res;
      try {
        res = await postSetup(base, { token: readSetupToken(root), email: "a@b.c" });
      } finally { cap.stop(); }
      try {
        assert.equal(res.status, 500, `${state}: a failed adoption is a 500, not a success`);

        // Fail CLOSED — the property the narrowed guard would break.
        const slash = await fetch(`${base}/`);
        assert.notEqual(slash.status, 200,
          `${state}: the board must not be served to an unauthenticated caller`);
        assert.doesNotMatch(await slash.text(), /OBA-1/, `${state}: no ticket content may leak`);

        // AC-1 + AC-2: the diagnostic exists AND names the recovery route.
        assert.match(cap.text, /administrator account was created/, `${state}: diagnosed at all`);
        assert.match(cap.text, /blaze user add/,
          `${state}: the operator holds an account whose credential was never issued — ` +
          "the product must say how to get one");
        assert.match(cap.text, /--role admin/, `${state}: and the whole command, not a hint`);
        assert.doesNotMatch(cap.text, /NOT issued.*[A-Za-z0-9]{32}/,
          `${state}: no credential value may appear`);
      } finally {
        try { chmodSync(identityDbPath(root), 0o600); } catch { /* already gone */ }
        server.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("GET /setup after a failed adoption does not point at a token that is gone", async () => {
    // The token is consumed either way — the admin exists, so a second one must not be
    // creatable — but `setupPending` stays true, so /setup kept serving a page telling the
    // operator to read a file this very request deleted.
    const { root, projects } = board();
    const createThenBreak = async (r, opts) => {
      const out = await addUser(r, opts);
      chmodSync(identityDbPath(r), 0o000);
      return out;
    };
    const { server, base } = await boot({ root, projectsDir: projects, host: "0.0.0.0",
                                         addUser: createThenBreak });
    const cap = captureOutput();
    try {
      await postSetup(base, { token: readSetupToken(root), email: "a@b.c" });
    } finally { cap.stop(); }
    try {
      assert.equal(existsSync(setupTokenPath(root)), false, "the token really is consumed");
      const page = await fetch(`${base}/setup`);
      const html = await page.text();
      assert.doesNotMatch(html, new RegExp(setupTokenPath(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "the page must not send the operator to a file that no longer exists");
      assert.match(html, /blaze user add/i,
        "it should name the route that actually works from here");
    } finally {
      try { chmodSync(identityDbPath(root), 0o600); } catch { /* already gone */ }
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// BLZ-397 — appending a rule is not the same as the path being ignored
// =============================================================================

describe("BLZ-397: ensureSetupTokenIgnored verifies the rule took", () => {
  /** A repo whose `.blaze/.gitignore` NEGATES the token, so a root-level rule loses:
   *  the deeper file outranks it. Contrived — an operator must have written it — but it
   *  is the one shape where "append and report added" is a lie. */
  function negatingBoard() {
    const root = mkdtempSync(join(tmpdir(), "blaze-negate-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", root, "config", "user.name", "t"]);
    mkdirSync(join(root, ".blaze"), { recursive: true });
    writeFileSync(join(root, ".blaze", ".gitignore"), "!setup-token\n");
    return root;
  }

  const rules = (root) => {
    const p = join(root, ".gitignore");
    return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length : 0;
  };
  /** The only question that actually matters: does git ignore the token? The first cut
   *  of this file defined a helper for this, never called it, and had it backwards —
   *  `-q` prints nothing and EXITS 1 when the path is not ignored, so `execFileSync`
   *  throws rather than returning false. Every BLZ-397 test therefore asserted only the
   *  returned state string and the rule count, and a regression that left a live token
   *  committable walked straight past all four of them. */
  const isIgnored = (root) =>
    spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-q", "--", ".blaze/setup-token"])
      .status === 0;

  test("a rule that does not take is reported as such, not as `added`", async () => {
    const root = negatingBoard();
    try {
      const r = ensureSetupTokenIgnored(root);
      assert.equal(isIgnored(root), false,
        "premise check: on this board git genuinely cannot be made to ignore the token");
      assert.notEqual(r.state, "added",
        "`added` claims the path is ignored; a deeper .gitignore outranks the root one");
      assert.equal(r.state, "ineffective",
        `the state must say the rule did not take; got ${JSON.stringify(r.state)}`);
      assert.equal(r.path, ".blaze/setup-token", "and it names the PATH");
      assert.equal(JSON.stringify(r).includes("setup-token\n"), false, "never a value");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("no duplicate rule accretes across boots", async () => {
    // Measured on the shipped code: three boots gave rules=2, 3, 4 with the token
    // committable throughout.
    const root = negatingBoard();
    try {
      ensureSetupTokenIgnored(root);
      const after1 = rules(root);
      ensureSetupTokenIgnored(root);
      ensureSetupTokenIgnored(root);
      assert.equal(rules(root), after1,
        `a rule already present but ineffective must not be appended again; ` +
        `grew from ${after1} to ${rules(root)} across two more boots`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the operator is warned — path only, never the value", async () => {
    const root = negatingBoard();
    writeFileSync(join(root, ".blaze", "setup-token"), "SECRETVALUE123\n");
    const cap = captureOutput();
    try {
      ensureSetupTokenIgnored(root);
    } finally { cap.stop(); }
    try {
      assert.match(cap.text, /setup-token/, "the path is named");
      assert.match(cap.text, /ignore|commit/i, "and what is wrong with it");
      assert.equal(cap.text.includes("SECRETVALUE123"), false,
        "the VALUE never appears, anywhere, ever");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the ordinary board is unchanged — one rule, ignored, reported `added`", async () => {
    // The direction that stops the checks above from being satisfied by refusing everything.
    const root = mkdtempSync(join(tmpdir(), "blaze-plain-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", root, "config", "user.name", "t"]);
    try {
      const r = ensureSetupTokenIgnored(root);
      assert.equal(r.state, "added");
      assert.equal(rules(root), 2, "one comment line plus one rule");
      ensureSetupTokenIgnored(root);
      assert.equal(rules(root), 2, "and a second boot appends nothing — it is already ignored");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("BLZ-397: appending is attempted wherever it can work", () => {
  /** Git resolves within ONE file by LAST MATCHING RULE, so a rule that loses to a later
   *  line in the same file is fixed by appending at the end. The first cut skipped the
   *  append whenever a rule for the path was already present — correct only for the
   *  DEEPER-file case — and review measured four board shapes where the live token was
   *  ignored before that change and committable after it. A regression in the one
   *  direction this function exists to protect, and no test saw it because not one of
   *  them asked git whether the token was ignored. */
  function repo(files) {
    const root = mkdtempSync(join(tmpdir(), "blaze-gi-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", root, "config", "user.name", "t"]);
    mkdirSync(join(root, ".blaze"), { recursive: true });
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
    return root;
  }
  const isIgnored = (root) =>
    spawnSync("git", ["-C", root, "check-ignore", "--no-index", "-q", "--", ".blaze/setup-token"])
      .status === 0;
  const rules = (root) => {
    const p = join(root, ".gitignore");
    return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).length : 0;
  };

  // Same-file negation: the rule IS present and loses to a LATER line. Appending wins.
  for (const [label, gitignore] of Object.entries({
    "an explicit same-file negation": ".blaze/setup-token\n!.blaze/setup-token\n",
    "a broad re-include written for another file": ".blaze/setup-token\n!.blaze/*\n",
    "a wildcard re-include": ".blaze/setup-token\n!.blaze/setup-*\n",
    "CRLF line endings": ".blaze/setup-token\r\n!.blaze/setup-token\r\n",
  })) {
    test(`the token ends up IGNORED despite ${label}`, () => {
      const root = repo({ ".gitignore": gitignore });
      try {
        assert.equal(isIgnored(root), false, "premise: it starts un-ignored");
        const r = ensureSetupTokenIgnored(root);
        assert.equal(isIgnored(root), true,
          "appending at the end is the fix here — git takes the LAST matching rule");
        assert.equal(r.state, "added");
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test("where appending cannot work, the file is left exactly as it was", () => {
    // The accretion BLZ-397 was raised for, closed harder than the ticket asked: the
    // append is undone, so the count does not grow even once.
    const root = repo({ ".blaze/.gitignore": "!setup-token\n" });
    try {
      const before = rules(root);
      const states = [];
      for (let i = 0; i < 3; i += 1) states.push(ensureSetupTokenIgnored(root).state);
      assert.deepEqual(states, ["ineffective", "ineffective", "ineffective"]);
      assert.equal(rules(root), before, "not one line added across three boots");
      assert.equal(isIgnored(root), false, "and it is honest that the token is still exposed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a board with no .gitignore at all does not gain an empty one on failure", () => {
    // The undo must not leave a stray file behind where none existed.
    const root = repo({ ".blaze/.gitignore": "!setup-token\n" });
    try {
      assert.equal(existsSync(join(root, ".gitignore")), false, "premise: none to begin with");
      ensureSetupTokenIgnored(root);
      assert.equal(existsSync(join(root, ".gitignore")), false,
        "an append that did not help is removed, not left as an empty file");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("BLZ-397: the undo restores the operator's file, byte for byte", () => {
  /** EVERY earlier `ineffective` test used a board with NO root .gitignore, so
   *  `existedBefore` was always false and only the `rmSync` branch ever ran. The
   *  `writeFileSync` branch — the one that touches content the operator wrote — was
   *  exercised by nothing, and BLANKING THE WHOLE FILE passed all 2,649 tests. That is how
   *  a utf8 round-trip that silently rewrote non-UTF-8 bytes got in. These boards all have
   *  a root .gitignore. */
  function board(rootGitignore, deeper = "!setup-token\n") {
    const root = mkdtempSync(join(tmpdir(), "blaze-undo-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", root, "config", "user.name", "t"]);
    mkdirSync(join(root, ".blaze"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), rootGitignore);
    writeFileSync(join(root, ".blaze", ".gitignore"), deeper);
    return root;
  }

  test("an ordinary .gitignore comes back unchanged when the append cannot help", () => {
    const root = board("node_modules/\n*.log\n");
    try {
      const before = readFileSync(join(root, ".gitignore"));
      const r = ensureSetupTokenIgnored(root);
      assert.equal(r.state, "ineffective", "premise: this board cannot be fixed from the root");
      assert.deepEqual(readFileSync(join(root, ".gitignore")), before,
        "the operator's file must come back exactly as it was");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("bytes that are not valid UTF-8 survive the round trip", () => {
    // A latin-1 filename in a rule. Read as utf8 and written back, `0xe9` returns as
    // U+FFFD (ef bf bd) — the rule the operator wrote is rewritten, and whatever it
    // covered stops being ignored, by the one function that exists to stop that.
    const raw = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x6c, 0x6f, 0x67, 0x0a]); // café.log\n
    const root = mkdtempSync(join(tmpdir(), "blaze-bytes-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    mkdirSync(join(root, ".blaze"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), raw);
    writeFileSync(join(root, ".blaze", ".gitignore"), "!setup-token\n");
    try {
      ensureSetupTokenIgnored(root);
      const after = readFileSync(join(root, ".gitignore"));
      assert.equal(after.toString("hex"), raw.toString("hex"),
        `non-UTF-8 bytes were rewritten: ${raw.toString("hex")} -> ${after.toString("hex")}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a file with no trailing newline is restored without one", () => {
    const root = board("node_modules/");
    try {
      const before = readFileSync(join(root, ".gitignore"));
      ensureSetupTokenIgnored(root);
      assert.deepEqual(readFileSync(join(root, ".gitignore")), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("...and the append still succeeds where it CAN help, on the same shape", () => {
    // The direction that stops all of the above being satisfied by never writing at all:
    // a root .gitignore present AND fixable means the file must genuinely change.
    const root = board(".blaze/setup-token\n!.blaze/setup-token\n", "");
    try {
      const before = readFileSync(join(root, ".gitignore"));
      const r = ensureSetupTokenIgnored(root);
      assert.equal(r.state, "added");
      assert.notDeepEqual(readFileSync(join(root, ".gitignore")), before,
        "a fixable board must actually gain the rule");
      assert.equal(isIgnoredAt(root), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a read-only .gitignore warns instead of throwing out of the boot check", () => {
    // The append is unconditional now, so a write refusal reaches the caller. `serve.mjs`
    // catches it bare, which would swallow the only warning the operator gets.
    const root = board("node_modules/\n");
    chmodSync(join(root, ".gitignore"), 0o444);
    const cap = captureOutput();
    let r, threw = null;
    try { r = ensureSetupTokenIgnored(root); } catch (e) { threw = e; } finally { cap.stop(); }
    try {
      assert.equal(threw, null, "a boot-time hygiene check must not throw at its caller");
      assert.equal(r.state, "unwritable",
        "and the state names THIS cause — `ineffective` covered three unrelated ones that " +
        "need different operator actions");
      assert.match(cap.text, /could not add/, "and the operator is warned about the write, " +
        "not about a negating rule that is not there");
    } finally {
      try { chmodSync(join(root, ".gitignore"), 0o644); } catch { /* ignore */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a symlink to a REAL file is refused too — git will not read it either", () => {
    // The obvious worry about refusing symlinks is that it gives up where appending would
    // have worked. It would not: GIT ITSELF DOES NOT HONOUR A SYMLINKED .gitignore —
    // `git check-ignore` reports "unable to access" and ignores nothing from it. So writing
    // through the link would have modified the operator's shared file AND left the token
    // committable, while reporting `added`. Refusing is strictly better, and this pins the
    // premise the refusal rests on rather than assuming it.
    const root = mkdtempSync(join(tmpdir(), "blaze-symreal-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    mkdirSync(join(root, ".blaze"), { recursive: true });
    writeFileSync(join(root, "shared-ignore"), "node_modules/\n.blaze/setup-token\n");
    symlinkSync("shared-ignore", join(root, ".gitignore"));
    const cap = captureOutput();
    let r;
    try { r = ensureSetupTokenIgnored(root); } finally { cap.stop(); }
    try {
      assert.equal(isIgnoredAt(root), false,
        "premise: git does not honour a symlinked .gitignore, even one naming the token");
      assert.equal(r.state, "symlink", "so blaze must not claim it added anything");
      assert.equal(readFileSync(join(root, "shared-ignore"), "utf8"),
        "node_modules/\n.blaze/setup-token\n",
        "and must not write into the operator's shared file through the link");
      assert.match(cap.text, /symlink/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a symlinked .gitignore is left alone, and said to be left alone", () => {
    // `existsSync` follows a symlink, so a dangling one read as "absent": the append
    // created the link's TARGET and the undo deleted the LINK, orphaning the file.
    const root = mkdtempSync(join(tmpdir(), "blaze-link-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    mkdirSync(join(root, ".blaze"), { recursive: true });
    symlinkSync(join(root, "nowhere-at-all"), join(root, ".gitignore"));
    const cap = captureOutput();
    let r;
    try { r = ensureSetupTokenIgnored(root); } finally { cap.stop(); }
    try {
      assert.equal(r.state, "symlink");
      assert.equal(existsSync(join(root, "nowhere-at-all")), false,
        "blaze must not create the symlink's target behind the operator's back");
      assert.match(cap.text, /symlink/i, "and must say why it did nothing");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("BLZ-397: a blocked path still untracks a token that is already staged", () => {
  /** THE PART THAT CANNOT WORK MUST NOT SKIP THE PART THAT STILL CAN. An earlier cut
   *  `return`ed from the symlink and write-refusal branches, jumping over the
   *  `git rm --cached -f` untrack step that every prior version always reached, and
   *  hardcoding `wasTracked: false`. `serve.mjs` gates BOTH of its operator warnings on
   *  `wasTracked`, so on a board whose token was already staged the live credential stayed
   *  staged for the next commit and the operator was told nothing at all. */
  function trackedBoard(makeBlocked) {
    const root = mkdtempSync(join(tmpdir(), "blaze-blocked-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", root, "config", "user.name", "t"]);
    mkdirSync(join(root, ".blaze"), { recursive: true });
    writeFileSync(join(root, ".blaze", "setup-token"), "LIVE-TOKEN-VALUE\n");
    execFileSync("git", ["-C", root, "add", "-f", "--", ".blaze/setup-token"]);
    makeBlocked(root);
    return root;
  }
  const staged = (root) =>
    execFileSync("git", ["-C", root, "diff", "--cached", "--name-only"], { encoding: "utf8" });

  for (const [label, makeBlocked] of Object.entries({
    "a symlinked .gitignore": (root) => symlinkSync("shared", join(root, ".gitignore")) ||
      writeFileSync(join(root, "shared"), "node_modules/\n"),
    "an unwritable .gitignore": (root) => {
      writeFileSync(join(root, ".gitignore"), "node_modules/\n");
      writeFileSync(join(root, ".blaze", ".gitignore"), "!setup-token\n");
      chmodSync(join(root, ".gitignore"), 0o444);
    },
  })) {
    test(`${label} still un-stages the token and reports it was tracked`, () => {
      const root = trackedBoard(makeBlocked);
      const cap = captureOutput();
      let r;
      try { r = ensureSetupTokenIgnored(root); } finally { cap.stop(); }
      try {
        assert.match(staged(root), /^$/,
          `${label}: the live credential must be un-staged even when no rule can be added`);
        assert.equal(r.wasTracked, true,
          "and `wasTracked` must be true, or serve.mjs prints neither of its warnings");
        assert.equal(r.untrackOk, true);
        assert.equal(existsSync(join(root, ".blaze", "setup-token")), true,
          "--cached removes it from the INDEX only; the live token on disk stays");
        assert.equal(cap.text.includes("LIVE-TOKEN-VALUE"), false, "never a value");
      } finally {
        try { chmodSync(join(root, ".gitignore"), 0o644); } catch { /* ignore */ }
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("an unreadable .gitignore is not mistaken for an absent one, and is not deleted", () => {
    // lstat and read were wrapped in ONE bare catch, so "present but unreadable" read as
    // "absent" -> `existedBefore` false -> the undo took `rmSync` and DELETED the
    // operator's .gitignore, taking every rule in it with it.
    const root = mkdtempSync(join(tmpdir(), "blaze-unreadable-"));
    execFileSync("git", ["-C", root, "init", "-q"]);
    mkdirSync(join(root, ".blaze"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "node_modules/\nsecrets.env\n");
    writeFileSync(join(root, ".blaze", ".gitignore"), "!setup-token\n");
    chmodSync(join(root, ".gitignore"), 0o200);          // write-only: read denied
    const cap = captureOutput();
    let r;
    try { r = ensureSetupTokenIgnored(root); } finally { cap.stop(); }
    try {
      assert.equal(existsSync(join(root, ".gitignore")), true,
        "the operator's .gitignore must not be deleted — every rule in it would go with it");
      assert.equal(r.state, "unreadable",
        "and the state must name THIS cause, not be lumped in with a negating rule");
      assert.match(cap.text, /could not read/,
        "and the operator must be told — this board's token is committable and nothing else says so");
      chmodSync(join(root, ".gitignore"), 0o644);
      assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "node_modules/\nsecrets.env\n",
        "and must come back exactly as it was");
    } finally {
      try { chmodSync(join(root, ".gitignore"), 0o644); } catch { /* ignore */ }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
