# CSV import and export — the canonical schema, the mapping layer, and the round trip

**Status:** design, for review · **Date:** 2026-09-08 · **Tickets:** BLZ-587, BLZ-588, BLZ-589
· **Decision:** [ADR-0037](../decisions/0037-an-inferred-column-mapping-is-a-proposal-a-person-accepts-never-an-import.md)

This is phase 3 of
[`../superpowers/plans/2026-08-31-blaze-app-adoption-and-import-standard.md`](../superpowers/plans/2026-08-31-blaze-app-adoption-and-import-standard.md).
Its §5 Q1 and Q2 are **answered and binding** and are not reopened here:

- **Q1 — the model layer.** Import targets the injectable write port, not `node:fs`, so it
  survives BLZ-254's cutover unchanged.
- **Q2 — canonical schema first, arbitrary CSVs adapted at import time.** CSV is the **primary**
  import medium; markdown (BLZ-588) is secondary.
- **The mapping is a proposal, never an import**, and import itself is deterministic.
- **BLZ-589 is not optional and not last.**

**On this file's location.** The repo has six subsystem design documents under
`docs/superpowers/specs/`. This one is not filed there because ADR-0028 records that
`docs/superpowers/` holds *"session kickoffs, hand-off briefs and internal work orders"* and is
deliberately unpublishable, whereas a CSV interchange schema is a contract an outside user needs
in the same way `docs/schema-versioning.md` and `docs/schema-customization.md` are.

**Every claim below about how blaze works today is cited to the file and line it was read from.**
Where something could not be verified it says so rather than asserting.

**Two kinds of path appear in this document, and they must not be confused.** A path with a line
number — `scripts/model/ticket.mjs:112-119` — is **existing code at `13f661c`**, read and cited.
A path without one under `scripts/model/csv.mjs`, `import-*.mjs`, `export-*.mjs`, the three
runners, and `tests/csv-round-trip.test.mjs` is **proposed** — it does not exist in the tree, and
§6 is its inventory. In particular, `scripts/model/import-mapping-propose.mjs` is described as
the only module that will spawn `agentCommand`; **today the tree has exactly one read of
`agentCommand`, at `scripts/loops/groomer.mjs:547`**, and the proposer is what this design adds
beside it. Every sentence about a proposed module is a specification of what it will do, not a
report of what it does.

---

## 0. The three decisions

> **1. The canonical CSV is 31 columns — the board's 28 frontmatter keys, plus `status` (which
> is a directory, not a field), plus `description` (which is the markdown body), plus a
> `schema_version` column carried on every row.**
>
> **2. The model runs in exactly one function, reachable from exactly one runner. The property
> pinned is that NO SPAWN IS PERFORMED on the import path — not that none is linked, which is
> unsatisfiable here: six modules the importer must reach import `node:child_process`, and
> `config.mjs` both defines `agentCommand` and hands it over on every `loadConfig()`.**
>
> **3. The round trip needs THREE gates, because export-to-export alone is vacuous. X and Y come
> from the same exporter, so an exporter defect cancels in the diff — 21 of the 31 columns can be
> blanked with a byte-identical diff and a passing audit. Gate 1 is `diff X Y`; gate 2 is
> `zeroDiff`'s value comparison of the source board against the imported one; gate 3 is that every
> column is non-empty in at least one row of **X**, the exported CSV.**

---

## 1. What the board's field model actually is

Read from source, not from the guide. Two of these facts contradict
`docs/guide/schema.md`, and where they do, the code is the schema.

### 1.1 The 28 frontmatter keys

`scripts/model/ticket.mjs:112-119` fixes the serialization order of 24 keys:

```
id, title, type, project, priority, resolution, parent, assignee, labels, components,
estimate, sprint, not_before, deadline, start, due, worklog, links, likelihood, impact,
branch, pr, created, updated
```

`scripts/model/write-port.mjs:126-136` (`COLUMN_FIELDS`) names four more that have a real
database column and are therefore **not** part of the `extra_json` tail — `ref`, `category`,
`verification`, `derived`. `scripts/migrate/zero-diff.mjs:130-136` checks all 28 as the
migration oracle's field list, and its own comment (`:120-125`) records that BLZ-391 closed the
gap so the SQLite read seam *"now projects all 28"*.

Those four are absent from `FIELD_ORDER`, so on disk they serialize **after `updated`** —
`serializeTicket` appends any unlisted key (`scripts/model/ticket.mjs:149-152`). That is a real
on-disk ordering fact, and it is the reason the round trip in §3 is not measured on markdown
bytes.

`description` is not a frontmatter key. It is the ticket **body** — the type registry lists it
among `required` (`scripts/model/schema.mjs:15-28`) and `validateTicket` resolves it against
`ticket.body` (`scripts/model/rules.mjs:26-27`).

**`status` is not a field at all.** It is the directory the file sits in:
`ticketPath()` builds `<projectsDir>/<project>/<status>/<id>-<slug>.md`
(`scripts/model/storage.mjs:54-57`), `walkTickets` yields it first-class from the walk
(`scripts/model/index.mjs:226-256`) and `buildIndex` takes `status: t.status` from the walk
rather than from frontmatter (`scripts/model/index.mjs:412`).

### 1.2 The enums

| Enum | Values | Source |
|---|---|---|
| `priority` | `highest, high, medium, low, lowest, none, urgent` | `scripts/model/schema.mjs:12` |
| `resolution` | `done, wont-do, duplicate, cannot-reproduce` | `scripts/model/workflows.mjs:13` |
| `type` | `goal, requirement, architecture, feature, risk, story, task, bug, subtask, epic` | `scripts/model/schema.mjs:14-29` |

`priority` and `resolution` are fixed — `mergeTypes`/`mergeWorkflows` cannot reach them.
`type` and the statuses below are **resolved per board**: `TYPES` is `DEFAULT_TYPES` merged with
the ambient `schema.types` override (`scripts/model/schema.mjs:32-38`), and `WORKFLOWS` likewise
(`scripts/model/workflows.mjs:71-77`). So the importer validates against the *resolved* registry
for the target project, exactly as `applyNew` does via `loadProjectSchema`
(`scripts/new.mjs:82-84`), never against a hardcoded list.

### 1.3 The status vocabulary — 13 values across 5 workflows

From `scripts/model/workflows.mjs:15-68`:

| Workflow | Types | Statuses (order is the sequence) | Terminal |
|---|---|---|---|
| `delivery` | feature, story, task, bug, subtask, epic | `defined, in-progress, in-review, done` | `done` |
| `goal` | goal | `defined, in-progress, achieved` | `achieved` |
| `requirement` | requirement | `proposed, implemented, verified, rejected, obsolete` | `implemented, verified, rejected, obsolete` |
| `architecture` | architecture | `proposed, accepted, rejected` | `accepted, rejected` |
| `risk` | risk | `identified, mitigated, accepted, obsolete` | `mitigated, accepted, obsolete` |

Union: 13 distinct values.

> **Documentation defect, found while reading this.** `docs/guide/schema.md`'s workflow table
> gives `requirement` as `proposed → { implemented | rejected | obsolete }` and omits
> **`verified`**, which `scripts/model/workflows.mjs:44` declares and BLZ-339's comment on the
> line above says was deliberately shipped. A CSV status vocabulary derived from the guide would
> refuse a legal value. This is filed as a gap in §8, not fixed here.

### 1.4 The link vocabulary — and there are two of them

`scripts/model/links.mjs:12-14`:

```js
export const TRACE_LINK_TYPES = new Set(["Implements", "Addresses"]);
export const LINK_TYPES = new Set(["Blocks", "Relates", "Duplicate", "Cloners", ...TRACE_LINK_TYPES]);
```

Six values. This is the set `blaze link` accepts (`scripts/link.mjs:14-15`), `lintLinks` warns
against (`scripts/model/links.mjs:28`) and `blaze audit` reports `unknown-link-type` against
(`scripts/model/audit.mjs:287`).

`scripts/model/link-schema.mjs:107-147` declares a **different** six — `Implements`, `Addresses`,
`Verifies`, `Supersedes`, `Derives`, `Precedes` — the v4 typed meta-model the scheduler and the
database read (`scripts/model/schedule.mjs:33,45`, `scripts/model/import-deps.mjs:19`).
`scripts/audit-runner.mjs:268` states the split in as many words: *"`Precedes` lives in the v4
`link` table and `LINK_TYPES` (links.mjs:14) has no…"*.

**The CSV `links` column is validated against `LINK_TYPES`** — the frontmatter vocabulary — because
that is what a ticket carries and what the audit will judge after the import. Accepting
`Precedes` from a CSV would write a link every existing audit calls unknown. The divergence is
real and out of scope here; it is named in §8.

> **A stale justification not to lean on.** ADR-0022:112 says *"`Precedes` lives in the v4 `link`
> table and `createDbSchema` installs no v4 table at all."* The second half is **no longer true**:
> `scripts/model/db-schema-version.mjs:233` runs `exec.run(linkDdl(dialect), [])` inside
> `applyCreate`, so the `link_type` table is installed on every create. Nothing in this design's
> conclusions depends on it — §2.4 bounds the parity claim on `ticket_link` being **derived from
> frontmatter**, which is a live fact about the write path (`write-port.mjs:254-259`), not about
> whether a table exists — but the ADR's sentence should not be cited as though it still held.

### 1.5 What a link and a worklog entry look like on disk

Verbatim, from `blaze-pm` `projects/BLZ/done/BLZ-275-…md`:

```
worklog:
  - { date: 2026-08-20, minutes: 240, note: "Last five read consumers routed through the driver; … hjr15/blaze#63." }
links:
  - { type: Relates, target: BLZ-268 }
branch: BLZ-275-last-consumers
pr: #63 — https://github.com/hjr15/blaze/pull/63
```

**There are two on-disk spellings, and both are legal.** The inline-object form above is the one
`serializeTicket` writes (`scripts/model/ticket.mjs:144-146,158-161`). The **block-mapping** form
also occurs — verbatim from `projects/OBA/*/OBA-466-….md`:

```
links:
  - type: Relates
    target: OBA-425
  - type: Relates
    target: OBA-464
```

`parseTicket` handles both: `:85` takes the `{`-prefixed inline object, and `:88-99` takes
`- key: value` followed by further keys indented past the `-` marker. A worklog entry is
`{ date, minutes, note }`; a link is `{ type, target }`. `pr` carries a value beginning with `#`
and containing an em-dash and a URL — which is why §2.5's escaping rules are not theoretical.

This matters beyond spelling: a reader that handles only the inline form sees the block-mapping
entries as links with **no target**, which is a real corruption class (BLZ-123) and is exactly the
false positive §1.6 records having made.

### 1.6 What the live board actually contains

Measured read-only on 2026-09-08 against the `v4-spine` worktree of `blaze-pm`, **through blaze's
own `walkTickets` and `parseTicket`** — not a hand-rolled frontmatter reader. That distinction is
not pedantry: an earlier pass of this section used a cruder parser and published a false finding
(retracted below), and the rule that caught it is the repo's own — a measurement is only as good
as the reader that took it.

**2,858 tickets**, across **11 project keys** (ACA, BLZ, CRP, FL, INF, KPA, NCA, OBA, OMA, SN,
STA). **The board is live and advances under this figure** — the same corpus measured three times
over three days gave 2,849, 2,850, 2,854 and 2,858 — so treat it as a figure with a timestamp,
not a constant. The plan's *"2,815 tickets"* is superseded; re-derive rather than quote.
`projects/INF/FREED-IDS.md` and `projects/OBA/FREED-IDS.md` sit directly under a project
directory rather than in a status directory and are correctly not reached by `walkTickets`
(`scripts/model/index.mjs:226-236`).

**26 distinct frontmatter keys occur**, and every one is inside the 31-column set — `not_before`
and `deadline` are the two of the 28 with no live instance. **No board field is dropped by the
column list.**

| Key | Files carrying it | Notes |
|---|---|---|
| `id`, `title`, `type`, `project`, `resolution`, `assignee`, `components`, `estimate`, `created`, `updated` | all | on every ticket |
| `priority`, `parent`, `labels` | 2,857 each | and on three DIFFERENT tickets — `INF-608` has no `priority`, `OBA-819` no `parent`, `BLZ-142` no `labels`. Not a shared cohort |
| `worklog` | 1,932 (1,707 non-empty) | max **6** entries on one ticket |
| `links` | 1,521 (1,067 non-empty) | max **13** on one ticket |
| `branch` / `pr` | 606 / 596 | `pr` is always `#<N> — https://github.com/…/pull/<N>` |
| `ref` | 301 | |
| `category`, `verification`, `derived` | 173 each | |
| `likelihood`, `impact`, `sprint` | 80 each | all 80 `likelihood`/`impact` on `type: risk` |
| `due` / `start` | 40 / 38 | |
| **`not_before`, `deadline`** | **0** | ADR-0022's constraints are declared, unwritten on this board |

Seven facts the format depends on:

1. **Dates are uniformly `YYYY-MM-DD`, with zero deviations** — **5,794** date values across
   `created`, `updated`, `start` and `due`, none of them deviating. §2.3's single date grammar
   refuses nothing that exists.
2. **`estimate` is always an integer**, 1,928 non-empty, min **5**, max **4,800**.
3. **No frontmatter value anywhere begins with `=`, `+`, `-` or `@`.** Measured across every value
   of every key: **0**. This is the measurement §2.5's refusal rests on — refusing `=`/`@` on
   import cannot reject a value the board has ever held.
4. **32 values contain an embedded `"`** and **1,434 contain a comma** (mostly `title` and
   `worklog.note`). Both are RFC 4180's job and neither is theoretical.
5. **`labels` and `components` are always flow arrays**, never block lists; max **4** labels
   (`[lane:c, parked, advisory-only, founder-manual]`) and max **9** components. **No member
   contains a comma, a space or a quote** — which is what makes §2.4's `;` separation safe. Members
   *do* contain colons (`lane:c`, `marketing:dmp`, `area:compliance`), so `:` is not available as a
   list delimiter, and `;` is.
6. **Link types in use: `Relates` 991, `Blocks` 393, `Implements` 322, `Addresses` 89,
   `Duplicate` 23 — and `Cloners` 0.** The sixth declared type has no live instance, so the
   round-trip fixture must carry one deliberately (§3.3).
