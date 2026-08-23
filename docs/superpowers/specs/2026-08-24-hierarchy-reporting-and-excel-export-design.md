# Blaze v4 — spec 4: hierarchy reporting and Excel export

**Status:** draft for review · **Date:** 2026-08-24 · **Consumer spec, BLZ-365**

The fifth of the six v4 subsystem specs and the last of the three this session writes. It goes
last because it is the heaviest consumer of the schema BLZ-360 §6.4 installs.

**Its inputs are merged and are not reopened:** the two kernel specs (BLZ-354, BLZ-360), spec 3
(BLZ-363) and spec 2 (BLZ-364).

BLZ-354 §8.3 handed this spec two problems and was explicit that it could not solve either:

> *"**This one strains, and saying it passes would be dishonest.** Two things it needs do not
> exist: 1. **`report` is a seventh view type with no renderer.** … the model is **verified**
> against two specs and only **structurally plausible** for the third. … Also worth flagging
> outside this spec's scope: `export: 'xlsx'` collides with ADR-0011 — an xlsx writer is a runtime
> dependency. Spec 4's problem, but it should not be discovered inside spec 4."*

**Both are answered below, and the second is answered by building it and measuring it rather than
by arguing about it.**

Every number was measured against the live board on 2026-08-24 — **2,613 tickets, 11 projects** —
by running the measurement.

---

## 0. The three decisions

> **1. Blaze writes `.xlsx` itself, with zero dependencies. Proven by building it, not asserted:
> an 86-line writer over `node:zlib` produces files that `unzip -t`, openpyxl and LibreOffice Calc
> all accept — and at 50,000 rows it is *faster* than the `exceljs` figure ADR-0016 benchmarked.
> The working proof is committed beside this spec.**
>
> **2. `export` is a route suffix, not a view-config key.**
>
> **3. The `default` hierarchy is seeded from `ticket.parent`, which is exact on this corpus:
> 2,539 edges, 0 orphans, 0 cross-project, 0 level inversions.**

---

## 1. The xlsx collision — dissolved by measurement

### 1.1 What the collision actually is

ADR-0011's headline is the thing at risk: *"A default install is **1 package with zero
dependencies**."* An xlsx writer taken from npm makes that false for everyone, or — via ADR-0011's
own `optionalDependencies` finding — for everyone by default, since *"optional dependencies are
installed by default and merely tolerate installation failure."*

ADR-0011 supplies an escape hatch that would work: `pg` is an **optional peer dependency**, so
*"someone running Blaze on Postgres runs `npm install pg`."* An `xlsx` peer would follow that
precedent exactly, and **this spec does not take it**, because it turned out not to be needed.

### 1.2 An `.xlsx` is a ZIP of XML, and Node 24 ships everything required

| Part | Supplied by |
|---|---|
| DEFLATE | `node:zlib` — `deflateRawSync` |
| The ZIP container (local headers, central directory, EOCD) | ~60 lines, hand-written |
| CRC-32 | ~8 lines — a 256-entry table; **not** in `node:zlib`'s public API |
| The six OOXML parts | template strings |

That is the same move this repo already makes elsewhere: BLZ-354 §4.3 hand-writes a validator
rather than taking a JSON Schema library, *"a declared key table, a loop, an array of error
strings. **No JSON Schema library.**"*

### 1.3 It was built and measured, and the numbers are the argument

A working writer — **86 lines (77 non-blank, non-comment), importing `node:zlib` and nothing
else** — was run against the live corpus and at ADR-0016's benchmark scale. All figures are
medians, not single runs.

**It is committed at
[`evidence/2026-08-24-xlsx-zero-dependency-proof.mjs`](evidence/2026-08-24-xlsx-zero-dependency-proof.mjs)**
so this section is reproducible rather than asserted. It is evidence, not production code —
nothing imports it, and `scripts/model/xlsx.mjs` is where the shipped writer goes (§7).

| Input | Level | Output | Median time |
|---|---|---|---|
| **Live board: 2,613 rows × 13 columns**, real data | 6 | 220.4 KB | **55 ms** |
| Live board, same rows | 9 | 215.1 KB | 97 ms |
| **50,000 rows × 13 columns** | 6 | 2.36 MB | **775 ms** (7 runs, 757–911) |
| 50,000 rows × 13 columns | 9 | 2.16 MB | 1,876 ms (7 runs, 1,790–1,975) |

