// tests/adr-0031-site9-reachability.test.mjs — BLZ-520.
//
// ADR-0031's table said site 9 — `loadProjectSchema`'s `project.json` read — is reached from
// "the audit's schema layer", and its inventory-corrections section said `auditCorpus` "opens
// the same `project.json` a second time". BOTH ARE FALSE, and the same belief had spread to
// three more places: `schema-config.mjs`'s own comment, a comment in
// `tests/read-path-fifo.test.mjs`, and a clause in `scripts/audit-runner.mjs`.
//
// THE DECISION IS NOT REOPENED. The guard on `loadProjectSchema` is right and stays. What was
// wrong is the sentence about WHY that site is reachable — and a wrong reason is worth fixing
// on its own, because it is what the next person reads before deciding whether a line can go.
// On the old story, site 9 was `audit-runner.mjs`'s shadow and deleting it once site 2 was
// guarded would look harmless. It is not: it is the FIRST read of `project.json` on the
// `blaze edit` and `blaze new` paths.
//
// This file pins the corrected claim STRUCTURALLY, so the record cannot drift back without
// something going red. The behavioural half — the revert experiment — is in ADR-0031 §R.5
// with its measurements, and is not re-run here: it requires reverting a guard, and a test
// that reverts production code to prove a point is a test that can leave it reverted.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

/** Source with `//` and block comments removed. EVERY structural assertion below runs on
 *  this rather than on the raw file, and the reason is a defect this very test had in its
 *  first cut: the corrections written by this ticket NAME `loadProjectSchema` and
 *  `project.json` in prose, so matching the raw text made the test fail on its own fix.
 *  Matching a spelling wherever it appears is the same defect BLZ-521 found in the fd guard's
 *  pin — a claim about CODE has to be asserted against code. */
function code(...p) {
  return read(...p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
}

describe("BLZ-520: site 9 is reached from `blaze edit`/`blaze new`, never from the audit", () => {
  test("nothing under the audit calls `loadProjectSchema` — the old claim, refuted in source", () => {
    // Three files are named `audit*.mjs`. All three are checked, by full path, because the
    // wrong claim in the first place came from naming one of them loosely.
    for (const f of [["scripts", "audit-runner.mjs"],
                     ["scripts", "model", "audit.mjs"],
                     ["scripts", "migrate", "audit.mjs"]]) {
      assert.doesNotMatch(code(...f), /\bloadProjectSchema\b/,
        `${f.join("/")} calls loadProjectSchema. ADR-0031 §R.5 says the audit does not — if `
        + "that changed, the ADR's corrected table is now wrong in the other direction and "
        + "must be updated, not this assertion.");
    }
  });

  test("`model/audit.mjs` CANNOT read from disk at all — the mechanism, not the symptom", () => {
    // The strongest available form of "there is no second read": the pure core imports no
    // filesystem at all, so it could not open `project.json` if it wanted to. It receives the
    // already-parsed project from the runner.
    const src = code("scripts", "model", "audit.mjs");
    assert.doesNotMatch(src, /from\s+"node:fs"/,
      "model/audit.mjs now imports node:fs. It is the PURE core — a function of what the "
      + "runner read — and a disk read in here is what would make the old ADR claim true.");
    assert.doesNotMatch(src, /regular-file\.mjs/,
      "model/audit.mjs now takes a read primitive, which is the same change by another route");
    assert.match(src, /resolveSchema\(\{\s*config,\s*project:\s*projects\[/,
      "and it must still resolve each project's schema from the object handed in");
  });

  test("`blaze edit` and `blaze new` DO call it, and before `loadProject`", () => {
    // The ordering is the whole reason the hang lands on these two verbs: this call is the
    // first thing to touch project.json, so a FIFO there stops them before `loadProject`
    // would have refused. Asserted as an ORDER, not as two independent matches.
    for (const f of ["edit.mjs", "new.mjs"]) {
      const src = code("scripts", f);
      const schemaAt = src.indexOf("loadProjectSchema(");
      const projectAt = src.indexOf("loadProject(");
      assert.notEqual(schemaAt, -1, `scripts/${f} no longer calls loadProjectSchema`);
      assert.notEqual(projectAt, -1, `scripts/${f} no longer calls loadProject`);
      assert.ok(schemaAt < projectAt,
        `scripts/${f} now calls loadProject BEFORE loadProjectSchema. ADR-0031 §R.5's `
        + "measurement depends on that order — re-measure it rather than editing this line.");
    }
  });

  test("the paths in the record are paths that EXIST", () => {
    // The work order for this correction named `scripts/model/edit.mjs` and
    // `scripts/model/new.mjs`. Neither exists, and a fix aimed at a file that is not there is
    // how a record stays wrong through a ticket that claims to have fixed it.
    const model = readdirSync(join(ROOT, "scripts", "model"));
    assert.ok(!model.includes("edit.mjs") && !model.includes("new.mjs"),
      "scripts/model/edit.mjs or new.mjs now exists — the ADR names scripts/edit.mjs and "
      + "scripts/new.mjs, and which one is meant has to be settled again");
    for (const f of ["edit.mjs", "new.mjs"]) {
      assert.doesNotThrow(() => read("scripts", f), `scripts/${f} is missing`);
    }
  });

  test("no copy of the refuted claim is left standing uncorrected", () => {
    // It lived in four places at once. Each is allowed to CONTAIN the old words — three of
    // them quote the false sentence in order to correct it — but only alongside the marker
    // that says so, which is what stops a future reader taking the quote at face value.
    for (const f of [["docs", "decisions", "0031-what-a-read-that-refused-to-open-reports-per-site.md"],
                     ["scripts", "model", "schema-config.mjs"],
                     ["tests", "read-path-fifo.test.mjs"],
                     ["scripts", "audit-runner.mjs"]]) {
      const src = read(...f);
      if (/audit's schema layer|schema layer opens the (same )?path|project\.json` ON DISK/.test(src)) {
        assert.match(src, /BLZ-520|§R\.5/,
          `${f.join("/")} still carries the refuted reachability claim with nothing marking `
          + "it as refuted. Correct it or remove the sentence.");
      }
    }
  });
});
