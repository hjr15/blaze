// tests/import-shared-rule.test.mjs — BLZ-633's own test, design §4.5:
//
//     "BLZ-588's 'literally the same code path' criterion is met
//      STRUCTURALLY: there is one `planImport(rows, board, opts)` and two
//      readers that produce `rows`. A test asserts the property by adding a
//      rule once and observing both front ends enforce it."
//
// THE POINT IS NOT THAT BOTH REFUSE. It is that both refuse with the IDENTICAL
// MESSAGE, because the message is authored in exactly one place
// (`scripts/model/import-plan.mjs` — the echo rule is implemented there "and
// nowhere else", in that file's own words). A markdown reader that validated
// anything itself would have to word its refusal itself, and the word-for-word
// comparison below is what makes that impossible to do unnoticed.
//
// EIGHT RULES, spanning every kind of rule the planner has: the per-row enum
// checks, the per-TYPE enum check whose legal set is a function of another
// cell, a membership check on a value that passed its shape check, the
// pair-list target check, the whole-file forward-reference check, the
// spreadsheet-formula predicate §2.5 requires both sides to share, and — the
// literal reading of "a rule added once" — a taxonomy rule that exists only on
// the BOARD, in one `project.json`, with neither reader knowing anything about
// it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { writeCsv } from "../scripts/model/csv.mjs";
import { parseCanonicalCsv, planImport } from "../scripts/model/import-plan.mjs";
import { readMarkdownRows } from "../scripts/model/import-markdown.mjs";
import { serializeTicket } from "../scripts/model/ticket.mjs";
import { TYPES, PRIORITIES } from "../scripts/model/schema.mjs";
import { statusesFor, RESOLUTIONS } from "../scripts/model/workflows.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(REPO, "scripts", "cli.mjs");

/**
 * The one board both readers are judged against. `projectFor` is the rule
 * "added once": BLZ declares a two-member `labels` taxonomy and nothing else
 * in this file mentions it.
 */
function board() {
  return {
    byId: new Map(),
    types: TYPES, typesFor: () => TYPES,
    statusesFor, priorities: PRIORITIES, resolutions: RESOLUTIONS,
    sprintIds: new Set(),
    projectFor: (key) => (key === "BLZ" ? { labels: ["alpha", "beta"], components: [] } : null),
  };
}

/** A well-formed ticket, as FRONTMATTER. Each case below perturbs one field. */
function baseFrontmatter() {
  return { id: "BLZ-1", title: "t", type: "task", project: "BLZ", estimate: 30 };
}

/** The same ticket, as the 31 canonical CELLS. `cellsFor` below derives the
 *  perturbed version from the perturbed frontmatter, so the two media can
 *  never drift apart WITHIN a case — which would make a passing comparison
 *  meaningless. */
function cellsFor(frontmatter, { status, body }) {
  const cells = {
    schema_version: "1", status, description: body,
    ...Object.fromEntries(Object.entries(frontmatter).map(([k, v]) => [k, encodeCell(k, v)])),
  };
  return COLUMN_NAMES.map((n) => cells[n] ?? "");
}

function encodeCell(key, v) {
  if (Array.isArray(v)) {
    if (key === "links") return v.map((p) => `${p.type}:${p.target}`).join(";");
    if (key === "worklog") return JSON.stringify(v);
    return v.join(";");
  }
  return String(v);
}

