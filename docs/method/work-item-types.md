# Work item types — reference

An alternative type hierarchy for requirements-driven delivery: it separates
*need* (`requirement`), *design decision* (`architecture`) and *delivery*
(`feature` → `task`/`bug`) into distinct tickets with distinct lifetimes,
instead of collapsing all three into one. For the reasoning, see
[`engineering-method.md`](engineering-method.md).

This is **not** the engine's built-in default (`goal`/`epic`/`risk`/`story`/
`task`/`bug`/`subtask` — see [`guide/schema.md`](../guide/schema.md)). It is
installed with a `schema` block, the mechanism documented in
[`schema-customization.md`](../schema-customization.md).

> **Read this before adopting the model.** Three parts of it **cannot** be
> expressed through the schema block on the current engine. They are listed
> in [Engine limits](#engine-limits) at the foot of this document, with what
> each one does to a live board. The type table and the link vocabulary below
> describe the model as designed; the limits section describes what actually
> ships today. They do not yet agree.

## The relationship in one line

**A project builds workable items. `REQ` and `ADR` are the references inside that
project that those items trace to.**

Everything else in this document is detail on that sentence. Concretely:

| | Identity | Reference | Cited as | Lives at |
|---|---|---|---|---|
| Requirement | `BLZ-150` | `ref: REQ-001` | "REQ-001" | `projects/BLZ/implemented/BLZ-150-….md` |
| Architecture decision | `BLZ-202` | `ref: ADR-0001` | "ADR-0001" | `projects/BLZ/accepted/BLZ-202-….md` |
| Feature / task / bug | `BLZ-51` | — | its id | `projects/BLZ/done/BLZ-51-….md` |

Three rules follow, and they are the whole convention:

1. **The `ref` is the citation; the id is the identity.** Write "this implements
   REQ-014" and "per ADR-0011" — in ticket bodies, code comments, commit messages,
   docs, anywhere. Write the ticket id only when you mean the ticket itself.
2. **A `ref` is project-scoped.** `REQ-001` means one thing inside `BLZ` and something
   else inside `OBA`. Qualify it across projects: "BLZ REQ-001".
3. **Never reference either by path.** A ticket's status is its directory, so its path
   changes on every transition. `ADR-0011` survives that; `docs/decisions/0011-….md`
   does not.

Only `requirement` and `architecture` carry a `ref`, because only those two are
things you cite rather than things you do. Features and tasks are referenced by id,
because you point at the work itself, not at a statement about it.

## Type hierarchy

| Type | Level | Legal parents | Workflow |
|---|---|---|---|
| `goal` | 4 | (top-level) | `defined → in-progress → achieved` |
| `requirement` | 3 | `goal` | `proposed → approved → implemented → verified` (+ `rejected`, `obsolete`) |
| `architecture` | 2 | `requirement`, `goal` | `proposed → accepted → superseded` (+ `rejected`, `deprecated`) |
| `feature` | 1 | `architecture`, `requirement`, `goal` | delivery |
| `story` | 1 | `requirement` | delivery (verification axis — design deferred) |
| `risk` | 1 | `goal`, `requirement`, `architecture`, `feature` | risk |
| `task` | 0 | `feature`, `story` | delivery |
| `bug` | 0 | `feature`, `story` | delivery |

`feature` **and** `architecture` legally parenting straight to `goal` is deliberate,
not an oversight — see "Untraced work" in the method doc. Some delivery work traces to
no stated need (discovery, toil, tech debt), and some decisions predate any written
requirement — foundational choices made before anyone wrote down what the product must
do. Both are legal, and both are **counted**: the matrix publishes the untraced figure
rather than hiding it. Manufacturing a requirement to close the gap is what makes a
traceability matrix a lie.

`story`'s design (its fields and required content) is out of scope here; it keeps the
`delivery` workflow and a `requirement` parent for now.

### New workflows

`delivery` and `risk` are the engine's existing workflows, unchanged.
`requirement` and `architecture` are new — define them in the same `schema`
block, using the shape in `schema-customization.md`:

| Workflow | Status sequence | Terminal | Reopen target |
|---|---|---|---|
| `requirement` | `proposed → approved → implemented → verified` (`rejected`, `obsolete` reachable from any status) | `verified`, `rejected`, `obsolete` | `proposed` |
| `architecture` | `proposed → accepted → superseded` (`rejected`, `deprecated` reachable from any status) | `superseded`, `rejected`, `deprecated` | `proposed` |

## `feature` is a deliberate local coinage

In SAFe and Azure DevOps, `feature` sits *below* `epic`. In Shortcut it's a
subtype of `story`. Jira has no such type at all.

| System | Where `feature` sits |
|---|---|
| SAFe | Epic → Capability → **Feature** → Story (ART-sized, ≤1 PI) |
| Azure DevOps | Epic → **Feature** → Requirement → Task (fixed child of Epic) |
| Shortcut | **Feature** is a subtype of Story — below story level |
| Jira | no `feature` type |

Here `feature` occupies the altitude those frameworks call `epic` — the PR
unit. If you're coming from any of those tools, drop the "feature is smaller
than an epic" prior; it's wrong in this model.

**Sizing rule, so the wrong prior doesn't produce task-sized features:** a
feature is one integration branch, one PR, typically 4–8 child tasks. Fewer
than 3 children means you wanted a `task`, not a `feature`. **Features do not
nest** — there is no feature-of-features.

## Per-type fields

The engine's `required` array (in a type's schema entry) enforces field
*presence* only — it does not validate values against a closed set. The enums
below (`category`, `verification`, `derived`) are convention, checked by
review or a lint script, not by the engine.

