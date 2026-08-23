# Blaze — next session kickoff (written 2026-08-23)

**If you are a session reading this, your task is:** work §3 in order. The sequence was set by
the operator; do not reorder it without asking. Supersedes
`2026-08-24-blaze-next-session-kickoff.md`'s predecessor and every earlier kickoff.

---

## 0. Continuity contract

If you hit a usage or context limit, that is a **pause, not completion**. Do not stop, do not
mark anything Done, do not hand back early. Commit work-in-progress after every sub-step, keep a
running checklist in the ticket you are on, and resume from branch + checklist.

---

## 1. First five minutes — verify, don't trust

**This document asserts repo state. Re-verify before building; it may be stale.**

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH   # Node 20 lacks node:sqlite — mandatory
cd /home/rnamwoh/Documents/Code/blaze
git fetch origin && git status --short && git log origin/main --oneline -3
```

Expect `main` clean at or after `7e4ba4e BLZ-354, BLZ-360: the two kernel specs specs 2-4 depend on (#103)`.

Baseline the suite once before touching anything:

```bash
docker run --rm -d -e POSTGRES_PASSWORD=x -p 55443:5432 --name v4chk postgres:17-alpine
sleep 7
BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55443/postgres npm run test:coverage
docker rm -f v4chk
```

Last verified: **1,942 pass / 0 fail**, coverage **97.89 / 85.83 / 96.63 / 97.89** against gates
of 91 / 77 / 93 / 91. If that does not reproduce, stop and say so.

Board:

```bash
cd /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine
git status --short && git log --oneline -1
node /home/rnamwoh/Documents/Code/blaze/scripts/cli.mjs audit | tail -3
```

Expect clean, on `BLZ-305-v4-spine`, **~64 commits unpushed — that is correct, do not push**, and
`ok=true` with one soft `terminal-goal-unverified-requirement` finding (NCA-27, deliberately open).

---

## 2. Blocked vs actionable

| Item | State | Who |
|---|---|---|
| Spec 3 — Gantt / critical path | **ACTIONABLE — start here** | agent |
| Spec 2 — agile execution | ACTIONABLE after spec 3 | agent |
| Spec 4 — hierarchy reporting + Excel | ACTIONABLE after spec 2 | agent |
| BLZ-362 — ADR-0014 factual corrections | ACTIONABLE, small, independent | agent |
| BLZ-358 — first-run setup wizard | ACTIONABLE, independent | agent |
| BLZ-355 — grill the Q6 interface half | ACTIONABLE, needs the operator interactively | agent + operator |
| BLZ-324 — v3→v4 migration | **BLOCKED — needs a week of dual-write soak** | operator |
| NCA-40 / NCA-41 / NCA-27 | **PARKED by operator decision** — different project, not blocking | later |
| `name-clearance-audit#7` | **BLOCKED — needs operator review** | operator |

---

## 3. The sequence

### Phase 1 — spec 3 (Gantt / critical path)

**Both kernel specs are merged and are the input.** Read them first, in full:

- `docs/superpowers/specs/2026-08-23-scheduling-kernel-design.md` — constraints in, dates derived
- `docs/superpowers/specs/2026-08-23-project-owned-views-design.md` — views belong to a project

The operator settled both on 2026-08-23. **Do not re-litigate either decision.**

Facts from those specs you will need, each measured against the live corpus:

- `Blocks` **cannot carry a direction.** 392 edges, **248 (63.3%) in 124 mutual pairs**, because
  frontmatter has no way to write the inverse. The kernel therefore adds a new `Precedes`/`Follows`
  type — **ADR-0001 is NOT reversed** and no superseding ADR is needed.
- **There are zero dependency cycles among open tickets.** 39 SCCs over all tickets → 25 restricted
  to delivery types → **0** once terminal tickets are excluded. Every cycle passes through a `done`
  ticket. A first draft got this wrong; the corrected figure is in §5.4 of the spec.
- **DB schema version 2 is owned by the scheduling spec's §6.4** and installs `linkDdl` +
  `hierarchyDdl` + `viewDdl` + five `ticket` columns. The views spec yields to it. Do not
  re-open that.

### Phase 2 — spec 2 (agile execution), then Phase 3 — spec 4 (hierarchy + Excel)

Order is **3 → 2 → 4** and it is deliberate. Spec 4 last because it is the heaviest consumer of
the schema the kernel installs.

Known gaps to carry in:
- **Spec 2:** `sprints.json` has a **single global `active` pointer**, which per-project sprint
  boards break. Named as a real gap by the views spec; unaddressed.
- **Spec 4:** it is the one case where the views spec's falsification test only **plausibly**
  passes — `report` has no renderer module, and `export: 'xlsx'` collides with ADR-0011's
  no-required-dependency rule. Solve or scope both explicitly.

### Independent, pick up any time

- **BLZ-362** — ADR-0014 names `board_config`, a table that has never existed; omits
  `config_version`; counts one `migration_mode` twice; and asserts "one installation is one board"
  when `deriveBoards()` returns **4** for this board. Decision is sound, facts are wrong.
- **BLZ-358** — first-run setup. **Operator decided the mechanism:** a one-time token written to
  `<board>/.blaze/setup-token` at mode `0600`, path logged but never the value.

---

## 4. Out of scope

- **Do not push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole
  merger. Work there ends at a local commit. ~64 commits waiting is correct.
- **Do not touch the NCA project** (`name-clearance-audit`, board project `NCA`). Parked by the
  operator on 2026-08-23. NCA-40 is a real false green and it will keep.
- **Do not run the dual-write soak** on the operator's behalf (BLZ-324) — it needs elapsed time.
- **Do not reopen** the two kernel decisions, ADR-0014's ruling (only its facts are wrong), or
  ADR-0001.
- There are **no parallel sessions** and no sibling lanes to fence.

---

## 5. Process

- **`hygiene.yml` rejects `Co-Authored-By` trailers** and runs only on `pull_request`. Omit the
  trailer; open a PR rather than merging to `main` directly. Check first:
  `node scripts/ci/hygiene-check.mjs origin/main`
- **One ticket per commit subject** — `idFromSubject` anchors on `^KEY-n:`.
- Branch `KEY-n-slug`; commit `KEY-n: description`; PR title `KEY-n: description`; `blaze log`
  before any terminal move (BLZ has `requireWorklogBeforeTerminal`).
- Workflows differ by type: delivery is `defined → in-progress → in-review → done`; a **goal**
  is `defined → in-progress → achieved`; a **requirement** is
  `proposed → implemented → verified` (+ `rejected`, `obsolete`). You cannot jump.
- `blaze reconcile` is **disabled** on this board. Move tickets by hand.
- Run `blaze` commands **from the board directory**, not the engine repo.
- **Worktrees do not inherit `node_modules`.** Symlink it or ~108 tests fail on a missing `pg`:
  `ln -sfn /home/rnamwoh/Documents/Code/blaze/node_modules <worktree>/node_modules`

**Model routing when dispatching subagents — set `model` explicitly, never inherit:**

| Job | Model |
|---|---|
| Read-only recon / codebase fan-out | `haiku` (low effort; `sonnet` if it must reason across many files) |
| Mechanical, already-designed implementation | `sonnet` |
| Complex or subtle implementation | `opus` |
| Judgement-heavy review, adversarial verify | `opus` |
| Design / brainstorm / architecture decision | `fable`, with `opus` as fallback |

---

## 6. The one instruction that earned its keep

**Every agent PR gets an adversarial review before merge, and the reviewer must try to make the
check FAIL — not confirm it passes.**

On 2026-08-23, eight agent PRs were CI-green and **six were refuted by review**. CI caught none of
them. The recurring shape, seven times:

- a CI gate that could only prove rejection, never that a board loads
- a revert that silently no-opped on mixed tracked/untracked paths
- a fix that re-introduced the bug it was written to remove
- an auth downgrade when the identity file was corrupt
- a `checkBindSafety` call on a constant that could never fail
- an R48 gate whose success state did not exist on this board
- an SCC figure that applied one of the two restrictions it claimed

**Keep this in every implementation dispatch:** *if a mutation does not break a test, say so
plainly.* And when a review corrects a number, re-run the measurement yourself — on 2026-08-23
the author's own measurement was the faulty one four times.

---

## 7. What the last session did

Closed **seventeen tickets**. Merged the BYO-key spec (BLZ-346) after a five-lane expert panel and
an adversarial pass; ran the capability probe (BLZ-349) that proved `claude -p` reaches an open PR
with an allowlist and **no permissions bypass**, which unblocked ADR-0020; then cleared six
defects — groomer containment, the identity gate, forge visibility, the board CI gate, R48, and
two schema-guard bugs. Finished by designing and merging the two kernel specs this session starts
from.

The most useful single finding for whoever picks this up: **BLZ-345's self-declared hardest
constraint dissolved.** Because the agent runs where the credentials already are, Blaze never
holds an LLM key — so `docs/design.md`'s "no API key handling" line is upheld, not reversed. That
is recorded in ADR-0020 and in the BYO-key spec.
