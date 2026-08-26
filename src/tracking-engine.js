/**
 * dsh-rich-tracking — pure engine (board validation + projection fold + wire view).
 *
 * ZERO dependencies and no I/O: host-only (unlike the exemplar's
 * survey-engine.js, nothing is inlined into the client — the client renders
 * the wire view and needs no validation logic).
 *
 * Three exports:
 *  - validateBoard(raw)     — model-facing whole-board validation, the
 *                             self-repairing-message style of the exemplar
 *                             (name the row, name the rule, say the fix).
 *  - foldTracking(state, event) — the projection fold (design §7.2). The
 *                             board deliberately does NOT reset on
 *                             turn/start: todos are the per-turn micro plan,
 *                             tracking is the mission macro scoreboard.
 *  - boardView(state)       — the client-visible wire view (design §7.2).
 */

/** Size/shape limits for model-authored boards (design §6.1). */
export const LIMITS = {
  maxRows: 12,
  minRows: 1,
  guidanceRows: '3-7',
  maxIdLength: 24,
  maxLabel: 80,
  maxNote: 200,
  maxEvidence: 300,
  maxItems: 20,
  maxItemLabel: 120,
  maxBoardNote: 200,
  maxCheckpointLabel: 60,
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const STATUSES = new Set(['pending', 'active', 'blocked', 'done'])

/** Derived status when the model omits it: 100 -> done, >0 -> active, 0 -> pending. */
export function deriveStatus(percent, explicit) {
  if (explicit !== undefined) return explicit
  if (percent === 100) return 'done'
  if (percent > 0) return 'active'
  return 'pending'
}

/**
 * Validate a whole-board replacement.
 * @param {unknown} raw - the `args` of a tracking_write call ({ rows, note? }).
 * @returns {{ok: true, board: {rows: Array<object>, note: string | null}} | {ok: false, errors: string[]}}
 */
export function validateBoard(raw) {
  const errors = []
  const fail = (message) => errors.push(message)
  if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.rows)) {
    return { ok: false, errors: ['tracking_write requires a rows array (1-12 rows; aim for 3-7)'] }
  }
  const { rows } = raw
  if (rows.length < LIMITS.minRows || rows.length > LIMITS.maxRows) {
    fail(`rows has ${rows.length} entries (limit ${LIMITS.minRows}-${LIMITS.maxRows}; guidance is ${LIMITS.guidanceRows} — split into a new board or prune obsolete rows if over)`)
  }

  const seenIds = new Set()
  rows.forEach((row, index) => {
    const where = `rows[${index}]`
    if (typeof row !== 'object' || row === null) { fail(`${where} must be an object`); return }
    if (typeof row.id !== 'string' || row.id === '') { fail(`${where}.id must be a non-empty ascii slug (e.g. 'w2-fleet')`); return }
    if (row.id.length > LIMITS.maxIdLength || ID_PATTERN.test(row.id) === false) {
      fail(`${where}.id "${row.id}" must match ${ID_PATTERN.toString()} and be <= ${LIMITS.maxIdLength} chars`)
    } else if (seenIds.has(row.id)) {
      fail(`duplicate row id "${row.id}" (first occurrence rejected too — ids must be unique so checkpoints and actions can reference rows)`)
    } else {
      seenIds.add(row.id)
    }
    if (typeof row.label !== 'string' || row.label.trim() === '') fail(`${where}.label must be a non-empty string`)
    else if (row.label.length > LIMITS.maxLabel) fail(`${where}.label exceeds ${LIMITS.maxLabel} characters`)
    if (typeof row.percent !== 'number' || !Number.isInteger(row.percent) || row.percent < 0 || row.percent > 100) {
      fail(`${where}.percent must be an integer 0-100 (got ${String(row.percent)})`)
    }
    if (row.note !== undefined && (typeof row.note !== 'string' || row.note.length > LIMITS.maxNote)) {
      fail(`${where}.note must be a string <= ${LIMITS.maxNote} characters (what changed since the last write, or the blocker)`)
    }
    if (row.evidence !== undefined && (typeof row.evidence !== 'string' || row.evidence.length > LIMITS.maxEvidence)) {
      fail(`${where}.evidence must be a string <= ${LIMITS.maxEvidence} characters (paths + checked/total)`)
    }
    if (row.status !== undefined && STATUSES.has(row.status) === false) {
      fail(`${where}.status must be one of pending | active | blocked | done (got ${String(row.status)})`)
    }
    // Percent-honesty rule (design D11): a percent is a claim; evidence is its basis.
    if (typeof row.percent === 'number' && row.percent >= 1 && (typeof row.evidence !== 'string' || row.evidence.trim() === '')) {
      fail(`${where}.evidence is required when percent >= 1 — name the artifact basis (paths + checked/total, e.g. '.docs/GOAL.md W2 snapshot + .docs/qc/: 9/14 receipts')`)
    }
    // Items checklist (row expansion): when present, percent must equal the
    // item math — the board shows exactly what the items show, never a number
    // its own checklist contradicts.
    if (row.items !== undefined) {
      if (Array.isArray(row.items) === false || row.items.length === 0) {
        fail(`${where}.items must be a non-empty array (1-${LIMITS.maxItems}) of { label, done } when provided`)
      } else if (row.items.length > LIMITS.maxItems) {
        fail(`${where}.items has ${row.items.length} entries (limit ${LIMITS.maxItems} — split the row or prune)`)
      } else {
        row.items.forEach((item, itemIndex) => {
          const at = `${where}.items[${itemIndex}]`
          if (typeof item !== 'object' || item === null) { fail(`${at} must be an object { label, done }`); return }
          if (typeof item.label !== 'string' || item.label.trim() === '') fail(`${at}.label must be a non-empty string`)
          else if (item.label.length > LIMITS.maxItemLabel) fail(`${at}.label exceeds ${LIMITS.maxItemLabel} characters`)
          if (typeof item.done !== 'boolean') fail(`${at}.done must be a boolean`)
        })
        if (typeof row.percent === 'number' && row.items.every((item) => typeof item?.done === 'boolean')) {
          const doneCount = row.items.filter((item) => item.done === true).length
          const derived = Math.round((doneCount / row.items.length) * 100)
          if (row.percent !== derived) {
            fail(`${where}.percent is ${row.percent} but its items say ${doneCount}/${row.items.length} = ${derived} — when items are present, percent must equal round(done/total × 100); fix the percent or the item flags`)
          }
        }
      }
    }
    // Status consistency (design §6.1 rule 3).
    if (typeof row.percent === 'number' && Number.isInteger(row.percent)) {
      const effective = deriveStatus(row.percent, row.status)
      if (row.status === 'done' && row.percent < 100) fail(`${where} declares status 'done' at percent ${row.percent} — done requires 100`)
      if (row.percent === 100 && effective !== 'done') fail(`${where} has percent 100 but status '${row.status}' — a complete row is done; pick the status that matches truth`)
      if (row.status === 'blocked' && (row.percent >= 100 || typeof row.note !== 'string' || row.note.trim() === '')) {
        fail(`${where} declares status 'blocked' — blocked requires percent < 100 and a note naming the concrete blocker`)
      }
    }
  })

  if (raw.note !== undefined && (typeof raw.note !== 'string' || raw.note.length > LIMITS.maxBoardNote)) {
    fail(`note must be a string <= ${LIMITS.maxBoardNote} characters (what this write changed)`)
  }
  if (errors.length > 0) return { ok: false, errors }

  const clean = rows.map((row) => ({
    id: row.id,
    label: row.label,
    percent: row.percent,
    status: deriveStatus(row.percent, row.status),
    ...(row.note !== undefined && row.note !== '' ? { note: row.note } : {}),
    ...(row.evidence !== undefined && row.evidence !== '' ? { evidence: row.evidence } : {}),
    ...(Array.isArray(row.items) && row.items.length > 0
      ? { items: row.items.map((item) => ({ label: item.label, done: item.done === true })) }
      : {}),
  }))
  return { ok: true, board: { rows: clean, note: typeof raw.note === 'string' && raw.note !== '' ? raw.note : null } }
}

