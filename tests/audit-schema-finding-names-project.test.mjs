// tests/audit-schema-finding-names-project.test.mjs — BLZ-416.
//
// `auditCorpus` judges each project's schema layer separately and deliberately does NOT
// deduplicate across projects: "two projects with the same broken block are two things to
// fix". But the two findings it emits for that case carried BYTE-IDENTICAL detail text —
// `project.json: schema.types must be an object …` — with nothing in the sentence saying
// WHICH project.json. The project key travelled only in the `ticket` field, a field named
// for ticket ids, and the plain report prints nothing but a per-kind COUNT.
//
// So an operator on an 11-project board reading `blaze audit --json`, or grouping findings
// by message, or reading any consumer that renders `detail`, is told there is a broken
// project.json and not told whose. The fix is in the SENTENCE, where the reader is.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { auditCorpus } from "../scripts/model/audit.mjs";

const broken = () => ({ schema: { types: "notanobject" } });

describe("BLZ-416: a per-project schema finding names its project in the detail text", () => {
  test("two projects with the SAME broken block get two distinguishable findings", () => {
    const r = auditCorpus({
      tickets: [],
      projects: { ALPHA: { key: "ALPHA", ...broken() }, BETA: { key: "BETA", ...broken() } },
      config: { key: "ALPHA" },
    });
    const details = r.findings.filter((f) => f.kind === "schema-malformed").map((f) => f.detail);
    assert.equal(details.length, 2, JSON.stringify(r.findings));
    assert.equal(new Set(details).size, 2,
      "the two detail texts must differ — identical text is the whole defect");
    assert.ok(details.some((d) => d.includes("ALPHA")), details.join(" | "));
    assert.ok(details.some((d) => d.includes("BETA")), details.join(" | "));
  });

  test("the project.json path is named as a path an operator can open", () => {
    const r = auditCorpus({
      tickets: [], projects: { OBA: { key: "OBA", ...broken() } }, config: { key: "OBA" },
    });
    const hit = r.findings.find((f) => f.kind === "schema-malformed");
    assert.ok(hit);
    assert.match(hit.detail, /projects\/OBA\/project\.json:/,
      "naming the file without its directory is what left the reader guessing");
    assert.match(hit.detail, /schema\.types must be an object/,
      "and the original message must survive intact, not be replaced");
  });

  test("a SOFT per-project finding is attributed the same way", () => {
    // `schema.linkTypes` on a project is inert-by-design and reported soft. Same reader,
    // same question, so the same answer — the fix must not be limited to the hard kind.
    const r = auditCorpus({
      tickets: [],
      projects: { INF: { key: "INF", schema: { linkTypes: [{ name: "Precedes" }] } } },
      config: { key: "INF" },
    });
    const hit = r.findings.find((f) => f.kind === "schema-invalid");
    assert.ok(hit, JSON.stringify(r.findings));
    assert.match(hit.detail, /projects\/INF\/project\.json:/);
  });

  test("a project-layer problem that is NOT about project.json still names the project", () => {
    // A narrowed `requirement` workflow is reported from the merged registry, so its
    // message never mentions a file at all. It is still one project's problem.
    const r = auditCorpus({
      tickets: [],
      projects: {
        NCA: {
          key: "NCA",
          schema: {
            workflows: {
              requirement: {
                statuses: ["proposed", "implemented"], terminal: ["implemented"],
                transitions: [["proposed", "implemented"]],
                resolutionOnTerminal: { implemented: "done" },
              },
            },
          },
        },
      },
      config: { key: "NCA" },
    });
    const hit = r.findings.find((f) => /omits/.test(f.detail ?? ""));
    assert.ok(hit, JSON.stringify(r.findings.map((f) => f.detail)));
    assert.match(hit.detail, /NCA/);
  });

  test("the TOP-LEVEL layer is NOT attributed to a project — it belongs to no one project", () => {
    // The negative side, and the reason this is a decoration at the per-project `add` site
    // rather than a change to the message itself: a `blaze.config.json` problem is the
    // same block for every project, and naming one of them would be a false statement.
    const r = auditCorpus({
      tickets: [], projects: { ALPHA: { key: "ALPHA" } },
      config: { key: "ALPHA", schema: { types: "notanobject" } },
    });
    const hit = r.findings.find((f) => f.kind === "schema-malformed");
    assert.ok(hit);
    assert.equal(hit.ticket, "-");
    assert.match(hit.detail, /^blaze\.config\.json:/);
    assert.doesNotMatch(hit.detail, /ALPHA/);
  });

  test("cross-layer dedup still compares the RAW message, not the decorated one", () => {
    // `blaze.config.json` problems reach BOTH layers (the config is passed to each), and
    // the project layer skips any message the top layer already reported. Decorating
    // before that comparison would break the skip and double every config finding.
    const r = auditCorpus({
      tickets: [], projects: { ALPHA: { key: "ALPHA" }, BETA: { key: "BETA" } },
      config: { key: "ALPHA", schema: { types: "notanobject" } },
    });
    assert.equal(r.findings.filter((f) => f.kind === "schema-malformed").length, 1,
      `the top-level block must be reported ONCE: ${JSON.stringify(r.findings)}`);
  });
});
