// scripts/matrices-runner.mjs — `blaze matrices [--project KEY] [--check] [--out DIR]` (BLZ-682).
//
// Replaces blaze-pm's `scripts/build_matrices.py` (spec §5.6). The I/O half only: the tickets
// come through `resolveReadStorage` (fs, dual and db alike) and every byte of every file comes
// from `model/matrices.mjs`, where the coverage gate sees it (`.c8rc.json` excludes runners).
//
//   default   write `<KEY>-requirements-matrix.md` and `<KEY>-architecture-matrix.md` for each
//             project into --out (default `<data root>/docs/matrices`)
//   --check   write nothing; exit 1 naming every file that differs from what would be written —
//             the script's CI gate, `matrices-in-sync`
import { mkdirSync } from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";
import { readRegularFileSync, writeRegularFileSync } from "./model/regular-file.mjs";
import { resolveRoots, loadConfig } from "./config.mjs";
import { resolveReadStorage } from "./model/write-port-resolve.mjs";
import { ticketPath } from "./model/storage.mjs";
import { matrixFiles } from "./model/matrices.mjs";
import { assertWritable } from "./readonly.mjs";

const USAGE = `usage: blaze matrices [--project KEY] [--check] [--out DIR]

  Regenerate the requirements and architecture matrices — derived views of the tickets.
  --project KEY   one project only (default: every configured project)
  --check         write nothing; exit 1 if a committed matrix differs from the tickets
  --out DIR       where the files live (default: <data root>/docs/matrices)`;

const opts = { project: null, check: false, out: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--check") { opts.check = true; continue; }
  if (a === "--project" || a === "--out") {
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) { console.error(`blaze matrices: ${a} needs a value\n\n${USAGE}`); process.exit(1); }
    opts[a.slice(2)] = v;
    continue;
  }
  if (a === "--help" || a === "-h") { console.log(USAGE); process.exit(0); }
  console.error(`blaze matrices: unknown argument ${a}\n\n${USAGE}`);
  process.exit(1);
}

const { dataRoot, projectsDir } = resolveRoots();
const out = opts.out ? resolvePath(opts.out) : join(dataRoot, "docs", "matrices");

// The per-runner BLAZE_READONLY guard every mutating runner carries (AGENTS.md), before anything
// is written. `--check` writes nothing and is allowed, exactly as cli.mjs's readOnlyFlags says.
if (!opts.check) {
  try { assertWritable("run blaze matrices"); }
  catch (e) { console.error(e.message); process.exit(1); }
}

const rs = await resolveReadStorage({ dataRoot, projectsDir }).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
let tickets, keys;
try {
  tickets = [...(await rs.readStorage.listTickets(projectsDir))];
  const configured = loadConfig({ root: dataRoot }).projects ?? [];
  keys = opts.project ? [opts.project]
    : (configured.length ? configured : await rs.readStorage.listProjects(projectsDir));
} finally { await rs.close(); }
if (!keys.length) {
  // A run that rendered nothing must not report that everything is in sync.
  console.error(`blaze matrices: no projects found under ${projectsDir}`);
  process.exit(2);
}

// The link column. Under fs and dual a ticket's record carries its real path. Under db there
// is no file, so the link is the canonical path `ticketPath` gives — what the file would be
// called if it were written today.
const pathOf = rs.mode === "db"
  ? (t) => relative(dataRoot, ticketPath(projectsDir, t.project, t.status, t.frontmatter.id, t.frontmatter.title))
  : (t) => relative(dataRoot, t.file);

const drift = [];
if (!opts.check) mkdirSync(out, { recursive: true });
for (const key of keys) {
  for (const [name, content] of Object.entries(matrixFiles(tickets, key, pathOf))) {
    const path = join(out, name);
    if (opts.check) {
      let existing = null;
      try { existing = readRegularFileSync(path); } catch (e) { if (e?.code !== "ENOENT") throw e; }
      if (existing !== content) drift.push(name);
    } else {
      writeRegularFileSync(path, content);
      console.log(`wrote ${relative(dataRoot, path)}`);
    }
  }
}
if (opts.check) {
  if (drift.length) {
    console.error(`MATRIX DRIFT — regenerate: ${drift.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("matrices are in sync with the tickets");
  }
}
