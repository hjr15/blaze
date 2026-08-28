# ADR-0026 — shipped documents link out by URL; `docs/` stays unshipped

- **Status:** Accepted
- **Date:** 2026-08-29
- **Deciders:** Ryan Howman
- **Ticket:** BLZ-474 (with BLZ-460, BLZ-473, BLZ-478)

## Context

`package.json`'s `files` whitelist ships `scripts/`, `AGENTS.md`, `README.md` and
`LICENSE`. It ships **zero** files under `docs/`, and `tests/package.test.mjs` asserts
that on every run (`assert.ok(!f.startsWith("docs/"))`).

Both shipped documents nonetheless linked into `docs/` with **relative** paths. Measured
on this tree before the change: **9** relative `docs/` link instances in `AGENTS.md` (7
distinct targets; `docs/schema-customization.md` and
`docs/guide/how-it-works.md#two-rules-that-keep-the-board-honest` each appear twice) and
**11** in `README.md` — 20 in total. Every one of them is dead for anyone who installed
`@hjr15/blaze-board`: the file the link points at is not in the tarball.

BLZ-460 had already met this defect in one place. `scripts/config.mjs`'s key-rule pointer
was a bare `docs/decisions/0025-….md` path emitted inside a refusal message, so an
installed user following the refusal reached nothing. BLZ-460 replaced it with a GitHub
blob URL and pinned it — but deliberately fixed only that one pointer, because fixing
`AGENTS.md`'s other nine while `README.md`'s eleven stayed broken would leave the two
shipped documents inconsistent, and `README.md` was not that lane's file.

So this is **one decision, not twenty edits**, and it has to answer BLZ-478 in the same
breath: the BLZ-460 guard accepts either an absolute URL *or* a path the tarball ships,
and the second arm is unreachable while `tests/package.test.mjs` forbids `docs/`.

## Options

1. **Ship `docs/`.** Add `docs/` (or a subset) to `files` and delete
   `tests/package.test.mjs`'s assertion. Relative links become live for an installed
   user.
2. **Convert all 20 to URLs.** Keep `docs/` out of the tarball; every outbound link in a
   shipped document becomes a canonical `https://github.com/hjr15/blaze/blob/<ref>/<path>`
   URL.

## Decision

**Option 2. Every outbound link in a shipped document is an absolute URL, and `docs/`
stays out of the tarball.**

Three reasons, in order of weight:

1. **`docs/` is not all publishable.** It holds `docs/superpowers/plans/` and
   `docs/superpowers/specs/` — session kickoffs, hand-off briefs and internal work orders
   naming lanes, reviewers and absolute paths on the maintainer's machine. Shipping the
   tree wholesale publishes those to every installer. Shipping a curated subset means the
   `files` whitelist and the link set have to be kept in agreement by hand forever, and a
   link added to an unshipped subdirectory reintroduces exactly this defect silently.
2. **A URL is reachable from more places than a relative path is.** The same pointer works
   in the tarball, in a `node_modules` copy, in the rendered npm page and in a terminal
   that printed it inside an error message. `scripts/config.mjs`'s refusal already needs
   that property, and BLZ-460 already chose it there; option 2 is the consistent
   generalisation rather than a second convention.
3. **It costs nothing at publish time.** Option 1 grows the tarball and the surface that
   has to be reviewed before every release.

The trade this accepts, stated plainly: a URL can name a **dead ref**, which a relative
path cannot. That is BLZ-473, and it is closed in the same change — the guard now resolves
the ref against the repository rather than accepting any `blob/<anything>/`.

## Consequences

- All 20 links in `AGENTS.md` and `README.md` are canonical blob URLs on `main`.
- `tests/package.test.mjs`'s "docs must not ship" assertion **stays**, and it is now
  load-bearing for this ADR rather than incidental. It is named as such in that file.
- `tests/shipped-doc-links.test.mjs` pins the rule for every shipped document: no relative
  link may point at a path the tarball does not carry, and every blob URL must name this
  org/repo, an existing ref, and an existing path.
- `docs/`-internal relative links (e.g. `docs/guide/commands.md` → `../decisions/…`) are
  **unaffected**. They are only ever read inside the repository or on GitHub, where they
  resolve, and converting them would trade a working link for a brittle one.
- BLZ-478's finding is answered by saying so rather than by widening the guard: the
  BLZ-460 pointer test's "a path the tarball ships" arm is **unreachable by policy**, not
  by accident, and its comment now states that instead of implying the disjunction is
  live. It is kept because it is what makes this ADR reversible in one edit — flip
  `package.json`'s `files` and the guard follows without being rewritten.