It scales close to linearly at level 6 — 2,613 → 55 ms, 10,000 → 162 ms, 20,000 → 300 ms,
50,000 → 775 ms.

**Against ADR-0016's own benchmark of the same 50k-row workload — `exceljs`, 2,026.2 ms total, of
which 1,540.8 ms (76%) inside the library — the zero-dependency writer is faster at both
compression levels: 1.08× at level 9 and 2.61× at level 6.**

**Stated honestly, because the comparison is not controlled:** different machine, different day,
a 13-column shape rather than whatever the benchmark used, and this writer does **less** than
`exceljs` — one sheet, inline strings rather than a shared-string table, one number format, no
formulas, no charts, no styling beyond a date format. The claim it supports is therefore the
narrow one: **at this scale and for this shape, the library is not buying speed**, so ADR-0011's
rule costs nothing here. It is not "we beat exceljs".

**Level 6 is the shipped default.** At 50,000 rows it is **2.42× faster** than level 9 for 9.4%
more bytes; on the live board's real data it is **1.76× faster for 2.5% more bytes**. Both
measured end-to-end — and the two ratios differ because synthetic repeated rows compress far
better than real ticket titles, which is why the real-data row is the one that governs.

### 1.4 It was validated three ways, and two real defects were caught doing it

| Validator | Result |
|---|---|
| `unzip -t` | *"No errors detected in compressed data"* |
| **openpyxl 3.1.5, `warnings.simplefilter('error')`** | reads back 2,614 × 13; `2026-08-11` returns as `datetime.datetime(2026, 8, 11)`, estimates as numbers; **1,694 numeric cells summing to 282,030**, matching the corpus |
| **LibreOffice Calc** (headless `--convert-to csv`) | exit 0; 2,614 rows; dates render as `2026-08-11`, so the number format round-tripped, not just the serial |

**The first draft passed a naive check and was still wrong twice**, which is why the bar above is
three validators and not one:

1. **No `<cellStyles>` element.** openpyxl warned *"Workbook contains no default style"*. Silent
   under default settings.
2. **No `<dimension>` element.** openpyxl's **streaming** reader returned `max_row = None` — so a
   50k-row export was unreadable by exactly the reader anyone would use on a 50k-row export, while
   the non-streaming reader was fine.

Both shipped green under "it opens". **So the acceptance test is: openpyxl with warnings as
errors, in `read_only=True` mode, plus a LibreOffice round-trip** — and that is a project rule
here, not a suggestion.

### 1.5 What this does to the event-loop hazard

ADR-0016 already names this workload: *"**Heavy synchronous jobs go off the main thread.** CPM and
Excel export both qualify."*

**Measured, export crosses the line before CPM does — but only just, and the margin is worth
stating rather than dramatising.** BLZ-360 §6.3 sets the scheduler's `worker_threads` trigger at
*"a solve exceeding 50 ms, or a board exceeding 10k schedulable tickets"*, and the live solve is
nowhere near it. **The live export is 55 ms at level 6** — over that 50 ms mark, on today's board,
but by 10%.

**v1 ships synchronous, with the trigger named and the number on record.** 55 ms is one stalled
frame on an operator-initiated action with no concurrent readers; 775 ms at 50k would not be. The
trigger to move it off-thread: **an export exceeding 500 ms**, which at level 6 this shape reaches
at roughly **32,000 rows** (interpolating 20,000 → 300 ms and 50,000 → 775 ms). An earlier draft
said 12,000 rows, extrapolating from a level-9 figure; the shipped level is 6 and the correct
number is ~2.7× larger. That is a measurement, not a guess, and the streaming
alternative ADR-0016 also offers — *"large responses stream or chunk"* — is harder here than it
looks, because a ZIP entry's header carries the CRC and the compressed length of data that has not
been produced yet.

---

## 2. `export` is a route, not a config key

BLZ-354 §8.3's illustrative row put `export: 'xlsx'` inside `config_json`. **This spec moves it,
and the reason is that a view's config describes what the view *is*, not what you do to it.**

```
GET /p/<KEY>/v/<slug>            → the report, rendered
GET /p/<KEY>/v/<slug>.xlsx       → the same rows, as a workbook
GET /p/<KEY>/v/<slug>.csv        → the same rows, as CSV
```

