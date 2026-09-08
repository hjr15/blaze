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
> **3. The round trip needs TWO gates, because export-to-export alone is vacuous. X and Y come
> from the same exporter, so an exporter defect cancels in the diff — 21 of the 31 columns can be
> blanked with a byte-identical diff and a passing audit. Gate 1 is `diff X Y`; gate 2 is
> `zeroDiff`'s value comparison of the source board against the imported one.**

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

**2,854 tickets**, across **11 project keys** (ACA, BLZ, CRP, FL, INF, KPA, NCA, OBA, OMA, SN,
STA). **The board is live and advances under this figure** — the same corpus measured three times
over one day gave 2,849, 2,850 and 2,854 — so treat it as an order of magnitude with a timestamp,
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
| `priority`, `parent`, `labels` | 2,848 | |
| `worklog` | 1,932 (1,707 non-empty) | max **6** entries on one ticket |
| `links` | 1,521 (1,067 non-empty) | max **13** on one ticket |
| `branch` / `pr` | 606 / 596 | `pr` is always `#<N> — https://github.com/…/pull/<N>` |
| `ref` | 301 | |
| `category`, `verification`, `derived` | 173 each | |
| `likelihood`, `impact`, `sprint` | 80 each | all 80 `likelihood`/`impact` on `type: risk` |
| `due` / `start` | 40 / 38 | |
| **`not_before`, `deadline`** | **0** | ADR-0022's constraints are declared, unwritten on this board |

Seven facts the format depends on:

1. **Dates are uniformly `YYYY-MM-DD`, with zero deviations** — **5,786** date values across
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
   `parseTicket`: all 2,854 tickets parse, **0** links lack a target, and `lintLinks`
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
| 8 | `priority` | enum | ○ | Default `medium` if empty |
| 9 | `resolution` | enum | ○ | |
| 10 | `parent` | id | ○ | |
| 11 | `assignee` | text | ○ | Default `unassigned` if empty |
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
*"Nothing written — this verb is report-only"* (`scripts/schedule-runner.mjs:191`) — and
`dbWritePort`'s `persist` DELETEs every `ticket_link` row for a ticket and re-inserts from
frontmatter (`scripts/model/write-port.mjs:254-258`), so even an externally-inserted `Precedes`
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

### 3.1 Two oracles, because one of them is blind

```
A  ──blaze export --format csv──▶  X
X  ──blaze import --apply──▶  B   (an empty board)
B  ──blaze export --format csv──▶  Y
```

**Gate 1 — `diff X Y` is empty, byte for byte.** This catches importer defects.

**Gate 2 — `zeroDiff(A, B).valueDiffs` is empty.** This catches **exporter** defects, and without
it gate 1 is vacuous.

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
| **X and Y** | **Nothing.** Byte-identical | gate 1 |
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

A new step in `.github/workflows/board-gate.yml`, which already runs verbs over fixture boards
and then runs `node --test tests/board-gate.test.mjs` to *"Prove the gate discriminates"* — the
same shape, for the same reason.

1. `blaze export --format csv tests/fixtures/csv-round-trip/projects > X.csv`
2. `blaze import --apply --into <tmp board> X.csv`
3. `blaze export --format csv <tmp board>/projects > Y.csv`
4. **Gate 1** — `diff X.csv Y.csv`; non-empty fails the job.
5. **Gate 2** — `zeroDiff(fsReadStorage, tests/fixtures/csv-round-trip/projects, <B's read
   driver>)` and require `valueDiffs`, `missing`, `extra` and `frozenViolations` all empty.
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
- **gaps in the id sequence**, so the round trip cannot pass by renumbering;
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

The proposer is `proposeMapping(header, sampleRows, { agentCommand })` in
`scripts/model/import-mapping-propose.mjs`. It spawns `cfg.agentCommand` — the same seam the
groomer already uses (`scripts/loops/groomer.mjs:547,570`), default `"claude -p"`
(`scripts/config.mjs:21`), overridable by `BLAZE_AGENT_COMMAND` (`scripts/config.mjs:271`). It is
handed the header row and a bounded sample of rows and returns a mapping candidate. It never
resolves an id, never reads the corpus and never touches a write port.

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

