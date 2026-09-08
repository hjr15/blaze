// tests/model/seam-closure.test.mjs — BLZ-275, ADR-0009.
//
// A structural guard, not a behavioural one. ADR-0009 says every read goes through
// the driver; nothing in the suite enforced that, so the next person to need "just
// one quick walk" would reintroduce a bypass with a green suite — which is exactly
// how contentHash survived four earlier slices unnoticed.
//
// BLZ-535: the write-seam guard at the bottom of this file no longer names the functions it
// is looking for. It derives the mutating half of `node:fs` from `node:fs` — see the banner
// above it for why, and for how that remedy differs from BLZ-521's on the fd guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync,
  // BLZ-535 F5a: the corpus-scope case needs a throwaway tree of its own
  mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// the whole surface of both fs modules, for BLZ-535's derived write-seam ledger
import * as fsCallbacks from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
// BLZ-535: a devDependency, never a dependency. This package ships zero runtime deps, and
// this parser is loaded by one TEST. See the banner below for why a parser and not a reader.
import { parse } from "acorn";

const SCRIPTS = join(fileURLToPath(new URL("../../scripts", import.meta.url)));

// The seam itself, and the one module that owns the filesystem walk.
const SEAM = new Set(["model/index.mjs", "model/read-storage.mjs"]);

// Every extension Node will EXECUTE from this tree. The package is `"type": "module"`, so a
// `.js` file under `scripts/` runs as ESM exactly like an `.mjs` one — and was invisible to
// this guard until BLZ-535's second pass. `.cjs` is here for the same reason: a file the
// guard cannot see is a file the seam does not cover. Non-JS reach (`scripts/ci/smoke.sh`
// and the one `.py`) is out of scope and stated in the banner below.
const EXECUTABLE_JS = /\.(?:mjs|cjs|js)$/;

function* jsFiles(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { yield* jsFiles(p); continue; }
    if (EXECUTABLE_JS.test(e)) yield p;
  }
}

/** Every function CALLED in a module, by the name at the callee — `f()` and `o.f()` alike.
 *  A call, not a mention in prose: comments and error strings legitimately name these, and
 *  a parser tells the two apart without a comment-stripping regex that a `//` inside a
 *  string or a regex literal can derail. A module that does not parse is REPORTED. */
function callsIn(raw) {
  const { ast } = parseModule(raw);
  if (!ast) return { called: new Set(), unreadable: true };
  const called = new Set();
  for (const node of astIndex(ast).nodes) {
    if (node.type !== "CallExpression" && node.type !== "NewExpression") continue;
    const callee = node.callee;
    if (callee.type === "Identifier") called.add(callee.name);
    else if (callee.type === "MemberExpression" && !callee.computed) {
      called.add(nameOf(callee.property));
    }
  }
  return { called, unreadable: false };
}

test("no module outside the seam calls walkTickets", () => {
  const offenders = [];
  for (const file of jsFiles(SCRIPTS)) {
    const rel = relative(SCRIPTS, file).split("\\").join("/");
    if (SEAM.has(rel)) continue;
    const { called, unreadable } = callsIn(readFileSync(file, "utf8"));
    if (unreadable || called.has("walkTickets")) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    "ADR-0009: reads go through the driver. Add a named operation to read-storage.mjs " +
    "instead of walking the corpus directly.");
});

test("no module outside the seam stats or lists the projects tree directly", () => {
  // contentHash did exactly this for four slices without anyone noticing, at 35.4 ms
  // per poll per open tab. This is the guard that would have caught it.
  const ALLOWED = new Set([
    "model/index.mjs", "model/read-storage.mjs",
    "model/storage.mjs",        // the WRITE seam owns file creation
    "model/ids.mjs", "model/claims.mjs",  // the allocator, deleted at Phase 2
    "model/transitions.mjs",    // git rename history, not the ticket store
    "model/sprints.mjs", "config.mjs",    // registries, not tickets
    "migrate/jira-import.mjs",  // a migration path, not a live verb
    "loops/groomer.mjs",        // hashes file text against git porcelain
    "pending-ledger.mjs", "commit-lock.mjs", "reindex.mjs", "supervisor.mjs",
  ]);
  const offenders = [];
  for (const file of jsFiles(SCRIPTS)) {
    const rel = relative(SCRIPTS, file).split("\\").join("/");
    if (ALLOWED.has(rel) || rel.startsWith("ci/")) continue;
    const { called, unreadable } = callsIn(readFileSync(file, "utf8"));
    if (unreadable || called.has("readdirSync") || called.has("statSync")) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    "a bespoke directory walk outside the seam is how contentHash hid for four slices");
});

// =============================================================================
// BLZ-535 — the WRITE seam, pinned as a PROPERTY rather than as a list of spellings.
//
// The guard this replaces matched `writeFileSync(` and `renameSync(`. MEASURED: a LIVE
// `appendFileSync(` in non-allowlisted `scripts/reconcile.mjs` left it at 3 pass / 0 fail —
// which is why a FIFO-hang defect shipped past the guard that exists to catch it and had to
// be caught by review. Replacing two spellings with twenty would only move the hole, so the
// list is not hand-written at all: the MUTATING surface is derived at run time from what
// `node:fs` and `node:fs/promises` actually export, minus a ledger of the members that
// cannot change a filesystem entry. It is FAIL-CLOSED — a member nobody here has heard of,
// including one a future Node adds, is a write until this ledger says otherwise.
//
// The FIRST cut of that derivation was still a spelling fix in a property's clothes, and an
// adversarial review drove eleven real writes past it. Every one of those eleven is a case in
// `the eleven routes an adversarial review drove a real write through` below, and each was
// reproduced as a green guard before it was fixed. They were five CATEGORIES, not eleven
// bugs, and the categories are what changed:
//
//   1. NON-FUNCTION MEMBERS WERE INVISIBLE. The surface admitted a member only when
//      `typeof mod[name] === "function"`, so `fs.promises` — an OBJECT — never entered it,
//      and `promises.writeFile`, `fs.promises.writeFile` and a default import's
//      `fs.promises.writeFile` were exempt everywhere. The derivation now keys on the NAME:
//      a member is inert only if the read-only ledger or `INERT` vouches for it, a member
//      whose value is a nested fs namespace is WALKED, and everything else — a function, an
//      `undefined`, anything — is a write. That also settles the platform question:
//      `lchmodSync` is `undefined` on Linux and a function on macOS, and it is in the surface
//      on both because the derivation never asks what it is, only what it is called.
//
//   2. MEMBER ACCESS WAS DOT-ONLY, AND STRINGS WERE GONE BEFORE THE READ. `fs["writeFileSync"]`
//      became `fs[""]` and matched nothing, and neither did `fs["write" + "FileSync"]`, an
//      evaluated template, an array `.join("")`, or `const { writeFileSync } = fs`. A
//      COMPUTED member access on an fs namespace is now an offence in itself — the guard
//      cannot evaluate it, so it will not pass it — and destructuring off a namespace is
//      read as the binding it is, to a fixpoint, so `const { promises: p } = fs` followed by
//      `p.writeFile` is seen.
//
//   3. ACQUISITION WAS ANCHORED ON TOKEN NAMES. Bare `"fs"` counted only after `from` or
//      `import(`/`require(`, so `createRequire(import.meta.url)("fs")` matched neither and
//      the whole scan came back clean. Source is now TOKENISED rather than regexed: every
//      string literal is extracted with its VALUE and its POSITION, so an fs specifier is
//      classified by where it sits. After `from` it is an import or a re-export; in a call's
//      argument position it is an acquisition whatever the callee is called; in one of a
//      short list of value positions (a comparison, a `??`, an object property) it is data,
//      because `BLAZE_WRITE_PORT` really is set to the string "fs" in four modules here; and
//      ANYWHERE ELSE IT IS REPORTED. That last clause is the fail-closed one, and only the
//      bare `"fs"` spelling gets the data exemption at all — every other spelling names
//      node:fs and nothing else, so `const S = "node:fs"` is an offence where it sits.
//
//   4. `export { writeFileSync } from "node:fs"` YIELDED ZERO BINDINGS and still satisfied
//      the fail-closed arm, so a two-file chain — a re-exporting helper plus a consumer —
//      wrote to disk with the guard at exit 0. A re-export is now read as the binding it
//      hands on: named members register as writes, and `export *`, `export * as ns` and
//      `export { default as fs }` register as re-exporting node:fs wholesale.
//
//   6. FOUND WHILE ATTACKING THIS FIX RATHER THAN BY THE REVIEW, and all four are the two
//      categories above meeting a spelling the first pass of the fix had not met: a specifier
//      built by `+` or by an array `.join("")`, a specifier parked in a `const` and imported
//      through the variable, and `{ ...fs }` — a SPREAD, whose three dots the namespace
//      lookbehind read as a member access and skipped. Each has a case below.
//
//   5. THE CORPUS WAS NARROWER THAN THE TREE. `.mjs` only, in a `"type": "module"` package
//      where a `.js` file runs identically, and `ci/` skipped outright — where
//      `scripts/ci/mutate-schedule.mjs` has held a live `writeFileSync`, `rmSync` and
//      `cpSync` the whole time. Both are closed: the corpus is every executable JS extension
//      and `ci/` is scanned like everything else, with `mutate-schedule.mjs` allowlisted by
//      name and reason below.
//
// HOW THIS DIFFERS FROM BLZ-521, which is the same "pins a spelling" defect one layer down
// (`tests/read-path-fifo.test.mjs`, the fd guard). Two different remedies, deliberately:
//   * THIS guard is STRUCTURAL and corpus-wide — WHICH MODULES may reach node:fs at all. The
//     property is a set membership over a whole tree, there is no behaviour to run, and the
//     evasion is a name. So the remedy is to stop naming names: enumerate the surface.
//   * BLZ-521's guard is BEHAVIOURAL and single-function — HOW ONE function decides a file's
//     type. There the property is observable by running it, so the remedy there is to stop
//     reading the source at all and make the path and the descriptor DISAGREE, which no
//     rename can survive. Enumerating a surface would not have pinned it; running it does.
//
// ROUND 3 — TWO FINDINGS THAT MADE EVERY CLAIM ABOVE UNSOUND, and what changed for each.
//
//   B1. THE READER WAS A HAND-ROLLED TOKENISER, and it decided whether a `/` opened a REGEX
//      or was a DIVISION by looking at the previous non-space CHARACTER. After a keyword —
//      `return`, `case`, `typeof`, `in`, `await`, `yield`, `else`, `do` — that character is a
//      letter, so `return /'/.test(x)` was read as a division followed by a string that
//      never closed, and the reader then swallowed everything up to the next quote ANYWHERE
//      IN THE FILE. Imports included. MEASURED on 718d362: one module holding that line
//      above an `appendFileSync` import wrote 19 bytes to /tmp while this file reported 9
//      tests, 9 pass, 0 fail, exit 0. Not a spelling that slipped past — a whole module the
//      guard had stopped reading, with no sign that it had.
//      The remedy is not a better heuristic. There is no character-local answer to that
//      question, which is why every JS parser tracks it in the grammar. So the reader is now
//      `acorn`, a DEVDEPENDENCY (this package ships zero runtime dependencies and the parser
//      is loaded by one test), and everything below is classified by its POSITION IN THE AST
//      rather than by the characters around it. A module that does not parse is an OFFENCE,
//      never a skip: a guard that goes quiet on what it cannot read has a documented way to
//      be blinded — ship it a file it chokes on.
//      Two more holes closed with it, both of them "the reader erased it": a call inside a
//      TEMPLATE SUBSTITUTION (`` `${fs.writeFileSync(p, d)}` `` executed and was never
//      looked at, because `${` skipped to the matching brace), and `import("node:fs").then(
//      m => m.writeFileSync(...))`, where the namespace never lands in a binding at all.
//
//   B4. A WRITE REPACKAGED BY A LOCAL MODULE was conceded in this banner as invisible "and
//      always will be" — directly under the claim that no module outside the allowlist can
//      reach a write. Both could not be true, and on main the second was the false one:
//      `scripts/reconcile.mjs` imports `appendRegularFileSync` from `model/regular-file.mjs`
//      and hands it a caller-supplied path, and reconcile.mjs was not on the list. The
//      concession is withdrawn rather than the claim weakened: the seam's own primitives are
//      PINNED, by name, in `SEAM_WRITE_PROVIDERS`, and importing one from a module the
//      allowlist does not name is an offence under the member's own name. reconcile.mjs is
//      now listed, narrowly, with its reason.
//      That pin is EXACT, and it is the one place in this file where exactness is the point
//      (B5): every export of a provider must be classified as a write or a read, and a new
//      export nobody has classified reddens the pin test AND is rejected by name at every
//      consumer. The node:fs surface stays DERIVED for the opposite reason — Node's surface
//      is not ours to pin, so an unknown member there is a write.
//      `model/storage.mjs` and the write ports are deliberately not pinned this way. They are
//      the DRIVER: ADR-0006 says ticket writes go THROUGH them, so importing one is the
//      sanctioned route. What is guarded is the raw path-taking primitive underneath.
//
// ROUND 5 — THREE MORE, and the class they share: round 4 stopped pinning the CALLEE's
// spelling and started pinning the LITERAL's. Same defect, one layer down.
//
//   D1. AN ACQUISITION WAS ONLY EXAMINED WHEN ITS SPECIFIER WAS A PLAIN STRING `Literal`.
//      `process.getBuiltinModule(`node:fs`)` — backticks — landed a real file with the guard
//      at 12 pass / 0 fail, while the SAME LINE in double quotes reddened it. Backtick versus
//      quote was the whole difference. So did `require(`node:fs`)`, so did
//      `require(["f", "s"].join(""))` with no fs literal anywhere in the file, and so did a
//      specifier parked in a variable — `const mode = env.BLAZE_WRITE_PORT ?? "fs"` copied
//      verbatim out of this file's own innocent list, where the literal really is data and
//      the VARIABLE is what carries it.
//      Two changes. The reader FOLDS constants — a template with no substitution, a `+` of
//      constants and an array `.join()` of constants are one VALUE, and the value is judged —
//      so the first three are ordinary specifiers again. And what will not fold is not
//      waved through: a call whose arguments this reader cannot fold is a possible
//      acquisition whatever the callee is called, so its RESULT is watched, and reaching a
//      mutating member or a nested fs namespace through it is an offence.
//
//   D2. THE PIN WAS DEFEATED BY THREE CHARACTERS. `resolveProvider` joined path segments and
//      looked the result up in a Map, so `"./model/regular-file.mjs?v=1"` — the same module
//      to Node, a different key to a Map — reopened the whole of B4. A `?query` or
//      `#fragment` is stripped before the lookup now, and before an fs specifier is matched.
//
//   D3. B4 WAS CLOSED FOR ONE MODULE OUT OF SIXTEEN. The pin named `model/regular-file.mjs`
//      and defended the rest with a general claim — "an allowlisted module's exports are, by
//      construction, the sanctioned route" — which was self-refuting, because regular-file.mjs
//      is itself `*`-allowlisted and was pinned anyway. MEASURED: `saveState("/tmp/X", {})`,
//      out of `*`-allowlisted `loops/groomer.mjs`, created a file from a module the allowlist
//      does not name, at 12 pass / 0 fail. `restoreSnapshot`, `appendEntry`, `acquireLock`,
//      `issueSetupToken` and `saveSprints` are the same shape.
//      The general claim is gone. Every module the allowlist names is now pinned — membership
//      DERIVED from the allowlist, so exempting a module without judging its exports is
//      itself an offence — and every export of every one of them is classified as a write
//      primitive, as sanctioned, or as inert. Seven consumers of those primitives joined the
//      allowlist, each named to the members it takes and each with its reason.
//      Neither the classification nor the coverage is taken on trust: a reachability walk
//      over each module decides which of its exports actually put bytes on disk, and the pin
//      must agree with it exactly, both ways.
//
// THIS FILE HARD-DEPENDS ON `acorn`, and that is a failure mode worth naming: without
// `npm ci` the whole file dies at import with ERR_MODULE_NOT_FOUND — 1 test, 1 fail — which
// is a MISSING GUARD wearing the clothes of a failing one. It is a devDependency, `npm ci`
// installs it in every workflow that runs the suite, and the two workflows that skip
// devDependencies (smoke, build-image) run no tests at all.
//
// WHAT THIS STILL CANNOT SEE, stated rather than left to look total. This guard now parses,
// but it is not a scope analyser and not a linker, and each of those is a hole:
//   * A WRITE REPACKAGED BY A MODULE THE ALLOWLIST DOES NOT NAME. Every module it DOES name
//     is pinned export by export since D3, so that half is closed. A module the allowlist
//     does not name cannot repackage a write without being an offender itself — it would
//     have to reach node:fs to have a write to repackage — so the chain cannot start. What
//     remains is narrower and real: a module could re-export a SANCTIONED verb of an
//     allowlisted module under a new name, and its consumers would see that name rather than
//     the pinned one. The verb still writes only where its own job says.
//   * AN UNFOLDABLE ACQUISITION WHOSE RESULT NEVER NAMES AN FS MEMBER. Constants fold now, so
//     `"node:" + "fs"`, `` `node:fs` `` and `["f", "s"].join("")` are all reported, fragment
//     or no fragment. What is not reported is `const fs = getBuiltinModule(mode)` followed by
//     `fs[k](p, d)` or `registerBackend(fs)`: a COMPUTED access on a call result occurs 112
//     times in this tree as ordinary code, and reporting all of them would get the guard
//     deleted. Reaching a NAMED mutating member through such a binding IS reported, and that
//     is every shape the review drove a write through.
//   * CODE INSIDE A STRING. `eval` and `new Function` take a string, and a string is a leaf
//     to a parser. `eval('import("node:fs").then(m => m.writeFileSync(a, b))')` is the one
//     route in the self-attack battery that this guard does not see. A template
//     SUBSTITUTION is no longer in that hole: its interior is real syntax and is walked.
//   * SHADOWING. A local `const fs = {}` in an inner scope of a module that also has
//     `import * as fs from "node:fs"` is read as the fs namespace: the walk is over
//     identifier NAMES, not resolved bindings. The guard errs toward REPORTING, so this is
//     noise rather than blindness.
//   * A PLATFORM-CONDITIONAL EXPORT KEY. The surface is derived from the Node this run is
//     on. `lchmodSync` is safe — it is a KEY on Linux even though its value is `undefined` —
//     but a member some other platform exports and this one does not name at all would be
//     missed. Every member of the surface is asserted below to be a name, not a value.
//   * ANOTHER LANGUAGE OR ANOTHER PROCESS. `scripts/ci/smoke.sh` and the `.py` under
//     `scripts/` are not read, and neither is anything a `spawnSync`ed child does.
// =============================================================================

