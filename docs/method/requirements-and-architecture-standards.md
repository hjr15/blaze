# Requirements and architecture standards

What `engineering-method.md` establishes as a house method, this document takes toward a
schema: concrete fields, concrete validation rules classified by enforcement mechanism, and
concrete default templates, each traced to a cited standard or a measured failure. It does
not replace `engineering-method.md` — it extends it in three places and corrects it in one,
named explicitly below — and it treats [ADR-0015](../decisions/0015-traceability-enforcement-shape-rules-block-coverage-rules-gate.md)'s
shape/coverage/gate taxonomy as binding, generalizing it from links (where the ADR scoped it)
to field content and document structure (which the ADR left to "the requirements-practices
work, where they belong" — this is that work).

**A clause-number caveat, stated once, honestly.** IEEE/ISO standards text is not freely
republishable; clause numbers below for 29148 and 42010 are taken from `engineering-method.md`'s
existing citations where it already cites them, extended by consistent numbering where it
doesn't, and cross-checked against secondary literature (INCOSE summary material, academic
papers on the standard) where primary text wasn't available to this research pass. Treat any
clause number not already used elsewhere in this repo as "consistent with the standard's
structure, not verified character-for-character against a purchased copy" — and verify before
using a clause number in a compliance claim to a third party.

## Where this document stands relative to `engineering-method.md`

**Extends, without contradiction:**
1. Elevates EARS from "optional style note" to a system-offered selectable scaffold (below)
   — the method doc calls EARS "a reasonable template if you want one" but doesn't operationalize
   it; this document does.
2. Fills a real gap: `engineering-method.md` cites 42010 exactly once, for cl. 5.8 (rationale is
   optional). It never uses 42010's actual apparatus — stakeholders, concerns, viewpoints,
   views. This document adds a minimal, non-bureaucratic version of that apparatus (§"Architecture
   — document level" below), because implementing even a thin slice of 42010 is a differentiator
   the shortcomings register names directly (no reviewed incumbent implements it).
3. Adds architecturally-significant-requirement (ASR) and quality-attribute-scenario (ATAM)
   concepts that connect `requirement` (category: quality) to `architecture` — a link the method
   doc's "when architecture is required" section doesn't quite reach (see disagreement below).

**Disagrees, explicitly:**

> `engineering-method.md`, "Unambiguous… Any of these in a requirement's text is a signal to
> rewrite it, not a style preference."

That sentence describes the right standard (29148 §5.2.7) and then declines to enforce it —
banned-construction checking is left as prose guidance a human is supposed to apply. **This
document proposes making it a hard block, not a preference.** The measured-completion table
in the method doc's own "Known limits" section is the argument for this, applied against
itself: return-visit obligations fail (15%, 0%), but obligations satisfied *at the moment of
creation, while the author is present* succeed (~93%). A banned-word check fires at exactly
that moment — the same moment `blaze new` already succeeds at capturing fields. Leaving it as
a preference is choosing the failure mode the method doc itself measured, when the successful
mode is sitting right there. See RQ-4 below for the concrete mechanism, which reuses a pattern
Blaze already ships (`--reason` override on `requireLabels`/`requireComponents`) rather than
inventing new UI.

**One addition to "when architecture is required":** the three bullets there (alternative
rejected / expensive to reverse / constrains later requirements) miss the case ATAM and the
ASR literature center on — a decision made *to hit a quality-attribute target*, where no
alternative was ever formally minuted because the target dictated the shape. A caching layer
added "to hit p99 latency" often never gets an ADR, precisely because nobody debated
alternatives out loud — the number drove the design directly. That is still architecturally
significant by the ASR definition (Rozanski & Woods: high impact on the architecture, high
stakeholder value) even when the method doc's first bullet doesn't fire. Add a fourth bullet:

- **A quality-attribute target drove the shape.** If a `quality`-category requirement carries
  a quantified response measure and meeting it required a structural choice, write the ADR
  with the quality-attribute scenario (below) as its rationale — even if no alternative was
  ever on the table.

## Field sets

### Requirement — item level

| Field | Type | Required | Allowed values | Source |
|---|---|---|---|---|
| `ref` | string, `REQ-nnn` | **Yes** | monotonic, never reused | Convention (work-item-types.md); stable identity is 29148 §4.1's "unique identifier" |
| `title` | string (frontmatter) | Yes | — | Engine default |
| `description` | body text | Yes | one-line statement + rationale | Engine default; shape below |
| `category` | closed enum | **Recommended → propose Required** | `functional \| quality \| constraint` | 29148 §5.2.8.3 (Quality as distinct type); ISO/IEC 25010 for the taxonomy behind `quality` |
| `quality_attribute` | closed enum | Recommended, only when `category: quality` | `performance-efficiency \| compatibility \| interaction-capability \| reliability \| security \| maintainability \| flexibility \| safety` | **ISO/IEC 25010:2023** top-level characteristics, `functional suitability` excluded (that is `category: functional`). The 2023 edition adds **Safety** as a characteristic in its own right — subcharacteristics: operational constraint, risk identification, fail safe, hazard warning, safe integration — and renames Usability to **Interaction Capability** and Portability to **Flexibility**. |
| `verification` | closed enum | Yes (already shipped) | `inspection \| analysis \| demonstration \| test` | 29148 §6.5.2.2 |
| `derived` | closed enum | Yes (already shipped) | `prospective \| retrospective` | Convention, addressing 29148 §3.1's baseline concept honestly (see method doc's "Known limits") |
| `goal` (parent) | ticket link | Yes | must resolve to a `goal` | Type hierarchy |

