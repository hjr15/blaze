// scripts/model/database-config.mjs — ADR-0012's config shape: the driver name is
// repo config, the connection is not. Credential refusal lives in loadConfig
// (scripts/config.mjs), unconditionally — this function only runs the resolution
// loadConfig has already validated the inputs for (no url/password/user:pass@ can
// reach here, since loadConfig throws on those before a caller ever gets a config
// object to pass in).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRegularFileSync } from "./regular-file.mjs";

const ENV_KEYS = { host: "BLAZE_DB_HOST", port: "BLAZE_DB_PORT", database: "BLAZE_DB_NAME",
                   user: "BLAZE_DB_USER", passwordEnv: "BLAZE_DB_PASSWORD_ENV" };

export function resolveDatabaseConfig({ dataRoot, config = {}, env = process.env }) {
  const dbConfig = config.database ?? {};
  const driver = dbConfig.driver ?? "sqlite";
  if (driver !== "sqlite" && driver !== "postgres") {
    throw new Error(`blaze: database.driver=${JSON.stringify(driver)} is not supported — expected 'sqlite' or 'postgres'.`);
  }
  if (driver === "sqlite") return { driver, connection: null };

  // Precedence: env > .blaze/database.json > blaze.config.json > default (ADR-0012 §4).
  // blaze.config.json never carries connection fields (refused in loadConfig), so the
  // "file" layer here is .blaze/database.json, read only if present — env alone may
  // suffice.
  const path = join(dataRoot, ".blaze", "database.json");
  const fileValues = existsSync(path) ? JSON.parse(readRegularFileSync(path, "utf8")) : {};
  const merged = {};
  for (const [field, envKey] of Object.entries(ENV_KEYS)) {
    merged[field] = env[envKey] ?? fileValues[field];
  }
  if (!merged.host || !merged.port || !merged.database || !merged.user || !merged.passwordEnv) {
    throw new Error(
      `blaze: database.driver is 'postgres' but no complete connection was found — need `
      + "host, port, database, user, passwordEnv from .blaze/database.json and/or "
      + `BLAZE_DB_HOST/BLAZE_DB_PORT/BLAZE_DB_NAME/BLAZE_DB_USER/BLAZE_DB_PASSWORD_ENV. `
      + `Checked ${path} (${existsSync(path) ? "present" : "absent"}).`);
  }
  const password = env[merged.passwordEnv];
  if (password === undefined) {
    throw new Error(
      `blaze: passwordEnv names '${merged.passwordEnv}', but that environment `
      + "variable is not set. Set it before connecting — the password is never stored.");
  }
  return { driver, connection: { host: merged.host, port: Number(merged.port),
                                  database: merged.database, user: merged.user, password } };
}

/**
 * BLZ-673 M-4: the NAME of the variable holding the Postgres password, by the same precedence
 * resolveDatabaseConfig uses (BLAZE_DB_PASSWORD_ENV, then `.blaze/database.json`'s
 * `passwordEnv`), or null. For callers that spawn an untrusted child (the groomer's agent) and
 * must strip the password from its env. Never throws: a missing or unreadable file means no
 * name from it — the caller is removing a secret, not connecting.
 */
export function passwordEnvName({ dataRoot, env = process.env }) {
  if (env[ENV_KEYS.passwordEnv]) return env[ENV_KEYS.passwordEnv];
  try {
    const path = join(dataRoot, ".blaze", "database.json");
    if (!existsSync(path)) return null;
    const v = JSON.parse(readRegularFileSync(path, "utf8"))?.passwordEnv;
    return typeof v === "string" && v ? v : null;
  } catch { return null; }
}
