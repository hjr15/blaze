// tests/how-it-works-doc-pins.test.mjs — BLZ-454 and BLZ-457.
//
// `docs/guide/how-it-works.md` makes two kinds of claim about reconcile that a reader acts
// on directly, and both had drifted from the code:
//
//   BLZ-454 — it named `/` and `+` as the claim-list separators. `idsFromSubject` also
//             accepts `,` and `&`, so a reader following the guide would believe
//             `KEY-1, KEY-2: desc` supplies no claim, when it supplies two.
//   BLZ-457 — it named only the masked BRANCH signal (the SHIPPED signal is masked by the
//             same clause, cross-repo), and said an uncorroborated claim "stays among the
//             candidate pull requests" — `candidates` being the one collection in the code
//             it does NOT stay in.
//
// This file pins the guide against the implementation IN BOTH DIRECTIONS, which is what
// stops them drifting again: every separator the page documents must be accepted, and
// every separator it does not document must be refused. The negative probe is derived by
// SUBTRACTING the documented set from a fixed candidate list rather than being hardcoded,
// so widening the accepted set stays a one-place change — add the row to the table and the
// code, and this test follows. It does not encode today's set as permanent.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { idsFromSubject, reconcile } from "../scripts/reconcile.mjs";

const GUIDE = join(import.meta.dirname, "..", "docs", "guide", "how-it-works.md");
const guide = readFileSync(GUIDE, "utf8");

/** The separator table, read out of the page itself — the DOC is the input here, and
 *  `idsFromSubject` is the thing being compared against it. */
function documentedSeparators() {
  const section = guide.split("#### The leading id list, and its separators")[1];
  assert.ok(section, "the guide must carry the separator section this test pins");
  const rows = section.split("\n").slice(0, 40)
    .map((l) => /^\|\s*`(.)`\s*\|/.exec(l)).filter(Boolean).map((m) => m[1]);
  return rows;
}

/** Every separator a reader might plausibly try. Anything in here that the page does NOT
 *  document must be refused by the parser, or the page's "and no others" is false. */
const PLAUSIBLE = ["/", "+", ",", "&", ";", "|", "~", ".", "—", "–", ":"];

describe("BLZ-454: the guide's claim-list separators are exactly what idsFromSubject accepts", () => {
  test("the table is non-empty — a page that documents nothing cannot pin anything", () => {
    const seps = documentedSeparators();
    assert.ok(seps.length >= 2, `parsed ${JSON.stringify(seps)} from the guide`);
    assert.equal(new Set(seps).size, seps.length, "no separator listed twice");
  });

  test("every separator the page documents IS accepted", () => {
    for (const sep of documentedSeparators()) {
      assert.deepEqual(idsFromSubject(`BLZ-1 ${sep} BLZ-2: two tickets`, "BLZ"),
        ["BLZ-1", "BLZ-2"], `the guide documents \`${sep}\` but idsFromSubject refuses it`);
      assert.deepEqual(idsFromSubject(`BLZ-1${sep}BLZ-2: no spaces`, "BLZ"),
        ["BLZ-1", "BLZ-2"], `\`${sep}\` must work unspaced too`);
    }
  });

  test("every separator the page does NOT document is refused", () => {
    const documented = new Set(documentedSeparators());
    const undocumented = PLAUSIBLE.filter((s) => !documented.has(s));
    assert.ok(undocumented.length, "the probe list must still contain something to refuse");
    for (const sep of undocumented) {
      // An unrecognised separator does not merely stop the list — the leading run then
      // fails the `(?=\s*:)` lookahead and NOTHING is claimed at all. Either way, the
      // property the page states is that BLZ-2 is not claimed.
      assert.equal(idsFromSubject(`BLZ-1 ${sep} BLZ-2: two tickets`, "BLZ").includes("BLZ-2"),
        false, `\`${sep}\` is accepted by idsFromSubject but the guide does not document it`);
    }
  });

  test("the bare-number column is true: only `/` continues a list without the key", () => {
    // The page's third column, asserted rather than merely printed. `BLZ-1 + 2026:` must
    // not claim a BLZ-2026 that does not exist.
    for (const sep of documentedSeparators()) {
      const got = idsFromSubject(`BLZ-1 ${sep} 2: desc`, "BLZ");
      if (sep === "/") assert.deepEqual(got, ["BLZ-1", "BLZ-2"], "bare number after `/`");
      else assert.equal(got.includes("BLZ-2"), false, `bare number after \`${sep}\``);
    }
  });

  test("the list still ends at the colon, whatever the separator", () => {
    assert.deepEqual(idsFromSubject("BLZ-1: fixes BLZ-4", "BLZ"), ["BLZ-1"]);
    assert.deepEqual(idsFromSubject("BLZ-1, BLZ-2: also mentions BLZ-9", "BLZ"),
      ["BLZ-1", "BLZ-2"]);
  });
});

describe("BLZ-457: the guide's two corrected claims", () => {
  test("it says RANKING POOL, and no longer says the claim stays among the candidates", () => {
    assert.match(guide, /ranking pool/);
    assert.doesNotMatch(guide, /stays among the candidate pull requests/,
      "`candidates` is the corroborated-only deliverer set — the one collection it is NOT in");
  });

  test("the masked-signal paragraph names BOTH branch and shipped, and scopes shipped cross-repo", () => {
    const para = guide.split("One consequence worth naming:")[1];
    assert.ok(para, "the masked-signal paragraph must still exist");
    const head = para.slice(0, 900);
    assert.match(head, /\*\*branch\*\*/);
    assert.match(head, /\*\*shipped\*\*/);
    assert.match(head, /across\s*\n?\s*\*\*repos\*\*|across repos|cross-repo/i,
      "the shipped case must be scoped: within one repo it cannot arise");
  });
});

