---
id: "d409f89b-2e6f-46e7-babe-8f52f1b93a05"
title: "dsh-rich-tracking v0.2–v0.3 — row items, /track ledger sync, row delegation (checkpoint handoff)"
description: "Implementation handoff for dsh-rich-tracking v0.2 (expandable row items, item-weighted completion) + v0.3 (/track command, per-row delegate, default submit injection): features, DSH plugin-command research, and the completed restart/runtime verification (board r6 = 100%)."
status: "active"
created_at: "2026-08-26T14:15:31.575Z"
updated_at: "2026-08-26T15:35:13.660Z"
content_hash: "808c2abc009e4abb825da33c6e7632c33786afabe6fe092cbff618c75d199971"
source_paths:
  - "src/tracking-engine.js"
  - "src/host.js"
  - "src/client.bundle.js"
  - "src/tracking-engine.test.mjs"
  - "README.md"
  - "package.json"
session_ids:
  - "5fbc4bca-3ae7-46a4-a254-89da9f8bfd1e"
  - "7e114825-7321-4c76-bddc-e6bbe9b6beb5"
  - "17db9b73-8223-495c-8baa-8638f4fe864c"
memory_body_ids:
  []
---

# dsh-rich-tracking v0.2–v0.3 — checkpoint handoff

Implementation handoff (checkpoint-reviewed). Repo: `/home/sysadmin/.dsh/plugins/dsh-rich-tracking` (branch `main`). Two feature waves landed, plus a verification phase:

- **v0.2.0** — expandable row items & item-weighted completion (commit `2eadba1`, 6 files, +186/−12); demo marker commit re-landed as `1edfb63` after an operator reset had dropped it.
- **v0.3.0** — `/track` ledger-sync command, per-row Delegate action, default submit-time injection, living-ledger cadence (commit `9b2130c`, 6 files, +162/−19).
- Tests: **16/16 green** (`npm test`, node:test, zero deps) — 5 items tests + 2 ledgerContext tests added across the waves.

## v0.2 — row `items` contract (engine: `src/tracking-engine.js`)
- Rows may carry `items`: 1–20 entries of `{ label, done }` (`LIMITS.maxItems: 20`, `maxItemLabel: 120`); non-empty array, boolean `done`, non-empty label — violations rejected with self-repairing messages naming the exact spot.
- **Percent↔items cross-check**: when `items` are present, `percent` MUST equal `round(done/total × 100)`; a mismatch is rejected naming both numbers (e.g. "percent is 80 but its items say 3/5 = 60"). The visible checklist can never contradict the shown percent.
- `evidence` stays mandatory at `percent >= 1`; the clean board passes `items` through as `{label, done}`.
- Completion fix: `overallPercentOf` became an item-weighted unit fraction (each item is one unit; itemless rows contribute `percent/100` as one unit) — mathematically identical to the old rounded mean when no row carries items (test: `55, 0 → 28` unchanged). This stopped a 10-item row and a 2-item row counting equally toward "completion".
- Client UX (`src/client.bundle.js`): rows with items are clickable (click/Enter/Space toggle, Escape closes); done items **grey + strikethrough**, open items primary with dashed-ring glyph; `N/M items` chip + chevron; new locale keys `row.items/expand/collapse` (en + zh).

## v0.3 — /track, delegate, default injection
- **`/track` host command** (`src/host.js`, via `ctx.inject(['commands'])` → `commands.register` — the `/plan` family; researched from `@deepseek-ai/dsh-commands` + `dsh-plan-mode` in the DSH checkout): bare `/track` or `/track <message>`. Injects the **full ledger plus the tracking doctrine** into the agent's next step as a genuine user-role message (source `{kind:'user'}`; trailing message rides as the operator's own words); delivered `steer` when running, `followup` when idle.
- Ledger body is `ledgerContext(view)` — a **pure, engine-exported, unit-tested** function (`src/tracking-engine.js`): every row with percent/status/`[x] [ ]` item flags/evidence/note + the re-derivation directive (read the named artifacts — docs, code, receipts, user context — recompute percent as checked/total, fix stale items/prose, write the corrected board); null view yields the board-creation directive.
- **Per-row Delegate action**: new hover icon button (person icon `IconUserOutline16` with `IconQueueOutline14` fallback — the runtime primitives set is finite) → whip route `kind: 'delegate'` (added to the whitelist + steer/followup whip set). The landed instruction: delegate the row to a **background subagent with read/write access**, self-contained brief (label, percent, status, item checklist with done flags, evidence, note, user context/files), **scoped strictly to the row's task and subtasks**; the subagent keeps its **own** `tracking_write` board scoped to that task; verifiable receipts (commits, tests, file paths) fold back into the parent row on its report.
- **Default submit-time injection**: while a live board exists, the first pre-step of every turn carries a one-line board reminder (`Board rN · % · rows…` + the update duty, "do not recite") — deduped via `assemblyCarriesTracking` (trailing-message sentinels `<tracking` / `[rich-tracking`), so /track syncs, whip instructions, and staleness reminders never double up. Staleness backstop kept: 8 steps OR 6k tokens.
- **Living-ledger cadence** in the announcement (`ANNOUNCEMENT`): `tracking_write` after EVERY completed task/step/todo whose artifact truth changed; refresh row prose (label/note/evidence/items) whenever details shift; the board describes current reality, not a milestone snapshot. Also documented the default-injection behavior so agents don't misread it.

## Verification & disposition (ALIGN re-derivation, completed)
- **Restart confirmed**: the v0.3.0 default `<tracking-board>` injection fired live in-session — the running `dsh web` process now executes v0.3.0; plugin/host changes load only at process boot (tool schemas and client bundle included).
- **Parallel polish session**: 7 UI-polish commits (`fa62022`…`161a17b`) landed on top of `9b2130c`; all features survived (items expansion JSX, DelegateIcon, `name: 'track'` registration verified present; tree clean except untracked `.mnemon/`).
- **Demo row retired**: polish commit `bae6c45` cleaned the `<!-- demo checkpoint marker -->` line — the demo drill's receipts were already delivered in session history; the row was dropped as obsolete rather than regressed.
- **Live proof**: the post-restart `tracking_write` carried `items` on every row and was **accepted by the running host** — v0.2.0+ schema validation → fold → wire proven end-to-end through the live process. Final board **r6: 2/2 rows done, 100% overall** (row-items 7/7 done, track-delegate 8/8 done, each with item checklists).
- Remaining step: operator eyeball of rendering (click a row to expand items, check `/track` in the command menu, hover a row for the delegate icon).

## Source map
```
src/tracking-engine.js        pure engine: LIMITS, validateBoard (+items), overallPercentOf (+item-weighted), boardView, ledgerContext
src/host.js                   ANNOUNCEMENT, tracking_write/checkpoint tools, /track registration, delegate kind, refresh+default injection
src/client.bundle.js          dock: expandable BoardRow (items, chevron, chip), delegate button, locale en/zh
src/tracking-engine.test.mjs  node:test, 16 tests
README.md                     grammar docs: items, /track, delegate, living-ledger cadence
```
Run: `npm test` in the repo; load into the GUI by restarting `dsh web`.