function tmpDir(t, tag) {
  const d = mkdtempSync(join(tmpdir(), `blaze-shared-rule-${tag}-`));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** The CSV front end: one row, through `parseCanonicalCsv` → `planImport`. */
function csvRefusals(t, { frontmatter, status, body }) {
  const dir = tmpDir(t, "csv");
  const p = join(dir, "in.csv");
  writeFileSync(p, writeCsv([COLUMN_NAMES.slice(), cellsFor(frontmatter, { status, body })]));
  const parsed = parseCanonicalCsv(writeCsv([COLUMN_NAMES.slice(),
    cellsFor(frontmatter, { status, body })]));
  assert.equal(parsed.ok, true,
    `the CSV must be WELL-FORMED — this suite is about data refusals (exit 1), not format `
    + `refusals: ${(parsed.errors ?? []).join(" / ")}`);
  const plan = planImport(parsed.rows, board(), {});
  return { plan, path: p };
}

/** The MARKDOWN front end: the same ticket as one document, through
 *  `readMarkdownRows` → the SAME `planImport`. */
function markdownRefusals(t, { frontmatter, status, body }) {
  const dir = tmpDir(t, "md");
  mkdirSync(join(dir, status), { recursive: true });
  writeFileSync(join(dir, status, "a.md"), serializeTicket({ frontmatter, body }));
  const read = readMarkdownRows([dir]);
  assert.equal(read.ok, true,
    `the markdown must be READABLE — same reason: ${(read.errors ?? []).join(" / ")}`);
  const plan = planImport(read.rows, board(), {});
  return { plan, path: dir };
}

const CASES = [
  {
    name: "`type` outside the resolved registry",
    perturb: (fm) => ({ ...fm, type: "wibble" }),
  },
  {
    name: "`status` outside the type's own workflow — a legal set that is a function of `type`",
    status: "shipped",
  },
  {
    name: "`priority` outside the registry — refused, never coerced",
    perturb: (fm) => ({ ...fm, priority: "URGENT!!" }),
  },
  {
    name: "`estimate` not a multiple of 5 — a membership check on a value that PASSED its shape check",
    perturb: (fm) => ({ ...fm, estimate: 37 }),
  },
  {
    name: "a `links` target that is not an id",
    perturb: (fm) => ({ ...fm, links: [{ type: "Blocks", target: "notanid" }] }),
  },
  {
    name: "a `parent` in neither the file nor the board — the whole-file reference check",
    perturb: (fm) => ({ ...fm, parent: "BLZ-9999" }),
  },
  {
    name: "a spreadsheet-formula hazard — §2.5's one predicate, on both sides",
    perturb: (fm) => ({ ...fm, assignee: "=SUM(A1:A9)" }),
  },
  {
    name: "a `labels` value outside the taxonomy ONE project.json declares — the rule added once",
    perturb: (fm) => ({ ...fm, labels: ["gamma"] }),
  },
];

describe("BLZ-633: a validation rule added once is enforced by BOTH readers", () => {
  for (const c of CASES) {
    test(c.name, (t) => {
      const input = {
        frontmatter: (c.perturb ?? ((fm) => fm))(baseFrontmatter()),
        status: c.status ?? "defined",
        body: "body",
      };
      const csv = csvRefusals(t, input);
      const md = markdownRefusals(t, input);

      assert.equal(csv.plan.ok, false, "the CSV reader must refuse this row");
      assert.equal(md.plan.ok, false, "and so must the markdown reader");
      assert.equal(csv.plan.exitCode, 1);
      assert.equal(md.plan.exitCode, 1, "same exit code — `data refused`, not a second class");

      // The assertion the ticket is actually about: not "both refused", but
      // "both refused for the same reason, in the same words, because there is
      // only one place the reason is written down".
      assert.deepEqual(
        md.plan.refusals.map((r) => r.message),
        csv.plan.refusals.map((r) => r.message),
        "the two readers refuse with DIFFERENT messages, which means at least one of them is "
        + "validating on its own rather than funnelling through planImport — the exact drift "
        + "§4.5 exists to make structurally impossible");
      assert.ok(csv.plan.refusals.length >= 1, "and there is a refusal to compare");
    });
  }
});

// --- and the same property end to end, through the CLI -----------------------

function boardRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "blaze-shared-rule-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "projects", "BLZ", "defined"), { recursive: true });
  writeFileSync(join(root, "projects", "BLZ", "project.json"),
    JSON.stringify({ key: "BLZ", name: "Blaze", labels: ["alpha", "beta"] }));
  spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  return root;
}

function runCli(root, args) {
  const env = { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") };
  delete env.BLAZE_SESSION;
  return spawnSync(process.execPath, [cli, "import", ...args],
    { cwd: root, env, encoding: "utf8" });
}

test("`blaze import` and `blaze import --format markdown` refuse the same row identically", (t) => {
  const root = boardRoot(t);
  const fm = { ...baseFrontmatter(), labels: ["gamma"] };

  const csvPath = join(root, "in.csv");
  writeFileSync(csvPath,
    writeCsv([COLUMN_NAMES.slice(), cellsFor(fm, { status: "defined", body: "body" })]));

  const mdDir = join(root, "md");
  mkdirSync(join(mdDir, "defined"), { recursive: true });
  writeFileSync(join(mdDir, "defined", "a.md"), serializeTicket({ frontmatter: fm, body: "body" }));

  const asCsv = runCli(root, ["--apply", csvPath]);
  const asMarkdown = runCli(root, ["--apply", "--format", "markdown", mdDir]);

  assert.equal(asCsv.status, 1, asCsv.stderr);
  assert.equal(asMarkdown.status, 1, asMarkdown.stderr);
  const refusal = /row 1: 1 `labels` value\(s\) are not in the taxonomy/;
  assert.match(asCsv.stderr, refusal);
  assert.match(asMarkdown.stderr, refusal,
    "the markdown front end must inherit the board's taxonomy rule without knowing it exists");
});

test("`blaze import --format markdown --mapping` is refused — frontmatter needs no mapping", (t) => {
  const root = boardRoot(t);
  const r = runCli(root, ["--format", "markdown", "--mapping", "m.json", join(root, "md")]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /mapping/,
    "§4.5: frontmatter IS the canonical vocabulary, so propose-mapping does not apply to it — "
    + "a flag that silently did nothing would be worse than a refusal");
});

test("`blaze import --format wibble` is refused rather than defaulting to csv", (t) => {
  const root = boardRoot(t);
  const r = runCli(root, ["--format", "wibble", join(root, "in.csv")]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--format/);
});
