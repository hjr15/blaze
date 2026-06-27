<p align="center">
  <img src="brand/readme_graphic.jpg" alt="Blaze" width="420">
</p>

<p align="center"><b>Agentic AI for App Development</b><br>
A file-based, git-native issue board that AI coding agents can drive.</p>

---

Blaze is a super-clean issue tracker that lives next to your code. **Tickets are
markdown files. Their status is the directory they sit in.** No app, no database, no
login — plain text, versioned in git, greppable, and trivial for an AI coding agent to
drive with the file tools it already has.

```
blaze/
├── backlog/        ← captured, not yet committed to
├── todo/           ← committed to, ready to pick up
├── in-progress/    ← actively being worked
├── in-review/      ← PR open / awaiting review
├── done/           ← shipped
├── canceled/  duplicate/
└── blaze.config.json
```

## The one rule

A ticket's status is **which folder it's in**. To change status, move the file:

```bash
git mv todo/TASK-008-fix-thing.md in-progress/
```

`git log --follow` on a file is its full history.

## Two ways to run it

**Standalone** (default) — a personal/team markdown kanban. You move tickets by hand.

```bash
npm run new "Fix the export bug"     # scaffolds backlog/TASK-001-fix-the-export-bug.md
npm run board                        # → http://localhost:4321
```

**Mirror mode** — point Blaze at a code repo and it tracks status from git automatically.
Set `codeRepo` in `blaze.config.json` (and `key` to match your branch convention):

```json
{ "key": "TASK", "codeRepo": "../my-app" }
```

Now the branch name *is* the link. A branch `you/TASK-12-add-export` in `../my-app`
moves ticket `TASK-12` to `in-progress/`; opening its PR moves it to `in-review/`;
merging moves it to `done/` — all via `npm run reconcile` (needs `gh` authed).

### Worked example: mirroring a real repo

Say your code repo uses `DEV-<n>` branch names (e.g. `jordan/DEV-309-ics-feed`). Drop
Blaze in as a sibling and configure:

```json
{ "key": "DEV", "boardTitle": "My Dev Board", "codeRepo": "../my-app" }
```

`reconcile` reads `../my-app`'s branches + PRs, greps the `DEV-<n>` out of each branch
name, and drives the matching ticket through the columns. There is nothing to install
in the code repo — the naming convention is the whole integration.

## Driving it with an AI agent

See [`AGENTS.md`](AGENTS.md) — the create → move → reconcile loop, the join key, and the
grooming rules, written for any coding agent. Claude Code users also get a plugin under
`.claude/` (commands `/blaze-new`, `/blaze-board`, `/blaze-reconcile`).

## Configuration

Everything lives in [`blaze.config.json`](blaze.config.json): the ticket `key`, the
`codeRepo` to mirror (`null` = standalone), `columns`, `defaultLabels`, the board
`port`, and more. See [`docs/design.md`](docs/design.md) for the full reference.

## License

MIT.
