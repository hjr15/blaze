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
         chmodSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startServer, CSRF } from "../scripts/serve.mjs";
import { addUser } from "../scripts/model/user-admin.mjs";
import { identityDbPath } from "../scripts/model/identity-db.mjs";
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
    // present but carrying no users -> `empty`, same fall-open shape as `absent`.
    empty: (r) => { unlinkSync(identityDbPath(r)); writeFileSync(identityDbPath(r), ""); },
  };

  for (const [state, breakIt] of Object.entries(breakers)) {
    test(`${state}: the board serves nothing, and the diagnostic says how to recover`, async () => {
      const { root, projects } = board();
      const createThenBreak = async (r, opts) => {
        const out = await addUser(r, opts);
        breakIt(r);
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
  const ignored = (root) =>
    execFileSync("git", ["-C", root, "check-ignore", "--no-index", "-q", "--", ".blaze/setup-token"],
      { encoding: "utf8", stdio: "pipe" }) === "" ;

  test("a rule that does not take is reported as such, not as `added`", async () => {
    const root = negatingBoard();
    try {
      const r = ensureSetupTokenIgnored(root);
      assert.notEqual(r.state, "added",
        "`added` claims the path is ignored; a deeper .gitignore outranks the root one");
      assert.match(r.state, /ineffective|not-ignored|failed/,
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