/**
 * Overall completion = item-weighted unit fraction. Every acceptance item is
 * one unit; a row without items contributes one unit at percent/100. With no
 * items anywhere this is exactly the rounded mean of row percents (legacy
 * boards keep their math); with items it stops a 10-item row and a 2-item row
 * counting equally toward "completion".
 */
export function overallPercentOf(rows) {
  if (rows.length === 0) return 0
  let units = 0
  let doneUnits = 0
  for (const row of rows) {
    if (Array.isArray(row.items) && row.items.length > 0) {
      units += row.items.length
      doneUnits += row.items.filter((item) => item.done === true).length
    } else {
      units += 1
      doneUnits += row.percent / 100
    }
  }
  return Math.round((doneUnits / units) * 100)
}

/**
 * The projection fold (design §7.2). State is `null` before the first write.
 * - tracking/write replaces the board, bumps nothing itself (revision rides
 *   the event data), and clears dismissal (D7: truth re-opens the board).
 * - tracking/checkpoint stores the latest checkpoint snapshot.
 * - tracking/decision folds dismiss / dismiss-row / the whip verbs.
 * - turn/start: deliberately NOT a reset (D3).
 */
export function foldTracking(state, event) {
  if (event.type === 'tracking/write') {
    const data = event.data
    return {
      present: true,
      revision: data.revision,
      rows: data.rows,
      note: data.note ?? null,
      git: data.git ?? null,
      commitsAhead: data.commitsAhead ?? null,
      updatedAt: data.at,
      dismissedAt: null,
      dismissedRows: [],
      lastCheckpoint: state?.lastCheckpoint ?? null,
      lastDecision: state?.lastDecision ?? null,
    }
  }
  if (event.type === 'tracking/checkpoint') {
    if (state === null) return state
    const data = event.data
    return { ...state, lastCheckpoint: { id: data.id, label: data.label ?? null, git: data.git ?? null, rows: data.rows, at: data.at } }
  }
  if (event.type === 'tracking/decision') {
    if (state === null) return state
    const data = event.data
    if (data.kind === 'play') return { ...state, playMode: true, lastDecision: { kind: data.kind, rowId: null, at: data.at } }
    if (data.kind === 'pause') return { ...state, playMode: false, lastDecision: { kind: data.kind, rowId: null, at: data.at } }
    if (data.kind === 'dismiss') return { ...state, dismissedAt: data.at, playMode: false, lastDecision: { kind: data.kind, rowId: null, at: data.at } }
    if (data.kind === 'dismiss-row') {
      const dismissedRows = state.dismissedRows.includes(data.rowId) ? state.dismissedRows : [...state.dismissedRows, data.rowId]
      return { ...state, dismissedRows, lastDecision: { kind: data.kind, rowId: data.rowId, at: data.at } }
    }
    return { ...state, lastDecision: { kind: data.kind, rowId: data.rowId ?? null, at: data.at } }
  }
  return state
}

