// scripts/model/projection.mjs — rebuilding resolved_* and reporting orphans (BLZ-288).
//
// The Phase 1 criterion this exists for: *"refresh_projection() reports every ticket a
// new config would orphan rather than failing opaquely."*
//
// WHY THIS IS JS AND NOT A STORED FUNCTION. The design writes it as
// `blaze_config.refresh_projection()`. SQLite has no stored procedures, so a plpgsql
// function would give Postgres one implementation and SQLite none — and the projection
// is exactly the thing that must behave identically on a laptop and on the cluster,
// because it is what makes a config restore safe. One implementation, both drivers,
// same reported orphans.
//
// WHY IT REPORTS INSTEAD OF FAILING. A restored config that no longer contains a type,
// or has dropped a status from a workflow, does not make the tickets wrong — it makes
// the pairing wrong, and only a human can say which side is stale. In Postgres the
// alternative is an FK violation naming one row; in SQLite, across ATTACHed files, it
// is no error at all. Neither tells you the thing you need to know, which is HOW MANY
// tickets and WHICH ONES.
//
// The scope sentinel: `'*'` is board-wide, a project key is that project only, and a
// project-scoped row REPLACES the board-wide one for that project (it never merges).
const BOARD = "*";

/** Every check the projection knows how to run, in report order. */
const ORPHAN_CHECKS = [
  {
    kind: "unknown-type",
    detail: "the ticket's type is not in the restored config for its project",
    sql: `SELECT t.id AS ticket_id, t.project_key, t.type AS value
            FROM ticket t
            LEFT JOIN resolved_type r
              ON r.project_key = t.project_key AND r.type = t.type
           WHERE r.type IS NULL AND t.deleted_at IS NULL`,
  },
  {
    kind: "unknown-status",
    detail: "the ticket's status is not in its type's workflow in the restored config",
    sql: `SELECT t.id AS ticket_id, t.project_key, t.status AS value
            FROM ticket t
            JOIN resolved_type rt
              ON rt.project_key = t.project_key AND rt.type = t.type
            LEFT JOIN resolved_status rs
              ON rs.project_key = t.project_key AND rs.type = t.type AND rs.status = t.status
           WHERE rs.status IS NULL AND t.deleted_at IS NULL`,
  },
  {
    kind: "unknown-priority",
    detail: "the ticket's priority is not in the restored config",
    sql: `SELECT t.id AS ticket_id, t.project_key, t.priority AS value
            FROM ticket t
            LEFT JOIN resolved_priority p ON p.name = t.priority
           WHERE t.priority IS NOT NULL AND p.name IS NULL AND t.deleted_at IS NULL`,
  },
  {
    kind: "unknown-resolution",
    detail: "the ticket's resolution is not in the restored config",
    sql: `SELECT t.id AS ticket_id, t.project_key, t.resolution AS value
            FROM ticket t
            LEFT JOIN resolved_resolution r ON r.name = t.resolution
           WHERE t.resolution IS NOT NULL AND t.resolution <> ''
             AND r.name IS NULL AND t.deleted_at IS NULL`,
  },
  {
    kind: "illegal-parent-type",
    detail: "the parent/child type pair is no longer legal in the restored config",
    sql: `SELECT t.id AS ticket_id, t.project_key,
                 t.parent_type AS value
            FROM ticket t
            LEFT JOIN resolved_type_parent rp
              ON rp.project_key = t.project_key
             AND rp.child_type  = t.type
             AND rp.parent_type = t.parent_type
           WHERE t.parent_id IS NOT NULL AND t.parent_type IS NOT NULL
             AND rp.parent_type IS NULL AND t.deleted_at IS NULL`,
  },
  {
    kind: "unknown-link-type",
    detail: "a link on this ticket uses a type the restored config does not define",
    sql: `SELECT l.src_id AS ticket_id, t.project_key, l.link_type AS value
            FROM ticket_link l
            JOIN ticket t ON t.id = l.src_id
            LEFT JOIN resolved_link_type r ON r.name = l.link_type
           WHERE r.name IS NULL AND t.deleted_at IS NULL`,
  },
];

