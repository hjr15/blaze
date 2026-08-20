# 11. Database clients are optional peer dependencies, and CI runs a real Postgres

Date: 2026-08-21

## Status

Accepted (BLZ-282)

## Context

[ADR-0006](0006-database-is-the-sole-source-of-truth.md) makes a database the sole
source of truth, and [ADR-0009](0009-read-seam-is-query-shaped.md) fixes the storage
contract as query-shaped so more than one database can satisfy it. BLZ-282 landed the
second real driver — Postgres — alongside SQLite, the filesystem, and the in-memory
driver.

That raised two questions the driver itself does not answer.

**Who pays for the client library?** `node:sqlite` is built into Node 24, so the
SQLite driver costs nothing to distribute. `pg` is a package. Declared as an
`optionalDependency` — the shape BLZ-282 first shipped — npm installs it for
*everyone*, because optional dependencies are installed by default and merely
tolerate installation failure. Measured on the packed tarball: `pg` pulls in 14
packages. The overwhelming majority of Blaze users run on files or SQLite and will
never load a line of it.

**What actually proves the driver works?** The conformance suite's claim is "one
suite, every driver". Its Postgres quarter skips when no server is reachable, which
is correct on a contributor's laptop. But CI had no Postgres either — so the fourth
driver was only ever exercised on a developer's machine, and a Postgres-only
regression would have merged green under a check whose name says the opposite.

## Decision

**`pg` is an optional peer dependency, not an optional dependency.** It is also a
devDependency, so the repo's own tests can run it.

```json
"peerDependencies":     { "pg": "^8.16.0" },
"peerDependenciesMeta": { "pg": { "optional": true } },
"devDependencies":      { "pg": "^8.16.0" }
```

A default install is **1 package with zero dependencies**. Someone running Blaze on
Postgres runs `npm install pg`. The peer range stays as the published statement of
which `pg` majors the driver supports — which a plain devDependency would not give.

This generalises: **every future driver's client library is declared the same way.**
The engine depends on no database client. It states which ones it supports.

**Absence is an ordinary state, so it must read as a setup instruction.** Because
`pg` is now deliberately not installed for most users, "pg is missing" is the *normal*
first encounter for anyone opting into Postgres — not evidence of a broken install.
`openPostgresRead` therefore catches `ERR_MODULE_NOT_FOUND` from its dynamic import
and raises an error naming the package, giving the exact install command, and saying
the other drivers are unaffected. It re-throws every other failure untouched, so a
corrupt install or a broken native binding is not mislabelled as an absent one —
which would send the user to a command they have already run.

**CI provisions a real Postgres.** The tests workflow runs a `postgres:17-alpine`
service and sets `BLAZE_TEST_PG_URL`, so all four drivers are exercised on every pull
request. Deleting that service or its variable is itself a test failure: when
`BLAZE_TEST_PG_URL` is unset *under CI*, the suite fails rather than skipping.
Locally, with no `CI` set, it still skips — a suite that goes red because a
contributor has no database teaches people to ignore it.

## Consequences

Default installs stay lean; Postgres users take one documented step. Coverage rose
from **94.48% to 97.44%** statements once the Postgres driver actually executed in
CI, and `scripts/model/pg-storage.mjs` stopped being a shipped file that no automated
run had ever touched — without excluding it from the gate, which would have made the
coverage number overstate what is tested.

The cost is roughly 15–20 seconds of CI time per run for the service container, and
one setup step for Postgres users. Both were accepted deliberately: the alternative
was a conformance claim that CI never checked.

Sequencing note: driver *selection* is not yet a user-facing choice — the verbs still
write through the transitional filesystem seam (ADR-0010), so nothing reads a
configured driver name yet. First-run driver selection is tracked separately and
belongs with the Phase 2 cutover, not here.
