#!/usr/bin/env node
// scripts/ops/concurrency-proof.mjs — the cutover's two-machine proof (BLZ-684, spec §7 step 3).
//
// BLZ-254's acceptance criterion is "two agents on two machines each create 50 tickets
// concurrently — distinct ids, no ceremony". This is the harness the operator runs for it:
//
//   create  — on EACH machine, in remote mode (BLAZE_REMOTE_URL + BLAZE_TOKEN), create
//             `--count` tickets through `POST /api/new`, `--parallel` at a time, and print the
//             ids as JSON on stdout. Save each machine's output to a file.
//
//       node scripts/ops/concurrency-proof.mjs create --project BLZ --count 50 --label m1 > m1.json
//
//   verify  — on either machine, hand it every saved file: it checks the ids are distinct
//             across ALL of them and that each one is on the server, and exits 0 or 1.
//
//       node scripts/ops/concurrency-proof.mjs verify m1.json m2.json
//
// Every request goes through remote-client.mjs's `requestRemote`, so the token reaches
// BLAZE_REMOTE_URL's origin and nowhere else. The tickets it creates are real: run it against
// the rehearsal database, and clean up with `blaze resolve <id> wont-do` (or drop the
// database) — the proof never deletes anything itself.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { remoteFrom, requestRemote } from "../remote-client.mjs";

const USAGE = `usage: node scripts/ops/concurrency-proof.mjs create --project <KEY> --count <n>
         [--type task] [--estimate 15] [--parallel 8] [--label <name>]
       node scripts/ops/concurrency-proof.mjs verify <ids.json> [<ids.json> …]
  Both need BLAZE_REMOTE_URL and BLAZE_TOKEN (remote mode).`;

/**
 * Create `count` tickets, at most `parallel` in flight at once.
 * @returns { ids: string[], failures: [{ n, status, errors }] } — ids in completion order
 */
export async function createMany(cfg, { project, count, type = "task", estimate = 15, parallel = 8,
                                        label = "proof", fetch } = {}) {
  const ids = [], failures = [];
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const n = ++next;
      let r;
      try {
        r = await requestRemote(cfg, "POST", "/api/new",
          { project, type, estimate, title: `concurrency proof ${label} ${n}` }, { fetch });
      } catch (e) {
        failures.push({ n, status: null, errors: [String(e?.cause?.message ?? e?.message ?? e)] });
        continue;
      }
      if (r.ok && r.answer?.ok === true && typeof r.answer.id === "string") ids.push(r.answer.id);
      else failures.push({ n, status: r.status, errors: r.answer?.errors ?? [] });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, count)) }, worker));
  return { ids, failures };
}

/**
 * The verdict over every machine's list: duplicates (within or across lists) and ids the
 * server does not hold. Asks the server about each distinct id (`GET /api/panel?id=`).
 * @returns { ok, total, distinct, duplicates: string[], missing: string[] }
 */
export async function verifyLists(cfg, lists, { fetch } = {}) {
  const all = lists.flat();
  const seen = new Set(), duplicates = new Set();
  for (const id of all) (seen.has(id) ? duplicates : seen).add(id);
  const missing = [];
  for (const id of seen) {
    const r = await requestRemote(cfg, "GET", `/api/panel?id=${encodeURIComponent(id)}`, undefined, { fetch });
    if (r.status !== 200) missing.push(id);
  }
  return { ok: all.length > 0 && duplicates.size === 0 && missing.length === 0,
           total: all.length, distinct: seen.size, duplicates: [...duplicates].sort(), missing: missing.sort() };
}

/** The CLI. @returns the exit code */
export async function main(argv, { env = process.env, out = console.log, err = console.error, fetch } = {}) {
  const [mode, ...rest] = argv;
  // The mode first (BLZ-691): a mistyped mode is a usage error, whatever the environment holds.
  if (mode !== "create" && mode !== "verify") { err(USAGE); return 1; }
  const cfg = remoteFrom(env);
  if (cfg.error) { err(cfg.error); return 1; }
  if (!cfg.remote) { err(`concurrency-proof: remote mode is not configured\n\n${USAGE}`); return 1; }
  if (mode === "create") {
    const o = { type: "task", estimate: 15, parallel: 8, label: "proof" };
    for (let i = 0; i < rest.length; i++) {
      const k = rest[i];
      const v = rest[++i];
      if (v === undefined) { err(`concurrency-proof: ${k} needs a value\n\n${USAGE}`); return 1; }
      if (k === "--project") o.project = v;
      else if (k === "--type") o.type = v;
      else if (k === "--label") o.label = v;
      else if (k === "--count" || k === "--estimate" || k === "--parallel") o[k.slice(2)] = Number(v);
      else { err(`concurrency-proof: unknown argument ${k}\n\n${USAGE}`); return 1; }
    }
    if (!o.project || !Number.isInteger(o.count) || o.count < 1 || !Number.isInteger(o.parallel) || o.parallel < 1) {
      err(USAGE); return 1;
    }
    const r = await createMany(cfg, { ...o, fetch });
    out(JSON.stringify({ origin: cfg.origin, label: o.label, ids: r.ids, failures: r.failures }));
    for (const f of r.failures) err(`concurrency-proof: ticket ${f.n} failed (${f.status ?? "no answer"}): ${f.errors.join("; ")}`);
    return r.failures.length ? 1 : 0;
  }
  if (mode === "verify") {
    if (!rest.length) { err(USAGE); return 1; }
    const lists = [];
    for (const file of rest) {
      let parsed;
      try { parsed = JSON.parse(readFileSync(file, "utf8")); }
      catch (e) { err(`concurrency-proof: cannot read ${file}: ${e.message}`); return 1; }
      if (!Array.isArray(parsed?.ids)) { err(`concurrency-proof: ${file} holds no "ids" list`); return 1; }
      if (!Array.isArray(parsed.failures)) { err(`concurrency-proof: ${file} holds no "failures" list`); return 1; }
      if (parsed.failures.length) {
        err(`concurrency-proof: ${file} records ${parsed.failures.length} failed create(s) — the proof cannot pass over a lost create`);
        return 1;
      }
      lists.push(parsed.ids);
    }
    // BLZ-691: a network error or a refused redirect REJECTS (requestRemote does not catch);
    // uncaught, it ended the run as an unhandled rejection with a stack. One line instead.
    let v;
    try { v = await verifyLists(cfg, lists, { fetch }); }
    catch (e) {
      err(`concurrency-proof: no answer from ${cfg.origin} — ${e?.cause?.message ?? e?.message ?? e}`);
      return 1;
    }
    out(`${v.total} ids from ${lists.length} list(s): ${v.distinct} distinct, `
      + `${v.duplicates.length} duplicated, ${v.missing.length} not on the server`);
    if (v.duplicates.length) out(`  duplicated: ${v.duplicates.join(", ")}`);
    if (v.missing.length) out(`  not on the server: ${v.missing.join(", ")}`);
    out(v.ok ? "PROOF: PASS" : "PROOF: FAIL");
    return v.ok ? 0 : 1;
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
