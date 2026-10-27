// scripts/model/db-migrate.mjs — `blaze db migrate`'s engine: a forward-only schema migration
// for Postgres, in ONE transaction (BLZ-705, spec D1(b)).
//
// Every earlier version bump rebuilt the database instead, because it was DERIVED: the SQLite
// shadow and a freshly loaded Postgres database are copies of a file corpus. Phase 5 makes the
// Postgres database the board itself — after the cutover there is no corpus to rebuild from —
// so the bump to v6 is the first that must be applied in place. Each step is additive DDL, the
// stamp moves with it, and the migrate also writes `blaze_meta('authoritative', 'true')`: from
// then on `load --replace` refuses, and the `older` refusal names migrate, not a rebuild.
//
// Re-running it is a no-op. Two concurrent runs serialise on a lock on `blaze_meta`.
import { checkDbSchema, DB_SCHEMA_VERSION, MIGRATE_FROM } from "./db-schema-version.mjs";
import { identityDdl } from "./identity-schema.mjs";
import { sprintDdl, writeSprintRegistry, readSprintRegistry } from "./sprint-store.mjs";
import { copyIdentity, verifyIdentity } from "./identity-copy.mjs";
import { canonicalStrict } from "./write-port.mjs";

/** v5 → v6: the six identity tables, then sprint/sprint_registry. Additive only. */
async function v5ToV6(exec) {
  await exec.run(identityDdl("postgres"), []);
  await exec.run(sprintDdl("postgres"), []);
}

/** `from → step`. A step brings the schema from `from` to `from + 1`; the stamp is the caller's. */
export const MIGRATIONS = new Map([[5, v5ToV6]]);

/**
 * The refusal (a `blaze: …` message) for a `checkDbSchema(…, { min: 1 })` state migrate cannot
 * take — empty, unstamped, newer, or older than MIGRATE_FROM — or null when it can.
 * `blaze db migrate` judges this once before its stranded-file refusals (E1 final review M8), so
 * a database it would refuse anyway is named first; `migrateDb` judges it again under its lock.
 */
export function migrateRefusal(state) {
  if (state.state === "empty") {
    return "blaze: this database holds no Blaze schema, so there is nothing to migrate. "
      + "Create it with 'blaze db init'.";
  }
  if (state.state === "unstamped") return `blaze: ${state.error}`;
  if (state.state === "newer") {
    return `blaze: database schema version ${state.version} is newer than this engine `
      + `(${DB_SCHEMA_VERSION}); upgrade the engine`;
  }
  if (!state.ok) return `blaze: ${state.error}`;
  if (state.version < MIGRATE_FROM) {
    return `blaze: no migration path from version ${state.version} — the oldest this engine `
      + `migrates from is ${MIGRATE_FROM}`;
  }
  return null;
}

/**
 * Bring a Postgres database forward to DB_SCHEMA_VERSION and mark it authoritative, in one
 * transaction. `exec` is `pgExec(client)` over ONE client; this function owns BEGIN, COMMIT and
 * ROLLBACK, and on any failure rolls back and rethrows, so nothing is half-migrated.
 *
 * `identityRows` is `readIdentityRows`'s result (BLZ-706): copied into the identity tables and
 * verified row for row before the commit. `sprintRegistry` is `parseSprintRegistry`'s result
 * (BLZ-707): written to the sprint tables and read back whole, compared by `canonicalStrict`,
 * before the commit; `sprintSource` names it (a path) in a verify failure. `beforeVerify(exec)`
 * is a TEST SEAM: it runs after every write and before the verifies, so a test can disturb what
 * the verifies read.
 *
 * @returns {{ from, to, steps: number[], authoritative: "written"|"already",
 *             identity: object|null, sprints: object|null }}
 */