/** The wire view (design §7.2): everything the dock renders, nothing else. */
export function boardView(state) {
  if (state === null || state.present !== true) return null
  const rows = state.rows
    .filter((row) => state.dismissedRows.includes(row.id) === false)
    .map((row) => ({ ...row, dimmed: row.percent === 100 }))
  const live = state.rows.filter((row) => state.dismissedRows.includes(row.id) === false)
  const overall = overallPercentOf(live)
  const doneCount = live.filter((row) => row.percent === 100).length
  const allDone = live.length > 0 && doneCount === live.length

  let sinceCheckpoint = null
  if (state.lastCheckpoint !== null) {
    const before = new Map(state.lastCheckpoint.rows.map((row) => [row.id, row.percent]))
    const rowDeltas = []
    for (const row of live) {
      if (before.has(row.id) === true && before.get(row.id) !== row.percent) {
        rowDeltas.push({ id: row.id, label: row.label, from: before.get(row.id), to: row.percent })
      }
    }
    rowDeltas.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
    const beforeOverall = overallPercentOf(state.lastCheckpoint.rows)
    sinceCheckpoint = {
      commitsAhead: state.commitsAhead,
      percentDelta: overall - beforeOverall,
      rowDeltas: rowDeltas.slice(0, 3),
    }
  }

  return {
    present: state.dismissedAt === null,
    revision: state.revision,
    rows,
    overallPercent: overall,
    doneCount,
    allDone,
    counts: {
      done: doneCount,
      active: live.filter((row) => row.status === 'active').length,
      blocked: live.filter((row) => row.status === 'blocked').length,
      pending: live.filter((row) => row.status === 'pending').length,
    },
    note: state.note,
    git: state.git,
    dismissedRows: state.dismissedRows,
    ...(state.dismissedAt !== null ? { dismissedAt: state.dismissedAt } : {}),
    ...(state.lastCheckpoint !== null ? { lastCheckpoint: state.lastCheckpoint } : {}),
    sinceCheckpoint,
    ...(state.lastDecision !== null ? { lastDecision: state.lastDecision } : {}),
    playMode: state.playMode === true,
    updatedAt: state.updatedAt,
  }
}

