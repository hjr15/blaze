// scripts/model/sprint-store.mjs — the sprint registry's database mapping (BLZ-705, spec D3).
//
// Sprints are data (the `sprints.mjs` header, ADR-0004), so on a Postgres board at schema v6
// they live in two tables: `sprint`, one row per sprint, and `sprint_registry`, the singleton
// that holds the active sprint and the registry's version. Both `extra_json` columns keep
// BLZ-369's rule — preserve what this engine does not understand — at both levels.
//
// No FK from `ticket.sprint_id` (spec D3): a migrate step must not fail on orphan data, and the
// engine already validates `--sprint` against the registry.
//
// BOTH DIALECTS ARE DECLARED, ONE IS INSTALLED (review I3). `sprint_registry` is a singleton in
// ADR-0014's own definition, and `tests/adr-0014-singletons.test.mjs` requires the two dialects
// to declare the same singleton set. So the SQLite form exists as an inert twin, and only
// `applyCreate` and `v5ToV6` install it — on Postgres only. The SQLite shadow is derived: a
// sprint written there would be lost on the next rebuild.
import { dialect } from "./sql-dialect.mjs";

/** Postgres has a `date` type; SQLite keeps an ISO `YYYY-MM-DD` string. */
const DATE = { postgres: "date", sqlite: "TEXT" };

/** The DDL for `sprint` and `sprint_registry`, for `"sqlite"` or `"postgres"`. */
export function sprintDdl(name) {
  const d = dialect(name);
  const date = DATE[name];
  return `
CREATE TABLE IF NOT EXISTS sprint (
  id         ${d.txt} PRIMARY KEY,
  name       ${d.txt} NOT NULL,
  start_date ${date},
  end_date   ${date},
  ord        ${d.int} NOT NULL,
  extra_json ${d.txt} NOT NULL DEFAULT '{}'
)${d.tbl};

CREATE TABLE IF NOT EXISTS sprint_registry (
  id               ${d.int} PRIMARY KEY CHECK (id = 1),
  active           ${d.txt},
  registry_version ${d.int},
  extra_json       ${d.txt} NOT NULL DEFAULT '{}'
)${d.tbl};
`;
}
