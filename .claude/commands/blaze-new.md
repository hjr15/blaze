---
description: Scaffold a new Blaze ticket from a title, created in its type's initial status.
---

Run `blaze new --project <KEY> --type <type> "$ARGUMENTS"` from the data repo root
to create the next ticket (add `--estimate m` for story/task/bug, `--parent ID` if
it has one), then report the created file path. If `$ARGUMENTS` is empty, ask the
user for a ticket title first.
