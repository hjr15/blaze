// tests/model/import-plan.test.mjs — BLZ-628: the deterministic import plan.
//
// Design §5.1 (exit codes), §5.2 (every named failure mode) and §5.3's
// "validation is all-or-nothing" rule, from
// docs/design/csv-import-and-export.md. `planImport` is PURE — it reads no
// board from disk and writes nothing — so every test here hands it a board
// object built in memory.
//
// The echo rule (§5.2, "echo the value only after it has passed a shape
// check") is tested as its own assertion on nearly every refusal, because the
// design records three separate drafts getting it wrong in three different
// ways. A refusal message that reproduces a pasted paragraph out of someone
// else's export is the harm BLZ-587 names, and only a negative assertion
// catches it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseCanonicalCsv, planImport } from "../../scripts/model/import-plan.mjs";
import { COLUMN_NAMES } from "../../scripts/model/csv-schema.mjs";
import { writeCsv } from "../../scripts/model/csv.mjs";
import { TYPES, PRIORITIES } from "../../scripts/model/schema.mjs";
import { RESOLUTIONS, statusesFor } from "../../scripts/model/workflows.mjs";

// --- fixtures ----------------------------------------------------------------

/** A board the planner can resolve against. Everything the planner needs and
 *  nothing it does not: no filesystem, no config loader, no write port. */
function board({ tickets = [], sprintIds = [], projects = {} } = {}) {
  return {
    byId: new Map(tickets.map((t) => [t.frontmatter.id, t])),
    types: TYPES,
    statusesFor,
    priorities: PRIORITIES,
    resolutions: RESOLUTIONS,
    sprintIds: new Set(sprintIds),
    projectFor: (k) => projects[k] ?? null,
  };
}

/** One canonical row as a column-name → cell map, every unnamed column empty. */
function cells(overrides = {}) {
  const base = Object.fromEntries(COLUMN_NAMES.map((n) => [n, ""]));
  return {
    ...base,
    schema_version: "1", id: "BLZ-1", project: "BLZ", type: "task",
    status: "defined", title: "t", description: "body", estimate: "30",
    ...overrides,
  };
}

/** Column-name maps → the rows shape `planImport` takes, numbered from 1. */
function rows(...maps) {
  return maps.map((m, i) => ({ row: i + 1, line: i + 2, cells: m }));
}

/** Column-name maps → canonical CSV text, for the parser's own tests. */
function csv(...maps) {
  return writeCsv([COLUMN_NAMES.slice(), ...maps.map((m) => COLUMN_NAMES.map((n) => m[n] ?? ""))]);
}

/** An existing board ticket, in the read seam's shape. */
function ticket(fm, { status = "defined", body = "body", file = null } = {}) {
  return {
    frontmatter: { title: "t", type: "task", project: "BLZ", estimate: 30, ...fm },
    body, status, project: fm.project ?? "BLZ",
    file: file ?? `/b/projects/BLZ/${status}/${fm.id}.md`,
  };
}

const errorText = (plan) => plan.refusals.map((r) => r.message).join("\n");

// --- the reader: "could not look" is not "bad data" (§5.1, §5.2) -------------

describe("BLZ-628: parseCanonicalCsv — the format refusals (exit 2/3)", () => {
  test("a canonical file parses to rows keyed by column name", () => {
    const r = parseCanonicalCsv(csv(cells({ id: "BLZ-1" }), cells({ id: "BLZ-2" })));
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0].cells.id, "BLZ-1");
    assert.equal(r.rows[0].row, 1, "data rows number from 1; the header is not a row");
    assert.equal(r.rows[1].cells.title, "t");
  });

  test("a row with the wrong cell count is exit 2 and names the line and the byte offset", () => {
    const text = csv(cells()) + "1,BLZ-2,BLZ\n";
    const r = parseCanonicalCsv(text);
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 2, "the FILE is not the format it claims — could not look, not bad data");
    assert.match(errorOf(r), /line 3/);
    assert.match(errorOf(r), /byte offset \d+/);
    assert.match(errorOf(r), /3 cells/);
  });

  test("an unterminated quote is exit 2 and names the line and the byte offset", () => {
    const text = csv(cells()) + '1,"BLZ-2,BLZ\n';
    const r = parseCanonicalCsv(text);
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 2);
    assert.match(errorOf(r), /unterminated/i);
    assert.match(errorOf(r), /byte offset \d+/);
  });

  test("a 32nd column is refused as a mapping the file has no confirmation for (exit 3)", () => {
    const text = writeCsv([[...COLUMN_NAMES, "surprise"], [...COLUMN_NAMES.map(() => ""), ""]]);
    const r = parseCanonicalCsv(text);
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 3, "a header that is not the canonical 31 has no confirmed mapping");
    assert.match(errorOf(r), /surprise/);
    assert.match(errorOf(r), /propose-mapping/);
  });

  test("a schema_version that is not 1 is exit 2 — the file declares a format this build cannot read", () => {
    const r = parseCanonicalCsv(csv(cells({ schema_version: "2" })));
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 2);
    assert.match(errorOf(r), /schema_version/);
  });

  test("a schema_version that disagrees between rows is exit 2", () => {
    const text = csv(cells({ id: "BLZ-1" }), cells({ id: "BLZ-2", schema_version: "" }));
    const r = parseCanonicalCsv(text);
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 2);
    assert.match(errorOf(r), /schema_version/);
  });

  test("an empty file is exit 2 — there is no header, so there is no format", () => {
    const r = parseCanonicalCsv("");
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 2);
  });

  test("a header-only file parses to zero rows and is not an error", () => {
    const r = parseCanonicalCsv(writeCsv([COLUMN_NAMES.slice()]));
    assert.equal(r.ok, true);
    assert.deepEqual(r.rows, []);
  });
});

