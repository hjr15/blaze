#!/usr/bin/env node
// scripts/publish-runner.mjs — `blaze publish` (BLZ-135).
//
// The sanctioned way to get local board work onto origin/main. It replaces a raw
//   kubectl create job -n blaze --from=cronjob/blaze-flush blaze-flush-manual-$(date +%s)
// which is not something anyone types from memory — and when the correct path is
// hard, the path people actually take is `git push`, which breaks the
// sole-merger invariant (ADR-0013 decision point 5: make the easy path correct).
//
// Two steps, in this order:
//
//   1. Sweep EVERY local pending queue into commits, host-side.
//   2. Trigger the flush job, which merges and publishes.
//
// Step 1 is not incidental. Pending queues are host state: they live in
// <dataRoot>/.blaze/, which the flush pod cannot see (it mounts only
// blaze.config.json, projects/, and .git). A publish that triggered the flush
// without sweeping would strand exactly the ops that have stranded before.
// Draining host state from the host is also the only version of this that works
// for more than one machine.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveRoots } from "./config.mjs";
import { assertWritable } from "./readonly.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
for (const a of args) {
  if (a !== "--dry-run") {
    console.error(`blaze publish: unknown flag ${a}\nusage: blaze publish [--dry-run]`);
    process.exit(1);
  }
}

// Mirrors the data-root guard the other mutating verbs carry: publishing from a
// non-board directory would sweep nothing and trigger a flush for a board this
// process knows nothing about.
let roots;
try {
  roots = resolveRoots();
} catch (e) {
  console.error(`blaze publish: ${e.message}`);
  process.exit(1);
}
const { dataRoot, projectsDir } = roots;
if (!existsSync(projectsDir)) {
  console.error(`blaze publish: ${projectsDir} does not exist — run this from the board's data root`);
  process.exit(1);
}
assertWritable("publish the board");

// --- step 1: sweep every local queue -----------------------------------------
// --all, not just this session's: the queues that strand are precisely those
// belonging to sessions that ended without committing, so a publish that only
// drained its own would never clear them.
const sweep = spawnSync(process.execPath, [join(import.meta.dirname, "commit-runner.mjs"), "--all"], {
  cwd: dataRoot,
  stdio: "inherit",
  env: process.env,
});
if (sweep.status !== 0) {
  console.error("blaze publish: local sweep failed — not triggering the flush (nothing was published)");
  process.exit(1);
}

// --- step 2: trigger the flush -----------------------------------------------
const NS = process.env.BLAZE_FLUSH_NAMESPACE || "blaze";
const CRONJOB = process.env.BLAZE_FLUSH_CRONJOB || "blaze-flush";
// INF-800: the flush lives on ONE cluster, but this command used to inherit
// whatever context happened to be current. Observed: the ambient context was
// k3d-online-broker-agent while the blaze namespace lives on
// k3d-service-platform, so the trigger failed with `namespaces "blaze" not
// found` — a message that names the namespace and never the context, so it
// reads as "the flush is misconfigured" rather than "you are pointed at the
// wrong cluster". Naming the target explicitly makes publishing independent of
// whatever the last kubectl command in the shell was doing.
const CONTEXT = process.env.BLAZE_FLUSH_CONTEXT || "";
// Seconds since epoch: unique per invocation, and readable in `kubectl get job`.
const jobName = `${CRONJOB}-manual-${Math.floor(Date.now() / 1000)}`;
const trigger = [
  "kubectl",
  ...(CONTEXT ? ["--context", CONTEXT] : []),
  "create", "job", "-n", NS, "--from", `cronjob/${CRONJOB}`, jobName,
];

// Whatever happens next, the operator needs to know which cluster was targeted.
// Unset is legitimate (single-cluster machines, CI), so it is described rather
// than refused — but described loudly enough that a wrong-cluster failure is
// self-diagnosing instead of pointing at the namespace.
const contextNote = CONTEXT
  ? `context ${CONTEXT}`
  : "the ambient kubectl context (BLAZE_FLUSH_CONTEXT unset — set it to the flush cluster to make this deterministic)";

if (dryRun) {
  console.log(`dry-run: would trigger the flush against ${contextNote} with:\n  ${trigger.join(" ")}`);
  process.exit(0);
}

const r = spawnSync(trigger[0], trigger.slice(1), { encoding: "utf8", stdio: "inherit" });
if (r.error && r.error.code === "ENOENT") {
  console.error(
    "blaze publish: kubectl not found — the local sweep committed, but nothing was published.\n" +
    `  Trigger the flush from a machine with cluster access:\n    ${trigger.join(" ")}`,
  );
  process.exit(1);
}
if (r.status !== 0) {
  console.error(
    `blaze publish: flush trigger failed (status ${r.status}) against ${contextNote}. ` +
    `The local sweep committed; origin/main is unchanged until a flush runs.\n` +
    `  If kubectl reported \`namespaces "${NS}" not found\`, the cluster is almost certainly the ` +
    `problem and not the namespace — check \`kubectl config get-contexts\` and set ` +
    `BLAZE_FLUSH_CONTEXT to the cluster that hosts the ${NS} namespace.`,
  );
  process.exit(1);
}
console.log(
  `blaze publish: swept local queues and triggered ${jobName} in namespace ${NS} against ${contextNote}`,
);