/** The READ-ONLY half of `node:fs`: members that cannot create, modify, replace or remove a
 *  filesystem entry. This is the only hand-written list in the guard, and it is the half
 *  where being wrong is SAFE — forgetting an entry here makes the guard noisier, never
 *  blinder. Names cover both the callback and the promises module, whose members share them.
 *  Every entry is asserted below to be a name one of those modules actually has, so a stale
 *  entry (`StatFs` and `Stream` were two, until this test looked) cannot sit here reading
 *  like coverage. */
const NON_MUTATING = new Set([
  "Dir", "Dirent", "FileReadStream", "ReadStream", "Stats",
  "_toUnixTimestamp", "access", "accessSync", "close", "closeSync", "createReadStream",
  "exists", "existsSync", "fstat", "fstatSync", "glob", "globSync", "lstat", "lstatSync",
  "openAsBlob", "opendir", "opendirSync", "read", "readFile", "readFileSync", "readSync",
  "readdir", "readdirSync", "readlink", "readlinkSync", "readv", "readvSync", "realpath",
  "realpathSync", "stat", "statSync", "statfs", "statfsSync", "unwatchFile", "watch",
  "watchFile",
]);

/** The one member that is neither a function nor a namespace and still cannot mutate
 *  anything: `constants` is a bag of integers. Nothing else gets this exemption — a member
 *  whose value is `undefined` on this platform is a NAME that is a function on another, and
 *  is a write. */
const INERT = new Set(["constants"]);

/** An fs member is a NESTED NAMESPACE — something to walk into rather than classify — when
 *  it is an object that carries functions of its own. That is `promises` and `default` today
 *  and it is derived, not listed: `constants` fails it because it holds only integers. */
function isFsNamespace(value) {
  return typeof value === "object" && value !== null
    && Object.values(value).some((v) => typeof v === "function");
}

/** The mutating surface of the given fs modules, the namespace-valued member names that lead
 *  to more of it, and every member NAME they expose at any depth.
 *
 *  Classification is by NAME, never by `typeof`. That is the whole of BLZ-535's second pass:
 *  the first cut asked `typeof mod[name] === "function"`, which silently dropped `promises`
 *  (an object, and the doorway to every promise-form write) and `lchmodSync` (`undefined` on
 *  Linux, a function on macOS — a surface that differed between a laptop and CI). */
function deriveSurface(mods) {
  const write = new Set(); const namespaces = new Set(); const members = new Set();
  const walked = new Set();
  const walk = (mod) => {
    if (walked.has(mod)) return;
    walked.add(mod);
    for (const name of Object.keys(mod)) {
      let value; try { value = mod[name]; } catch { value = undefined; }
      members.add(name);
      if (isFsNamespace(value)) { namespaces.add(name); walk(value); continue; }
      if (NON_MUTATING.has(name) || INERT.has(name)) continue;
      write.add(name);
    }
  };
  for (const mod of mods) walk(mod);
  return { write, namespaces, members };
}
const { write: WRITE_SURFACE, namespaces: FS_NAMESPACE_MEMBERS, members: FS_MEMBERS } =
  deriveSurface([fsCallbacks, fsPromises]);

/** Parse a module with acorn. EVERY executable file in this tree is ESM under
 *  `"type": "module"`, but a `.cjs` file is a script, so both goals are tried before giving
 *  up — and giving up is an OFFENCE, never a skip. This is the whole of BLZ-535's third
 *  pass: the reader this replaces was a hand-rolled tokeniser that decided whether a `/`
 *  opened a regex by looking at the previous non-space CHARACTER. After `return`, `case`,
 *  `typeof`, `yield`, `in` and `await` the previous character is a letter, so `return /'/`
 *  was read as a division followed by an unterminated string — and the tokeniser then ate
 *  the rest of the file. MEASURED on the commit before this one: a module holding
 *  `return /'/.test(x)` above an `appendFileSync` import wrote 19 bytes to /tmp while this
 *  file reported 9 pass / 0 fail at exit 0. A parser has no such state to lose. */
function parseModule(raw) {
  const options = {
    ecmaVersion: "latest", allowHashBang: true,
    allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
  };
  let error = null;
  for (const sourceType of ["module", "script"]) {
    try { return { ast: parse(raw, { ...options, sourceType }) }; }
    catch (e) { error ??= e; }
  }
  return { error };
}

const AST_SKIP_KEYS = new Set(["type", "start", "end", "loc", "range"]);

/** The three declarations that carry a module specifier of their own. A specifier literal
 *  sitting in one of these is judged as the import or re-export it is, not as a loose
 *  literal — and `import(...)`, which also has a `.source`, is deliberately NOT one of them. */
const DECLARATION_TYPES = new Set([
  "ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration",
]);

/** Every node of the tree, and each node's parent. The classification below is entirely
 *  positional — a name means one thing as a member and another as a binding — so the parent
 *  link is what replaces the old reader's "what character came before this one". */
function astIndex(ast) {
  const parents = new Map(); const nodes = [];
  const visit = (node, parent) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const child of node) visit(child, parent); return; }
    if (typeof node.type !== "string") return;
    parents.set(node, parent); nodes.push(node);
    for (const key of Object.keys(node)) {
      if (AST_SKIP_KEYS.has(key)) continue;
      visit(node[key], node);
    }
  };
  visit(ast, null);
  return { parents, nodes };
}

/** The constant string an expression evaluates to, or null when this reader cannot fold it.
 *  BLZ-535 ROUND 5, D1: the previous cut examined a specifier only when it was a plain string
 *  `Literal`, so it had stopped pinning the CALLEE's spelling and started pinning the
 *  LITERAL's — same defect, one layer down. `process.getBuiltinModule(`node:fs`)` with
 *  backticks landed a real file with the guard green while the same line in double quotes
 *  reddened it. Backtick versus quote was the whole difference. Folding removes the
 *  question: a template with no substitution, a `+` of constants and an array `.join()` of
 *  constants are all the same VALUE, and the value is what is judged. */
function constantString(node) {
  if (!node) return null;
  switch (node.type) {
    case "Literal": return typeof node.value === "string" ? node.value : null;
    case "TemplateLiteral":
      return node.expressions.length === 0
        ? node.quasis.map((q) => q.value.cooked ?? "").join("") : null;
    case "BinaryExpression": {
      if (node.operator !== "+") return null;
      const left = constantString(node.left); const right = constantString(node.right);
      return left === null || right === null ? null : left + right;
    }
    case "CallExpression": {
      const callee = node.callee;
      if (callee.type !== "MemberExpression" || callee.computed) return null;
      if (nameOf(callee.property) !== "join" || callee.object.type !== "ArrayExpression") return null;
      const sep = node.arguments.length === 0 ? "," : constantString(node.arguments[0]);
      if (sep === null) return null;
      const parts = callee.object.elements.map((e) => constantString(e));
      return parts.some((part) => part === null) ? null : parts.join(sep);
    }
    default: return null;
  }
}

