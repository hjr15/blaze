// tests/shipped-doc-links.test.mjs — BLZ-474 and BLZ-473 (ADR-0028).
//
// ADR-0028: every outbound link in a document the npm tarball SHIPS is an absolute URL,
// and `docs/` stays unshipped. Two failures this pins, both already seen in this repo:
//
//   BLZ-460/BLZ-474 — a RELATIVE link to a path the tarball does not carry. Measured
//     before the fix: 9 such links in `AGENTS.md` and 11 in `README.md`, 20 in total, all
//     of them dead for anyone who ran `npm i @hjr15/blaze-board`.
//   BLZ-473 — the replacement URL naming a ref that does not exist. BLZ-460's recovery
//     regex was `^https://github\.com/hjr15/blaze/blob/[^/]+/`, which pins the org, the
//     repo and the path and accepts ANY ref: rewriting the pointer to
//     `blob/no-such-ref-xyz/docs/decisions/0025-….md` left that test green while the URL
//     returned a live HTTP 404. The path could not rot; the ref could.
//
// THE REF IS RESOLVED AGAINST THIS REPOSITORY, not against a hardcoded "main". `main` is
// not privileged here — a SHA or a tag is an equally good pointer and this test accepts
// one — but a ref no object in the repository answers to is a dead link, and that is what
// is refused. Resolution is local (`git rev-parse`), so this makes no network call and
// cannot flake on GitHub being reachable.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const REPO = join(import.meta.dirname, "..");

/** Files the tarball really ships, from npm itself rather than from `package.json`'s
 *  `files` re-implemented here. */
function packedFiles() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"],
    { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out)[0].files.map((f) => f.path);
}

/** Does this repository resolve `ref` to a commit? Tried bare and under `origin/`, so a
 *  checkout that has `origin/main` but no local `main` (a detached CI checkout) still
 *  passes, and a genuinely dead ref still fails. Memoised: the shipped documents point at
 *  one ref twenty-one times over. */
const refCache = new Map();
function refResolves(ref) {
  if (refCache.has(ref)) return refCache.get(ref);
  const v = resolveRef(ref);
  refCache.set(ref, v);
  return v;
}
// BLZ-473 follow-up: three outcomes, not two. `actions/checkout@v4` clones at depth 1 onto a
// DETACHED HEAD with no branch refs and no remote-tracking refs, so `main` resolves nowhere —
// and reading that as "the ref is dead" is the exact defect BLZ-484 names in the product:
// a probe that CANNOT LOOK reporting what a probe that looked and found nothing reports.
// It failed CI on #149 for precisely that reason while passing on every developer checkout.
//
// So: "yes" when the ref resolves; "no" when it does not AND this checkout demonstrably CAN
// resolve refs (proven by a control, not assumed); "unknown" when the checkout has no refs to
// resolve against at all. "unknown" does not pass silently — the caller says so by name.
// A checkout can only prove a ref is ABSENT if it holds a complete ref set. `actions/checkout@v4`
// fetches a single branch at depth 1, so it has SOME refs (the PR head) but not `main` — which is
// why "does it have any refs at all" was the wrong control and still failed CI on #150.
// `--is-shallow-repository` is the discriminator that actually separates the two environments.
function canProveRefAbsent() {
  const shallow = spawnSync("git", ["-C", REPO, "rev-parse", "--is-shallow-repository"],
    { encoding: "utf8" });
  if (shallow.status !== 0 || String(shallow.stdout || "").trim() !== "false") return false;
  const r = spawnSync("git", ["-C", REPO, "for-each-ref", "--count=1", "--format=%(refname)",
    "refs/heads", "refs/remotes"], { encoding: "utf8" });
  return r.status === 0 && String(r.stdout || "").trim() !== "";
}
function resolveRef(ref) {
  for (const candidate of [ref, `origin/${ref}`]) {
    const r = spawnSync("git", ["-C", REPO, "rev-parse", "--verify", "-q", `${candidate}^{commit}`],
      { encoding: "utf8" });
    if (r.status === 0) return "yes";
  }
  return canProveRefAbsent() ? "no" : "unknown";
}

const MD_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const BLOB = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/;