/** Scan a session log snapshot backwards for the last event of a tracking type. */
export function lastTrackingEvent(events, type) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === type) return event
  }
  return null
}

/** Next board revision: last tracking/write revision + 1 (1 for the first). */
export function nextRevision(events) {
  const last = lastTrackingEvent(events, 'tracking/write')
  return last === null ? 1 : last.data.revision + 1
}

/** Next checkpoint id: cp-<n>. */
export function nextCheckpointId(events) {
  const last = lastTrackingEvent(events, 'tracking/checkpoint')
  if (last === null) return 'cp-1'
  const match = /^cp-(\d+)$/.exec(last.data.id ?? '')
  return match === null ? 'cp-1' : `cp-${Number(match[1]) + 1}`
}

/**
 * The /track injection body (pure): the full ledger plus the living-ledger
 * doctrine, as the paragraph the agent must act on. A null view (no board
 * yet) yields the creation directive instead.
 */
export function ledgerContext(view) {
  if (view === null || view.present !== true) {
    return 'No tracking board exists yet in this session. If the work ahead spans multiple steps, waves, or sessions, create one now with tracking_write: rows mapped to the plan\'s real workstreams, every percent >= 1 carrying evidence naming its artifact basis (paths + checked/total), and rows optionally carrying an items checklist that must add up to the percent.'
  }
  const rows = view.rows.map((row) => {
    const items = Array.isArray(row.items) && row.items.length > 0
      ? ` — items: ${row.items.map((item) => `${item.done === true ? '[x]' : '[ ]'} ${item.label}`).join('; ')}`
      : ''
    const basis = row.evidence !== undefined ? ` — basis: ${row.evidence}` : ''
    const note = row.note !== undefined ? ` — note: ${row.note}` : ''
    const status = row.status ?? deriveStatus(row.percent)
    return `- ${row.label} (${row.id}): ${row.percent}% ${status}${items}${basis}${note}`
  }).join('\n')
  return `TRACKING LEDGER (revision r${view.revision}, overall ${view.overallPercent}%, ${view.doneCount}/${view.rows.length} rows done):\n${rows}\n\nRe-derive this ledger now: read the artifacts each row names (documentation, code, receipts, user context), recompute percent as checked/total — never from impression — fix any stale items or prose (labels, notes, evidence must describe current reality), then call tracking_write with the corrected board. Afterward keep the ledger living: update percents and item flags after every completed step, and refresh the prose whenever the underlying details change.`
}