**What is pinned instead — two assertions, each with a control that works:**

1. **The proposer is absent from the importer's static graph.** This one holds, and its positive
   control is real: the same walk over `scripts/import-mapping-runner.mjs` **must** find
   `import-mapping-propose.mjs`. Absent-here / present-there is a genuine discrimination.
2. **A full import of a fixture CSV completes with every spawn primitive replaced by a throwing
   stub.** The test runs `blaze import --apply` under a harness that replaces
   `child_process.spawnSync`, `spawn` and `execFileSync` with functions that throw, and asserts
   the import **succeeds**. Its positive control is the same harness applied to
   `propose-mapping`, which **must** throw — proving the stub is installed and reachable, so a
   passing import means "no spawn happened" rather than "the stub was never wired".

That is the property the operator actually cares about, and it is immune to the `cfg`-reaches-the-
spawn-indirectly hole that sank assertion 3: a `cfg` carrying `agentCommand` is harmless if
nothing can execute it. It follows the plan's §9 method — *"pin the property, not the spelling"*,
and *"check a positive control before trusting a negative"* — where the first draft pinned a
graph shape that the repo's own module structure makes unreachable.

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
| **0** | Clean. A dry run that would succeed, or an `--apply` that did | unchanged, or fully imported |
| **1** | **Data refused.** One or more rows fail validation | **unchanged** — nothing written |
| **2** | **Could not look.** The input could not be read as the format it claims | unchanged |
| **3** | **Mapping incomplete.** A source column has no confirmed mapping, or the mapping's `source.sha256` does not match the file | unchanged |
| **4** | **The board changed and the run did not finish cleanly.** A write failed part way, **or** every write landed and staging then failed | **changed** — see §5.3 |

Three separations, each because the remedy differs:

- `1` means *fix the data*; `3` means *confirm a mapping*. Collapsing them makes the message carry
  a distinction the code should.
- `4` is the **only** code that means the board changed. A formula-injection cell is therefore a
  `1`, not a `4` — it is a refusal like any other, and nothing was written.