Three consequences, all of them the point:

1. **Every report view is exportable without a config key**, so there is no such thing as a report
   someone forgot to mark exportable.
2. **The collision with ADR-0011 disappears from the config vocabulary entirely** — nothing in
   `config_json` names a file format, so no view row can request a writer that does not exist.
3. It follows the surface BLZ-354 §7.2 already established, where `GET /view/<slug>` is the same
   view in a different representation.

`.csv` ships alongside `.xlsx` because it is ~15 lines over the same row builder and it is the
format that survives everything.

---

## 3. The `report` renderer

**BLZ-354's falsification test was about the record model, and a missing renderer never falsified
it.** §8.3 said the model is *"**verified** against two specs and only **structurally plausible**
for the third"*, and it was right to be careful — but the thing that was missing is a module, not
a shape. Spec 4 writes the module; the row is
`(scope='project', project_key, type='report', name, slug, config)` exactly like the other six.

`scripts/views/report.mjs` follows the contract `views/gantt.mjs:1-5` states — *"the model owns
all date math and geometry … so this module only paints and wires interaction"*:

- `scripts/model/report.mjs` — pure. `(index, hierarchy, memberships, config) → { columns, rows[], totals }`, each row carrying `depth`, its own values and its rolled values.
- `scripts/views/report.mjs` — `render(rm)` → an indented HTML table.
- The export routes of §2 consume **`reportModel`**, not the HTML. An export that scraped the rendered table would be a second implementation of the same query.

---

## 4. What populates `hierarchy_membership`

BLZ-360 §6.4 installs `hierarchyDdl` in DB schema version 2. **Installing is not populating, and
nothing writes a row today** — spec 3 §6 deferred `groupBy: 'hierarchy'` for exactly this reason.

**The `default` hierarchy is seeded from `ticket.parent`.** Measured, that projection is exact:

| Property of the parent tree | Measured | Consequence |
|---|---|---|
| Tickets carrying a `parent` | **2,539 of 2,613 (97.2%)** | 2,539 membership rows |
| Parents that do not resolve to a known ticket | **0** | no orphan handling needed at seed time |
| Roots | **74** — 49 `goal`, 16 `bug`, 5 `feature`, 4 `task` | 74 rows with `parent_id IS NULL` |
| Maximum depth | **4** — distribution 74 / 321 / 793 / 1,423 / 2 | the two depth-4 rows are `INF-107`, `INF-78`, both `subtask` |
| Parent edges crossing a project | **0** | a project-scoped report is complete by construction |
| Parent pairs where the child's `hierarchyLevel` exceeds the parent's | **0** | the seed introduces no illegal pair |
| Parent pairs at the same level | **4** | legal, and they survive the seed unchanged |

`hierarchy_membership`'s `UNIQUE (hierarchy_id, item_id, parent_id)` and its partial root index
(`hierarchy-schema.mjs:41-42`) both hold trivially, because a tree cannot produce a duplicate edge
or a second root for one item.

**A second named hierarchy is created by the operator and never inferred.** The seed exists to
make `default` non-empty on day one; it is not a general import.

---

## 5. The roll-up

### 5.1 BLZ-360 §8.3's decision, and the measurement that makes it safe

The kernel decided: *"`hierarchy-rollup.mjs` survives; it gains a `combine` parameter (default
sum)"*, dates roll `min`/`max`, and `rollup.mjs` *"keeps rolling time over `parent` until
`hierarchyDdl` installs — which §6.4 now does, in DB schema version 2 — then is retired."*

**Measured, the retirement is provably a no-op on this corpus.** Fed the same graph — the parent
tree, projected into 2,539 memberships — the two implementations return identical totals on the
three largest roots:

| Root | `rollup.mjs` | `hierarchy-rollup.mjs` | Agree |
|---|---|---|---|
| `OBA-4` | 36,335 min | 36,335 min | **yes** |
| `OBA-1` | 27,805 min | 27,805 min | **yes** |
| `OBA-2` | 22,055 min | 22,055 min | **yes** |

