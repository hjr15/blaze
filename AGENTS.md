# Driving Blaze with an agent

Blaze is a file-based issue board. **A ticket's status is the directory it sits in** —
there is no `status:` field, so it cannot drift. Any coding agent (Claude Code, Cursor,
Codex, …) can drive the board with ordinary file tools.

## The one rule

To change a ticket's status, move the file:

```bash
git mv todo/TASK-008-fix-thing.md in-progress/
```

The seven columns in workflow order: `backlog → todo → in-progress → in-review → done`,
plus `canceled` and `duplicate`.

## The loop

1. **Create** a ticket in `backlog/` (`npm run new "Title"` or copy `TEMPLATE.md`).
2. **You** move it to `todo/` when you commit to it (intent is a human decision).
3. In **mirror mode**, `reconcile` takes over from there: cut a code-repo branch named
   `you/<KEY>-<n>-slug` and the ticket lands in `in-progress/`; open a PR and it moves
   to `in-review/`; merge and it lands in `done/`. Never hand-move a ticket through the
   reconcile-owned columns.

## The join key

The only coupling between board and code is the branch name. Every branch embeds the
ticket key, e.g. `jordan/TASK-12-add-export`. Reconcile greps `TASK-12` out of it and
matches it to `*/TASK-12-*.md`. No API, no webhook, no stored id.

## Frontmatter

`id`, `title`, `type`, `priority`, `labels`, optional `project`/`assignee`/`estimate`/
`parent`, and the reconcile-filled `branch`/`pr`. See `CONVENTIONS.md`.

## Querying the board

```bash
for d in todo in-progress in-review; do echo "## $d"; ls "$d"/*.md 2>/dev/null; done
grep -rl '^priority: urgent' --include='*.md' .
```

## Grooming rules (used by the groomer loop)

When grooming a freshly-captured ticket, make these and only these edits to its `.md`
file, then stop:

- **Type & priority:** set `type` (feature/bug/improvement/chore) and `priority`
  (urgent/high/medium/low/none) from the ticket's content.
- **Labels:** add labels from the project taxonomy in `CONVENTIONS.md` that match the
  area/intent. Do not invent new labels.
- **Acceptance criteria:** if the `## Acceptance criteria` list is empty or a
  placeholder, draft 2–4 concrete, testable checkboxes from the context.
- **Duplicates:** if the ticket clearly duplicates another, note it in `## Notes`
  pointing at the surviving id (do not move or delete it — that stays a human decision).
- **Links:** in `## Notes`, link closely-related tickets by id.

Bump `updated:` to today on any edit. Never touch the `id`, never change the directory,
never edit code or any file outside the board.
