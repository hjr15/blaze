// scripts/rollup-runner.mjs — `blaze rollup [<id>]`: read-only time roll-up view.
// Builds the index from the resolved data tree's projects/, computes rollUp,
// and prints either one node's own/rolled totals + child breakdown, or a
// summary of all goals/epics. No writes.
import { fileURLToPath } from "node:url";
import { buildIndex } from "./model/index.mjs";
import { rollUp } from "./model/rollup.mjs";
import { formatMinutes } from "./model/time.mjs";
import { resolveRoots } from "./config.mjs";

// Pure formatter (exported for tests). index needs { rows, get(id) }.
export function rollupLines(index, rollupMap, id) {
  if (id) {
    const row = index.get(id);
    const r = rollupMap.get(id);
    if (!row || !r) return [`rollup: id not found: ${id}`];
    const out = [
      `${id}  ${row.type}  ${row.title ?? ""}`.trimEnd(),
      `  own:    estimate ${formatMinutes(r.own_estimate) || "—"} · logged ${formatMinutes(r.own_worklog) || "—"}`,
      `  rolled: estimate ${formatMinutes(r.rolled_estimate) || "0m"} · logged ${formatMinutes(r.rolled_worklog) || "0m"} (${r.descendant_count} descendant${r.descendant_count === 1 ? "" : "s"})`,
    ];
    const kids = index.rows.filter((x) => x.parent === id);
    if (kids.length) {
      out.push("  children:");
      for (const k of kids.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
        const kr = rollupMap.get(k.id);
        out.push(`    ${k.id}  ${k.type}  rolled est ${formatMinutes(kr.rolled_estimate) || "0m"} · logged ${formatMinutes(kr.rolled_worklog) || "0m"}`);
      }
    }
    return out;
  }
  // No id: summarise every goal/epic, grouped by project then id.
  const parents = index.rows
    .filter((x) => x.type === "goal" || x.type === "epic")
    .sort((a, b) => String(a.project).localeCompare(String(b.project)) || String(a.id).localeCompare(String(b.id)));
  if (!parents.length) return ["rollup: no goals or epics found."];
  const out = ["Roll-up (goals + epics):"];
  for (const p of parents) {
    const r = rollupMap.get(p.id);
    out.push(`  ${p.id}  ${p.type.padEnd(5)}  rolled est ${formatMinutes(r.rolled_estimate) || "0m"} · logged ${formatMinutes(r.rolled_worklog) || "0m"}  — ${p.title ?? ""}`.trimEnd());
  }
  return out;
}

function main() {
  const { projectsDir } = resolveRoots();
  const id = process.argv.slice(2).find((a) => !a.startsWith("--")) || null;
  const index = buildIndex(projectsDir);
  const lines = rollupLines(index, rollUp(index), id);
  console.log(lines.join("\n"));
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) main();
