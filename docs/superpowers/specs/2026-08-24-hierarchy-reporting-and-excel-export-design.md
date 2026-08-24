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
> a writer over `node:zlib` produces files that `unzip -t`, openpyxl and LibreOffice Calc all
> accept — and at 50,000 rows it is *faster* than the `exceljs` figure ADR-0016 benchmarked. The
> working proof is committed beside this spec and reproduces its own table with `--bench`.**
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

A working writer — **98 lines of code, importing `node:zlib` and nothing else** — was run against
the live corpus and at ADR-0016's benchmark scale. All figures are medians, not single runs.

**That count is the *shipped writer alone*, and it has now been wrong four times, so here is every
measure of the committed file with the line ranges that produce it** — the previous attempt was
wrong because it *transcribed* a reviewer's figures instead of recomputing them, and the same
commit changed the file:

| Region | Lines | Total | Code |
|---|---|---|---|
| header comment | 1–51 | 51 | 0 |
| **writer proper** | **52–179** | **128** | **99** |
| `--bench` harness | 181–237 | 57 | 46 |
| **whole file** | | **237** | **145** |

One of the writer's 99 is the `node:url` import, which only the harness's guard uses (`:193`), so
the **shipped** writer is **98 code lines**. Every figure above is `wc`-checkable against the
committed file; if it disagrees, this table is wrong, not the file.

Four earlier counts, each wrong differently: "86 lines (77 non-blank)" — true before the bug fixes,
and "non-blank" there meant non-blank-non-comment; "~140 lines (195 with comments)" — the whole
file's code count, and a second figure matching nothing; "94 lines (142 including its comments)" —
the file one commit before `localDayAsUtc` and the `node:url` import existed; and "234 lines … a
143-line region" — a total two lines stale, and a region that ran past the writer into the
harness's own comment block, i.e. the same boundary error in a new place.

**It is committed at
[`evidence/2026-08-24-xlsx-zero-dependency-proof.mjs`](evidence/2026-08-24-xlsx-zero-dependency-proof.mjs)**
and reproduces this table with
`node <it> --bench /path/to/board/projects`, so this section is reproducible rather than asserted.
**Run without a projects dir it refuses and exits 2** rather than printing a synthetic table — an
earlier version printed one under the label "real-shaped", which is precisely the flattered set
the paragraph below disowns. It is evidence, not production code —
nothing imports it, and `scripts/model/xlsx.mjs` is where the shipped writer goes (§7).

| Input | Level | Output | Median of 7 |
|---|---|---|---|
| **Live board: 2,613 rows × 13 columns** | 6 | 220.4 KB | **52 ms** (45–62) |
| Live board, same rows | 9 | 215.1 KB | 102 ms (94–122) |
| **50,000 real-shaped rows × 13** | 6 | 4.09 MB | **948 ms** (892–994) |
| 50,000 real-shaped rows × 13 | 9 | 3.99 MB | 1,825 ms (1,788–1,850) |

It scales close to linearly at level 6 — 2,613 → 52 ms, 10,000 → 176 ms, 20,000 → 351 ms,
30,000 → 531 ms, 50,000 → 948 ms.

**"Real-shaped" is doing real work in that table, and an earlier draft's figures did not have
it.** That draft built its 50,000 rows synthetically — `"row 0"`, `"row 1"`, … — and reported
**2.36 MB in 775 ms**. Cycling the board's actual rows instead gives **4.09 MB in 948 ms**: the
synthetic set was **1.73× smaller and 1.22× faster**, because repeated near-identical strings
compress far better than real ticket titles. The spec had already noted that effect in one
sentence and then quoted the flattered number anyway. **The generator is now committed with the
writer**, which is what makes the difference checkable.

**Against ADR-0016's own benchmark of the same 50k-row workload — `exceljs`, 2,026.2 ms total, of
which 1,540.8 ms (76%) inside the library — the zero-dependency writer is faster at both
compression levels: 1.11× at level 9 and 2.14× at level 6.** *(An earlier draft claimed 2.61×,
from the synthetic row set.)*

**Stated honestly, because the comparison is not controlled:** different machine, different day,
a 13-column shape rather than whatever the benchmark used, and this writer does **less** than
`exceljs` — one sheet, inline strings rather than a shared-string table, one number format, no
formulas, no charts, no styling beyond a date format. The claim it supports is therefore the
narrow one: **at this scale and for this shape, the library is not buying speed**, so ADR-0011's
rule costs nothing here. It is not "we beat exceljs".

