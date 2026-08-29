# ADR-0031 — what a read that refused to open reports, decided per site

- **Status:** Accepted
- **Date:** 2026-08-29
- **Deciders:** Ryan Howman
- **Ticket:** BLZ-493 (builds on BLZ-484 / BLZ-470 and ADR-0030)

## Context

ADR-0030 §4 established the rule: **a read path may never block, and that outranks reporting.**
`readFileSync` opens whatever the path names, and on a FIFO with no writer that open blocks
forever — no error, no timeout, no exit. It fixed the one site BLZ-484 had just introduced
(`classifyGitEntry`'s `.git` probe) and recorded two more it had found but deliberately not
fixed, with the reason they were left:

> Neither is a one-line fix: making them merely skip would reintroduce exactly the silent drop
> BLZ-470 exists to close, so each needs a decision about what it reports.

BLZ-493 is that decision, made site by site.

### Every site was reproduced first, at `1b00f3a`

Reproduced out of process with an 8-second wall-clock cap; `HANG` means the child had to be
killed. Line numbers are at `1b00f3a`, re-derived — the ticket's came from an older SHA.

| # | Site | Reached from | At `1b00f3a` |
|---|---|---|---|
| 1 | `scripts/model/index.mjs:243` | `walkTickets`'s `.md` read | **HANG** |
| 2 | `scripts/audit-runner.mjs:121` | `project.json`, `blaze audit` | **HANG** |
| 3 | `scripts/views/data.mjs:124` | `liveModel` ← `serve.mjs:516` — the running server | **HANG** |
| 4 | `scripts/model/claims.mjs:70` | `readCutover` ← `missingClaimErrors` ← `reindex.mjs:77` | **HANG** |
| 5 | `scripts/model/sprints.mjs:44` | `loadSprints` ← `buildIndex`, `new`, `edit`, `page` | **HANG** |
| 6 | `scripts/views/panel-content.mjs:84` | `panelHtml` ← `serve.mjs:523` | **HANG** (see §6) |
| 7 | `scripts/model/transitions.mjs:80` | `loadTransitions` ← `views/page.mjs:71` | **HANG** |
| 8 | `scripts/config.mjs:169` | `loadConfig` — nearly every entry point | **HANG** |
| 8b | `scripts/config.mjs:468` | `loadProject` — every verb that names a project | **HANG** |
| 9 | `scripts/model/schema-config.mjs:478` | `loadProjectSchema` ← the audit's schema layer | **HANG** |

Two corrections to the work order's inventory, both measured:

- **The ticket said `claims.mjs` is reached from `buildIndex`. It is not.** `missingClaimErrors`
  was moved out of `buildIndex` by BLZ-274/ADR-0009 and is called by `reindex.mjs` alone. A
  FIFO `.cutover` under a `buildIndex` returns normally; under `blaze reindex` it hangs.
- **Site 9 is not in the ticket, and without it site 2 is worthless.** `auditCorpus`'s schema
  layer opens the same `project.json` a second time, so guarding only the runner's own read
  moves the hang rather than removing it.

### `existsSync` is not a guard

Sites 8 and 8b are gated on `existsSync(path)`, **which a FIFO satisfies**. That is the widest
exposure of the ten: one `mkfifo blaze.config.json` at a board root wedged every verb Blaze
has, before any of them printed a word.

## Decision

### 1. The guard checks the OPEN FILE DESCRIPTOR, not the path

`scripts/model/regular-file.mjs` exports `readRegularFileSync` / `writeRegularFileSync`, and
the ten reads and one write below all go through it.

ADR-0030 implemented its rule as `statSync` then open. **That shape is not enough here.** A stat
on a *path* answers about the file that was there a moment ago; the process then opens the file
that is there now. Losing that race is not a wrong answer, it is an unbounded hang. So:

1. `O_NONBLOCK` on the open — which is what makes opening a FIFO return rather than block.
   Measured: **0 ms** on a FIFO with no writer. On a regular file it is a no-op.
2. `fstatSync(fd)` — the type of the file that is *actually open*.
3. read (or write), or refuse. Nothing between the check and the read can be swapped.

Refusal is `NotARegularFileError`, `code: "ERR_BLAZE_NOT_A_REGULAR_FILE"` — a named string, not
an errno, so a caller can tell it from `ENOENT` without matching on a message.

**`ENOENT` is deliberately untouched.** Every caller here distinguishes *"there is no such
file"* (an answer: no config, no sprints, no cutover) from *"there is something and I could not
read it"* (not an answer). Folding them together would turn every board without an optional
file into a hard failure — the mirror image of the bug.

**A device node is refused as well as a FIFO, and for a different reason.** Only the FIFO hangs;
`/dev/null` returns zero bytes instantly and a socket fails `ENXIO` before `fstat` is reached.
A run that silently accepted the device node would read an empty config *as a config*, which is
this programme's defect class by a quieter route.

### 2. The line every per-site decision is drawn on

`loadSprints` states it most clearly, and the same line governs all ten:

> A **malformed** registry still yields EMPTY, unchanged, because that **is an answer** — Blaze
> looked, and the file is junk. A registry it could not **open** is not an answer.

Every `catch` here already existed and every one was there for a good reason — an optional file,
a project that declares no taxonomy, a cache that is allowed to be cold. None of them was
written to mean *"I could not look"*. So the refusal passes through them, and the tolerances
they were written for are untouched.

### 3. What each site reports — the table AC-3 asks for

| # | Site | Decision | What it does now |
|---|---|---|---|
| 1 | `walkTickets`'s `.md` | **REFUSE** | throws, exactly as a malformed `.md` already throws from `parseTicket` and as a `.md` that is a *directory* already threw `EISDIR` from this very line |
| 2 | `audit-runner`'s `project.json` | **REFUSE** | names the file on stderr and exits 2, before one finding is printed |
| 3 | `liveModel`'s activity feed | **REPORT** | `{ groups: [], unreadable: { path, detail } }`, and the Live view renders it instead of `No recent activity.` |
| 4 | `readCutover` | **REFUSE** | throws instead of returning `null` |
| 5 | `loadSprints` | **REFUSE** | throws instead of returning EMPTY |
| 6 | `panelHtml`'s re-read | **REFUSE** | throws into the `try/catch` `serve.mjs` already wraps it in → 500. **Defence in depth; not reachable, not pinned — §6** |
| 7 | `loadTransitions`'s cache | **SKIP, and it owes no report** — §7 | falls back to `git`, which is the true answer |
| 8 | `loadConfig` | **REFUSE** | a plain `Error`, deliberately *not* `ConfigParseError` — §8 |
| 8b | `loadProject` | **REFUSE** | passed through rather than reworded as a parse failure |
| 9 | `loadProjectSchema` | **REFUSE** | throws instead of resolving to the ambient registry |

**Why REFUSE and not "skip and report" at sites 1, 2, 4, 5, 8, 8b and 9.** ADR-0030 needed a
report channel because a *skipped directory* is a fact about the corpus with no natural place to
throw from — `walkTickets` is a generator with five call sites and no out-of-band return. These
seven are not that shape. Each is a single scalar answer — this project's taxonomy, this
board's sprints, this project's cutover, this ticket's text — and there is no honest degraded
value for any of them. `{ key: k }` is the taxonomy of a project that declares nothing; EMPTY is
a board with no sprints; `null` from `readCutover` makes `missingClaimErrors` **stay silent**,
forgiving every genuinely missing claim on the board. Each of those is a *sentence about the
world* produced by a run that never looked at the world.

### 4. `blaze audit` refuses rather than growing a tenth finding kind

Site 2 exits 2 with a named stderr line instead of raising an `unreadable-project-file` finding.
ADR-0030 argued the opposite way for a skipped *directory*, and the difference is what the run
can still honestly say. A skipped directory leaves a real report standing beside it — the other
projects were read, the count is a floor, and the finding says so. A `project.json` that could
not be read is the **taxonomy the entire report is measured against**: every `schema-invalid`
count, every field check, every workflow gate for that project would be computed from a file
this run never opened. There is no partial report left to attach a finding to.

Site 8 goes the other way and reuses machinery rather than adding any: a plain `Error` from
`loadConfig` already lands in the existing **`config-unloadable` HARD finding** — named,
`ok=false`, exit 1 — which is exactly the treatment this deserves.

### 5. The report at site 3 reaches a surface, or it is not a report

`liveModel` is the one site that reports rather than refuses, because it is `serve.mjs`'s
`/api/live` route on a **long-lived process** — the site whose hang was reproduced as exit 137 —
and a throw would take a route down over an optional feed. But `groups: []` **alone is the bug**:
`views/live.mjs` renders exactly `No recent activity.` for it. So `unreadable` travels out with
the model, the way `forgeErrors` and `gitErrors` do (ADR-0030 §2), and the Live view branches on
it **first**, before the empty state.

A **missing** feed stays silent. Nearly every board has none, and a banner that is permanent
furniture is the gate people learn to skip.

### 6. Site 6 is defence in depth, is not reachable, and is not pinned — stated, not implied

`panelHtml` calls `buildIndex` on its **first line**, and `buildIndex` never memoises. The walk
therefore opens this very file — and refuses at site 1 — four lines before the re-read is
reached. Site 6 is reachable only inside the sub-second window between those two reads: the same
window `serve.mjs:519` already documents for `ENOENT`. No test constructs it.

**The revert rule proved this rather than the reasoning alone.** Reverting `panel-content.mjs`
to `readFileSync` leaves every test green, including the test named for it. The test has been
renamed to claim only what it pins — that `/api/panel` refuses *and returns* over a FIFO ticket
file — and the guard is kept, one line, because `row.file` is the only value on this path that
does not come from the caller.

The same rule caught a second, worse thing: the first version of the Live-view test asserted
`/unreadable/` against the whole of `live.mjs`, which the *destructuring* satisfies on its own,
so deleting the entire render branch left it green. It now pins the branch and its order.

### 7. One site is allowed to skip in silence, and the reason is written beside it

`loadTransitions`'s cache. Every other site's fallback is a claim about the board made by a run
that never looked. This one's fallback is `buildTransitions`, which **does look — at git — and
returns the true answer**; the cache is a pure optimisation over `git log`. ADR-0030's rule is
about a run that could not look reporting what a *looking* run reports, and this run looks. So
it must not block, and it owes no report.

**Guarding only the read moves the hang three lines down.** `writeFileSync` on a FIFO with no
reader blocks exactly as the read does — measured at `1b00f3a` — and the write was already
inside a best-effort `try/catch`, which a *blocking* call sails straight past. Hence
`writeRegularFileSync`: `O_WRONLY | O_NONBLOCK` on a FIFO fails `ENXIO` immediately, so the
existing catch sees an error instead of never returning.

`model/regular-file.mjs` is added to `seam-closure.test.mjs`'s write allowlist rather than
dodging the guard by using a differently-named `fs` call. It writes no ticket, and its one write
caller (the transitions cache) is already inside that allowlist. **A guard evaded by renaming is
a guard that has stopped working.**

### 8. The refusal's error CLASS is load-bearing at `loadConfig`

`loadConfig` throws a **plain `Error`**, deliberately not a `ConfigParseError`. BLZ-392's
tolerance in `audit-runner.mjs` keys off that class to **continue** past a config it could not
load — and continuing past a config this run never *read* is the laundering itself. Reverting
just that one line turns the refusal into a tolerated parse failure, and its test red.

## Consequences

- **Ten `readFileSync` sites and one `writeFileSync` that could hang forever now cannot.**
  Measured on the same 16 constructed FIFO cases under an 8-second child cap: **15 of 16 were
  killed at `1b00f3a`; 1 of 16 is at HEAD.** The one that remains is `model/storage.mjs:104`
  (`fsStorage.read`), which is outside this ticket's scope and is raised as its own — and
  which no current call path reaches with a non-regular file, because its callers take the
  file from a walk that now refuses. The 16th case, `readCutover` via `buildIndex`, never
  hung: `missingClaimErrors` is not on that path, which is the inventory correction above.
- **Two CLI outcomes change on a board that has a non-regular file where a regular one belongs.**
  `blaze audit` exits 2 (unreadable `project.json`) or 1 (unreadable `blaze.config.json`) instead
  of never returning. Both name the file. **This cannot fire on a healthy board:** every one of
  the 4,201 tests, and the whole live board, reads regular files.
- **`liveModel`'s payload grows `unreadable`.** It is `null` on every healthy board. The only
  consumer, `views/live.mjs`, renders it; the golden page snapshot moved by exactly that branch.
- **`model/regular-file.mjs` is the shape ADR-0030 §4's rule should have had.** `classifyGitEntry`
  still uses `statSync`-then-open — correct as far as it goes, and it no longer hangs, but it
  keeps the race this module removes. Left for its own ticket rather than reopened here.
- **`kindOf`'s `isSocket` branch is unreachable from both callers** (`open` on a Unix socket
  fails `ENXIO` before `fstat`). It is kept as a label and recorded as unreachable rather than
  left looking pinned.

