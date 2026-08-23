// tests/supervisor-surface.test.mjs — BLZ-359: the supervisor's HTTP surface, pinned
// three ways — what the code routes, what SUPERVISOR_SCOPES declares, and what
// docs/architecture.md documents. All three must agree or one of them is a lie.
//
// BLZ-348 published a security claim in docs/architecture.md that was true of `serve.mjs`
// and false of `supervisor.mjs` — the server the DEFAULT command actually runs. A claim
// that holds for one binary and not the one users run is worse than no claim, so the
// supervisor's route table is now a CHECKED artefact rather than prose: the doc's rows
// are parsed and compared to `SUPERVISOR_SCOPES` exactly. A route added, removed, or
// rescoped without the doc following is a red test, not a stale paragraph.
//
// Same shape as tests/schema-versioning-docs.test.mjs (BLZ-356), for the same reason.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPERVISOR_SCOPES, supervisorScopeFor } from "../scripts/supervisor.mjs";
import { pageScopeFor } from "../scripts/model/serve-auth.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = join(HERE, "..", "docs", "architecture.md");
const SRC = readFileSync(join(HERE, "..", "scripts", "supervisor.mjs"), "utf8");
const RUNNER = readFileSync(join(HERE, "..", "scripts", "user-runner.mjs"), "utf8");
const COMMANDS = join(HERE, "..", "docs", "guide", "commands.md");
const MARKER = "plus these of its own:";

/** `/control/{a,b}/{c,d}` -> every concrete path it stands for, in written order. */
function expandBraces(route) {
  const m = /\{([^}]*)\}/.exec(route);
  if (!m) return [route];
  return m[1].split(",").flatMap((alt) =>
    expandBraces(route.slice(0, m.index) + alt.trim() + route.slice(m.index + m[0].length)));
}

