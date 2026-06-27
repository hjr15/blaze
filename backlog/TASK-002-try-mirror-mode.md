---
id: TASK-002
title: Try mirror mode against a code repo
type: feature
priority: low
labels: [docs]
assignee: unassigned
created: 2026-06-27
updated: 2026-06-27
---

## Context

Set `codeRepo` in `blaze.config.json` to a sibling repo and run `npm run reconcile` to
see tickets track your branches and PRs automatically.

## Acceptance criteria

- [ ] `codeRepo` points at a real repo
- [ ] `npm run reconcile` moved a ticket based on a branch/PR

## Notes

See README.md → "Worked example".