/** Every spelling of an fs specifier. A specifier is a CONSTANT STRING WHOSE VALUE IS ONE OF
 *  THESE, so `"expected 'fs', 'dual' or 'db'"` is one string that is not any of them rather
 *  than a substring match waiting to happen. A `?query` or `#fragment` suffix is stripped
 *  first: Node tolerates one on a specifier, and a map lookup does not (D2). */
const FS_SPECIFIERS = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const withoutSuffix = (spec) => spec.split("?")[0].split("#")[0];
const isFsSpecifier = (value) => typeof value === "string" && FS_SPECIFIERS.has(withoutSuffix(value));

/** The ONE spelling that is also a value in this tree: BLAZE_WRITE_PORT is set to the string
 *  "fs", compared and defaulted in four modules, so bare `"fs"` gets a data exemption and has
 *  to. Every other spelling names node:fs and nothing else, so it gets NO exemption: a
 *  `const S = "node:fs"` that some later line hands to `import(S)` is reported where it sits,
 *  because this reader does not fold constants and will not pretend the literal is inert. */
const AMBIGUOUS_SPECIFIER = new Set(["fs"]);

/** The three positions in which a bare `"fs"` is DATA rather than an acquisition, and they
 *  are the three this tree actually contains: `env.BLAZE_WRITE_PORT ?? "fs"`, `mode === "fs"`
 *  and `{ name: "fs" }`. Everything else — a call argument, an array element, a `+`, a bare
 *  `const S = "fs"` — is REPORTED. The old reader answered this question with a regex over
 *  the preceding characters; the parent node answers it exactly. */
function isDataPosition(node, parent) {
  if (!parent) return false;
  if (parent.type === "LogicalExpression") return true;
  if (parent.type === "BinaryExpression") {
    return ["==", "===", "!=", "!=="].includes(parent.operator);
  }
  if (parent.type === "Property") return parent.value === node && !parent.computed;
  return false;
}

/** A member name that would take a value INTO the fs surface: a mutating member, or one of
 *  the nested namespaces that leads to the whole surface a second time. Used to decide
 *  whether an acquisition this reader could not fold matters. */
function reachesFsSurface(name) {
  return name !== null && (WRITE_SURFACE.has(name) || FS_NAMESPACE_MEMBERS.has(name));
}

// The offences that are not a member name. Each is a construct the reader CANNOT resolve, and
// each is reported rather than skipped — a guard that goes quiet on what it does not
// understand is not a guard.
const OPAQUE = "node:fs acquired in a shape this guard cannot read";
const WHOLESALE = "node:fs re-exported wholesale";
const COMPUTED = "a computed member access on an fs namespace";
const ESCAPE = "an fs namespace escaping where this guard cannot follow it";
const SEAM_WHOLESALE = "the write seam's own primitives taken wholesale";
const unparseable = (why) => `a module this guard cannot parse, so cannot judge: ${why}`;
const unreadableClause = (part) => `an fs binding clause this guard cannot read: ${part}`;
const unknownMember = (name) => `an unknown member \`${name}\` on an fs namespace`;
const unknownSeamMember = (name) => `an unpinned member \`${name}\` of the write seam`;

/** BLZ-535 B4/B5, widened in round 5 by D3. Every module the write allowlist names, and the
 *  disposition of EVERY name it exports. Round 4 pinned ONE of them — `regular-file.mjs` —
 *  and defended the other fifteen with a general claim ("an allowlisted module's exports are,
 *  by construction, the sanctioned route") that was self-refuting: regular-file.mjs is itself
 *  `*`-allowlisted and was pinned anyway, precisely because it takes a caller-supplied path.
 *  MEASURED: `import { saveState } from "./loops/groomer.mjs"; saveState("/tmp/X", {})`
 *  created a file from a module the allowlist does not name, at 12 pass / 0 fail.
 *
 *  So the general claim is gone and every export is judged, in one of three buckets:
 *
 *    writes     — a WRITE PRIMITIVE: the caller chooses the destination and the content, so
 *                 with it any module can put any bytes anywhere, a ticket included. Importing
 *                 one from a module the allowlist does not name is an OFFENCE, under the
 *                 member's own name, so a narrow exemption can name it.
 *    sanctioned — it writes, and it is the module's OWN verb or the driver's entry point:
 *                 what it writes and where is its job, not its caller's choice. ADR-0006 says
 *                 ticket writes go THROUGH the driver, so the driver's front door cannot be
 *                 the bypass the guard exists to stop. Each is named with what it writes.
 *    inert      — reaches nothing mutating in node:fs at all.
 *
 *  None of those three is taken on trust. `the allowlist's own modules are pinned, export by
 *  export` asserts the union is EXACTLY what the module exports, and `every export that
 *  reaches a write is classified as one` asserts `writes ∪ sanctioned` is EXACTLY what a
 *  reachability walk over the module finds. A new export reddens the first; a write added to
 *  an inert export reddens the second; a `sanctioned` entry that has stopped writing reddens
 *  it too. */
const SEAM_WRITE_PROVIDERS = new Map([
  // The FIFO-safe primitive of ADR-0031: caller's path, caller's bytes. This is the one that
  // was live on main — reconcile.mjs took `appendRegularFileSync` and the guard could not see
  // it. `readRegularFileSync` reaches `openSync`, which is on the mutating surface because
  // `open` can create; this one cannot, because it opens O_RDONLY|O_NONBLOCK and checks the
  // descriptor. That is why it is sanctioned rather than a write, and why it is recorded here
  // instead of quietly excluded.
  ["model/regular-file.mjs", { writes: ["writeRegularFileSync", "appendRegularFileSync"],
    sanctioned: ["readRegularFileSync"], inert: ["NotARegularFileError"] }],
  // The WRITE SEAM itself. `fsStorage` writes every ticket there is — and it is the driver,
  // so importing it is the route ADR-0006 prescribes, not a bypass of it.
  ["model/storage.mjs", { writes: [], sanctioned: ["fsStorage"],
    inert: ["slugify", "ticketPath", "memStorage"] }],
  // The allocator, deleted at Phase 2. `allocateId` and `writeClaim` put a claim file under a
  // caller-supplied projects dir; `ensureCutover` writes the cutover marker.
  ["model/ids.mjs", { writes: ["allocateId"], sanctioned: [], inert: ["maxId", "nextId"] }],
  ["model/claims.mjs", { writes: ["writeClaim", "ensureCutover"], sanctioned: [],
    inert: ["claimDir", "claimPath", "claimedNumbers", "maxClaim", "cutoverPath",
      "readCutover", "remoteMaxClaim"] }],
  // `loadTransitions` refreshes the git-rename cache it reads. `buildTransitions` is pure —
  // the reviewer named it as a write primitive and the reachability walk disagrees, which is
  // the point of having one.
  ["model/transitions.mjs", { writes: [], sanctioned: ["loadTransitions"],
    inert: ["parseTransitions", "buildTransitions"] }],
  // The sprint registry: `saveSprints({ root }, registry)` is caller's root, caller's bytes.
  ["model/sprints.mjs", { writes: ["saveSprints"], sanctioned: [],
    inert: ["SPRINT_REGISTRY_VERSION", "loadSprints", "unstampedRegistryWarning",
      "nextSprintId", "isIsoDate", "validateSprintFields", "addSprint", "setActive",
      "formatSprintList"] }],
  ["reindex.mjs", { writes: [], sanctioned: [], inert: [] }],       // derived caches, no exports
  ["migrate-runner.mjs", { writes: [], sanctioned: [], inert: [] }],
  ["cli.mjs", { writes: [], sanctioned: [], inert: [] }],
  // The pending ledger: an op queue under a caller-supplied root, appended to and cleared.
  ["pending-ledger.mjs", { writes: ["appendEntry", "clearLedger", "quarantineDropped"],
    sanctioned: [], inert: ["sessionId", "queueRoot", "ledgerPath", "readQueue", "readEntries",
      "readForDrain", "quarantinePath", "listQueues", "listQueuesResult", "strandedQueues",
      "worktreeBranchOwners", "belongsHere", "outstandingFiles"] }],
  // The commit lock: a lockfile under a caller-supplied root, taken and released.
  ["commit-lock.mjs", { writes: ["acquireLock", "releaseLock"], sanctioned: [],
    inert: ["lockPath"] }],
  ["migrate/jira-import.mjs", { writes: [], sanctioned: ["runLive"],
    inert: ["loadNormalized", "runDryRun"] }],
  ["migrate/jira-client.mjs", { writes: ["writeRawCache"], sanctioned: [],
    inert: ["cacheFile", "readRawCache"] }],
  // `saveState` and `restoreSnapshot` are the two the reviewer landed a file with: root and
  // contents both come from the caller. `groomOnce` is the groomer's verb.
  ["loops/groomer.mjs", { writes: ["saveState", "restoreSnapshot"], sanctioned: ["groomOnce"],
    inert: ["hashContent", "loadState", "statusDirs", "matchersFor", "selectNextTicket",
      "extractGroomingRules", "buildPrompt", "parseChangedFiles", "isStructuralChange",
      "redactSecrets", "outOfBoundsPaths", "CONFIG_FILE", "DEFAULT_TIMEOUT_SEC",
      "DEFAULT_MAX_BUFFER_MB", "git", "SNAPSHOT_SKIP_DIRS", "SNAPSHOT_SKIP_FILES",
      "snapshotTree", "diffSnapshots", "porcelainLines", "commitMessage"] }],
  ["init-runner.mjs", { writes: [], sanctioned: ["runInit"],
    inert: ["parseArgs", "USAGE", "askHidden"] }],
  // The setup-token credential. All three touch it or the .gitignore line that hides it.
  ["model/setup-token.mjs",
    { writes: ["issueSetupToken", "clearSetupToken", "ensureSetupTokenIgnored"], sanctioned: [],
      inert: ["SETUP_TOKEN_PREFIX", "setupTokenPath", "readSetupToken", "setupTokenMatches",
        "_existsSync"] }],
  ["ci/mutate-schedule.mjs", { writes: ["createSandbox", "discardSandbox"], sanctioned: [],
    inert: ["SANDBOX_CONTENTS", "MUTATIONS"] }],
  ["db-runner.mjs", { writes: [], sanctioned: ["runDb"], inert: ["USAGE"] }],
  // `openIdentityDb` creates .blaze/ at 0700 under a caller-supplied root; `loadIdentity` is
  // the loader that goes through it.
  ["model/identity-db.mjs", { writes: ["openIdentityDb"], sanctioned: ["loadIdentity"],
    inert: ["identityDbPath", "identityExec"] }],
  // `addUser` and `setUserPassword` write to the identity DATABASE, which is node:sqlite and
  // not this guard's surface at all. `ensureIdentityIgnored` appends the .gitignore line.
  ["model/user-admin.mjs", { writes: ["ensureIdentityIgnored"],
    sanctioned: ["addUser", "setUserPassword"], inert: ["USER_VERBS", "parseUserArgv"] }],
  // The soak's artifacts under gitignored .blaze/. `resolveWritePort` is how a verb OBTAINS
  // the driver — the front door again, not a bypass.
  ["model/write-port-resolve.mjs",
    { writes: ["openShadow", "logDivergence", "recordSoakOp"], sanctioned: ["resolveWritePort"],
      inert: ["shadowDbPath", "configDbPath", "divergenceLogPath", "soakStatePath",
        "sqliteExec", "readSoakState", "assertConfigNamespace"] }],
  // Both reach the BLZ_MEASURE census, which is this module's own narrow exemption above.
  // The seven the allowlist gained in round 5, for TAKING a primitive rather than for reaching
  // node:fs. They are pinned on the same terms as everything else it exempts — an exemption
  // whose own exports nobody has judged is how the primitive travels one module further.
  // Each of these exports a VERB: what it writes and where is its job, not its caller's.
  ["commit-runner.mjs", { writes: [], sanctioned: [], inert: [] }],   // a CLI verb, no exports
  ["user-runner.mjs", { writes: [], sanctioned: [], inert: [] }],
  ["sprint-runner.mjs", { writes: [], sanctioned: [], inert: [] }],
  ["commit-or-queue.mjs", { writes: [], sanctioned: ["commitOrQueue"],
    inert: ["commitSuffix"] }],
  ["serve-commit.mjs", { writes: [], sanctioned: ["commitFile"], inert: [] }],
  ["serve.mjs", { writes: [], sanctioned: ["startServer"],
    inert: ["CSRF", "boardModel", "contentHash", "liveModel", "pageHtml",
      "reconcilePreview"] }],
  ["new.mjs", { writes: [], sanctioned: ["applyNew"], inert: [] }],
  ["reconcile.mjs", { writes: [], sanctioned: ["buildBranchMap", "reconcile"],
    inert: ["PR_RANK", "shResult", "decide", "idFromSubject", "idsFromCommitMessage",
      "idsFromSubject", "claimCorroborated", "prTitleClaim", "betterPr", "buildPrMap",
      "ambiguousDeliverers", "remoteHost", "classifyRemote", "parseRemoteUrls", "gatherPrs",
      "recordablePr"] }],
]);

