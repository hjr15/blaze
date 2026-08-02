# 5. Three-layer ID allocator

Date: 2026-08-02

## Status

Accepted (BLZ-136)

## Context

`nextId` is a filesystem scan: the highest `<KEY>-N` under `projects/<KEY>/` plus one
(`scripts/model/ids.mjs`). Zero stored state, and correct for exactly one writer with one
working tree and nothing in flight.

It is blind to every other case, and each blind spot has produced real collisions:

| Blind spot | Consequence |
|---|---|
| Another worktree on the same machine | Both scan their own `projects/`, both see the same max, both issue N+1 |
| Another machine / clone | Same, with no shared filesystem at all |
| An unmerged branch | The id exists only on a ref this checkout hasn't merged |

The failure is **silent by construction**. A ticket's filename is
`<KEY>-<N>-<slug>.md`, so two machines issuing the same id produce *different paths*
(`PROJ-700-alpha.md`, `PROJ-700-beta.md`). Git has nothing to conflict on and merges them
cleanly. Verified:

```
$ git merge b        # branch a added PROJ-700-alpha.md, b added PROJ-700-beta.md
MERGE EXIT: 0
$ ls projects/PROJ/defined/
PROJ-700-alpha.md  PROJ-700-beta.md
```

A production board accumulated four such collisions across four contiguous ids. In two of the
pairs the shadowed ticket was the non-terminal one, so the derived index was hiding open work
behind a closed ticket, and `reindex` reported nothing (fixed separately by BLZ-134, which
makes the collision loud *after the fact* — detection, not prevention; this ADR is prevention).

### Two mechanisms already killed

Recorded so neither is re-attempted naively:

1. **Git-history high-water mark.** Non-monotone. Squash-merge plus branch-delete erases the
   history that allocated an id, so a fresh clone re-issues ids that exist on disk. Also blind
   to allocations that are written but not yet committed.
2. **Committed counter file.** One file, rewritten by every allocation, so every concurrent
   `blaze new` is a merge conflict on that file — a constant defect traded for a silent one.

## Decision

Three layers, each covering a blind spot the others cannot, combined as:

```
nextId = max(disk, claims, reservations) + 1
```

then atomically reserved. All three inputs are **tree or local state, never history** — which
is what makes the result monotone under squash-merge and branch-delete.

### Layer 1 — reservation (uncommitted, per clone)

`<git-common-dir>/blaze/ids/<KEY>/<N>`, an empty file created with `O_EXCL`.

Git worktrees of one clone **share a common `.git`**, so this serialises allocation across
every worktree of that clone. It is inside `.git`, therefore never committed and never a merge
conflict surface. `O_EXCL` is the whole concurrency primitive — first writer wins, a loser gets
`EEXIST`, bumps N and retries. No lockfile, no counter, no daemon.

Resolve the path with `git -C <dataRoot> rev-parse --path-format=absolute --git-common-dir`.
Two traps, both of which silently disable this layer rather than failing:

- The bare `--git-common-dir` returns a *relative* `.git` from the main checkout and an
  absolute path from a linked worktree; without `--path-format=absolute` the two disagree.
- Run from the **process CWD** instead of `dataRoot`, it resolves whatever repo encloses the
  CWD. A `dataRoot` that is not itself a repo but sits under an unrelated one returns that
  ancestor's `.git` with **exit 0** — verified. `BLAZE_PROJECTS_DIR` makes dataRoot/CWD
  divergence a first-class case (`config.mjs:102-104`), so two sessions with different CWDs
  would resolve *different* common dirs, never contend on `O_EXCL`, and collide on one machine
  — precisely the blind spot this layer exists to close.

Therefore: resolve against `dataRoot`, and assert the resolved repo's worktree actually
contains `dataRoot`. If it does not, or `dataRoot` is not in a repo at all, **fail loud** — do
not degrade to an unshared reservation.

### Layer 2 — claim (committed, forces cross-machine conflicts)

`projects/<KEY>/.ids/<N>`, containing `<KEY>-<N> <slug>`.

This is the layer that makes a cross-machine duplicate **loud**. The path is derived from the
id *alone* — no slug — so two machines issuing the same id write the same path, and git raises
an add/add conflict instead of merging two differently-named files. Two machines issuing
*different* ids write different paths and never interact, which is precisely how this differs
from the killed counter file: **the conflict surface is per-id, not global.**

Content carries the slug so the conflict fires even when git could otherwise auto-resolve
identical blobs.

**Claims are tombstones and are never deleted** — not on renumber, not on ticket deletion, not
on a ticket moving to a terminal status. A claim records *"this id was issued"*, which is a
fact that never becomes false. Deleting one would let a retired id be re-issued and reopen the
exact hole this ADR closes.

#### The claim must travel with the ticket

