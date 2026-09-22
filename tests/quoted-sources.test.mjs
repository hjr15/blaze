// tests/quoted-sources.test.mjs — BLZ-523.
//
// A DOC QUOTE THAT OPTED IN IS CHECKED. NOTHING ELSE IS TOUCHED.
//
// The ticket's own investigation (2026-08-30) ruled out the obvious mechanism first: a
// corpus-wide grep for "does this doc still say what the code says" produces false positives
// on illustrative and historical quotes, gets excepted, and the exceptions make it useless.
// The evidence was concrete — FOUR sites quoted a stale figure while TWO MORE quoted the
// same CLASS of figure correctly, and no grep can tell those two populations apart, because
// the difference is in what the author meant, not in the text.
//
// So the guard does not read the tree. It reads a registry, and a quote is in the registry
// because someone put it there. `scripts/ci/quoted-sources.mjs` holds both the entries and
// the derivers that say what each one's source of truth reads RIGHT NOW.
//
// The three properties below are the ones that make it worth having, and each is pinned
// rather than argued:
//
//   1. a registered quote that has rotted turns a test NAMED for that entry red;
//   2. reformatting does not defeat it — re-wrapping across lines, re-bolding, adding
//      backticks all still match, because that exact failure already happened once and only
//      the revert rule caught it;
//   3. an unregistered quote is not policed, even when it is demonstrably stale, and that is
//      checked by watching WHICH FILES the checker opens rather than asserted in prose.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REGISTRY, DERIVERS, normaliseQuote, checkEntry, checkRegistry, SHA_PIN }
  from "../scripts/ci/quoted-sources.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const REPO = join(import.meta.dirname, "..");

// BLZ-503: every scratch directory this file mints, removed when the file is done with
// it. Registered rather than written as a test's trailing statement, so a failing
// assertion earlier in the test cannot skip it.
const scratch = scratchRegistry();

/** A throwaway docs tree, `{ "a/b.md": "text" }`, rooted where a real repo would be. */
function fakeRepo(files) {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz523-docs-")));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe("BLZ-523: the registry is the whole scope, and it is not empty", () => {
  test("every entry is well formed and names a deriver that exists", () => {
    assert.ok(REGISTRY.length >= 2,
      `only ${REGISTRY.length} registered quote(s) — the mechanism proves nothing over an empty registry`);
    const ids = REGISTRY.map((e) => e.id);
    assert.deepEqual([...new Set(ids)], ids, "an id must name one entry");
    for (const e of REGISTRY) {
      for (const k of ["id", "doc", "quote", "deriver", "why"]) {
        assert.ok(typeof e[k] === "string" && e[k].length > 0, `${e.id}: ${k} is required`);
      }
      assert.ok(e.doc.endsWith(".md"), `${e.id}: doc must be a markdown path`);
      assert.equal(typeof DERIVERS[e.deriver], "function",
        `${e.id}: no deriver named ${JSON.stringify(e.deriver)} — a quote nothing can re-derive ` +
        "cannot be checked, and registering it would only look like coverage");
    }
  });

  test("a SHA-pinned figure is OUT of scope and must not be registered", () => {
    // The boundary decision this ticket asked for, made mechanical. A figure quoted with the
    // commit it was measured at is a HISTORICAL statement: it was true then, it is true now,
    // and it never rots. Registering one would force a true sentence to change whenever the
    // tree moves, which is the opposite of the point. Pinning to a SHA is the CHEAPER remedy
    // and the registry is for quotes that cannot use it — live claims about HEAD.
    for (const e of REGISTRY) {
      assert.doesNotMatch(e.quote, SHA_PIN,
        `${e.id}: this quote is pinned to a commit, so it cannot rot. Leave it out — see ` +
        "scripts/ci/quoted-sources.mjs on which figures are in scope");
    }
  });
});

