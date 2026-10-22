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
import { sprintDdl } from "./sprint-store.mjs";
import { copyIdentity, verifyIdentity } from "./identity-copy.mjs";

/** v5 → v6: the six identity tables, then sprint/sprint_registry. Additive only. */
async function v5ToV6(exec) {
  await exec.run(identityDdl("postgres"), []);
  await exec.run(sprintDdl("postgres"), []);
}

/** `from → step`. A step brings the schema from `from` to `from + 1`; the stamp is the caller's. */
export const MIGRATIONS = new Map([[5, v5ToV6]]);

/**
 * Bring a Postgres database forward to DB_SCHEMA_VERSION and mark it authoritative, in one
 * transaction. `exec` is `pgExec(client)` over ONE client; this function owns BEGIN, COMMIT and
 * ROLLBACK, and on any failure rolls back and rethrows, so nothing is half-migrated.
 *
 * `identityRows` is `readIdentityRows`'s result (BLZ-706): copied into the identity tables and
 * verified row for row before the commit. `sprintRegistry` is accepted and not yet used (BLZ-707). `beforeVerify(exec)` is a TEST SEAM: it runs after every write
 * and before the verifies, so a test can disturb what the verifies read.
 *
 * @returns {{ from, to, steps: number[], authoritative: "written"|"already",
 *             identity: object|null, sprints: object|null }}
 */
export async function migrateDb(exec, { identityRows = null, sprintRegistry = null,
                                        migrations = MIGRATIONS, beforeVerify = null } = {}) {
  void sprintRegistry;   // BLZ-707 gives this meaning.
  await exec.run("BEGIN", []);
  try {
    // Read BEFORE locking (review I1): an empty or unstamped database may have no blaze_meta to
    // lock, and the raw `relation "blaze_meta" does not exist` would then be the message.
    // `min: 1` (review M1): a stamp below MIN comes back `current` with its version, so the
    // MIGRATE_FROM check below judges it — the `older` message would say "run blaze db migrate",
    // which is circular here.
    const first = await checkDbSchema(exec, { dialect: "postgres", min: 1 });
    if (first.state === "empty") {
      throw new Error("blaze: this database holds no Blaze schema, so there is nothing to migrate. "
        + "Create it with 'blaze db init'.");
    }
    if (first.state === "unstamped") throw new Error(`blaze: ${first.error}`);

    // Two migrates serialise here; plain reads (ACCESS SHARE) carry on.
    await exec.run("LOCK TABLE blaze_meta IN EXCLUSIVE MODE", []);

    // Re-read under the lock: a concurrent migrate that committed first is now seen as v6.
    const state = await checkDbSchema(exec, { dialect: "postgres", min: 1 });
    if (state.state === "newer") {
      throw new Error(`blaze: database schema version ${state.version} is newer than this engine `
        + `(${DB_SCHEMA_VERSION}); upgrade the engine`);
    }
    if (!state.ok) throw new Error(`blaze: ${state.error}`);
    const from = state.version;
    if (from < MIGRATE_FROM) {
      throw new Error(`blaze: no migration path from version ${from} — the oldest this engine `
        + `migrates from is ${MIGRATE_FROM}`);
    }

    const steps = [];
    for (let v = from; v < DB_SCHEMA_VERSION; v++) {
      const step = migrations.get(v);
      if (!step) throw new Error(`blaze: no migration step from version ${v}`);
      await step(exec);
      await exec.run("UPDATE blaze_meta SET value = $1 WHERE key = 'schema_version'", [String(v + 1)]);
      steps.push(v);
    }

    const inserted = await exec.all(
      "INSERT INTO blaze_meta (key, value) VALUES ('authoritative', 'true') "
      + "ON CONFLICT (key) DO NOTHING RETURNING key", []);
    const authoritative = inserted.length ? "written" : "already";

    // ── copy slot: BLZ-706 (identity); BLZ-707 (sprints) inserts its copy here. ──
    const identity = identityRows ? await copyIdentity(exec, identityRows) : null;

    await beforeVerify?.(exec);

    // ── verify slot: BLZ-706 (identity); BLZ-707 inserts its row-for-row verify here. ──
    if (identityRows) await verifyIdentity(exec, identityRows);

    await exec.run("COMMIT", []);
    return { from, to: DB_SCHEMA_VERSION, steps, authoritative, identity, sprints: null };
  } catch (e) {
    try { await exec.run("ROLLBACK", []); } catch { /* the original error is what matters */ }
    throw e;
  }
}