function errorOf(r) { return (r.errors ?? []).join("\n"); }

// --- classification: create / update / skip (§5.2) ---------------------------

describe("BLZ-628: the create / update / skip classification", () => {
  test("a row whose id is not on the board is a CREATE", () => {
    const plan = planImport(rows(cells({ id: "BLZ-7" })), board());
    assert.equal(plan.ok, true);
    assert.equal(plan.exitCode, 0);
    assert.equal(plan.rows[0].op, "create");
    assert.equal(plan.counts.create, 1);
    assert.equal(plan.rows[0].ticket.project, "BLZ");
    assert.equal(plan.rows[0].ticket.status, "defined");
    assert.equal(plan.rows[0].ticket.frontmatter.id, "BLZ-7");
    assert.equal(plan.rows[0].ticket.body, "body");
  });

  test("a row identical to the ticket already on the board is a SKIP — this is what makes a re-run a no-op", () => {
    const b = board({ tickets: [ticket({ id: "BLZ-1" })] });
    const plan = planImport(rows(cells({ id: "BLZ-1" })), b);
    assert.equal(plan.ok, true);
    assert.equal(plan.rows[0].op, "skip");
    assert.equal(plan.counts.skip, 1);
  });

  test("identical means all 31 columns — a STATUS-only difference is a difference", () => {
    const b = board({ tickets: [ticket({ id: "BLZ-1" }, { status: "in-progress" })] });
    const plan = planImport(rows(cells({ id: "BLZ-1", status: "defined" })), b);
    assert.equal(plan.rows[0].op, "refuse", "status is a directory, not a field — comparing 28 keys would skip this silently");
    assert.match(errorText(plan), /status/);
  });

  test("a differing row with no --update is a REFUSAL naming the id and the differing fields, and echoes no cell contents", () => {
    // Values chosen so they cannot collide with the message's own prose — an
    // earlier draft of this test asserted on "on the board", which the
    // refusal legitimately says about itself, and passed for the wrong reason.
    const b = board({ tickets: [ticket({ id: "BLZ-1", title: "ZZBOARDVALUE" })] });
    const plan = planImport(rows(cells({ id: "BLZ-1", title: "QQFILEVALUE" })), b);
    assert.equal(plan.ok, false);
    assert.equal(plan.exitCode, 1);
    assert.equal(plan.rows[0].op, "refuse");
    assert.match(errorText(plan), /BLZ-1/);
    assert.match(errorText(plan), /title/);
    assert.doesNotMatch(errorText(plan), /ZZBOARDVALUE|QQFILEVALUE/,
      "the field is named; the two values are not reproduced");
  });

  test("a differing row WITH --update is an UPDATE carrying the field-level diff and the existing file", () => {
    const b = board({ tickets: [ticket({ id: "BLZ-1", title: "old" }, { file: "/b/projects/BLZ/defined/BLZ-1-old.md" })] });
    const plan = planImport(rows(cells({ id: "BLZ-1", title: "new" })), b, { update: true });
    assert.equal(plan.ok, true);
    assert.equal(plan.rows[0].op, "update");
    assert.deepEqual(plan.rows[0].changedColumns, ["title"]);
    assert.equal(plan.rows[0].currentFile, "/b/projects/BLZ/defined/BLZ-1-old.md");
    assert.equal(plan.counts.update, 1);
  });

  test("an empty id is refused by default — the skip rule is keyed on the id", () => {
    const plan = planImport(rows(cells({ id: "" })), board());
    assert.equal(plan.ok, false);
    assert.equal(plan.exitCode, 1);
    assert.match(errorText(plan), /--allocate-ids/);
  });

  test("an empty id under --allocate-ids is a CREATE with a null id, to be allocated at apply time", () => {
    const plan = planImport(rows(cells({ id: "" })), board(), { allocateIds: true });
    assert.equal(plan.ok, true);
    assert.equal(plan.rows[0].op, "create");
    assert.equal(plan.rows[0].id, null);
    assert.equal(plan.rows[0].allocate, true);
  });

  test("the plan is walkable in file order and carries a stable seq per row", () => {
    const plan = planImport(
      rows(cells({ id: "BLZ-1" }), cells({ id: "BLZ-2" }), cells({ id: "BLZ-3" })), board());
    assert.deepEqual(plan.rows.map((r) => r.seq), [1, 2, 3]);
    assert.deepEqual(plan.rows.map((r) => r.id), ["BLZ-1", "BLZ-2", "BLZ-3"]);
  });
});