- **`4` covers staging failure, and that requires the importer to catch.** An earlier draft
  claimed `4` was the only board-changed code while routing staging through `commitOrQueue`
  *after* the writes — and `commitOrQueue` **throws**, at `scripts/commit-or-queue.mjs:18-21` on
  an op absent from `OP_LABEL` and at `:27` via `assertWritable`. An uncaught throw exits 1, which
  this table declares means *nothing was written*. So the claim was false as written. The
  importer therefore wraps the staging call and converts any failure to **4**, naming the files
  written and the fact that they are unstaged.

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
| **A duplicate id within one file** | Refuse. Name the id and every row number carrying it. Never "last row wins" — `duplicateIdErrors` (`scripts/model/index.mjs:398`) records that a silent last-wins collapse hid open work behind a closed ticket on a real board | **1** |
| **An id that already exists on the board** | Three cases, decided by comparison, not by flag: **identical** ⇒ **skip**, counted and named (this is what makes a re-run a no-op, per BLZ-587); **differs, no `--update`** ⇒ **refuse**, naming the id and the differing fields; **differs, with `--update`** ⇒ update, and the dry run lists it under `WOULD UPDATE` with a field-level diff. **"Identical" means all 31 canonical columns**, `status` and `description` included — a status-only difference is a difference, and comparing only the 28 frontmatter keys would skip it silently, since `status` is a directory rather than a field (§1.1) | **0** / **1** / **0** |
| **A row with an empty `id`** | **Refused by default.** `id` is required on import. The skip rule above is keyed on the id, so an id-less row has nothing to compare and would allocate a fresh id on every run: two `--apply` passes over the same file would produce two tickets, and after an exit-4 partial apply the duplication compounds. `--allocate-ids` accepts them and **explicitly forfeits the no-op guarantee**, saying so in the dry run's trailer. Export always emits an id, so the §3 round trip is unaffected. A stable natural key (a mapping-declared identity column plus a committed key map) would restore idempotency for id-less rows and is **deferred**, not designed here — §7 | **1** |
| **A dangling reference** — a `parent` or `links` target in neither the file nor the board | Refuse, naming every dangling reference and its source row. **Never a silent drop.** A forward reference *within* the file resolves: the planner reads the whole file, builds the id set, then validates — the file is a unit, not a stream | **1** |
| **A malformed row mid-file — wrong cell count, or an unterminated quote** | The **file** is not the format it claims, so this is *could not look*, not *bad data*. Refuse at parse time, naming the line number and the byte offset. Nothing is validated and nothing is written | **2** |
| **A cell beginning with `=` or `@`** | Refuse, naming the row and column (not the contents). §2.5. Measured safe: **0** of the live board's values begin with either (§1.6) | **1** |
| **A link entry with a `type` and no `target`** — on **export** | Refuse the export, naming the ticket. An exporter that dropped it would launder corruption into a clean-looking CSV, and per §3.1 the X-vs-Y diff cannot see that. **Zero instances exist on the live board** (§1.6 fact 7, retracted), so this guard ships unexercised by real data and is driven by a constructed fixture row instead | **1** |
| **A partially applied import** | See §5.3 | **4** |
| **An `estimate` that is not a multiple of 5** | Refuse, naming the row and the nearest legal values. Not rounded — rounding is `blaze new`'s input policy and it invents (`scripts/model/time.mjs:19-21`); an import mirrors | **1** |
| **A `sprint` not in `sprints.json`** | Refuse, naming the sprint id. `validateSprintFields` already provides the rule | **1** |
| **An off-taxonomy `label` or `component`** | Refuse, with `validateTaxonomy`'s own message, which names the `project.json` to add it to (`scripts/model/taxonomy.mjs:14`) | **1** |
| **An unreadable input path** — missing, a directory, a FIFO, a socket | Refuse via `readRegularFileSync` (`scripts/model/regular-file.mjs`), per ADR-0031. Never opened blind: a FIFO with no writer blocks forever (`scripts/model/index.mjs:52-70`) | **2** |

**The no-echo rule is scoped, because stated as a blanket principle it contradicts this very
table.** An earlier draft declared that a refusal never echoes the offending cell, and then
specified four messages that do: the duplicate-id row names the id, the dangling-reference row
names the reference, the sprint row names the sprint id, and the off-taxonomy row uses
`validateTaxonomy`'s own message, which interpolates the cell at
`scripts/model/taxonomy.mjs:14`. §4.4's proposal render prints `Status: "Blocked" (3 rows)` too.

The rule that actually holds, and the reason for it:

- **A cell whose value space is CLOSED is echoed** — `id`, `parent`, a link `target`, `sprint`,
  `label`, `component`, `status`. These are identifiers and enum members. The operator cannot act
  on "row 412 names something that does not exist" without being told *what*, and the value is
  drawn from a vocabulary, not from free text.
- **A cell whose value space is OPEN is not echoed** — `title`, `description`, `worklog.note`,
  and **any cell in a column the mapping could not place**. These carry arbitrary pasted content,
  and BLZ-566's finding is that an error message is an output channel. The message gives the row,
  the column and the rule, and nothing of the content.
- **The boundary case is an unmapped source column**, where blaze does not know the value space.
  It is treated as **open**. Guessing "closed" on an unknown column is the mistake that lets
  pasted data reach a log.

### 5.3 Atomicity, and the part of it that is not real

**Validation is all-or-nothing and that guarantee is total.** The planner reads the entire file,
builds the full plan, and validates every row against the board and against the other rows. One
bad row means **zero** writes. BLZ-587's *"500 good rows and 3 bad ones"* case exits 1 with the 3
named and 497 untouched.

**The write is not atomic on a filesystem, and this design does not claim it is.** A write can
still fail at `ENOSPC` or `EACCES` after row 300 of 500. When it does:

- the run **stops at the first failure** — it does not press on;
- it prints every id **written** and every id **not written**, as two explicit lists;
- it exits **4**, the one code that means the board changed;
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
row, with no way for the operator to tell which. The receipt is therefore **two entries per row**,
appended to a JSONL file:

```
{"seq":41,"phase":"intent","row":41,"id":"BLZ-620","op":"create"}
{"seq":41,"phase":"done","id":"BLZ-620","file":"projects/BLZ/done/BLZ-620-….md","claim":true}
```

An `intent` with no matching `done` is precisely the set an operator must inspect, and it is
readable with `grep`, not inferred.

**Mistake 2 — the sole record of a board mutation was placed where the repo says to delete it.**
`.blaze/` is gitignored in both this repo and `blaze-pm`, and `scripts/reindex.mjs:1-4` states
that what lives there is *"derived, regenerable caches — safe to delete"*. A partial-apply record
is neither derived nor regenerable, and git would never keep it — strictly weaker than the
BLZ-531 precedent invoked. The receipt therefore lands at **`import-receipts/<ISO>-<name>.jsonl`
at the data root**, beside `import-mappings/` and for the same reason: it is a record, not a
cache. It is staged with the tickets it describes, so it reaches upstream in the same commit.

**If the receipt cannot be opened for append, the import does not start.** That is BLZ-531's
fail-closed rule in its own direction — an irreversible act whose record cannot be kept is not
performed. Refused before any write, exit 2.

**Under `BLAZE_WRITE_PORT=db` the run is one transaction and all-or-nothing is real.** The
asymmetry is stated rather than smoothed over, because ADR-0030's rule is that a run which could
not look does not report what a run that looked reports. The dry-run trailer names which port is
in force and therefore which guarantee applies — and under `db` the receipt is still written, so
the two ports produce the same evidence even though they give different guarantees.

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

A row with an explicit `id` does not allocate, and the id's number is checked against the
project's allocation floor so an import cannot hand out an id a later `blaze new` would reissue.
An id-less row is refused unless `--allocate-ids` is given (§5.2).

Under `--allocate-ids`, a row gets an id from `allocateId` (`scripts/model/ids.mjs:66-86`) — the
`O_EXCL` reservation of ADR-0005 — and a claim from `writeClaim`. An import that allocated ids
without claims would produce a board where `missingClaimErrors` (`scripts/model/index.mjs:353`)
reports **every** imported ticket as an error, not a warning.

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
- **The receipt is what makes them findable.** An `intent` entry with no `done` (§5.3) names
  exactly the rows whose reservation may be orphaned. That is why the intent entry is written
  before allocation, not after: written after, a crash between reservation and record leaves the
  reservation unrecorded, which is the case with no evidence at all.

---

## 6. Where the code goes

| File | What | Coverage |
|---|---|---|
| `scripts/model/csv.mjs` | RFC 4180 reader and canonical writer. Pure, zero-dependency | gated |
| `scripts/model/csv-schema.mjs` | The 31 columns, their types, the version constant, per-column validators | gated |
| `scripts/model/import-plan.mjs` | `planImport(rows, board, opts)` → the create/update/skip/refuse plan. Pure | gated |
| `scripts/model/import-apply.mjs` | Walks a plan through the injected write port. No `node:fs` | gated |
| `scripts/model/export-rows.mjs` | Corpus → canonical rows, via the read seam | gated |
| `scripts/model/import-mapping.mjs` | Mapping file load, validate, apply. **Deterministic, no model** | gated |
| `scripts/model/import-mapping-propose.mjs` | The **only** module that spawns `agentCommand` | gated |
| `scripts/import-runner.mjs` | CLI for `blaze import`. Argument parsing and printing only | excluded |
| `scripts/import-mapping-runner.mjs` | CLI for `blaze import propose-mapping` | excluded |
| `scripts/export-runner.mjs` | CLI for `blaze export` | excluded |