## Alternatives rejected

- **One blanket policy for all ten sites.** The ticket's own reason for deferring: a single
  answer is either "skip", which reintroduces BLZ-470's drop at seven of them, or "throw", which
  takes a long-lived server's route down over an optional activity feed at the eighth.
- **`statSync` then open, as ADR-0030 §4 did.** Cheaper, and it removes the hang for a file
  nobody is racing. It leaves a window in which the path becomes a FIFO between the check and
  the open — and the one site that only exists inside a window of exactly that shape is site 6.
- **Skip and report at every site, mirroring `unreadableTicketDirs`.** That channel exists
  because a generator has no way to throw a corpus-level fact to five call sites. Seven of these
  are single scalar answers with a caller standing right there; inventing a second reporting
  channel for them buys nothing an exception does not already do.
- **Let `blaze audit` raise a finding for an unreadable `project.json` instead of exiting.**
  There is no partial report to attach it to — see §4.
- **Fix every remaining `readFileSync` in `scripts/`.** Twenty-odd sit outside the shared read
  path (the groomer, the migrator, the pending ledger, the setup token). The shared path is what
  `blaze audit`, `buildIndex`, id resolution, the board view, `reconcile` and `blaze serve` all
  run through, and it is what this ticket scoped. The rest are raised as their own tickets.