7. **RETRACTED — there are ZERO malformed links on this board.** An earlier version of this
   section claimed eight link entries across `OBA-415`, `OBA-466`, `OBA-468` and `OBA-469` carried
   a `type` and no `target`, and called it live data. **That was wrong.** Re-measured through
   `parseTicket`: all 2,858 tickets parse, **0** links lack a target, and `lintLinks`
   (`scripts/model/links.mjs:18`) reports **zero** warnings board-wide. The eight entries are
   real and the count was right, but they use the **block-mapping** spelling of §1.5, which
   `ticket.mjs:88-99` reads correctly and the cruder reader did not. The retraction is kept
   rather than deleted, because the error is instructive: the same run that produced the correct
   link-type counts above produced this, so a figure being surrounded by correct figures is not
   evidence.

   **What it costs the design:** §5.2 still refuses a link with no target on export, and that is
   still right defensively — but it is now a guard against a shape nothing on this board has, so
   it **ships without real-data exercise** and must be driven by a constructed fixture. The
   sentence "the exporter meets it on its first real run" is withdrawn.

Two more, for the fixture and for the mapping layer: **`priority` uses only 4 of its 7 values**
(medium 2,128 / high 516 / low 161 / highest 43 — `none`, `urgent` and `lowest` are unexercised),
and **`type` uses 9 of 10** (`epic` has zero instances, as BLZ-231 intended). An enum-coverage
fixture built by sampling the live board would therefore miss four values, which is why §3.3's
coverage assertion reads the **registry**, not the corpus.

### 1.7 Two other model constraints an importer must obey

- **Estimates are multiples of five minutes.** `roundEstimate` is `blaze new`'s *input* policy and
  it invents — `roundEstimate(1)` is `5` (`scripts/model/time.mjs:9-14`). `storableEstimate` is the
  mirror policy and returns `null` for anything not already an integer multiple of 5
  (`scripts/model/time.mjs:29-33`), because the database column is `INTEGER` with a `% 5 = 0`
  CHECK. The comment there records that the two writers once disagreed three ways about
  `estimate: 7` — filesystem `7`, `loadCorpus` `null`, write-port `5`.
- **An id needs a claim.** `missingClaimErrors` (`scripts/model/index.mjs:353-377`) makes a ticket
  whose id has no `.ids/` claim an **error**, not a warning, for any number above the project's
  cutover marker. `applyNew` writes the claim with the ticket (`scripts/new.mjs:123`). An importer
  that allocates ids and skips claims produces a board that fails `blaze audit` on every imported
  row. **BLZ-587's acceptance criteria do not mention claims at all** — see §8.

---

## 2. The canonical CSV schema, version 1

### 2.1 Format

RFC 4180, with these fixed choices:

| Property | Value |
|---|---|
| Encoding | UTF-8, **no BOM** |
| Line ending | `\n` (LF). A file containing `\r\n` outside a quoted cell is read, but re-export normalises to `\n` |
| Header | Required, first line, exactly the 31 names of §2.2 in that order for a **canonical** file |
| Quoting | A cell is quoted **iff** it contains `,`, `"`, `\n` or `\r`. Nothing else is quoted |
| Escape | A `"` inside a quoted cell is doubled (`""`). There is **no** backslash escape |
| Row arity | Every row has exactly 31 cells. A row with any other count is a format error |
| Absent | An **empty cell**. There is no `null` literal, no `~`, no `\N` |

There is no comment syntax and no preamble. A blaze CSV opens in a spreadsheet with no
preprocessing, which is the point of choosing CSV.

### 2.2 The 31 columns

`req` = required on every row. `enum` sources are the **resolved** registry for the row's project
(§1.2), never a hardcoded list.

| # | Column | Type | Req | Notes |
|---|---|---|---|---|
| 1 | `schema_version` | integer | ● | Constant `1`. Every row carries it |
| 2 | `id` | id | ● | `<KEY>-<N>`. **Required on import**, because the re-run-is-a-no-op guarantee is keyed on it (§5.2). Empty is accepted only under `--allocate-ids`, which forfeits that guarantee |
| 3 | `project` | project key | ● | Refused, never normalised (ADR-0025) |
| 4 | `type` | enum | ● | From the resolved `schema.types` |
| 5 | `status` | enum | ● | Must be in `statusesFor(type)` |
| 6 | `title` | text | ● | |
| 7 | `description` | markdown | ● | The ticket **body**. Multi-line, quoted |
| 8 | `priority` | enum | ○ | Empty means **absent**, never `medium` — §2.6 |
| 9 | `resolution` | enum | ○ | |
| 10 | `parent` | id | ○ | |
| 11 | `assignee` | text | ○ | Empty means **absent**, never `unassigned` — §2.6 |
| 12 | `labels` | list | ○ | `;`-separated |
| 13 | `components` | list | ○ | `;`-separated |
| 14 | `estimate` | integer | ○ | Minutes, multiple of 5 |
| 15 | `sprint` | text | ○ | Must resolve in `sprints.json` |
| 16 | `not_before` | date | ○ | Constraint (ADR-0022) |
| 17 | `deadline` | date | ○ | Constraint (ADR-0022) |
| 18 | `start` | date | ○ | **Scheduler output**, see §2.7 |
| 19 | `due` | date | ○ | **Scheduler output**, see §2.7 |
| 20 | `likelihood` | text | ○ | Required for `type: risk` |
| 21 | `impact` | text | ○ | Required for `type: risk` |
| 22 | `ref` | text | ○ | e.g. `REQ-014` |
| 23 | `category` | text | ○ | |
| 24 | `verification` | text | ○ | |
| 25 | `derived` | text | ○ | |
| 26 | `branch` | text | ○ | Written by `blaze reconcile` |
| 27 | `pr` | text | ○ | Written by `blaze reconcile` |
| 28 | `links` | pair list | ○ | `;`-separated `Type:TARGET` |
| 29 | `worklog` | JSON array | ○ | See §2.4 |
| 30 | `created` | date | ○ | |
| 31 | `updated` | date | ○ | |

Nothing else is a column, and a canonical file with a 32nd column is refused (§5).

**Why the version is a column and not a preamble line.** A `# blaze-csv v1` comment line does not
survive a spreadsheet, `sort`, `head -n 20`, or a paste of a subset of rows, and a sidecar file
can be separated from the data it describes. A constant column survives all of those. The cost is
one redundant column; the benefit is that a truncated or hand-edited file still declares what it
is. Import refuses a file where the column is absent, is not `1`, or disagrees between rows.

### 2.3 Types

| Type | Grammar | Refused |
|---|---|---|
| `date` | `YYYY-MM-DD`, exactly 10 characters | any other shape, including `YYYY-MM-DDTHH:MM:SSZ` and `DD/MM/YYYY` |
| `integer` | `-?[0-9]+`, no separators, no decimal point | `1,200`, `240.0`, `4h` |
| `id` | `<KEY>-<N>`, `N` a positive integer | anything else |
| `project key` | validated by `config.mjs`'s key rule | a lowercase or punctuated key — ADR-0025 refuses, never normalises |
| `list` | zero or more members separated by `;`, no surrounding space | a member containing `;` |
| `pair list` | zero or more `Type:TARGET` separated by `;` | a `Type` outside `LINK_TYPES`; more or fewer than one `:` in a member |
| `JSON array` | RFC 8259 array of objects | anything that does not parse, or an element that is not an object |

`date` is exactly what the engine already treats as a date: `zero-diff.mjs:148` tests
`/^\d{4}-\d{2}-\d{2}/`, and `blaze new` stamps `created`/`updated` as bare ISO dates
(`scripts/new.mjs:53`).

### 2.4 Multi-valued fields — one rule, two shapes

**The rule:** a compact `;`-separated form where **every member is delimiter-free by validation**;
JSON where any member is free text.

- `labels`, `components` — members are validated against the project's declared taxonomy
  (`scripts/model/taxonomy.mjs:7-19`) or, where a project declares none, are opaque strings. A
  member containing `;` is a refusal rather than an escape, because inventing an escape
  character inside a CSV cell that is itself already escaped is how a format becomes unreadable
  by the spreadsheet it exists for. `backend;engine`.
- `links` — both halves are constrained: `type` is one of six (`LINK_TYPES`) and `target` is an
  id, so neither can contain `;` or `:`. `Implements:BLZ-167;Relates:BLZ-268`.
- `worklog` — the `note` member is free text and carries commas, quotes, `#`, `:` and `;` on the
  live board (§1.5). There is no delimiter to pick, so the cell is a **JSON array** with keys
  emitted in the fixed order `date`, `minutes`, `note`:
  `[{"date":"2026-08-20","minutes":240,"note":"…"}]`. JSON escapes every hostile character, and
  RFC 4180 quoting then handles the `,` and `"` that JSON introduces.