**That is a narrower claim than "the two roll-ups agree", and the narrowness is the point.**
`audit-runner.mjs:100-106` records them as unreconciled because *"their parent models and dedup
policies differ"*, and that remains true: they differ in **which graphs they can express**, not in
their arithmetic over a graph both can express. A tree is such a graph. So the swap is a zero-diff
change **today**, and stops being one the moment a second, DAG-shaped hierarchy exists — which is
precisely when `hierarchy-rollup.mjs`'s dedup starts doing work `rollup.mjs` cannot do.

`rollup.mjs` over the live 2,613 rows costs a **median 5.2 ms** over 9 runs (range 3.1–8.3),
consistent with ADR-0016's 762.7 ms at 100k.

### 5.2 `combine` alone is not enough — the retirement needs a whole-tree entry point

BLZ-360 §8.3 describes the change as *"a small change to an **18-line** pure function"* — it gains
`combine`, and `rollup.mjs` retires. **The `combine` half is right. The retirement half is not a
drop-in, and measuring it is how that surfaced.**

The two functions have different shapes, not just different graphs:

| | `rollUp(index)` | `rollup({…, rootId})` |
|---|---|---|
| Returns | a **Map of every id** → `{own_estimate, own_worklog, rolled_estimate, rolled_worklog, descendant_count}` | **one number**, for **one** root |
| Fields per id | **5** | 1 |
| Calls needed for a whole board | 1 | one per id, per field |

**And `rollUp` is not a leaf consumer.** Measured, it has two production callers —
`rollup-runner.mjs:61` and **`views/data.mjs:63`, which is inside `boardModel`**. Per BLZ-354
§2.1, `boardModel` is *"the read model behind board, list, map **and** metrics"*, so
`rollup.mjs` sits under **four of the six views**, not beside a CLI verb.

**The naive swap was measured rather than argued about:**

```
rollUp(index)              — whole-tree, all 2,613 ids, 5 fields      5.2 ms (median)
rollup({rootId}) per id    — 2,613 calls, estimate only              417 ms
                           — second pass for worklog                 425 ms
                                                           combined  842 ms
```