**Level 6 is the shipped default.** At 50,000 real-shaped rows it is **1.93× faster** than level 9
for **2.5% more bytes**; on the live board, **1.96× faster for 2.5% more bytes** (220.4 KB against
215.1 KB).

*(Two corrections collided in this sentence and the second broke the first. The **original** draft
said "2.5% **more** bytes" and was right; the **first correction pass** changed it to "fewer",
which was backwards against the table above. The second pass fixed the direction and, in the same
edit, replaced two **correct** ratios — 1.93× and 1.96× — with 1.87× and 1.81×, which reproduce
from no figure anywhere and understate the shipped default's advantage. A third pass then
misattributed "fewer" to the original, deleting a true account of its provenance. All of it is now
recomputed from the table's own numbers: 1825/948 and 102/52.)*

`writeXlsx(rows, sheetName, { level })` takes the compression level as a parameter, so §8's
mutation 6 has something to mutate — an earlier draft hardcoded the level and specified a
two-argument signature, which made that mutation unkillable by construction.

### 1.4 It was validated three ways, and two real defects were caught doing it

| Validator | Result |
|---|---|
| `unzip -t` | *"No errors detected in compressed data"* |
| **openpyxl 3.1.5, `warnings.simplefilter('error')`** | reads back 2,614 × 13; `2026-08-11` returns as `datetime.datetime(2026, 8, 11)`, estimates as numbers; **1,694 numeric cells in the `estimate` column summing to 282,030**, matching the corpus (the workbook also carries 2,613 numeric `worklog` cells) |
| **LibreOffice Calc** (headless `--convert-to csv`) | exit 0; 2,614 rows; dates render as `2026-08-11`, so the number format round-tripped, not just the serial |

**The first draft passed a naive check and was still wrong twice**, which is why the bar above is
three validators and not one:

1. **No `<cellStyles>` element.** openpyxl warned *"Workbook contains no default style"*. Silent
   under default settings.
2. **No `<dimension>` element.** openpyxl's **streaming** reader returned `max_row = None` — so a
   50k-row export was unreadable by exactly the reader anyone would use on a 50k-row export, while
   the non-streaming reader was fine.

Both shipped green under "it opens". **So the acceptance test is: openpyxl with warnings as
errors, in `read_only=True` **and** default mode, plus a LibreOffice round-trip** — a project rule
here, not a suggestion.

**And that test set was still not enough. Adversarial review found a whole input class the proof
mishandled, including one crash:**

| Input | First proof | Now |
|---|---|---|
| `NaN`, `Infinity`, `-Infinity` | emitted `<v>NaN</v>` → **openpyxl refused the workbook** | text cell |
| a `Date` object | `Date.parse(dateObj + "T00:00:00Z")` → `NaN` — **the `instanceof Date` branch was dead on arrival** | real date cell |
| a date-shaped non-date (`9999-99-99`) | `<v>NaN</v>` → refused | text cell |
| **130,000 rows** | **`RangeError: Maximum call stack size exceeded`** — `Math.max(...rows.map(…))` spreads the whole array | 200,000 rows write fine |
| one empty row `[[]]` | `<dimension ref="A1:1"/>` → **broke the streaming reader** | `A1` |
| sheet name with `: \ / ? * [ ]`, or > 31 chars | passed through → rejected | sanitised |

**The crash is the one that matters, and it changes §11's open question 3 from a performance
question into a functional ceiling.** The others are the same defect shape as the two the first
validation pass caught: *plausible output that a strict reader refuses.*

**Two more defects were found by the third review, both introduced by the second review's own
fixes, and both in code rather than prose.** Dropping the `--bench` filename guard in favour of
`process.argv.includes("--bench")` meant **any importer invoked with `--bench` ran the harness and
was killed by its `process.exit()`** — the guard is now the standard `import.meta.url ===
pathToFileURL(process.argv[1]).href`. And the `Date` fix's `Date.UTC(v.getFullYear(), …)` maps
years 0–99 into 1900–1999, so a year-50 date emitted **1950**; `setUTCFullYear` does not. Neither
is reachable from the live corpus, and both are the same shape as everything else here: a fix that
introduced a smaller version of the bug it fixed.

**One more input class was found by the second review, and it produced the worst failure yet
because every cheap check passed it.** `U+FFFE` and `U+FFFF` are XML 1.0 **non-characters**: they
survived the C0 strip, and a cell containing one produced a sheet that **both openpyxl modes
refuse** while `unzip -t` reported *"No errors detected"* and **LibreOffice exited 0 having
silently dropped the row**. Fixed by adding them to the strip class — and the lesson is recorded in
§1.4's rule: **LibreOffice's exit code is not a gate.** The round-trip is only evidence because it
asserts the row count; on every malformed input in this sweep `soffice` returned 0.

**A second `Date` defect survived the first fix and is worse than the one it replaced.** Making the
`instanceof Date` branch live was not enough: `serial()` used `getTime()`, an absolute instant,
while the string path forces `T00:00:00Z`. So `new Date(2026, 7, 11)` — local midnight — landed at
`2026-08-10T14:00Z` in `Australia/Melbourne` and rendered as **2026-08-10**. The date format hides
the time, so the workbook simply showed the previous day, **on the timezone every figure in this
spec was measured in**. It now reads the Date's *local calendar day* and treats that as UTC
midnight; verified identical in `Australia/Melbourne`, `Asia/Tokyo`, `UTC` and `America/New_York`.

**Behaviour that is deliberate and now documented rather than discovered:** C0 control characters
are **stripped, not escaped** (XML 1.0 forbids them), so a lone CR becomes LF and NUL vanishes —
real data loss, intentional; a date-shaped string JS can normalise is accepted **as the normalised
date** (`2026-02-30` → `2026-03-02`), where `sprints.mjs:isIsoDate` would reject it, so **the
shipped writer should reuse that predicate**; and Excel's own ceilings (1,048,576 rows, 16,384
columns) are **not enforced** — a 16,385th column emits `XFE1`, one past Excel's last valid
column — and neither is its **32,767-character cell limit**. Non-string values are coerced rather
than refused: a `BigInt` and a boolean become text, an object becomes `"[object Object]"`, and a
`Symbol` throws. A shipped writer should decide which of those to refuse; the proof documents them
rather than pretending they do not occur. The 1899-12-30 epoch is correct **only for dates on or after 1900-03-01**; it does not
reproduce Excel's phantom `1900-02-29`, and earlier dates round-trip inconsistently between the
two validators. An earlier draft of the module comment claimed the leap-year bug was "included".

