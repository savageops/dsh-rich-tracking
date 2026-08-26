/**
 * dsh-rich-tracking — engine test suite (node:test, zero deps).
 * Run: node --test src/tracking-engine.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { boardView, foldTracking, nextCheckpointId, nextRevision, overallPercentOf, validateBoard } from './tracking-engine.js'

const validRow = (over = {}) => ({ id: 'w2-fleet', label: 'W2 fleet rebuild', percent: 55, evidence: '.docs/GOAL.md W2 + qc: 6/11', ...over })

test('validateBoard accepts a valid board and derives status', () => {
  const check = validateBoard({ rows: [validRow(), { id: 'w3', label: 'W3', percent: 0 }], note: 'first' })
  assert.equal(check.ok, true)
  assert.equal(check.board.rows[0].status, 'active')
  assert.equal(check.board.rows[1].status, 'pending')
})

test('percent honesty: evidence required at >= 1, self-repairing message', () => {
  const check = validateBoard({ rows: [validRow({ evidence: undefined })] })
  assert.equal(check.ok, false)
  assert.match(check.errors[0], /rows\[0\]\.evidence is required when percent >= 1/)
  assert.match(check.errors[0], /paths \+ checked\/total/)
})

test('status consistency: done requires 100; 100 is done; blocked needs a note', () => {
  assert.equal(validateBoard({ rows: [validRow({ percent: 40, status: 'done' })] }).ok, false)
  assert.equal(validateBoard({ rows: [validRow({ percent: 100, evidence: 'qc: 11/11' })] }).ok, true)
  assert.equal(validateBoard({ rows: [validRow({ status: 'blocked' })] }).ok, false)
  assert.equal(validateBoard({ rows: [validRow({ percent: 30, status: 'blocked', note: 'eu02 migration blocked on DNS' })] }).ok, true)
})

test('row limits: id slug rules, duplicates, caps', () => {
  assert.equal(validateBoard({ rows: [validRow({ id: 'Bad_Id' })] }).ok, false)
  assert.equal(validateBoard({ rows: [validRow({ id: 'x'.repeat(25) })] }).ok, false)
  assert.equal(validateBoard({ rows: [validRow(), validRow({ id: 'w2-fleet' })] }).ok, false) // duplicate ids quoted
  assert.equal(validateBoard({ rows: Array.from({ length: 13 }, (_, i) => validRow({ id: `r${i}` })) }).ok, false)
})

test('fold: write replaces, resurrects dismissal; checkpoint and decisions fold', () => {
  let state = null
  state = foldTracking(state, { type: 'tracking/write', data: { revision: 1, rows: [validRow()], note: null, git: null, commitsAhead: null, at: 1 } })
  assert.equal(boardView(state).present, true)
  state = foldTracking(state, { type: 'tracking/decision', data: { kind: 'dismiss', at: 2 } })
  assert.equal(boardView(state).present, false)
  state = foldTracking(state, { type: 'tracking/write', data: { revision: 2, rows: [validRow()], note: null, git: null, commitsAhead: null, at: 3 } })
  assert.equal(boardView(state).present, true, 'a later write resurrects a dismissed board (D7)')
})

test('fold: checkpoint only records on an existing board; decision kinds record lastDecision', () => {
  let state = null
  state = foldTracking(state, { type: 'tracking/checkpoint', data: { id: 'cp-1', git: null, rows: [], at: 1 } })
  assert.equal(state, null, 'checkpoint without a board is a no-op')
  state = foldTracking(state, { type: 'tracking/write', data: { revision: 1, rows: [validRow()], note: null, git: null, commitsAhead: null, at: 2 } })
  state = foldTracking(state, { type: 'tracking/decision', data: { kind: 'pursue', rowId: 'w2-fleet', at: 3 } })
  assert.equal(boardView(state).lastDecision.kind, 'pursue')
})

test('view: dimming, dismissal filtering, since-checkpoint deltas', () => {
  let state = null
  state = foldTracking(state, { type: 'tracking/write', data: { revision: 1, rows: [validRow({ percent: 30 }), validRow({ id: 'w4', label: 'W4', percent: 0 })], note: null, git: null, commitsAhead: null, at: 1 } })
  state = foldTracking(state, { type: 'tracking/checkpoint', data: { id: 'cp-1', label: null, git: null, rows: [{ id: 'w2-fleet', label: 'W2 fleet rebuild', percent: 30, status: 'active' }, { id: 'w4', label: 'W4', percent: 0, status: 'pending' }], at: 2 } })
  state = foldTracking(state, { type: 'tracking/write', data: { revision: 2, rows: [validRow(), validRow({ id: 'w4', label: 'W4', percent: 0 }), validRow({ id: 'w9', label: 'W9 done', percent: 100, evidence: 'qc: 5/5' })], note: null, git: { branch: 'main', head: 'abc' }, commitsAhead: 2, at: 3 } })
  state = foldTracking(state, { type: 'tracking/decision', data: { kind: 'dismiss-row', rowId: 'w4', at: 4 } })
  const view = boardView(state)
  assert.equal(view.rows.length, 2, 'dismissed row filtered out')
  assert.equal(view.rows.find((row) => row.id === 'w9').dimmed, true)
  assert.equal(view.doneCount, 1)
  assert.equal(view.sinceCheckpoint.commitsAhead, 2)
  assert.equal(view.sinceCheckpoint.percentDelta > 0, true)
  assert.ok(view.sinceCheckpoint.rowDeltas.length <= 3)
})

test('turn/start never resets the board (D3 divergence from todos)', () => {
  let state = null
  state = foldTracking(state, { type: 'tracking/write', data: { revision: 1, rows: [validRow()], note: null, git: null, commitsAhead: null, at: 1 } })
  state = foldTracking(state, { type: 'turn/start', data: {} })
  assert.equal(boardView(state).present, true)
})

test('revision and checkpoint numbering scan the log backwards', () => {
  const events = [
    { type: 'tracking/write', data: { revision: 1 } },
    { type: 'tracking/checkpoint', data: { id: 'cp-1' } },
    { type: 'tracking/write', data: { revision: 7 } },
    { type: 'assistant/message', data: {} },
  ]
  assert.equal(nextRevision(events), 8)
  assert.equal(nextCheckpointId(events), 'cp-2')
  assert.equal(nextRevision([]), 1)
})

test('overall percent is the rounded mean', () => {
  assert.equal(overallPercentOf([{ percent: 55 }, { percent: 0 }]), 28)
  assert.equal(overallPercentOf([]), 0)
})