A claim that never reaches upstream is worth nothing: the ticket merges exactly as silently as
it does today. Two things make this a live risk, not a theoretical one:

- `new-runner.mjs:65` records `files: [r.file]` — **the ticket only** — and `blaze commit`
  stages only recorded files (`commit-runner.mjs:131-133,145`). The allocator must append the
  claim path to that ledger entry, so batch mode commits claim and ticket **atomically**.
- A hand-run `git add projects/<KEY>/defined/ && git commit` — the obvious manual flow — stages
  the ticket without the claim.

Because neither can be fully prevented, the design does not rely on prevention. It adds an
invariant instead:

> **Every ticket file must have a corresponding claim. A ticket without one is an index
> `error`,** reported exactly like a duplicate id (BLZ-134's channel).

This one invariant is load-bearing: it converts *both* remaining escape routes into loud
failures at the next index build, including a merge that auto-resolved the claim conflict away
(below).

#### Required precondition: stop relying on the `.md` accident

Every walker that iterates `projects/<KEY>/<status>/` treats **any** subdirectory as a status
dir, and skips claim files only because they have no `.md` extension. That is an accidental
guard, not a designed one, and it is load-bearing in four places:

| Site | Guard |
|---|---|
| `scripts/model/index.mjs` `walkTickets` | `if (!f.endsWith(".md")) continue` |
| `scripts/model/ids.mjs` `maxId` | `if (!f.endsWith(".md")) continue` |
| `scripts/migrate/jira-import.mjs` `removeExisting` | none — protected only by filename-prefix luck (`PROJ-700-` never matches a claim named `700`) |
| the board repo's external `metadata_audit.py` | `if not fn.endswith(".md")` |

Board columns inherit `walkTickets`'s guard, so a claim file that ever gained a `.md`
extension would render `.ids` as a status column.

Before this ships, each walker must skip dot-prefixed directories **explicitly**, so
correctness stops depending on claim files staying extensionless forever. `removeExisting` is
the one that would actually destroy data if the assumption broke.

### Layer 3 — disk

The existing filename scan, retained unchanged. It costs nothing, and it means **no backfill
is required**: a board with thousands of pre-existing tickets and zero claim files still
allocates correctly from day one, with claims accruing only for new tickets.

### Layer 2b — remote claims, and what "offline" actually means

The three layers above are entirely local, which would make "online" and "offline" mechanically
identical and the offline specification vacuous. So allocation has one network step:

```
git fetch --quiet origin main            # then read remote claims from the fetched ref
git ls-tree --name-only origin/main -- projects/<KEY>/.ids/
```

Remote claims join the `max(...)`. This is what makes the allocator *avoid* most cross-machine
collisions rather than merely detect them: any id another machine has already published is
visible before the next one is issued. It is a tree read of one small directory — no working
tree touched, no merge.

**Offline / fetch failure: allocate anyway, and mark the claim provisional.** The claim file
gains a `provisional` marker line. Concretely:

| | Online | Offline |
|---|---|---|
| Inputs to `max` | disk, claims, reservations, **remote claims** | disk, claims, reservations |
| Claim content | `<KEY>-<N> <slug>` | `<KEY>-<N> <slug> provisional` |
| Collision risk | avoided at allocation time | possible; caught at merge / index build |

**Provisional lifecycle** — the marker is not decorative, it has exactly one consumer and one
transition: the next successful online operation (`blaze new`, or an explicit
`blaze reindex`) rewrites any provisional claim it can prove is uncontested upstream to a plain
claim. A provisional claim that *is* contested is already a merge conflict by then. Nothing
else reads the marker; it exists so an operator (and the flush's alert) can tell "this id was
issued against a possibly stale view" from "this id was issued with full knowledge".

The trade is deliberate: refusing to create tickets without a network would be a real workflow
regression, and the board already tolerates being behind (the flush is a daily merge-owner, not
a synchronous gate). Collisions are made *impossible to miss*, not impossible — the only way to
make them impossible is a synchronous global allocator, which this system does not have and
should not grow.

## What this does NOT guarantee

An adversarial pass falsified the stronger claim, so it is stated honestly here rather than
left implied.

**A merge strategy that auto-resolves conflicts defeats layer 2.** `git merge -X theirs`
(or `-X ours`) on a colliding claim exits **0** and leaves both ticket files on the board —
verified. Nothing in this design can constrain every merge path: a human's `pull` habit, a bot
unblocking itself, or GitHub's conflict-resolution UI can all take that route.

The design does not pretend otherwise. It relies on **defence in depth**: auto-resolving the
claim conflict does *not* delete the second ticket file, so both survive at distinct paths and
the next index build fails on the duplicate id (BLZ-134) or on the ticket-without-claim
invariant above. The guarantee is therefore:

> A duplicate id cannot reach the board **and stay unnoticed**. It can still be *created*; it
> cannot survive an index build.

That is a weaker and truer claim than "cannot be issued silently".

**Byte-identical concurrent creations dedupe silently.** Same title on the same day yields the
same slug and the same template body, so both the claim and the ticket file are identical
blobs and git merges them into one. The outcome — one ticket, one id — is self-consistent, so
this is an accepted edge rather than a defect; it costs one of two same-titled tickets.

## Consequences

- Cross-machine duplicate ids become a merge conflict on a specific file, naming the id.
  Nobody has to notice a subtle board anomaly.
- Same-machine cross-worktree allocation is serialised without a lock, so the ADR-0013
  constraint against worktrees-by-default can eventually be revisited on its own merits.
- Adds one small tracked file per new ticket. At this board's rate that is noise, and it buys
  the only structural place git can be made to see a collision.
- `.blaze/` is gitignored, so claims deliberately live under `projects/<KEY>/.ids/` — inside
  the tree that gets committed, and next to the project they belong to.
- The daily flush (tracked separately) must merge claim files like any other path; a conflict there is a real
  collision and must refuse-and-alert, never auto-resolve.
- A renumber leaves a gap in the id sequence. Intended: gaps are free, reuse is not.
- `projects/<KEY>/.ids/` is the repo's **only purely accretive, never-pruned artifact** —
  closer to a changelog than to a cache. Stated plainly here so nobody later "tidies it up"
  mistaking it for disposable state; deleting a claim silently re-arms the bug this ADR closes.
- **Un-migrated boards stay silent.** The cutover marker distinguishes *absent* ("this project
  has never allocated through the ledger") from *zero*. Conflating the two made every ticket on
  a board that predates claims look like it was missing one — 1805 false errors on the real
  board. Absent means the invariant does not apply until the first allocation sets a boundary.
- **Not a pattern to carry into a DB.** This is a git-era workaround for git having no atomic
  counter. The idiomatic DB realisation of "next id for KEY" is a sequence or auto-increment
  column, not one row per historical claim. At migration the claim set seeds that sequence once
  and is then retired — it must not be modelled literally as a claims table. `.ids/` stays
  entirely outside `buildIndex`, so the index remains a clean seam to a future DB.

## Validation

Every criterion is pinned by a committed test. Suite: **719 pass / 0 fail** (688 before this
work).

| # | Criterion | Test |
|---|---|---|
| ① | Fresh clone allocates above true disk max | `AC1: allocation is above the highest id on disk` |
| ② | Two worktrees, batch mode, distinct ids | `AC2: concurrent allocations across two worktrees are all distinct` |
| ③ | Same-id merge conflicts rather than merging clean | `AC3: two machines claiming one id CONFLICT; different ids do not` |
| ④ | Create + renumber in a squashed branch, delete branch, no regression | `AC4: claims survive squash-merge + branch delete` |
| ⑤ | Offline behaviour specified | `AC5` × 3 — remote read, offline degrade, clone allocates above remote |

**AC ② is proven to discriminate.** Run the identical two-worktree race against the old
scan-only allocator and 20 concurrent allocations yield **1 distinct id** (every process
returns `PROJ-1`). Against the new allocator they yield 20. The test measures the real
property, not an incidental one.

**Verified against a real board**, not only fixtures: on a 1805-ticket board the index reports
**0 false "missing claim" errors** and still catches its **4 genuine duplicate ids**.

### Adversarial findings this design absorbed

Confirmed against source and folded in above, rather than argued away:

| Finding | Status |
|---|---|
| `-X ours/theirs` silences the claim conflict | **Accepted as a limit.** Guarantee restated; caught at index build instead |
| Claim never committed — ledger records the ticket only (`new-runner.mjs:65`) | **Fixed.** Claim joins the ledger entry; ticket-without-claim is an index error |
| `--git-common-dir` silently resolves an ancestor repo for a non-repo dataRoot | **Fixed.** Resolve via `git -C <dataRoot>`, assert containment, fail loud |
| "Provisional" had no consumer, and no fetch step existed, so offline ≡ online | **Fixed.** Fetch step added; provisional lifecycle defined |
| Byte-identical concurrent creations dedupe silently | **Accepted as a benign edge**, documented above |

### Rollback tests required at implementation

Not "does it work" but "does it still fail when it should" — each must be red before the guard
lands and green after:

1. `-X theirs` a colliding claim → merge succeeds, **next `blaze reindex` must fail** naming
   both tickets.
2. Commit a ticket with its claim withheld → **index must error** on ticket-without-claim.
3. Point `BLAZE_PROJECTS_DIR` at a non-repo dir nested under an unrelated repo → allocation
   must **fail loud**, not reserve into the ancestor's `.git`.
