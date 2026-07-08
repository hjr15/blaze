---
title: Ticket type hierarchy
type: data-model
format: mermaid
---

## Caption

The built-in ticket type registry (`scripts/model/schema.mjs`, `DEFAULT_TYPES`).
Every type declares a hierarchy `level`, the parent types it may hang off, the
fields it requires, and which of the three workflows governs it. Parent edges are
validated on every write — including cycle detection — so the work-breakdown
structure is data, not convention. A data repo can override or extend this
registry through a `schema` block in its config without editing engine source; the
diagram shows the defaults.

```mermaid
flowchart TD
    goal["goal · level 2<br/>workflow: goal<br/>requires: title, description"]
    epic["epic · level 1<br/>workflow: delivery<br/>requires: title, description"]
    risk["risk · level 1<br/>workflow: risk<br/>requires: title, description,<br/>likelihood, impact"]
    story["story · level 0<br/>workflow: delivery<br/>requires: title, description, estimate"]
    task["task · level 0<br/>workflow: delivery<br/>requires: title, description, estimate"]
    bug["bug · level 0<br/>workflow: delivery<br/>requires: title, description, estimate"]
    subtask["subtask · level -1<br/>workflow: delivery<br/>requires: title, description"]

    goal --> epic
    goal --> risk
    epic --> risk
    epic --> story
    epic --> task
    epic --> bug
    story --> subtask
    task --> subtask
    bug --> subtask
```

## Worked example

An arrow points from a **parent** type to a **child** type it may contain:

- A `goal` is top-level (no parent type) and sits above everything.
- An `epic` must hang off a `goal`; `story`/`task`/`bug` must hang off an `epic`;
  a `subtask` hangs off a `story`, `task`, or `bug`.
- A `risk` is the one type with two legal parents — a `goal` **or** an `epic` — and
  is the only leaf-level type carrying `likelihood` and `impact` instead of an
  `estimate`.

Only the delivery-workflow leaf types (`story`/`task`/`bug`/`subtask`) require an
`estimate`; a project can additionally require a worklog before those enter a
terminal status via `requireWorklogBeforeTerminal`. Time rolls up from leaves to
`epic` and `goal` parents, so parents carry no estimate of their own.
