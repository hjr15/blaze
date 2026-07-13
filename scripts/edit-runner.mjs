// scripts/edit-runner.mjs — CLI entry for `blaze edit <id> <field> <value>`:
// applyEdit against the resolved data tree, then commit (or queue) the
// touched file. Mirrors move-runner.mjs's commit pattern.
import { applyEdit } from "./edit.mjs";
import { loadConfig, resolveRoots } from "./config.mjs";
import { commitOrQueue } from "./commit-or-queue.mjs";

const { dataRoot, projectsDir } = resolveRoots();
const [id, field, ...valueParts] = process.argv.slice(2);
if (!id || !field || valueParts.length === 0) {
  console.error("usage: blaze edit <id> <field> <value>"); process.exit(1);
}
const value = valueParts.join(" ");
const today = new Date().toISOString().slice(0, 10);
const r = applyEdit(projectsDir, id, { [field]: value }, { today });
if (!r.ok) { console.error(`blaze edit failed:\n  ${r.errors.join("\n  ")}`); process.exit(1); }

const cfg = loadConfig({ root: dataRoot });
const c = commitOrQueue({ root: dataRoot, mode: cfg.commitMode, op: "edit", id, message: `${id}: edit ${field}`, files: [r.file] });
if (!c.ok) { console.error(`blaze edit: file written but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
console.log(`${id}: ${field} = ${value}${c.queued ? " (queued for blaze commit)" : ""}`);