### `requirement`

| Field | Values | Required |
|---|---|---|
| `ref` | `REQ-nnn` | yes — see "Stable, not contiguous" below |
| `category` | `functional \| quality \| constraint` | recommended |
| `verification` | `inspection \| analysis \| demonstration \| test` | yes |
| `derived` | `prospective \| retrospective` | yes — see the method doc's "Known limits" |

`title` and `description` (the body) are required as usual. `acceptance` is
deliberately **not** a field here — see the method doc's verification
section for why a second acceptance-criteria surface is a trap, not a
safeguard.

### `architecture`

| Field | Values | Required |
|---|---|---|
| `ref` | `ADR-nnnn` | yes — see below |

The ticket body *is* the decision record — context, decision, consequences,
alternatives considered. Nothing else is added on top of the delivery
frontmatter you'd expect.

## Reference an ADR by its designator, never by its path

An architecture ticket's status is its directory
(`projects/<KEY>/proposed/…` → `accepted/` → `superseded/`), so its path
changes on every transition. A path-based reference breaks the moment the
decision moves. `ref: ADR-nnnn` doesn't — write `ADR-0011`, not
`docs/decisions/0011-…md` or a project path, anywhere you'd cross-reference a
decision: in other tickets, in code comments, in other docs.

## `ref` is stable and monotonic, not contiguous

A rejected or obsoleted requirement **keeps its `ref`** — it does not get
reassigned or reclaimed, and the next new requirement does not fill the gap.
This matches the engine's own rule for ticket ids: gaps are free, reuse is
not. A `ref` sequence with holes in it is expected and correct; a `ref` that
got reused after a rejection is a bug.

The engine does not allocate or collision-check `ref` values for you — there
is no equivalent of the ticket-id claim file. Treat assignment the same way
you'd treat a hand-picked id: check the highest existing `ref` before writing
the next one.

## Link vocabulary

Additive to the engine's built-in link types (`Blocks`, `Relates`,
`Duplicate`, `Cloners` — untyped or weakly-typed, any ticket to any ticket):

| Link | From → To | Meaning |
|---|---|---|
| `Implements` | `feature` → `requirement` | this delivery bundle builds this requirement |
| `Addresses` | `architecture` → `requirement` | this decision responds to this requirement |
| `Verifies` | `story` or `feature` → `requirement` | evidence that this requirement is met |
| `Supersedes` | `architecture` → `architecture` | this decision replaces that one |
| `Derives` | `requirement` → `requirement` | this requirement is refined from that one |

`Verifies` deliberately allows `feature` as an origin, not just `story`: three
of the four verification methods (inspection, analysis, demonstration) need
no test artifact at all, so verification doesn't have to wait on `story`'s
design landing. See the method doc's verification section.

## Engine limits

Three parts of this model cannot be expressed through the `schema` block on
the current engine. Each was verified against source, and each needs an engine
change before the model is fully installable.

### 1. A schema block cannot remove a type

`mergeTypes` merges by spread (`{ ...defaults, ...override }`), so an override
entry can **add or replace** a type but never **delete** one. Installing this
registry therefore yields **ten** types, not eight: `epic` and `subtask`
survive alongside `feature` and `task`.

`epic: null` and `epic: undefined` are worse than useless — the key still
exists, so `isType("epic")` returns `true` and `hierarchyLevel("epic")` throws
a `TypeError` rather than the clean `unknown type` error.

Consequences: `blaze new --type epic` keeps working after you adopt the model,
`allTypes()` reports both `epic` and `feature` with no way to tell which is
current, and nothing enforces the migration beyond convention.

### 2. Existing `task`/`bug`/`story` parents become illegal unless you keep `epic`

Because `epic` survives (limit 1) but is absent from the `parentTypes` lists
above, every existing `task → epic`, `bug → epic` and `story → epic` edge
becomes parent-illegal the moment the registry resolves. On the board this
model was designed against, that was **1,599 edges**.

It does not fail loudly. `validateTicket` runs on `new`, `edit` and `migrate`
only — never on `reindex` — so the board indexes fine and the first symptom is
`blaze edit <id> --priority high` failing with `invalid parent: task cannot be
a child of epic`, an error about a field you did not touch.

**Until limit 1 is fixed, keep `epic` in the `parentTypes` of `task`, `bug`
and `story`,** and migrate the tickets before tightening the rule.

### 3. The link registry is not schema-driven

`LINK_TYPES` is a fixed `Set` in `model/links.mjs`. The ambient schema
override exposes `types` and `workflows` only — there is no `links` path. So
the five link types above cannot be installed, and:

- **`blaze link` refuses outright.** `applyLink` returns
  `unknown link type '<X>'` and never touches the ticket. This is a hard
  rejection, not a warning.
- Hand-writing the link into frontmatter does work, but `lintLinks` then warns
  `unknown link type` on **every** `blaze reindex`, permanently.

There is also no type-pair validation for links even once they are installed:
`lintLinks` checks only that the entry is an object, carries a `target:` key,
names a known type, and resolves. It will not notice `Implements` pointing
from a `goal` to a `task`. Contrast `parent`, which has both `canParent` and
cycle detection.

### A note on levels

If you keep `story` at level 1 as the table above shows, check
`requireWorklogBeforeTerminal` on your projects first. The worklog-before-
terminal guard uses `hierarchyLevel(type) <= 0` as a proxy for "is a leaf", so
moving `story` from level 0 to level 1 **silently stops requiring a worklog**
before a story reaches a terminal status — exit 0, no warning. Time roll-up
itself is unaffected: `rollUp()` walks the `parent` graph and never reads
`level`.