**Roughly 160× slower against the median (95× against the same run's cold 8.9 ms), and still one
field short of what `boardModel` reads.** A per-root API called once
per row is quadratic in the subtree size; the whole-tree pass is the thing ADR-0016 measured at
6.0× faster than a recursive CTE, and calling it per-root throws that away.

**So the decision BLZ-360 made stands and its cost estimate does not.** `hierarchy-rollup.mjs`
gains **two** things:

```js
// unchanged shape, for one root
rollup({ memberships, values, hierarchyId, rootId, combine = "sum" })

// new: one pass, every node, several fields at once — what boardModel needs
rollupAll({ memberships, values, hierarchyId, combine = "sum" })  // → Map<id, total>
```

`rollupAll` is the whole-tree pass `rollup.mjs` already is, generalised to
`hierarchy_membership` and to `combine`; `rollup` becomes a one-root convenience over it. Only
then is `rollup.mjs` removable without a 95× regression on four views.

**`combine`, and the fields it applies to:**

```js
// "sum" → estimate_minutes, worklog_minutes, descendant counts
// "min" → start_date       "max" → due_date
```

**Dates do not sum**, per BLZ-360 §8.3 — a parent's start is the `min` of its subtree's and its
due the `max`. Measured, the blast radius is small and reviewable: **22 parents have at least one
dated child, and only 1 of those is itself dated**, so a date roll-up newly populates **21**
parents.

**None of it is persisted.** BLZ-360 §8.3: a parent's rolled dates are *"derived from derived data
and are never persisted to `start_date`/`due_date` on the parent row."* The report computes them
per render, like every other roll-up here.

### 5.3 `rollupDuplicates` is inert on the `default` hierarchy, and says so

BLZ-354 §8.3's example carries `rollupDuplicates: 'exclude'`, from v4 spine §3.3's rule. **On a
tree it decides nothing** — no node is reachable twice, so the toggle has no observable effect on
any of the 2,539 seeded edges. It ships because a DAG hierarchy is the whole reason
`hierarchy_membership` allows several parents, and because `hierarchy-rollup.mjs:7-9` states the
rule it implements: *"Duplicates are excluded BY DEFAULT. Structure needs a toggle for this, which
means its default double-counts. A number you have to configure to be correct is not a number you
can trust."*

**Which is an argument against having the key at all**, and it is nearly persuasive. It is kept
only because the *include* direction has a legitimate use — asking "how much work is attributable
to this parent, counting shared items once per parent" — and refused as a default in either
direction: `exclude` is the default and there is no board-level setting that can change it.

---

## 6. The `report` registry entry

```js
{
  name: "report",
  label: "Report",
  scopes: ["installation", "project"],
  instantiable: true,
  configKeys: {
    hierarchy:         { type: "string", default: "default" },
    roots:             { type: "string[]|null", default: null },   // explicit ids
    rootTypes:         { type: "string[]|null", default: null },   // or by type
    depth:             { type: "integer|null", default: null },
    columns:           { type: "string[]", default: ["id","title","status","estimate","logged"] },
    rollupDuplicates:  { enum: ["exclude","include"], default: "exclude" },
  },
  render(model, config),
}
```

**`roots` is added beside BLZ-354 §8.3's `rootTypes`, and the measurement is why.** Its example
uses `rootTypes: ['goal']`, which looks natural and **silently drops 25 of the board's 74 roots** —
16 `bug`, 5 `feature`, 4 `task` that have no parent. A report rooted by type is a report with a
hole in it that nobody sees. So:

- `roots` names ids explicitly;
- `rootTypes` filters by type;
- **if both are null the roots are every node with no parent in that hierarchy** — all 74 — which
  is the only default that cannot silently omit work.

Whichever is used, **the report states its root count and how many roots the filter excluded**:
*"49 roots (25 excluded by rootTypes)"*. Spec 3 §5.2 sets that rule for hidden dependency edges
and it is the same rule.

**`depth` is a no-op past 4 on this corpus** (the deepest chain is 4), and `depth: 3` — BLZ-354
§8.3's illustrative value — would hide the 2 depth-4 subtasks. Rows hidden by `depth` are counted
in the same line.

**`export` is absent**, per §2.

---

## 7. What changes

| File | Change |
|---|---|
| new — `scripts/model/xlsx.mjs` | **86 lines**; `node:zlib` only. The committed proof (§1.3) is the starting point. ZIP writer, CRC-32, the six OOXML parts, `writeXlsx(rows, sheetName)` |
| new — `scripts/model/report.mjs` | pure `reportModel(...)`; no `Date.now()` |
| new — `scripts/views/report.mjs` | `render(rm)` → indented table, per `views/gantt.mjs:1-5`'s contract |
| `scripts/model/hierarchy-rollup.mjs` | `combine` parameter **and a new `rollupAll` whole-tree entry point** (§5.2); stays pure |
| `scripts/model/rollup.mjs` | **retired** once the seed lands and `rollupAll` exists (§5.1, §5.2). **Two production callers move: `rollup-runner.mjs:61` and `views/data.mjs:63` — the latter is inside `boardModel`, the read model behind board, list, map and metrics.** Test cost, measured: `tests/model/rollup.test.mjs` (5), `tests/rollup-runner.test.mjs` (5) and the `rollUp` assertions in `tests/serve.test.mjs`; `tests/model/hierarchy-rollup.test.mjs` has 6 tests inside a `describe` and gains `rollupAll`'s |
| `scripts/serve.mjs` | `.xlsx` / `.csv` route suffixes (§2) |
| migration | seed the `default` hierarchy — 2,539 memberships, 74 roots (§4) |

---

## 8. Testing and mutation discipline

TDD throughout. The xlsx acceptance test is §1.4's three validators, and **openpyxl and
LibreOffice are test-time tools, not runtime dependencies** — the distinction ADR-0011 draws
between `dependencies` and `devDependencies`, and the same one that lets a real Postgres gate the
`pg` driver.

Mutations, each of which must break at least one test:

1. Omit `<dimension>` from the sheet XML (§1.4 — the streaming reader stops resolving `max_row`).
2. Omit `<cellStyles>` from `styles.xml` (§1.4).
3. Write the CRC-32 of the **compressed** bytes rather than the raw bytes.
4. Emit a date as an inline string rather than a serial with `s="1"`.
5. Use the 1900 epoch rather than 1899-12-30 (an off-by-two on every date).
6. Deflate at level 9 instead of 6 (a **performance** assertion, not a correctness one — and it
   must be an assertion about a measured budget, or it is untestable).
7. Roll dates with `sum` instead of `min`/`max` (§5.2).
8. Default `rollupDuplicates` to `include` (§5.3).
9. Default `roots` to `rootTypes: ['goal']` (§6 — silently drops 25 roots).
10. Seed the hierarchy from the ticket's *type level* rather than its `parent` (§4).
11. Let the `.xlsx` route render the HTML table and scrape it, rather than consuming `reportModel` (§3).
12. Implement `rollupAll` by calling `rollup` once per id (§5.2 — a **performance** mutation, and
    it must be asserted against a measured budget or it is untestable; the measured gap is
    5.2 ms median vs 842 ms on this corpus).

**Mutation 11 has the same shape as spec 3's mutation 9 and the same problem: a correct scraper
produces the same bytes.** It is killable only structurally — by giving `reportModel` a column the
HTML renderer does not paint and asserting it appears in the workbook. That test is named here
because otherwise the mutation is decoration.

**Any mutation that survives is named in the PR body as a hole in the suite.**

Fixtures from the corpus: `OBA-4` (253 descendants, the largest subtree); the 25 non-goal roots;
`INF-107`/`INF-78` (the only depth-4 rows); and the 22 parents with a dated child.

---

## 9. Constraints honoured

| Constraint | How |
|---|---|
| **ADR-0011 — no new required runtime dependency** | **Zero added, and proven by construction** (§1.3). `package.json` keeps one optional peer (`pg`) and no `dependencies`. |
| **ADR-0016 — Node stays the runtime** | Its `exceljs` figure is the benchmark §1.3 measures against; its event-loop finding sets §1.5's trigger. |
| **ADR-0014 — no board or tenant discriminator** | `hierarchy.project_key` names a project inside one installation, exactly as `view.project_key` does. |
| **ADR-0018 — hybrid custom fields** | No new ticket column. Rolled values are derived per render and never persisted (§5.2). |
| **v4 spine §3.3** | Multiple named hierarchies; duplicates excluded by default (§5.3). |
| **BLZ-360 §8.3** | `hierarchy-rollup.mjs` survives with `combine`; `rollup.mjs` retires (§5.1). |

---

## 10. What this spec does NOT solve

- **Streaming or off-thread export.** §1.5 names the 500 ms trigger and the reason streaming a ZIP
  is hard. Not built.
- **Formulas, charts, multiple sheets, column widths, or styling** beyond a date format.
- **Import.** The writer writes. Nothing reads `.xlsx` back.
- **A second hierarchy's contents.** §4 seeds `default` only; a `safety` hierarchy is the
  operator's to build, and nothing infers one.
- **Reconciling `hierarchy` with `ticket.parent` after the seed.** They will diverge the first
  time either is edited, and no rule here says which wins. **This is the largest honest gap**, and
  it is bigger than it looks: `rollup.mjs`'s retirement (§5.1) removes the only consumer that
  reads `parent` directly, so nothing will notice the divergence.
- **Baselines / planned-vs-actual columns.** Spec 1's.
- **Scheduled or emailed reports.**

---

## 11. Open questions

1. **After the seed, is `ticket.parent` still the source of truth?** §10 names the gap; the
   candidate answers are a one-way seed (parent wins, hierarchy is a projection rebuilt on write),
   a one-time import (hierarchy wins, `parent` becomes legacy), or a lint that reports divergence.
   **The first is the smallest and is probably right for `default` specifically**, but it makes
   `default` unlike every other hierarchy, which is its own cost.
2. **Should `rollupDuplicates` exist?** §5.3 argues itself close to "no" and keeps it on one use
   case. It is inert on every hierarchy that exists today.
3. **What is the export's row cap, if any?** 50k rows is 2.16 MB and ~775 ms. 500k is untested and
   would exceed the 500 ms trigger by a lot. No cap is specified, and an uncapped synchronous
   export is a denial-of-service on one's own event loop.
4. **Does the `.xlsx` route respect `BLAZE_READONLY`?** It writes no board state, but BLZ-354 §7.3
   records that `mutates` is per-verb and `cli.mjs:89` refuses to spawn before parsing — so the
   CLI half of this has the same problem `blaze view list` has, and the same unresolved answer.
5. **`depth` and `roots`/`rootTypes` interact.** A `depth` that truncates a subtree and a root
   filter that excludes it produce the same empty region for different reasons; §6 counts both but
   does not say whether they are reported separately.