### 1.5 What this does to the event-loop hazard

ADR-0016 already names this workload: *"**Heavy synchronous jobs go off the main thread.** CPM and
Excel export both qualify."*

**Measured, export crosses the line before CPM does — but only just, and the margin is worth
stating rather than dramatising.** BLZ-360 §6.3 sets the scheduler's `worker_threads` trigger at
*"a solve exceeding 50 ms, or a board exceeding 10k schedulable tickets"*, and the live solve is
nowhere near it. **The live export is 52 ms at level 6** — over that 50 ms mark, on today's board,
but by 4%.

**v1 ships synchronous, with the trigger named and the number on record.** 52 ms is one stalled
frame on an operator-initiated action with no concurrent readers; 948 ms at 50k would not be. The
trigger to move it off-thread: **an export exceeding 500 ms**, which at level 6 this shape reaches
at roughly **28,000 rows** — measured, not extrapolated: 20,000 → 351 ms and 30,000 → 531 ms. Two
earlier drafts put it at 12,000 and then 32,000 rows, the first from a level-9 figure and the
second from the synthetic row set. That is a measurement, not a guess, and the streaming
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

`hierarchy_membership`'s `UNIQUE (hierarchy_id, item_id, parent_id)` (`hierarchy-schema.mjs:31`)
and its partial root index (`:41-42`) both hold trivially, because a tree cannot produce a duplicate edge
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

**And even the narrowed claim needs one more qualifier, which review supplied.** The two
implementations coerce differently: `rollup.mjs:15` does `Number(r.estimate) || 0`, so a
non-numeric estimate contributes **0**; `hierarchy-rollup.mjs:24` does `Number(values[id] ?? 0)`,
so it propagates **`NaN`** and poisons the whole total. A two-node tree with `estimate: "3h"`
gives 5 from one and `NaN` from the other. **The live corpus holds 0 non-numeric estimates, so the
zero-diff-today claim survives untouched** — but "identical over any graph both can express" is
false, and the swap must either restrict `values` to numeric-or-null or coerce with `|| 0` at the
seam.

**That aside, this is a narrower claim than "the two roll-ups agree", and the narrowness is the
point.**
`audit-runner.mjs:100-106` records them as unreconciled because *"their parent models and dedup
policies differ"*, and that remains true: they differ in **which graphs they can express**, not in
their arithmetic over a graph both can express. A tree is such a graph. So the swap is a zero-diff
change **today**, and stops being one the moment a second, DAG-shaped hierarchy exists — which is
precisely when `hierarchy-rollup.mjs`'s dedup starts doing work `rollup.mjs` cannot do.