/**
 * Scope-resolve the sparse authored config into the dense per-project projection.
 *
 * Pure: takes rows, returns rows. That is what makes the resolution rules testable
 * without a database, and it is where the `'*'` sentinel is actually interpreted.
 */
export function resolveProjection(config) {
  const projects = config.project ?? [];
  const pick = (rows, key, projectKey) =>
    rows.filter((r) => r[key] === projectKey).length
      ? rows.filter((r) => r[key] === projectKey)
      : rows.filter((r) => r[key] === BOARD);

  const out = {
    resolved_project: [], resolved_type: [], resolved_type_parent: [],
    resolved_required_field: [], resolved_status: [], resolved_transition: [],
    resolved_label: [], resolved_component: [],
    resolved_priority: (config.priority ?? []).map((p) => ({ name: p.name, ord: p.ord })),
    resolved_resolution: (config.resolution ?? []).map((r) => ({ name: r.name, is_success: !!r.is_success })),
    resolved_link_type: (config.link_type ?? []).map((l) => ({
      name: l.name, is_directed: !!l.is_directed, is_trace: !!l.is_trace })),
  };

  for (const p of projects) {
    const key = p.key;
    out.resolved_project.push({
      project_key: key, name: p.name,
      label_mode: p.label_mode ?? "open", component_mode: p.component_mode ?? "open",
      require_labels: !!p.require_labels,
      require_components: !!p.require_components,
      require_worklog_before_terminal: !!p.require_worklog_before_terminal,
    });

    const types = pick(config.ticket_type ?? [], "scope", key);
    const workflowsInScope = pick(config.workflow ?? [], "scope", key);
    const statusesInScope = pick(config.workflow_status ?? [], "scope", key);
    const transitionsInScope = pick(config.workflow_transition ?? [], "scope", key);

    for (const t of types) {
      out.resolved_type.push({ project_key: key, type: t.type, level: t.level,
                               workflow: t.workflow, ord: t.ord ?? 0 });

      // Flatten workflow -> type. This is the denormalisation that lets ticket→status
      // be a two-column FK on the ticket's own (project_key, type).
      for (const s of statusesInScope.filter((s) => s.workflow === t.workflow)) {
        out.resolved_status.push({
          project_key: key, type: t.type, status: s.status, ord: s.ord,
          is_terminal: !!s.is_terminal,
          resolution_on_terminal: s.resolution_on_terminal ?? null,
        });
      }
      const wf = workflowsInScope.find((w) => w.name === t.workflow);
      for (const tr of transitionsInScope.filter((x) => x.workflow === t.workflow)) {
        out.resolved_transition.push({
          project_key: key, type: t.type,
          from_status: tr.from_status, to_status: tr.to_status,
          is_reopen: !!wf && tr.to_status === wf.reopen_to,
        });
      }
    }

    for (const tp of pick(config.type_parent ?? [], "scope", key)) {
      // Only project a pair whose child type actually resolved for this project.
      if (types.some((t) => t.type === tp.child_type)) {
        out.resolved_type_parent.push({ project_key: key, child_type: tp.child_type,
                                        parent_type: tp.parent_type });
      }
    }
    for (const rf of pick(config.type_required_field ?? [], "scope", key)) {
      if (types.some((t) => t.type === rf.type)) {
        out.resolved_required_field.push({ project_key: key, type: rf.type, field: rf.field });
      }
    }
    for (const l of (config.project_label ?? []).filter((l) => l.project_key === key && !l.retired_at)) {
      out.resolved_label.push({ project_key: key, name: l.name });
    }
    for (const c of (config.project_component ?? []).filter((c) => c.project_key === key && !c.retired_at)) {
      out.resolved_component.push({ project_key: key, name: c.name });
    }
  }
  return out;
}