/** Resolve a relative specifier against the importing module's own seam-relative path, so
 *  `./regular-file.mjs` from `model/index.mjs` and `../model/regular-file.mjs` from
 *  `views/data.mjs` are recognised as the same provider. A bare or absolute specifier is not
 *  one of ours and returns null. */
function resolveProvider(rel, spec) {
  if (typeof spec !== "string" || !spec.startsWith(".")) return null;
  // D2. `./model/regular-file.mjs?v=1` is the same module to Node and a different KEY to a
  // Map, and three characters reopened the whole of B4 with the guard at 12 pass / 0 fail.
  const clean = withoutSuffix(spec);
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const out = [];
  for (const part of [...dir.split("/"), ...clean.split("/")]) {
    if (part === "" || part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return SEAM_WRITE_PROVIDERS.get(out.join("/")) ?? null;
}

/** Every name a module exports, read off the AST. Used to hold the pinned seam surface to
 *  exactly what the provider exports — no more, and no less. */
function exportedBindings(raw) {
  const { ast, error } = parseModule(raw);
  if (!ast) throw new Error(`cannot read exports: ${error.message}`);
  const out = new Map();
  for (const node of astIndex(ast).nodes) {
    if (node.type === "ExportDefaultDeclaration") {
      out.set("default", node.declaration.id ? nameOf(node.declaration.id) : "default"); continue;
    }
    if (node.type === "ExportAllDeclaration") {
      const name = node.exported ? nameOf(node.exported) : "*"; out.set(name, name); continue;
    }
    if (node.type !== "ExportNamedDeclaration") continue;
    for (const s of node.specifiers) out.set(nameOf(s.exported), nameOf(s.local));
    const decl = node.declaration;
    if (!decl) continue;
    if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        const name = d.id.type === "Identifier" ? d.id.name : `(${d.id.type})`;
        out.set(name, name);
      }
      continue;
    }
    if (decl.id) out.set(nameOf(decl.id), nameOf(decl.id));
  }
  return out;
}
const exportedNames = (raw) => new Set(exportedBindings(raw).keys());

/** Every node under one node, itself included. */
function subtreeOf(root) {
  const out = [];
  const visit = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (typeof node.type !== "string") return;
    out.push(node);
    for (const key of Object.keys(node)) { if (AST_SKIP_KEYS.has(key)) continue; visit(node[key]); }
  };
  visit(root);
  return out;
}

/** BLZ-535 round 5, D3. The exports of one module that can REACH node:fs's mutating surface:
 *  the binding calls a mutating member itself, or calls something else in the same module
 *  that does, or calls a WRITE PRIMITIVE pinned on another allowlisted module. Walked to a
 *  fixpoint over the module's top-level bindings.
 *
 *  This is what stops the pin below from being 138 assertions nobody can check. A pin says
 *  which exports write; this says which exports DO write; the test asserts they are the same
 *  set. An `inert` claim is therefore checked against the code rather than believed, and a
 *  write added to an inert export reddens without anybody remembering to re-judge it.
 *
 *  It is deliberately INTRA-MODULE. Propagating through every import would mark the whole
 *  tree write-reaching — `blaze new` reaches a write, so does the CLI — which is true and
 *  useless. What the guard is asking is narrower: which of THIS module's exports put bytes
 *  on disk itself. */
function writeReachingExports(raw, rel) {
  const { ast, error } = parseModule(raw);
  if (!ast) throw new Error(`cannot walk ${rel}: ${error.message}`);
  const nodes = astIndex(ast).nodes;
  const writeNames = new Set();   // local names that ARE a write when called
  const fsNs = new Set();
  for (const node of nodes) {
    if (node.type !== "ImportDeclaration") continue;
    const spec = node.source.value;
    const provider = resolveProvider(rel, spec);
    for (const sp of node.specifiers) {
      if (sp.type !== "ImportSpecifier") {
        if (isFsSpecifier(spec)) fsNs.add(sp.local.name);
        continue;
      }
      const imported = nameOf(sp.imported);
      if (isFsSpecifier(spec)) { if (WRITE_SURFACE.has(imported)) writeNames.add(sp.local.name); }
      else if (provider && provider.writes.includes(imported)) writeNames.add(sp.local.name);
    }
  }
  const bindings = new Map();
  for (const stmt of ast.body) {
    const decl = stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration"
      ? stmt.declaration : stmt;
    if (!decl || typeof decl.type !== "string") continue;
    if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
      if (decl.id) bindings.set(decl.id.name, decl);
      continue;
    }
    if (decl.type !== "VariableDeclaration") continue;
    for (const d of decl.declarations) {
      if (d.id.type === "Identifier" && d.init) bindings.set(d.id.name, d);
    }
  }
  const facts = new Map();
  for (const [name, node] of bindings) {
    let writes = false; const calls = new Set();
    for (const n of subtreeOf(node)) {
      if (n.type !== "CallExpression") continue;
      const callee = n.callee;
      if (callee.type === "Identifier") {
        if (writeNames.has(callee.name)) writes = true;
        calls.add(callee.name);
        continue;
      }
      if (callee.type !== "MemberExpression" || callee.computed) continue;
      const member = nameOf(callee.property);
      calls.add(member);
      let base = callee.object;
      if (base.type === "MemberExpression" && !base.computed
        && FS_NAMESPACE_MEMBERS.has(nameOf(base.property))) base = base.object;
      if (base.type === "Identifier" && fsNs.has(base.name) && WRITE_SURFACE.has(member)) writes = true;
    }
    facts.set(name, { writes, calls });
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const fact of facts.values()) {
      if (fact.writes) continue;
      for (const call of fact.calls) {
        if (facts.get(call)?.writes) { fact.writes = true; grew = true; break; }
      }
    }
  }
  const reaching = new Set();
  for (const [exported, local] of exportedBindings(raw)) {
    if (facts.get(local)?.writes) reaching.add(exported);
  }
  return reaching;
}

/** An ESTree name node is an Identifier or — for a string module export name — a Literal. */
function nameOf(node) {
  if (!node) return null;
  return node.type === "Identifier" ? node.name : String(node.value);
}

/** Every mutating fs member a module BINDS, HANDS ON, or reaches through a namespace, plus
 *  every write primitive it takes off the local seam. Binding it is the offence, not calling
 *  it, so there is no `const w = fs.writeFileSync` indirection to hide behind. `rel` is the
 *  module's seam-relative path, and it is load-bearing: it is what a relative specifier is
 *  resolved against. */