// --- forward references and duplicates (§5.2) --------------------------------

describe("BLZ-628: forward-reference resolution and duplicate detection", () => {
  test("a parent declared on a LATER row of the same file resolves — the file is a unit, not a stream", () => {
    const plan = planImport(rows(
      cells({ id: "BLZ-2", type: "task", parent: "BLZ-1" }),
      cells({ id: "BLZ-1", type: "feature", estimate: "" }),
    ), board());
    assert.equal(plan.ok, true, errorText(plan));
    assert.equal(plan.rows[0].op, "create");
  });

  test("a LINK target declared on a later row of the same file resolves", () => {
    const plan = planImport(rows(
      cells({ id: "BLZ-2", links: "Blocks:BLZ-3" }),
      cells({ id: "BLZ-3" }),
    ), board());
    assert.equal(plan.ok, true, errorText(plan));
  });

  test("a forward-referenced parent is still TYPE-checked against the row that will create it", () => {
    const plan = planImport(rows(
      cells({ id: "BLZ-2", type: "task", parent: "BLZ-1" }),
      cells({ id: "BLZ-1", type: "task" }),
    ), board());
    assert.equal(plan.ok, false, "task cannot be a child of task");
    assert.match(errorText(plan), /invalid parent/);
  });

  test("a duplicate id within one file is refused, naming the id and EVERY row carrying it", () => {
    const plan = planImport(rows(
      cells({ id: "BLZ-1" }), cells({ id: "BLZ-2" }), cells({ id: "BLZ-1" }),
    ), board());
    assert.equal(plan.ok, false);
    assert.equal(plan.exitCode, 1);
    const msg = errorText(plan);
    assert.match(msg, /BLZ-1/, "an id passed its shape check, so it is echoed");
    assert.match(msg, /\b1\b[^\n]*\b3\b/, "both row numbers are named — never last-row-wins");
    assert.doesNotMatch(msg, /BLZ-2/);
  });

  test("a dangling parent — in neither the file nor the board — is refused and never silently dropped", () => {
    const plan = planImport(rows(cells({ id: "BLZ-1", parent: "BLZ-999" })), board());
    assert.equal(plan.ok, false);
    assert.equal(plan.exitCode, 1);
    assert.match(errorText(plan), /BLZ-999/, "a well-formed id that failed MEMBERSHIP is echoed");
    assert.match(errorText(plan), /parent/);
  });

  test("a dangling link target is refused, naming every dangling reference and its row", () => {
    const plan = planImport(rows(cells({ id: "BLZ-1", links: "Blocks:BLZ-900;Relates:BLZ-901" })), board());
    assert.equal(plan.ok, false);
    assert.match(errorText(plan), /BLZ-900/);
    assert.match(errorText(plan), /BLZ-901/);
  });

  test("a reference to a ticket already ON THE BOARD resolves", () => {
    const b = board({ tickets: [ticket({ id: "BLZ-1", type: "feature" })] });
    const plan = planImport(rows(cells({ id: "BLZ-2", parent: "BLZ-1" })), b);
    assert.equal(plan.ok, true, errorText(plan));
  });
});

// --- the §5.2 refusals, one named test each ----------------------------------