const ENCODE = (v, pg) => (typeof v === "boolean" ? (pg ? v : (v ? 1 : 0)) : v);

/**
 * Rebuild resolved_* from the authored config, then report what the new config orphans.
 *
 * @param exec  { all(sql, params) -> rows, run(sql, params) } — sync or async, awaited either way
 * @param config  the authored config rows (as `configSeed()` shapes them)
 * @param opts  { dialect, now, configVersion }
 * @returns { orphans, counts, projected, refreshedAt }
 */
export async function refreshProjection(exec, config, { dialect = "sqlite", now, configVersion = 1 } = {}) {
  if (dialect !== "sqlite" && dialect !== "postgres") {
    throw new Error(`unknown dialect ${JSON.stringify(dialect)} — expected 'sqlite' or 'postgres'`);
  }
  const pg = dialect === "postgres";
  const ph = (i) => (pg ? `$${i + 1}` : "?");
  const projected = resolveProjection(config);

  // Rebuild in one transaction. A half-rebuilt projection is worse than a stale one:
  // stale is detectable via projection_meta, half-rebuilt looks current and is not.
  await exec.run("BEGIN", []);
  try {
    // Reverse dependency order for the delete, forward for the insert.
    const order = ["resolved_transition", "resolved_status", "resolved_required_field",
                   "resolved_type_parent", "resolved_type", "resolved_label",
                   "resolved_component", "resolved_project", "resolved_priority",
                   "resolved_resolution", "resolved_link_type"];
    for (const table of order) await exec.run(`DELETE FROM ${table}`, []);

    const insertOrder = ["resolved_project", "resolved_priority", "resolved_resolution",
                         "resolved_link_type", "resolved_type", "resolved_type_parent",
                         "resolved_required_field", "resolved_status", "resolved_transition",
                         "resolved_label", "resolved_component"];
    const counts = {};
    for (const table of insertOrder) {
      const rows = projected[table] ?? [];
      counts[table] = rows.length;
      for (const row of rows) {
        const cols = Object.keys(row);
        await exec.run(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => ph(i)).join(", ")})`,
          cols.map((c) => ENCODE(row[c], pg)));
      }
    }

    const refreshedAt = now ?? new Date().toISOString();
    await exec.run("DELETE FROM projection_meta", []);
    await exec.run(
      `INSERT INTO projection_meta (id, config_version, refreshed_at) VALUES (1, ${ph(0)}, ${ph(1)})`,
      [configVersion, refreshedAt]);
    await exec.run("COMMIT", []);

    // Orphans are read AFTER the commit, deliberately: the report describes the config
    // that is now live, so acting on it does not race a rollback.
    const orphans = [];
    for (const check of ORPHAN_CHECKS) {
      for (const row of (await exec.all(check.sql, [])) ?? []) {
        orphans.push({ kind: check.kind, detail: check.detail,
                       ticket: row.ticket_id, project: row.project_key, value: row.value });
      }
    }
    orphans.sort((a, b) =>
      a.kind.localeCompare(b.kind) || String(a.ticket).localeCompare(String(b.ticket)));
    return { orphans, counts, projected, refreshedAt };
  } catch (e) {
    // A sync driver returns undefined here, so `.catch()` on the result would throw a
    // TypeError and REPLACE the real failure with a bogus one. Swallow via try/catch.
    try { await exec.run("ROLLBACK", []); } catch { /* the original error is what matters */ }
    throw e;
  }
}

/** Is the projection stale relative to the authored config version? */
export async function projectionIsStale(exec, configVersion) {
  const rows = await exec.all("SELECT config_version FROM projection_meta WHERE id = 1", []);
  if (!rows?.length) return true;   // never refreshed
  return Number(rows[0].config_version) !== Number(configVersion);
}