function fsWritesIn(raw, rel) {
  const { ast, error } = parseModule(raw);
  if (!ast) return [unparseable(String(error.message).split("\n")[0])];
  const { parents, nodes } = astIndex(ast);

  const hits = new Set();
  const named = new Map();   // a local name -> the fs member it is bound to
  const ns = new Set();      // local names holding an fs namespace
  const seenRef = new Set(); // identifier nodes already classified as a namespace reference

  const classifyMember = (at, name) => {
    if (name === null) { hits.add(COMPUTED); return; }
    if (INERT.has(name)) return;                                  // fs.constants.O_RDONLY
    if (FS_NAMESPACE_MEMBERS.has(name)) { classifyNsUse(at); return; }   // fs.promises...
    if (WRITE_SURFACE.has(name)) { hits.add(name); return; }
    if (NON_MUTATING.has(name)) return;
    hits.add(unknownMember(name));
  };

  const readObjectPattern = (pattern) => {
    for (const prop of pattern.properties) {
      if (prop.type === "RestElement") { hits.add(WHOLESALE); continue; }  // `{ ...all }`
      if (prop.computed) { hits.add(COMPUTED); continue; }   // `{ ["writeFileSync"]: w }`
      const key = nameOf(prop.key);
      if (key === null) { hits.add(unreadableClause(prop.key.type)); continue; }
      let value = prop.value;
      if (value.type === "AssignmentPattern") value = value.left;
      if (value.type === "Identifier") { named.set(value.name, key); continue; }
      if (value.type === "ObjectPattern") {
        if (INERT.has(key)) continue;
        if (FS_NAMESPACE_MEMBERS.has(key)) { readObjectPattern(value); continue; }
        hits.add(unreadableClause(`{ ${key}: { … } }`)); continue;
      }
      hits.add(unreadableClause(value.type));
    }
  };

  /** Bind whatever a namespace-valued expression landed in, so the taint follows the alias. */
  const bindPattern = (target) => {
    if (target.type === "Identifier") { ns.add(target.name); return; }
    if (target.type === "ObjectPattern") { readObjectPattern(target); return; }
    hits.add(unreadableClause(target.type));
  };

  /** One reference to a value that IS an fs namespace, classified by where it sits. */
  const classifyNsUse = (node) => {
    const parent = parents.get(node);
    if (!parent) { hits.add(ESCAPE); return; }
    switch (parent.type) {
      case "MemberExpression":
        if (parent.object !== node) break;              // `other[fs]` — not a member of ours
        if (parent.computed) { hits.add(COMPUTED); return; }
        classifyMember(parent, nameOf(parent.property));
        return;
      case "AwaitExpression": case "ChainExpression": case "ParenthesizedExpression":
      case "SequenceExpression":
        classifyNsUse(parent); return;
      case "VariableDeclarator":
        if (parent.init === node) { bindPattern(parent.id); return; }
        break;
      case "AssignmentExpression":
        if (parent.right === node) { bindPattern(parent.left); return; }
        break;
      case "ExportSpecifier":                            // `export { fs }` — handed on
        hits.add(WHOLESALE); return;
      default: break;
    }
    hits.add(ESCAPE);
  };

  /** Where an identifier is a BINDING SITE rather than a reference: a property name, a
   *  declaration, a parameter, an import clause. Everything else is a use. */
  const isBindingSite = (node, parent) => {
    if (!parent) return false;
    switch (parent.type) {
      case "MemberExpression": return parent.property === node && !parent.computed;
      case "Property": case "MethodDefinition": case "PropertyDefinition":
        return parent.key === node && !parent.computed;
      case "VariableDeclarator": return parent.id === node;
      case "ImportSpecifier": case "ImportDefaultSpecifier": case "ImportNamespaceSpecifier":
        return true;
      case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression":
        return parent.id === node || (parent.params ?? []).includes(node);
      case "ClassDeclaration": case "ClassExpression": return parent.id === node;
      case "LabeledStatement": case "BreakStatement": case "ContinueStatement":
        return parent.label === node;
      default: return false;
    }
  };

  /** Whatever an acquisition — `import(...)`, `require(...)`, `createRequire(...)(...)`, or a
   *  callee nobody has thought of yet — was assigned to. Unassigned is not silence: a
   *  namespace that goes somewhere this reader cannot follow is reported. */
  const bindAcquisition = (valueNode) => {
    let node = valueNode; let parent = parents.get(node);
    while (parent && ["AwaitExpression", "ChainExpression", "ParenthesizedExpression"]
      .includes(parent.type)) { node = parent; parent = parents.get(node); }
    if (!parent) { hits.add(OPAQUE); return; }
    if (parent.type === "VariableDeclarator" && parent.init === node) {
      bindPattern(parent.id); return;
    }
    if (parent.type === "AssignmentExpression" && parent.right === node) {
      bindPattern(parent.left); return;
    }
    if (parent.type === "MemberExpression" && parent.object === node) {
      if (parent.computed) { hits.add(COMPUTED); return; }
      classifyMember(parent, nameOf(parent.property));   // `import("node:fs").then(...)`
      return;
    }
    hits.add(OPAQUE);
  };

  /** A named member taken off the LOCAL write seam, judged against the pinned member set. */
  const classifySeamMember = (provider, name) => {
    if (name !== null && provider.writes.includes(name)) { hits.add(name); return; }
    if (name !== null && (provider.sanctioned.includes(name) || provider.inert.includes(name))) return;
    hits.add(unknownSeamMember(name ?? "computed"));
  };

  const classifyProviderUse = (node, provider) => {
    if (node.type === "ExportAllDeclaration") { hits.add(SEAM_WHOLESALE); return; }
    for (const s of node.specifiers ?? []) {
      if (s.type === "ImportNamespaceSpecifier" || s.type === "ImportDefaultSpecifier") {
        hits.add(SEAM_WHOLESALE); continue;
      }
      classifySeamMember(provider, nameOf(s.type === "ImportSpecifier" ? s.imported : s.local));
    }
  };

  for (const node of nodes) {
    const source = node.source ?? null;
    const isDecl = node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration"
      || (node.type === "ExportNamedDeclaration" && source);

    if (isDecl && source && isFsSpecifier(source.value)) {
      if (node.type === "ImportDeclaration") {
        for (const s of node.specifiers) {
          if (s.type === "ImportSpecifier") named.set(s.local.name, nameOf(s.imported));
          else ns.add(s.local.name);          // a default import IS the namespace, as is `* as`
        }
        continue;                             // no specifiers: `import "node:fs"` binds nothing
      }
      // A re-export HANDS THE BINDING ON: a re-export of a write is a write, here, in this
      // module — otherwise a two-file chain writes to disk with this guard at exit 0.
      if (node.type === "ExportAllDeclaration") { hits.add(WHOLESALE); continue; }
      for (const s of node.specifiers) {
        const imported = nameOf(s.local);
        if (imported === null || FS_NAMESPACE_MEMBERS.has(imported)) { hits.add(WHOLESALE); continue; }
        if (WRITE_SURFACE.has(imported)) hits.add(imported);
        else if (!FS_MEMBERS.has(imported)) hits.add(unknownMember(imported));
      }
      continue;
    }

    if (isDecl && source) {
      const provider = resolveProvider(rel, source.value);
      if (provider) { classifyProviderUse(node, provider); continue; }
    }

    // A dynamic import whose specifier will not FOLD to a constant cannot be read, and is
    // therefore reported: every dynamic import in this tree folds.
    if (node.type === "ImportExpression" && constantString(node.source) === null) {
      hits.add(OPAQUE);
      continue;
    }

    // The value, not the spelling. A plain literal, a backtick template, a `+` chain and an
    // array `.join("")` are one constant here, and D1 turned on exactly that difference.
    const folded = constantString(node);
    if (folded === null) continue;
    const parent = parents.get(node);
    // fold the OUTERMOST expression only, so `"node:" + "fs"` is judged once, as "node:fs"
    if (parent && constantString(parent) !== null) continue;

    if (isFsSpecifier(folded)) {
      if (parent && parent.source === node && DECLARATION_TYPES.has(parent.type)) continue;
      if (parent && parent.type === "ImportExpression" && parent.source === node) {
        bindAcquisition(parent); continue;
      }
      // A specifier in a CALL's argument position, whatever the callee is spelled. That is
      // `require(...)`, `createRequire(import.meta.url)(...)` and
      // `process.getBuiltinModule(...)` alike — pinning the callee's SPELLING is the defect
      // this guard is named after.
      if (parent && parent.type === "CallExpression" && parent.arguments.includes(node)) {
        bindAcquisition(parent); continue;
      }
      if (AMBIGUOUS_SPECIFIER.has(folded) && isDataPosition(node, parent)) continue;
      hits.add(OPAQUE);
      continue;
    }

    const provider = resolveProvider(rel, folded);
    if (provider && parent && ((parent.type === "ImportExpression" && parent.source === node)
      || (parent.type === "CallExpression" && parent.arguments.includes(node)))) {
      // `const { reconcile } = await import("./reconcile.mjs")` names its members exactly as
      // a static import does, so it is judged member by member. Landing anywhere else takes
      // the module wholesale, and that is an offence: nobody can say which member is used.
      let at = parent; let up = parents.get(at);
      while (up && ["AwaitExpression", "ChainExpression", "ParenthesizedExpression"]
        .includes(up.type)) { at = up; up = parents.get(at); }
      const target = up && up.type === "VariableDeclarator" && up.init === at ? up.id
        : up && up.type === "AssignmentExpression" && up.right === at ? up.left : null;
      if (target === null || target.type !== "ObjectPattern") { hits.add(SEAM_WHOLESALE); continue; }
      for (const prop of target.properties) {
        if (prop.type === "RestElement" || prop.computed) { hits.add(SEAM_WHOLESALE); continue; }
        classifySeamMember(provider, nameOf(prop.key));
      }
    }
  }

  // D1's fail-closed arm, and the reason there is one at all: an acquisition is a CALL whose
  // arguments this reader cannot fold, and the callee's spelling is deliberately not
  // consulted — `require`, `createRequire(...)(...)` and `process.getBuiltinModule(...)` are
  // one shape, and the next one has not been invented yet. So the RESULT is watched instead.
  // `require(["f", "s"].join(""))` folds; `getBuiltinModule(mode)` does not, and it is the
  // member reached THROUGH the result that gives it away.
  const unfoldable = new Set();
  for (const node of nodes) {
    if (node.type !== "CallExpression" && node.type !== "ImportExpression") continue;
    const args = node.type === "ImportExpression" ? [node.source] : node.arguments;
    if (!args.some((a) => constantString(a) === null)) continue;
    let at = node; let parent = parents.get(at);
    while (parent && ["AwaitExpression", "ChainExpression", "ParenthesizedExpression"]
      .includes(parent.type)) { at = parent; parent = parents.get(at); }
    if (!parent) continue;
    if (parent.type === "MemberExpression" && parent.object === at && !parent.computed) {
      if (reachesFsSurface(nameOf(parent.property))) hits.add(OPAQUE);
      continue;
    }
    let target = null;
    if (parent.type === "VariableDeclarator" && parent.init === at) target = parent.id;
    else if (parent.type === "AssignmentExpression" && parent.right === at) target = parent.left;
    if (target === null) continue;
    if (target.type === "Identifier") { unfoldable.add(target.name); continue; }
    if (target.type !== "ObjectPattern") continue;
    for (const prop of target.properties) {
      if (prop.type === "RestElement" || prop.computed) continue;
      if (reachesFsSurface(nameOf(prop.key))) hits.add(OPAQUE);
    }
  }
  if (unfoldable.size > 0) {
    for (const node of nodes) {
      if (node.type !== "MemberExpression" || node.computed) continue;
      if (node.object.type !== "Identifier" || !unfoldable.has(node.object.name)) continue;
      if (reachesFsSurface(nameOf(node.property))) hits.add(OPAQUE);
    }
  }

  // A namespace hands out more namespaces (`fs.promises`) and more names
  // (`const { w } = fs`), so resolution runs to a FIXPOINT rather than one level deep.
  for (let grew = true; grew;) {
    grew = false;
    for (const [local, imported] of [...named]) {
      if (FS_NAMESPACE_MEMBERS.has(imported) && !ns.has(local)) { ns.add(local); grew = true; }
    }
    for (const node of nodes) {
      if (node.type !== "Identifier" || !ns.has(node.name) || seenRef.has(node)) continue;
      seenRef.add(node); grew = true;
      const parent = parents.get(node);
      if (isBindingSite(node, parent)) continue;
      classifyNsUse(node);
    }
  }

  for (const imported of named.values()) {
    if (FS_NAMESPACE_MEMBERS.has(imported) || INERT.has(imported)) continue;
    if (WRITE_SURFACE.has(imported)) hits.add(imported);
    else if (!NON_MUTATING.has(imported) && !FS_MEMBERS.has(imported)) {
      hits.add(unknownMember(imported));
    }
  }
  return [...hits].sort();
}

/** `allowed` maps a module to `"*"` (it owns its own files wholesale) or to the exact
 *  members its exemption covers — so a narrow exemption stays narrow. Every named member is
 *  asserted below to still be one the module actually reaches, so a list that has been
 *  widened past what the module does reddens instead of reading as review convention. */
function writeSeamOffenders(sources, allowed) {
  const offenders = [];
  for (const [rel, raw] of sources) {
    const permitted = allowed.get(rel);
    if (permitted === "*") continue;
    const hits = fsWritesIn(raw, rel).filter((h) => !(permitted ?? []).includes(h));
    if (hits.length) offenders.push(`${rel} :: ${hits.join(", ")}`);
  }
  return offenders.sort();
}

/** The corpus the guard runs over: every executable JS file under `scripts/`, by
 *  seam-relative path. `ci/` is IN — it was skipped outright until BLZ-535's second pass,
 *  which is why `ci/mutate-schedule.mjs`'s live `writeFileSync` had never been seen. */
function corpus() {
  const out = new Map();
  for (const file of jsFiles(SCRIPTS)) {
    out.set(relative(SCRIPTS, file).split("\\").join("/"), readFileSync(file, "utf8"));
  }
  return out;
}

// Every module permitted to reach node:fs's mutating surface directly, with the reason.
const WRITE_ALLOWED = new Map([
  ["model/storage.mjs", "*"],                    // the write seam itself
  ["model/ids.mjs", "*"], ["model/claims.mjs", "*"],   // the allocator, deleted at Phase 2
  ["model/transitions.mjs", "*"], ["model/sprints.mjs", "*"],  // caches and registries
  ["reindex.mjs", "*"],                          // derived, gitignored caches
  ["pending-ledger.mjs", "*"], ["commit-lock.mjs", "*"],
  ["migrate/jira-import.mjs", "*"], ["migrate-runner.mjs", "*"],
  ["migrate/jira-client.mjs", "*"], ["loops/groomer.mjs", "*"],
  // BLZ-285. `blaze init` writes blaze.config.json, project.json and .gitignore — config,
  // never a ticket — and it runs BEFORE a board exists, so there is no storage driver to
  // route through.
  ["init-runner.mjs", "*"],
  // BLZ-358. The first-run setup token is a CREDENTIAL, not a ticket: one file under
  // .blaze/, written at mode 0600 and deleted the moment setup completes. Routing it through
  // the storage driver would be wrong on its own terms — the driver exists to put TICKETS
  // where the board keeps tickets, and this must land on local disk at a known path even
  // when the board's storage is Postgres, because the operator reads it with `cat` before
  // any identity exists.
  ["model/setup-token.mjs", "*"],
  // BLZ-493. `model/regular-file.mjs` is the primitive that stops a `writeFileSync` from
  // BLOCKING FOREVER on a FIFO — it opens non-blocking, checks the descriptor's type, and
  // writes to the FD it already holds. It writes no ticket and takes no path from a caller
  // that is not already inside this allowlist. Listed here rather than dodged by using a
  // differently-named fs call, because a guard evaded by renaming is a guard that has
  // stopped working.
  ["model/regular-file.mjs", "*"],
  // BLZ-535. `scripts/ci/` was skipped outright until the corpus was widened, so this
  // module's writes had never been judged. It is the mutation harness: it copies the
  // checkout into a temp directory and mutates THERE, and it is excluded from the published
  // package (`files` in package.json drops `scripts/ci`). Not product code, not a ticket.
  ["ci/mutate-schedule.mjs", "*"],
  // BLZ-535. The four below were invisible to the guard while it pinned two spellings, and
  // are listed now that it does not. None writes a ticket; each is named to its members
  // rather than starred, and the load-bearing test below now checks each NAMED MEMBER is
  // still reached — so the narrowing is a guard, not a review convention.
  //
  // `blaze db init` recreates the gitignored shadow database under .blaze/ — a derived
  // artifact of the dual-write soak, on the same footing as reindex.mjs's caches.
  // ...and `db init` opens the shadow to recreate it, which is write-port-resolve's primitive.
  ["db-runner.mjs", ["rmSync", "openShadow"]],
  // The identity database's own directory: .blaze/ created 0700 and re-tightened. Same
  // credential-store footing as setup-token.mjs, and deliberately NOT in the shadow
  // database, which `db init` may destroy.
  ["model/identity-db.mjs", ["mkdirSync", "chmodSync"]],
  // `blaze user add` appends the identity database to the board's .gitignore, so a
  // credential store cannot be committed. A .gitignore line, not a ticket.
  // ...and it opens the identity database, whose directory the primitive creates at 0700.
  ["model/user-admin.mjs", ["appendFileSync", "openIdentityDb"]],
  // The dual-write soak's divergence log and its counter, both under gitignored .blaze/.
  // BLZ-535 round 5, D1. The third member is not an fs call: `const port = dualWritePort(...)`
  // is a call this reader cannot fold, and `port.write(op)` reaches a member NAME that
  // node:fs also has. It is the dual-write PORT's own method, not `fs.write`, and this is
  // the single place in the tree where D1's fail-closed arm fires on something innocent.
  // Named rather than tuned away: a rule loosened until this module goes quiet is a rule
  // loosened for every module.
  ["model/write-port-resolve.mjs", ["appendFileSync", "mkdirSync", OPAQUE]],
  // `writeSync(2, ...)` — a partial-write loop onto STDERR, which is a terminal, not a file.
  // Named to that one member: a path-taking write appearing in the CLI still reddens.
  ["cli.mjs", ["writeSync"]],
  // BLZ-535 B4 — a LIVE hole on main until this pass, and the reason the banner above used
  // to be false. `reconcile.mjs` imports `appendRegularFileSync` out of
  // `model/regular-file.mjs` and hands it a caller-supplied path, so a module this list did
  // not name reached a write while the banner claimed none could. Nothing about that import
  // was hidden; the guard simply did not look at LOCAL repackagings of a write, and said so
  // in its own banner as though conceding a hole were the same as not having one.
  //
  // Listed rather than removed, and narrowly. The write is the BLZ_MEASURE census: one JSONL
  // line per git probe, to a path the OPERATOR names in the environment, written only while
  // that variable is set and never on a normal run. It is not a ticket, so ADR-0006 has no
  // claim on it, and it must be the FIFO-safe primitive precisely because the operator may
  // point BLZ_MEASURE at anything. Named to that one member: a ticket write, or a second
  // primitive, appearing in reconcile still reddens.
  ["reconcile.mjs", ["appendRegularFileSync"]],
  // BLZ-535 round 5, D3. The seven below take a WRITE PRIMITIVE off an allowlisted module —
  // `saveState`, `appendEntry`, `acquireLock` and their kin, each of which puts caller-chosen
  // bytes at a caller-chosen root. Round 4 could not see any of them, because it pinned one
  // provider out of sixteen and defended the rest with a general claim. None writes a ticket;
  // each is named to the members it actually takes, and the load-bearing test below checks
  // every one of those names is still reached.
  //
  // `blaze commit` owns the commit lock and drains the ledger it has just committed; the
  // quarantine sidecar is BLZ-531's. `commit-or-queue` is the other half: it records an op on
  // the ledger when the lock is held elsewhere. `serve-commit` is the board server taking the
  // same lock.
  ["commit-runner.mjs", ["acquireLock", "releaseLock", "clearLedger", "quarantineDropped"]],
  ["commit-or-queue.mjs", ["appendEntry"]],
  ["serve-commit.mjs", ["acquireLock", "releaseLock"]],
  // First-run setup: the board server issues the setup-token CREDENTIAL, clears it when setup
  // completes, and keeps both it and the identity database out of git. `blaze user add` does
  // the .gitignore half from the CLI side. Same footing as setup-token.mjs and user-admin.mjs
  // themselves, which are allowlisted for the same files.
  ["serve.mjs", ["issueSetupToken", "clearSetupToken", "ensureSetupTokenIgnored",
    "ensureIdentityIgnored"]],
  ["user-runner.mjs", ["ensureIdentityIgnored"]],
  // `blaze new` allocates the id and writes its claim — the allocator, deleted at Phase 2,
  // and on exactly the footing of ids.mjs and claims.mjs above.
  ["new.mjs", ["allocateId", "writeClaim"]],
  // `blaze sprint` saves the sprint registry. A registry, not a ticket.
  ["sprint-runner.mjs", ["saveSprints"]],
]);

