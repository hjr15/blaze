---
description: Flush the day's queued blaze board ops into a single commit.
---

Run `npm run commit` from the board repo root to drain `.blaze/pending-commit.jsonl`
into one commit (subject summary + per-op body). If it prints `nothing to flush`,
there were no queued ops (either nothing changed today, or the board is in per-op
`commitMode` and every op already committed). Report the resulting commit subject.