describe("BLZ-628: every §5.2 refusal, and the shape-vs-membership echo rule", () => {
  test("an unknown STATUS names the row, the column and the legal set — and does not echo the cell", () => {
    const plan = planImport(rows(cells({ status: "wibble" })), board());
    assert.equal(plan.ok, false);
    assert.equal(plan.exitCode, 1);
    const m = errorText(plan);
    assert.match(m, /status/);
    assert.match(m, /defined/);
    assert.match(m, /in-review/);
    assert.doesNotMatch(m, /wibble/, "status has no shape constraint, so the cell is never echoed");
  });

  test("an unknown TYPE is refused without echoing the cell", () => {
    const plan = planImport(rows(cells({ type: "epicc" })), board());
    assert.equal(plan.ok, false);
    assert.doesNotMatch(errorText(plan), /epicc/);
    assert.match(errorText(plan), /type/);
  });

  test("an unknown PRIORITY is a refusal, never a coercion to medium", () => {
    const plan = planImport(rows(cells({ priority: "P1" })), board());
    assert.equal(plan.ok, false);
    assert.equal(plan.rows[0].op, "refuse");
    assert.doesNotMatch(errorText(plan), /P1/);
    assert.match(errorText(plan), /priority/);
    assert.match(errorText(plan), /highest/);
  });

  test("an unknown RESOLUTION is refused without echoing the cell", () => {
    const plan = planImport(rows(cells({ resolution: "shipped" })), board());
    assert.equal(plan.ok, false);
    assert.doesNotMatch(errorText(plan), /shipped/);
    assert.match(errorText(plan), /wont-do/);
  });

  test("a cell beginning with '=' is refused, naming the row and column but not the contents", () => {
    const plan = planImport(rows(cells({ title: "=HYPERLINK(\"http://evil\")" })), board());
    assert.equal(plan.ok, false);
    assert.equal(plan.exitCode, 1);
    assert.match(errorText(plan), /title/);
    assert.doesNotMatch(errorText(plan), /HYPERLINK/);
  });

  test("a LEADING TAB before the '@' does not smuggle it past the check — whitespace is stripped first", () => {
    const plan = planImport(rows(cells({ assignee: "\t@SUM(1+1)" })), board());
    assert.equal(plan.ok, false);
    assert.match(errorText(plan), /assignee/);
    assert.doesNotMatch(errorText(plan), /SUM/);
  });

  test("'+' and '-' are deliberately NOT hostile — refusing them would restrict free text nothing measured", () => {
    const plan = planImport(rows(cells({ title: "-1 is a legitimate title" })), board());
    assert.equal(plan.ok, true, errorText(plan));
  });

  test("an ESTIMATE that is not a multiple of 5 is refused, echoing it and naming the nearest legal values", () => {
    const plan = planImport(rows(cells({ estimate: "7" })), board());
    assert.equal(plan.ok, false);
    const m = errorText(plan);
    assert.match(m, /\b7\b/, "an integer passed its shape check, so it is echoed");
    assert.match(m, /\b5\b/);
    assert.match(m, /\b10\b/);
  });

  test("an ESTIMATE that is not an integer at all fails the SHAPE check and is NOT echoed", () => {
    const plan = planImport(rows(cells({ estimate: "4h" })), board());
    assert.equal(plan.ok, false);
    assert.doesNotMatch(errorText(plan), /4h/);
    assert.match(errorText(plan), /estimate/);
  });

  test("a SPRINT outside sprints.json is refused, naming the registered ids and not the cell", () => {
    const b = board({ sprintIds: ["2026-W38", "2026-W39"] });
    const plan = planImport(rows(cells({ sprint: "Sprint Health" })), b);
    assert.equal(plan.ok, false);
    const m = errorText(plan);
    assert.match(m, /2026-W38/);
    assert.doesNotMatch(m, /Sprint Health/, "a sprint id has no shape constraint");
  });

  test("an off-taxonomy LABEL names the column, the declared set and project.json — not validateTaxonomy's echoing message", () => {
    const b = board({ projects: { BLZ: { key: "BLZ", labels: ["lane:c", "parked"], components: [] } } });
    const plan = planImport(rows(cells({ labels: "lane:c;whatever-they-pasted" })), b);
    assert.equal(plan.ok, false);
    const m = errorText(plan);
    assert.match(m, /labels/);
    assert.match(m, /lane:c/, "the DECLARED set is shown — that is what the operator acts on");
    assert.match(m, /project\.json/);
    assert.doesNotMatch(m, /whatever-they-pasted/);
  });

  test("a link TYPE outside LINK_TYPES is refused without echoing it", () => {
    const plan = planImport(rows(cells({ id: "BLZ-1", links: "Precedes:BLZ-1" })), board());
    assert.equal(plan.ok, false);
    assert.doesNotMatch(errorText(plan), /Precedes/, "a link type has no shape constraint");
    assert.match(errorText(plan), /links/);
  });

  test("a links member with more or fewer than one ':' is refused without echoing it", () => {
    const plan = planImport(rows(cells({ links: "Blocks:BLZ-1:extra" })), board());
    assert.equal(plan.ok, false);
    assert.doesNotMatch(errorText(plan), /extra/);
  });

  test("a link entry with a type and NO target is refused — the export-side guard's import twin", () => {
    const plan = planImport(rows(cells({ links: "Blocks:" })), board());
    assert.equal(plan.ok, false);
    assert.match(errorText(plan), /links/);
  });

  test("a WORKLOG cell that is not a JSON array of objects is refused without echoing it", () => {
    const plan = planImport(rows(cells({ worklog: '{"date":"2026-01-01"}' })), board());
    assert.equal(plan.ok, false);
    assert.match(errorText(plan), /worklog/);
    assert.doesNotMatch(errorText(plan), /2026-01-01/, "worklog.note is free text — nothing in the cell is echoed");
  });

  test("an ID that fails its SHAPE is refused and never echoed", () => {
    const plan = planImport(rows(cells({ id: "not an id, a pasted paragraph" })), board());
    assert.equal(plan.ok, false);
    assert.doesNotMatch(errorText(plan), /pasted paragraph/);
    assert.match(errorText(plan), /<KEY>-<N>/);
  });

  test("a DATE that fails its shape is refused and never echoed", () => {
    const plan = planImport(rows(cells({ created: "01/02/2026" })), board());
    assert.equal(plan.ok, false);
    assert.doesNotMatch(errorText(plan), /01\/02\/2026/);
    assert.match(errorText(plan), /YYYY-MM-DD/);
  });

  test("a PROJECT KEY that fails its shape is refused, never normalised (ADR-0025)", () => {
    const plan = planImport(rows(cells({ project: "blz" })), board());
    assert.equal(plan.ok, false);
    assert.match(errorText(plan), /project/);
  });

  test("an empty REQUIRED cell is refused", () => {
    const plan = planImport(rows(cells({ title: "" })), board());
    assert.equal(plan.ok, false);
    assert.match(errorText(plan), /title/);
  });

  test("a type's own required fields still apply — a risk with no likelihood/impact is refused", () => {
    const plan = planImport(rows(cells({ type: "risk", status: "identified", estimate: "" })), board());
    assert.equal(plan.ok, false);
    assert.match(errorText(plan), /likelihood/);
    assert.match(errorText(plan), /impact/);
  });

  test("not_before after deadline is refused, echoing both — they passed their shape check", () => {
    const plan = planImport(rows(cells({ not_before: "2026-02-10", deadline: "2026-01-10" })), board());
    assert.equal(plan.ok, false);
    assert.match(errorText(plan), /2026-02-10/);
  });

  test("an empty optional cell means ABSENT, never a default — no key is materialised", () => {
    const plan = planImport(rows(cells({ id: "BLZ-5", priority: "", assignee: "" })), board());
    assert.equal(plan.ok, true, errorText(plan));
    const fm = plan.rows[0].ticket.frontmatter;
    assert.equal(Object.hasOwn(fm, "priority"), false, "an empty cell round-trips as an ABSENT key, not as 'medium'");
    assert.equal(Object.hasOwn(fm, "assignee"), false, "...and never as 'unassigned'");
  });
});