/** Every markdown link target in `text`, IN FULL — one entry per occurrence, fragments
 *  kept. Not deduplicated: the counts BLZ-474 measured (9 in AGENTS.md, 11 in README.md)
 *  are instance counts, and a floor asserted against a deduplicated list would silently
 *  drop whenever a target came to be linked twice. */
const linksIn = (text) => [...text.matchAll(MD_LINK)].map((m) => m[1]);

const SHIPPED_DOCS = ["AGENTS.md", "README.md"];

describe("ADR-0028: a shipped document's links are reachable for an installed user", () => {
  const packed = packedFiles();

  test("the tarball really ships the documents this file is about — otherwise it is vacuous", () => {
    assert.ok(packed.length > 0, "npm pack listed no files at all");
    for (const doc of SHIPPED_DOCS) {
      assert.ok(packed.includes(doc), `${doc} is not in the tarball; this file pins nothing`);
    }
    assert.equal(packed.filter((f) => f.startsWith("docs/")).length, 0,
      "ADR-0028 keeps docs/ out of the tarball — if that changed, the decision changed and " +
      "this file plus tests/package.test.mjs must change with it, deliberately");
  });

  test("BLZ-474: no shipped document carries a relative link to a path the tarball does not ship", () => {
    let checked = 0;
    for (const doc of SHIPPED_DOCS) {
      for (const href of linksIn(readFileSync(join(REPO, doc), "utf8"))) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) continue;
        checked += 1;
        const path = href.split("#")[0];
        if (path === "") continue;   // a bare fragment into this same file
        assert.ok(packed.includes(path),
          `${doc} links to ${JSON.stringify(href)}, which the tarball does not ship — dead for ` +
          "anyone who installed @hjr15/blaze-board. ADR-0028: use an absolute URL instead");
      }
    }
    assert.ok(checked > 0,
      "no relative link was examined at all — the extractor stopped matching and this test is vacuous");
  });

  test("BLZ-473: every blob URL in a shipped document names this repo, a LIVE ref, and a real path", () => {
    let checked = 0;
    for (const doc of SHIPPED_DOCS) {
      for (const href of linksIn(readFileSync(join(REPO, doc), "utf8"))) {
        if (!href.startsWith("https://github.com/hjr15/blaze/")) continue;
        const m = BLOB.exec(href);
        assert.ok(m, `${doc}: ${JSON.stringify(href)} is not the canonical blob form ` +
          "`https://github.com/<org>/<repo>/blob/<ref>/<path>`");
        const [, org, repo, ref, rest] = m;
        checked += 1;
        assert.equal(`${org}/${repo}`, "hjr15/blaze", `${doc}: ${href} names the wrong repository`);
        assert.notEqual(refResolves(ref), "no",
          `${doc}: ${href} names the ref ${JSON.stringify(ref)}, which this repository does not ` +
          "resolve — the URL is a live 404. This is the half BLZ-460's guard did not pin");
        const path = rest.split("#")[0];
        assert.ok(existsSync(join(REPO, path)),
          `${doc}: ${href} names ${path}, which does not exist in the repository`);
      }
    }
    assert.ok(checked >= 21,
      `only ${checked} blob URL occurrence(s) were examined; BLZ-474 converted 20 (9 in ` +
      "AGENTS.md, 11 in README.md) and BLZ-460's ADR-0025 pointer is the twenty-first, so a " +
      "smaller number means the extractor stopped matching");
  });

  test("BLZ-473: the ref check is not vacuous — a dead ref really is refused", (t) => {
    // A checkout with no refs at all (depth-1 detached CI clone) cannot tell a dead ref from
    // a live one, and must SAY so rather than answer either way. Skipping here is the honest
    // outcome; the assertions above still run, because they only refuse an outright "no".
    if (!canProveRefAbsent()) {
      t.skip("this checkout is shallow or holds no refs (a depth-1 single-branch CI clone) — " +
        "it cannot distinguish a dead ref from one it simply never fetched, so neither " +
        "answer would mean anything");
      return;
    }
    // The exact URL the BLZ-473 reviewer reproduced with. It passes the org/repo/path
    // shape and fails only on the ref, which is the whole point.
    assert.equal(refResolves("no-such-ref-xyz"), "no",
      "a ref this repository cannot resolve must not pass — the guard would accept a 404");
    assert.equal(refResolves("main"), "yes",
      "the ref the shipped pointers actually use must resolve, or this test refuses everything");
  });
});
