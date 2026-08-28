
# v0.3 — Tracks: every board, every workspace

New sidebar entry "Tracks" (ideas-entry family, self-healing injection, last
in the family chain) opens a pure-DOM panel listing ALL tracking boards across
ALL workspaces: GET /api/rich-tracking/tracks folds every session log's
tracking events (zstd -dc, line pre-filter, mtime+size cache, 8s newest-first
budget per open), groups boards by workspace slug with resolved session
titles, and marks liveness from the in-process agent registry. Each board
expands to its rows (percent, status, items x/y) and carries the full action
set — Play/Pause (auto-engage), Checkpoint, Align, Dismiss, and per-row
Pursue — delivered through the existing /action whip route; offline boards
show disabled actions with the open-first hint.

# v0.3.1 — play mode survives writes (goal-mode continuation semantics)

Operator report: play mode stopped after the engaged turn finished. Root
cause: foldTracking's tracking/write branch built a fresh state that dropped
playMode — the first tracking_write of any auto-engaged turn silently
disarmed the loop, so the next turn/end saw playMode false and stopped. The
write branch now preserves playMode (a MODE, not board content); only
pause/dismiss decisions clear it. Continuation now runs until allDone, all
rows blocked, or the operator pauses/dismisses — exactly the goal-mode
contract. Engine tests 18/18 (two new: play-across-writes, natural stop).

# Gotcha-sweep round 2 (three adversarial lanes + own probes)

Round 1's bug pattern was runtime seams, so round 2 hunted them directly:
- **Fork-seed inheritance (found at scale, fixed): 76 of 478 child sessions
  carried parent boards** (seedLength up to 735k events) — reminders fired
  inside delegated children, a play-mode parent could auto-engage children,
  and Tracks listed 76 duplicates. All folds now start at the seed boundary
  (header.seedLength — verified durable through resume and fork-of-fork);
  a child's board is what the child writes. Scanner re-validated: 761
  inherited events skipped, boards 24→6 real.
- **Compaction: proven clean** (log append-only; ignorable tracking events
  survive — 30/32 writes present in real compacted logs).
- **Engage loop hardened (P1):** fires only on naturally completed turns
  (operator Stop is never undone; refusal/max-tokens don't loop); per-session
  timer dedupe; re-folds and re-checks present/playMode/!allDone at fire;
  delivers only when still idle (never steers the operator's fresh turn).
- **Wrong-row whip fixed:** pursue/delegate no longer fall back to rows[0]
  on a stale rowId; dismiss-row instruction names the row id.
- **Dock:** decision chip locale keys (play/pause/delegate), status visible
  while collapsed, postAction 15s timeout, checklist scroll cap with fade,
  stale state reset on dismiss→reopen.
- **Premise falsified:** react-dom/client DOES resolve in the live shell
  (staticModules seed) — generative-ideas' React panel was never dead here;
  its busy-guard dead code and Reroll/Push uncaught generates fixed, zh
  typo 重抑→重掷.
- Noted-not-applied: projection raw apply lacks boundary (GUI forks showing
  the parent board is arguably the feature; subagent children own no dock);
  identity stateSchema.parse (trusted state); Host-header hardening (breaks
  remote admission).
