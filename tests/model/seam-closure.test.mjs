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
import { readdirSync, readFileSync, statSync } from "node:fs";
// the whole surface of both fs modules, for BLZ-535's derived write-seam ledger
import * as fsCallbacks from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(fileURLToPath(new URL("../../scripts", import.meta.url)));

// The seam itself, and the one module that owns the filesystem walk.
const SEAM = new Set(["model/index.mjs", "model/read-storage.mjs"]);

function* mjsFiles(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { yield* mjsFiles(p); continue; }
    if (e.endsWith(".mjs")) yield p;
  }
}

test("no module outside the seam calls walkTickets", () => {
  const offenders = [];
  for (const file of mjsFiles(SCRIPTS)) {
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
  for (const file of mjsFiles(SCRIPTS)) {
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
// WHAT THIS STILL CANNOT SEE, stated rather than left to look total: a write re-exported
// through a local module (`./regular-file.mjs` is exactly that, and is allowlisted for it),
// and an fs specifier reached through a variable rather than written at the import site. A
// dynamic `import("node:fs")` IS seen — cli.mjs uses one — and an fs acquisition in a shape
// the binding reader cannot resolve is reported as an offence rather than skipped.
// =============================================================================

/** The READ-ONLY half of `node:fs`: members that cannot create, modify, replace or remove a
 *  filesystem entry. This is the only hand-written list in the guard, and it is the half
 *  where being wrong is SAFE — forgetting an entry here makes the guard noisier, never
 *  blinder. Names cover both the callback and the promises module, whose members share them. */
const NON_MUTATING = new Set([
  "Dir", "Dirent", "FileReadStream", "ReadStream", "Stats", "StatFs", "Stream",
  "_toUnixTimestamp", "access", "accessSync", "close", "closeSync", "createReadStream",
  "exists", "existsSync", "fstat", "fstatSync", "glob", "globSync", "lstat", "lstatSync",
  "openAsBlob", "opendir", "opendirSync", "read", "readFile", "readFileSync", "readSync",
  "readdir", "readdirSync", "readlink", "readlinkSync", "readv", "readvSync", "realpath",
  "realpathSync", "stat", "statSync", "statfs", "statfsSync", "unwatchFile", "watch",
  "watchFile",
]);

/** Everything the given fs modules export as a function that the ledger above does not
 *  vouch for. Derived, not spelled out — that is the whole point of BLZ-535. */
function mutatingSurface(...mods) {
  const out = new Set();
  for (const mod of mods) {
    for (const name of Object.keys(mod)) {
      if (typeof mod[name] === "function" && !NON_MUTATING.has(name)) out.add(name);
    }
  }
  return out;
}
const WRITE_SURFACE = mutatingSurface(fsCallbacks, fsPromises);

/** Comments, strings, template literals and regex literals removed, so a NAME that survives
 *  is a name the parser would see — not prose, not an error message, not a pattern. The
 *  guard this replaces stripped `//` lines only, which left every JSDoc block and every
 *  quoted spelling able to produce a false offender. */
function codeOnly(src) {
  let out = ""; let i = 0; let prev = ""; const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") {
      i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue;
    }
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < n && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      i++; out += '""'; prev = '"'; continue;
    }
    if (c === "`") {
      i++; let depth = 0;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "`" && depth === 0) { i++; break; }
        if (src[i] === "$" && src[i + 1] === "{") { depth++; i += 2; continue; }
        if (src[i] === "}" && depth > 0) { depth--; i++; continue; }
        i++;
      }
      out += '""'; prev = '"'; continue;
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
      out += "0"; prev = "0"; continue;
    }
    out += c; if (!/\s/.test(c)) prev = c; i++;
  }
  return out;
}

const FS_SPEC = String.raw`["'](?:node:)?fs(?:\/promises)?["']`;
const STATIC_FROM = new RegExp(String.raw`\bfrom\s*${FS_SPEC}`, "g");
const DYNAMIC_BOUND = new RegExp(
  String.raw`(?:const|let|var)\s*(\{[^{}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?` +
  String.raw`(?:import|require)\s*\(\s*${FS_SPEC}\s*\)`, "g");
// Every MENTION of an fs specifier, wherever it sits. The unambiguous `node:fs` forms count
// anywhere — `createRequire(import.meta.url)("node:fs")` names no `import` or `require` token
// this reader can anchor on — while bare `"fs"` counts only in an import position, because
// `"fs"` is also the value of BLAZE_WRITE_PORT and appears as data all over the tree.
const ANY_ACQUISITION = new RegExp(
  String.raw`["'](?:node:fs(?:\/promises)?|fs\/promises)["']` +
  String.raw`|(?:\bfrom\s*|\b(?:import|require)\s*\(\s*)["']fs["']`, "g");

/** Split a `{ a, b as c }` clause into local -> imported. */
function readBraces(clause, named) {
  const braces = /\{([\s\S]*)\}/.exec(clause);
  if (!braces) return;
  for (const part of braces[1].split(",")) {
    const t = part.trim(); if (!t) continue;
    const aliased = /^([A-Za-z_$][\w$]*)\s*(?::|\bas\b)\s*([A-Za-z_$][\w$]*)$/.exec(t);
    if (aliased) named.set(aliased[2], aliased[1]); else named.set(t, t);
  }
}

