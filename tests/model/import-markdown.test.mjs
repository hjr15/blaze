// tests/model/import-markdown.test.mjs — BLZ-633: the markdown reader's own
// surface. Design §4.5.
//
// The property that matters — one `planImport`, two readers, refusing
// identically — is tests/import-shared-rule.test.mjs, and the loop is
// tests/markdown-round-trip.test.mjs. This pins what is genuinely the
// READER'S OWN and therefore cannot be inherited from `planImport`: which
// files it collects, where `status` comes from, and the §5.1 exit class of
// each way a document can fail before it ever becomes a row.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MARKDOWN_EXT, collectMarkdownFiles, readMarkdownRows, exportMarkdownDocs,
} from "../../scripts/model/import-markdown.mjs";
import { serializeTicket } from "../../scripts/model/ticket.mjs";
import { UnknownFrontmatterKeyError } from "../../scripts/model/export-rows.mjs";

function tmp(t) {
  const d = mkdtempSync(join(tmpdir(), "blaze-md-reader-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function doc(dir, status, name, frontmatter, body = "body") {
  mkdirSync(join(dir, status), { recursive: true });
  const p = join(dir, status, name);
  writeFileSync(p, serializeTicket({ frontmatter, body }));
  return p;
}

const ticket = (over = {}) =>
  ({ id: "BLZ-1", title: "t", type: "task", project: "BLZ", estimate: 30, ...over });

describe("collecting the input (§4.5's `<dir-or-glob>`)", () => {
  test("a directory is walked recursively, sorted, and non-markdown is skipped", (t) => {
    const d = tmp(t);
    doc(d, "defined", "b.md", ticket({ id: "BLZ-2" }));
    doc(d, "defined", "a.md", ticket());
    writeFileSync(join(d, "defined", "notes.txt"), "not a ticket");
    mkdirSync(join(d, ".git"), { recursive: true });
    writeFileSync(join(d, ".git", "HEAD.md"), "---\n---\n");
    const files = collectMarkdownFiles([d]);
    assert.deepEqual(files, [join(d, "defined", "a.md"), join(d, "defined", "b.md")],
      "sorted, so the row numbers a refusal names are stable; and a dot-directory is skipped "
      + "because pointing this at a board's own tree is a legitimate thing to do");
  });

  test("several paths — what a shell glob expands to — are all read, once each", (t) => {
    const d = tmp(t);
    const a = doc(d, "defined", "a.md", ticket());
    const b = doc(d, "done", "b.md", ticket({ id: "BLZ-2", resolution: "done" }));
    assert.deepEqual(collectMarkdownFiles([a, b, a]), [a, b], "de-duplicated");
    assert.deepEqual(collectMarkdownFiles([join(d, "defined"), join(d, "done")]), [a, b]);
  });

  test(`the extension is ${MARKDOWN_EXT}`, () => {
    assert.equal(MARKDOWN_EXT, ".md");
  });
});

describe("the row shape is the CSV reader's", () => {
  test("`status` is the containing DIRECTORY, never a frontmatter field (§1.1)", (t) => {
    const d = tmp(t);
    doc(d, "in-progress", "a.md", ticket());
    const r = readMarkdownRows([d]);
    assert.equal(r.ok, true, (r.errors ?? []).join("\n"));
    assert.equal(r.rows[0].cells.status, "in-progress");
  });

  test("a frontmatter `status:` key is refused as a 29th key, not quietly preferred", (t) => {
    const d = tmp(t);
    // `status` is not one of the canonical 28 frontmatter keys — it is the
    // directory. A document that declared it would give the reader two sources
    // for one value, so §2.8's refusal is the right answer and it arrives from
    // `exportRows`, the same place it arrives from on the CSV side.
    doc(d, "defined", "a.md", ticket({ status: "done" }));
    const r = readMarkdownRows([d]);
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 1, "data refused — the remedy is to fix the document");
    assert.match(r.errors[0], /"status"/);
  });

  test("`project` comes from frontmatter, and its absence is planImport's refusal to make", (t) => {
    const d = tmp(t);
    const fm = ticket();
    delete fm.project;
    doc(d, "defined", "a.md", fm);
    const r = readMarkdownRows([d]);
    assert.equal(r.ok, true, "the READER does not judge it — it produces an empty cell");
    assert.equal(r.rows[0].cells.project, "",
      "an empty required column, which planImport refuses with its own message");
  });

  test("the legend names the file every row number refers to", (t) => {
    const d = tmp(t);
    doc(d, "defined", "a.md", ticket());
    doc(d, "defined", "b.md", ticket({ id: "BLZ-2" }));
    const r = readMarkdownRows([d], { dataRoot: d });
    assert.equal(r.ok, true);
    assert.match(r.legend.join("\n"), /row 1\s+defined\/a\.md/);
    assert.match(r.legend.join("\n"), /row 2\s+defined\/b\.md/);
  });
});

describe("the exit classes, following §5.1's split exactly as the CSV reader does", () => {
  test("nothing to read at all is exit 2 — `could not look`", (t) => {
    const d = tmp(t);
    const r = readMarkdownRows([d]);
    assert.equal(r.ok, false);
    assert.equal(r.exitCode, 2);
    assert.match(r.errors[0], /no \.md files/);
  });

  test("a file that is not a ticket document is exit 2, and names the grammar", (t) => {
    const d = tmp(t);
    mkdirSync(join(d, "defined"), { recursive: true });
    writeFileSync(join(d, "defined", "a.md"), "# just a heading\n\nno frontmatter here\n");
    const r = readMarkdownRows([d], { dataRoot: d });
    assert.equal(r.exitCode, 2, "the file is not the format it claims");
    assert.match(r.errors[0], /is not a ticket document/);
    assert.match(r.errors[0], /nothing was written/);
  });

  test("an unreadable path is exit 2 rather than a crash", (t) => {
    const d = tmp(t);
    const r = readMarkdownRows([join(d, "nope.md")], { dataRoot: d });
    assert.equal(r.exitCode, 2);
    assert.match(r.errors[0], /cannot read/);
  });

  test("a FIFO is refused rather than opened blind (ADR-0031)", (t) => {
    const d = tmp(t);
    // `readRegularFileSync` is the only reader used here for exactly this: a
    // FIFO with no writer blocks forever, with no error, no timeout and
    // nothing on stderr — the failure mode that is worse than any wrong
    // answer, because nothing reports at all.
    mkdirSync(join(d, "defined"), { recursive: true });
    const fifo = join(d, "defined", "a.md");
    execFileSync("mkfifo", [fifo]);
    const r = readMarkdownRows([fifo], { dataRoot: d });
    assert.equal(r.exitCode, 2, "and it RETURNS, which is the whole assertion");
    assert.match(r.errors[0], /cannot read/);
  });

  test("a 29th frontmatter key is exit 1, and says why dropping it would be worse", (t) => {
    const d = tmp(t);
    doc(d, "defined", "a.md", ticket({ wibble: "x" }));
    const r = readMarkdownRows([d], { dataRoot: d });
    assert.equal(r.exitCode, 1);
    assert.match(r.errors[0], /outside the declared 28 canonical keys/);
    assert.match(r.errors[0], /launder it out of the corpus/);
  });

  test("a link type outside LINK_TYPES is exit 1 — the fixed six-member vocabulary (§1.4)", (t) => {
    const d = tmp(t);
    doc(d, "defined", "a.md", ticket({ links: [{ type: "Precludes", target: "BLZ-2" }] }));
    const r = readMarkdownRows([d], { dataRoot: d });
    assert.equal(r.exitCode, 1);
    assert.match(r.errors[0], /link type "Precludes" is not one of/);
  });

  test("every bad document is reported, not just the first", (t) => {
    const d = tmp(t);
    doc(d, "defined", "a.md", ticket({ wibble: 1 }));
    doc(d, "defined", "b.md", ticket({ id: "BLZ-2", wobble: 2 }));
    const r = readMarkdownRows([d], { dataRoot: d });
    assert.equal(r.exitCode, 1);
    assert.equal(r.errors.length, 2,
      "a directory of 300 documents with three bad ones is three things to fix, not three runs");
  });

  test("a format error and a data error together report the FORMAT one — nothing was read", (t) => {
    const d = tmp(t);
    doc(d, "defined", "a.md", ticket({ wibble: 1 }));
    mkdirSync(join(d, "done"), { recursive: true });
    writeFileSync(join(d, "done", "b.md"), "not a ticket at all\n");
    const r = readMarkdownRows([d], { dataRoot: d });
    assert.equal(r.exitCode, 2,
      "exit 2 outranks exit 1 because the remedies differ and the stronger claim is the true "
      + "one: a file that would not parse means nothing was validated");
  });
});

describe("exportMarkdownDocs, the reverse serialization", () => {
  const storageOf = (tickets) => ({ listTickets: () => tickets });

  test("rows are ordered project ascending then id NUMERICALLY — exportRows's own rule", () => {
    const { docs } = exportMarkdownDocs(null, {
      storage: storageOf([
        { project: "BLZ", status: "defined", frontmatter: { id: "BLZ-10", title: "ten", type: "task" }, body: "b" },
        { project: "ACME", status: "defined", frontmatter: { id: "ACME-1", title: "one", type: "task" }, body: "b" },
        { project: "BLZ", status: "defined", frontmatter: { id: "BLZ-9", title: "nine", type: "task" }, body: "b" },
      ]),
    });
    assert.deepEqual(docs.map((d) => d.id), ["ACME-1", "BLZ-9", "BLZ-10"]);
  });

  test("the path is <project>/<status>/<id>-<slug>.md", () => {
    const { docs } = exportMarkdownDocs(null, {
      storage: storageOf([{
        project: "BLZ", status: "in-progress",
        frontmatter: { id: "BLZ-4", title: "A Title, With Punctuation!", type: "task" }, body: "b",
      }]),
    });
    assert.equal(docs[0].path, "BLZ/in-progress/BLZ-4-a-title-with-punctuation.md");
  });

  test("`project` is stamped from the walk even when frontmatter omits it", () => {
    const { docs } = exportMarkdownDocs(null, {
      storage: storageOf([{
        project: "BLZ", status: "defined",
        frontmatter: { id: "BLZ-1", title: "t", type: "task" }, body: "b",
      }]),
    });
    assert.match(docs[0].text, /^project: BLZ$/m,
      "a document that has left the corpus has no walk to be read off, and `project` is a "
      + "required column — BLZ-271's rule, inverted for the medium");
  });

  test("a 29th frontmatter key refuses the WHOLE export, exactly as exportRows does (§2.8)", () => {
    assert.throws(() => exportMarkdownDocs(null, {
      storage: storageOf([{
        project: "BLZ", status: "defined",
        frontmatter: { id: "BLZ-1", title: "t", type: "task", wibble: 1 }, body: "b",
      }]),
    }), (e) => e instanceof UnknownFrontmatterKeyError && e.key === "wibble");
  });

  test("it writes nothing — the caller places the documents", (t) => {
    const d = tmp(t);
    exportMarkdownDocs(null, {
      storage: storageOf([{
        project: "BLZ", status: "defined",
        frontmatter: { id: "BLZ-1", title: "t", type: "task" }, body: "b",
      }]),
    });
    assert.deepEqual(collectMarkdownFiles([d]), [],
      "§4.5 specifies a markdown READER and no export verb; a model function that wrote a "
      + "directory tree would be a third writer in this lane for no requirement");
  });
});