/** The `{ "METHOD /path": scope }` map the supervisor's own table in the doc declares. */
function documentedScopes(text) {
  const at = text.indexOf(MARKER);
  assert.notEqual(at, -1, `docs/architecture.md must still introduce the table with "${MARKER}"`);
  const out = {};
  for (const line of text.slice(at).split("\n").slice(1)) {
    if (!line.startsWith("|")) { if (Object.keys(out).length) break; else continue; }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    const [method, route, scope] = cells;
    if (!/^(GET|POST|PUT|DELETE|PATCH)$/.test(method)) continue;      // header / catch-all rows
    if (!/^`(read|write|admin)`$/.test(scope)) continue;
    for (const p of expandBraces(route.replace(/`/g, ""))) out[`${method} ${p}`] = scope.replace(/`/g, "");
  }
  return out;
}

test("BLZ-359: the doc's supervisor route table is exactly SUPERVISOR_SCOPES", () => {
  const documented = documentedScopes(readFileSync(DOC, "utf8"));
  assert.deepEqual(documented, SUPERVISOR_SCOPES,
    "docs/architecture.md and scripts/supervisor.mjs disagree about which supervisor route "
    + "needs which scope");
});

test("BLZ-359: the brace shorthand in the table expands, so the pin is not vacuous", () => {
  // If expandBraces silently returned the literal string, the assertion above would be
  // comparing two things that both said "{reconcile,groomer}" and proving nothing.
  assert.deepEqual(expandBraces("/control/{a,b}/{c,d}"),
    ["/control/a/c", "/control/a/d", "/control/b/c", "/control/b/d"]);
  const documented = documentedScopes(readFileSync(DOC, "utf8"));
  assert.equal(Object.keys(documented).some((k) => k.includes("{")), false);
});

test("BLZ-359: the stale BLZ-348 caveat — 'imports neither gate nor checkBindSafety' — is gone", () => {
  // The sentence this ticket exists to falsify. It was accurate when written; leaving it
  // in place after the fix would be the same defect pointed the other way.
  const text = readFileSync(DOC, "utf8");
  assert.doesNotMatch(text, /imports\s+neither `gate` nor `checkBindSafety`/);
});

describe("BLZ-359 (W3): every path the file ROUTES on is a path the gate classifies", () => {
  // The docs pin above compares the doc to the constant. Nothing compared the constant to
  // the CODE — and the fail-closed 404 only covers the `/api/*` and `/control/*` prefixes,
  // so a handler at a new top-level path (`POST /webhook`) would skip the gate entirely
  // with every existing test still green. `/events` is the precedent: the one route
  // outside those prefixes, which had to be classified by hand.

  /** The literal prefix of a routing regex, and whether it stops at a metacharacter. */
  function literalPrefix(source) {
    const body = source.replace(/^\//, "").replace(/\/[gimsuy]*$/, "").replace(/^\^/, "");
    let out = "", i = 0;
    for (; i < body.length; i++) {
      const c = body[i];
      if (c === "\\") { out += body[++i] ?? ""; continue; }
      if ("([{|+*?$.".includes(c)) break;
      out += c;
    }
    return { prefix: out, variable: i < body.length };
  }

  /** Every path this file routes on: each literal, and a probe path for each pattern. */
  function routedPaths(src) {
    const out = new Set();
    for (const m of src.matchAll(/u\.pathname\s*===\s*"([^"]*)"/g)) out.add(m[1]);
    for (const m of src.matchAll(/u\.pathname\.startsWith\("([^"]*)"\)/g)) out.add(`${m[1]}x`);
    for (const m of src.matchAll(/u\.pathname\.match\((\/.*?\/)\)/g)) {
      const { prefix, variable } = literalPrefix(m[1]);
      out.add(variable ? `${prefix}x` : prefix);
    }
    return [...out];
  }

  /** Would the gate above decide this path, rather than let it through unclassified? */
  const classified = (path) =>
    path.startsWith("/api/") || path.startsWith("/control/")
    || Boolean(supervisorScopeFor("GET", path)) || Boolean(supervisorScopeFor("POST", path))
    || Boolean(pageScopeFor("GET", path));

  test("the scanner actually finds this file's routes", () => {
    // Anti-vacuity: an empty or broken scan would make the assertion below pass forever.
    const found = routedPaths(SRC);
    for (const expected of ["/api/hash", "/api/sync", "/events", "/", "/control/revert",
                            "/view/x", "/control/x"]) {
      assert.ok(found.includes(expected), `the scan missed ${expected}: ${JSON.stringify(found)}`);
    }
  });

  test("and it discriminates — an unclassified path is reported unclassified", () => {
    assert.equal(classified("/webhook"), false);
    assert.equal(classified("/metrics"), false);
    assert.equal(classified("/events"), true);
  });

  test("every routed path is classified", () => {
    for (const path of routedPaths(SRC)) {
      assert.ok(classified(path),
        `supervisor.mjs routes ${path}, which no scope table classifies — it would skip `
        + "the gate. Add it to SUPERVISOR_SCOPES (or serve it under /api/ or /control/).");
    }
  });

  test("routing never reads req.url directly, which would make the scan blind", () => {
    // The gate and the dispatcher both read `u.pathname` from ONE `new URL()`, which is
    // why no path-normalisation trick separates them. A handler that went back to the raw
    // `req.url` would reopen that gap AND hide itself from the scan above.
    assert.doesNotMatch(SRC, /req\.url\s*===/, "route on u.pathname, not req.url");
    assert.doesNotMatch(SRC, /req\.url\.(match|startsWith)/, "route on u.pathname, not req.url");
  });
});

describe("BLZ-359 (W2): the roster is read once at boot, and the operator is told", () => {
  // Both servers snapshot loadIdentity() at boot (serve.mjs:startServer, supervisor.mjs:
  // createApp), so `blaze user add` against an ALREADY-RUNNING board does not turn
  // authentication on for that process. Pre-existing and symmetric across both servers —
  // but this ticket is the one that broadened the docs claim to cover the daemon, and the
  // claim was "creating the first identity turns authentication on" with no qualifier.
  test("`blaze user add` says a running server must be restarted", () => {
    assert.match(RUNNER, /ALREADY RUNNING does not pick this up/,
      "the moment the operator believes they turned auth on is the moment to say it");
    assert.match(RUNNER, /Restart `blaze board` \/ `blaze start`/);
  });

  test("both docs carry the caveat beside the claim", () => {
    assert.match(readFileSync(DOC, "utf8"), /read the roster once, at boot/i);
    assert.match(readFileSync(COMMANDS, "utf8"), /already running does not pick it up/i);
  });
});