/** The node:fs bindings a module actually holds. `opaque` is the fail-closed arm: an fs
 *  acquisition this reader could not turn into bindings is reported rather than ignored. */
function fsBindings(withComments) {
  const named = new Map(); const ns = new Set();
  let resolved = 0;
  for (const m of withComments.matchAll(STATIC_FROM)) {
    resolved++;
    const start = withComments.slice(0, m.index).lastIndexOf("import");
    if (start < 0) continue;
    const clause = withComments.slice(start + "import".length, m.index).trim();
    const nsm = /\*\s*as\s*([A-Za-z_$][\w$]*)/.exec(clause);
    if (nsm) ns.add(nsm[1]);
    readBraces(clause, named);
    const def = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause);
    if (def) ns.add(def[1]);
  }
  for (const m of withComments.matchAll(DYNAMIC_BOUND)) {
    resolved++;
    if (m[1].startsWith("{")) readBraces(m[1], named); else ns.add(m[1]);
  }
  const total = [...withComments.matchAll(ANY_ACQUISITION)].length;
  return { named, ns, opaque: total > resolved };
}

/** Every mutating fs member a module BINDS — binding it is the offence, not calling it, so
 *  there is no `const w = fs.writeFileSync` indirection to hide behind. A namespace import
 *  has no binding to read, so its members are found by reference in the stripped code. */
function fsWritesIn(raw) {
  const withComments = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const { named, ns, opaque } = fsBindings(withComments);
  const hits = new Set();
  if (opaque) hits.add("node:fs acquired in a shape this guard cannot read");
  for (const [local, imported] of named) {
    if (WRITE_SURFACE.has(imported)) hits.add(imported);
  }
  if (ns.size) {
    const code = codeOnly(raw);
    for (const nsName of ns) {
      const re = new RegExp(String.raw`(?<![.\w$])${nsName}\s*\.\s*([A-Za-z_$][\w$]*)`, "g");
      for (const m of code.matchAll(re)) if (WRITE_SURFACE.has(m[1])) hits.add(m[1]);
    }
  }
  return [...hits].sort();
}

/** `allowed` maps a module to `"*"` (it owns its own files wholesale) or to the exact
 *  members its exemption covers — so a narrow exemption stays narrow. */
function writeSeamOffenders(sources, allowed) {
  const offenders = [];
  for (const [rel, raw] of sources) {
    if (rel.startsWith("ci/")) continue;
    const permitted = allowed.get(rel);
    if (permitted === "*") continue;
    const hits = fsWritesIn(raw).filter((h) => !(permitted ?? []).includes(h));
    if (hits.length) offenders.push(`${rel} :: ${hits.join(", ")}`);
  }
  return offenders.sort();
}

/** The corpus the guard runs over: every `.mjs` under `scripts/`, by seam-relative path. */
function corpus() {
  const out = new Map();
  for (const file of mjsFiles(SCRIPTS)) {
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
  // BLZ-535. The four below were invisible to the guard while it pinned two spellings, and
  // are listed now that it does not. None writes a ticket; each is named to its members
  // rather than starred, so the exemption does not widen by accident.
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
  const invented = mutatingSurface({
    readFileSync() {}, statSync() {},           // vouched for by the ledger
    quantumWriteSync() {}, teleportFileSync() {},  // nobody has ever heard of these
    SOME_CONSTANT: 7,                            // not a function, not a seam
  });
  assert.deepEqual([...invented].sort(), ["quantumWriteSync", "teleportFileSync"],
    "an fs member the read-only ledger does not vouch for must count as a write");

  for (const name of ["writeFileSync", "renameSync", "appendFileSync", "openSync",
    "mkdirSync", "rmSync", "unlinkSync", "truncateSync", "createWriteStream", "cpSync"]) {
    assert.ok(WRITE_SURFACE.has(name), `${name} must be in the derived write surface`);
  }
  for (const name of ["readFileSync", "readdirSync", "statSync", "fstatSync", "existsSync"]) {
    assert.ok(!WRITE_SURFACE.has(name), `${name} reads; it must not be in the write surface`);
  }
  assert.ok(WRITE_SURFACE.size > 40,
    `the surface came out at ${WRITE_SURFACE.size} — that is not node:fs, that is a bug here`);
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
      'const fs = createRequire(import.meta.url)("node:fs");\nfs.writeFileSync(p, d);',
  };
  for (const [why, src] of Object.entries(cases)) {
    const found = writeSeamOffenders(new Map([["fake.mjs", src]]), new Map());
    assert.equal(found.length, 1, `${why}: this must be an offender, and it is not — ${src}`);
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
  // looks identical to a clean tree. Both arms below fail in that case.
  const sources = corpus();
  assert.ok(sources.size > 100,
    `the scan saw ${sources.size} modules under scripts/ — it is not reading the corpus`);
  assert.deepEqual(fsWritesIn(sources.get("model/storage.mjs")).includes("renameSync"), true,
    "the write seam itself must register as a writer — if it does not, the detector is dead");

  const dead = [...WRITE_ALLOWED.keys()].filter((rel) => {
    const src = sources.get(rel);
    return src === undefined || fsWritesIn(src).length === 0;
  });
  assert.deepEqual(dead, [],
    "these allowlist entries name a module that no longer writes through node:fs (or no " +
    "longer exists). An exemption nobody needs reads as one somebody does — delete them.");
});
