import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchRegistry } from "../helpers/scratch.mjs";
import { resolveDatabaseConfig } from "../../scripts/model/database-config.mjs";

const scratch = scratchRegistry();

function withDatabaseJson(dataRoot, obj) {
  mkdirSync(join(dataRoot, ".blaze"));
  writeFileSync(join(dataRoot, ".blaze", "database.json"), JSON.stringify(obj));
  chmodSync(join(dataRoot, ".blaze", "database.json"), 0o600);
}

test("defaults to sqlite with no config anywhere", () => {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blaze-dbcfg-")));
  const result = resolveDatabaseConfig({ dataRoot, config: {}, env: {} });
  assert.deepEqual(result, { driver: "sqlite", connection: null });
});

test("postgres driver with a complete .blaze/database.json resolves a connection", () => {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blaze-dbcfg-")));
  withDatabaseJson(dataRoot, { host: "db.example", port: 5432, database: "blaze",
                               user: "blaze", passwordEnv: "BLZ_DB_PW" });
  const result = resolveDatabaseConfig({
    dataRoot, config: { database: { driver: "postgres" } },
    env: { BLZ_DB_PW: "secret" } });
  assert.equal(result.driver, "postgres");
  assert.deepEqual(result.connection,
    { host: "db.example", port: 5432, database: "blaze", user: "blaze", password: "secret" });
});

test("postgres driver with passwordEnv pointing at an unset var refuses", () => {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blaze-dbcfg-")));
  withDatabaseJson(dataRoot, { host: "db.example", port: 5432, database: "blaze",
                               user: "blaze", passwordEnv: "BLZ_DB_PW_UNSET" });
  assert.throws(
    () => resolveDatabaseConfig({ dataRoot, config: { database: { driver: "postgres" } }, env: {} }),
    /blaze:.*BLZ_DB_PW_UNSET/);
});

test("postgres driver with no .blaze/database.json at all refuses, not silently falls back", () => {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blaze-dbcfg-")));
  assert.throws(
    () => resolveDatabaseConfig({ dataRoot, config: { database: { driver: "postgres" } }, env: {} }),
    /blaze:.*\.blaze\/database\.json/);
});

// The `database.url` / `user:pass@` refusal tests moved to Step 3a below — they test
// `loadConfig`, not `resolveDatabaseConfig`, since that's where the refusal now lives
// (unconditionally, matching ADR-0012's literal text) rather than only when this
// function happens to be called.

test("BLAZE_DB_* env vars override .blaze/database.json, per ADR-0012 §4 precedence", () => {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blaze-dbcfg-")));
  withDatabaseJson(dataRoot, { host: "file-host", port: 5432, database: "file-db",
                               user: "file-user", passwordEnv: "FILE_PW" });
  const result = resolveDatabaseConfig({
    dataRoot, config: { database: { driver: "postgres" } },
    env: { FILE_PW: "unused", ENV_PW: "from-env",
           BLAZE_DB_HOST: "env-host", BLAZE_DB_PASSWORD_ENV: "ENV_PW" } });
  assert.equal(result.connection.host, "env-host");   // env wins over the file
  assert.equal(result.connection.password, "from-env");
  assert.equal(result.connection.database, "file-db"); // untouched fields still come from the file
});

test("with no .blaze/database.json, BLAZE_DB_* env vars alone are sufficient", () => {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blaze-dbcfg-")));
  const result = resolveDatabaseConfig({
    dataRoot, config: { database: { driver: "postgres" } },
    env: { BLAZE_DB_HOST: "h", BLAZE_DB_PORT: "5432", BLAZE_DB_NAME: "d",
           BLAZE_DB_USER: "u", ENV_PW: "p", BLAZE_DB_PASSWORD_ENV: "ENV_PW" } });
  assert.deepEqual(result.connection, { host: "h", port: 5432, database: "d", user: "u", password: "p" });
});
