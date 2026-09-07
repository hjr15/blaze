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

test("no module outside the seam calls walkTickets", () => {
  const offenders = [];
  for (const file of jsFiles(SCRIPTS)) {
    const rel = relative(SCRIPTS, file).split("\\").join("/");
    if (SEAM.has(rel)) continue;
    const src = readFileSync(file, "utf8");
    // a call, not a mention in prose — comments legitimately name it
    if (/\bwalkTickets\s*\(/.test(src.replace(/\/\/.*$/gm, ""))) offenders.push(rel);
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
    const src = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
    if (/\breaddirSync\s*\(|\bstatSync\s*\(/.test(src)) offenders.push(rel);
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
// WHAT THIS STILL CANNOT SEE, stated rather than left to look total. This guard reads TEXT.
// It is not a parser, not a scope analyser and not a linker, and each of those is a hole:
//   * A write REPACKAGED BY A LOCAL MODULE. `./regular-file.mjs` exports its own
//     `writeRegularFileSync`, which is a write, and is allowlisted for exactly that; a
//     consumer importing it is invisible here and always will be. What is no longer
//     invisible is the narrower `export { writeFileSync } from "node:fs"` — that one is now
//     an offence in the re-exporting module.
//   * AN FS SPECIFIER WITH NO LITERAL FRAGMENT. `import("node:" + "fs")` IS reported — the
//     `"fs"` fragment is a literal in a position that is not a value position — but
//     `import("n" + "ode:fs")` contains no fs specifier literal anywhere and is not seen.
//     This reader does not fold constants and never will.
//   * CODE INSIDE A STRING. `eval` and `new Function` take a string, and the tokeniser erases
//     every string. MEASURED: `eval('import("node:fs").then(m => m.writeFileSync(a, b))')`
//     is the one route out of 34 in the self-attack battery that this guard does not see.
//     A template WITH a substitution is not in that hole — it is recorded as non-constant and
//     reported — but its interior is gone all the same.
//   * SHADOWING. A local `const fs = {}` in an inner scope of a module that also has
//     `import * as fs from "node:fs"` is read as the fs namespace. The guard errs toward
//     REPORTING, so this is noise rather than blindness.
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

/** One pass over a module that drops comments and replaces every string, template and regex
 *  literal with an inert `""` — while REMEMBERING what each string said and where its
 *  placeholder landed. The remembering is the point, and it is what the first cut lacked:
 *  the guard has to know that `"fs"` next to a `(` is an acquisition and that `?? "fs"` is
 *  the default value of BLAZE_WRITE_PORT, and it can know neither if the strings are already
 *  gone by the time it looks. A template with a `${}` in it is recorded as NOT CONSTANT, so
 *  a specifier assembled inside one is reported rather than read. */
function scan(src) {
  const literals = [];
  let code = ""; let i = 0; let prev = ""; const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") {
      i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue;
    }
    if (c === '"' || c === "'") {
      const q = c; i++; let value = "";
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") { value += src[i + 1] ?? ""; i += 2; continue; }
        value += src[i]; i++;
      }
      i++;
      literals.push({ value, at: code.length, constant: true });
      code += '""'; prev = '"'; continue;
    }
    if (c === "`") {
      i++; let depth = 0; let value = ""; let constant = true;
      while (i < n) {
        if (src[i] === "\\") { value += src[i + 1] ?? ""; i += 2; continue; }
        if (src[i] === "`" && depth === 0) { i++; break; }
        if (src[i] === "$" && src[i + 1] === "{") { constant = false; depth++; i += 2; continue; }
        if (src[i] === "}" && depth > 0) { depth--; i++; continue; }
        if (depth === 0) value += src[i];
        i++;
      }
      literals.push({ value, at: code.length, constant });
      code += '""'; prev = '"'; continue;
    }
    if (c === "/" && (prev === "" || /[=(,:[!&|?{};+\-*%<>~^]/.test(prev))) {
      i++; let inClass = false;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) { i++; break; }
        else if (src[i] === "\n") break;
        i++;
      }
      while (i < n && /[dgimsuvy]/.test(src[i])) i++;
      code += "0"; prev = "0"; continue;
    }
    code += c; if (!/\s/.test(c)) prev = c; i++;
  }
  return { code, literals };
}

/** Every spelling of an fs specifier. There is no regex for these any more — a specifier is
 *  a STRING LITERAL WHOSE VALUE IS ONE OF THESE, so `"expected 'fs', 'dual' or 'db'"` is one
 *  literal that is not any of them rather than a substring match waiting to happen. */
const FS_SPECIFIERS = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);

/** The ONE spelling that is also a value in this tree: BLAZE_WRITE_PORT is set to the string
 *  "fs", compared and defaulted in four modules, so bare `"fs"` gets a data exemption and has
 *  to. Every other spelling names node:fs and nothing else, so it gets NO exemption: a
 *  `const S = "node:fs"` that some later line hands to `import(S)` is reported where it sits,
 *  because this reader cannot follow the variable and will not pretend the literal is inert. */
const AMBIGUOUS_SPECIFIER = new Set(["fs"]);

// The offences that are not a member name. Each is a construct the reader CANNOT resolve, and
// each is reported rather than skipped — F3 and F4 were both "could not read it, so said
// nothing", and a guard that goes quiet on what it does not understand is not a guard.
const OPAQUE = "node:fs acquired in a shape this guard cannot read";
const WHOLESALE = "node:fs re-exported wholesale";
const COMPUTED = "a computed member access on an fs namespace";
const ESCAPE = "an fs namespace escaping where this guard cannot follow it";
const unreadableClause = (part) => `an fs binding clause this guard cannot read: ${part}`;
const unknownMember = (name) => `an unknown member \`${name}\` on an fs namespace`;

/** The token positions in which an fs specifier is a VALUE rather than an acquisition — a
 *  comparison, a default, an assignment, an object property, an array or argument element.
 *  This arm has to exist: BLAZE_WRITE_PORT's value is literally the string "fs", compared and
 *  defaulted in four modules of this tree. Everything NOT on this list, not an import, not a
 *  re-export and not a call argument is REPORTED rather than assumed to be data —
 *  `import("node:" + "fs")` puts the literal next to a `+`, which this reader cannot evaluate
 *  and will not wave through. A specifier sitting in an array that is later joined and
 *  imported is still data to this reader, and is stated in the banner. */
const DATA_CONTEXT = /(?:[=!]==?|=>|\?\?|&&|\|\||[:=]|\breturn|\bcase)$/;

const DECL_TARGET = String.raw`(\{[^{}]*\}|[A-Za-z_$][\w$]*)`;
/** `const X = <anything>(` — the declaration a call-form acquisition lands in. The callee is
 *  deliberately unconstrained: `import`, `require`, `createRequire(import.meta.url)` and a
 *  name nobody has thought of yet are all the same shape, and pinning the callee's SPELLING
 *  is the defect this guard is named after. */
const CALL_BINDING = new RegExp(
  String.raw`(?:const|let|var)\s+${DECL_TARGET}\s*=\s*(?:await\s+)?` +
  String.raw`[A-Za-z_$][\w$.]*\s*(?:\([^()]*\)\s*)*\($`);
const ASSIGNED_TO = new RegExp(
  String.raw`(?:^|[;{(,]|\b(?:const|let|var)\b)\s*${DECL_TARGET}\s*=$`);

/** Split a `{ a, b as c }` clause into local -> imported. FAIL-CLOSED: a part that is not a
 *  plain name or a plain alias — a computed key `{ ["writeFileSync"]: w }`, a rest element
 *  `{ ...rest }`, a default — is recorded as an offence rather than dropped. */
function readBraces(clause, named, hits) {
  const braces = /\{([\s\S]*)\}/.exec(clause);
  if (!braces) return false;
  for (const part of braces[1].split(",")) {
    const t = part.trim(); if (!t) continue;
    const aliased = /^([A-Za-z_$][\w$]*)\s*(?::|\bas\b)\s*([A-Za-z_$][\w$]*)$/.exec(t);
    if (aliased) { named.set(aliased[2], aliased[1]); continue; }
    if (/^[A-Za-z_$][\w$]*$/.test(t)) { named.set(t, t); continue; }
    hits.add(unreadableClause(t));
  }
  return true;
}

/** Bind whatever a namespace-valued expression was assigned to, so the taint follows the
 *  alias: `const p = fs.promises`, `const { writeFileSync } = fs`, `const g = fs`. Returns
 *  false when the expression was not assigned to anything at all, which is the caller's cue
 *  that the namespace escaped somewhere this reader cannot follow. */
function bindTarget(head, named, ns, hits) {
  const m = ASSIGNED_TO.exec(head);
  if (!m) return false;
  if (m[1].startsWith("{")) readBraces(m[1], named, hits); else ns.add(m[1]);
  return true;
}

/** Every reference to one fs NAMESPACE binding, classified. A dotted chain is walked member
 *  by member so `fs.promises.writeFile` resolves; a `[` is an offence because the guard
 *  cannot evaluate it; a bare reference either binds an alias or escapes. */
function walkNamespace(body, nsName, named, ns, hits) {
  const re = new RegExp(String.raw`(?<![\w$])${nsName}(?![\w$])`, "g");
  for (const m of body.matchAll(re)) {
    const head = body.slice(0, m.index).replace(/\s+$/, "");
    // `other.fs` is somebody else's member, and not this binding. `...fs` is a SPREAD of this
    // one — three dots, not a member access — and a lookbehind that rejects any preceding dot
    // waves it straight through. Found while attacking this fix, not by the review.
    if (/\.$/.test(head) && !/\.\.\.$/.test(head)) continue;
    const rest = body.slice(m.index + nsName.length);
    if (/^\s*\[/.test(rest)) { hits.add(COMPUTED); continue; }
    const chain = /^((?:\s*\.\s*[A-Za-z_$][\w$]*)+)/.exec(rest);
    if (chain) {
      let landedOn = "value";
      for (const part of chain[1].split(".").map((s) => s.trim()).filter(Boolean)) {
        if (INERT.has(part)) { landedOn = "value"; break; }
        if (FS_NAMESPACE_MEMBERS.has(part)) { landedOn = "namespace"; continue; }
        landedOn = "value";
        if (WRITE_SURFACE.has(part)) { hits.add(part); break; }
        if (NON_MUTATING.has(part)) break;
        hits.add(unknownMember(part)); break;
      }
      // `const p = fs.promises` — the chain ended ON a namespace, so the alias inherits it.
      if (landedOn === "namespace") bindTarget(head, named, ns, hits);
      continue;
    }
    if (/^\s*=(?![=>])/.test(rest)) continue;   // this occurrence is the target of an assignment
    if (bindTarget(head, named, ns, hits)) continue;
    hits.add(ESCAPE);
  }
}

/** Every mutating fs member a module BINDS, HANDS ON, or reaches through a namespace —
 *  binding it is the offence, not calling it, so there is no `const w = fs.writeFileSync`
 *  indirection to hide behind. */
function fsWritesIn(raw) {
  const { code, literals } = scan(raw);
  const hits = new Set(); const named = new Map(); const ns = new Set();

  // The acquisition sites are blanked out of the body before the namespace scan, so an
  // import clause's own `fs` is not misread as the namespace escaping into an expression.
  const masked = [...code];
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (!/\s/.test(masked[k])) masked[k] = " ";
  };

  for (const lit of literals) {
    if (!FS_SPECIFIERS.has(lit.value)) continue;
    if (!lit.constant) { hits.add(OPAQUE); continue; }
    const head = code.slice(0, lit.at).replace(/\s+$/, "");

    if (/\bfrom$/.test(head)) {
      let kw = null; let kwAt = -1;
      for (const k of head.matchAll(/\b(import|export)\b/g)) { kw = k[1]; kwAt = k.index; }
      if (kw === null) { hits.add(OPAQUE); continue; }
      blank(kwAt, lit.at + 2);
      const clause = head.slice(kwAt + kw.length, head.length - "from".length).trim();
      if (kw === "import") {
        const nsm = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
        if (nsm) ns.add(nsm[1]);
        readBraces(clause, named, hits);
        const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
        if (def) ns.add(def[1]);        // a default import IS the namespace: `fs.promises` etc.
        continue;
      }
      // `export ... from "node:fs"` HANDS THE BINDING ON. The first cut counted this as
      // resolved and then bound nothing, so a re-exporting helper plus a consumer wrote to
      // disk with the guard green. A re-export of a write is a write, here, in this module.
      if (clause.includes("*")) { hits.add(WHOLESALE); continue; }
      const reexported = new Map();
      if (!readBraces(clause, reexported, hits)) { hits.add(OPAQUE); continue; }
      for (const imported of reexported.values()) {
        if (FS_NAMESPACE_MEMBERS.has(imported)) hits.add(WHOLESALE);
        else if (WRITE_SURFACE.has(imported)) hits.add(imported);
      }
      continue;
    }

    if (/\($/.test(head)) {
      // A specifier in a CALL's argument position, whatever the callee is spelled. That is
      // `import(...)`, `require(...)` and `createRequire(import.meta.url)(...)` alike — the
      // last of which the first cut missed entirely, because `\brequire` does not match
      // `createRequire` and so the scan came back with nothing at all to report.
      const m = CALL_BINDING.exec(head);
      if (!m) { hits.add(OPAQUE); continue; }
      blank(m.index, lit.at + 2);
      if (m[1].startsWith("{")) readBraces(m[1], named, hits); else ns.add(m[1]);
      continue;
    }

    if (/\bimport$/.test(head)) continue;   // `import "node:fs"` — a side effect, binds nothing
    if (AMBIGUOUS_SPECIFIER.has(lit.value) && DATA_CONTEXT.test(head)) continue;
    hits.add(OPAQUE);
  }

  // A namespace hands out more namespaces (`fs.promises`) and more names (`const { w } = fs`),
  // so resolution runs to a FIXPOINT rather than one level deep.
  const body = masked.join("");
  const walked = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const [local, imported] of [...named]) {
      if (FS_NAMESPACE_MEMBERS.has(imported) && !ns.has(local)) { ns.add(local); grew = true; }
    }
    for (const nsName of [...ns]) {
      if (walked.has(nsName)) continue;
      walked.add(nsName); grew = true;
      walkNamespace(body, nsName, named, ns, hits);
    }
  }
  for (const imported of named.values()) if (WRITE_SURFACE.has(imported)) hits.add(imported);
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
    const hits = fsWritesIn(raw).filter((h) => !(permitted ?? []).includes(h));
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
  ["db-runner.mjs", ["rmSync"]],
  // The identity database's own directory: .blaze/ created 0700 and re-tightened. Same
  // credential-store footing as setup-token.mjs, and deliberately NOT in the shadow
  // database, which `db init` may destroy.
  ["model/identity-db.mjs", ["mkdirSync", "chmodSync"]],
  // `blaze user add` appends the identity database to the board's .gitignore, so a
  // credential store cannot be committed. A .gitignore line, not a ticket.
  ["model/user-admin.mjs", ["appendFileSync"]],
  // The dual-write soak's divergence log and its counter, both under gitignored .blaze/.
  ["model/write-port-resolve.mjs", ["appendFileSync", "mkdirSync"]],
  // `writeSync(2, ...)` — a partial-write loop onto STDERR, which is a terminal, not a file.
  // Named to that one member: a path-taking write appearing in the CLI still reddens.
  ["cli.mjs", ["writeSync"]],
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
  };
  for (const [why, src] of Object.entries(cases)) {
    const found = writeSeamOffenders(new Map([["fake.mjs", src]]), new Map());
    assert.ok(found.length === 1, `${why}: this must be an offender, and it is not — ${src}`);
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
  assert.deepEqual(fsWritesIn(sources.get("model/storage.mjs")).includes("renameSync"), true,
    "the write seam itself must register as a writer — if it does not, the detector is dead");

  // A NARROWED exemption has to be enforced by something, or naming its members is a review
  // convention wearing a guard's clothes. MEASURED against the first cut: widening
  // `db-runner.mjs` from `["rmSync"]` to five members, and rewriting every `chmodSync` in
  // `model/identity-db.mjs` to `mkdirSync` while the allowlist still named both, BOTH stayed
  // 7/7 green — because the only question asked was whether the MODULE still wrote at all.
  const dead = [];
  for (const [rel, permitted] of WRITE_ALLOWED) {
    const src = sources.get(rel);
    if (src === undefined) { dead.push(`${rel} (no such module)`); continue; }
    const writes = fsWritesIn(src);
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