**Not added, deliberately:** `acceptance` — already ruled out by `work-item-types.md` ("a
second acceptance-criteria surface is a trap, not a safeguard"), and this document agrees:
`verification` + a resolving `Verifies` link **is** the acceptance criterion, stated once.
Also not added: an `owner` field distinct from `assignee` (29148 §5.2.8.2's Owner concept) —
a solo operator collapses author/owner/approver into one person, the same argument
`engineering-method.md` already makes for `approved`, extended here for consistency.

### Requirement — document level

Blaze has no "requirements document" ticket type, and this document does not propose one —
a new type is exactly the kind of structural addition that should be argued for explicitly
(the tie-breaker in `engineering-method.md`'s closing section) and there's a cheaper answer:
**the document is the aggregate of `requirement` tickets under one `goal`**, plus a short
plain file that carries what no single ticket can: 29148 §5.2.6's *set* characteristics
(Complete, Consistent, Feasible, Comprehensible, Able to be Validated — echoed by INCOSE's
C10–C14) apply to the set, not to any one item, and need somewhere to live.

| Field | Type | Required | Allowed values | Source |
|---|---|---|---|---|
| `scope` | text | Yes | what's in/out for this goal's requirement set | 29148 SRS/SyRS outline, Scope clause |
| `stakeholders` | list of {role, concern} | Yes | free text per row | 29148 §5.2.2 stakeholder requirements; 42010 stakeholder/concern pair |
| `baseline_status` | closed enum | Yes | `draft \| baselined \| superseded` | 29148 §6.6 baseline/change-control concept — **note this is distinct from any one requirement's workflow status**; baselining freezes the *set's text* for change control, it does not mean every requirement is implemented |
| `baseline_date` | date | Required once `baselined` | — | Audit trail, same logic as `approved`'s git-commit trail |
| `traceability_summary` | computed, not hand-written | N/A — generated | counts: implemented/verified/rejected/obsolete/untraced | Mirrors `engineering-method.md`'s existing "count it, don't hide it" traceability stance |

`baseline_status` is deliberately **not** a per-requirement field. Putting it on the document
avoids duplicating `approved` (which the method doc already positions correctly as a
per-item, git-audited commitment marker) with a second, document-level notion of the same
thing. One concept, one field, at the level it actually describes.

### Architecture — item level (the ADR ticket body)

Grounded in Nygard's original four sections, trimmed against MADR's additions, with MADR's
people-role fields (`decision-makers`, `consulted`, `informed`) deliberately dropped — a solo
operator collapses those roles exactly the way `engineering-method.md` already argues for
29148's Owner concept on `approved`. Consistency, not an oversight.

| Field | Type | Required | Allowed values | Source |
|---|---|---|---|---|
| `ref` | string, `ADR-nnnn` | Yes (already shipped) | monotonic, never reused | work-item-types.md |
| **Status** | *(not a body field)* | — | — | Already the ticket's workflow status (`proposed/accepted/rejected/superseded/deprecated`). MADR restates status in the body because most MADR consumers have no native ticket-workflow field to read it from — Blaze does, so restating it is a second surface for one fact, the exact trap `work-item-types.md` names for `acceptance`. **Do not add a `Status` heading to the body.** |
| `Context` (body section) | text | Yes | non-trivial length | Nygard: "a set of forces" |
| `Decision` (body section) | text | Yes | non-trivial length | Nygard: "stated in full sentences, active voice" (style guidance — advisory, not machine-checkable) |
| `Consequences` (body section) | text | Yes | non-trivial length | Nygard: "all consequences… not just the positive ones" |
| `Alternatives Considered` (body section) | text | Recommended, not required | — | MADR's "Considered Options"; ties directly to `engineering-method.md`'s own first test for whether an ADR was warranted — **an ADR with this section empty is a signal to ask whether it should exist at all** |
| `Quality Attribute Scenario` (body block) | structured, optional | Recommended when `Addresses` a `quality`-category requirement | six-part ATAM shape, below | ATAM (Kazman, Klein, Clements) |
| `viewpoint` | closed-ish tag | Optional | one of the project's declared viewpoints (below) | 42010 Viewpoint concept |

### Architecture — document level (`docs/architecture.md`, the 42010 Architecture Description)

This is the gap-fill: a thin, deliberately informal slice of 42010's apparatus, living as one
plain file per project (or per repo, matching the user's own standing convention that durable
decisions live in `architecture.md`/ADR/README, not transient specs).

| Field | Type | Required | Allowed values | Source |
|---|---|---|---|---|
| `stakeholders` | list of {role, concerns} | Yes | free text | 42010 Stakeholder/Concern |
| `viewpoints` | list of names | Yes | project-declared, e.g. `Functional, Deployment, Data, Security` | 42010 Viewpoint |
| `views` | list of {viewpoint, location} | Recommended | pointer to a diagram/doc section, not inline duplication | 42010 View |
| `correspondence_rules` | plain-English list | **Advisory only, optional** | free text | 42010 Correspondence Rules — kept informal; see "what we do not adopt" |
| `adr_index` | computed, not hand-written | N/A — generated | table of `ref`, title, status | Mirrors `traceability_summary`'s "generated, not authored" pattern |

## EARS as selectable templates

Not mandatory — `engineering-method.md` is right that 29148 §5.2.4 NOTE 2 permits user-story
form too. What changes here is *offering* EARS as the default scaffold `blaze new --type
requirement` starts you from, with user-story as the named alternative, rather than leaving
the author to remember EARS exists. Syntax (Mavin et al., the EARS originators, via
[alistairmavin.com/ears](https://alistairmavin.com/ears/)):

| Pattern | Keyword | Syntax | Example |
|---|---|---|---|
| Ubiquitous | none | `The <system> shall <response>` | The mobile phone shall have a mass of less than XX grams. |
| State-driven | `While` | `While <precondition>, the <system> shall <response>` | While there is no card in the ATM, the ATM shall display "insert card to begin". |
| Event-driven | `When` | `When <trigger>, the <system> shall <response>` | When "mute" is selected, the laptop shall suppress all audio output. |
| Optional feature | `Where` | `Where <feature is included>, the <system> shall <response>` | Where the car has a sunroof, the car shall have a sunroof control panel. |
| Unwanted behaviour | `If`/`Then` | `If <trigger>, then the <system> shall <response>` | If an invalid card number is entered, then the ATM shall display "please re-enter". |
| Complex (compound) | combination | `While <precondition>, When <trigger>, the <system> shall <response>` | While the aircraft is on ground, when reverse thrust is commanded, the engine control system shall enable reverse thrust. |

## The quality-attribute scenario as a selectable template (`category: quality`)

Six parts (Kazman/Klein/Clements, ATAM), offered as the structured body when
`category: quality` — the direct NFR counterpart to EARS, and the second "template the
system can offer" the operator's brief names as highest-value:

```
REQ-nnn — <one-line summary>
  source:           <who/what generates the stimulus>
  stimulus:         <the condition arriving at the system>
  environment:      <conditions when it arrives — normal load, startup, overload...>
  artifact:         <the part of the system stimulated>
  response:         <what the system does about it>
  response_measure: <the quantified, testable threshold — this is what makes it verifiable>
```

`response_measure` is the field that turns a quality requirement from a wish into something
`verification: test` or `analysis` can actually check — its presence is machine-checkable
(is the field non-empty), its *quality* (is the number meaningful, not rubber-stamped) is not.

## Quality rules

Classified per [ADR-0015](../decisions/0015-traceability-enforcement-shape-rules-block-coverage-rules-gate.md)'s
taxonomy, generalized here from links to field content and document structure:

- **Shape rule** — decidable from the ticket's own content alone, no query beyond it. Hard
  block at write time.
- **Gate** — either needs a query across more than one ticket (ADR-0015's original sense,
  "coverage"), *or* is a shape-like check that would be legitimately false during drafting
  and so belongs at a specific transition rather than every keystroke (an extension of
  ADR-0015's sense, flagged for the operator below). Blocks only at the named action.
- **Advisory** — no query or check reliably decides it. Reported or flagged, never blocks.

### Requirements

| ID | Rule | Checks | Class | Machine-checkable? |
|---|---|---|---|---|
| RQ-1 | Required fields present | `ref`, `verification`, `derived`, non-empty title/body | Shape (already shipped) | Yes, fully |
| RQ-2 | Closed-set field validity | `category`, `quality_attribute`, `verification`, `derived` values are in their enums | Shape — **needs an engine change**: today `required` checks presence only, not value (`schema.md`); this is the concrete gap to close | Yes, fully, once the engine supports it |
| RQ-3 | `ref` format, uniqueness, monotonic | `REQ-nnn`, never reused, never collided | Shape — **needs an engine change**: today `ref` allocation is hand-managed, unlike ticket ids which have a claim file | Yes, fully |
| RQ-4 | Banned-construction lint | 29148 §5.2.7's list (superlatives, "user friendly", vague pronouns, "and/or", "provide support"/"including but not limited to", "if possible"/"as appropriate", "all"/"always"/"never") appearing in the one-line requirement statement | Shape, hard block **with mandatory `--reason` override** (extends the existing `requireLabels`/`requireComponents` `--reason` UX from a soft warning to an actual gate — see the disagreement section above for why this crosses from advisory to hard-block) | Yes, by word/phrase list — cannot detect every ambiguity, only these named constructions |
| RQ-5 | Link type/endpoint validity | `Implements: feature→requirement`, `Addresses: architecture→requirement`, `Verifies: {story,feature}→requirement`, `Supersedes: architecture→architecture`, `Derives: requirement→requirement` | Shape (this is the typed-link meta-model table ADR-0015 point 1 deferred to "the requirements-practices work" — this is that table) | Yes, fully |
| RQ-6 (gate) | `requirement → verified` requires a resolving `Verifies` link | The transition is refused without one | Gate, on the `verified` transition | Yes, fully — link either resolves or it doesn't |
| RQ-7 (gate) | `goal → achieved` requires every child `requirement` to be in a terminal status | Query across all children of the goal | Gate, on the `achieved` transition — closes the exact gap `engineering-method.md` names as the reason `requirement` exists as its own layer ("is this finished?") | Yes, fully |
| RQ-8 (advisory) | Necessary | Would deleting it make the product *wrong*? | Advisory | No — pure judgement |
| RQ-9 (advisory) | Singular | Contains "and" joining two capabilities | Advisory (flagged, not blocked) — locally decidable by regex, but false-positive risk on legitimate compound phrasing is too high to hard-block ("search and filter" as one integrated capability vs. two disguised requirements looks identical to a regex) | Assisted — a linter can flag it, only a human can rule on it |
| RQ-10 (advisory) | Verification method is the *right* one, not just present | Did they pick `demonstration` when the claim really needs `test`? | Advisory | No |
| RQ-11 (advisory, reported) | Architecture coverage | % of requirements with no `Addresses` link and no stated reason one isn't needed | Advisory, reported the way `engineering-method.md` already reports untraced `feature`s — a count, not a gate, because most requirements legitimately need no ADR | Yes, the count; no, the judgement of whether each gap is a real gap |

### Architecture

| ID | Rule | Checks | Class | Machine-checkable? |
|---|---|---|---|---|
| AQ-1 | `ref` format, uniqueness, monotonic | Same as RQ-3 for `ADR-nnnn` | Shape — same engine gap as RQ-3 | Yes, fully |
| AQ-2 (gate) | Structural completeness on `proposed → accepted` | Body contains non-empty `Context`, `Decision`, `Consequences` sections | Gate, not write-time shape — a `proposed` decision must be draftable with sections missing, so this is exactly the "shape check deferred to a transition" extension flagged below; blocking it at every edit would make legitimate half-written drafts unsaveable | Yes, by heading + minimum length — cannot judge whether the content is *good*, only present |
| AQ-3 | `Supersedes`/`Addresses` link type/endpoint validity | Same mechanism as RQ-5 | Shape | Yes, fully |
| AQ-4 (advisory) | Was this decision actually key (cl. 5.8) | The three-bullet-plus-one test in `engineering-method.md` and above | Advisory | No |
| AQ-5 (advisory) | `Alternatives Considered` empty | Flags "reconsider whether this needed an ADR" per the method doc's own first test | Advisory, but machine-**assisted**: presence/absence of the section is checkable, the judgement it prompts is not | Assisted |
| AQ-6 (advisory) | Consequences named honestly (not just upside) | Did they list a downside? | Advisory | No |
| AQ-7 (advisory) | Stakeholder/concern completeness in `architecture.md` | Did we miss a stakeholder class? | Advisory | No |

**A note on AQ-2, for the operator.** ADR-0015 frames "gate" around coverage rules — checks
needing a corpus-wide query, undecidable from one ticket alone. AQ-2 is not that: it's fully
decidable from the one ticket's own body. It's placed at a gate anyway because the *timing*
matters as much as the *decidability* — a completeness check that fires on every edit of a
`proposed` decision would punish drafting, the same failure mode ADR-0015 already rejected
for coverage rules ("it makes ticket creation fail when the requirement... doesn't exist yet").
**This is a second, distinct reason to use a gate instead of write-time blocking, beyond the
one ADR-0015 names**, and it's worth deciding explicitly whether to fold it into ADR-0015 or
record it as its own decision (ADR-0016) — flagged in "for the operator" below.

## Default templates

### New requirement (`blaze new --type requirement`, body scaffold)

```markdown
<!-- EARS pattern — delete the four you don't need -->
The <system> shall <response>.                                   <!-- ubiquitous -->
While <precondition>, the <system> shall <response>.             <!-- state-driven -->
When <trigger>, the <system> shall <response>.                   <!-- event-driven -->
If <trigger>, then the <system> shall <response>.                <!-- unwanted behaviour -->

## Rationale
<why this is necessary — deleting it would make the product wrong, not merely worse>
```

For `category: quality`, scaffold the six-part scenario instead (§"quality-attribute scenario"
above).

### New architecture decision (`blaze new --type architecture`, body scaffold)

```markdown
## Context
<the forces at play — technical, business, constraints>

## Decision
<what was decided, in full sentences, active voice>

## Consequences
<what follows — positive, negative, and neutral. All of them, not just the upside.>

## Alternatives Considered
<what else was on the table, and why it lost. Empty here is a signal to ask whether
this decision needed an ADR at all.>
```

### `docs/architecture.md` (once per project, the 42010 Architecture Description)

```markdown
# Architecture — <project>

## Stakeholders and concerns
| Stakeholder | Concern |
|---|---|
| ... | ... |

## Viewpoints in use
- Functional
- Deployment
- Data
<!-- add only the viewpoints this project actually needs distinct views for -->

## Views
| Viewpoint | Where it lives |
|---|---|
| ... | ... |

## Decisions
<!-- generated: table of ADR ref, title, status -->
```

### Requirements register (per `goal`, `docs/requirements/<goal-slug>.md`)

```markdown
# Requirements — <goal title>

**Scope:** <what's in/out>
**Baseline:** draft
**Stakeholders:**
| Role | Concern |
|---|---|

<!-- generated: requirement list by category, traceability summary -->
```

## What we deliberately do not adopt, and why

1. **The full 29148 SRS/SyRS document outline as a mandatory structure.** Its clause-by-clause
   annex (Scope, References, System Overview, System Requirements, Verification, Traceability,
   Appendices) is built for contractual and regulatory delivery. Mandating it here would be
   bureaucracy the operator's own PM argument (CS-039) exists to reject. We take only the
   pieces that pay for themselves — Scope, Stakeholders, a traceability count.
2. **INCOSE's full 42-rule / 14-characteristic checklist as a gate.** `engineering-method.md`
   already condensed nine characteristics to five rules for exactly this reason — "nine is
   accurate and not memorable." Forty-two is worse. The full list is a good *reference* for
   what a future linter's word-list draws from; it is not a checklist anyone should apply by
   hand per requirement.
3. **42010's Correspondence Rules as a formal, computable constraint system.** The standard
   lets you define machine-checkable relations between architecture elements across views.
   Building that engine is real work with a real payoff for large, multi-viewpoint systems —
   and it is also exactly the kind of "everyday configuration requires programming" trap
   CS-222 names. `correspondence_rules` above is deliberately a plain-English list, advisory
   only, not a rule engine.
4. **A mandatory ADR per requirement.** Already correctly rejected in `engineering-method.md`
   citing 42010 cl. 5.8 directly — this document agrees without reservation.
5. **Any rule expressed as a script the author must write** (DXL, Java, Velocity, or
   equivalent). Every rule in this document is expressible as: a JSON schema entry, a
   plain-word list, or a named CLI flag/gate. CS-222 names this as a defect in three
   incumbent tools; nothing here should require a non-programmer to open an editor and write
   code to configure their own board.
6. **A formal specification language for requirements** (SysML, Z, or similar contract
   notation). Precise, and unusable by the CS-039 persona this product exists to serve.
   EARS and the ATAM scenario are the ceiling here — natural-language templates, not formal
   logic.
7. **A second acceptance-criteria surface.** Already rejected in `work-item-types.md`; this
   document's `Verifies` link + `verification` method field is the single surface, not a
   second one layered on top.
8. **The full ATAM evaluation method** — utility trees, multi-day stakeholder workshops,
   scenario-brainstorming sessions. We take only the six-part scenario **template** as an
   authoring aid for one requirement at a time. Running an actual ATAM exercise is a
   consulting engagement, not a field on a ticket.
9. **29148 §6.6's formal change-control process** (Change Control Board, impact-assessment
   forms). `baseline_status` + git history is the audit trail, matching the same logic
   `engineering-method.md` already applies to `approved` — a solo or small team doesn't need
   a board to approve a diff a repo already shows.
10. **A separate, maintained requirements-to-tests cross-reference matrix as its own
    artifact.** The `Verifies` link plus RQ-6's gate already produces this as a query over
    existing data. A second maintained document duplicating it is the acceptance-criteria
    trap again, one level up.

## For the operator to decide

1. **RQ-2/RQ-3/AQ-1 need an engine change** (enum validation on frontmatter fields beyond
   presence; a `ref` allocator/claim-file analogous to the ticket-id one). These are the
   concrete "make it native" asks in this document — without them, several rules marked
   "shape, hard block" here are only convention, checked by review, same as today.
2. **RQ-4's escalation from advisory prose to a hard block with mandatory `--reason`** is
   the single biggest behavior change proposed here. It's argued above from the method doc's
   own measured data, but it changes what `blaze new` does today, and the operator should
   confirm before it ships that way rather than discover it live.
3. **RQ-6 and RQ-7 mean `verified` (on `requirement`) and a gated `achieved` (on `goal`)
   actually ship in v4**, reversing their current "designed but not shipped" status in
   `schema.md`. They were held back before because they were return-visit gates with nothing
   enforcing them. Attaching a hard gate changes that calculus — but it's a reversal of a
   standing decision, worth an explicit yes.
4. **AQ-2's justification for using a gate is not the one ADR-0015 names** (timing/drafting,
   not corpus-coverage). Worth deciding whether that's folded into ADR-0015 as a second
   justification for the gate mechanism, or written up as ADR-0016.
5. ~~**`quality_attribute`'s enum (ISO 25010:2011 vs. 2023)**~~ — **SETTLED 2026-08-22: use
   ISO/IEC 25010:2023.** The draft chose 2011 on the grounds it is more widely cited. That
   argument loses to a stronger one: the 2023 edition adds **Safety** as a top-level
   characteristic, and the target market is firms doing DO-178C, ISO 26262 and IEC 62304
   work. Shipping a quality model with no Safety characteristic to a safety-critical
   audience is indefensible, and "the older list is better known" does not survive contact
   with that. Usability becomes Interaction Capability and Portability becomes Flexibility;
   both are recognisable enough that the recognition argument costs us little.