test("the mutating fs surface is DERIVED from node:fs, and derived fail-closed", () => {
  // The defect BLZ-535 names is a hand-written list of spellings. This is the test that
  // says there is no longer one: a member this file has never heard of — including one a
  // future Node adds — is classified as a write without anybody editing anything.
  const invented = deriveSurface([{
    readFileSync() {}, statSync() {},              // vouched for by the read-only ledger
    quantumWriteSync() {}, teleportFileSync() {},  // nobody has ever heard of these
    constants: { O_RDONLY: 0 },                    // integers, and the only inert non-function
    lchmodSync: undefined,                         // a NAME here, a function on macOS
    promises: { readFile() {}, quantumWriteFile() {} },  // a nested namespace, to be walked
  }]);
  assert.deepEqual([...invented.write].sort(),
    ["lchmodSync", "quantumWriteFile", "quantumWriteSync", "teleportFileSync"],
    "classification must be by NAME: an fs member the read-only ledger does not vouch for is " +
    "a write whether it is a function, an object's member, or `undefined` on this platform");
  assert.deepEqual([...invented.namespaces], ["promises"],
    "a member holding functions of its own is a namespace to walk, not a leaf to classify");

  for (const name of ["writeFileSync", "renameSync", "appendFileSync", "openSync",
    "mkdirSync", "rmSync", "unlinkSync", "truncateSync", "createWriteStream", "cpSync",
    "writeFile", "cp", "lchmodSync"]) {
    assert.ok(WRITE_SURFACE.has(name), `${name} must be in the derived write surface`);
  }
  for (const name of ["readFileSync", "readdirSync", "statSync", "fstatSync", "existsSync"]) {
    assert.ok(!WRITE_SURFACE.has(name), `${name} reads; it must not be in the write surface`);
  }
  assert.deepEqual([...FS_NAMESPACE_MEMBERS].sort(), ["default", "promises"],
    "`fs.promises` and `fs.default` are the doorways to the whole surface a second time — " +
    "the first cut of this guard admitted only functions, so both were structurally invisible");
  assert.ok(WRITE_SURFACE.size > 55,
    `the surface came out at ${WRITE_SURFACE.size} — that is not node:fs, that is a bug here`);
});

test("the read-only ledger names only members node:fs actually has", () => {
  // A ledger entry for a member that does not exist vouches for nothing and reads as though
  // it does. `StatFs` and `Stream` sat here through the first cut of BLZ-535 — neither is a
  // member of either fs module on Node 24 — and nothing in the suite could tell.
  const stale = [...NON_MUTATING, ...INERT].filter((name) => !FS_MEMBERS.has(name)).sort();
  assert.deepEqual(stale, [],
    "these are vouched for as read-only and are not members of node:fs or node:fs/promises " +
    "at all. Delete them: a ledger nobody can check is a list of spellings again.");
  assert.ok(FS_MEMBERS.size > 90,
    `the walk saw ${FS_MEMBERS.size} member names across both fs modules — that is not node:fs`);
});

test("the eleven routes an adversarial review drove a real write through", () => {
  // Every case below was VERIFIED as a real write to disk while the first cut of this guard
  // exited 0. They are not eleven bugs; they are five categories, named in the banner above.
  // Each is here so the category cannot be reinstated quietly.
  const routes = [
    // 1 — non-function members. `fs.promises` is an OBJECT, so a surface derived by
    // `typeof === "function"` never contained it, and neither did the namespace regex.
    ["F1a promises named-imported",
      'import { promises } from "node:fs";\nawait promises.writeFile(p, d);'],
    ["F1b promises off a namespace import",
      'import * as fs from "node:fs";\nawait fs.promises.writeFile(p, d);'],
    ["F1c promises off a default import",
      'import fs from "node:fs";\nawait fs.promises.writeFile(p, d);'],
    // 2 — member access that is not a dot, and destructuring off the namespace. The old
    // detector required a literal `.`, and the string stripper had already turned
    // `fs["writeFileSync"]` into `fs[""]`.
    ["F2a computed member from concatenation",
      'import * as fs from "node:fs";\nfs["write" + "FileSync"](p, d);'],
    ["F2b computed member from an evaluated template",
      'import * as fs from "node:fs";\nconst k = "FileSync";\nfs[`write${k}`](p, d);'],
    ["F2c computed member from an array join",
      'import * as fs from "node:fs";\nfs[["write", "File", "Sync"].join("")](p, d);'],
    ["F2d destructured off the namespace",
      'import * as fs from "node:fs";\nconst { writeFileSync } = fs;\nwriteFileSync(p, d);'],
    // 3 — acquisition anchored on a token name. `\brequire` does not match `createRequire`,
    // and bare "fs" counted only after `from`/`import(`/`require(`, so the scan found NOTHING
    // and the fail-closed arm never fired.
    ["F3 bare \"fs\" through createRequire",
      'const fs = createRequire(import.meta.url)("fs");\nfs.writeFileSync(p, d);'],
    // 4 — a re-export binds nothing and satisfied the fail-closed arm anyway. Proven
    // end-to-end with a re-exporting helper plus a consumer, both green.
    ["F4 re-export straight out of node:fs",
      'export { writeFileSync } from "node:fs";'],
  ];
  for (const [route, src] of routes) {
    const found = writeSeamOffenders(new Map([["fake.mjs", src]]), new Map());
    assert.equal(found.length, 1, `${route}: this must be an offender, and it is not — ${src}`);
  }

  // 5 — the corpus was narrower than the tree, in two independent ways. Neither is a source
  // pattern, so neither can be a row in the table above.
  //
  // F5a: `"type": "module"`, so a `.js` file under scripts/ executes exactly like an `.mjs`
  // one. The corpus yielded `.mjs` only, so such a file was not scanned at all.
  //
  // Stated plainly, because a widening nobody can see is indistinguishable from one nobody
  // made: the live tree is 150 files and every one of them is `.mjs`, so ONLY the synthetic
  // fixture below exercises this. It is a guard against the day somebody adds `scripts/x.js`,
  // not a claim that anything is being caught today.
  const tmp = mkdtempSync(join(tmpdir(), "blz535-corpus-"));
  try {
    for (const name of ["a.mjs", "b.js", "c.cjs", "d.txt", "e.sh"]) {
      writeFileSync(join(tmp, name), "//\n");
    }
    assert.deepEqual([...jsFiles(tmp)].map((f) => relative(tmp, f)).sort(),
      ["a.mjs", "b.js", "c.cjs"].sort(),
      "F5a: every extension Node will EXECUTE from this tree must be scanned, not `.mjs` alone");
  } finally { rmSync(tmp, { recursive: true, force: true }); }

  // F5b: `ci/` was skipped outright by the offender scan, and `ci/mutate-schedule.mjs` has
  // held a live `writeFileSync`, `rmSync` and `cpSync` the whole time.
  assert.deepEqual(
    writeSeamOffenders(new Map([["ci/x.mjs", 'import { writeFileSync } from "node:fs";\nwriteFileSync(p, d);']]),
      new Map()),
    ["ci/x.mjs :: writeFileSync"],
    "F5b: `ci/` is part of the tree. A module exempted by its DIRECTORY is an exemption " +
    "nobody wrote down — name it in the allowlist, with a reason, or judge it.");
});

