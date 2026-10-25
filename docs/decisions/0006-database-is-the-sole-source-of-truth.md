# 6. The database is the sole source of truth

Date: 2026-08-20

## Status

Proposed (BLZ-259)

Reverses this repo's published product doctrine in
[docs/guide/why-blaze.md](../guide/why-blaze.md), which listed a hosted API and a
database backend as "non-goals by design, not gaps waiting to be filled".

Supersedes, in the private data repo, `blaze-pm` ADR-0001 (*file-based,
directory-is-status*) and ADR-0013 (*reject hub-and-spoke, fix central*).
ADR-0013 did not close the question permanently — it recorded a revival path,
and this is that path being taken. It is cited here rather than pretended away.

## Context

The file-and-git store did what ADR-0001 promised: a ticket is a markdown file,
status is the directory it sits in, git is the audit trail, and the engine has
zero runtime dependencies. It shipped, it is published, and it is deployed.

It has hit a ceiling that is structural, not incidental. Multiple agent sessions
across multiple machines cannot write to one board without branch-and-worktree
ceremony, merge conflicts, a daily squash-flush CronJob acting as sole committer,
and a three-layer id allocator ([ADR-0005](0005-three-layer-id-allocator.md)) —
full-tree scan, committed claims ledger, `O_EXCL` reservations, and a
`git fetch`/`ls-tree` sweep of every remote ref — whose entire purpose is
stopping two machines minting the same id.

That allocator is a lot of machinery to approximate one `UNIQUE` constraint, and
it still does not close the hole. **Two live failures, neither hypothetical:**

| | What happened |
|---|---|
| **BLZ-122** | A ticket existed in two status directories at once. Status *is* the directory, so the ticket had two statuses. Git had nothing to conflict on — the two paths differ, so the merge was clean. |
| **BLZ-246 / BLZ-251** | Two *different* tickets held the id `BLZ-246` in two divergent trees simultaneously. ADR-0005's allocator cannot see across an unmerged branch, so it never fired. Found 2026-08-20 during the v3 Phase 0 reconcile and resolved by renumbering one to BLZ-251. |

Both are the same shape: **the filesystem cannot express an invariant that spans
two trees.** A database expresses both in one line of DDL each.

## Decision

The database is the sole source of truth for ticket data. Markdown files and git
stop being ticket storage. Dumps are the backup.

One storage adapter, two drivers — SQLite for the `npx`/laptop path, Postgres for
the cluster. Config and project data are two schemas in one Postgres database,
with config **projected** into the data schema as `resolved_*` tables so every
foreign key is intra-schema (SQLite cannot enforce a foreign key across an
`ATTACH`ed file).

### Rejected: a git markdown mirror

Keeping a mirror of the corpus in git, written on every change, was considered
and **declined**. It reintroduces the two-writers problem this decision exists to
remove, and a mirror nobody reads is a mirror nobody notices going stale. The
zero-diff exporter is built as a **throwaway migration harness only** — its job
is to prove the migration lost nothing by re-emitting the corpus and producing an
empty `git diff`, then it is deleted.

## Consequences

**What is genuinely lost, stated plainly:**

- **Zero runtime dependencies, on the Postgres path.** Node has no built-in PG
  client, so `pg` becomes an `optionalDependency` behind a dynamic `import()`.
  The `npx` + SQLite path stays genuinely install-free; the cluster path does not.
- **`git log --follow` as the audit trail.** Its replacement is `ticket_events`
  and `GET /v1/tickets/{id}/events`, with event-sourced revert standing in for
  `git revert`. These are built in Phase 1, **before** files freeze — deferred,
  they die silently and the board loses its history with nothing in its place.
- **"Delete the engine and your board is still a complete set of files."** After
  cutover that is no longer true, and the guide must stop claiming it.

**What the audit trail actually gains — honestly:**

The existing trail is not the complete record it appears to be.
`.blaze/transitions.json` covers **298 of 2,165 tickets (13.8%)** — 351
transitions over 27 days — because history is squash-merged to 158 commits. The
migration imports it **verbatim**; `git log` is never re-run and unobserved
transitions are never synthesised. So the migration replaces a mostly-empty audit
trail with a complete one going forward, and the 13.8% coverage figure is
surfaced on the metrics view rather than buried.

**What stays true:**

- `npx @hjr15/blaze serve` still works on a clean machine with no Docker, no
  Postgres and no config.
- This repo's own ADRs stay in `docs/decisions/` and stay readable without the
  board.

## Addendum (2026-10-13, BLZ-254) — concurrent writers need db mode; fs is single-machine

This ADR is still *Proposed*. BLZ-254 does not accept it whole, and it does not retire files. The
operator's decision D1 (2026-10-05, BLZ-254 spec §2) splits the product in two:

- **db mode (`BLAZE_WRITE_PORT=db`) is the multi-machine mode.** The live board runs it. Ids come
  from `project_counter`'s transactional allocate; a second machine writes over HTTP (`blaze`
  remote mode, `POST /api/*` with a bearer token). This is the only supported way for two
  writers — two sessions, two machines, an agent and a person — to share one board.
- **fs mode is a supported single-machine mode, on a git working tree.** `blaze new`'s reservation needs one (`ids.mjs`: "is not inside a git worktree — cannot reserve ticket ids safely", review M7). It keeps its allocator (`ids.mjs`,
  `claims.mjs`, ADR-0005) and nothing else of the git era: since 0.9.0 the board **never
  commits**. `blaze commit`, `blaze publish`, `commitMode`, the pending ledgers, the commit lock
  and the server's per-click commit are deleted (BLZ-254 §5.5). The person who owns an fs board
  versions its files with git themselves, when and how they choose. (The fs groomer loop and
  the one-shot `blaze migrate` still commit their own changes; they were outside §5.5's table.)

Running an fs board with more than one concurrent writer is unsupported. The failures that
motivated this ADR — a ticket in two status directories, one id minted twice in two trees — are
exactly what such a board can still produce, and nothing in the engine now tries to paper over
them with a queue or a lock.

## Addendum (2026-10-22, BLZ-711) — a deployed db board is the only writable store

The single-machine rule from the BLZ-254 addendum still holds: an fs board is a supported mode on one
machine, on a git working tree, with one writer, and nothing here changes it.

A deployed db board's data is now Postgres-only
([ADR-0039](0039-board-data-lives-in-postgres-board-config-in-the-platform-chart.md)): tickets, events,
users, tokens, sessions and sprints live in the database once `blaze db migrate` has marked it
authoritative. A checkout of a migrated board must not be written, and the engine enforces that for
engines 0.10.0 and newer: a board whose config names the postgres driver refuses an implicit file write.