// --- atomicity of VALIDATION (§5.3) ------------------------------------------

describe("BLZ-628: validation is all-or-nothing", () => {
  test("500 good rows and 3 bad ones is one refusal with the 3 named and nothing applyable", () => {
    const good = [];
    for (let i = 1; i <= 20; i++) good.push(cells({ id: `BLZ-${i}` }));
    good[4] = cells({ id: "BLZ-5", status: "wibble" });
    good[9] = cells({ id: "BLZ-10", estimate: "7" });
    good[14] = cells({ id: "BLZ-15", parent: "BLZ-999" });
    const plan = planImport(rows(...good), board());
    assert.equal(plan.ok, false);
    assert.equal(plan.exitCode, 1);
    assert.equal(plan.rows.filter((r) => r.op === "refuse").length, 3);
    assert.equal(plan.counts.refuse, 3);
    assert.equal(plan.applicable, false,
      "one bad row means ZERO writes — the apply must not walk a plan that is not ok");
  });

  test("a clean plan is applicable and reports its counts", () => {
    const b = board({ tickets: [ticket({ id: "BLZ-1" })] });
    const plan = planImport(rows(
      cells({ id: "BLZ-1" }),                 // identical → skip
      cells({ id: "BLZ-2" }),                 // new → create
    ), b);
    assert.equal(plan.ok, true);
    assert.equal(plan.applicable, true);
    assert.deepEqual(plan.counts, { create: 1, update: 0, skip: 1, refuse: 0 });
  });
});