// ---------------------------------------------------------------------------------------
// The cross-repo shipped masking, as BEHAVIOUR — the guide's new sentence is a claim about
// the code, so it is proved rather than asserted in prose. `gatherProject` unions every
// repo's `shippedSet` while corroboration is computed per repo (`gatherRepo` builds its
// prMap from its OWN shippedSet), so a ticket shipped in repo B can carry an uncorroborated
// PR in repo A — and `decide`'s uncorroborated arm returns before the `shipped` arm.

function gitInit(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
}

function commit(dir, subject) {
  writeFileSync(join(dir, `${subject.replace(/\W+/g, "_")}.txt`), "x\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", subject]);
}

/** Two code repos for one project. `shipRepoB` decides whether repo B's default branch
 *  carries the `INF-5:` commit that ships the ticket; `prs` is what repo A's `gh` answers
 *  (repo B answers with none). */
function twoRepoBoard(tmp, { shipRepoB, prsInA }) {
  const a = join(tmp, "repo-a"); const b = join(tmp, "repo-b");
  gitInit(a); commit(a, "seed a");
  execFileSync("git", ["-C", a, "remote", "add", "origin", "https://github.com/hjr15/a.git"]);
  gitInit(b); commit(b, "seed b");
  if (shipRepoB) commit(b, "INF-5: the work that actually shipped it");
  execFileSync("git", ["-C", b, "remote", "add", "origin", "https://github.com/hjr15/b.git"]);

  const root = join(tmp, "board");
  const dir = join(root, "projects", "INF", "defined");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "INF-5-t.md"),
    "---\nid: INF-5\ntype: task\nproject: INF\nestimate: 30\n---\n\nbody\n");
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "INF", projects: ["INF"], codeRepos: [a, b] }));

  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
case "$PWD" in
  *repo-a) cat <<'JSON'
${JSON.stringify(prsInA)}
JSON
  ;;
  *) echo '[]' ;;
esac
`);
  execFileSync("chmod", ["+x", join(bin, "gh")]);
  const prev = process.env.PATH;
  process.env.PATH = `${bin}:${prev}`;
  return { root, restore: () => { process.env.PATH = prev; } };
}

// Mentions INF-5 in its ref and claims nothing in its title — a range, the BLZ-440 shape.
const UNCORROBORATED_IN_A = [{ number: 7, state: "OPEN", url: "u7",
  headRefName: "docs-INF-5-notes", title: "docs: kickoff for the INF-1..9 lane" }];

describe("BLZ-457: the shipped signal really is masked, and only across repos", () => {
  test("control: with no PR at all, the cross-repo shipped signal drives the ticket to done", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz457-control-"));
    const { root, restore } = twoRepoBoard(tmp, { shipRepoB: true, prsInA: [] });
    try {
      const r = await reconcile({ root, dryRun: true });
      assert.deepEqual(r.changes.map((c) => `${c.id}:${c.from}->${c.to}`), ["INF-5:defined->done"],
        "the union of shippedSet across repos must move it, or the test below proves nothing");
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an uncorroborated PR in repo A masks repo B's shipped signal", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz457-masked-"));
    const { root, restore } = twoRepoBoard(tmp,
      { shipRepoB: true, prsInA: UNCORROBORATED_IN_A });
    try {
      const r = await reconcile({ root, dryRun: true });
      assert.equal(r.ok, true);
      assert.deepEqual(r.changes, [],
        "BLZ-440's clause returns before the shipped arm — a missed advance, on the safe side");
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("WITHIN one repo the same shape cannot arise — shippedSet is what corroborates", async () => {
    // The other half of the guide's sentence. Ship it in the SAME repo the PR lives in and
    // the PR is corroborated by that repo's own shippedSet, so nothing is masked.
    const tmp = mkdtempSync(join(tmpdir(), "blz457-onerepo-"));
    const repo = join(tmp, "repo-a");
    gitInit(repo); commit(repo, "seed a"); commit(repo, "INF-5: shipped right here");
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/hjr15/a.git"]);
    const root = join(tmp, "board");
    const dir = join(root, "projects", "INF", "defined");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "INF-5-t.md"),
      "---\nid: INF-5\ntype: task\nproject: INF\nestimate: 30\n---\n\nbody\n");
    writeFileSync(join(root, "blaze.config.json"),
      JSON.stringify({ key: "INF", projects: ["INF"], codeRepos: [repo] }));
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"),
      `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(UNCORROBORATED_IN_A)}\nJSON\n`);
    execFileSync("chmod", ["+x", join(bin, "gh")]);
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    try {
      const r = await reconcile({ root, dryRun: true });
      assert.deepEqual(r.changes.map((c) => `${c.id}:${c.from}->${c.to}`),
        ["INF-5:defined->in-review"],
        "the PR is corroborated by this repo's own shippedSet, so it is not neutered at all");
    } finally {
      process.env.PATH = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