`rollup.mjs` over the live 2,613 rows costs a **median 5.2 ms** over 9 runs (range 3.1–8.3),
consistent with ADR-0016's 762.7 ms at 100k.

### 5.2 `combine` alone is not enough — the retirement needs a whole-tree entry point

BLZ-360 §8.3 describes the change as *"a small change to an **18-line** pure function"* (it is
19 — `hierarchy-rollup.mjs:10-28`; quoted as written) — it gains
`combine`, and `rollup.mjs` retires. **The `combine` half is right. The retirement half is not a
drop-in, and measuring it is how that surfaced.**

The two functions have different shapes, not just different graphs:

| | `rollUp(index)` | `rollup({…, rootId})` |
|---|---|---|
| Returns | a **Map of every id** → `{own_estimate, own_worklog, rolled_estimate, rolled_worklog, descendant_count}` | **one number**, for **one** root |
| Fields per id | **5** | 1 |
| Calls needed for a whole board | 1 | one per id, per field |

**And `rollUp` is not a leaf consumer.** Measured, it has two production callers —
`rollup-runner.mjs:61` and **`views/data.mjs:63`, which is inside `boardModel`**.

**Two different numbers describe that, and an earlier draft gave one wrong number instead of
both.** It said `rollup.mjs` *"sits under four of the six views"*. Measured:

- **Computed under six of six.** `page.mjs:115` and `:151` call `boardModel` unconditionally for
  every view, so `rollUp` runs on every render — that is the **regression exposure**.
- **Read by one of six.** Only `views/board.mjs` reads `model.rollup` — that is the **data**
  dependency.

Four is neither. The retirement's blast radius is the first number; its behavioural surface is the
second.

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
| new — `scripts/model/xlsx.mjs` | **`writeXlsx(rows, sheetName, { level = 6 })`** — the three-argument form, so §8's mutation 6 has something to mutate; a two-argument signature makes it unkillable by construction. The ZIP writer, CRC-32 and the six OOXML parts: **98 lines of code**, importing **`node:zlib` only**. The committed proof is the starting point, minus its `--bench` harness (§1.3). |
| new — `scripts/model/report.mjs` | pure `reportModel(...)`; no `Date.now()` |
| new — `scripts/views/report.mjs` | `render(rm)` → indented table, per `views/gantt.mjs:1-5`'s contract |
| `scripts/model/hierarchy-rollup.mjs` | `combine` parameter **and a new `rollupAll` whole-tree entry point** (§5.2); stays pure |
| `scripts/model/rollup.mjs` | **retired** once the seed lands and `rollupAll` exists (§5.1, §5.2). **Two production callers move: `rollup-runner.mjs:61` and `views/data.mjs:63`, the latter inside `boardModel` — computed under all six views, read by `views/board.mjs` alone (§5.2).** Test cost, measured by grep rather than inferred: `tests/model/rollup.test.mjs` (5), `tests/rollup-runner.test.mjs` (5), `tests/serve.test.mjs` (**2** tests asserting `m.rollup` via `boardModel`, at `:69` and `:78`, **plus a now-dead `import { rollUp }` at `:52` that must be deleted or the file will not load**), `tests/runner-flag-guard.test.mjs` (2), `tests/readonly.test.mjs:128` (1), and field-shape stubs in `tests/views/board.test.mjs` and `tests/model/metrics.test.mjs`. `tests/model/hierarchy-rollup.test.mjs` has 6 tests inside a `describe` and gains `rollupAll`'s |
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
3. **What is the export's row cap?** It is now a **functional** question, not only a performance
   one. 50,000 real-shaped rows is 4.09 MB and ~948 ms; **200,000 write fine** since the crash
   §1.4 records was fixed, but **Excel itself stops at 1,048,576 rows and 16,384 columns and the
   writer enforces neither** — past those it emits a file Excel will reject, and a 16,385th column
   is written as `XFE1`, one past the last valid column. So there are two caps to choose: a
   **hard** one at Excel's limits, and a **soft** one where the synchronous write becomes a
   denial-of-service on one's own event loop (~28,000 rows, §1.5). Neither is specified.
4. **Does the `.xlsx` route respect `BLAZE_READONLY`?** It writes no board state, but BLZ-354 §7.3
   records that `mutates` is per-verb and `cli.mjs:89` refuses to spawn before parsing — so the
   CLI half of this has the same problem `blaze view list` has, and the same unresolved answer.
5. **`depth` and `roots`/`rootTypes` interact.** A `depth` that truncates a subtree and a root
   filter that excludes it produce the same empty region for different reasons; §6 counts both but
   does not say whether they are reported separately.
