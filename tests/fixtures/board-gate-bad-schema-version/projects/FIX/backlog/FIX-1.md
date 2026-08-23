---
id: FIX-1
title: fixture task one
type: task
project: FIX
priority: medium
estimate: 30
---

## Context
Synthetic fixture ticket for the BLZ-351 board-gate CI check
(.github/workflows/board-gate.yml + tests/board-gate.test.mjs). Content is
deliberately generic — this board exists only to prove the config-schema
guard (ADR-0002) fires against a real board checkout, not to model any real
project.