export async function migrateDb(exec, { identityRows = null, sprintRegistry = null,
                                        sprintSource = "the source registry",
                                        migrations = MIGRATIONS, beforeVerify = null } = {}) {
  // READ COMMITTED explicitly: the lock-then-re-read below sees a concurrent migrate's commit
  // only because each statement takes a fresh snapshot. Under a server default of REPEATABLE
  // READ the re-read would see the pre-lock snapshot and migrate twice.
  await exec.run("BEGIN ISOLATION LEVEL READ COMMITTED", []);
  try {
    // Read BEFORE locking (review I1): an empty or unstamped database may have no blaze_meta to
    // lock, and the raw `relation "blaze_meta" does not exist` would then be the message.
    // `min: 1` (review M1): a stamp below MIN comes back `current` with its version, so the
    // MIGRATE_FROM check below judges it — the `older` message would say "run blaze db migrate",
    // which is circular here.
    const first = await checkDbSchema(exec, { dialect: "postgres", min: 1 });
    if (first.state === "empty" || first.state === "unstamped") throw new Error(migrateRefusal(first));

    // Two migrates serialise here; plain reads (ACCESS SHARE) carry on.
    await exec.run("LOCK TABLE blaze_meta IN EXCLUSIVE MODE", []);

    // Re-read under the lock: a concurrent migrate that committed first is now seen as v6.
    const state = await checkDbSchema(exec, { dialect: "postgres", min: 1 });
    const refusal = migrateRefusal(state);
    if (refusal) throw new Error(refusal);
    const from = state.version;

    const steps = [];
    for (let v = from; v < DB_SCHEMA_VERSION; v++) {
      const step = migrations.get(v);
      if (!step) throw new Error(`blaze: no migration step from version ${v}`);
      await step(exec);
      await exec.run("UPDATE blaze_meta SET value = $1 WHERE key = 'schema_version'", [String(v + 1)]);
      steps.push(v);
    }

    // True by construction: any other value is overwritten. A row comes back only when this
    // statement inserted or changed it, which is what "written" means.
    const inserted = await exec.all(
      "INSERT INTO blaze_meta (key, value) VALUES ('authoritative', 'true') "
      + "ON CONFLICT (key) DO UPDATE SET value = 'true' WHERE blaze_meta.value <> 'true' RETURNING key", []);
    const authoritative = inserted.length ? "written" : "already";

    // ── copy slot: BLZ-706 (identity); BLZ-707 (sprints). ──
    const identity = identityRows ? await copyIdentity(exec, identityRows) : null;
    const sprints = sprintRegistry ? await copySprints(exec, sprintRegistry) : null;

    await beforeVerify?.(exec);

    // ── verify slot: BLZ-706 (identity); BLZ-707 (sprints). ──
    if (identityRows) await verifyIdentity(exec, identityRows);
    if (sprintRegistry) await verifySprints(exec, sprintRegistry, sprintSource);

    await exec.run("COMMIT", []);
    return { from, to: DB_SCHEMA_VERSION, steps, authoritative, identity, sprints };
  } catch (e) {
    try { await exec.run("ROLLBACK", []); } catch { /* the original error is what matters */ }
    throw e;
  }
}

/** BLZ-707: the registry into EMPTY sprint tables — a second import is refused, never merged. */
async function copySprints(exec, registry) {
  const [{ n }] = await exec.all("SELECT count(*) AS n FROM sprint", []);
  const held = await exec.all("SELECT 1 FROM sprint_registry", []);
  if (Number(n) > 0 || held.length) {
    throw new Error("sprint copy refused: the sprint tables already hold a registry");
  }
  await writeSprintRegistry(exec, registry);
  return { count: registry.sprints.length, active: registry.active ?? null };
}

/** BLZ-707: the registry read back whole must equal the source, key for key, type for type. */
async function verifySprints(exec, source, sourceName) {
  const got = await readSprintRegistry(exec);
  if (canonicalStrict(got) === canonicalStrict(source)) return;
  const byId = new Map(got.sprints.map((s) => [s.id, s]));
  const wantIds = new Set(source.sprints.map((s) => s.id));
  const first = source.sprints.find((s) => canonicalStrict(s) !== canonicalStrict(byId.get(s.id)))?.id
    ?? got.sprints.find((s) => !wantIds.has(s.id))?.id;
  throw new Error(`sprint verify: the registry read back from Postgres differs from ${sourceName}`
    + (first !== undefined ? ` (first difference: sprint ${first})` : ""));
}
