# Phase 5 — retire blaze-pm: the live board's data lives only in Postgres

Date: 2026-10-22 · Follows: BLZ-254 (done) · Parent: **BLZ-2** (Writer's call, §10)
Supersedes §8 of `2026-09-23-blaze-v3-phase2-db-cutover-design.md` ("Phase 5 — retirement:
no new ticket"). That section assumed the archive was a checklist. Recon on 2026-10-22 found
six runtime dependencies on blaze-pm that are still live, so the checklist is not enough.
Not to be confused with **BLZ-257**, "Blaze v3 Phase 5 — extract the eight services". That
is the v3 programme's *service* phase. Ticket titles here say "retire blaze-pm" and never
"Phase 5" alone.

Evidence base: engine `main` @ `5904845`; service-platform @ `26e8ebf`; claude-config @
`92209f3`; blaze-pm `v4-spine` worktree @ `a65adb7b`, which is the **2026-10-21 snapshot**.
The board itself is in Postgres and was not read. Every ticket id cited from blaze-pm was
true on that snapshot. BLZ-701/702 and INF-932/933 were filed after it, so they come from
the brief.

The operator's intent, quoted: *"The plan was to move off the blaze-pm repo so everything is
in the postgres database."* Every call the writer made is marked **Writer's call** and gives
the reason, so it can be overturned in one edit. The operator answered four questions on
2026-10-22. Those answers are marked **Operator decision (2026-10-22)**:
- OD1: config lives in the GitOps chart (D4).
- OD2: reconcile is dropped, and tickets are moved by hand (D6).
- OD3: the Live view is let go (D10).
- OD4: the second machine has no blaze-pm clone (D9).

**Pod admin commands.** The image has no `blaze` on `PATH` (its Dockerfile ends
`CMD ["node", "scripts/serve.mjs"]`). Every in-pod command in this spec is therefore
`kubectl exec -n blaze deploy/blaze -- node scripts/cli.mjs <verb>`, written **`pod-blaze
<verb>`** below. **Writer's call:** this needs no image change. A `blaze` bin in the image
would only save typing.

## 1. Intent and why

Since 2026-10-21 the live board (`blaze.howman.link`, CNPG `blaze-pg`,
`BLAZE_WRITE_PORT=db`, engine 0.9.0) has written its tickets only to Postgres. blaze-pm is
still load-bearing in three ways:

1. **It holds state Postgres doesn't.** The users, sessions and tokens are in
   `blaze-pm/.blaze/identity.db`, which is hostPath-mounted from the dirty `BLZ-143` main
   checkout. The sprint registry is in `sprints.json`, which is not mounted at all, so the live
   gantt is empty and `--sprint` is rejected. The per-project taxonomy is in
   `projects/*/project.json`.
2. **It is a second writable board.** A `blaze` run inside blaze-pm in fs mode writes ticket
   files and commits that never reach the live board. This happened after the cutover:
   INF-928, INF-930 and INF-931 had to be replayed into the database.
3. **Tools and docs still point at it.** These include claude-config agents and skills,
   docs-central's launchpad, the k8s-posture-audit tests, and service-platform's mounts and
   runbook.

Phase 5 closes all three. When it is done, Postgres is the only store of board *data*.
GitOps (the service-platform chart) is the only store of board *configuration*. blaze-pm is
a read-only GitHub archive.

## 2. Goals, non-goals, anti-goals

**Goals**
- G1. Every user, token, session, sprint and ticket the live board serves is read from Postgres.
- G2. The board pod mounts nothing from a laptop checkout. No hostPath for `.blaze`,
  `projects` or `.git`, and no git environment.
- G3. Board configuration has exactly one source, the chart (D4).
- G4. A write aimed at anything other than the live board is refused, whether by an
  engine guard or by the archive leaving nothing to write to (D5).
- G5. Agents operate the live board from any repo over remote mode. A session gets a
  token without the token ever entering a transcript (D7).
- G6. Every external consumer is repointed (§6), and hjr15/blaze-pm is archived on GitHub with
  a verified offline bundle (D9).

**Non-goals**
- Re-enabling the groomer loop on the live board. It stays `enabled: false`, as it is today.
- Any automatic status derivation from branches or PRs on the live board. Reconcile is
  dropped (OD2, D6).
- Remote `import`, `groom`, `db`, `sprint` or `user`. These stay admin verbs, run inside the
  pod (D7).
- A db→git export. As in BLZ-254 §10, none will be built.
- Changing fs mode as a product. fs boards keep `sprints.json`, `identity.db` and
  `project.json` files exactly as they work today.
- Multi-instance Postgres, point-in-time recovery, or moving off k3d.

**Anti-goals** (each one is a hard stop in the runbook)
- A1. Losing any user, token, session-bearing admin, sprint, sprint membership or ticket.
  The identity copy and the sprint copy each need a row-for-row verify, not only a row count.
- A2. A board that silently diverges again. The guard must refuse a write, never just warn
  about it.
- A3. A credential materialising where an agent can see it. That covers a token in chat,
  in `env` output or in a log, a decoded Secret, and the `admin-api-token.txt` file.
- A4. Deleting blaze-pm. It is archived and kept indefinitely (2026-08-31 plan, Q4).
- A5. A schema change that the documented recovery would *destroy*. Today the documented
  answer to an old schema stamp is `blaze db init --force` "from the corpus", and after
  Phase 5 there is no corpus. The other destroyer is `blaze db load --replace`, which
  truncates the ticket tables (D1).

## 3. What recon found that the brief did not say

| Finding | Where | Consequence |
|---|---|---|
| The engine's schema-version machinery assumes the database is *derived*. An old stamp is answered with "rebuild it … `blaze db init --force`", and there is **no migrate command**. The stamp is a `blaze_meta(key, value)` row with key `schema_version`. There is no `meta` table. | `db-schema-version.mjs:43-67, 89-93, 137-146`; `db-runner.mjs:529` | Adding sprint or identity tables to a live, authoritative database needs Phase 5's **first forward migration** (D1). |
| `blaze db init --force` is **already refused on Postgres**. `blaze db load --replace` empties only the seven ticket tables (`LOAD_TABLES`). | `db-runner.mjs:40, 74-77, 196-197` | The authoritative flag has to guard only `load --replace` and the `older` message (D1). |
| The pod runs `serve.mjs`'s standalone block, not `blaze board`. Identity is loaded twice: at start, and again after setup completes. | `serve.mjs:957-971` (`startServer({ root })`), `serve.mjs:558` (`loadIdentity(root)` after setup) | The pg identity load is wired at both points (D2). |
| `identityStore` is already dialect-aware (`'postgres'` placeholders, async API), and `identityDdl(name)` already emits Postgres DDL. Nothing constructs the pg variant | `identity-store.mjs:27`, `identity-schema.mjs:31`, `serve.mjs:316-325` | Identity in Postgres is wiring, not a new store. `serve.mjs`'s `setupInFlight` guard becomes live for the first time and needs a real test. |
| `startServer` takes `identity` as a *parameter* (`identity = loadIdentity(root)`) | `serve.mjs:277` | The async pg load can run at the entry point before bind, so the sync bind-safety check stays sync. |
| `blaze_config.project` already exists, with `code_repos_json` and taxonomy columns. Nothing populates or reads it | `config-schema.mjs:119-133` | It is an option for D3, but it is built and unused. |
| `loadProject` and `loadSprints` are synchronous and have about 20 callers | `config.mjs:503`, `sprints.mjs:47` | db-backed sources must be **prefetched at the entry point** and passed down (the ADR-0038 pattern), not made async throughout. |
| All 17 blaze-pm ADRs already exist as BLZ architecture tickets **BLZ-202…BLZ-218** (`ref: ADR-0001…0017`), under its own ADR-0017 ("the ticket body is the decision record") | v4-spine `projects/BLZ/accepted/` | `docs/decisions/` is archived, not moved (§6). |
| Remote mode has no read verb (`REMOTE_VERBS` = new, move, edit, resolve, log, link) and no JSON ticket-read endpoint. `/api/panel` returns HTML | `remote-client.mjs:24-27`, `serve-auth.mjs:27-56` | With no checkout to read, agents cannot see a ticket. Remote reads become required (D7). |
| `remote-client.mjs` uses built-in `fetch` and has no CA handling | `remote-client.mjs:17` | Node's `fetch` honours `NODE_EXTRA_CA_CERTS`, so no engine CA option is needed (D7). |
| blaze-pm pins engine `v0.8.0` (`package.json`) | v4-spine | An engine-side guard does not protect a write made with blaze-pm's own pinned engine (D5). |
| `blaze.config.json` differs between the main checkout (`BLZ-143` HEAD plus one dirty line) and `v4-spine` (the `epic` type and `parentTypes`) | `git diff` | The chart ConfigMap must be diffed against **both** before archive (runbook step 1). |
| `projects/OMA/project.json`'s description cites `docs/exec-board/decisions/2026-07-20-…` | v4-spine | This path moves (§6), so the text is updated with it. |
| `blaze-pm/.blaze/admin-api-token.txt` exists, mode 0600 | `ls` only, never read | It is a plaintext credential. Disposition in D9 (A3). |
| `branch` and `pr` are **not** in `EDITABLE_FIELDS`. Only reconcile writes them. | `fields.mjs:22-25` | With reconcile dropped, those fields stay as they are on existing tickets and stay empty on new ones (D6). |
| `GET /api/live` is not gated by `views.live`. Only `/view/<name>` is. The live ConfigMap already has `views.live: false`. | `serve.mjs:707-727`, `config.mjs:62` | Retiring the Live view needs a gate, not just the config flag (D10). |

## 4. Decisions

### D1 — Schema v6 and the first forward migration (Writer's call)

**Options.**
- (a) Bump to v6 and raise `MIN_DB_SCHEMA_VERSION` to 6. The live v5 database is refused
  until it is migrated.
- (b) Bump to v6, keep MIN at 5, and add `blaze db migrate`. A v5 database serves exactly as
  today, with v6 features falling back to their file sources, until it is migrated.
- (c) Add the tables without a bump.

**Call: (b).** Option (a) takes the board down the moment the image auto-bump deploys
(service-platform's `bump` job rolls on every engine `main` push), so it is ruled out.
Option (c) is ruled out because it is exactly the silent schema change that the version
stamp's own comment forbids (`db-schema-version.mjs:35-41`). With (b), merging the engine
changes nothing live, and the switch happens at a moment the operator chooses (§5).

- `blaze db migrate` runs forward only. Each step is additive DDL in **one transaction**, and
  the step updates the `blaze_meta` row `schema_version` itself. Re-running it is a no-op.
- It refuses a database newer than the engine, and it refuses an `older` database below
  `MIN`.
- v6 adds the identity tables (D2), plus `sprint` and `sprint_registry` (D3).
- **A `blaze_meta` row `('authoritative', 'true')`** is written by the Phase 5 migrate.
  `blaze db init --force` already refuses on Postgres (`db-runner.mjs:74-77`), so the flag
  adds two things only:
  - `blaze db load --replace` refuses, with a message naming `pg_restore`. It would truncate
    the authoritative ticket tables.
  - The `older`-version refusal stops recommending `init --force` on an authoritative
    database, and recommends `blaze db migrate` instead (A5).
- `docs/schema-versioning.md` gains a section titled "authoritative databases migrate, derived
  ones rebuild".

### D2 — Identity: Postgres tables, not a cluster PVC (Writer's call)

**Options.**
- (a) Keep the SQLite `identity.db` and move it from the hostPath to a PVC.
- (b) Put the six identity tables in `blaze-pg`.

**Call: (b).**
- The operator's intent is that everything is in Postgres.
- The store and its DDL already support Postgres (§3).
- It joins the existing verified daily `pg_dump` (service-platform ADR-0024). Today
  `identity.db` has no backup beyond the laptop.
- It removes the last reason for a writable data mount.
- (a) would be a second stateful volume with its own backup story, kept only to preserve a
  file format.

Shape:
- **Tables.** The six tables from `identityDdl("postgres")`: `app_user`, `user_identity`,
  `membership`, `api_token`, `local_password` and `user_session`. They go in the `public`
  schema, and `blaze db migrate` creates them. They are **never** touched by
  `load --replace`'s truncation, which a test proves.
- **Load at boot.** A new `loadIdentityPg(client)` returns the same four states as
  `loadIdentity` (absent, broken, empty, healthy):
  - absent: no `app_user` table;
  - broken: the query fails;
  - empty: zero users;
  - healthy: at least one user.
  It is wired at the two places identity is loaded:
  - **At start.** `serve.mjs`'s standalone block (`serve.mjs:957-971`, the pod's actual
    entry) and `blaze board` both await it before `startServer({ root, identity })`, when the
    write mode is `db` and the stamp is at least 6.
  - **After setup.** The `loadIdentity(root)` call at `serve.mjs:558`, which adopts a just-created
    admin, goes through the same resolver. It becomes async there, inside the async request
    handler.

  Below v6, both points keep today's SQLite path.
- **User admin.** `user-admin.mjs` resolves the same way. In db mode it never writes
  `.gitignore` or `.blaze/`, which fixes BLZ-701's EACCES.
- **Copy.** `blaze db migrate --identity-from <identity.db>` copies all six tables
  verbatim, including token hashes, password hashes and live sessions, so no token needs
  re-issuing. It runs in the migrate transaction, and the transaction aborts on any mismatch
  in the verify. The verify compares every row of every table under a canonical form (column
  set, timestamps normalised to UTC milliseconds), not just counts (A1). The 8 smoke users
  are copied too. BLZ-702 removes them afterwards, so the copy's verify stays exact.
  **Writer's call.**
- **Setup token.** It stays a file under the data root, which becomes an `emptyDir` (D4). It
  is reachable only on a board with no users, which this board will never be again.

### D3 — Sprints: a Postgres table (Writer's call on shape)

BLZ-254 §5.7 deferred sprints to Phase 5. Sprints are data (the `sprints.mjs` header,
ADR-0004), so they go in Postgres.

- **Tables.**
  - `sprint (id text PK, name text NOT NULL, start_date date, end_date date, ord integer
    NOT NULL, extra_json text NOT NULL DEFAULT '{}')`.
  - `sprint_registry (id integer PK CHECK (id = 1), active text, registry_version integer,
    extra_json text NOT NULL DEFAULT '{}')`.

  The two `extra_json` columns keep BLZ-369's rule, *preserve what this engine does not
  understand*, at both the registry and the sprint level.
- **No FK from `ticket.sprint_id`.** **Writer's call:** a migrate step must not fail on
  orphan data. The engine already validates `--sprint` against the registry. The snapshot
  has 80 tickets across S1–S5, and every id is registered.
- **Reads.** In db mode at v6 or later, `loadSprints` is fed by a prefetched registry. The
  entry point (each request in `reading(…)`, and each CLI command) awaits the registry and
  passes it down, so the sync API and its ~10 callers are unchanged. fs mode reads
  `sprints.json` as today.
- **Writes.** `sprint-runner` writes through the db port in db mode.
- **Copy.** `blaze db migrate --sprints-from <sprints.json>` imports `v4-spine/sprints.json`
  (5 sprints, `active: S2`) and verifies it by comparing each object round-tripped through
  `loadSprints`.

### D4 — Board config and `project.json`: the chart is the single source (Operator decision (2026-10-22), OD1)

**Options for `project.json`.**
- (a) Populate the existing `blaze_config.project` tables from `project.json`, read them by
  prefetch in db mode, and add a `blaze project` admin verb for edits.
- (b) Move the 11 `project.json` files into the chart, beside `blaze.config.json`, and
  ConfigMap-mount them at `/data/projects/<KEY>/project.json`. `loadProject` is unchanged.

**Call: (b), and the same for `blaze.config.json` (INF-932).**
- Both files are **configuration**: types, workflows, taxonomy and loops. They change rarely,
  and a change to them should be reviewed, versioned and revertible.
- A GitOps PR gives all of that for free. A Postgres row gives none of it unless an audit
  trail is built.
- (b) needs no engine change.
- (a) builds a reader, a loader and an editor for data that changes a few times a year.

The operator confirmed this split on 2026-10-22: *data* in Postgres, *config* in the
platform repo.

- **INF-932 delivers "config once".** The chart's values hold `blaze.config.json` and the 11
  project files. The service-platform test fixture derives from the values instead of
  re-pinning a hand copy.
- **Seeding the values.** They are seeded from `v4-spine` after a three-way diff:
  - the ConfigMap;
  - `v4-spine`;
  - the main checkout's `BLZ-143` HEAD plus its dirty line.

  Every difference is resolved in the PR description, and `v4-spine` wins unless the
  ConfigMap is newer.
- **`codeRepos` are dropped from the chart's project files.** Their only consumer is
  reconcile, which is dropped (D6). F1 also removes the `loops.reconcile` block from the
  chart's `blaze.config.json`.
- **The data root.** `/data` becomes an `emptyDir`. Config files are mounted read-only
  (INF-933). Import receipts and maps are written to the emptyDir, and their loss on restart
  is accepted. Like the groomer, `import` is an admin verb. Its durable record is
  `ticket_event`.

### D5 — The guard against fs writes (Writer's call)

Two layers. Each one covers a case the other can't.

| Layer | Mechanism | Covers | Doesn't cover |
|---|---|---|---|
| **G-engine** (product) | A board whose config says `database.driver: "postgres"` while `BLAZE_WRITE_PORT` is **unset** (the implicit fs default) and remote mode is off **refuses every mutating verb**. It is checked in `cli.mjs`'s dispatch gate, beside `BLAZE_READONLY`. It is checked again in `resolvePorts` for direct runners and `serve.mjs`, and in `sprint-runner` and `user-admin`, which write files directly. `blaze db *` is exempt, because it is the migration path. An **explicit** `BLAZE_WRITE_PORT=fs` is allowed as a deliberate migration-window statement. `dual` is allowed. | Any engine ≥ the release carrying it, on any board, including a future board migrated the way blaze-pm was | blaze-pm's pinned `v0.8.0`, and any older engine |
| **G-data** (archive) | blaze-pm's final commit (D9) deletes `projects/`. It also sets `blaze.config.json` to `database.driver: "postgres"` (so G-engine trips too) and replaces the README with a tombstone. Then every local checkout and worktree is removed, and the GitHub repo is archived. | Every engine version: an old engine's `blaze new` stops at "unknown project — no such directory", and `move`/`edit` find no ticket | Nothing known. The operator confirmed that the second machine has no blaze-pm clone (OD4). |

- **Why not a marker file alone?** Every engine already released ignores it. That includes
  blaze-pm's own v0.8.0, which is the engine an agent in that directory actually runs.
- **Why not config alone?** For the same reason. The config key only matters to an engine
  that knows to look.
- **Why refuse rather than warn?** A warning is what agents scroll past, and warning is the
  failure mode A2 names.

**Interim (ships first).** A claude-config PreToolUse hook denies any `blaze` write verb
whose cwd is under a blaze-pm checkout or worktree when `BLAZE_REMOTE_URL` is unset. It
closes today's split-brain window for agents, who are the ones writing, until G-data lands.
It is removed in the same PR that archives the repo. **Writer's call.** A hook is the one
guard that works against the v0.8.0 pin without touching blaze-pm.

### D6 — Reconcile is dropped; moves are explicit (Operator decision (2026-10-22), OD2)

The options were:
- (a) an in-cluster CronJob;
- (b) remote reconcile from the operator's machine;
- (c) drop it.

**The operator chose (c).** On the live board, status moves only by an explicit
`blaze-live move` (D7): to `in-progress` when work starts, `in-review` when the PR opens,
and `done` after `blaze-live log`, when it merges. `blaze-live resolve` covers non-Done
outcomes. `ship-ticket` already works this way.

- **`branch` and `pr`.** They are not editable fields (`fields.mjs:22-25`), and **they stay
  that way. Writer's call.** Their only writer was reconcile. The join between a ticket and
  its code is the `KEY-n` in the branch name, commit subject and PR title, which the process
  bar already requires. Adding two editable fields so agents can hand-copy what that
  convention already records would be new surface with no reader.
- **What is retired on the live board.**
  - The chart's `loops.reconcile` block (F1).
  - On any **db** board, `blaze reconcile` and `GET /api/reconcile-preview` refuse with
    "this board moves tickets explicitly". The preview's panel is hidden. Remote mode
    already refuses `reconcile`.
  - Skill and agent wording, and the CLAUDE.md row (§6).
- **The engine's `scripts/reconcile.mjs` is kept for fs boards. Writer's call.**
  - fs mode is a supported single-machine product mode (BLZ-254 D1), and reconcile is its
    delivery-truth mechanism. It is documented in the engine's `AGENTS.md` and covered by
    ADR-0010's safety rails.
  - Deleting it means removing 2,702 lines, `reconcile-apply-report.mjs`,
    `views/reconcile-summary.mjs`, the preview route and the supervisor loop. That is a
    product decision about fs boards, not part of retiring blaze-pm.
  - The db-board refusal gives the live board the behaviour the operator asked for at about
    90 minutes, against a deletion with a public-package blast radius.
  - If fs-board reconcile should also go, that is a separate engine ticket. It is not filed
    here.

### D7 — The board operator and agents on the live board (Writer's call)

**Routine verbs go remote. Admin verbs go in the pod.**

| Need | How |
|---|---|
| `new`, `move`, `edit`, `resolve`, `log`, `link` | Remote mode, which exists today (BLZ-684) |
| `show`, `list` (new) | New `GET /api/ticket?id=` and `GET /api/tickets?project=&status=&type=` (scope `read`, JSON, value-shaped like `ticketValue`). New remote verbs `show` and `list` (`--json`). |
| Project and taxonomy lookup | New `GET /api/projects` (scope `read`) |
| `sprint`, `user`, `audit`, `matrices`, `db`, `import` | `pod-blaze <verb>`, that is `kubectl exec -n blaze deploy/blaze -- node scripts/cli.mjs <verb>`. The pod has the db env. It is an operator or board-operator action. `user add` prints a token, so it is **operator-only** (A3). |

**Getting a token, without it ever being visible (A3).** The engine has no
`user token issue` verb: `blaze user add` issues a user's first token and prints it once. So
each machine gets its **own `member` user**, for example `agent+<host>@…`. That costs no
engine work, and revoking one machine never touches another. **Writer's call.** The operator
runs this once per machine, in their own terminal:

```
kubectl exec -n blaze deploy/blaze -- node scripts/cli.mjs user add --email <agent+host> --role member
```

The operator writes the token straight to `~/.config/blaze/token` (mode 0600). An agent never
runs this command.

- **`BLAZE_TOKEN_FILE`** (new, engine). It is read only when `BLAZE_TOKEN` is unset, so the
  token never sits in an environment that `env` or a child process can print.
- **No engine CA option.** Built-in `fetch` honours `NODE_EXTRA_CA_CERTS`. The wrapper sets
  it to `~/.config/service-platform/local-ca/ca.crt` (`scripts/local-ca.sh path`).
- **A clear TLS error.** When the cause is `SELF_SIGNED_CERT_IN_CHAIN` or
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, the remote client's failure line names
  `NODE_EXTRA_CA_CERTS`, instead of printing a bare `fetch failed`.
- **`blaze-live` wrapper** (claude-config `scripts/`). It exports `BLAZE_REMOTE_URL`,
  `BLAZE_TOKEN_FILE` and `NODE_EXTRA_CA_CERTS`, then execs the installed engine's `blaze`.
  Skills and agents call `blaze-live`, never a bare `blaze`.

**Skill and agent changes.**
- **One global skill, `blaze-live-board`.** It folds together blaze-pm's
  `.claude/skills/blaze`, its `.claude/commands/blaze-*`, and the durable conventions from
  `AGENTS.md` and `docs/engineering/metadata-governance.md`. It has no `scope:`, because the
  board is reachable from any repo. The engine's own `.claude/skills/blaze` stays as it is,
  for engine development.
- **`blaze-board-operator` is rewritten around `blaze-live`.** It drops the blaze-pm paths,
  `metadata_audit.py` (already deleted, per BLZ-254 §3), the never-push-main rule and the
  pathspec rule. It also drops its "reconcile and groom passes" duty (D6). Its hygiene gate
  becomes `pod-blaze audit`.

### D8 — Docs disposition (Writer's call, row by row)

The rule: **durable and public-safe** goes to the engine (hjr15/blaze is public, and its
hygiene CI runs `scan_public_leakage`). **Durable and owned by another product** goes to that
product's repo. **Operator-private** goes to docs-central. Everything else stays in the
archive, where it remains readable.

| blaze-pm path | Files | Fate | Destination / note |
|---|---|---|---|
| `docs/decisions/` ADR-0001…0017 | 17 | **Archive** | Already mirrored as BLZ-202…218 (§3). The board operator marks the ADRs that Phase 5 supersedes as superseded on the board: BLZ-206 (ADR-0005, batch commit) and BLZ-210 (ADR-0009, plain-file ledger). |
| `docs/matrices/` | 22 | **Archive; regenerate on demand** | The board serves `GET /api/matrix`. `blaze matrices --out` in the pod is the on-demand export. No committed copy remains, so there is nothing for `--check` to drift against. |
| `docs/plans`, `archive`, `briefs`, `audits`, `status` | 55 + 23 + 40 + 72 + 7 | **Archive** | — |
| `docs/specs/2026-07-20-oma-engine-v1-design.md` | 1 | **Move** | `obs-maturity-audit/docs/design/`. This follows the precedent of BLZ-245, which moved KPA's spec. |
| `docs/specs/2026-07-20-adr-draft-audit-engine-core.md` | 1 | **Archive** | It was superseded by `audit-engine-core/docs/decisions/0001-audit-engine-core.md`. |
| `docs/specs/2026-07-21-sta-engine-sketch.md` | 1 | **Archive** | STA has no code repo. |
| `docs/diagrams/oma-engine-v1-architecture.md` | 1 | **Move** | `obs-maturity-audit/docs/diagrams/` |
| `docs/diagrams/` (other 4) | 4 | **Archive** | These cover commit serialisation and the pending queue, both retired in BLZ-254. |
| `docs/engineering/metadata-governance.md` | 1 | **Fold** | Into the `blaze-live-board` skill (D7) |
| `docs/engineering/blz-requirements-register.md` | 1 | **Archive** | The board's requirement tickets are the register. |
| `docs/programme`, `reconciliation`, `migrations`, `grooming` | 4 | **Archive** | BLZ-689 cites `grooming/2026-10-13-blz-689-terminal-parents.md`. The archived URL stays valid. |
| `docs/operations/board-publishing-and-flush.md` | 1 | **Archive** | The flush is retired (C2). |
| `docs/competitive/shortcomings-register.md` | 1 | **Archive** | It is not public-safe without review, and it is not needed at runtime. |
| `docs/exec-board/decisions/` | 3 | **Move** | `docs-central/docs/exec-board/decisions/`. These are operator business memos. claude-config ADR-0011 gives memos a cwd-relative home, so this is where they land from a docs-central session. The OMA `project.json` description path is updated with them. |
| `docs/legal/` | 2 | **Move** | `obs-maturity-audit/docs/legal/`. These are OMA engagement drafts. The k8s-posture-audit test (`tests/kpa/test_engagement_templates.py:51-52`) and `templates/engagement/README.md` are repointed in the same PR pair. |
| `docs/architecture.md` | 1 | **Archive** | Replaced by a new engine page, `docs/operations/live-board.md`. It covers where the board runs, the config source, remote mode and admin-in-pod. |
| `scripts/*.py` governance (5) and their tests | 10 | **Archive after the §5 step 2 verify** | Each one's replacement is verified in db mode (§8) |
| `scripts/embed_diagrams.py` | 1 | **Archive** | The engine already ships `scripts/embed_diagrams.py`. Verify that it covers blaze-pm's use. |
| `scripts/v3_*` probes, `fixtures/`, `remediate_oba_metadata.py`, `rebuild-daily-history.sh` | 7 | **Archive** | — |
| `migration/` | 2 | **Archive** | — |
| `projects/` | ~2,979 tickets + 11 `project.json` | **Delete in the final commit** (G-data) | The tickets are in Postgres and in git history. `project.json` goes to the chart (D4). |
| `sprints.json` | 1 | **Migrate, then delete** | Goes to the `sprint` tables (D3) |
| `blaze.config.json` | 1 | **Tombstone** | Becomes `database.driver: "postgres"`, plus only the keys `loadConfig` needs, so that G-engine trips. A config that fails to load is an acceptable refusal too. The README points at the chart. |
| `AGENTS.md` | 1 | **Fold, then tombstone** | The conventions go to `blaze-live-board`. The grooming rules stay in the archive, because the groomer is disabled (non-goal). |
| `README.md` | 1 | **Tombstone** | "Archived 2026-10-xx. The board is `blaze.howman.link`. Data: CNPG `blaze-pg`. Config: service-platform `deploy/apps/blaze`." |
| `.github/workflows/board-integrity.yml` | 1 | **Delete** | Replaced by the `blaze-audit` CronJob (§8). Duplicate ids can no longer exist, because `ticket.id` is the primary key. |
| `.githooks/`, `package.json`, `.claude/commands/blaze-*`, `.claude/skills/*` | — | **Delete in the final commit** | The skills and commands are folded into claude-config first (D7). `monorepo-build-workspace-deps-first` already exists in claude-config. |
| `.blaze/` (gitignored, not in the bundle) | — | **Discard after it is drained** | See D9. |

### D9 — Archive mechanics (Writer's call; second-machine scope per OD4)

1. **Preserve everything.** On every checkout and worktree with local state, commit the dirty
   tree to a branch named `final-wip/<branch>`, using explicit pathspecs. That includes the
   main checkout (`BLZ-143`, which has 3 dirty paths and an untracked `.worktrees/`), and
   `.worktrees/applied`, `split`, `oba-followup`, `sw-ui-refresh`, `board-main`,
   `v3-phase0`, `v4-spine` and `Code/.worktrees/blaze-pm-taxcode`. Detached HEADs get a
   branch.
2. **Bundle.** Run `git bundle create ~/cluster-data/archive/blaze-pm-final-<date>.bundle
   --all`, then `git bundle verify`. Clone it into a scratch directory and check that
   `git log --all | wc -l` matches the source. ~/cluster-data is already the home of the
   pg backups.
3. **Final commit** on `BLZ-305-v4-spine`: the tombstones and deletions in D8. Then push
   every branch from step 1, with no force. On GitHub, set the default branch to
   `BLZ-305-v4-spine` and **archive** hjr15/blaze-pm. The repo stays private and read-only.
   **The operator does the push.** Agents never push blaze-pm, and this rule outlives the
   repo.
4. **`.blaze/` disposition.**
   - `pending/` must be empty. It was 0 entries on 2026-10-22.
   - Copy `pending-drained-*` into the archive directory.
   - Keep `identity.db` beside the bundle, mode 0600, for **14 days**, which matches the
     pg_dump retention. Then delete it.
   - `admin-api-token.txt`: the operator either moves it into Vaultwarden or revokes the
     token it names. An agent never opens it.
   - Delete `index.json` and `transitions.json`.
5. **Remove the checkouts.** Run `git worktree remove` on each worktree, then remove the main
   checkout, `blaze-pm-worktrees/`, `Code/.worktrees/blaze-pm-taxcode` and the stray
   `Code/blaze-pm-queue-snapshot-20260831-190249`. The second machine has no blaze-pm clone
   (OD4), so there is nothing to remove there.

### D10 — The Live view is let go (Operator decision (2026-10-22), OD3)

The Live view was fed by claude-config's `blaze-activity.sh` PostToolUse hook, which appends
to `<dataRoot>/.blaze/activity.jsonl` on the *local* machine. Once there is no local data
root, nothing feeds the pod. Its config already says `views.live: false`, but
`GET /api/live` is still served, because only `/view/<name>` honours the flag.

- **Engine (E2).** `GET /api/live` answers 404 when `views.live` is false, like
  `/view/live`. The engine's `AGENTS.md` "Live activity feed" section gains a note that the
  feed is local-file-only, so a remote or db-hosted board has no Live view.
- **The view and feed reader stay in the engine for local boards. Writer's call.** That is
  the same reasoning as reconcile in D6: it is a product feature of single-machine boards,
  and deleting it is a separate decision.
- **claude-config (G).** Delete `hooks/blaze-activity.sh` and its registration in
  `global/settings.json` (the PostToolUse entry at line 114). The skill or agent text that
  mentions the Live view is updated.
- **Data.** The feed was gitignored and truncatable by design. Any `activity.jsonl` left on
  the operator's machine is deleted with the blaze-pm checkouts (D9 step 5), and is not
  archived.

## 5. Migration and cutover sequence

Rehearse steps 3–6 first on CNPG database `blaze_rehearsal`, loaded from `v4-spine` with
`blaze db load` and migrated with a *copy* of `identity.db`.

| Step | Action | Gate | Rollback |
|---|---|---|---|
| 0 | The interim hook is live (claude-config, D5). Engine PR E1 is merged and deployed. Its image serves the v5 database exactly as before. | CI green. The live board is unchanged (sprints still empty, sign-in works). | Revert E1. The auto-bump redeploys the old engine. |
| 1 | Config three-way diff (D4). The chart PR F1 is merged. It puts the config in the chart once, puts `project.json` in the chart without `codeRepos`, drops `loops.reconcile`, and still has the hostPaths. | The board renders the same. `pod-blaze audit` shows no new `config-project-drift`. | `git revert` F1. ArgoCD resyncs. |
| 2 | Verify the governance replacements in db mode (§8 table) against `blaze_rehearsal`. | Each row matches. | — (read-only) |
| 3 | **Freeze** (operator go-ahead). No sessions write, and no token is issued. Take a manual `pg_dump` and verify it with `pg_restore --list`. | The dump is verified. | — |
| 4 | Copy `v4-spine/sprints.json` into the pod with `kubectl cp`. Then run `pod-blaze db migrate --identity-from /data/.blaze/identity.db --sprints-from /tmp/sprints.json`. That is v5→v6, the `authoritative` row, the identity copy and the sprint import, all in **one transaction** with a row-level verify. | It exits 0, `SELECT value FROM blaze_meta WHERE key='schema_version'` returns `6`, and the printed per-table counts equal the SQLite counts. | Before commit, the transaction aborts on its own. After commit, `UPDATE blaze_meta SET value='5' WHERE key='schema_version'`: the engine falls back to the file sources, which are untouched. Sessions and tokens created after step 4 are lost, which is accepted. Rolling back to an image older than E1 also needs the stamp reverted first, because that engine refuses v6 as `newer`. |
| 5 | `kubectl rollout restart deploy/blaze`. Identity is loaded at boot (D2). | An existing token works. An existing browser session survives. The gantt shows S1–S5. `blaze new --sprint S5` is accepted. `/api/new` from both machines works. | As for step 4 |
| 6 | Unfreeze. Watch for one day: the nightly `blaze-pg-backup` must contain `app_user` and `sprint` (`pg_restore --list`). The backup directory must be mode 0700, because it now holds credential hashes. | The backup is verified, and so is the directory mode. | As for step 4, until step 7 |
| 7 | Service-platform PR F2 is merged. It removes the three hostPaths, `GIT_*` env and `safe.directory`, and makes `/data` an `emptyDir` with read-only config (INF-933). It adds the `blaze-audit` CronJob and drops `BLAZE_PM_DIR` volumes from `k8s-up.sh` and the docs. It removes the dormant basic-auth (BLZ-697). | The pod has no hostPath (`kubectl get pod -o yaml`), and the step-5 smokes pass again. | `git revert` F2. The hostPaths come back, and the files are still there until step 9. |
| 8 | Engine E2 is merged, if it isn't already (remote reads, token file, TLS hint). Then claude-config G (skill, wrapper, agents). Then the repo-move PRs (§7). | `rg -l blaze-pm` across claude-config, docs-central, k8s-posture-audit and service-platform finds only history, archive or changelog text. A fresh session creates and shows a ticket through `blaze-live`. | Revert each PR on its own. None of them touch data. |
| 9 | Archive (D9 steps 1–5). The interim hook is removed. | The bundle is verified, the GitHub repo shows *Archived*, and no checkout remains on this machine. The second machine has none (OD4). | Un-archive on GitHub (it is reversible). The bundle restores everything. |
| 10 | Day 14: delete the retained `identity.db` copy (D9 step 4). BLZ-702 removes the smoke users. | — | — |

After step 7, the engine's file fallback for identity and sprints is unreachable on the
live board. It stays in the engine as fs mode's own behaviour (non-goal: fs unchanged).

## 6. External consumers and how each is repointed

| Consumer | Today | After |
|---|---|---|
| claude-config `agents/blaze-board-operator.md` | blaze-pm paths, `metadata_audit.py`, never-push-main | Rewritten around `blaze-live`, with admin in the pod (D7) |
| claude-config `agents/backlog-audit-against-master.md` | Walks `blaze-pm/projects/` | `blaze-live list --project K --json`, then the same classification |
| claude-config `agents/program-project-manager.md`, `blaze-data-model-architect.md` | blaze-pm mentions | Point at the live board, and at `blaze-live-board` |
| claude-config skills: `ship-ticket`, `feature-pr-bundling`, `jira-status-walk-to-done`, `mid-work-jira-ticket-spawn`, `pmo-team`, `ops-team`, `solve`, `promote-then-retire-spec`, `public-upstream-repo-forbids-coauthor-trailer`, `cross-repo-tool-migration-scan-audit-parallel-sweep`, `monorepo-build-workspace-deps-first`, `bash-date-u-naive-timestamp-dst-bug` | blaze-pm paths, commands, the "inside a blaze-pm session" wording, and "reconcile moves it" | `blaze-live …`. Wording: "the live board". Every "reconcile will move it" becomes an explicit `blaze-live move` step (D6). |
| claude-config `hooks/blaze-activity.sh` and its `global/settings.json:114` registration | Feeds the Live view | Deleted (D10) |
| claude-config `hooks/check-unpushed.sh` | `EXCLUDED_REPOS=("blaze-pm")` | The exclusion and its comment are removed |
| claude-config `scripts/blaze-bundle-push.sh` and its test | Obsolete | Deleted |
| claude-config `scripts/scan_public_leakage.py` | Reads project keys from `blaze-pm/projects/` | Reads a checked-in `scripts/project_keys.txt`, regenerated with `blaze-live list --projects`. `FALLBACK_PROJECT_KEYS` stays. **Writer's call:** the script runs in public-repo CI with no board access. |
| claude-config `global/settings.json:9` | Allows `git push origin main` on blaze-pm | Rule deleted |
| claude-config `scripts/install.sh:513` | Comment about blaze-pm slash skills | Comment updated |
| claude-config `global/CLAUDE.md:40` | "create the ticket in `blaze-pm`"; "`blaze reconcile` moves status from branch + PR" | **Proposed wording, for the operator to apply:** "`blaze-live-board` skill — create the ticket on the live board (`blaze-live new`, **parent + estimate at create**); branch `KEY-n-slug`; every commit `KEY-n: description`; PR title `KEY-n: description`; **move status explicitly** with `blaze-live move` (`in-progress` at start, `in-review` at PR open, `done` at merge); `blaze-live log` time before a terminal move; **`blaze-live resolve` for non-Done outcomes**" |
| docs-central `scripts/gen_launchpad.py` | Reads `blaze-pm/.blaze/index.json` | `blaze-live list --json`. If the board is unreachable, the section prints "board unreachable", not zero tallies. `INPUT_REPOS` drops blaze-pm. |
| k8s-posture-audit test and template | `blaze-pm/docs/legal/…` | `obs-maturity-audit/docs/legal/…` |
| k8s-posture-audit `docs/` and `CLAUDE.md` | Cite blaze-pm ADR-0017 and `docs/specs` | Cite BLZ-218, and the archived URL for historical paths |
| service-platform `scripts/k8s-up.sh` | `BLAZE_PM_DIR` and 3 `--volume` | Removed. The k3d volumes go at the next cluster create, and nothing mounts them before then. |
| service-platform chart `data.*HostPath`, `GIT_*`, `safe.directory` | Present | Removed (F2) |
| service-platform `docs/services/blaze.md`, runbook, ADR refs | Laptop working copy | Live-board model. ADR-0017 (flush) is already superseded. A new ADR records "board data in Postgres, config in the chart". |
| service-platform basic-auth (BLZ-697) | Dormant | Removed in F2 |
| Agents' remote access | Not available | `blaze-live` and the operator-issued token file (D7) |

## 7. PR plan (feature-pr-bundling)

One feature, split at repo and rollback boundaries, as BLZ-254 was:

| PR | Repo | Contents | Order / why separate |
|---|---|---|---|
| G0 | claude-config | Interim blaze-pm write hook (D5) | **First.** It closes today's window. |
| E1 — db completeness | blaze | Schema v6 and `db migrate`, the authoritative refusals, identity in pg, sprints in pg, G-engine guard, schema-versioning docs and ADR | Must deploy before the cutover. It is inert on v5. |
| E2 — remote agent surface | blaze | `GET /api/ticket(s)` and `/api/projects`, remote `show` and `list`, `BLAZE_TOKEN_FILE`, the TLS hint, the db-board reconcile refusal (D6), the `/api/live` gate (D10), and `docs/operations/live-board.md` | It touches auth scopes, so it is reviewed on its own. It can run in parallel with E1. |
| F1 | service-platform | Config once: `blaze.config.json` and 11 `project.json` in values, with the fixture derived (INF-932). `codeRepos` and `loops.reconcile` dropped. | Before the cutover. It is a pure config move. |
| — | cluster (operator) | §5 steps 3–6 | Runbook-timed |
| F2 | service-platform | Drop the hostPaths and git env, emptyDir `/data`, read-only mounts (INF-933), `blaze-audit` CronJob, `k8s-up.sh`, docs and ADR, basic-auth removal (BLZ-697) | After step 6 |
| G | claude-config | `blaze-live` wrapper, `blaze-live-board` skill, agents, skills, hooks, scripts and settings (§6), and removal of `blaze-activity.sh` (D10) | After E2 deploys |
| H1 | obs-maturity-audit | `docs/legal/`, OMA spec and diagram moved in | Paired with H2 |
| H2 | k8s-posture-audit | Path repoint for the test, template and docs | Merges after H1 |
| H3 | docs-central | `gen_launchpad.py` and the exec-board memos | After G |
| — | blaze-pm (operator push) | Final commit, push and archive (D9) | **Last** |

## 8. Governance replacements, verified in db mode before the archive

This answers BLZ-254's AC "re-homed before archive". Each row is checked by running the
Python script against the `v4-spine` tree and the blaze command against `blaze_rehearsal`,
which is loaded from the same tree (generator-oracle).

| Script | Replacement | Pass condition |
|---|---|---|
| `duplicate_id_check.py` | `ticket` PK, plus `blaze audit --kind duplicate-status` | Both report 0 |
| `terminal_parent_scan.py` | `blaze audit --kind terminal-parent-open-child` (soft, BLZ-689) | Same set of (parent, child) pairs |
| `empty_body_scan.py` | `blaze audit --kind empty-body` | Same id set |
| `config_drift_check.py` | `blaze audit --kind config-project-drift` | Same findings |
| `build_matrices.py` | `blaze matrices --out <dir>` | Zero `diff -r` against the script's 22 files |
| `embed_diagrams.py` | Engine `scripts/embed_diagrams.py` | Same output on `docs/diagrams/` |

**`blaze-audit` CronJob** (F2) replaces `board-integrity.yml`. It runs daily as
`blaze audit --json --fail-on <the hard kinds>` and fails into the existing
`CronJobLastRunFailed` and `CronJobStale` alerts, which is the `blaze-pg-backup` pattern.
**Writer's call.** Postgres is cluster-internal, so a GitHub-hosted job cannot reach it. A
CronJob also needs no runner. The command asserts that it observed a non-empty ticket set,
so an empty read can't pass as clean.

## 9. Testing

TDD throughout. Postgres paths run against `tests/helpers/pg-scratch.mjs`.

- **Migrate.**
  - A v5 fixture database migrates to v6 in one transaction, and a second run is a no-op.
  - An injected failure mid-step leaves v5 intact.
  - `load --replace` refuses on a database with the `authoritative` `blaze_meta` row. The
    existing Postgres refusal of `init --force` stays covered.
  - The `older` message recommends `db migrate`, not `init --force`, on an authoritative
    database.
  - `load --replace` leaves the identity and sprint tables untouched.
  - A v5 database still serves on the new engine with the file fallbacks.
- **Identity copy.**
  - A fixture `identity.db` covers every table, a revoked token, an expired session and a
    password user. It copies with zero row diffs.
  - An injected one-byte hash change makes the verify abort the transaction
    (`prove-test-discriminates`).
  - After the copy, the pre-existing bearer token authenticates and the pre-existing session
    cookie resolves.
  - The four `loadIdentityPg` states each have a test, and broken ≠ absent.
  - Two concurrent setup completions against the yielding pg store create exactly one admin.
    This makes `serve.mjs`'s `setupInFlight` guard proven, not hypothetical.
- **Sprints.** A registry with unknown keys at both levels round-trips byte-equal through
  `loadSprints`. The gantt renders the sprints in db mode. `--sprint` validates against the
  table.
- **G-engine.**
  - Each mutating verb on a `driver: postgres` board refuses when `BLAZE_WRITE_PORT` is unset.
  - Each one is allowed with an explicit `fs`, with `dual`, with `db`, and in remote mode.
  - `blaze db *` is exempt.
  - The serve API path refuses too.
  - A test injects a regression (the guard removed) and the suite goes red.
- **G-data.** In a scratch copy, the v0.8.0 engine against the tombstoned tree fails
  `blaze new` and `blaze move`.
- **Remote reads.**
  - Scopes: `viewer` can read; no token gets a 401.
  - `show` and `list` round-trip end to end on an ephemeral port.
  - `BLAZE_TOKEN_FILE` is honoured, and it never appears in an error.
  - A TLS-failure stub produces the `NODE_EXTRA_CA_CERTS` hint.
- **Identity wiring.** The standalone `serve.mjs` entry and the post-setup adoption
  (`serve.mjs:558`) both read pg at v6. A test fails if either path still opens SQLite.
- **Reconcile refusal.** On a db board, `blaze reconcile` and `GET /api/reconcile-preview`
  refuse. fs-board reconcile fixtures stay green, unchanged.
- **Live gate.** `GET /api/live` gives 404 when `views.live` is false and 200 when it is true.
- **service-platform.**
  - Chart tests assert no hostPath, read-only config mounts, the CronJob present, and
    basic-auth absent.
  - The fixture derives from values (INF-932).
  - `test_k8s_up_mounts.py` asserts that no `BLAZE_PM_DIR` remains.
- **Cutover gates.** These are the §5 step gates, rehearsed in full first.

## 10. Tickets to file

**Parent feature** (type `feature`, project BLZ): *"Retire blaze-pm — the live board's data
lives only in Postgres"*, estimate 3,585 minutes.

- Parent: **BLZ-2**, "Blaze always tells the truth about where work stands". Links:
  `Relates BLZ-254`, `Relates BLZ-195`.
- **Writer's call.** BLZ-254's parent, BLZ-195, is a *requirement* about preserving ticket
  content in a migration. Phase 5's purpose is that the board cannot silently diverge, and
  that is BLZ-2's statement.
- BLZ-241, a feature with the same flavour, already sits directly under BLZ-2. It is the
  precedent.
- The parent is verified only against the 2026-10-21 snapshot. Confirm it at create.

Children (type `task`, estimates in minutes):

| # | Title | PR | Est. |
|---|---|---|---|
| 1 | Interim hook: refuse `blaze` writes from a blaze-pm checkout without remote mode | G0 | 60 |
| 2 | Schema v6, forward-only `blaze db migrate`, and the authoritative-database refusals | E1 | 300 |
| 3 | Identity in Postgres: `loadIdentityPg` before bind, user-admin over pg, verified copy from `identity.db` (absorbs BLZ-701) | E1 | 420 |
| 4 | Sprints in Postgres: tables, entry-point prefetch for `loadSprints`, db-port sprint writes, verified import | E1 | 300 |
| 5 | Refuse fs writes on a board whose config names the postgres driver (G-engine) | E1 | 120 |
| 6 | Remote reads: `GET /api/ticket(s)` and `/api/projects`, remote `show` and `list` | E2 | 300 |
| 7 | Remote ergonomics: `BLAZE_TOKEN_FILE`, a TLS-failure hint, and the `docs/operations/live-board.md` page | E2 | 90 |
| 8 | ADR: board data lives in Postgres, board config in the platform chart, plus addenda to ADR-0006 and schema-versioning | E1 | 90 |
| 9 | Chart: `blaze.config.json` and 11 `project.json` once, in values, without `codeRepos` or `loops.reconcile` (absorbs INF-932) | F1 | 180 |
| 10 | Chart: drop the blaze-pm hostPaths and git env, emptyDir `/data`, read-only config (absorbs INF-933), `k8s-up.sh`, docs, basic-auth removal (with BLZ-697) | F2 | 180 |
| 11 | `blaze-audit` CronJob replacing blaze-pm's `board-integrity.yml` | F2 | 120 |
| 12 | Verify the six governance replacements in db mode against `blaze_rehearsal` (§8) | — | 90 |
| 13 | Rehearse, then run the identity and sprint cutover (§5 steps 3–6) | cluster | 240 |
| 14 | `blaze-live` wrapper, `blaze-live-board` skill (folds blaze-pm's skill, commands and `AGENTS.md` conventions) | G | 240 |
| 15 | Repoint claude-config agents, skills, hooks, scripts and settings off blaze-pm (§6) | G | 300 |
| 16 | Move legal, the OMA spec and the diagram to obs-maturity-audit, and repoint k8s-posture-audit | H1+H2 | 120 |
| 17 | docs-central: launchpad from `blaze-live list`, exec-board memos moved in | H3 | 90 |
| 18 | Archive blaze-pm: preserve branches, bundle, tombstone commit, GitHub archive, remove local checkouts, `.blaze/` disposition | blaze-pm | 120 |
| 19 | Board ops: mark the superseded blaze-pm ADR tickets (BLZ-206, BLZ-210), and check BLZ-202…218 against D8 | board | 60 |
| 20 | Refuse `blaze reconcile` and `/api/reconcile-preview` on a db board; docs note moves are explicit (D6) | E2 | 90 |
| 21 | Gate `GET /api/live` on `views.live`; document the Live feed as local-only (D10) | E2 | 45 |
| 22 | Remove the `blaze-activity.sh` hook and its settings registration (D10) | G | 30 |
| | **Total** | | **3,585** |

**Filed 2026-10-22 on the live board:** parent **BLZ-703** (under BLZ-2; Relates BLZ-254, BLZ-195); children #1–#22 are **BLZ-704 … BLZ-725** in table order.

BLZ-702 (smoke users) and BLZ-697 (basic-auth) stay under BLZ-254, where they were filed.
Child 10 carries BLZ-697's change, and BLZ-702 runs at §5 step 10. BLZ-689 and BLZ-696 are
not part of Phase 5.

## 11. Out of scope

- Re-enabling the groomer, and so the fate of `AGENTS.md`'s grooming rules beyond the
  archive.
- Remote `sprint`, `user`, `import`, `db`, `audit` and `matrices`.
- Populating `blaze_config.project` (D4 option a).
- Reconcile in any form on the live board (OD2). Deleting the engine's fs-board reconcile
  would be a separate engine decision (D6).
- Deleting the engine's Live view for local boards (D10).
- Raising `MIN_DB_SCHEMA_VERSION` to 6. That comes in a later release, once no v5 database is
  in service.
- Any change to fs or dual behaviour beyond G-engine.

## 12. Self-review (2026-10-22)

The checks run against this document, and what they changed:

1. **The auto-bump against the schema bump.** The first draft had MIN=6, which takes the
   board down the moment E1 merges. Changed to D1(b).
2. **Identity is loaded once at boot.** The first draft had the switch happening "on the
   next request". It actually needs a restart, which is now §5 step 5. The gap between
   migrate and restart loses only sessions created in it, which is accepted.
3. **The BLZ-254 cutover pattern against G-engine.** That cutover ran with
   `driver: postgres` and `BLAZE_WRITE_PORT` unset, which G-engine would have refused. Hence
   the "explicit `fs` is allowed" clause and the `blaze db *` exemption.
4. **G-engine against the v0.8.0 pin.** G-engine alone would not have protected blaze-pm.
   Hence G-data and the interim hook.
5. **Rollback past step 7.** F2's revert restores the hostPaths. That works only while the
   files exist, which is why the archive (step 9) comes after F2 has soaked.
6. **Does anything still read `projects/<KEY>/` directories in db mode?** `loadProject`
   checks that the directory exists (`config.mjs:519`). D4's ConfigMap mounts recreate
   `/data/projects/<KEY>/project.json`, so the check holds.
7. **Backups now hold credentials.** The nightly `pg_dump` will contain password and token
   hashes. §5 step 6 (child 13) now gates on `~/cluster-data/blaze-pg-backups` being mode 0700.
8. **Builder check (2026-10-22).** Corrected four claims against the code:
   - the stamp is `blaze_meta(key, value)`, not a `meta` table;
   - `init --force` is already refused on Postgres;
   - the image has no `blaze` bin, hence `pod-blaze`;
   - the pod enters through `serve.mjs`'s standalone block, and identity is also re-loaded
     at `serve.mjs:558`.
9. **Operator answers.** After OD2, nothing reads `codeRepos` on the live board, so F1 drops
   them. After OD3, `/api/live` needed a real gate, because the config flag alone left the
   route served.
10. **Contradiction check.** §2's non-goal "fs unchanged" against D3 and D2: the file sources
   remain for fs mode and for a v5 database, so there is no contradiction. §7 E1 against
   child 8: the ADR ships in E1, so the docs land in the same effort.