describe("BLZ-523: a registered quote that rotted fails, by name", () => {
  for (const entry of REGISTRY) {
    test(`${entry.id}: ${entry.doc} still says what ${entry.deriver} derives`, () => {
      const r = checkEntry(entry, { repo: REPO });
      assert.equal(r.status, "ok",
        `${r.problem}\n\n  registered: ${JSON.stringify(r.quote)}\n  derived now: ` +
        `${JSON.stringify(r.derived)}\n  why it is load-bearing: ${entry.why}`);
    });
  }

  test("a source that moved on is reported stale, not shrugged off", () => {
    const repo = fakeRepo({ "docs/x.md": "the answer is **41**, give or take.\n" });
    const entry = { id: "t", doc: "docs/x.md", quote: "the answer is 41", deriver: "t", why: "t" };
    const ok = checkEntry(entry, { repo, derivers: { t: () => "the answer is 41" } });
    assert.equal(ok.status, "ok");
    const stale = checkEntry(entry, { repo, derivers: { t: () => "the answer is 42" } });
    assert.equal(stale.status, "stale");
    assert.match(stale.problem, /42/, "the failure must say what the source reads now");
  });

  test("a quote that has LEFT the doc fails rather than passing quietly", () => {
    // The defeat that matters. A guard that only checks "if I find it, is it right" reports
    // clean the moment the sentence is rewritten, which is precisely when it rotted.
    const repo = fakeRepo({ "docs/x.md": "we no longer say anything about that.\n" });
    const r = checkEntry({ id: "t", doc: "docs/x.md", quote: "the answer is 41", deriver: "t", why: "t" },
      { repo, derivers: { t: () => "the answer is 41" } });
    assert.equal(r.status, "missing");
    assert.match(r.problem, /docs\/x\.md/);
  });

  test("a doc the registry names but the tree does not have fails loudly", () => {
    const r = checkEntry({ id: "t", doc: "docs/gone.md", quote: "x", deriver: "t", why: "t" },
      { repo: fakeRepo({}), derivers: { t: () => "x" } });
    assert.equal(r.status, "unreadable");
  });
});

describe("BLZ-523: reformatting does not defeat the check", () => {
  const entry = { id: "t", doc: "docs/x.md", quote: "17 mutations to two files", deriver: "t", why: "t" };
  const derivers = { t: () => "17 mutations to two files" };

  for (const [name, body] of [
    ["re-wrapped across two lines", "it applies 17 mutations\nto two files today.\n"],
    ["re-wrapped across three lines", "it applies 17\nmutations to\ntwo files today.\n"],
    ["re-bolded", "it applies **17 mutations to two files** today.\n"],
    ["backticked in the middle", "it applies 17 mutations to `two files` today.\n"],
    ["extra spaces", "it applies 17   mutations  to two  files today.\n"],
    ["wrapped inside a table cell", "| a | it applies 17 mutations to two\n  files | b |\n"],
  ]) {
    test(`${name} still matches`, () => {
      const r = checkEntry(entry, { repo: fakeRepo({ "docs/x.md": body }), derivers });
      assert.equal(r.status, "ok", `${name}: ${r.problem}`);
    });
  }

  test("…but a changed WORD is not reformatting, and does not match", () => {
    const r = checkEntry(entry,
      { repo: fakeRepo({ "docs/x.md": "it applies 17 mutations to three files.\n" }), derivers });
    assert.equal(r.status, "missing",
      "normalisation must forgive whitespace and emphasis only — forgiving a word would make " +
      "the check unfalsifiable");
  });

  test("normaliseQuote is the one rule both sides go through", () => {
    assert.equal(normaliseQuote("**a**  `b`\n  c"), "a b c");
    assert.equal(normaliseQuote("a\n\nb"), "a b");
  });
});

describe("BLZ-523: an unregistered quote is not policed, however stale it is", () => {
  test("the checker opens the registered docs and no others", () => {
    // The property the ticket's investigation says a grep-based guard cannot have. Watched
    // rather than asserted: a checker that read the tree and merely chose not to complain
    // would satisfy any assertion about its OUTPUT.
    const repo = fakeRepo({
      "docs/registered.md": "the count is 7.\n",
      "docs/illustrative.md": "for example, the count might be 9999 — a made-up number.\n",
      "docs/historical.md": "the count was 3 back when this was written.\n",
    });
    const opened = [];
    const results = checkRegistry(
      [{ id: "r", doc: "docs/registered.md", quote: "the count is 7", deriver: "t", why: "t" }],
      {
        repo,
        derivers: { t: () => "the count is 7" },
        onRead: (p) => opened.push(p),
      });
    assert.deepEqual(results.map((r) => r.status), ["ok"]);
    assert.deepEqual(opened, ["docs/registered.md"],
      "the checker must open exactly the docs the registry names. Reading the corpus is how " +
      "the grep-shaped guard this ticket rejected gets its false positives");
  });

  test("the real registry touches only the docs it names", () => {
    const opened = [];
    checkRegistry(REGISTRY, { repo: REPO, onRead: (p) => opened.push(p) });
    assert.deepEqual([...new Set(opened)].sort(), [...new Set(REGISTRY.map((e) => e.doc))].sort());
  });
});