Logic lives under `scripts/model/` because `.c8rc.json` excludes `scripts/*-runner.mjs` from the
coverage gate (statements 91, branches 77, functions 93, lines 91). A decision made in a runner is
a decision nothing measures.

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
- **Natural-key identity for id-less rows.** §5.2 refuses a row with no `id` unless
  `--allocate-ids` is given, and that flag forfeits the re-run-is-a-no-op guarantee. Restoring it
  needs a mapping-declared identity column plus a committed natural-key → blaze-id map, with its
  own collision and re-key semantics. That is a design of its own and is **deferred, not
  assumed** — the flag's dry-run trailer says so rather than leaving an operator to find out on
  the second run.
- **Resolving the two link vocabularies** (§1.4) or correcting `docs/guide/schema.md` (§1.3).
  Both are named as gaps in §8.
- **Rollback of a partial apply.** §5.3 records why: a rollback is a second write path with its
  own failure mode, and ADR-0032 already rejected that shape once. The receipt makes the residue
  findable; undoing it is a manual operation.

---

## 8. Where this design and the existing tickets disagree

One thing in BLZ-587 **is** contradicted — item 6 below — and six things the three tickets do not
cover.

1. **Claims.** BLZ-587's acceptance criteria never mention the `.ids/` claim ledger. An importer
   that satisfies every criterion as written still produces a board that fails `blaze audit` on
   every allocated row (`scripts/model/index.mjs:353`). §5.5 closes it; it needs to be a
   criterion, not a footnote.
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
6. **BLZ-587's Context is stale about `git add -A`, and this design does not repeat it.** The
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
explicit, named opt-out. Naming it beats an importer that quietly fails the criterion for id-less
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
| B2 | **The apply** (`scripts/model/import-apply.mjs` + `blaze import`) | Walk the plan through the injected write port; `--allocate-ids` and its forfeited guarantee; claims; **caught** `commitOrQueue` staging (§5.1); the two-entry receipt of §5.3 at the data root; the §5.1 exit codes; dry run by default | **BLZ-587** | B1, A3 |
| B3 | **The round-trip gate — gates 1, 2 and 3** | The `tests/fixtures/csv-round-trip/` corpus (incl. `not_before`/`deadline`/`sprint`, which no enum assertion can reach); the `board-gate.yml` steps; **gate 2, the `zeroDiff` A-vs-B value comparison**; **gate 3, per-column non-emptiness**; the enum-coverage assertion; `zeroDiff`'s own `compared`/`fieldsChecked` positive control (§3.3) | **BLZ-589** | B2 |
| B4 | **The blanking revert test** | Blank — not remove — one exported column and assert **gate 2** goes red for the reason its name gives. Separated from B3 because it is the test that proves B3 discriminates, and a gate merged without it is a gate nobody has falsified | **BLZ-589** | B3 |

### Phase C — the mapping layer

| # | Item | Scope | Ticket | Depends on |
|---|---|---|---|---|
| C1 | **Mapping file + deterministic apply** (`scripts/model/import-mapping.mjs`) | The §4.2 format, the closed `transform` vocabulary, the `sha256` header check, `unmapped` completeness. **No model** | **gap — new ticket** | B1 |
| C2 | **The proposer + the confirmation** (`scripts/model/import-mapping-propose.mjs`, `blaze import propose-mapping`) | Spawn `agentCommand`; render §4.4; write the mapping file and nothing else | **gap — new ticket** | C1 |
| C3 | **The boundary guard** | §4.3's **two** assertions: the proposer absent from the importer's static graph (with the present-there control), and a full fixture import completing under a **throwing spawn stub** (with the propose-must-throw control). Explicitly **not** the three static assertions of the first draft, two of which are unsatisfiable | **gap — new ticket** | C2 |

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
- **BLZ-587's stale `git add -A` Context** (§8 item 6) — a ticket-text correction, not a code change.

**Sequencing.** A3 lands **with** B2, not after it — BLZ-589's round trip is the only honest
verification of BLZ-587 and the plan is explicit that it is *"not optional and not last"*. **B4
lands with B3**, for the same reason one step down: a gate merged without the test that falsifies
it is a gate nobody has checked. C runs after B and can run in parallel with D.
