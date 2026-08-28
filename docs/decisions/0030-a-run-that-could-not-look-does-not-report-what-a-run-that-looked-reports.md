# ADR-0030 — a run that could not look does not report what a run that looked reports

- **Status:** Accepted
- **Date:** 2026-08-29
- **Deciders:** Ryan Howman
- **Ticket:** BLZ-484 (the git probes), BLZ-470 (the skipped directory)

## Context

Two defects, one shape. In both, a component that **could not obtain an answer** returned
the same value it returns when it obtained the answer *"nothing"* — and every consumer
downstream, having no way to tell the two apart, reported a clean board.

**BLZ-484.** `scripts/reconcile.mjs`'s `sh()` collapsed `shResult`'s `{ok:false, status,
stderr}` into `null`. Eight `sh("git", …)` probes read that `null`, five of them through a
`|| ""` that turns it into an empty commit log or an empty ref list. The Lane J reviewer
demonstrated the consequence end to end: with the `git log --format=%x00%B` probe unable to
run, reconcile went from `moved ZZZ-1: defined → done` to `no code-bound change found —
nothing to do.` — exit 0, and not one word on stderr.

The forge half of the same file has been loud since BLZ-350 (INF-763): `gatherPrs` uses
`shResult`, classifies the failure, and the condition travels with the result to a
`FORGE UNREADABLE` line the CLI prints on every run. The git half had never been given the
same treatment, and its own comment asserted — wrongly — that every `sh` call site was a
probe "whose failure is either meaningless or already handled".

**BLZ-470.** BLZ-430 fixed a real crash: a git submodule checked out under `projects/` made
`parseTicket` throw on its vendored `README.md`, the throw escaped `walkTickets`'s generator,
and that took down `blaze audit`, `buildIndex`, the board view, id resolution and `reconcile`
together. The fix skips any directory carrying a `.git` entry — **silently**. Measured on a
constructed 8-ticket board:

| Shape | ids before | ids after |
|---|---|---|
| zero-byte `.git` file in a **project** directory | 8 | **4** |
| zero-byte `.git` file in a **status** directory | 8 | **6** |
| `chmod 000` on a project directory (`safeReaddir`'s swallowed error) | 8 | **4** |

No finding, no counter. `blaze audit` still printed `N tickets across M project(s)` and
`ok=true`; `blaze reconcile --ticket BLZ-9` still refused with *"names ticket(s) that do not
exist on this board"*. That is the same class BLZ-430 explicitly refused to introduce for
malformed `.md` files, which still throw.

This is also the class the operator shipped and had to fix on 2026-08-29 in PR #150, one
layer up: a test guard resolved a git ref against the local checkout, and in CI's shallow
single-branch clone read *"cannot look"* as *"the ref does not exist"*. Its fix is the shape
reused below.

## Decision

### 1. A git probe has three outcomes, not two

`gitProbe(errors, repoPath, args, opts)` replaces every `sh("git", …)` call site in
`reconcile.mjs`:

| `shResult` | Meaning | Treatment |
|---|---|---|
| `ok: true` | the answer | returned |
| `ok: false`, `status` is a number | `git` ran and said no | an answer **only where the question is "does this ref exist"** — opted into per call site with `exitIsAnAnswer` |
| `ok: false`, `status === null` | the process never completed — ENOENT, EAGAIN (cannot fork), ETIMEDOUT, a killing signal | **never** an answer; always reported |

`status === null` is the discriminator, and it is a property `execFileSync` already supplies.
`exitIsAnAnswer` is per call site rather than global because whether a non-zero exit is an
answer is a property of the **question**, not of `git`: `rev-parse --verify --quiet <ref>`
exiting 1 *is* the answer to "does this ref exist", while `git log <ref>` exiting 128 is
never the answer to "which tickets shipped".

**Measured before choosing which sites opt in**, across the 330 tests in
`tests/reconcile-*.test.mjs` on `0c76712`:

| Probe | failures | statuses | classified as |
|---|---|---|---|
| `rev-parse --verify --quiet <b>` | 474 | all exit 1 | an answer |
| `rev-parse --abbrev-ref origin/HEAD` | 239 | all exit 128 | an answer |
| `log <branch> ^<ref> --format=%s` | 52 | all exit 128 | see §3 |
| `rev-parse <branch>` | 52 | all exit 128 | see §3 |
| `fetch --prune --quiet` | 4 | exit 128 | reported, **warning** |
| `log <ref> --format=%x00%B` | 0 | — | reported, **error** |
| `for-each-ref` | 0 | — | reported, **error** |
| `rev-parse <default ref>` | 0 | — | reported, **error** |
| **could not run (`status === null`)** | **0** | — | reported, **error** |

Nothing in the suite relied on the laundering at the three zero-incidence sites, so making a
non-zero exit loud there costs nothing measured.

### 2. The condition travels with the result, and a run that could not look FAILS

`gitErrors` is collected per repo, unioned by `gatherProject`, and returned on
`reconcile()`'s result — the same journey `forgeErrors` already makes. The CLI prints
`GIT DEGRADED` (warning) and `GIT UNREADABLE` (error) on stderr **regardless of `--quiet`**,
by the same rule as the existing `WARNING` / `FORGE UNREADABLE` lines: `--quiet` means "print
only on change", and an unreadable probe is precisely a reason not to trust the absence of
one.

Where this departs from the forge is the exit code. An unsupported forge is a **permanent**
property of a repo, so exiting non-zero on it every run would be a nuisance an operator
learns to ignore; BLZ-350 was right to leave it at 0. A `git` that could not fork, is not
installed, or timed out is an **environment failure** — transient, actionable, and the exact
state in which "nothing to do" is a lie. So it takes the shape of the neighbouring
missing-codeRepo refusal instead:

```
reconcile: GIT UNREADABLE — `git log main --format=%x00%B` COULD NOT RUN in <repo>: … .
  Blaze never got an answer — this is not `git` saying no. …
reconcile: FAILED — 8 git probe(s) could not be completed, so what this run did NOT find
  is not evidence of an in-sync board.
```

and exit 1. The exit is split rather than unconditional: a run that *did* find changes still
prints them before exiting non-zero, because hiding real work behind a probe failure would be
a second silence.

**Both halves of that split are reachable, and a first revision of this ADR wrongly said one
was not.** It argued that every signal reconcile can turn into a change comes from `git`, so a
`git` that cannot run takes them all down and `changes` is empty by construction — therefore
the falling-through half needed a spawn failure no test could construct, and no mutation could
kill it.

**That was false, and it is this ADR's own defect class: a claim asserting more than had been
established.** It assumed probe failures are all-or-nothing. They are not — a probe fails on
its own merits while its siblings answer. Deterministic, with plain git and no spawn
manipulation:

```sh
git init -b main svc && git commit --allow-empty -m base
PARENT=$(git rev-parse HEAD) && git commit --allow-empty -m second
git branch INF-1-work                          # a branch signal — a real change
rm -f .git/objects/${PARENT:0:2}/${PARENT:2}   # break ONLY the commit-log walk
```

`rev-parse main` exits 0, `for-each-ref` exits 0, `git log main --format=%x00%B` exits 128,
and reconcile prints `GIT UNREADABLE`, `FAILED`, `would move INF-1: defined → in-progress`,
and exits 1. A missing or corrupt object is an ordinary real-world state: an interrupted
fetch, a partial clone, a damaged object store. Both halves are pinned by tests; mutating the
guard to an unconditional `process.exit(1)` turns the fall-through test red.

**A corollary that is easy to get wrong, and was.** When no default-branch ref resolves,
reconcile emits a `no-default-branch` warning whose message asserts that none of five refs
*exists*. That claim is gated on the probes having actually run: a run whose `rev-parse`
calls could not fork has established nothing of the kind, and saying it anyway would
reproduce this ADR's own defect inside its fix.

### 3. Two probes are laundered on purpose, and it is stated rather than implied

`inspect()`'s two probes ask about a branch by a name with `origin/` already stripped, so a
branch that exists only on the remote is asked about by a name no local ref answers to. That
is **reconcile's own bug, not the environment's** — 52 occurrences each in the suite, every
one an `ambiguous argument` on a stripped remote-only ref, after which `buildBranchMap` reads
`own: []` / `sameTipAsDefault: false` and silently declines to corroborate the branch on its
own evidence. Reporting it as an unreadable repo would blame the environment for a defect in
this file; fixing the ref name changes which branches corroborate, which is a behaviour change
outside BLZ-484. So their non-zero exits stay silent, the reason is written beside them, and
the underlying defect is raised as its own ticket. A probe that could not **run** at those
sites is still reported.

### 4. The channel for a skipped directory is a NAMED READ, not a generator parameter

`walkTickets` is a generator with five call sites — `fsReadStorage`'s `getTicket`,
`listChildren`, `blockersOf` and `listTickets`, plus `buildIndex` — and a generator has no
out-of-band return channel a `for…of` can see. Three designs were considered:

1. **A sentinel yielded among the tickets.** Rejected. The three driver operations that
   filter on frontmatter drop it silently, so id resolution, the parent drill and the
   blocker check would still answer "nothing there" — the defect, surviving its own fix —
   and the two that do not filter would carry it into `rows` as a garbage ticket.
2. **An `onSkip` callback on `walkTickets`.** Rejected. It has to be threaded through all
   four driver operations to serve two callers, changing the read-seam contract for every
   consumer, and a caller that passes nothing is silently back to today's behaviour — a
   default that reintroduces the bug is not a fix.
3. **A named read.** Accepted. `unreadableTicketDirs(projectsDir)` answers *"which
   directories under this board could not be read, and why"*. What a skipped directory is —
   a fact about the **corpus**, not about any ticket in it — is a named question, which is
   the shape ADR-0009 says a read must take. It reads directories only and opens no `.md`,
   costing one `readdir` per project and per status directory (103 on the live board) against
   the ~2,700 files the ticket walk itself reads.

The skip **predicate** (`classifyGitEntry`) is shared with the walk rather than re-derived,
because two implementations of one predicate is how this drift keeps reappearing (INF-735;
`gatherPrs`'s `recordablePr` counter one layer up). The **traversal** is still written twice,
so a ground-truth test pins the two against each other: the directories the reporter names
must be exactly the directories the walk lost tickets from.

`classifyGitEntry` distinguishes five shapes rather than reporting "a repository", because a
zero-byte `.git` file is not a repository and telling an operator to go looking for one is a
second wrong claim: `nested-repo` (a `.git` directory), `nested-repo-pointer` (a `gitdir:`
file, what `git submodule add` writes), `git-file-empty`, `git-file-unrecognised`, and
`git-entry-not-a-file`. A directory that could not be listed at all is `directory-unreadable`.

**A read path may never block, and that outranks reporting.** The first cut of
`classifyGitEntry` opened any non-directory `.git` with `readFileSync`. On a FIFO that blocks
forever — no error, no timeout, no exit — and this predicate sits on the path `blaze audit`,
`buildIndex`, id resolution, the board view and `reconcile` all share, `blaze serve` included.
BLZ-430's stat-only predicate could not hang, so this was a regression introduced *by* the fix
for BLZ-470, in the function whose whole purpose is to stop a board going quiet. A hang is
strictly worse than a wrong sentence: nothing reports, nothing exits, nothing times out. So
the rule is `st.isFile()` before any open, the shape is skipped exactly as BLZ-430 skipped it,
and it is named rather than silent.

**A hang can only be pinned from outside the process, and the first attempt to pin it was
itself an overstatement.** The tests were written in-process with `node:test`'s `timeout`
option and a comment claiming that made a reintroduced hang fail rather than wedge the run.
That is false: `timeout` is enforced on the event loop, and a blocking synchronous
`readFileSync` never yields to it. Measured directly — a `{ timeout: 2000 }` test reading a
FIFO had to be killed with SIGTERM from outside, and re-applying the mutant wedged the
mutation runner for its full 300-second cap. So every case for this shape runs in a **child
process with a hard wall-clock limit**, and asserts on the child's `signal`: a killed child is
the hang, reported as a failure rather than as a suite that never finishes.

Two **pre-existing** instances of the same shape were found on the same path while checking
this and are left for their own tickets rather than fixed as a side effect:
`walkTickets`'s `readFileSync(file)` for a `.md` entry (a FIFO named `X.md` in a status
directory hangs the walk on `0c76712`, before this branch) and `audit-runner`'s
`readFileSync(project.json)` (both confirmed hung at an 8-second timeout). Neither is a
one-line fix: making them merely skip would reintroduce exactly the silent drop BLZ-470
exists to close, so each needs a decision about what it reports.

### 5. The count says which it is

`blaze audit` raises `unreadable-ticket-directory` — **HARD**, and the ticket count changes
its own wording:

```
  6 tickets across 2 project(s) — a FLOOR, not a total: 1 directory could not be read
```

HARD is licensed by measurement, per BLZ-353. At blaze-pm `BLZ-305-v4-spine` on 2026-08-29,
**0 of the 103** project and status directories holding its **2,736** tickets carry a `.git`
entry of any shape, and **0** are unlistable — so shipping this hard fails no existing board.
It is also not a fill queue: there is nothing to work through, only a directory to move or a
stray `.git` entry to delete. Every other hard kind says *a ticket in the corpus is wrong*;
this one says *the corpus you just audited is not the corpus*, and a soft finding cannot
change `ok`, so `blaze audit` would exit 0 over a board whose ticket count it had no way to
compute.

`reconcile` raises the same kind as a `NEEDS ATTENTION` finding, unconditionally on every run
— filtered or not — for exactly the reason BLZ-406 raises `project-mismatch` that way: a
directory the walk skipped is invisible to **every** scope, so gating the report on scope
would make it the silent skip it exists to report.

## Consequences

- A `git` that cannot fork now fails `blaze reconcile` loudly instead of producing a clean
  board. In an environment without `git` at all, `reconcile` exits 1 every run — correct, and
  the condition is named on the first line.
- `reconcile()`'s result grows `gitErrors`. Consumers that render `forgeErrors` (the
  dashboard, the preview JSON) can render this with the same code shape; none is required to.
- **`unreadableTicketDirs` belongs on the read seam** as a sixth named driver operation, so a
  database driver answers it with the empty list it structurally is, and so
  `scripts/views/data.mjs` can report it on the board page. Neither file was in the set this
  change was scoped to, so until it moves, a database-fed index and the board view report
  nothing here — the right answer for a database, and wrong only in that it is decided by
  which module you called rather than by the driver.
- `inspect()`'s stripped-ref defect (§3) is now written down and measured, and is left for
  its own ticket rather than fixed as a side effect.

## Alternatives rejected

- **Make `sh` itself throw on failure.** It has ten call sites with three different notions
  of what a failure means; one blanket answer is how the current comment came to assert
  something false about all of them.
- **Report every non-zero git exit.** Measured at 713 lines per suite run from the two ref
  probes alone. A gate that fires on the fill queue is a gate people learn to skip
  (`scripts/model/audit.mjs`'s own warning), and it would bury the one line that matters.
- **Exit 0 on an unreadable git probe, like the forge does.** The forge's condition is
  permanent; this one is transient and actionable, and "nothing to do" under it is false.
- **Skip the directory silently but count it.** A count with no name sends an operator
  hunting; the finding names the directory, the shape found, and what to do about it.