test("a write is seen through any spelling, alias, namespace or dynamic import", () => {
  // Each of these is a live write from a module the allowlist does not name. Every one of
  // them was INVISIBLE to the guard this replaces, which matched `writeFileSync(` and
  // `renameSync(` and nothing else.
  const cases = {
    "the spelling that shipped the defect": 'import { appendFileSync } from "node:fs";\nappendFileSync(p, d);',
    "a spelling nobody listed": 'import { truncateSync } from "node:fs";\ntruncateSync(p);',
    "one this file has not thought of either": 'import { lutimesSync } from "node:fs";\nlutimesSync(p, a, m);',
    "an aliased import": 'import { appendFileSync as jot } from "node:fs";\njot(p, d);',
    "a namespace import": 'import * as fs from "node:fs";\nfs.renameSync(a, b);',
    "a default import": 'import fs from "node:fs";\nfs.writeFileSync(p, d);',
    "the promises module": 'import { writeFile } from "node:fs/promises";\nawait writeFile(p, d);',
    "a dynamic import": 'const { rmSync } = await import("node:fs");\nrmSync(p);',
    "the fd route, which needs no *FileSync at all":
      'import { openSync, writeSync } from "node:fs";\nconst fd = openSync(p, "w");\nwriteSync(fd, d);',
    "a reference that is never called, so there is no `(` to match":
      'import * as fs from "node:fs";\nconst w = fs.writeFileSync;\nw(p, d);',
    "an fs acquired in a shape the reader cannot resolve":
      'fs = createRequire(import.meta.url)("node:fs");\nfs.writeFileSync(p, d);',
    "an alias of the namespace itself":
      'import * as fs from "node:fs";\nconst g = fs;\ng.renameSync(a, b);',
    "the promises namespace, aliased":
      'import * as fs from "node:fs";\nconst p2 = fs.promises;\nawait p2.rm(p);',
    "a namespace handed to somebody else entirely":
      'import * as fs from "node:fs";\nregisterBackend(fs);',
    "a member of the namespace this guard cannot classify at all":
      'import * as fs from "node:fs";\nfs.someMemberNoNodeHas(p, d);',
    "a computed key in a destructuring pattern":
      'import * as fs from "node:fs";\nconst { ["writeFileSync"]: w } = fs;\nw(p, d);',
    "a rest element, which copies the whole surface":
      'import * as fs from "node:fs";\nconst { ...all } = fs;\nall.writeFileSync(p, d);',
    "a specifier assembled inside a template":
      'const fs = await import(`node:fs${""}`);\nfs.writeFileSync(p, d);',
    // found while trying to break this guard, not by the review: the literal sits next to a
    // `+`, so it is neither `from`, nor a call argument, nor any position a value takes
    "a specifier concatenated out of pieces":
      'const fs = await import("node:" + "fs");\nfs.writeFileSync(p, d);',
    "a specifier assembled out of an array":
      'const fs = await import(["node:", "fs"].join(""));\nfs.writeFileSync(p, d);',
    "a specifier parked in a variable first":
      'const S = "node:fs";\nconst fs = await import(S);\nfs.writeFileSync(p, d);',
    "the namespace SPREAD into a plain object, which copies every member of it":
      'import * as fs from "node:fs";\nconst box = { ...fs };\nbox.writeFileSync(p, d);',
    "the whole module re-exported": 'export * from "node:fs";',
    "the whole module re-exported under a name": 'export * as fs from "node:fs";',
    "the default re-exported, which is the namespace again":
      'export { default as fs } from "node:fs";',
    // BLZ-535 round 3. The reader this replaces erased a template's interior along with the
    // template — `${` set a flag and it skipped to the matching `}` — so a call written
    // inside a substitution executed at import time and was never looked at.
    "a write inside a template substitution":
      'import * as fs from "node:fs";\nexport const s = `${fs.writeFileSync(p, d)}`;',
    // the namespace never lands in a binding at all: it is the argument of a `.then`
    "a namespace taken straight off a dynamic import's `.then`":
      'import("node:fs").then((m) => m.writeFileSync(p, d));',
    "the builtin module handed over by name rather than imported":
      'const fs = process.getBuiltinModule("node:fs");\nfs.writeFileSync(p, d);',
    // FAIL CLOSED: a module this guard cannot read is a module the seam does not cover, so
    // a parse failure is an OFFENCE. A guard that skips what it cannot parse is a guard with
    // a documented way to become invisible: ship a file it chokes on.
    "a module that does not parse, which is not a module this guard may skip":
      'import { writeFileSync } from "node:fs"\nfunction ( { ;',
    // the bare spelling is the only one with a data exemption, and the exemption is exactly
    // three positions wide. A `"fs"` anywhere else is REPORTED rather than assumed inert —
    // this reader does not follow a variable into a later `import(spec)`.
    "a bare fs specifier parked in a position that is not one of the three data shapes":
      'export const spec = "fs";',
  };
  for (const [why, src] of Object.entries(cases)) {
    const found = writeSeamOffenders(new Map([["fake.mjs", src]]), new Map());
    assert.ok(found.length === 1, `${why}: this must be an offender, and it is not — ${src}`);
  }
});

test("a regex literal does not blind this guard to the rest of the module", () => {
  // BLZ-535 ROUND 3, and the reason there is a parser here at all. The reader this replaces
  // decided whether a `/` opened a regex by looking at the previous non-space CHARACTER.
  // After a KEYWORD that character is a letter, so `return /'/` was read as a division
  // followed by a string that never closed — and everything from there to the next quote in
  // the file, imports included, stopped existing as far as the guard was concerned.
  //
  // MEASURED on 718d362, the commit before this one: `scripts/attack-b1.mjs` holding
  // `return /'/.test(x)` above an `appendFileSync` import wrote 19 bytes to disk while this
  // file reported 9 tests, 9 pass, 0 fail, exit 0. One module, one character, whole file
  // invisible. Each row below is that defect with a different keyword in front of it.
  const afterAKeyword = {
    return: "export function q(x) { return /'/.test(x); }",
    case: "switch (k) { case 1: /'/.test(x); }",
    typeof: "export const t = typeof /'/;",
    in: 'export const i = "k" in /\'/;',
    await: "export const a = await /'/.exec(s);",
    yield: "export function* g() { yield /'/; }",
    else: "if (a) { b(); } else /'/.test(x);",
    do: "do /'/.test(x); while (0);",
  };
  for (const [keyword, prefix] of Object.entries(afterAKeyword)) {
    // the trailing literal is what made the old reader's swallow END, so the damage was a
    // silently invisible MIDDLE rather than an obvious truncation
    const src = `${prefix}\nimport { appendFileSync } from "node:fs";\nappendFileSync(p, d);\n` +
      "export const note = \"it's\";";
    assert.deepEqual(writeSeamOffenders(new Map([["fake.mjs", src]]), new Map()),
      ["fake.mjs :: appendFileSync"],
      `a write below a regex literal after \`${keyword}\` must still be seen — it was not, ` +
      "and that is not a spelling this guard missed, it is a whole module it stopped reading");
  }
});

test("a write primitive taken off the LOCAL write seam is a write", () => {
  // BLZ-535 B4. A live hole on main: `scripts/reconcile.mjs` imports `appendRegularFileSync`
  // from `model/regular-file.mjs` and hands it a caller-supplied path, while every previous
  // cut of this guard CONCEDED IN ITS OWN BANNER that a write repackaged by a local module
  // was invisible "and always will be" — under a banner that also claimed no module outside
  // the allowlist could reach a write. Both could not be true. The concession is withdrawn:
  // the seam's own primitives are pinned, and taking one is an offence under its own name.
  const consumer = (spec, clause) =>
    new Map([["views/consumer.mjs", `import ${clause} from "${spec}";`]]);
  const cases = [
    ["{ appendRegularFileSync }", "appendRegularFileSync"],
    ["{ writeRegularFileSync as jot }", "writeRegularFileSync"],
    ["* as rf", SEAM_WHOLESALE],
    ["rf", SEAM_WHOLESALE],
    // a member nobody has pinned is an offence IN ITSELF — this is the consumer-side half of
    // B5, and it is what makes adding a write primitive to the seam impossible to do quietly
    ["{ truncateRegularFileSync }", unknownSeamMember("truncateRegularFileSync")],
  ];
  for (const [clause, offence] of cases) {
    assert.deepEqual(
      writeSeamOffenders(consumer("../model/regular-file.mjs", clause), new Map()),
      [`views/consumer.mjs :: ${offence}`],
      `\`import ${clause}\` off the write seam must be an offence in the consumer`);
  }
  // ...and the two halves of discrimination: a READ off the same module is not a write, and
  // a function that merely SHARES A NAME, from a module that is not the seam, is not one.
  assert.deepEqual(
    writeSeamOffenders(consumer("../model/regular-file.mjs", "{ readRegularFileSync }"), new Map()),
    [], "a read off the write seam is a read");
  assert.deepEqual(
    writeSeamOffenders(consumer("./local-helpers.mjs", "{ appendRegularFileSync }"), new Map()),
    [], "the SEAM is what is guarded, not the spelling of a function name");
  // the resolution is relative to the IMPORTING module, so the same provider is the same
  // provider from anywhere in the tree
  assert.deepEqual(
    writeSeamOffenders(new Map([["model/x.mjs",
      'import { appendRegularFileSync } from "./regular-file.mjs";']]), new Map()),
    ["model/x.mjs :: appendRegularFileSync"],
    "`./regular-file.mjs` from model/ and `../model/regular-file.mjs` from views/ are one module");
});

test("every module the write allowlist names is pinned, export by export", () => {
  // BLZ-535 round 5, D3. Round 4 pinned ONE module out of sixteen and defended the rest with
  // a general claim. MEASURED against it: `saveState("/tmp/X", {})`, imported out of
  // `*`-allowlisted loops/groomer.mjs by a module the allowlist does not name, created a real
  // file at 12 tests, 12 pass, 0 fail. So the membership is DERIVED from the allowlist
  // itself: a module cannot be exempted from node:fs without its own exports being judged.
  assert.deepEqual([...SEAM_WRITE_PROVIDERS.keys()].sort(), [...WRITE_ALLOWED.keys()].sort(),
    "every module the write allowlist exempts must have its exports classified, and nothing " +
    "else may be. A module exempted from reaching node:fs and NOT pinned here is a module " +
    "whose exports are an unjudged way for anybody to reach one.");

  const sources = corpus();
  const wrong = [];
  for (const [rel, pin] of SEAM_WRITE_PROVIDERS) {
    const src = sources.get(rel);
    if (src === undefined) { wrong.push(`${rel} (no such module)`); continue; }
    const exported = [...exportedNames(src)].sort();
    const pinned = [...pin.writes, ...pin.sanctioned, ...pin.inert];
    const seen = new Set();
    for (const name of pinned) {
      if (seen.has(name)) wrong.push(`${rel} :: ${name} (classified twice)`);
      seen.add(name);
    }
    if (JSON.stringify(exported) !== JSON.stringify([...pinned].sort())) {
      wrong.push(`${rel} (exports [${exported}], pinned [${[...pinned].sort()}])`);
    }
  }
  assert.deepEqual(wrong, [],
    "every export of an allowlisted module must be classified exactly once, as a write " +
    "primitive, as sanctioned, or as inert. A new export nobody has classified is a way " +
    "into the write seam that nobody has judged.");

  // the observation: this pin is not vacuously empty
  const primitives = [...SEAM_WRITE_PROVIDERS.values()].flatMap((p) => p.writes);
  assert.ok(primitives.length > 15,
    `only ${primitives.length} write primitives are pinned across the whole allowlist — ` +
    "that is not this tree, that is a pin that has been emptied");
});

test("an export that reaches a write is pinned as one, and one that does not is not", () => {
  // The pin above is 138 hand-written judgements, and a hand-written judgement nobody checks
  // is the thing this whole ticket exists to delete. So it is checked: a reachability walk
  // over each module decides which of its exports actually put bytes on disk, and the two
  // answers must be the same SET. An `inert` claim is verified rather than believed, a
  // `sanctioned` entry that has stopped writing reddens, and a write added to an inert export
  // reddens without anybody remembering to come back here.
  const sources = corpus();
  const disagreements = [];
  for (const [rel, pin] of SEAM_WRITE_PROVIDERS) {
    const reaching = [...writeReachingExports(sources.get(rel), rel)].sort();
    const claimed = [...pin.writes, ...pin.sanctioned].sort();
    if (JSON.stringify(reaching) !== JSON.stringify(claimed)) {
      disagreements.push(`${rel}: reaches [${reaching}], pinned as writing [${claimed}]`);
    }
  }
  assert.deepEqual(disagreements, [],
    "the pin and the code disagree about which exports reach a write. Re-judge the export: " +
    "a caller-chosen destination makes it a `writes`, the module's own verb makes it " +
    "`sanctioned`, and neither makes it `inert`.");

  // the observation: the walk is not returning an empty set for everything
  assert.ok(writeReachingExports(sources.get("model/storage.mjs"), "model/storage.mjs")
    .has("fsStorage"),
    "the write seam's own driver must come back as write-reaching. If it does not, the walk " +
    "is dead, and a dead walk agrees with every pin there has ever been.");
  assert.ok(writeReachingExports(sources.get("loops/groomer.mjs"), "loops/groomer.mjs")
    .has("saveState"),
    "D3's own case: the groomer's state writer must come back as write-reaching");
});

