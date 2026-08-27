
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
