// tests/supervisor-docs.test.mjs — BLZ-359 AC 4: the documented surface is the real one.
//
// BLZ-348 published a security claim in docs/architecture.md that was true of `serve.mjs`
// and false of `supervisor.mjs` — the server the DEFAULT command actually runs. A claim
// that holds for one binary and not the one users run is worse than no claim, so the
// supervisor's route table is now a CHECKED artefact rather than prose: the doc's rows
// are parsed and compared to `SUPERVISOR_SCOPES` exactly. A route added, removed, or
// rescoped without the doc following is a red test, not a stale paragraph.
//
// Same shape as tests/schema-versioning-docs.test.mjs (BLZ-356), for the same reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPERVISOR_SCOPES } from "../scripts/supervisor.mjs";

const DOC = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "architecture.md");
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