**Order.** `labels`, `components` and `worklog` preserve authored order in both directions — the
database preserves it too (`ORDER BY ord` for labels and components, `ORDER BY id` for worklog,
`scripts/model/write-port.mjs`'s `read`). **`links` are sorted by `(type, target)` on export**,
because the database returns them `ORDER BY link_type, target_id` (`:323-324`) and because
`ticketValue` already declares the reason: *"`links` is compared as a set of pairs … Order is not
a value"* (`scripts/model/write-port.mjs:48-50`).

**The `fs`/`db` parity this buys is real today but conditional, and the condition is worth
stating.** Sorting makes the two ports agree on link *order*. It does not make them agree on link
*membership*, and one link type would break that:

- `ticket_link` carries **no CHECK on `link_type`** (`scripts/model/sqlite-schema.mjs:109-113`), so
  it can hold `Precedes` — which §1.4 records lives in the v4 meta-model and cannot be written in
  frontmatter.
- If such a row existed, the `db` port's `read` would surface it as a frontmatter link, §2.3's
  `pair list` grammar would refuse it (it is outside `LINK_TYPES`), and the round trip would
  either break at import or drop it — a loss **gate 1 structurally cannot see** (§3.1).

**No such row exists today, and this design does not claim the risk is live.** The only producer
of `Precedes` edges is `blaze schedule import-deps`, which is report-only — its own last line is
*"Nothing written — this verb is report-only"* (`scripts/schedule-runner.mjs:192`) — and
`dbWritePort`'s `persist` DELETEs every `ticket_link` row for a ticket and re-inserts from
frontmatter (`scripts/model/write-port.mjs:254-259`), so even an externally-inserted `Precedes`
would be destroyed by the ticket's next write.

So the parity claim is bounded rather than dropped: **the two ports agree for as long as
`ticket_link` is derived from frontmatter.** The day BLZ-360 §5.5 lands a real `Precedes` writer,
this design's link grammar and gate 1 both need revisiting — and gate 2 (§3.1), which compares
values through the read driver, is what would notice. That dependency is recorded in §8 rather
than left for whoever lands the writer to discover.

### 2.5 Escaping — comma, newline, quote, and a leading `=`

The first three are RFC 4180's job and blaze adds nothing:

| Value | Cell |
|---|---|
| `a, b` | `"a, b"` |
| `he said "no"` | `"he said ""no"""` |
| `line one`⏎`line two` | `"line one`⏎`line two"` |
| `#63 — https://…/pull/63` | `#63 — https://…/pull/63` (nothing to escape) |

A leading `=`, `+`, `@`, tab or carriage return is **not a CSV hazard — it is a spreadsheet
hazard.** Excel and LibreOffice evaluate such a cell as a formula on open, which is the
`=HYPERLINK(...)`/`=cmd|...` injection class.

**Blaze does not mutate the value.** Prefixing with `'` would corrupt a legitimate title and would
break the round trip, and a second "safe" output format is a second thing to keep in sync. Instead:

**One character set, one predicate, used by both sides.** An earlier draft had export warn on
`=`, `+`, `@`, tab and CR while import refused only `=` and `@` — so a **leading tab was warned
about on the way out and accepted on the way in**, which is the gap the whole rule exists to
close. And the check was first-character-only, so `"\t=cmd|' /C calc'!A0"` — a tab, then the
formula — passed it. Both are fixed by defining the predicate once:

```
hostile(cell)  :=  the first character of cell, after stripping leading
                   whitespace (space, tab, CR, LF, and U+00A0), is one of  =  @
```

- **Stripping first, then testing** is what makes a leading tab or space unable to smuggle the
  formula character past the check. Excel strips leading whitespace before deciding a cell is a
  formula, so the predicate matches the threat rather than the literal first byte.
- **`=` and `@` only.** `+` and `-` are deliberately excluded, on measurement rather than taste:
  a title may legitimately begin with either, and §1.6 fact 3 records that **zero** of the live
  board's values begin with `=`, `+`, `-` or `@` — so refusing `=`/`@` rejects nothing the board
  has ever held, while refusing `+`/`-` would be an untested restriction on free text.

Applied on both sides:

1. **Export mutates nothing and refuses nothing**, but names on stderr every `hostile` cell — with
   its ticket id, its column, and the total — so the operator learns before opening the file in a
   spreadsheet, not after. Prefixing with `'` would corrupt a legitimate title and break gate 1,
   and a second "safe" output format is a second thing to keep in sync.
2. **Import refuses every `hostile` cell** (exit 1, §5.1). Same predicate, same characters, no
   gap between what one side warns about and the other accepts.

### 2.6 Empty and absent are one thing

CSV has no absence — every row has all 31 cells — so **an empty cell means absent**, and the
exporter emits an empty cell for `null`, `""` and `[]` alike. This is not an invention: the
engine already collapses those three, and says why. `ticketValue`
(`scripts/model/write-port.mjs:54-58`): *"Empty string and absent are the same absence. A file
writes `parent:` with nothing after it; a database stores NULL. Treating those as different would
report a divergence on every ticket without a parent."* Import applies the same collapse in
reverse.

**The importer materialises no defaults, and an earlier draft of §2.2 said it did.** That draft
gave `priority` *"default `medium` if empty"* and `assignee` *"default `unassigned` if empty"*,
which contradicts this section and **breaks gate 1**: a default written on import makes Y's cell
non-empty where X's was empty, so `diff X Y` is non-empty while §3.2 promises byte-identical.
It is not hypothetical — `INF-608` carries **no `priority` key at all**, one of exactly three
tickets on the live board missing one of these (§1.6). §2.2 now defers to this section; an empty
cell round-trips as an absent key.

**Under `BLAZE_WRITE_PORT=db` this is not achievable, and gate 1 is therefore declared
`fs`-only.** `dbWritePort`'s `persist` writes `fm.priority || "medium"`
(`scripts/model/write-port.mjs:235`) and `fm.assignee || "unassigned"` (`:236`) into `NOT NULL`
columns, so a priority-absent ticket comes back as `medium` **no matter what the importer does**.
That is the database's schema, not a defect, and no importer behaviour can route around it.

So the contract is stated per port rather than claimed universally:

| Port | Gate 1 (`diff X Y`) | Gate 2 (values) |
|---|---|---|
| `fs` (default) | **holds** — absence round-trips | holds |
| `db` | **does not hold** for `priority` and `assignee` on a row absent either; holds for the other 29 | holds — `zeroDiff`'s `DEFAULTS = { priority: "medium", assignee: "unassigned" }` (`scripts/migrate/zero-diff.mjs:141`) already classifies exactly this as `defaulted` rather than a value diff, which is why that carve-out exists |

The CI gate runs under `fs`, which is the default and the store the round trip is defined against.
A `db` run reports the two columns as port-defaulted in its trailer rather than failing — and
`zeroDiff` already having a carve-out named for precisely these two fields is the evidence that
this is the engine's long-standing behaviour, not something this design introduced.

### 2.7 The two fields that are outputs, not inputs

`start` and `due` are **scheduler outputs** under ADR-0022. `EDITABLE_FIELDS`
(`scripts/model/fields.mjs:22-25`) excludes them, and `derivedFieldRefusal`
(`:33-37`) refuses an edit naming the replacement constraint field. `applyNew` no longer accepts
them either (`scripts/new.mjs:45-52`).

They are nonetheless **exported and imported verbatim**, for two reasons that are both measured
facts rather than preferences: `buildIndex` carries them (`scripts/model/index.mjs:416`) with a
comment recording that dropping them made the Gantt render 12 tickets as `unplanned`, and
`zero-diff.mjs:130-135` checks them as part of the oracle's field list. A round trip that silently
dropped them would lose data the migration oracle already treats as data.

The importer therefore writes them **through `writePort.write` directly**, not through
`applyEdit` — `applyEdit` would refuse them, correctly, because a person editing a board should
not set a scheduler output by hand. Importing a corpus is not that operation.

### 2.8 A field the board has that CSV cannot express

**Inside a ticket, there is none.** All 28 frontmatter keys plus `status` plus the body are
columns. But the database write port has an `extra_json` tail for keys outside `COLUMN_FIELDS`
(`scripts/model/write-port.mjs:138-147`), so a board *can* hold a 29th key.

**The rule is a loud failure, per BLZ-589's own acceptance criterion.** `blaze export` walks every
ticket's frontmatter keys and, on encountering a key outside the declared 28, **refuses the whole
export** (exit 1) naming the ticket and the key. It does not emit a partial file with the key
dropped, and it does not invent a column. Adding a 29th field to the model therefore fails the
export and the CI round trip on the same day it lands — which is the behaviour the criterion
asks for.

What CSV genuinely cannot carry is **board state that is not a ticket**: the `.ids/` claim ledger,
`sprints.json`, `projects/<KEY>/project.json`, `.blaze/transitions.json`, the `ticket_event`
history, and the on-disk filename slug (60 of 2,537 tickets have a filename that no longer matches
`id-slug(title)` — `scripts/model/storage.mjs:72-77`). All six are §7 out-of-scope, not silently
lost: import **derives** what it must (claims, §5.5) and refuses what it cannot (an unknown
sprint id).

---

## 3. The round-trip contract

### 3.1 Three gates, because the obvious one is blind

```
A  ──blaze export --format csv──▶  X
X  ──blaze import --apply──▶  B   (an empty board)
B  ──blaze export --format csv──▶  Y
```

**Gate 1 — `diff X Y` is empty, byte for byte.** This catches importer defects. `fs` port only,
per §2.6.

**Gate 2 — `zeroDiff(A, B).valueDiffs` is empty.** This catches **exporter** defects, and without
it gate 1 is vacuous.

**Gate 3 — every one of the 31 columns is non-empty in at least one row of X.** Gates 1 and 2 both
compare *corpora*; neither notices a column empty **everywhere** — in the fixture and in both
exports alike. Thirty-one assertions, and the cheapest of the three.

All three are stated here, in §0 and in ADR-0037. An earlier draft carried gate 3 only in the CI
recipe and the ticket breakdown while both the headline decisions and the binding ADR said *"two
gates"* — so an implementer following the decision record would have built two and shipped the
hole gate 3 closes.

**Why gate 1 alone is not an oracle, stated plainly because an earlier draft of this document
claimed it was.** X and Y are produced by the *same exporter*, so **any exporter defect is
common-mode and cancels in the diff.** The refuting input is trivial and it passes every check the
first draft specified: an exporter that emits the correct 31-name header and then an **empty
cell** for `priority`, `resolution`, `parent`, `assignee`, `labels`, `components`, `sprint`,
`not_before`, `deadline`, `start`, `due`, `ref`, `category`, `verification`, `derived`, `branch`,
`pr`, `links`, `worklog`, `created` and `updated`. Row arity stays 31, so §2.1's arity check
passes. X equals Y byte for byte, so the diff is empty. And `blaze audit` passes, because
`validateTicket` checks only `requiredFields(type)` (`scripts/model/rules.mjs:25-31`) and
`DEFAULT_TYPES` (`scripts/model/schema.mjs:14-28`) requires only `title` and `description`, plus
`estimate` for story/task/bug and `likelihood`/`impact` for risk.

**21 of the 31 columns can be silently zeroed with the entire first-draft gate green.** Only 10 —
`schema_version`, `id`, `project`, `type`, `status`, `title`, `description`, `estimate`,
`likelihood`, `impact` — are structurally or by validation load-bearing.

The revert rule as first written did not cover it either: *removing* a column is caught by the
arity check, but **blanking** one is not, and blanking is the defect shape that matters.

**The repo already has the right instrument and it was not used.** `scripts/migrate/zero-diff.mjs`
is a value-level comparator over exactly these fields — `FIELDS` at `:130-135` covers the 26
scalars, `ARRAY_FIELDS` at `:136` covers `worklog` and `links` by multiset, `:202-203` compare
`status` and `body`, and `DEFAULTS`/`STAMPED` at `:141-147` carve out "never stated" from
"changed" so it does not cry wolf on 2,000 non-changes. It is order-tolerant by construction,
which is exactly why it can compare A against B where a byte oracle cannot.

**Why gate 2 is not itself a byte comparison of the markdown.** `scripts/migrate/zero-diff.mjs:8-12`
records that **137 of 2,534 tickets (5.4%) do not re-emit byte-identically today, with zero value
mismatches**, purely because `serializeTicket` normalises to `FIELD_ORDER` while on-disk files
keep their authored order. In that module's own words, *"an acceptance criterion that fails for an
unrelated reason gets waived — which is how a real regression later slips through a gate everyone
has learned to ignore."* So gate 2 compares **values**, not bytes — and gate 1 supplies the byte
strictness, on the artefact where byte strictness is achievable.

### 3.2 What is allowed to differ

| Between | Allowed to differ | Enforced by |
|---|---|---|
| **X and Y** | **Nothing.** Byte-identical | gate 1, **`fs` port only** (§2.6) |
| **A and B as values** | **Nothing.** All 28 keys, the status and the body compare equal | **gate 2** |
| A's ticket files and B's ticket files as bytes | Frontmatter key **order** (the 5.4% above); the filename slug where A's had drifted from `id-slug(title)`; `.blaze/` derived state; git history | nothing, deliberately |

Making X vs Y byte-identical is achievable because export is **canonical** — fixed column order,
fixed row order, minimal quoting, one date format, `links` sorted, everything else order-preserving:

- **Row order:** `(project ascending, numeric part of id ascending)`. Not lexicographic —
  `BLZ-9` sorts before `BLZ-10`.
- **Column order:** exactly §2.2, always all 31, always in that order.
- **Quoting:** the minimal rule in §2.1, so two exports of the same values cannot differ in
  quoting.

### 3.3 How CI measures it

**All three gates live in a `node --test` suite — `tests/csv-round-trip.test.mjs` — not in
`.github/workflows/board-gate.yml`.** They need a temp board, which the suite builds routinely
(~56 test files already stand up a real temp dir and git repo), and the repo's most important
correctness gate has to be runnable locally and mutation-testable. Encoding it in CI-workflow YAML
would make it the one piece of test logic nobody can run without pushing. `board-gate.yml` keeps
what it already does; the round trip is not YAML.

The suite, per run, with `BLAZE_WRITE_PORT` unset (`fs`, per §2.6):

1. `exportCsv(tests/fixtures/csv-round-trip/projects)` → `X`
2. `importCsv(X, { into: <tmp board B>, apply: true })`
3. `exportCsv(<tmp board B>/projects)` → `Y`
4. **Gate 1** — `assert.equal(X, Y)`; a byte difference fails.
5. **Gate 2** — `zeroDiff(...)`, requiring `valueDiffs`, `missing`, `extra` and
   `frozenViolations` all empty.

   **`zeroDiff` cannot be called directly here and an earlier draft's recipe was unrunnable.**
   `scripts/migrate/zero-diff.mjs:81` hard-codes `loaded.listTickets(null)`, written for a
   database driver that ignores the argument. B is a **filesystem** board, whose
   `listTickets(root)` (`scripts/model/read-storage.mjs:140`) is `walkTickets(root)` — and
   `safeReaddir` (`scripts/model/index.mjs:15`) swallows the error from `walkTickets(null)` and
   returns `[]`. So `dst` would be empty and **every id would land in `missing`**. It fails loud
   rather than silently, but it never passes, and no wrapper was specified.

   The wrapper is one object, and it belongs in the test rather than in `zero-diff.mjs` — that
   module is shared with the migration suites and its `null` convention is load-bearing there:

   ```js
   const loadedB = { listTickets: () => fsReadStorage.listTickets(bProjectsDir) };
   const report  = zeroDiff(fsReadStorage, fixtureProjectsDir, loadedB);
   ```

   **This is the step that catches an exporter defect**, and without it steps 1–4 are
   common-mode-blind (§3.1). The comparator is `scripts/migrate/zero-diff.mjs`, reused rather
   than reimplemented — a second value comparator written by the same hand as the exporter would
   agree with the exporter by construction, including where it is wrong, which is the failure
   `zero-diff.mjs:205-208` already names for the AC matcher.
6. **Gate 3 — per-column non-emptiness.** For each of the 31 columns, assert **at least one row of
   X is non-empty**. This is the direct guard against the blanking defect and it is cheap: 31
   assertions over the fixture. Without it, a column could be blank in *every* fixture row and
   both gates above would still pass.
7. `blaze audit <tmp board>/projects` — a non-zero exit fails the job. A round trip that produces
   a corpus the audit rejects has not round-tripped. Note this is a **weak** check on its own:
   §3.1's blanking defect passes it.

**The fixture is the gate's real content**, and BLZ-589 already specifies it: at least one row of
every enum value the registry allows. Concretely, `tests/fixtures/csv-round-trip/` carries at
minimum:

- one ticket of **each of the 10 types**, each in **each of its workflow's statuses** — 13 distinct
  statuses across 5 workflows (§1.3);
- one ticket at **each of the 7 priorities** and **each of the 4 resolutions**;
- one link of **each of the 6 `LINK_TYPES`**, including a forward reference (a link to a row that
  appears later in the file) and a link between projects;
- a ticket with a multi-entry `worklog` whose `note` contains a comma, a double quote, a
  semicolon, a colon and a `#`;
- a `title` containing a comma, a `title` containing a double quote, a `description` containing a
  blank line and a fenced code block, a `pr` beginning with `#`;
- a ticket with empty `labels` and `components` and one with several of each;
- **a row with `priority` absent and a row with `assignee` absent.** Requiring all 7 priorities
  is not the same as requiring a priority-ABSENT row, and the enum-coverage assertion cannot
  produce one — so without these two the §2.6 defaults conflict would have stayed green in CI.
  `INF-608` is the live proof the case exists (§1.6);
- **gaps in the id sequence**, so the round trip cannot pass by renumbering;
- **a `.ids/.cutover` marker on the fixture project, and an assertion that a claim file exists for
  every created ticket.** Without the marker the fixture is *structurally incapable* of catching a
  regression in §5.5: `missingClaimErrors` returns early at `scripts/model/index.mjs:367`
  (`if (cutover === null) continue;`) and `ensureCutover` has one call site, inside `allocateId`
  (`scripts/model/ids.mjs:72`) — so a fresh board never allocates, never gets a marker, and stays
  silent forever. An importer that regressed to skipping claims would pass CI indefinitely and
  fail only on the operator's real board, which is the exact distribution §5.5 exists to close.
  Seeding the marker is what makes the guard possible at all; asserting the claim files directly
  is what makes it independent of the audit's own early return;
- a ticket carrying `ref`, `category`, `verification` and `derived` — the four keys that
  serialize after `updated` and are therefore the ones an implementation is most likely to drop;
- **a ticket carrying `not_before`, `deadline` and `sprint`.** These three have **zero live
  instances** (§1.6), and — unlike the enums — the enum-coverage assertion below **cannot reach
  them**, because they are not enums. Gate 3 is what forces them into the fixture;
- a link entry deliberately malformed (`type`, no `target`) in a **separate refusal fixture**, to
  exercise §5.2's export refusal, which §1.6 fact 7 records has no live instance to drive it.

Three guards make the gate discriminating rather than merely green, per the plan's §9 method:

- **The revert rule, on the defect shape that matters.** *Removing* a column is already caught by
  the arity check, so the revert test **blanks** a column in the exporter instead and asserts
  gate 2 goes red *for the reason its name gives*. A revert test aimed at the case the gate
  already catches is a revert test that proves nothing.
- **An enum-coverage assertion.** A test that reads the resolved registry and asserts the fixture
  contains every type, every status of every workflow, every priority, every resolution and every
  link type. It reads the **registry**, not the corpus — sampling the live board would miss
  `Cloners`, `none`, `urgent`, `lowest` and `epic`, all of which have zero instances (§1.6).
  Adding an enum value without adding a fixture row then fails CI, which is BLZ-589's last
  acceptance criterion made mechanical instead of remembered.
- **A positive control on gate 2 itself.** `zeroDiff` returns `fieldsChecked` and `compared`
  (`scripts/migrate/zero-diff.mjs:69,153,157`). The test asserts both are **non-zero** before
  trusting an empty `valueDiffs` — otherwise a comparator handed two empty corpora reports clean
  and the gate is measuring nothing. This is the plan's §9 rule (*"assert the observation
  happened"*) applied to the instrument rather than to the subject.

---

## 4. The mapping layer

### 4.1 The shape of the problem

A canonical file needs no mapping — its header is the 31 names and import reads it directly. An
**arbitrary** CSV (a Jira export, a Linear export, a spreadsheet) has different column names,
different status words, different date formats and different id conventions. Q2's answer is that
those are inferred **per file**, not hardcoded per tracker.

### 4.2 The mapping file

**Location:** `import-mappings/<name>.json` at the **data root**, beside `blaze.config.json` and
`sprints.json` — committed, reviewable, diffable.

**Not under `.blaze/`**, and the precedent is explicit. `.blaze/` holds regenerable derived state
(`scripts/reindex.mjs:1-5`); a mapping is *source*. BLZ-110's own body drew the same line for
`sprints.json`: *"it isn't a `.blaze/` cache — that directory holds regenerable derived state; a
sprint definition is source, so it lives at top level and gets committed like tickets do."*

**Format:**

```json
{
  "mappingVersion": 1,
  "schemaVersion": 1,
  "name": "acme-jira-export",
  "source": {
    "columns": ["Issue key", "Summary", "Issue Type", "Status", "Priority", "Story Points"],
    "sha256": "b1946ac9…"
  },
  "sourceIdColumn": "Issue key",
  "columns": {
    "id":          { "from": "Issue key" },
    "title":       { "from": "Summary" },
    "type":        { "from": "Issue Type" },
    "status":      { "from": "Status" },
    "priority":    { "from": "Priority" },
    "estimate":    { "from": "Story Points", "transform": "hours-to-minutes" },
    "project":     { "constant": "ACME" },
    "description": { "from": "Description" }
  },
  "values": {
    "type":     { "Story": "story", "Sub-task": "subtask", "Epic": "feature" },
    "status":   { "To Do": "defined", "In Progress": "in-progress", "Done": "done" },
    "priority": { "P1": "high", "P2": "medium" }
  },
  "unmapped": ["Sprint Health", "Reporter"],
  "confirmedBy": "ryan",
  "confirmedAt": "2026-09-08"
}
```

- `source.columns` is the **verbatim header row** and `source.sha256` is its digest. Import checks
  both. A source export whose header has changed is a **refusal**, not a best-effort re-map —
  that is the case where silently continuing produces the wrong-but-plausible board.
- **`sourceIdColumn` names the source's own identity column**, and it is what makes a re-import of
  the same foreign export idempotent. §5.2 requires a blaze `id` and offers `--allocate-ids` for
  rows without one; on its own that flag forfeits the no-op guarantee. With `sourceIdColumn`, the
  importer keys the skip/update decision on the **source** key instead, so re-running the same
  export is a no-op even though blaze allocated the ids. The forfeit then applies only to a CSV
  with **no identity column at all** — a genuinely anonymous spreadsheet — which the dry run names
  in as many words. In §4.2's example the column is `Issue key`, which also maps to `id`; the two
  uses are independent, and a tracker whose keys do not parse as `<KEY>-<N>` uses
  `sourceIdColumn` alone.

  **The map lives in its own durable store, and an earlier draft put it in the one artifact the
  retention rule is designed to delete.** That draft recorded the source-key → blaze-id pairs in
  the receipt while §5.3 pruned receipts older than 90 days *whose every `intent` has a matching
  `done`* — so retention kept the records of **failed** runs and deleted the records of **clean**
  ones, which is the exact inverse of what idempotency needs. Concretely: import 2,800 rows
  cleanly on day 0; on day 91 the next `--apply` prunes that receipt; on day 92 the same export
  re-imports with the map gone and **duplicates the entire board** — the precise failure
  `sourceIdColumn` exists to prevent. Both halves were added in the same commit, which is how they
  were written without ever being read against each other.

  The map is therefore **`source-ids/<mapping>.jsonl` at the data root**, beside
  `import-mappings/` and committed for the same reason: it is source, not a run artifact, and it
  outlives every individual run. One file per mapping, so the lookup reads exactly one file rather
  than folding N receipts of unknown completeness.

  **It is an OUTCOME record, appended one pair per row BETWEEN the ticket write and that row's `done` — and the draft
  that moved it here got that exactly backwards.** That draft wrote the whole map *before* the
  tickets, forbade rewriting any pair, and placed the write "under §5.1's exit-4 invariant like
  every other write". Three defects, each fatal on its own, and every one is a collision with a
  rule this document already states:

  - **§5.1's invariant is conditioned on a ticket having been written** — *"once any ticket has
    been written, no later failure may exit anything but 4"*. A pre-ticket map write is not under
    it. An unwritable `source-ids/` therefore fell under **no** exit code: an uncaught throw exits
    1, whose row says *"data refused — one or more rows fail validation"*, which is false. Exit 5
    was created for the receipt on precisely this argument and not extended.
  - **A map written before the event is §5.3's "mistake 1" verbatim** — *"a record written before
    the event cannot be an outcome."* After an exit 4 at row 300 of 2,800, a pre-written map
    asserts 2,500 source-key → blaze-id pairs with **no ticket behind them**, and "never rewrites
    an existing pair" forbids correcting them.
  - **The consequence is worse than the duplication the map exists to prevent.** On re-import the
    2,500 phantom pairs make every unwritten row look *already imported*, so the retry **skips
    them** — silent data loss, on exactly the run whose purpose is recovery.

  So, the rule, and it is the receipt's rule applied to a second file:

  - **The file is opened for append before any ticket write, alongside the receipt.** If either
    cannot be opened, the run does not start — **exit 5**, whose definition in §5.1 now covers
    both. Board unchanged.
  - **One line is appended per row, BETWEEN the ticket write and that row's `done`**, through
    `appendRegularFileSync` (`scripts/model/regular-file.mjs:135-143`) — synchronous, and refusing
    a non-regular file. So **`done` implies pair**: a row with a `done` has its ticket on disk and
    its pair in the map, and a row without one may have either, both, or neither. An earlier
    draft appended the pair *after* `done` and claimed "a pair never exists without its ticket" —
    the right invariant in the wrong direction. What matters on re-import is the converse: a
    **ticket without a pair** is invisible to the lookup and gets created twice. After-`done`
    ordering left exactly that window (SIGKILL or `ENOSPC` on the map append, ticket on disk,
    map one pair short, **no torn line** to detect it), and the draft's own test 2 could only
    inject a fault after row N's map append — the one point that cannot expose it. An append
    that fails here is after a ticket write, so it is under the exit-4 invariant with
    everything else. The full per-row sequence is stated once, in §5.3.
  - **Append-only**, which is what "never rewrites an existing pair" actually means once the file
    is a log: a source key that already has a line keeps it, and the lookup takes the **first**
    occurrence, so a later accidental duplicate line can never remap a row.
  - **The lookup reads one file, read-only, and a torn line is a refusal — exit 5, nothing
    written.** Not "parked": parking is a write (§5.3 item 3), the lookup runs before any ticket
    write, and a failed park there would fall under no exit code — the hole this bullet list was
    written to close, reopened one item later. A torn line is a pair cut mid-append, with its
    ticket already on disk (the write precedes the append), so the map does not know a ticket
    that exists and a re-import would create it again. The importer refuses rather than guess.
    It is **5, not 2**: an earlier draft widened 2 to cover it, but §5.1 separates 5 from 2
    precisely because *"a different file with a different remedy"* deserves its own code, and a
    torn map is a different file (not the input) with a different remedy (repair the record, not
    the data). 5 is now defined as *the run's own records are not in a state it may start from*,
    and this is one of its four cases.

    **The receipt is the recovery source, and an earlier draft said so while the receipt could
    not do it.** Its entries carried `row`, `id`, `file`, `claim` — **no source key**, and the
    `intent` is written before allocation so it cannot carry the id either. Both are now
    recorded: `intent` carries **`source`** (the row's `sourceIdColumn` value) and a new
    **`allocated`** phase carries the id the moment it exists (§5.3). A pair is then
    reconstructible from the receipt alone: `source` from the `intent`, `id` from the
    `allocated`.

    **The inspection path repairs by truncate-then-append, and the truncate is a non-append
    write this document has to state.** "Re-append the pair" onto an append-only file whose last
    line is a torn fragment with no newline glues the pair to the fragment and makes it
    unparseable too. So the path: park the fragment's raw bytes to `<map>.corrupt` (BLZ-531 —
    park before you clear), **truncate** the map to its last complete line, then
    `appendRegularFileSync` the reconstructed pair. The one place the map is not append-only,
    and it is an operator action, never the importer's.

  ```
  {"source":"ACME-123","id":"BLZ-620","seq":41}
  ```

  **Two tests, neither optional, both absent from every earlier draft** — nothing anywhere named
  `source-ids` in a test:

  1. **Fail the map's open before any write** (an unwritable `source-ids/` directory) and assert
     **exit 5, zero tickets written, zero receipt lines**.
  2. **Fail the map append at row N of a `sourceIdColumn` import whose ids are allocated** (`--allocate-ids`, so row N has an `allocated` entry to assert on) — the injected fault is the
     append itself, not something after it, because that is the only placement that opens the
     ticket-without-pair window. Assert: ticket N **is** on disk; the map holds **N−1** lines;
     the receipt has row N's `intent` and `allocated` and **no** `done`. Then re-import the same
     file and assert it **refuses with exit 5** naming row N as unresolved. Then resolve through
     the inspection path and re-import again: rows above N **created**, rows 1..N **skipped**,
     **no duplicate**, **no phantom pair**. This is the test that would have caught both the
     pre-write draft and the after-`done` draft, and it is the one that proves `sourceIdColumn`
     is idempotent *under failure*, which is the only case that matters.
- `transform` is a **closed vocabulary**, not an expression language: `identity` (the default),
  `hours-to-minutes`, `seconds-to-minutes`, `days-to-minutes`, `trim`, `split-semicolon`,
  `split-comma`, `iso-date`, `dmy-date`, `mdy-date`. A mapping naming a transform outside the
  list is refused. An expression language here would be a second place a model's output becomes
  executable, and ADR-0037 §2 exists to have exactly one.
- `unmapped` is required to be **present and complete**: every source column is either in
  `columns` or in `unmapped`. A source column in neither is a refusal, so a column cannot be
  dropped by omission.

### 4.3 Where the model runs, and the boundary that guarantees it does not

| | proposes | imports |
|---|---|---|
| Command | `blaze import propose-mapping <file.csv>` | `blaze import --mapping <m.json> <file.csv>` |
| Runner | `scripts/import-mapping-runner.mjs` | `scripts/import-runner.mjs` |
| Model? | **yes**, once | **never** |
| Writes | one file: `import-mappings/<name>.json` | tickets, under `--apply` |
| Sees the board? | no | yes |

The proposer **will be** `proposeMapping(header, sampleRows, { agentCommand })` in
`scripts/model/import-mapping-propose.mjs` — a new module; nothing by that name exists at
`13f661c`. It will spawn `cfg.agentCommand` through the same seam the groomer already uses
(`scripts/loops/groomer.mjs:547,570`, today the tree's **only** read of `agentCommand`), default
`"claude -p"` (`scripts/config.mjs:21`), overridable by `BLAZE_AGENT_COMMAND`
(`scripts/config.mjs:271`). It will be handed the header row and a bounded sample of rows and
will return a mapping candidate. It will never resolve an id, never read the corpus and never
touch a write port — and C3's guard (§4.3) is what turns each of those "never"s from a
specification into a pinned property.

**The guarantee is that no spawn is PERFORMED — not that none is linked.** An earlier draft of
this document specified three static-graph assertions, and **two of the three are unsatisfiable.**
Measured by walking the transitive `import` graph from the modules this design itself names as
importer dependencies (`schema.mjs`, `workflows.mjs`, `ids.mjs`, `rules.mjs`, `taxonomy.mjs`,
`index.mjs`, `write-port.mjs`, `commit-or-queue.mjs`):

| | Result |
|---|---|
| modules reached | **26** |
| importing `node:child_process` | **6** — `config.mjs` (via `workflows.mjs` → `ambientSchemaOverride`), `model/claims.mjs` (via `index.mjs`), `model/git-common.mjs` (via `ids.mjs`), and `branch-guard.mjs`, `pending-ledger.mjs`, `serve-commit.mjs` (all via `commit-or-queue.mjs`) |
| mentioning `agentCommand` | **1** — `config.mjs`, which **defines** it at `:21` and populates it from `BLAZE_AGENT_COMMAND` at `:271` |

Every one of those edges is required by the importer's own work. So "no module in the graph
imports `node:child_process`" is false for every entry point in the repo, and "no module reads
`agentCommand`" is false the moment the importer calls `loadConfig()` — which it must, to resolve
the schema registry — and `loadConfig` hands it a live `cfg` carrying the spawn string. The
positive control was also weaker than claimed: since `child_process` is reachable from essentially
every runner, assertions 2 and 3 are tripped by *every* entry point and the control discriminates
only for assertion 1.

**And the first repair was worse than what it replaced.** It proposed an in-process harness
replacing `child_process.spawnSync`/`spawn`/`execFileSync` with throwing stubs. That cannot work
here: `cli.mjs:9` is
`spawnSync(process.execPath, [join(here, file), ...args], { stdio: "inherit" })`, so the runner is
a **separate process** and a monkey-patch in the parent reaches nothing inside it. It also missed
`execSync`, `execFile` and `fork`.

**The property is narrower and truer than "no spawn": NO AGENT COMMAND IS EXECUTED.** "No spawn"
is simply false for a correct importer — staging shells out to `git`, and `transitions.mjs:62`
spawns one too. What must never happen is that the *configured agent command* runs on the import
path.

**Three assertions, pinned the way this repo already pins a shelled-out binary** — a PATH-shadowed
stub, the `stubGh` pattern at `tests/reconcile-delivery-truth.test.mjs:65-73`, combined with the
`agentCommand`-pointing-at-a-script pattern at `tests/supervisor-identity.test.mjs:41-45`. Because
`cli.mjs` spawns with the inherited environment, a `PATH` and `BLAZE_AGENT_COMMAND` set in the
test propagate into the runner process, which is exactly what the in-process patch could not do.

**Two arms, two sentinels — because they are exercised by different configurations and a single
sentinel cannot tell them apart.** `config.mjs:271` is
`if (env.BLAZE_AGENT_COMMAND) cfg.agentCommand = env.BLAZE_AGENT_COMMAND` — an **override**, not a
merge — and the spawn site splits `cfg.agentCommand` and spawns `cmd` directly
(`groomer.mjs:547,570`). So with the env var set to a stub path, `cmd` is **absolute** and `PATH`
is never consulted. An earlier draft set both the env var and a PATH-shadowed `claude` and used
**one** sentinel for both: across all three of its assertions the PATH stub was never executed
once, so a misconfigured shadow — wrong directory, not `chmod +x`, `PATH` not actually inherited —
left assertion 1 passing and nothing noticing. Vacuously green for the entire default-config
class the shadow exists to cover: round 2's defect, halved rather than fixed.

Set up: **two** stub scripts, each writing its **own** sentinel and exiting non-zero — `ENV_HIT`
for the one `BLAZE_AGENT_COMMAND` points at, `PATH_HIT` for a PATH-shadowed `claude` covering the
built-in default (`scripts/config.mjs:21`).

1. **No agent command runs on the import path.** `blaze import --apply` over a fixture CSV
   **succeeds**, and **neither sentinel exists** afterwards. Asserting sentinel absence — not
   merely a zero exit — is what distinguishes "nothing spawned it" from "it spawned and we ignored
   the result".
2. **Positive control, env arm.** `blaze import propose-mapping` under the *identical* environment
   **fails**, `ENV_HIT` **exists**, and the failure message **carries its sentinel string**.
3. **Positive control, PATH arm.** `blaze import propose-mapping` with `BLAZE_AGENT_COMMAND`
   **unset** — so `cfg.agentCommand` falls back to the built-in `"claude -p"` and the bare name
   *is* resolved through `PATH` — **fails**, and **`PATH_HIT` exists**. Without this assertion the
   shadow is never executed and its correctness is never observed.
4. **Rollback control.** With both stubs repointed at benign scripts that succeed,
   `propose-mapping` **succeeds**. This proves assertions 2 and 3 failed *because of the stubs* and
   not because of the harness, the fixture, or an unrelated error — the plan's §9 rule that a
   negative result is worthless without a positive control, applied to the controls themselves.

Covered set for the PATH shadow: `spawn`, `spawnSync`, `exec`, `execSync`, `execFile` and
`execFileSync` resolve a bare command name through `PATH`, so shadowing the name covers all six.

**`fork` does not, and an earlier draft claimed it did.** `fork` resolves a **module path** and
runs it under `process.execPath`; it never consults `PATH` for an executable. Reproduced against a
PATH-shadowed `claude`: `fork("claude")` exits **1** with the sentinel **absent**. No hole follows
— nothing here forks — but the sentence asserting the guard's completeness contained a false claim
about the runtime, which is the sort of thing that gets relied on later.

A spawn of an **absolute path** bypasses `PATH` and is deliberately out of the shadow's reach —
correct, because `cli.mjs:9`'s spawn of `process.execPath` is exactly that and must keep working.
It is also why the env arm needs its own sentinel rather than sharing the PATH arm's.

The surviving static assertion, which still holds and still has a real control: **the proposer
module is absent** from `scripts/import-runner.mjs`'s transitive graph and **present** in
`scripts/import-mapping-runner.mjs`'s. Absent-here / present-there discriminates; the two
assertions the first draft added did not.

**Scope note on the table above.** The 26/6/1 figures are for the **8-seed graph this design
declares**, not for the repo. `scripts/model/transitions.mjs` also spawns (`:62`,
`execFileSync("git", …)`) and is *not* in that graph — so the table is complete for what it
measures and must not be read as an inventory of every spawn site in blaze.

### 4.4 What the operator is shown, and what they are agreeing to

`blaze import propose-mapping` renders four blocks and then asks:

```
MAPPED — 8 of 12 source columns
  Issue key      → id
  Summary        → title
  Issue Type     → type          Story→story  Sub-task→subtask  Epic→feature
  Status         → status        To Do→defined  In Progress→in-progress  Done→done
  Priority       → priority      P1→high  P2→medium
  Story Points   → estimate      via hours-to-minutes
  Description    → description
  (constant)     → project       ACME

UNMAPPED — 4 source columns will be DISCARDED
  Sprint Health, Reporter, Watchers, Epic Link

REQUIRED AND UNFILLED — the import cannot run
  (none)

VALUES SEEN BUT NOT TRANSLATED — 1
  Status: "Blocked" (3 rows) — no blaze status maps to this

Write import-mappings/acme-jira-export.json? [y/N]
```

**The operator is agreeing to a file, not to a run.** `y` writes the JSON and exits. No ticket is
created, no id is allocated, nothing is staged. The import is a separate command, run later,
against a file they can read and diff first. That is what makes the acceptance meaningful — a
confirmation prompt that is immediately followed by 2,800 writes is a confirmation nobody reads.

Three things the render is careful about:

- **Unmapped columns are shown as `will be DISCARDED`**, in the affirmative. A column silently
  absent from a mapping table is the failure mode this whole layer exists to prevent.
- **`REQUIRED AND UNFILLED`** lists canonical columns nothing maps to. Non-empty means the proposal
  cannot be applied at all, and it says so at proposal time rather than at row 1 of the import.
- **`VALUES SEEN BUT NOT TRANSLATED`** is derived from the sample, not guessed. It is the block
  that catches the case where the mapping is structurally right and one status word is missing.
- **This render deliberately shows untranslated source values, and is the one exemption from
  §5.2's echo rule.** `Status: "Blocked" (3 rows)` is the entire point of the block — an unmapped
  status the operator cannot see is a mapping they cannot fix. The echo rule governs **refusal
  messages**, which go to stderr and get logged; this is an interactive display of the operator's
  own file, on screen, at their request. Different channel, different rule, stated here so the
  two are not later "reconciled" by silencing the block that makes the proposal reviewable.

### 4.5 Markdown, the secondary medium (BLZ-588)

`blaze import --format markdown <dir-or-glob>` parses each file with `parseTicket`
(`scripts/model/ticket.mjs:60`), turning it into the **same in-memory row shape** the CSV reader
produces, and then runs the identical planner, validator and writer. Frontmatter needs no mapping
layer — it is already the canonical vocabulary — so `propose-mapping` does not apply to it.

BLZ-588's "literally the same code path" criterion is met structurally: there is one
`planImport(rows, board, opts)` and two readers that produce `rows`. A test asserts the property
by adding a rule once and observing both front ends enforce it.

---

## 5. Failure modes, fail-closed behaviour, and exit codes

### 5.1 The exit codes

Aligned with the codes already in use: `0` clean, `1` a refusal or a hard finding
(`scripts/audit-runner.mjs:352`), `2` *could not look* (`scripts/audit-runner.mjs:117,133`, and
`blaze commit --status` exits 2 for a partially-read queue as of BLZ-531).

| Code | Meaning | Board state |
|---|---|---|
| **0** | Clean. A dry run that would succeed, or an `--apply` that did | unchanged, or fully imported — **for an in-process outcome.** Under signal death `cli.mjs:290` also yields 0 with the board partially written; see the limit below |
| **1** | **Data refused.** One or more rows fail validation | **unchanged** — nothing written |
| **2** | **Could not look.** The **input** could not be read as the format it claims. Only the input — an earlier draft widened this to the `source-ids` map and thereby violated the rule two rows down that each code exists because its remedy differs | unchanged |
| **3** | **Mapping incomplete.** A source column has no confirmed mapping, or the mapping's `source.sha256` does not match the file | unchanged |
| **4** | **The board changed and the run did not finish cleanly.** A ticket write failed part way, **or** a receipt or `source-ids` append failed after a ticket write, **or** every write landed and staging failed | **changed** — see §5.3 |
| **5** | **The run's own records are not in a state it may start from.** Four cases: the receipt cannot be opened for append; the `source-ids` map cannot be opened for append; the map has a torn line; or — **under `sourceIdColumn` only** — the mapping's latest receipt carries an `intent` with neither a `done` nor a `resolved` entry (§5.3 defines both, and `<name>`). Scoped that way because only the source-key lookup can be blind to a ticket that exists; an explicit-id import finds it on the board and compares. The run never starts | unchanged — nothing attempted |

Four separations, each because the remedy differs:

- `1` means *fix the data*; `3` means *confirm a mapping*. Collapsing them makes the message carry
  a distinction the code should.
- `4` is the **only** code the importer *itself* exits with when the board changed. A
  formula-injection cell is therefore a `1`, not a `4` — it is a refusal like any other, and
  nothing was written. The qualifier is load-bearing: a signal-killed run exits **0** through
  `cli.mjs:290` with the board changed, so "only" is true of what the runner returns and false of
  what the operator observes — the limit below, and finding it stated three times as an
  unqualified universal is what this sentence corrects.
- `5` is not folded into `2`. This table defines `2` as *"the input could not be read as the format
  it claims"*, and *"I could not open my own log"* is a different fact about a different file with
  a different remedy. An earlier draft overloaded `2` with both — and a later one created `5` for
  the receipt and then wrote a second pre-ticket record, the `source-ids` map (§4.2), under **no
  code at all**: its failure fell to an uncaught throw and exit 1, whose row says *"data refused"*.
  `5` covers every record the run must establish before it may write a ticket — **and every
  record it must find intact**. A torn map and an unresolved prior receipt are the same class as
  an unopenable one: the remedy is *repair the run's records*, which is neither *fix the data*
  (1) nor *fix the input file* (2) nor *confirm a mapping* (3). One code, one remedy.
- **The board-changed rule is a post-condition on the whole run, not a property of one call site.**
  Stated once, so it cannot be satisfied in one place and missed in another: **once any ticket has
  been written, no later failure may exit anything but 4** — and see the process-boundary limit
  below, which is where that promise genuinely stops. An earlier draft asserted `4` was the
  only board-changed code while routing staging through `commitOrQueue` *after* the writes — and
  `commitOrQueue` **throws**, at `scripts/commit-or-queue.mjs:18-21` on an op absent from
  `OP_LABEL` and at `:27` via `assertWritable`, so an uncaught throw exited 1. The repair caught
  the staging call and then **reintroduced the identical shape in the receipt** (§5.3, mistake 3),
  which appends per row during the writes and can fail on `ENOSPC`. Two instances of one bug in
  two consecutive sections is the evidence that the rule belongs here, as one invariant over the
  run, rather than as a fix applied per call.

**The post-condition holds only for in-process failures, and a signal defeats it.** This is a
limit, not a bug to be argued away, and an earlier draft's §5.1/§5.3 reasoned entirely about
throws inside the runner without ever reaching the process boundary.

`blaze import` is not the process that computes the exit code. `cli.mjs:9` dispatches it with
`spawnSync(process.execPath, …)` and `cli.mjs:290` is `process.exit(r.status ?? 0)`. A child killed
by a signal returns `status: null`, and `?? 0` maps that to **0**. Reproduced:

```
wrote 300 of 500 tickets
spawnSync -> status=null signal="SIGKILL"
cli.mjs:290 would exit with: 0
```

So an OOM-killed import — and the runner, not the 40-line parent, is the large-RSS process — exits
**0** with the board partially written. That is strictly worse than the exit-1 case the round-3
fix was written to eliminate: 1 at least says something went wrong.

Two things follow, and neither is optional:

1. **A test that SIGKILLs `blaze import --apply` mid-write and asserts BOTH the observed exit
   code AND the receipt's contents.** Pinning the exit code alone, which is what an earlier draft
   required, pins the wrong thing: the code is the part this design admits is uninformative, and
   the receipt is the part it promotes to sole evidence. A floor nobody tests is a claim.

   **The assertion is a superset, not equality, and an earlier draft got that wrong.** It said the
   unmatched-`intent` set *equals* the set of ids not on disk — but §5.5 already admits the
   unmatched set names rows whose reservation *may* be orphaned, which is a superset. The
   per-row sequence (§5.3) has a window between the ticket write and `done` in which the ticket
   is on disk and the `intent` is unmatched. Reproduced: `intent` appended, `BLZ-1.md` written,
   SIGKILL before `done` → `unmatched = ["BLZ-1"]`, `not-on-disk = []`, equal is **false**. A test
   asserting equality is flaky by kill placement. The assertion is therefore:

   - `unmatched ⊇ not-on-disk` — every unwritten row is named; the set is **complete**;
   - `|unmatched \ not-on-disk| ≤ 1` — at most the one row in flight; the set is **tight**.

   Both sets are keyed by **`seq`**, not by id: an `intent` killed before its `allocated` has
   `"id": null`, and a set keyed by id would silently drop it — which is the row most worth
   naming. `not-on-disk` is derived by mapping each `seq` to its id through `allocated` (or the
   `intent`'s own id on the explicit path) and then to the board; a `seq` with no id anywhere is
   *not on disk* by definition.

   Both halves are needed. The first alone is satisfied by a receipt that names everything; the
   second alone by one that names nothing.

   **For that assertion to be satisfiable, receipt appends must be synchronous and unbuffered.**
   A `createWriteStream` receipt loses its buffered `intent`/`done` lines under SIGKILL, making
   the unmatched set neither complete nor sound — and an earlier draft never said which primitive
   the appends use. They use `appendRegularFileSync` (`scripts/model/regular-file.mjs:135-143`):
   `openSync` with `O_APPEND`, `appendFileSync` on the descriptor, `closeSync`, and a refusal of
   any non-regular file. Each line is in the kernel's page cache before the call returns, which is
   what SIGKILL cannot take back. Its own header says *"a caller that is not best-effort would
   need it"* — this is that caller, and the `source-ids` map (§4.2) is the second.
2. **Either `cli.mjs:290` learns about signals** (`r.signal ? 128 + signum : (r.status ?? 0)`, or
   any explicit non-zero), **or this document states plainly that under signal death the exit code
   carries no information and the receipt's unmatched-`intent` set is the sole evidence.** This
   design takes the second as its floor and proposes the first as the fix, because changing
   `cli.mjs` affects **every** verb and is not this lane's call to make unilaterally — it is filed
   in §8.

The repo has already settled the general form of this. ADR-0035's consequences: *"A caller that
needs to know whether HEAD moved must read the stdout line or git, not the exit code."* The same
rule applies here — the exit code is a summary, and the receipt is the record.

**Exit 0 does not mean "committed".** On a `commitMode: "batch"` board `commitOrQueue` **queues**
rather than commits (`scripts/commit-or-queue.mjs:28-31`), so a fully successful import exits 0
with the files written, staged into a pending ledger, and **uncommitted until the next flush**.
That is correct and is how every other verb behaves — but it is named in the run's trailer rather
than left to be discovered, because the flush path it hands off to is the one BLZ-531 found a
data-loss defect in.

### 5.2 The named failure modes

| Failure | Behaviour | Exit |
|---|---|---|
| **An unmappable column** — a source column in neither `columns` nor `unmapped` | Refuse before reading any row. Name the column and both places it could be declared. Nothing is written | **3** |
| **A source header that has changed** since the mapping was confirmed (`sha256` mismatch) | Refuse. Name the columns added and removed. Do **not** re-map, do not fall back to name matching | **3** |
| **An unknown status value** — a cell not in `statusesFor(type)` after translation | Refuse the run. Name the row number, the column and the **set of legal values**. Per BLZ-587's criterion the message does **not** echo the cell — see the scoping rule below the table | **1** |
| **An unknown `type`, `priority` or `resolution`** | Same as above. A value outside the registry is a **refusal, never a coercion**. `blaze migrate`'s `mapPriority` silently defaults an unknown priority to `medium` (`scripts/migrate/map.mjs:29-32`); the CSV importer deliberately does not | **1** |
| **A duplicate id within one file** | Refuse. Name the id — shape-bounded, so echoed per the rule below the table — and every row number carrying it. Never "last row wins" — `duplicateIdErrors` (`scripts/model/index.mjs:398`) records that a silent last-wins collapse hid open work behind a closed ticket on a real board | **1** |
| **An id that already exists on the board** | Three cases, decided by comparison, not by flag: **identical** ⇒ **skip**, counted and named (this is what makes a re-run a no-op, per BLZ-587); **differs, no `--update`** ⇒ **refuse**, naming the id and the differing fields; **differs, with `--update`** ⇒ update, and the dry run lists it under `WOULD UPDATE` with a field-level diff. **"Identical" means all 31 canonical columns**, `status` and `description` included — a status-only difference is a difference, and comparing only the 28 frontmatter keys would skip it silently, since `status` is a directory rather than a field (§1.1) | **0** / **1** / **0** |
| **A row with an empty `id`** | **Refused by default.** `id` is required on import. The skip rule above is keyed on the id, so an id-less row has nothing to compare and would allocate a fresh id on every run: two `--apply` passes over the same file would produce two tickets, and after an exit-4 partial apply the duplication compounds. `--allocate-ids` accepts them; with a mapping declaring **`sourceIdColumn`** (§4.2) the skip is keyed on the source key instead and the no-op guarantee **holds**. Without one it is **explicitly forfeited**, and the dry run's trailer says a second run duplicates. Export always emits an id, so the §3 round trip is unaffected | **1** |
| **A dangling reference** — a `parent` or `links` target in neither the file nor the board | Refuse, naming every dangling reference and its source row. **Never a silent drop.** A forward reference *within* the file resolves: the planner reads the whole file, builds the id set, then validates — the file is a unit, not a stream | **1** |
| **A malformed row mid-file — wrong cell count, or an unterminated quote** | The **file** is not the format it claims, so this is *could not look*, not *bad data*. Refuse at parse time, naming the line number and the byte offset. Nothing is validated and nothing is written | **2** |
| **A cell beginning with `=` or `@`** | Refuse, naming the row and column (not the contents). §2.5. Measured safe: **0** of the live board's values begin with either (§1.6) | **1** |
| **A link entry with a `type` and no `target`** — on **export** | Refuse the export, naming the ticket. An exporter that dropped it would launder corruption into a clean-looking CSV, and per §3.1 the X-vs-Y diff cannot see that. **Zero instances exist on the live board** (§1.6 fact 7, retracted), so this guard ships unexercised by real data and is driven by a constructed fixture row instead | **1** |
| **A partially applied import** | See §5.3 | **4** |
| **An `estimate` that is not a multiple of 5** | Refuse, naming the row and the nearest legal values. Not rounded — rounding is `blaze new`'s input policy and it invents (`scripts/model/time.mjs:19-21`); an import mirrors | **1** |
| **A `sprint` not in `sprints.json`** | Refuse, naming the **column and the registered sprint ids** — not the offending value, which has no shape constraint (echo rule below the table). `validateSprintFields` supplies the check | **1** |
| **An off-taxonomy `label` or `component`** | Refuse, naming the column and the declared set and pointing at the same `projects/<KEY>/project.json`. **Not** `validateTaxonomy`'s own message — it interpolates the cell (`scripts/model/taxonomy.mjs:14`), which is right for a CLI and wrong for an import (echo rule below the table) | **1** |
| **A torn line in the `source-ids` map** | Refuse before any write, naming the map and the line number. Read-only — the importer does not park; the inspection path does (§4.2). The receipt is the recovery source | **5** |
| **An unresolved prior partial apply** — under `sourceIdColumn`, the mapping's latest receipt has an `intent` with neither a `done` nor a `resolved` (§5.3) | Refuse before any write, naming the receipt and every unresolved row. A re-import that proceeded would recreate any row whose ticket landed but whose pair did not (§4.2 test 2) | **5** |
| **An unreadable input path** — missing, a directory, a FIFO, a socket | Refuse via `readRegularFileSync` (`scripts/model/regular-file.mjs`), per ADR-0031. Never opened blind: a FIFO with no writer blocks forever (`scripts/model/index.mjs:52-70`) | **2** |

**The no-echo rule is scoped, because stated as a blanket principle it contradicts this very
table.** An earlier draft declared that a refusal never echoes the offending cell, and then
specified four messages that do: the duplicate-id row names the id, the dangling-reference row
names the reference, the sprint row names the sprint id, and the off-taxonomy row uses
`validateTaxonomy`'s own message, which interpolates the cell at
`scripts/model/taxonomy.mjs:14`. §4.4's proposal render prints `Status: "Blocked" (3 rows)` too.

**That scoping was itself wrong, and produced three answers for one cell.** It listed `status`
among the closed spaces that ARE echoed while the table row above says the message does NOT echo
it, and §4.4 renders the value outright. It also split on the wrong axis: "closed vocabulary" is a
**membership** property, and the value in a refusal is by definition the one that **failed**
membership — so "it came from a vocabulary" is precisely what is not known about it. `type`,
`priority`, `resolution` and `estimate` satisfied the stated principle and appeared in neither
list.

**The axis that works is SHAPE, not membership**, and it matches BLZ-587's own wording — *"does
not echo the offending cell's contents **where the cell may carry pasted data**"*:

> **A value is echoed iff it satisfies a shape constraint that bounds its character set and
> length — whether or not it satisfies membership.**

A value that parsed as `<KEY>-<N>` cannot be a pasted paragraph, whatever else is wrong with it. A
value that merely failed to be one of thirteen statuses can be anything at all.

**The test is on the VALUE at hand, not on the column it came from**, and a draft of this table
got that wrong in the same way the membership version did. It answered per **field** — `id` yes,
`estimate` yes, the six dates yes — while the rule and its justification are conditional on the
value *passing* the shape (*"a value that parsed as `<KEY>-<N>` cannot be a pasted paragraph"*).
But §2.3 defines a refusal for exactly the **failing** case: a cell refused *because* it is not an
id has by definition not satisfied the shape. Table and rule then contradict, and an implementer
following the table echoes a pasted paragraph out of the `id` column — precisely the harm BLZ-587
names. The `status` fix, reintroduced one axis over.

So every shaped field splits by **which check failed**:

| Field | Failure | Echoed |
|---|---|---|
| `id`, `parent`, link `target` | **shape** — not `<KEY>-<N>` | **no** |
| `id`, `parent`, link `target` | **membership** — well-formed, but duplicate / dangling / unknown | **yes** |
| `estimate` | **shape** — not an integer | **no** |
| `estimate` | **membership** — an integer, but not a multiple of 5 | **yes** |
| `created`, `updated`, `start`, `due`, `not_before`, `deadline` | **shape** — not `YYYY-MM-DD` | **no** |
| `created`, `updated`, `start`, `due`, `not_before`, `deadline` | **membership** — well-formed but rejected | **yes** |
| `status`, `type`, `priority`, `resolution`, link `type` | any — no shape constraint exists | **no** |
| `label`, `component`, `sprint` | any — no shape constraint exists | **no** |
| `title`, `description`, `worklog.note`, any unmapped column | any — no shape constraint exists | **no** |

One sentence covers the whole table, and it is the implementable form of the rule: **echo the value
only after it has passed a shape check.** A shape failure reports the column, the row and the
expected grammar; nothing of the cell.

Where a value is not echoed the message gives the **row, the column, and the legal set** — which
is what the operator acts on. "Row 412's `status` is not one of `defined`, `in-progress`,
`in-review`, `done`" is actionable without reproducing the cell.

Two consequences this forces, rather than leaving implicit:

- **The importer does not reuse `validateTaxonomy`'s message.** It interpolates the cell at
  `scripts/model/taxonomy.mjs:14` (`off-taxonomy label: '<value>'`), which is right for a CLI
  where the operator typed the value and wrong for an import where it came from someone else's
  export. The import path reports the column and the declared set and points at the same
  `project.json`; `blaze new`/`blaze edit` keep the existing message unchanged.
- **§4.4's proposal render is deliberately exempt, and says so there.** It is an interactive
  display of the operator's own file, on screen, at their request, and showing the untranslated
  values is its entire purpose — an unmapped status the operator cannot see is a mapping they
  cannot fix. BLZ-566's finding is about **error messages**, which are emitted to stderr and get
  logged. Different channel, different rule.

### 5.3 Atomicity, and the part of it that is not real

**Validation is all-or-nothing and that guarantee is total.** The planner reads the entire file,
builds the full plan, and validates every row against the board and against the other rows. One
bad row means **zero** writes. BLZ-587's *"500 good rows and 3 bad ones"* case exits 1 with the 3
named and 497 untouched.

**The write is not atomic on a filesystem, and this design does not claim it is.** A write can
still fail at `ENOSPC` or `EACCES` after row 300 of 500. When it does:

- the run **stops at the first failure** — it does not press on;
- it prints every id **written** and every id **not written**, as two explicit lists;
- it exits **4** — the one code the importer itself returns for a changed board; a signal death
  bypasses this list entirely (§5.1);
- it does **not** roll back. A rollback is a second write path with its own failure mode and its
  own blast radius, and this repo has already rejected exactly that shape once — ADR-0032 records
  a recovery sweep that *"named files blaze never wrote"*.

**The receipt, and why it is written before the write rather than after.** A partially-applied
import has the same shape as the defect BLZ-531 fixed (`13f661c`): `blaze commit` destroyed an
unparseable ledger line when it cleared the queue holding it — the line was skipped by the parser,
named in no report, and then erased, so *"nothing anywhere could re-derive it."* The fix parks the
raw bytes in a `<session>.corrupt` sidecar **before** clearing, fails closed per queue (a queue
whose sidecar write threw is **kept**, not cleared), and makes a quarantine failure its own exit
code — because a record that exists only in a stream nobody kept is not a record.

Applied here: a printed two-column list of written and unwritten ids is exactly that stream. So
`blaze import --apply` writes a **receipt**. Two earlier mistakes in this section are corrected
rather than quietly fixed, because both were the kind that survive review by sounding careful.

**Mistake 1 — an intent log was labelled an outcome log.** The first draft appended one entry per
row *before* that row's write and called it the outcome. A record written before the event cannot
be an outcome: on a crash it asserts a write that never happened, over-reporting by exactly one
row, with no way for the operator to tell which. The receipt is therefore an append-only JSONL
log with **two or three entries per row** — three when the row's id was allocated, two when it was supplied — and **the per-row sequence is stated here once** —
§4.2, §5.5 and the ADR refer to it rather than restating it, because three restatements is how
its ordering drifted in earlier drafts:

```
1. intent     → receipt   {"seq":41,"phase":"intent","row":41,"source":"ACME-123","id":null,"op":"create"}   id is the row's own when supplied, null when to be allocated
2. allocate   → .ids/     allocateId + writeClaim, only when the row carries no id (§5.5)
3. allocated  → receipt   {"seq":41,"phase":"allocated","id":"BLZ-620"}   only when step 2 ran; a supplied id is already in the intent
4. write      → board     writePort.write at the declared status
5. pair       → map       {"source":"ACME-123","id":"BLZ-620","seq":41}   only under sourceIdColumn
6. done       → receipt   {"seq":41,"phase":"done","id":"BLZ-620","file":"projects/BLZ/done/BLZ-620-….md","claim":true}
```

Every receipt and map line goes through `appendRegularFileSync` (§5.1). Three facts the ordering
buys, each of which an earlier draft lacked:

- **`intent` carries `source`**, so the receipt can name a row by the key the map is keyed on.
  Earlier entries carried `row`, `id`, `file`, `claim` and no source key, which made "the receipt
  is the recovery source" a sentence rather than a property.
- **`allocated` records the id the moment it exists.** The `intent` is written *before*
  allocation (§5.5 — so an orphaned reservation is findable) and therefore cannot carry the id.
  Without this phase, a row that reached step 4 but not step 6 had a ticket on disk that nothing
  could match back to its `source`.
- **`done` implies pair, and pair implies ticket** (steps 4 → 5 → 6). An `intent` with no `done`
  is the set to inspect. Within it there are **three** states, not two — an earlier draft
  collapsed the middle one into the last, which is precisely the state F1 was fixed for:

  | Ticket on disk | Pair in map | Meaning | Repair |
  |---|---|---|---|
  | no | — | steps 4–6 did not land: an **orphan reservation** (§5.5) | none; the row is re-created on re-import |
  | **yes** | **no** | step 4 landed, step 5 did not — the ticket-without-pair window | **append the pair**, `source` from the `intent`, `id` from the `allocated` (or from the `intent` on the explicit-id path) |
  | yes | yes | steps 4–5 landed, only step 6 is missing | nothing to repair |

  The middle row is the one a re-import would duplicate, and the one an inspection path that
  checked only "is the ticket on disk" would have called "only `done` is missing" and left
  alone. All three are decidable from the receipt plus a `stat` and a map lookup — readable,
  not inferred.

**What "resolved" means, so the refusal can be lifted.** The inspection path **appends a
`resolved` entry** to the receipt for each row it examines —
`{"seq":41,"phase":"resolved","state":"pair-appended"}` with `state` one of `orphan-reservation`,
`pair-appended`, `nothing-to-repair` — the three states above. The receipt stays append-only;
nothing is edited. The §5.1 exit-5 check then reads: *any `intent` in the mapping's latest
receipt with neither a `done` nor a `resolved`.* An earlier draft defined the refusal with no
lift condition at all, so after the operator repaired the map the receipt still carried its
unmatched `intent`, the check still fired, and the re-import test 2 requires could never run.

`resolved` lifts the **refusal** and nothing else. It does not make the receipt prunable: the
prune (item 2) requires every `intent` to have a `done`, and a partial-apply receipt is evidence
that is kept regardless of age.

**`<name>` in the receipt path is the mapping's `name` field** (`import-mappings/<name>.json`,
§4.2), or `canonical` for a canonical-header import with no mapping. "The mapping's latest
receipt" is therefore computable: the lexically last `import-receipts/<ISO>-<name>.jsonl` with
that name — ISO-8601 sorts by time. **The check runs before the current run opens its own
receipt** — it is part of the pre-write phase, alongside the prune — because if it ran after,
"latest" would be the empty file the run had just created and the check would never fire.

**Mistake 2 — the sole record of a board mutation was placed where the repo says to delete it.**
`.blaze/` is gitignored in both this repo and `blaze-pm`, and `scripts/reindex.mjs:1-4` states
that what lives there is *"derived, regenerable caches — safe to delete"*. A partial-apply record
is neither derived nor regenerable, and git would never keep it — strictly weaker than the
BLZ-531 precedent invoked. The receipt therefore lands at **`import-receipts/<ISO>-<name>.jsonl`
at the data root**, beside `import-mappings/` and for the same reason: it is a record, not a
cache.

**Mistake 3 — the fix for the staging bug was reintroduced one section later.** The draft guarded
only the *open* (*"if the receipt cannot be opened for append, the import does not start"*), while
appending per row **during** the writes. An append that fails mid-run — `ENOSPC`, the very failure
§5.3 names — throws after writes have landed, and an uncaught throw exits **1**, which §5.1
declares means *"unchanged — nothing written"*. Identical shape to the `commitOrQueue` defect
fixed four paragraphs earlier, in the code written to record it.

So **every receipt append — and every `source-ids` append, which in the sequence above follows the ticket write — sits
inside the same `try` that converts a post-write failure to exit 4.** There is exactly one rule,
applied to ticket writes, to staging, to the receipt and to the map alike: *once any ticket has
been written, no later failure may exit anything but 4.*

**A failure to establish the receipt before starting gets its own code, 5** — not the overloaded
2. §5.1 defines 2 as *"the input could not be read as the format it claims"*, and *"I could not
open my own log"* is a different fact with a different remedy. Board unchanged; nothing attempted.

**Three claims about the receipt that were wrong or missing:**

1. **"Staged with the tickets, so it reaches upstream in the same commit" is false on both paths
   that matter.** On exit 4, staging either failed or never ran. On a clean run against a
   `commitMode: "batch"` board, §5.1 already says `commitOrQueue` *queues* rather than commits.
   The honest claim is narrower: **the receipt is on disk before the writes it describes**, which
   is what an operator needs; it is staged only if staging runs and succeeds, and the run's
   trailer says which happened.
2. **Retention.** One file per `--apply` run, committed, accumulates without bound. The rule:
   `blaze import --apply` **prunes receipts older than 90 days in which every `intent` has a
   matching `done`** — a clean run's record is disposable once it is history. A receipt with **any
   unmatched `intent` is never pruned**, at any age, because that is the evidence of a partial
   apply and it is the whole reason the file exists.

   **The prune runs BEFORE any write, is best-effort, and never affects the exit code.** Its
   placement is the whole of its specification, because both other placements are wrong and an
   earlier draft left it unstated. *Inside* the exit-4 guard, an `EACCES` unlinking a 91-day-old
   file after 500 tickets landed would exit 4 and tell the operator the board is partially
   applied when it is not. *After* the writes but outside the guard, the same `EACCES` throws and
   exits 1 — violating the post-condition on the very run that fix protects, which is §5.3's own
   "mistake 3" a third time. Before any write, a failed unlink is a warning on stderr and nothing
   else: nothing has been written, so there is no post-condition to violate, and a receipt that
   outlives its retention window costs disk rather than correctness.

   **"Before any write" has to include the prune's own reading, and as first written it did
   not.** To decide eligibility the prune must *read* each receipt — and item 3 below says the
   receipt reader **writes** `<receipt>.corrupt` on a torn line. So the phase named "before any
   write" wrote, and a swallowed quarantine failure would have contradicted the BLZ-531 precedent
   this section invokes. Worse, a receipt whose *only* evidence of a partial apply is its torn last
   `intent` line parsed as "every intent matched" and was prune-eligible — the prune would have
   deleted exactly the receipt it exists to keep. Two rules close both:

   - **The prune's reader is read-only and never quarantines.** It parses; it does not park. A
     receipt with **any** line that will not parse is treated as **not prune-eligible** — kept,
     conservatively, because *unreadable* and *clean* are not the same fact and a prune that
     cannot tell them apart must keep. Quarantine happens only when an operator inspects a
     receipt through the explicit read path, which is a write they asked for.
   - **A torn `intent` is an unmatched `intent`.** Eligibility requires every `intent` to have a
     `done` *and* the file to have parsed completely. Both, or the receipt stays.

   `source-ids/` (§4.2) is **not** prune-eligible at all. It is not a run artifact.
3. **A torn last line.** A hard crash mid-append leaves a partial JSONL line — precisely BLZ-531's
   unparseable-ledger-line shape, invoked here as precedent without its rule being applied. So the
   receipt reader takes that rule too: a line that will not parse is **parked, not skipped** — the
   raw bytes appended to `<receipt>.corrupt` — and the reader reports the dropped count rather
   than presenting a partial read as a complete one (ADR-0030).

   **Parking is a write, so only the explicit inspection path does it.** Every reader that runs
   *before a ticket write* — the prune (item 2) and the `source-ids` lookup (§4.2) — is read-only:
   it reports a torn line and acts conservatively (keep the receipt; refuse the import), and it
   never parks. A park that failed in the pre-write phase would fall under no exit code, which is
   the defect this section has now fixed twice and does not intend to fix a third time. `scripts/pending-ledger.mjs`'s
   `parseRecords`/`quarantineDropped` is the shape to follow, including its buffer-in/bytes-out
   discipline: `toString("utf8")` maps an incomplete trailing multibyte sequence to U+FFFD, which
   re-encodes as different bytes, and a torn line is exactly where that happens.

**Under `BLAZE_WRITE_PORT=db` the run is NOT one transaction, and an earlier draft claimed it
was.** Checked against source rather than assumed: `scripts/model/write-port.mjs` contains no
`BEGIN`, `COMMIT` or `ROLLBACK`; `persist` (`:204-300`) runs bare `exec.run` statements; and the
`exec` it is handed exposes only `{ run, all }` and the port itself only `{ name, exists, write, move, read }` (`:77-79`, `:298`) — no transaction on either. Each statement autocommits, so under `db` a row
is durable the moment its `persist` returns — **per-row durable, exactly like the filesystem**,
and no more all-or-nothing than it. The claim was false about existing code, and it would have
been wrong to make true: a per-row `done` written inside one uncommitted transaction is mistake 1
under `db` — an outcome asserted for a write a later rollback undoes — and "the two ports produce
the same evidence" would then have been false too.

So the honest statement is the simpler one: **neither port is all-or-nothing; both are per-row
durable at `done`; the receipt means the same thing on both.** The dry-run trailer names the
port in force, and nothing about the guarantee changes with it. If a transactional `db` import is
ever wanted, `done` must move to after the commit — one entry per run, not per row — and that is
a different receipt shape, not this one with a `BEGIN` in front.

### 5.4 Staging

The importer stages **exactly the files it wrote**, through `commitOrQueue`
(`scripts/commit-or-queue.mjs:11`), which is *"scoped to exactly the touched files (never `git add
-A`)"*.

**Correction to an earlier draft, which inverted its own citation.** That draft said `blaze
migrate --live` "runs `git add -A`" and quoted the comment above the call as the cost. It is the
opposite: `scripts/migrate-runner.mjs:73` is
`spawnSync("git", ["-C", dataRoot, "add", "-A", "--", projectsDir], …)` — **pathspec-scoped** —
and the comment at `:67-72` is the record of the **BLZ-139 fix**, not of a live defect. It says
the bare `add -A` was the bug and that the scoped `-A` is *"kept (scoped) because runLive's
removeExisting() deletes superseded ticket files, and those deletions must be staged too."*
Quoting the first half of a comment describing a fixed defect as though it described current
behaviour is the same error class this document elsewhere warns about.

**This falsifies a claim in BLZ-587 itself**, whose Context says `blaze migrate`'s `--live` path
*"is the one blaze command that runs `git add -A` over the data repo rather than staging only what
it wrote."* BLZ-139 predates BLZ-587 and had already scoped it. The AC *"staging is file-scoped —
the importer never runs `git add -A`"* still stands and is met; only its stated justification is
stale. Recorded in §8.

The importer's own staging is narrower still than migrate's, and for a reason that is not merely
stylistic: it creates and updates but never deletes (§7), so it has no deletion to stage and can
name each file explicitly rather than relying on `-A` over a directory.

### 5.5 Id allocation, claims, and the residue neither guarantees away

**Every created ticket gets a claim, on both paths.** An earlier draft wrote claims only under
`--allocate-ids`, which left the defect uncovered on the path the `id`-required fix had just made
the default. The mechanism:

- `writeClaim` has **exactly one caller repo-wide** — `scripts/new.mjs:123` — and neither write
  port touches `scripts/model/claims.mjs`. So nothing writes a claim unless the importer does it
  itself.
- `ensureCutover` is likewise called from exactly one place — `scripts/model/ids.mjs:72`, **inside
  `allocateId`** — so a project that has ever allocated carries a cutover marker.
- `missingClaimErrors` (`scripts/model/index.mjs:353-377`) then reports **an error, not a
  warning**, for every id above that marker with no claim.

Put together: importing rows with **explicit ids** into any project that has ever allocated would
error on every imported id above the cutover — the exact defect §8 item 1 exists for, on the
default path. A project that has *never* allocated has no marker, `readCutover` returns `null`, and
the check stays silent (`:369-370`) — so the failure is invisible on a fresh fixture board and
appears on the operator's real board. That is the worst possible distribution, and it is why the
claim write is unconditional rather than tied to a flag.

An id-less row is refused unless `--allocate-ids` is given (§5.2). Under that flag the id comes
from `allocateId` (`scripts/model/ids.mjs:66-86`) — the `O_EXCL` reservation of ADR-0005 — and the
claim is written exactly as on the explicit path.

**Dropped from an earlier draft: "the id's number is checked against the project's allocation
floor so an import cannot hand out an id a later `blaze new` would reissue."** That guarded a
non-problem. `allocateId` floors on `maxId(projectsDir, key)` (`:74`), which **reads the disk**
(`:25-34`), so an imported ticket advances the floor merely by existing. No separate check is
needed and specifying one would have implied a risk that is not there.

**An earlier draft claimed "both land, or neither does, exactly as `applyNew` does". That is
false, and `applyNew` says so itself.** The real order is `allocateId` (`scripts/new.mjs:111`) →
`writePort.exists` → `writePort.write` (`:118`) → `writeClaim` (`:123`) — three separable steps —
and the comment at `scripts/new.mjs:31-33` states the consequence outright: *"Allocation is an
irreversible side effect (an O_EXCL reservation that survives a failed create)."*

So the honest position, rather than a guarantee that does not exist:

- An exit-4 partial apply **leaves orphan reservations** — numbers reserved under
  `<common>/blaze/ids/<KEY>/` with no ticket behind them.
- **They are harmless but not invisible.** `allocateId` takes the max across disk, claims,
  reservations and the remote (`:74`), so an orphan only advances the floor; it can never cause a
  reissue. What it costs is a gap in the id sequence, which on this board is meaningful — a gap
  is normally evidence a ticket was deleted.
- **The receipt is what makes them findable, and the `allocated` phase is what makes them
  decidable.** An `intent` with no `done` (§5.3) names the rows whose reservation *may* be
  orphaned — a superset, since the ticket may have landed before the kill. Within that set, an
  `allocated` entry gives the number; the inspection path then applies §5.3's **three-state**
  rule — ticket absent is an orphan reservation; ticket present with no pair needs the pair
  appended; ticket and pair present needs nothing. An earlier version of this sentence said
  "ticket present means only the `done` is missing", which skipped the middle state and would
  have left the duplicate-on-re-import window open from this section while §5.3 closed it. The `intent` is written *before* allocation so that a crash between reservation and
  record still leaves the row named; the `allocated` is written *immediately after* so that the
  number is never known to `.ids/` and unknown to the receipt.

---

## 6. Where the code goes

**None of these files exists at `13f661c`.** This is the inventory of what the build adds, and
where, so that the coverage gate applies to the right half of it.

| File | What | Coverage |
|---|---|---|
| `scripts/model/csv.mjs` | RFC 4180 reader and canonical writer. Pure, zero-dependency | gated |
| `scripts/model/csv-schema.mjs` | The 31 columns, their types, the version constant, per-column validators | gated |
| `scripts/model/import-plan.mjs` | `planImport(rows, board, opts)` → the create/update/skip/refuse plan. Pure | gated |
| `scripts/model/import-apply.mjs` | Walks a plan through the injected write port. No `node:fs` | gated |
| `scripts/model/export-rows.mjs` | Corpus → canonical rows, via the read seam | gated |
| `scripts/model/import-mapping.mjs` | Mapping file load, validate, apply. **Deterministic, no model** | gated |
| `scripts/model/import-mapping-propose.mjs` | Will be the **only** module that spawns `agentCommand` other than the groomer, which reads it today at `loops/groomer.mjs:547` | gated |
| `scripts/import-runner.mjs` | CLI for `blaze import`. Argument parsing and printing only | excluded |
| `scripts/import-mapping-runner.mjs` | CLI for `blaze import propose-mapping` | excluded |
| `scripts/export-runner.mjs` | CLI for `blaze export` | excluded |

Logic lives under `scripts/model/` because `.c8rc.json` excludes `scripts/*-runner.mjs` from the
coverage gate (statements 91, branches 77, functions 93, lines 91). A decision made in a runner is
a decision nothing measures.

**What this design adds to the data root** — four artifacts, in one place so the distinction
between them is not spread across §4.2, §5.3 and §5.5. An earlier version of this table said
three and lagged the sections it summarised on two counts; a summary that lags is worse than no
summary, because it is the part a reader trusts.

| Path | What | Committed | Prunable |
|---|---|---|---|
| `import-mappings/<name>.json` | the confirmed column mapping (§4.2) | yes | no |
| `source-ids/<mapping>.jsonl` | source key → blaze id, appended per row **between the ticket write and `done`** (§5.3 step 5) | yes | **never** |
| `import-receipts/<ISO>-<name>.jsonl` | one run's intent / allocated / done record, plus `resolved` entries the inspection path appends (§5.3); `<name>` is the mapping's `name` or `canonical` | yes | after 90 days, **only** if every `intent` has a `done` **and** the file parsed completely — a `resolved` lifts the exit-5 refusal but never makes a receipt prunable |
| `<receipt>.corrupt`, `<map>.corrupt` | raw bytes of a torn line, parked by the **inspection path only** (§5.3 item 3; §4.2) | yes | no — it is evidence |

None of them is under `.blaze/`, which holds regenerable caches `scripts/reindex.mjs:1-4` calls
safe to delete. All four are records or source; none is derivable from the corpus.

Two new entries in `SUBCOMMANDS` (`scripts/cli.mjs:27-64`), which is the only dispatch table and
therefore also where help, the `BLAZE_READONLY` gate and the description come from:

- `import` — `mutates: true`, described as dry run unless `--apply`, following `reconcile`
  (`scripts/cli.mjs:36`);
- `export` — `mutates: false`.

`propose-mapping` is a **subcommand of `import`**, not a top-level verb, so it inherits the
`mutates: true` gate — it does write a file.

---

## 7. Explicitly out of scope

- **Any tracker-specific adapter.** No Jira/Linear/Asana knowledge is added. `blaze migrate`'s
  Jira tables (`scripts/migrate/map.mjs`) stay where they are and are not consumed by this.
- **`.xlsx` import or export.** The zero-dependency writer proven in
  `docs/superpowers/specs/2026-08-24-hierarchy-reporting-and-excel-export-design.md` §1 is that
  spec's, and its `GET /p/<KEY>/v/<slug>.csv` view export is a *report* of a view's rows — a
  different artefact from this corpus interchange schema, and neither replaces the other.
- **History, comments, attachments, and the `ticket_event` log.** A CSV row is a ticket's current
  state. Q4 already settled that history stays in the archived `blaze-pm` repository in
  perpetuity, so no history-migration format is needed.
- **Non-ticket board state:** `sprints.json`, `projects/<KEY>/project.json`,
  `blaze.config.json`, `.blaze/` derived state, the `.ids/` claim ledger as an *importable*
  artefact (claims are **derived** on import, §5.5), and identity/users.
- **Deletion.** Import creates, updates and skips. A row present on the board and absent from the
  file is **not** deleted and is not reported as a difference. A destructive sync mode is a
  separate decision on a separate ticket.
- **Cross-project id rewriting.** Import does not renumber. If two boards' `BLZ-1`s collide, that
  is a refusal, not a silent remap.
- **Concurrent import.** One import at a time; it takes the same commit lock the other verbs use.
- **Streaming.** The file is read whole. Forward references and duplicate detection both need the
  full id set before any row is judged, and the live corpus is ~2,850 tickets — small enough that
  streaming buys nothing and costs the file-as-a-unit guarantee.
- **Identity for a CSV with no identity column at all.** §4.2's `sourceIdColumn` closes the case
  that matters — re-importing the same foreign export is idempotent by **source** key even when
  blaze allocated the ids — so the forfeit is now confined to a genuinely anonymous spreadsheet:
  no blaze `id`, no source key, nothing stable to match a row against across two runs. There is
  no correct answer there without inventing one (content hashing makes an edited title a new
  ticket), so `--allocate-ids` on such a file says in its dry-run trailer that a second run
  duplicates, and that is the end of it. Out of scope, and stated rather than papered over.
- **Resolving the two link vocabularies** (§1.4) or correcting `docs/guide/schema.md` (§1.3).
  Both are named as gaps in §8.
- **Rollback of a partial apply.** §5.3 records why: a rollback is a second write path with its
  own failure mode, and ADR-0032 already rejected that shape once. The receipt makes the residue
  findable; undoing it is a manual operation.

---

## 8. Where this design and the existing tickets disagree

One thing in BLZ-587 **is** contradicted — item 7 below — and six things the three tickets do not
cover, one of which (item 6) is an engine-wide defect this design merely ran into.

1. **Claims — on every created row, not merely every allocated one.** BLZ-587's acceptance
   criteria never mention the `.ids/` claim ledger. An importer that satisfies every criterion as
   written produces a board that fails `blaze audit` on **every created ticket whose id sits above
   the project's cutover marker** (`scripts/model/index.mjs:353-377`), whether the id was
   allocated or supplied in the CSV — because `writeClaim`'s only caller is `scripts/new.mjs:123`
   and neither write port writes one. An earlier draft scoped this to "every allocated row", which
   understated it: after `id` became required (§5.2) the *default* path is the explicit one, and
   that is the path the narrower rule left uncovered. §5.5 closes it unconditionally; it needs to
   be a criterion, not a footnote.
2. **`status` is not a field.** BLZ-587 treats the schema as a column list and never says how a
   ticket reaches a non-initial status. `applyNew` forces `initialStatus(type)`
   (`scripts/new.mjs:30`) and `applyMove` enforces transitions, so the naive composition
   fabricates up to three transitions per imported row. ADR-0037 §1 settles it — write at the
   declared status through the port — but nothing in the tickets said so.
3. **The two link vocabularies, and the dependency they create.** BLZ-587 says *"`parent`,
   `Blocks`, `Implements` and friends"*, which are `LINK_TYPES` values, while the v4 meta-model
   declares a different six (§1.4). Beyond naming the split, §2.4 records a **live dependency**
   nobody has written down: this design's `fs`/`db` link parity holds only while `ticket_link` is
   derived from frontmatter. The day BLZ-360 §5.5 lands a real `Precedes` writer, the CSV link
   grammar and gate 1 both need revisiting. That belongs on the `Precedes`-writer ticket as a
   blocked-by, not in this document alone.
4. **`start`/`due` are scheduler outputs.** No ticket says whether they are exported. §2.7 says
   yes, and gives the two measured reasons.
5. **`docs/guide/schema.md` does not merely omit `verified` — it affirmatively denies it.**
   `:221-225` states that the `approved`/`verified` gates on `requirement` and `superseded` on
   `architecture` are *"designed but not shipped in the documented configuration"*, while
   `scripts/model/workflows.mjs:44` ships `verified` as a declared status and `:46-52` gives it
   transitions and a resolution. The doc contradicts running code rather than lagging it, so this
   is not the "one-line fix" an earlier draft called it — the paragraph has to be rewritten and
   the claim about `superseded` re-checked independently.
6. **`cli.mjs:290` maps a signal death to exit 0, for every verb — not just this one.**
   `process.exit(r.status ?? 0)` turns a `spawnSync` `status: null` (the shape a signal-killed
   child returns) into a clean success. Reproduced: an OOM-killed import that wrote 300 of 500
   tickets exits **0**. This is not an import defect and its fix is not this lane's to land —
   `cli.mjs` dispatches all 21 subcommands and a change there affects every one — but it caps what
   §5.1's post-condition can promise, so it must be a ticket rather than a paragraph. The fix is
   one line (`r.signal ? 128 + signum : (r.status ?? 0)`, or any explicit non-zero); the test is a
   SIGKILL mid-verb asserting the observed code. Until it lands, the receipt's unmatched-`intent`
   set is the only evidence a signal-killed run leaves, exactly as ADR-0035 already rules for
   `blaze commit`: *"a caller that needs to know whether HEAD moved must read the stdout line or
   git, not the exit code."*
7. **BLZ-587's Context is stale about `git add -A`, and this design does not repeat it.** The
   ticket says `blaze migrate --live` *"is the one blaze command that runs `git add -A` over the
   data repo rather than staging only what it wrote."* BLZ-139 had already scoped that call to a
   pathspec (`scripts/migrate-runner.mjs:73`), and the comment above it is the record of that fix
   (§5.4). The AC — *"staging is file-scoped — the importer never runs `git add -A`"* — still
   stands and is met; only the justification is out of date. Worth correcting on the ticket so the
   next reader does not go looking for a defect that was fixed.

One place the design is **stricter** than a ticket: BLZ-587 asks that an enum outside the registry
be refused; this design also refuses a *silent coercion* of `priority`, which `blaze migrate`
performs today (`scripts/migrate/map.mjs:29-32`). That is a deliberate divergence from the
existing import surface, not from the ticket.

One place the design is **weaker** than an earlier draft of itself claimed, and the ticket never
required: `--allocate-ids` forfeits BLZ-587's *"a re-run of the same file is a no-op rather than a
duplicate"*. The default path (`id` required) satisfies the criterion in full; the flag is an
explicit, named opt-out — and §4.2's `sourceIdColumn` narrows it further: with a mapping that
declares the source's own identity column the guarantee **holds** even for allocated ids, so the
forfeit now covers only a CSV with no identity column of any kind. Naming it beats an importer that
quietly fails the criterion for id-less
rows, which is what the first draft specified.

---

## Ticket breakdown

Eleven items. Dependency order is top to bottom within a phase; items in the same phase are
independent of each other. **These are not created on the board** — this is the list to create
from.

### Phase A — the format (no board writes anywhere)

| # | Item | Scope | Ticket | Depends on |
|---|---|---|---|---|
| A1 | **RFC 4180 reader/writer** (`scripts/model/csv.mjs`) | Parse and emit CSV with the §2.1 quoting rules; property tests over comma/quote/newline/CRLF/empty | **BLZ-587** | — |
| A2 | **The canonical schema module** (`scripts/model/csv-schema.mjs`) | The 31 columns, per-column type validators, the multi-valued encodings of §2.4, `schema_version` | **BLZ-587** | A1 |
| A3 | **Export** (`scripts/model/export-rows.mjs` + `blaze export --format csv`) | Corpus → canonical rows through the read seam; canonical row and column order; the unknown-key refusal of §2.8 | **BLZ-589** | A2 |

### Phase B — the deterministic import

| # | Item | Scope | Ticket | Depends on |
|---|---|---|---|---|
| B1 | **The plan** (`scripts/model/import-plan.mjs`) | Whole-file read, id set, forward references, duplicate detection, create/update/skip/refuse classification, every §5.2 refusal. **Pure — no writes** | **BLZ-587** | A2 |
| B2 | **The apply** (`scripts/model/import-apply.mjs` + `blaze import`) | Walk the plan through the injected write port; **a claim per created ticket on BOTH the explicit-id and `--allocate-ids` paths** (§5.5); the once-any-ticket-is-written-only-exit-4 invariant covering writes, staging **and** receipt appends (§5.1); the receipt (intent / allocated / done, plus the inspection path's `resolved`, whose presence is what lifts the exit-5 refusal; §5.3) and its **three-state** repair rule (orphan / pair-absent / nothing) with its **pre-write, best-effort, exit-code-neutral** 90-day prune and torn-line quarantine; exit codes 0–5 with 5 covering all four record-state cases; **a SIGKILL-mid-write test asserting the code AND that unmatched-`intent` ⊇ not-on-disk with the difference ≤ 1** (§5.1), which requires `appendRegularFileSync` for every receipt and map append (§5.1); the prune's read-only, never-quarantining reader with torn-`intent`-means-unmatched (§5.3); dry run by default | **BLZ-587** | B1, A3 |
| B3 | **The round-trip gate — gates 1, 2 and 3** | `tests/csv-round-trip.test.mjs` (a `node --test` suite, **not** `board-gate.yml` — it needs a temp board and must be runnable locally); the fixture, incl. `not_before`/`deadline`/`sprint` and a **`priority`-absent and `assignee`-absent row**, and a **`.ids/.cutover` marker plus per-ticket claim assertions** (without the marker `missingClaimErrors` returns early at `index.mjs:367` and the claim guard is structurally impossible), none of which any enum assertion can reach; **gate 2** with its `listTickets` wrapper (§3.3), since `zero-diff.mjs:81` hard-codes `listTickets(null)`; **gate 3**; the enum-coverage assertion; `zeroDiff`'s `compared`/`fieldsChecked` positive control | **BLZ-589** | B2 |
| B4 | **The blanking revert test** | Blank — not remove — one exported column and assert **gate 2** goes red for the reason its name gives. Separated from B3 because it is the test that proves B3 discriminates, and a gate merged without it is a gate nobody has falsified | **BLZ-589** | B3 |

### Phase C — the mapping layer

| # | Item | Scope | Ticket | Depends on |
|---|---|---|---|---|
| C1 | **Mapping file + deterministic apply** (`scripts/model/import-mapping.mjs`) | The §4.2 format, the closed `transform` vocabulary, the `sha256` header check, `unmapped` completeness, and **`sourceIdColumn`** plus its durable **`source-ids/<mapping>.jsonl`** store — an **outcome** log appended per row **between the ticket write and `done`** (§5.3 step 5) through `appendRegularFileSync`, opened before any write under exit 5, append-only with first-occurrence lookup; the inspection path's park-truncate-append repair. **Two tests:** an unwritable map ⇒ exit 5 with nothing written; **the map append itself failed at row N** ⇒ ticket N on disk, N−1 pairs, no `done`; re-import refuses with 5; after resolution, rows above N created, 1..N skipped, no duplicate, no phantom. **No model** | **gap — new ticket** | B1 |
| C2 | **The proposer + the confirmation** (`scripts/model/import-mapping-propose.mjs`, `blaze import propose-mapping`) | Spawn `agentCommand`; render §4.4; write the mapping file and nothing else | **gap — new ticket** | C1 |
| C3 | **The boundary guard** | §4.3's assertions over a **PATH-shadowed sentinel stub** (`stubGh` pattern, `tests/reconcile-delivery-truth.test.mjs:65-73`): **two** stubs with **two** sentinels; import succeeds leaving neither; `propose-mapping` fails with `ENV_HIT`; `propose-mapping` with `BLAZE_AGENT_COMMAND` **unset** fails with `PATH_HIT` (without which the PATH arm is never executed); both repointed at benign stubs, `propose-mapping` succeeds. Plus the one surviving static assertion. Explicitly **not** the first draft's three static assertions (two unsatisfiable) nor the second draft's in-process patch (`cli.mjs:9` spawns a separate process) | **gap — new ticket** | C2 |

### Phase D — the second front end

| # | Item | Scope | Ticket | Depends on |
|---|---|---|---|---|
| D1 | **Markdown import** (`blaze import --format markdown`) | A second reader onto the same `planImport`; the shared-rule test; markdown export and its round trip | **BLZ-588** | B2, B3 |

### Gaps the three tickets do not cover

- **C1–C3 have no ticket.** BLZ-587 predates the Q2 decision, so the entire mapping layer — the
  operator's actual ask — is unticketed. **Three new tickets, and C3 is the load-bearing one:**
  without it, "no model runs on the import path" is a claim rather than a property.
- **B4 has no ticket either**, and it is the item that decides whether B3 is a gate or a
  decoration. Either a criterion on BLZ-589 or its own ticket, but not an implicit part of B3 —
  the whole reason B3 needed rewriting is that its first version was green against a defect that
  blanked 21 of 31 columns.
- **Claims on import** (§8 item 1) — either a new criterion on BLZ-587 or its own ticket.
- **The two link vocabularies, and the `Precedes`-writer dependency** (§8 item 3) — its own ticket, and
  it should carry a blocks/blocked-by edge to whoever lands BLZ-360 §5.5's writer, because that
  is the change that silently invalidates §2.4's parity bound.
- **`docs/guide/schema.md` contradicts shipped code** (§8 item 5) — a doc ticket, and larger than the
  "one-line fix" an earlier draft called it: the paragraph denies that `verified` shipped, and the
  neighbouring claim about `superseded` needs independent checking.
- **`cli.mjs:290`'s signal handling** (§8 item 6) — its own ticket, engine-wide, blocking nothing
  here but capping what §5.1 can promise. One-line fix, one SIGKILL test.
- **BLZ-587's stale `git add -A` Context** (§8 item 7) — a ticket-text correction, not a code change.

**Sequencing.** A3 lands **with** B2, not after it — BLZ-589's round trip is the only honest
verification of BLZ-587 and the plan is explicit that it is *"not optional and not last"*. **B4
lands with B3**, for the same reason one step down: a gate merged without the test that falsifies
it is a gate nobody has checked. C runs after B and can run in parallel with D.