test("a write primitive is a write wherever it is imported from", () => {
  // B4 in round 4 (regular-file.mjs), D3 in round 5 (the other fifteen), D2 in round 5 (the
  // specifier suffix). Each row is a real write from a module the allowlist does not name.
  const cases = [
    // D3 — the reviewer's own case, and the one that was green on 56fa011
    ["loops/groomer.mjs", "{ saveState }", "saveState"],
    ["loops/groomer.mjs", "{ restoreSnapshot }", "restoreSnapshot"],
    ["pending-ledger.mjs", "{ appendEntry }", "appendEntry"],
    ["commit-lock.mjs", "{ acquireLock }", "acquireLock"],
    ["model/setup-token.mjs", "{ issueSetupToken }", "issueSetupToken"],
    ["model/sprints.mjs", "{ saveSprints }", "saveSprints"],
    ["model/claims.mjs", "{ writeClaim as put }", "writeClaim"],
    ["model/regular-file.mjs", "{ appendRegularFileSync }", "appendRegularFileSync"],
    // the whole module, however it is taken
    ["loops/groomer.mjs", "* as groomer", SEAM_WHOLESALE],
    ["loops/groomer.mjs", "groomer", SEAM_WHOLESALE],
  ];
  for (const [provider, clause, offence] of cases) {
    const src = `import ${clause} from "./${provider}";`;
    assert.deepEqual(writeSeamOffenders(new Map([["fake.mjs", src]]), new Map()),
      [`fake.mjs :: ${offence}`],
      `\`import ${clause}\` from ${provider} must be an offence in the consumer`);
  }

  // D2 — three characters Node tolerates and a Map lookup does not. Every suffix shape.
  for (const suffix of ["?v=1", "#frag", "?a=1&b=2#x"]) {
    const src = `import { appendRegularFileSync } from "./model/regular-file.mjs${suffix}";`;
    assert.deepEqual(writeSeamOffenders(new Map([["fake.mjs", src]]), new Map()),
      ["fake.mjs :: appendRegularFileSync"],
      `a \`${suffix}\` suffix must not take a module out of the pin — it is the same module ` +
      "to Node, and reopening B4 with it costs three characters");
  }

  // ...and the discrimination. A SANCTIONED export is the module's own verb or the driver's
  // front door: importing one is the route ADR-0006 prescribes, not a bypass of it. An inert
  // one is not a write at all. Neither is an offence, and a guard that cannot be quiet about
  // them would have to exempt half the tree to stay green — which is how an allowlist stops
  // meaning anything.
  const quiet = [
    ["loops/groomer.mjs", "{ groomOnce }"],
    ["model/storage.mjs", "{ fsStorage }"],
    ["model/write-port-resolve.mjs", "{ resolveWritePort }"],
    ["model/regular-file.mjs", "{ readRegularFileSync }"],
    ["model/transitions.mjs", "{ loadTransitions }"],
    ["model/sprints.mjs", "{ loadSprints, addSprint }"],
    ["pending-ledger.mjs", "{ readForDrain, listQueues }"],
  ];
  for (const [provider, clause] of quiet) {
    assert.deepEqual(
      writeSeamOffenders(new Map([["fake.mjs", `import ${clause} from "./${provider}";`]]),
        new Map()), [],
      `${clause} off ${provider} is sanctioned or inert, and must not be an offence`);
  }
  // a member nobody has classified is an offence in itself: this is the consumer-side half of
  // the pin, and it is what makes adding a primitive to the seam impossible to do quietly
  assert.deepEqual(
    writeSeamOffenders(new Map([["fake.mjs",
      'import { truncateRegularFileSync } from "./model/regular-file.mjs";']]), new Map()),
    [`fake.mjs :: ${unknownSeamMember("truncateRegularFileSync")}`],
    "an unpinned member of a pinned module must be an offence");
  // and a function that merely SHARES A NAME, from a module that is not on the allowlist,
  // is not one
  assert.deepEqual(
    writeSeamOffenders(new Map([["fake.mjs", 'import { saveState } from "./local-helpers.mjs";']]),
      new Map()), [],
    "the MODULE is what is pinned, not the spelling of a function name");
});

test("an acquisition this guard cannot fold is an acquisition it reports", () => {
  // BLZ-535 round 5, D1, and the reason the reader folds constants at all. Round 4 examined a
  // specifier only when it was a plain string `Literal` — it had stopped pinning the CALLEE's
  // spelling and started pinning the LITERAL's. MEASURED on 56fa011: the first row below
  // landed a real file at 12 pass / 0 fail, and the SAME LINE with double quotes instead of
  // backticks reddened it. Backtick versus quote was the whole difference.
  const routes = {
    "a backtick specifier through getBuiltinModule":
      "const fs = process.getBuiltinModule(`node:fs`);\nfs.writeFileSync(p, d);",
    "a backtick specifier through require":
      "const require = createRequire(import.meta.url);\nconst fs = require(`node:fs`);\nfs.writeFileSync(p, d);",
    "a specifier with no fs literal anywhere in the file":
      'const require = createRequire(import.meta.url);\nconst m = require(["f", "s"].join(""));\nm.writeFileSync(p, d);',
    // the `??` line is copied verbatim out of the innocent list below: the literal really is
    // data, and the VARIABLE is what carries it into the acquisition. The reader does not
    // follow variables and will not pretend it does — so the RESULT is what gives it away.
    "a specifier parked in a variable the reader cannot follow":
      'const mode = process.env.BLAZE_WRITE_PORT ?? "fs";\nconst fs = process.getBuiltinModule(mode);\nfs.writeFileSync(p, d);',
    "the same, through an object property":
      'const cfg = { name: "fs" };\nconst fs = process.getBuiltinModule(cfg.name);\nfs.writeFileSync(p, d);',
    "an unfoldable acquisition destructured on the spot":
      'const { writeFileSync } = process.getBuiltinModule(mode);\nwriteFileSync(p, d);',
    "an unfoldable acquisition whose namespace is reached without a binding":
      "process.getBuiltinModule(mode).promises.writeFile(p, d);",
    // folding is what catches this one and nothing else is: the namespace is HANDED ON
    // rather than used, so there is no member access to give it away
    "a folded specifier whose namespace is re-exported rather than called":
      "const fs = require(`node:fs`);\nexport { fs };",
  };
  for (const [why, src] of Object.entries(routes)) {
    const found = writeSeamOffenders(new Map([["fake.mjs", src]]), new Map());
    assert.equal(found.length, 1, `${why}: this must be an offender, and it is not — ${src}`);
  }
  // discrimination: an unfoldable call whose result never reaches the fs surface is ordinary
  // code, and this tree is made of it
  for (const src of [
    'const r = shResult("git", args);\nif (r.ok) return r.stdout;',
    "const cfg = loadConfig(root);\nreturn cfg.projects;",
    "const { records, dropped } = parseRecords(buf);\nreturn records.length + dropped.length;",
  ]) {
    assert.deepEqual(writeSeamOffenders(new Map([["fake.mjs", src]]), new Map()), [],
      `an ordinary call is not an acquisition:\n${src}`);
  }
});

test("prose, a message or a regex that merely NAMES a write is not a write", () => {
  // The other half of discrimination: a guard that cannot be quiet gets deleted. The guard
  // this replaces stripped `//` lines only, so a JSDoc block or an error string naming
  // `writeFileSync` was a false offender.
  const innocent = [
    '/** `writeFileSync` on a FIFO blocks forever. */\nimport { readFileSync } from "node:fs";',
    'import { readFileSync } from "node:fs";\nthrow new Error("use writeFileSync(p, d) instead");',
    'import { readFileSync } from "node:fs";\nconst RE = /\\brenameSync\\s*\\(/;',
    "import { readFileSync } from \"node:fs\";\nconst s = `appendFileSync(${p})`;",
    'import { writeFileSync } from "./regular-file.mjs";\nwriteFileSync(p, d);',
    // the namespace arm, where a REFERENCE is what the guard looks for, so a mention of one
    // in a comment or a message is the false offender to avoid
    'import * as fs from "node:fs";\n// never fs.writeFileSync(p, d) here\nfs.readFileSync(p);',
    'import * as fs from "node:fs";\nthrow new Error("use fs.renameSync(a, b)");\nfs.readFileSync(p);',
    'import * as fs from "node:fs";\nconst RE = /fs\\.appendFileSync/;\nfs.readFileSync(p);',
    // the bare specifier as DATA, which is what BLAZE_WRITE_PORT's value actually is in four
    // modules of this tree. A call position makes it an acquisition; `??` and `===` do not.
    'const mode = (env.BLAZE_WRITE_PORT ?? "fs").trim();\nif (mode === "fs") return fsPort();',
    'export const port = { name: "fs", write(t) { return t; } };',
    "throw new Error(\"expected 'fs', 'dual' or 'db'\");",
    // a namespace read through, and a nested namespace read through
    'import * as fs from "node:fs";\nconst p2 = fs.promises;\nawait p2.readFile(p);',
    'import * as fs from "node:fs";\nreturn fs.constants.O_RDONLY;',
    'import { promises as fsp } from "node:fs";\nawait fsp.readFile(p);',
    // a re-export of a READ
    'export { readFileSync } from "node:fs";',
    // a side-effect import binds nothing
    'import "node:fs";\nconsole.log(1);',
    // the other side of the regex/division question the old reader got wrong: a division is
    // a division, and a parser needs no heuristic to say so
    'import { readFileSync } from "node:fs";\nexport const half = (a) => a / 2 / 2;',
    // a template substitution is READ now rather than erased, so what is inside one is
    // judged on its merits — a read is still a read
    'import * as fs from "node:fs";\nexport const s = `${fs.readFileSync(p)}`;',
    // a READ off the local write seam, which is the module B4 pinned
    'import { readRegularFileSync } from "./model/regular-file.mjs";\nreadRegularFileSync(p);',
  ];
  for (const src of innocent) {
    assert.deepEqual(writeSeamOffenders(new Map([["fake.mjs", src]]), new Map()), [],
      `this names a write without being one:\n${src}`);
  }
});

test("no module outside the write seam writes or renames through node:fs", () => {
  // BLZ-267 wired six verbs and deliberately left reconcile, whose write is interleaved
  // inside a per-ticket loop. BLZ-276 finished it. This is the guard that keeps the seventh
  // writer from reappearing — and, since BLZ-535, one that a new spelling does not evade.
  assert.deepEqual(writeSeamOffenders(corpus(), WRITE_ALLOWED), [],
    "ADR-0006: ticket writes go through the storage driver, not node:fs");
});

test("the write-seam scan OBSERVED the corpus, and its allowlist is all load-bearing", () => {
  // Assert the observation happened, not just that the answer was green: a scan that read
  // no files, or a detector that silently stopped detecting, reports zero offenders and
  // looks identical to a clean tree. Every arm below fails in that case.
  const sources = corpus();
  assert.ok(sources.size > 100,
    `the scan saw ${sources.size} modules under scripts/ — it is not reading the corpus`);
  assert.ok(sources.has("ci/mutate-schedule.mjs"),
    "`ci/` is inside the corpus now; if it is not here the widening has been undone");
  assert.deepEqual(fsWritesIn(sources.get("model/storage.mjs"), "model/storage.mjs")
    .includes("renameSync"), true,
    "the write seam itself must register as a writer — if it does not, the detector is dead");

  // BLZ-535 round 3. The reader is a PARSER now, so "could not read it" is a state it can
  // actually be in — and the one it must never be in quietly. Every module in the corpus is
  // asserted to have PARSED and to have yielded nodes: a scan that could not look is not a
  // scan that looked, and a parse failure is an offence above rather than a skip.
  const unread = [];
  let nodesSeen = 0;
  for (const [rel, src] of sources) {
    const { ast } = parseModule(src);
    if (!ast) { unread.push(rel); continue; }
    nodesSeen += astIndex(ast).nodes.length;
  }
  assert.deepEqual(unread, [],
    "these modules did not parse, so nothing in this file has judged them. A guard that " +
    "cannot read a module has not cleared it.");
  // ...and the walk actually walked. The arm this replaces asked whether a parsed module
  // yielded ZERO nodes, which it cannot: `Program` is always one, so the arm was dead and
  // read as an observation while observing nothing.
  assert.ok(nodesSeen > 50000,
    `the walk saw ${nodesSeen} AST nodes across the corpus — that is not this tree, and a ` +
    "reader that stopped descending would report every module clean");

  // B4, on the live tree rather than on a fixture: the module that proved the banner false.
  assert.ok(fsWritesIn(sources.get("reconcile.mjs"), "reconcile.mjs")
    .includes("appendRegularFileSync"),
    "reconcile.mjs takes a write primitive off the local seam. If this stops being seen, " +
    "the hole that was live on main until BLZ-535's third pass is open again.");

  // A NARROWED exemption has to be enforced by something, or naming its members is a review
  // convention wearing a guard's clothes. MEASURED against the first cut: widening
  // `db-runner.mjs` from `["rmSync"]` to five members, and rewriting every `chmodSync` in
  // `model/identity-db.mjs` to `mkdirSync` while the allowlist still named both, BOTH stayed
  // 7/7 green — because the only question asked was whether the MODULE still wrote at all.
  const dead = [];
  for (const [rel, permitted] of WRITE_ALLOWED) {
    const src = sources.get(rel);
    if (src === undefined) { dead.push(`${rel} (no such module)`); continue; }
    const writes = fsWritesIn(src, rel);
    if (permitted === "*") {
      if (writes.length === 0) dead.push(`${rel} (reaches nothing mutating any more)`);
      continue;
    }
    for (const member of permitted) {
      if (!writes.includes(member)) dead.push(`${rel} :: ${member} (not reached any more)`);
    }
  }
  assert.deepEqual(dead, [],
    "an exemption nobody needs reads as one somebody does. Either the module no longer " +
    "writes through node:fs, or a NAMED member of its narrow exemption is no longer reached " +
    "— which is how a narrow exemption silently becomes a wide one. Delete them.");
});
