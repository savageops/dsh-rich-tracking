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
  }))
  return { ok: true, board: { rows: clean, note: typeof raw.note === 'string' && raw.note !== '' ? raw.note : null } }
}

/** Overall percent = mean of row percents, rounded to integer. */
export function overallPercentOf(rows) {
  if (rows.length === 0) return 0
  const total = rows.reduce((sum, row) => sum + row.percent, 0)
  return Math.round(total / rows.length)
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
    if (data.kind === 'dismiss') return { ...state, dismissedAt: data.at, lastDecision: { kind: data.kind, rowId: null, at: data.at } }
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
